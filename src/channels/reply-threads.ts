/**
 * When an outgoing message should quote the message it answers. A normal back-and-forth stays plain. A reply quotes
 * its ask only when the chat has moved on since: the person asked something else in between, or another worker's
 * report went out first. Tracked per conversation address, in memory; after a restart the first reply goes out plain.
 */
export class ReplyThreads {
	readonly #channel: string;
	/** Address -> the message id the chat is currently about: their latest message, or the ask last answered. */
	readonly #active = new Map<string, string>();

	/** `channel` is the ref prefix this channel's asks carry ("telegram", "discord"). */
	constructor(channel: string) {
		this.#channel = channel;
	}

	/** The person sent a message: the chat is about it now. */
	heard(address: string, messageId: string | number): void {
		this.#active.set(address, String(messageId));
	}

	/** The id of this channel's message behind `replyTo` ("<channel>:<id>"), if it is one. */
	askId(replyTo: string | undefined): string | undefined {
		if (replyTo === undefined || !replyTo.startsWith(`${this.#channel}:`)) return undefined;
		const id = replyTo.slice(this.#channel.length + 1);
		return id === "" ? undefined : id;
	}

	/** The message id to quote for a reply to `replyTo`, or undefined to send it plainly. */
	target(address: string, replyTo: string | undefined): string | undefined {
		const id = this.askId(replyTo);
		if (id === undefined) return undefined;
		const active = this.#active.get(address);
		return active !== undefined && active !== id ? id : undefined;
	}

	/** A reply to `replyTo` went out (not an ephemeral one): the chat is about that ask now. */
	sent(address: string, replyTo: string | undefined): void {
		const id = this.askId(replyTo);
		if (id !== undefined) this.#active.set(address, id);
	}
}
