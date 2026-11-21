import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type DocumentReader, type EntryId } from "@earendil-works/pi-durable";

/**
 * Which conversation answers which address, e.g. "discord:dm:<user id>". One DM is one conversation today; group
 * chats and per-channel contexts later get their own addresses and conversations.
 */
export const Routes = defineDoc<{ conversations: Record<string, ConversationId> }>({
	kind: "pclaw.routes",
	version: 1,
	scope: "session",
	initial: () => ({ conversations: {} }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** The address a conversation is bound to, e.g. "telegram:dm:123" or "discord:channel:456". */
export async function addressOf(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<string | undefined> {
	const routes = (await read.snapshot(Routes, context))?.conversations ?? {};
	return Object.keys(routes).find((key) => routes[key] === conversationId);
}

/** The app a conversation lives in: "discord", "telegram", "terminal". The part of its address before the first colon. */
export async function channelOf(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<string | undefined> {
	const address = await addressOf(read, conversationId, context);
	return address?.split(":")[0];
}

/** How a conversation shows up in the dashboard, and where it forked from. Set by the channel that created it. */
export const ConversationInfo = defineDoc<{
	conversations: Record<string, { label: string; parent?: ConversationId; forkedAt?: EntryId }>;
}>({
	kind: "pclaw.conversation-info",
	version: 1,
	scope: "session",
	initial: () => ({ conversations: {} }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});
