import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineDoc,
	defineEntry,
	defineExtension,
	defineTask,
	type EntryId,
	type EntryRecord,
	type Harness,
	type TaskId,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { STRIP_GUIDANCE } from "../decisions.ts";
import { type PromptResolver, readPrompt } from "../prompts.ts";
import { redactCoordinates, STRIP_LOCATION } from "../location.ts";
import { STRIP_CROSS_CLIENT } from "../search-index.ts";
import type { Notes, NotesResolver } from "./notes.ts";

/**
 * The memory pass. The front model is tuned to answer fast and rarely stops to call `remember`, so notes are also kept
 * from outside the conversation: once it has been quiet for a while (or right before `pi.reset` via `flushMemory`), a
 * separate request reads what was said since the last pass and adds or removes notes. One long-lived background task
 * per conversation does this; it sleeps between checks and survives restarts.
 */

export const Memory = defineDoc<{ keeper?: TaskId; reviewed?: EntryId }>({
	kind: "pclaw.memory",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** A display-only transcript entry (no model message) recording what a pass changed. */
export const NotesUpdate = defineEntry<{ added: string[]; removed: string[]; at: number }>("pclaw.notes-update");

const CHECK_MS = 5 * 60_000;
const RETRY_MS = 10 * 60_000;
const MESSAGE_LIMIT = 1_500;
const TRANSCRIPT_LIMIT = 40_000;
const INTERNAL = /<(follow-up|worker-report|job-update|job-result)[\s>]/;

const textOf = (message: Message): string =>
	typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** What the person and pclaw said to each other, oldest first. Tool calls, reports, and follow-ups are left out. */
export function conversationText(entries: readonly EntryRecord[]): { lines: string[]; lastAt?: number } {
	const lines: string[] = [];
	let lastAt: number | undefined;
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message === undefined) continue;
		if ("timestamp" in message && typeof message.timestamp === "number") lastAt = Math.max(lastAt ?? 0, message.timestamp);
		let line: string | undefined;
		if (UserEntry.is(entry) && message.role === "user") {
			const text = textOf(message).replace(STRIP_GUIDANCE, "").replace(STRIP_CROSS_CLIENT, "").replace(STRIP_LOCATION, "").trim();
			if (!INTERNAL.test(text)) line = `them: ${text}`;
		} else if (AssistantEntry.is(entry) && message.role === "assistant") {
			const text = textOf(message).trim();
			if ((message as AssistantMessage).stopReason !== "error" && text !== "" && !text.startsWith("NO_REPLY")) line = `pclaw: ${text}`;
		}
		// Notes never get precise coordinates; a town is as close as they go.
		if (line !== undefined) line = redactCoordinates(line);
		if (line !== undefined) lines.push(line.length > MESSAGE_LIMIT ? `${line.slice(0, MESSAGE_LIMIT)} [...]` : line);
	}
	// Keep the most recent part if a long stretch went unreviewed.
	while (lines.join("\n").length > TRANSCRIPT_LIMIT && lines.length > 1) lines.shift();
	return { lines, ...(lastAt === undefined ? {} : { lastAt }) };
}

/** Pull `{ add, remove }` out of the model's reply, tolerating a code fence or stray text around it. */
export function parseChanges(reply: string): { add: string[]; remove: string[] } {
	const match = /\{[\s\S]*\}/.exec(reply);
	if (match === null) throw new Error(`memory pass: no JSON in reply: ${reply.slice(0, 200)}`);
	const value = JSON.parse(match[0]) as { add?: unknown; remove?: unknown };
	const strings = (list: unknown) =>
		Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
	return { add: strings(value.add), remove: strings(value.remove) };
}

/** One memory pass over a stretch of conversation: what to add to the notes and what to remove. `pnpm evals:memory` runs this too. */
export async function reviewNotes(
	models: Models,
	config: Pick<Config, "provider" | "model">,
	current: string,
	lines: string[],
	signal?: AbortSignal,
	systemPrompt?: string,
): Promise<{ add: string[]; remove: string[] }> {
	const model = models.getModel(config.provider, config.model);
	if (model === undefined) throw new Error(`memory pass: unknown model ${config.provider}/${config.model}`);
	const input = `Current notes:\n\n${current.trim() || "(none yet)"}\n\nConversation since the last pass:\n\n${lines.join("\n\n")}`;
	const reply = await models.completeSimple(
		model,
		{ systemPrompt: systemPrompt ?? readPrompt("memory"), messages: [{ role: "user", content: input, timestamp: Date.now() }] },
		{ reasoning: "low", ...(signal === undefined ? {} : { signal }) },
	);
	if (reply.stopReason === "error") throw new Error(`memory pass: ${reply.errorMessage ?? "model error"}`);
	return parseChanges(textOf(reply));
}

type EntriesReader = (
	query: { minEntryId?: EntryId; order: "ascending" },
	limit: number,
	cursor: Cursor | undefined,
	context: Context,
) => Promise<{ items: readonly EntryRecord[]; next?: Cursor }>;

/** Read every unreviewed entry past `reviewed` (fork-safe and `pi.reset`-safe). */
async function readUnreviewedEntries(
	readEntries: EntriesReader,
	conversationId: ConversationId,
	reviewed: EntryId | undefined,
	context: Context,
): Promise<{ entries: EntryRecord[]; last?: EntryId }> {
	const entries: EntryRecord[] = [];
	let last: EntryId | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await readEntries(
			{
				...(reviewed === undefined ? {} : { minEntryId: (reviewed + 1) as EntryId }),
				order: "ascending",
			},
			200,
			cursor,
			context,
		);
		for (const entry of page.items) {
			if (last === undefined || entry.id > last) last = entry.id;
			if (entry.conversationId === conversationId) entries.push(entry);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return { entries, ...(last === undefined ? {} : { last }) };
}

function applyNoteChanges(userNotes: Notes, changes: { add: string[]; remove: string[] }): { added: string[]; removed: string[] } {
	const existing = new Set(userNotes.read().split("\n").map((line) => line.replace(/^-\s*/, "").trim()));
	const added = changes.add.filter((note) => !existing.has(note));
	const removed = changes.remove.filter((note) => userNotes.removeExact(note));
	for (const note of added) userNotes.add(note);
	return { added, removed };
}

/**
 * Flush any unreviewed entries for `conversationId` into `notes.md` right away (ignoring `quietMs`).
 * Called by `session-keeper` before `conversation.reset()` so no unreviewed facts are lost on session rollover.
 */
export async function flushMemory(
	harness: Harness,
	conversationId: ConversationId,
	options: {
		notes: Notes | NotesResolver;
		models: Models;
		config: Pick<Config, "provider" | "model">;
		prompts?: PromptResolver;
		now?: () => number;
	},
	context: Context,
): Promise<{ added: string[]; removed: string[] }> {
	const conversation = await harness.conversation(conversationId, context);
	if (conversation === undefined) return { added: [], removed: [] };
	const resolveNotes: NotesResolver = typeof options.notes === "function" ? options.notes : async () => options.notes as Notes;
	const reviewed = (await harness.snapshot(Memory, conversationId, context))?.reviewed;
	const { entries: fresh, last } = await readUnreviewedEntries(
		(query, limit, cursor, ctx) => conversation.entries(query, limit, cursor, ctx),
		conversationId,
		reviewed,
		context,
	);
	if (last === undefined) return { added: [], removed: [] };

	const { lines } = conversationText(fresh);
	const userNotes = await resolveNotes(harness, conversationId, context);
	if (userNotes === undefined) {
		await conversation.commit(async (tx) => {
			(await tx.doc(Memory, conversationId)).reviewed = last;
		}, context);
		return { added: [], removed: [] };
	}

	let changes = { add: [] as string[], remove: [] as string[] };
	if (lines.length > 0) {
		changes = await reviewNotes(
			options.models,
			options.config,
			userNotes.read(),
			lines,
			context.abortSignal,
			options.prompts?.read("memory"),
		);
	}
	const { added, removed } = applyNoteChanges(userNotes, changes);
	const at = options.now?.() ?? Date.now();
	await conversation.commit(async (tx) => {
		(await tx.doc(Memory, conversationId)).reviewed = last;
		if (added.length > 0 || removed.length > 0) {
			await tx.appendEntry(NotesUpdate, conversationId, { data: { added, removed, at } });
		}
	}, context);
	return { added, removed };
}

export function memoryExtension(options: {
	notes: Notes | NotesResolver;
	models: Models;
	config: Config;
	quietMs: number;
	prompts?: PromptResolver;
	now?: () => number;
}) {
	const { models, config } = options;
	const resolveNotes: NotesResolver = typeof options.notes === "function" ? options.notes : async () => options.notes as Notes;
	// Serialize per-conversation memory flushes between background Keeper and explicit pre-reset flushMemory().
	const locks = new Map<string, Promise<unknown>>();
	const serialize = <T>(id: ConversationId, fn: () => Promise<T>): Promise<T> => {
		const key = String(id);
		const prev = locks.get(key) ?? Promise.resolve();
		const run = prev.then(fn);
		const tracked = run
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				if (locks.get(key) === tracked) locks.delete(key);
			});
		locks.set(key, tracked);
		return run;
	};

	const Keeper = defineTask<null, { phase: "watch"; tick: number }, null>({
		name: "pclaw.memory-keeper",
		version: 1,
		initial: () => ({ phase: "watch", tick: 0 }),
		phases: {
			watch: async (task, runtime, context) => {
				// Each round saves a new checkpoint; Pi Durable doesn't rerun a phase whose checkpoint didn't change.
				const next = { phase: "watch", tick: task.state.checkpoint.tick + 1 } as const;
				const checkAgainAt = (until: number) => runtime.sleepUntil(until, next, context);
				const id = runtime.conversationId;

				await serialize(id, async () => {
					const now = runtime.now();
					const reviewed = (await runtime.snapshot(Memory, id, context))?.reviewed;
					const { entries: fresh, last } = await readUnreviewedEntries(
						(query, limit, cursor, ctx) => runtime.entries(query, limit, cursor, ctx),
						id,
						reviewed,
						context,
					);
					const { lines, lastAt } = conversationText(fresh);

					if (last === undefined) {
						await checkAgainAt(now + Math.min(CHECK_MS, options.quietMs));
						return;
					}
					if (lines.length > 0 && now < (lastAt ?? now) + options.quietMs) {
						await checkAgainAt((lastAt ?? now) + options.quietMs);
						return;
					}

					// Skip private-note updates on multi-user shared group chats.
					const userNotes = await resolveNotes(runtime, id, context);
					if (userNotes === undefined) {
						await runtime.commit(async (tx) => {
							(await tx.doc(Memory, id)).reviewed = last;
							return { status: "running", checkpoint: next };
						}, context);
						return;
					}

					let changes = { add: [] as string[], remove: [] as string[] };
					if (lines.length > 0) {
						try {
							changes = await reviewNotes(
								models,
								config,
								userNotes.read(),
								lines,
								context.abortSignal,
								options.prompts?.read("memory"),
							);
						} catch (error) {
							if (context.abortSignal?.aborted) throw error;
							runtime.report(error);
							await checkAgainAt(now + RETRY_MS);
							return;
						}
					}
					const { added, removed } = applyNoteChanges(userNotes, changes);

					await runtime.commit(async (tx) => {
						(await tx.doc(Memory, id)).reviewed = last;
						if (added.length > 0 || removed.length > 0) {
							await tx.appendEntry(NotesUpdate, id, { data: { added, removed, at: runtime.now() } });
						}
						return { status: "running", checkpoint: next };
					}, context);
				});
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	/** Start the conversation's keeper unless it already has a live one. */
	async function ensureKeeper(harness: Harness, conversationId: ConversationId, context: Context): Promise<void> {
		const keeper = (await harness.snapshot(Memory, conversationId, context))?.keeper;
		if (keeper !== undefined) {
			const record = await harness.getTask(keeper, context);
			if (record !== undefined && record.state.status !== "terminal") return;
		}
		const conversation = await harness.conversation(conversationId, context);
		await conversation?.commit(async (tx) => {
			const doc = await tx.doc(Memory, conversationId);
			doc.keeper = await tx.createTask(Keeper, null, { ownership: { kind: "conversation" }, background: true });
		}, context);
	}

	async function flush(harness: Harness, conversationId: ConversationId, context: Context): Promise<{ added: string[]; removed: string[] }> {
		return serialize(conversationId, () =>
			flushMemory(
				harness,
				conversationId,
				{
					notes: resolveNotes,
					models,
					config,
					...(options.prompts === undefined ? {} : { prompts: options.prompts }),
					...(options.now === undefined ? {} : { now: options.now }),
				},
				context,
			),
		);
	}

	return { extension: defineExtension({ name: "pclaw.memory", tasks: [Keeper] }), ensureKeeper, flushMemory: flush };
}
