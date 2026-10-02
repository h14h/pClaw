import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import type { Agent } from "./agent.ts";
import { readPrompt } from "./prompts.ts";

const CHECK_MS = 60_000;

/** Prompt tokens of the conversation's latest model request, cached or not. */
async function promptTokens(agent: Agent, id: ConversationId, context: Context): Promise<number | undefined> {
	const conversation = await agent.harness.conversation(id, context);
	const page = await conversation?.entries({}, 30, undefined, context);
	const latest = page?.items.find((entry) => AssistantEntry.is(entry))?.model?.[0] as AssistantMessage | undefined;
	if (latest === undefined) return undefined;
	return latest.usage.input + latest.usage.cacheRead + latest.usage.cacheWrite;
}

/**
 * Keeps each conversation's context small: once a request's prompt passes `thresholdTokens` and the conversation is
 * idle, ask Pi Durable to summarize everything but the most recent messages. Pi Durable's own trigger sits near the
 * model's full context window, far past where replies get slow and the middle of the thread gets lost; long-term
 * facts live in the notes, so the word-for-word part can stay short.
 */
export function startContextKeeper(agent: Agent, thresholdTokens: number, context: Context): { stop(): void } {
	const pending = new Set<string>();
	const check = async () => {
		for (const id of Object.values(await agent.addresses(context))) {
			if (pending.has(String(id))) continue;
			const live = await agent.harness.snapshot(LiveDoc, id, context);
			if (live?.run !== undefined || (live?.compactions?.length ?? 0) > 0) continue;
			const tokens = await promptTokens(agent, id, context);
			if (tokens === undefined || tokens < thresholdTokens) continue;
			const conversation = await agent.harness.conversation(id, context);
			if (conversation === undefined) continue;
			pending.add(String(id));
			const task = await conversation.compact(readPrompt("compaction"), context);
			console.log(`[pclaw] summarizing conversation ${id} (${tokens} prompt tokens)`);
			void agent.harness
				.waitForTask(task, context)
				.catch((error: unknown) => console.error("[pclaw] summary failed", error))
				.finally(() => pending.delete(String(id)));
		}
	};
	const timer = setInterval(() => void check().catch((error: unknown) => console.error("[pclaw] context check", error)), CHECK_MS);
	return { stop: () => clearInterval(timer) };
}
