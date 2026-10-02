import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	Harness,
	type Storage,
} from "@earendil-works/pi-durable";
import { type Config, paths } from "./config.ts";
import { followUpsExtension } from "./extensions/follow-ups.ts";
import { type Notes, notesExtension } from "./extensions/notes.ts";
import { soulExtension } from "./extensions/soul.ts";
import { Routes } from "./routes.ts";
import { prepareWorkspace, type WorkerOptions, workerOptions, workersExtension } from "./extensions/workers.ts";

export type Agent = {
	harness: Harness;
	/** The conversation for `address`, created on first use. */
	conversationFor(address: string, context: Context): Promise<Conversation>;
	/** Addresses that have a conversation, for reattaching delivery after a restart. */
	addresses(context: Context): Promise<Record<string, ConversationId>>;
	/** Switch every conversation to another front model, from the next request on. */
	setModel(choice: { provider: string; model: string; thinkingLevel: ModelThinkingLevel }, context: Context): Promise<void>;
};

export async function openAgent(
	storage: Storage,
	options: { config: Config; models: Models; notes: Notes; workers?: WorkerOptions; now?: () => number },
	context: Context,
): Promise<Agent> {
	const { config, models, notes } = options;
	const registry = createRegistry();
	registry.install(soulExtension(config.timeZone));
	registry.install(notesExtension(notes));
	registry.install(followUpsExtension(config.timeZone, options.now));
	const workers = options.workers ?? workerOptions(config, paths);
	prepareWorkspace(workers);
	const current: { current?: Harness } = {};
	registry.install(workersExtension(workers, current));

	let agent = { model: { provider: config.provider, modelId: config.model }, thinkingLevel: config.thinkingLevel };
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: { retry: { maxRetries: 3 }, toolExecution: "parallel" },
			onReport: (error) => console.error("[pclaw]", error),
			...(options.now === undefined ? {} : { now: options.now }),
		},
		context,
	);

	const configured = new Set<ConversationId>();

	current.current = harness;

	async function conversationFor(address: string, context: Context): Promise<Conversation> {
		const known = (await harness.snapshot(Routes, context))?.conversations[address];
		const existing = known === undefined ? undefined : await harness.conversation(known, context);
		if (existing !== undefined) {
			// Pick up model changes from config.json once per process.
			if (!configured.has(existing.id)) {
				await existing.configure(agent, context);
				configured.add(existing.id);
			}
			return existing;
		}
		const created = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
		await created.commit(async (tx) => {
			(await tx.doc(Routes)).conversations[address] = created.id;
		}, context);
		return created;
	}

	async function addresses(context: Context) {
		return (await harness.snapshot(Routes, context))?.conversations ?? {};
	}

	async function setModel(choice: { provider: string; model: string; thinkingLevel: ModelThinkingLevel }, context: Context) {
		agent = { model: { provider: choice.provider, modelId: choice.model }, thinkingLevel: choice.thinkingLevel };
		for (const id of Object.values(await addresses(context))) {
			await (await harness.conversation(id, context))?.configure(agent, context);
			configured.add(id);
		}
	}

	harness.resume();
	return { harness, conversationFor, addresses, setModel };
}
