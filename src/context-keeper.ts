import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationId, type EntryId, LiveDoc } from "@earendil-works/pi-durable";
import type { Agent } from "./agent.ts";

const CHECK_MS = 60_000;
/** An idle conversation holding this many copies of the notes gets summarized, which drops them (see `notesView`). */
const NOTES_COPIES = 3;
/** How often to count notes copies in a conversation, and to retry a summary for them that failed. */
const COPIES_EVERY_MS = 30 * 60_000;

/** Copies of the notes section in the active transcript. */
async function notesCopies(agent: Agent, id: ConversationId, context: Context): Promise<number> {
	const conversation = await agent.harness.conversation(id, context);
	const entries = (await conversation?.context(context))?.entries ?? [];
	return entries.filter((entry) => typeof (entry.model?.[0] as { sections?: { notes?: unknown } } | undefined)?.sections?.notes === "string").length;
}

/** The conversation's latest model request: its entry, and its prompt tokens, cached or not. */
async function latestRequest(agent: Agent, id: ConversationId, context: Context): Promise<{ entry: EntryId; tokens: number } | undefined> {
	const conversation = await agent.harness.conversation(id, context);
	const page = await conversation?.entries({}, 30, undefined, context);
	const entry = page?.items.find((each) => AssistantEntry.is(each));
	const latest = entry?.model?.[0] as AssistantMessage | undefined;
	if (entry === undefined || latest === undefined) return undefined;
	return { entry: entry.id, tokens: latest.usage.input + latest.usage.cacheRead + latest.usage.cacheWrite };
}

/**
 * Keeps each conversation's context small: once a request's prompt passes `thresholdTokens` and the conversation is
 * idle, ask Pi Durable to summarize everything but the most recent messages. Pi Durable's own trigger sits near the
 * model's full context window, far past where replies get slow and the middle of the thread gets lost; long-term
 * facts live in the notes, so the word-for-word part can stay short. It also summarizes a conversation that holds several
 * copies of the notes (from before they were sent as changes, or after large refreshes), so old and removed notes leave
 * the model's view.
 */
export function startContextKeeper(agent: Agent, thresholdTokens: number, context: Context, everyMs = CHECK_MS): { stop(): void } {
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
			} else {
				if (Date.now() - (counted.get(String(id)) ?? 0) < COPIES_EVERY_MS) continue;
				counted.set(String(id), Date.now());
				const copies = await notesCopies(agent, id, context);
				if (copies < NOTES_COPIES) continue;
				reason = `${copies} copies of the notes`;
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
	const timer = setInterval(() => void check().catch((error: unknown) => console.error("[pclaw] context check", error)), CHECK_MS);
	return { stop: () => clearInterval(timer) };
}
