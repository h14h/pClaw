import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type ConversationId,
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
import { readPrompt } from "../prompts.ts";
import type { Notes } from "./notes.ts";

/**
 * The memory pass. The front model is tuned to answer fast and rarely stops to call `remember`, so notes are also kept
 * from outside the conversation: once it has been quiet for a while, a separate request reads what was said since the
 * last pass and adds or removes notes. One long-lived background task per conversation does this; it sleeps between
 * checks and survives restarts.
 */

export const Memory = defineDoc<{ keeper?: TaskId; reviewed?: EntryId }>({
	kind: "pclaw.memory",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

/** A display-only transcript entry (no model message) recording what a pass changed. */
export const NotesUpdate = defineEntry<{ added: string[]; removed: string[]; at: number }>("pclaw.notes-update");

const CHECK_MS = 5 * 60_000;
const RETRY_MS = 10 * 60_000;
const MESSAGE_LIMIT = 1_500;
const TRANSCRIPT_LIMIT = 40_000;
const INTERNAL = /<(follow-up|worker-report)[\s>]/;

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
			const text = textOf(message).trim();
			if (!INTERNAL.test(text)) line = `them: ${text}`;
		} else if (AssistantEntry.is(entry) && message.role === "assistant") {
			const text = textOf(message).trim();
			if ((message as AssistantMessage).stopReason !== "error" && text !== "" && !text.startsWith("NO_REPLY")) line = `pclaw: ${text}`;
		}
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

export function memoryExtension(options: { notes: Notes; models: Models; config: Config; quietMs: number }) {
	const { notes, models, config } = options;

	async function review(lines: string[], signal: AbortSignal | undefined): Promise<{ add: string[]; remove: string[] }> {
		const model = models.getModel(config.provider, config.model);
		if (model === undefined) throw new Error(`memory pass: unknown model ${config.provider}/${config.model}`);
		const input = `Current notes:\n\n${notes.read().trim() || "(none yet)"}\n\nConversation since the last pass:\n\n${lines.join("\n\n")}`;
		const reply = await models.completeSimple(
			model,
			{ systemPrompt: readPrompt("memory"), messages: [{ role: "user", content: input, timestamp: Date.now() }] },
			{ reasoning: "low", ...(signal === undefined ? {} : { signal }) },
		);
		if (reply.stopReason === "error") throw new Error(`memory pass: ${reply.errorMessage ?? "model error"}`);
		return parseChanges(textOf(reply));
	}

	const Keeper = defineTask<null, { phase: "watch"; tick: number }, null>({
		name: "pclaw.memory-keeper",
		version: 1,
		initial: () => ({ phase: "watch", tick: 0 }),
		phases: {
			watch: async (task, runtime, context) => {
				// Each round saves a new checkpoint; Pi Durable doesn't rerun a phase whose checkpoint didn't change.
				const next = { phase: "watch", tick: task.state.checkpoint.tick + 1 } as const;
				const again = () => runtime.commit(() => ({ status: "running", checkpoint: next }), context);
				const id = runtime.conversationId;
				const now = runtime.now();
				const { entries } = await runtime.context(id, context);
				const reviewed = (await runtime.snapshot(Memory, id, context))?.reviewed;
				// A reviewed entry that compaction has hidden: start from what's visible.
				const index = reviewed === undefined ? -1 : entries.findIndex((entry) => entry.id === reviewed);
				const fresh = entries.slice(index + 1);
				const last = fresh.at(-1)?.id;
				const { lines, lastAt } = conversationText(fresh);

				if (last === undefined) {
					await runtime.sleep(now + Math.min(CHECK_MS, options.quietMs), context);
					return again();
				}
				if (lines.length > 0 && now < (lastAt ?? now) + options.quietMs) {
					await runtime.sleep((lastAt ?? now) + options.quietMs, context);
					return again();
				}

				let changes = { add: [] as string[], remove: [] as string[] };
				if (lines.length > 0) {
					try {
						changes = await review(lines, context.abortSignal);
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						runtime.report(error);
						await runtime.sleep(now + RETRY_MS, context);
						return again();
					}
				}
				const existing = new Set(notes.read().split("\n").map((line) => line.replace(/^-\s*/, "").trim()));
				const added = changes.add.filter((note) => !existing.has(note));
				const removed = changes.remove.filter((note) => notes.removeExact(note));
				for (const note of added) notes.add(note);

				await runtime.commit(async (tx) => {
					(await tx.doc(Memory, id)).reviewed = last;
					if (added.length > 0 || removed.length > 0) {
						await tx.appendEntry(NotesUpdate, id, { data: { added, removed, at: runtime.now() } });
					}
					return { status: "running", checkpoint: next };
				}, context);
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

	return { extension: defineExtension({ name: "pclaw.memory", tasks: [Keeper] }), ensureKeeper };
}
