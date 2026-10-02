import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	type EntryId,
	Harness,
	type Storage,
} from "@earendil-works/pi-durable";
import { type Config, paths } from "./config.ts";
import { followUpsExtension } from "./extensions/follow-ups.ts";
import { memoryExtension } from "./extensions/memory.ts";
import { recallExtension } from "./extensions/recall.ts";
import { type Notes, notesExtension } from "./extensions/notes.ts";
import { soulExtension } from "./extensions/soul.ts";
import { ConversationInfo, Routes } from "./routes.ts";
import { prepareWorkspace, type WorkerOptions, workerOptions, workersExtension } from "./extensions/workers.ts";

export type Agent = {
	harness: Harness;
	/** The conversation for `address`, created on first use. */
	conversationFor(address: string, context: Context): Promise<Conversation>;
	/** Addresses that have a conversation, for reattaching delivery after a restart. */
	addresses(context: Context): Promise<Record<string, ConversationId>>;
	/**
	 * A new conversation for `address` that starts as a copy of `parent` up to `at` and continues on its own: a Discord
	 * thread off a channel, for instance. Returns the existing one if `address` already has a conversation.
	 */
	forkFor(address: string, parent: Conversation, at: EntryId, info: { label: string }, context: Context): Promise<Conversation>;
	/** Record how a conversation is labelled in the dashboard. */
	describe(id: ConversationId, info: { label: string; parent?: ConversationId }, context: Context): Promise<void>;
	/** Switch every conversation to another front model, from the next request on. */
	setModel(choice: { provider: string; model: string; thinkingLevel: ModelThinkingLevel }, context: Context): Promise<void>;
};

export async function openAgent(
	storage: Storage,
	options: {
		config: Config;
		models: Models;
		notes: Notes;
		workers?: WorkerOptions;
		/** How long a conversation stays quiet before the memory pass reads it. */
		memoryQuietMs?: number;
		now?: () => number;
	},
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
	const memory = memoryExtension({ notes, models, config, quietMs: options.memoryQuietMs ?? config.memoryQuietMinutes * 60_000 });
	registry.install(memory.extension);
	registry.install(recallExtension(current, config.timeZone));

	let agent = { model: { provider: config.provider, modelId: config.model }, thinkingLevel: config.thinkingLevel };
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: { retry: { maxRetries: 3 }, toolExecution: "parallel", compaction: { keepRecentTokens: config.keepRecentTokens } },
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
				await memory.ensureKeeper(harness, existing.id, context);
				configured.add(existing.id);
			}
			return existing;
		}
		const created = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
		await created.commit(async (tx) => {
			(await tx.doc(Routes)).conversations[address] = created.id;
		}, context);
		await memory.ensureKeeper(harness, created.id, context);
		configured.add(created.id);
		return created;
	}

	async function addresses(context: Context) {
		return (await harness.snapshot(Routes, context))?.conversations ?? {};
	}

	async function forkFor(address: string, parent: Conversation, at: EntryId, info: { label: string }, context: Context) {
		const known = (await harness.snapshot(Routes, context))?.conversations[address];
		const existing = known === undefined ? undefined : await harness.conversation(known, context);
		if (existing !== undefined) return existing;
		const fork = await parent.fork(at, { ownership: { kind: "ownerless" }, agent }, context);
		await fork.commit(async (tx) => {
			(await tx.doc(Routes)).conversations[address] = fork.id;
			(await tx.doc(ConversationInfo)).conversations[String(fork.id)] = { label: info.label, parent: parent.id, forkedAt: at };
		}, context);
		await memory.ensureKeeper(harness, fork.id, context);
		configured.add(fork.id);
		return fork;
	}

	async function describe(id: ConversationId, info: { label: string; parent?: ConversationId }, context: Context) {
		const current = (await harness.snapshot(ConversationInfo, context))?.conversations[String(id)];
		if (current?.label === info.label && current.parent === info.parent) return;
		const conversation = await harness.conversation(id, context);
		await conversation?.commit(async (tx) => {
			const doc = await tx.doc(ConversationInfo);
			// Keep the fork point; only the label and parent come from the channel.
			const forkedAt = doc.conversations[String(id)]?.forkedAt;
			doc.conversations[String(id)] = {
				label: info.label,
				...(info.parent === undefined ? {} : { parent: info.parent }),
				...(forkedAt === undefined ? {} : { forkedAt }),
			};
		}, context);
	}

	async function setModel(choice: { provider: string; model: string; thinkingLevel: ModelThinkingLevel }, context: Context) {
		agent = { model: { provider: choice.provider, modelId: choice.model }, thinkingLevel: choice.thinkingLevel };
		for (const id of Object.values(await addresses(context))) {
			await (await harness.conversation(id, context))?.configure(agent, context);
			configured.add(id);
		}
	}

	harness.resume();
	return { harness, conversationFor, addresses, forkFor, describe, setModel };
}
