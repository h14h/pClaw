import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Harness,
	UserEntry,
	watchEvents,
} from "@earendil-works/pi-durable";

/** Where a conversation's replies go: a Discord DM, a terminal. */
export type Outbox = {
	/** `entry` is the transcript entry the text came from, so a channel can map its messages back to it. */
	send(text: string, entry: EntryId): Promise<void>;
	/** Called with true when the agent starts working on something and false when it's done. */
	working(busy: boolean): void;
};

/** The last assistant entry sent out, so a restart neither drops nor repeats replies. */
const Delivered = defineDoc<{ last?: EntryId }>({
	kind: "pclaw.delivered",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

export const SILENT = "NO_REPLY";

export type Reply =
	/** Text written alongside tool calls, mid-run. */
	| { kind: "interim"; text: string }
	/** The run's answer; `text` is undefined when it's empty, and `silent` when the model chose NO_REPLY. */
	| { kind: "final"; text?: string; silent: boolean };

export function readReply(entry: EntryRecord): Reply | undefined {
	if (!AssistantEntry.is(entry)) return undefined;
	const message = entry.model?.[0] as AssistantMessage | undefined;
	return message === undefined ? undefined : readAssistantReply(message);
}

export function readAssistantReply(message: AssistantMessage): Reply | undefined {
	if (message.stopReason === "aborted") return undefined;
	if (message.stopReason === "error") {
		return { kind: "final", text: `(something broke on my end: ${message.errorMessage ?? "unknown error"})`, silent: false };
	}
	const text = message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.filter((text, index, texts) => index === 0 || text !== texts[index - 1])
		.join("")
		.trim();
	if (message.stopReason === "toolUse") return { kind: "interim", text };
	const silent = text.startsWith(SILENT);
	return { kind: "final", ...(text === "" || silent ? {} : { text }), silent };
}

/**
 * Collapses one run into one message. Models often say something before a tool call ("I'll check") and again after it
 * ("checking now"); only the answer goes out. Keep the longest interim if it's at least 100 characters and the final
 * is absent, silent, or less than half as long, appending a distinct final. Empty finals and runs ending at a tool call
 * still fall back to interim text (`delegate` ends the run as soon as the worker starts).
 */
export function replyCollector() {
	let interim: string[] = [];
	const flush = (): string | undefined => {
		const held = interim;
		interim = [];
		return held.length === 0 ? undefined : held.join("\n\n");
	};
	const take = (reply: Reply): string | undefined => {
		if (reply.kind === "interim") {
			if (reply.text !== "") interim.push(reply.text);
			return undefined;
		}
		const longest = interim.reduce((best, text) => text.length > best.length ? text : best, "");
		const held = flush();
		if (longest.length >= 100 && (reply.text?.length ?? 0) < longest.length / 2) {
			return reply.silent || reply.text === undefined || longest.includes(reply.text) ? longest : `${longest}\n\n${reply.text}`;
		}
		return reply.silent ? undefined : (reply.text ?? held);
	};
	return { take, flush };
}

/**
 * Send every new assistant reply in a conversation to `outbox`, in order. Replies written while nothing was attached
 * (pclaw was restarting, a follow-up fired during a Discord outage) go out on attach. The first attach to a
 * conversation starts from its end.
 */
export async function deliver(
	harness: Harness,
	conversationId: ConversationId,
	outbox: Outbox,
	context: Context,
): Promise<{ stop(): Promise<void> }> {
	const conversation = await harness.conversation(conversationId, context);
	if (conversation === undefined) throw new Error(`No conversation ${conversationId}`);

	let queue = Promise.resolve();
	let lastQueued: EntryId | undefined;
	const collector = replyCollector();
	let heldEntry: EntryId | undefined;
	const send = async (text: string | undefined, entry: EntryId | undefined) => {
		if (text === undefined || entry === undefined) return;
		try {
			await outbox.send(text, entry);
		} catch (error) {
			console.error("[pclaw] delivery failed", error);
		}
	};
	const sendInOrder = (entry: EntryRecord) => {
		lastQueued = entry.id;
		queue = queue.then(async () => {
			const reply = readReply(entry);
			if (reply?.kind === "interim" && reply.text !== "") heldEntry = entry.id;
			await send(reply === undefined ? undefined : collector.take(reply), reply?.kind === "final" && reply.text === undefined ? heldEntry : entry.id);
			await conversation.commit(async (tx) => {
				(await tx.doc(Delivered, conversationId)).last = entry.id;
			}, context);
		});
	};
	/** A run ended (or a new one began) with text still held: send it. */
	const flushInOrder = () => {
		queue = queue.then(() => send(collector.flush(), heldEntry));
	};

	const stream = await watchEvents(harness, conversationId, context);
	const catchUp = (entries: readonly EntryRecord[], last: EntryId | undefined) => {
		// A cursor that compaction has hidden counts as caught up; resending the visible transcript would be worse.
		const index = last === undefined ? -1 : entries.findIndex((entry) => entry.id === last);
		const start = index === -1 ? entries.length : index + 1;
		for (const entry of entries.slice(start)) {
			if (AssistantEntry.is(entry)) sendInOrder(entry);
			else if (UserEntry.is(entry)) flushInOrder();
		}
		if (last === undefined && entries.length > 0) {
			const end = entries[entries.length - 1]!.id;
			lastQueued = end;
			queue = queue.then(() =>
				conversation.commit(async (tx) => {
					(await tx.doc(Delivered, conversationId)).last = end;
				}, context),
			);
		}
	};
	lastQueued = (await harness.snapshot(Delivered, conversationId, context))?.last;
	catchUp(stream.snapshot.entries, lastQueued);
	if (stream.snapshot.run !== undefined) outbox.working(true);

	stream.start(async (events) => {
		for (const event of events) {
			// A consumer that fell far behind gets a fresh snapshot instead of the missed events.
			if (event.type === "snapshot") catchUp(event.entries, lastQueued);
			else if (event.type === "run_start") outbox.working(true);
			else if (event.type === "run_end") {
				outbox.working(false);
				flushInOrder();
			}
			else if (event.type === "message_end" && AssistantEntry.is(event.entry)) sendInOrder(event.entry);
		}
	});
	return {
		stop: async () => {
			await stream.stop();
			await queue;
		},
	};
}
