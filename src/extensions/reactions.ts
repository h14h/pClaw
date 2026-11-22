import type { Context } from "@earendil-works/chord/context";
import { obj, str } from "@earendil-works/pi-schema";
import {
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTool,
	type DocumentReader,
	type Harness,
	LiveDoc,
	type Tx,
} from "@earendil-works/pi-durable";
import { isTelegramReactionEmoji, normalizeTelegramReaction } from "../channels/telegram-format.ts";

/**
 * Reactions as status. Each of the person's messages that asked for something can carry one reaction from pclaw,
 * kept here as the desired state; the channel (Discord) makes the real reactions match. Messages are identified by
 * their submission's request ID, e.g. "discord:<message id>", so this stays channel-neutral.
 *
 * Code owns the timing (a job starting, its report arriving, a failure); the model owns the emoji, chosen in calls it
 * already makes (delegate's `emoji`, the `react` tool). One reaction per message: a new one replaces the old.
 */
export const Reactions = defineDoc<{
	/** Message ref -> the emoji pclaw wants on it ("" for none). */
	asks: Record<string, string>;
	/** Request ID of a worker report -> the message ref of the ask that started the job. */
	reports: Record<string, string>;
}>({
	kind: "pclaw.reactions",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ asks: {}, reports: {} }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

export const WORKING = "⏳";
export const FAILED = "⚠️";
export const STEERED = "🫡";

/** True for a single emoji (allowing modifiers and joiners), so a model's ":tada:" or "done!" is refused up front. */
export function isEmoji(text: string): boolean {
	return /^(\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣]*$/u.test(text);
}

export async function setReaction(tx: Tx, conversationId: ConversationId, ref: string, emoji: string): Promise<void> {
	(await tx.doc(Reactions, conversationId)).asks[ref] = emoji;
}

/**
 * The message the current run is about: the person's message that started it, or, when a worker's report started it,
 * the message that asked for that job. Undefined when the run came from somewhere without a message (a follow-up).
 */
export async function currentAsk(
	harness: Harness | undefined,
	read: DocumentReader,
	conversationId: ConversationId,
	context: Context,
): Promise<string | undefined> {
	const inputs = (await read.snapshot(LiveDoc, conversationId, context))?.run?.inputs ?? [];
	const latest = inputs.at(-1);
	if (latest === undefined || harness === undefined) return undefined;
	const requestId = (await (await harness.submission(latest, context))?.status(context))?.requestId;
	if (requestId === undefined) return undefined;
	const viaReport = (await read.snapshot(Reactions, conversationId, context))?.reports[requestId];
	if (viaReport !== undefined) return viaReport;
	// A message from the person: "<channel>:<message id>". Follow-ups, reports, and their reactions have other shapes.
	return /^[a-z]+:[^:]+$/.test(requestId) && !requestId.startsWith("worker-report:") ? requestId : undefined;
}

export function reactionsExtension(harness: { current?: Harness }) {
	return defineExtension({
		name: "pclaw.reactions",
		tools: [
			defineTool({
				name: "react",
				description:
					"Put one emoji reaction on their message: the one you're answering, or, when you're relaying a worker's " +
					"report, the message that asked for the job. Pick the literal emoji when there is one (🍜 for ramen, 🖥️ for " +
					"a computer), a positive one that fits the topic and your voice (🎉, 🔥, 💯, ✅) when a job is done and the news is good, something warmer for hard news, and never ✅ " +
					"on bad news. A reaction can be the whole reply: for \"thanks\" or \"ok sounds good\", react and reply NO_REPLY. " +
					"It replaces any reaction you put there before; pass \"none\" to clear it. Follow your app's formatting guide for " +
					"which reactions it supports.",
				parameters: obj({ emoji: str({ description: "One emoji, or \"none\"." }) }, { open: true }),
				execute: async ({ emoji }, api, context) => {
					const value = emoji.trim() === "none" ? "" : emoji.trim();
					if (value !== "" && !isEmoji(value)) throw new Error(`"${emoji}" isn't a single emoji.`);
					const ref = await currentAsk(harness.current, api, api.conversationId, context);
					if (ref === undefined) return { output: [{ type: "text" as const, text: "There's no message of theirs to react to here." }] };
					// Telegram only takes its own reaction set: store what they'll actually see, and say so when it had to swap one in.
					const mapped = value !== "" && ref.startsWith("telegram:") ? (normalizeTelegramReaction(value, "👌") ?? value) : value;
					await api.commit((tx) => setReaction(tx, api.conversationId, ref, mapped), context);
					const text =
						mapped === "" ? "Cleared."
						: mapped !== value && !isTelegramReactionEmoji(value) ? `Reacted ${mapped} (Telegram does not support ${value}; pick from your formatting guide's supported reactions).`
						: `Reacted ${mapped}.`;
					return { output: [{ type: "text" as const, text }] };
				},
			}),
		],
	});
}
