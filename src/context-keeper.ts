import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationId, type EntryId, LiveDoc } from "@earendil-works/pi-durable";
import type { Agent } from "./agent.ts";

const CHECK_MS = 60_000;
/** An idle conversation holding this many copies of the notes gets summarized, which drops them. */
const NOTES_COPIES = 3;
/** How often to count notes copies in a conversation, and to retry a summary for them that failed. */
const COPIES_EVERY_MS = 30 * 60_000;

/** Copies of the notes section in the active transcript. */
async function notesCopies(agent: Agent, id: ConversationId, context: Context): Promise<number> {
	const conversation = await agent.harness.conversation(id, context);
	const entries = (await conversation?.context(context))?.entries ?? [];
	return entries.filter((entry) => typeof (entry.model?.[0] as { sections?: { notes?: unknown } } | undefined)?.sections?.notes === "string").length;
}

/**
 * The conversation's latest model request in the ACTIVE context: its entry, and its prompt tokens, cached or not.
 * Scanning `conversation.context()` (rather than raw `conversation.entries()`) guarantees a freshly reset
 * conversation never triggers compaction from a pre-reset high-token entry.
 */
export async function latestRequest(
	agent: Agent,
	id: ConversationId,
	context: Context,
): Promise<{ entry: EntryId; tokens: number } | undefined> {
	const conversation = await agent.harness.conversation(id, context);
	const entries = (await conversation?.context(context))?.entries ?? [];
	const entry = entries.findLast((each) => AssistantEntry.is(each));
	const latest = entry?.model?.[0] as AssistantMessage | undefined;
	if (entry === undefined || latest === undefined) return undefined;
	return { entry: entry.id, tokens: latest.usage.input + latest.usage.cacheRead + latest.usage.cacheWrite };
}

/**
 * Keeps each conversation's context small: once a request's prompt passes `thresholdTokens` and the conversation is
 * idle, ask Pi Durable to summarize everything but the most recent messages. When `sessionReset.enabled` is true,
 * token-based compaction is demoted to an emergency backstop (`emergencyCompactTokens`, default 110k) and the legacy
 * 3-notes-copies trigger is skipped.
 */
export function startContextKeeper(
	agent: Agent,
	thresholdTokens: number,
	context: Context,
	everyMs = CHECK_MS,
	options: { checkNotesCopies?: boolean } = {},
): { stop(): void; tick(): Promise<void> } {
	const checkNotesCopies = options.checkNotesCopies ?? true;
	const pending = new Set<string>();
	// The token count only changes with a new request, so one request is only worth one attempt.
	const attempted = new Map<string, EntryId>();
	const counted = new Map<string, number>();
	const check = async () => {
		for (const id of Object.values(await agent.addresses(context))) {
			if (pending.has(String(id))) continue;
			const live = await agent.harness.snapshot(LiveDoc, id, context);
			if (live?.run !== undefined || (live?.compactions?.length ?? 0) > 0) continue;
			const latest = await latestRequest(agent, id, context);
			if (latest === undefined) continue;
			let reason: string;
			if (latest.tokens >= thresholdTokens && attempted.get(String(id)) !== latest.entry) {
				attempted.set(String(id), latest.entry);
				reason = `${latest.tokens} prompt tokens`;
			} else if (checkNotesCopies) {
				if (Date.now() - (counted.get(String(id)) ?? 0) < COPIES_EVERY_MS) continue;
				counted.set(String(id), Date.now());
				const copies = await notesCopies(agent, id, context);
				if (copies < NOTES_COPIES) continue;
				reason = `${copies} copies of the notes`;
			} else {
				continue;
			}
			const conversation = await agent.harness.conversation(id, context);
			if (conversation === undefined) continue;
			pending.add(String(id));
			const task = await conversation.compact(agent.prompts.read("compaction"), context);
			console.log(`[pclaw] summarizing conversation ${id} (${reason})`);
			void agent.harness
				.waitForTask(task, context)
				.catch((error: unknown) => console.error("[pclaw] summary failed", error))
				.finally(() => pending.delete(String(id)));
		}
	};
	const timer = setInterval(() => void check().catch((error: unknown) => console.error("[pclaw] context check", error)), everyMs);
	return { stop: () => clearInterval(timer), tick: check };
}
