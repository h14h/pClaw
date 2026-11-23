import type { Context } from "@earendil-works/chord/context";
import { AssistantEntry, type Conversation, type EntryId } from "@earendil-works/pi-durable";

/** What's going on in the chat when a reply goes out, beyond which ask it answers. */
export type ReplyContext = {
	/** The reply is a delegate/message_worker ack: it dissolves if nothing else happens, so it moves nothing on. */
	isAck?: boolean;
	/** The asks of this conversation's workers that are still working ("" for one with no ask on record). */
	workingAsks?: readonly string[];
};

const OLD_TOPIC_LIMIT = 50;

/**
 * When an outgoing message should quote the message it answers, so interleaved topics leave a trail of breadcrumbs.
 * A plain back-and-forth stays plain. A reply quotes its ask when the chat has moved on since (the person asked
 * something else in between, or another worker's report went out first), while a worker is running in the background
 * (side chat and the work's own updates interleave), or when the ask was a swipe-reply to an older message (so the
 * jump back is linked). Tracked per conversation address, in memory; after a restart the first reply goes out plain.
 */
export class ReplyThreads {
	readonly #channel: string;
	/** Address -> the message id the chat is currently about: their latest message, or the ask last answered. */
	readonly #active = new Map<string, string>();
	/** Address -> the ids of the newest bubble group in the chat: their latest message(s) or the last reply's chunks. */
	readonly #latest = new Map<string, string[]>();
	/** Address -> asks that swipe-replied to an older message (a jump back to an earlier topic), not yet answered. */
	readonly #oldTopicAsks = new Map<string, Set<string>>();

	/** `channel` is the ref prefix this channel's asks carry ("telegram", "discord"). */
	constructor(channel: string) {
		this.#channel = channel;
	}

	/**
	 * The person sent a message (`messageIds`, the first being the ask): the chat is about it now. `repliedTo` is the
	 * message they swipe-replied to, if any: when it's older than the newest bubble in the chat, it's a jump back.
	 */
	heard(address: string, messageIds: string | number | readonly (string | number)[], repliedTo?: string | number): void {
		const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).map(String);
		const ask = ids[0];
		if (ask === undefined) return;
		if (repliedTo !== undefined && this.#isOlder(String(repliedTo), this.#latest.get(address))) {
			let asks = this.#oldTopicAsks.get(address);
			if (asks === undefined) this.#oldTopicAsks.set(address, (asks = new Set()));
			asks.add(ask);
			if (asks.size > OLD_TOPIC_LIMIT) asks.delete(asks.values().next().value!);
		}
		this.#active.set(address, ask);
		this.#latest.set(address, ids);
	}

	/** The bot posted a lasting (not ephemeral) message in the chat: it's the newest bubble now. */
	posted(address: string, messageIds: readonly (string | number)[]): void {
		if (messageIds.length > 0) this.#latest.set(address, messageIds.map(String));
	}

	/** Whether `replyTo` was a swipe-reply to an older message, still unanswered. */
	isOldTopic(address: string, replyTo: string | undefined): boolean {
		const id = this.askId(replyTo);
		return id !== undefined && (this.#oldTopicAsks.get(address)?.has(id) ?? false);
	}

	/** The id of this channel's message behind `replyTo` ("<channel>:<id>"), if it is one. */
	askId(replyTo: string | undefined): string | undefined {
		if (replyTo === undefined || !replyTo.startsWith(`${this.#channel}:`)) return undefined;
		const id = replyTo.slice(this.#channel.length + 1);
		return id === "" ? undefined : id;
	}

	/** The message id to quote for a reply to `replyTo`, or undefined to send it plainly. `forceQuote` quotes regardless. */
	target(address: string, replyTo: string | undefined, options?: { forceQuote?: boolean }): string | undefined {
		const id = this.askId(replyTo);
		if (id === undefined) return undefined;
		if (options?.forceQuote === true) return id;
		const active = this.#active.get(address);
		return active !== undefined && active !== id ? id : undefined;
	}

	/**
	 * Whether a reply to `replyTo` must quote even when the chat is on that ask. An ack quotes only when another worker
	 * is already running; any other reply quotes while a worker for some other ask is running, or after a jump back.
	 */
	forceQuote(address: string, replyTo: string | undefined, reply: ReplyContext = {}): boolean {
		const otherWorker = (reply.workingAsks ?? []).some((ask) => ask !== replyTo);
		if (reply.isAck === true) return otherWorker;
		return otherWorker || this.isOldTopic(address, replyTo);
	}

	/** `target` with `forceQuote` worked out from the chat's state. */
	quote(address: string, replyTo: string | undefined, reply: ReplyContext = {}): string | undefined {
		return this.target(address, replyTo, { forceQuote: this.forceQuote(address, replyTo, reply) });
	}

	/** A reply to `replyTo` went out (not an ephemeral one): the chat is about that ask now, and any jump is answered. */
	sent(address: string, replyTo: string | undefined): void {
		const id = this.askId(replyTo);
		if (id === undefined) return;
		this.#active.set(address, id);
		this.#oldTopicAsks.get(address)?.delete(id);
	}

	/** Whether message `id` is older than every message in `latest` (ids are numeric and grow over time). */
	#isOlder(id: string, latest: readonly string[] | undefined): boolean {
		if (latest === undefined || latest.length === 0) return false;
		const target = asNumber(id);
		if (target === undefined) return false;
		return latest.every((each) => {
			const other = asNumber(each);
			return other !== undefined && target < other;
		});
	}
}

/** Telegram message ids and Discord snowflakes both compare as integers; snowflakes need BigInt. */
function asNumber(id: string): bigint | undefined {
	return /^\d+$/.test(id) ? BigInt(id) : undefined;
}

/** Whether `entry` is the reply written alongside a `delegate` or `message_worker` call: an ack for work just handed off. */
export async function isDelegateAck(conversation: Conversation, entry: EntryId, context: Context): Promise<boolean> {
	const record = (await conversation.entries({ minEntryId: entry, maxEntryId: entry }, 1, undefined, context)).items[0];
	if (record === undefined || !AssistantEntry.is(record)) return false;
	const message = record.model?.[0] as { content?: { type?: string; name?: string }[] } | undefined;
	return message?.content?.some((part) => part.type === "toolCall" && (part.name === "delegate" || part.name === "message_worker")) ?? false;
}
