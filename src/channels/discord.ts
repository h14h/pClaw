import type { Context } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	defineDoc,
	type EntryId,
	type UserInput,
} from "@earendil-works/pi-durable";
import {
	type AnyThreadChannel,
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	type Message,
	Partials,
	type SendableChannels,
} from "discord.js";
import type { Agent } from "../agent.ts";
import { type Config, saveConfig } from "../config.ts";
import { deliver, type Outbox } from "../delivery.ts";
import { Reactions } from "../extensions/reactions.ts";
import { stamp } from "../time.ts";

const MAX_MESSAGE = 2000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPING_REFRESH_MS = 8_000;
const QUOTE_LIMIT = 800;

/**
 * How pclaw maps Discord onto Pi Durable conversations:
 *   discord:dm:<user>        a DM: one long conversation
 *   discord:channel:<id>     a server channel on the allowlist: one long conversation
 *   discord:thread:<id>      a thread in such a channel: a fork of the channel's conversation at the message the thread
 *                            started from, so it knows everything up to that point and then goes its own way
 * A reply to an earlier message quotes it into the new message, which brings it back even after it's been summarized.
 */
const address = {
	dm: (userId: string) => `discord:dm:${userId}`,
	channel: (channelId: string) => `discord:channel:${channelId}`,
	thread: (threadId: string) => `discord:thread:${threadId}`,
};

/** Which transcript entry each message pclaw sent came from, so a thread started on it can fork at that point. */
const SentMessages = defineDoc<{ messages: Record<string, { conversation: ConversationId; entry: EntryId }> }>({
	kind: "pclaw.discord-sent",
	version: 1,
	scope: "session",
	initial: () => ({ messages: {} }),
});

/** Split text into Discord-sized messages, preferring paragraph, then line, then word breaks. */
export function splitMessage(text: string, limit = MAX_MESSAGE): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const cut = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")].find(
			(index) => index > limit / 2,
		);
		const at = cut ?? limit;
		chunks.push(rest.slice(0, at).trimEnd());
		rest = rest.slice(at).trimStart();
	}
	if (rest !== "") chunks.push(rest);
	return chunks;
}

const clip = (text: string) => (text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text);

async function toInput(message: Message, timeZone: string, context: string[]): Promise<UserInput> {
	const parts: (TextContent | ImageContent)[] = [];
	const notes: string[] = [];
	for (const attachment of message.attachments.values()) {
		const type = attachment.contentType ?? "";
		if (type.startsWith("image/") && attachment.size <= MAX_IMAGE_BYTES) {
			const response = await fetch(attachment.url);
			if (response.ok) {
				const data = Buffer.from(await response.arrayBuffer()).toString("base64");
				parts.push({ type: "image", data, mimeType: type.split(";")[0]! });
				continue;
			}
		}
		notes.push(`[attached ${attachment.name} (${type || "unknown type"}, ${attachment.size} bytes), which I can't open yet]`);
	}
	const text = [`[${stamp(message.createdTimestamp, timeZone)}]`, ...context, message.content, ...notes].filter(Boolean).join("\n");
	return parts.length === 0 ? text : [{ type: "text", text }, ...parts];
}

/** "[replying to your message from Fri 2026-10-02 13:10: "..."]" when the message is a reply. */
async function replyContext(message: Message, botId: string, timeZone: string): Promise<string[]> {
	if (message.reference?.messageId === undefined) return [];
	const quoted = await message.fetchReference().catch(() => undefined);
	if (quoted === undefined || quoted.content.trim() === "") return [];
	const whose = quoted.author.id === botId ? "your" : "their own";
	return [`[replying to ${whose} message from ${stamp(quoted.createdTimestamp, timeZone)}: "${clip(quoted.content.trim())}"]`];
}

/**
 * pclaw on Discord. Answers only its owner: in DMs, and in the server channels listed in `discordChannels` and their
 * threads. The first person to DM it becomes the owner when none is configured.
 */
export async function startDiscord(agent: Agent, config: Config, context: Context): Promise<{ stop(): Promise<void> }> {
	if (config.discordToken === undefined) throw new Error("No Discord token. Run `pnpm setup`.");
	let ownerId = config.discordOwnerId;
	const channels = new Set(config.discordChannels);

	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.DirectMessageReactions,
			// Reading server messages needs the privileged Message Content intent, so only ask when channels are configured.
			...(channels.size > 0
				? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions]
				: []),
		],
		// Uncached DM channels, and reactions on messages from before a restart, arrive as partials; without these
		// they're dropped.
		partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
	});

	const deliveries = new Map<string, { stop(): Promise<void> }>();

	async function target(addr: string): Promise<SendableChannels | undefined> {
		const [, kind, id] = addr.split(":");
		if (kind === "dm") return (await client.users.fetch(id!)).createDM();
		const channel = await client.channels.fetch(id!).catch(() => null);
		return channel?.isSendable() ? channel : undefined;
	}

	function outbox(addr: string, conversation: Conversation): Outbox {
		let typing: NodeJS.Timeout | undefined;
		return {
			async send(text, entry) {
				const channel = await target(addr);
				if (channel === undefined) throw new Error(`Can't reach ${addr}`);
				const sent: string[] = [];
				for (const chunk of splitMessage(text)) sent.push((await channel.send(chunk)).id);
				await conversation.commit(async (tx) => {
					const doc = await tx.doc(SentMessages);
					for (const id of sent) doc.messages[id] = { conversation: conversation.id, entry };
				}, context);
			},
			working(busy) {
				clearInterval(typing);
				typing = undefined;
				if (!busy) return;
				const ping = () => void target(addr).then((channel) => channel?.sendTyping()).catch(() => undefined);
				ping();
				typing = setInterval(ping, TYPING_REFRESH_MS);
			},
		};
	}

	/**
	 * Make pclaw's reactions in Discord match the conversation's Reactions doc. Only changes after attaching are applied;
	 * one sync at a time per conversation, so quick ⏳ -> ✅ changes land in order.
	 */
	async function syncReactions(addr: string, conversation: Conversation): Promise<() => void> {
		const state = await agent.harness.documentState(Reactions, conversation.id, context);
		if (state === undefined) return () => undefined;
		let applied: Record<string, string> | undefined;
		let queue = Promise.resolve();
		const apply = async (ref: string, emoji: string) => {
			if (!ref.startsWith("discord:")) return;
			const channel = await target(addr);
			if (channel === undefined || !("messages" in channel)) return;
			const message = await channel.messages.fetch(ref.slice("discord:".length));
			for (const reaction of message.reactions.cache.values()) {
				if (reaction.me && reaction.emoji.name !== emoji) await reaction.users.remove(client.user!.id);
			}
			if (emoji !== "" && !message.reactions.cache.get(emoji)?.me) await message.react(emoji);
		};
		return state.subscribe(async (value) => {
			const asks = { ...(value?.asks ?? {}) };
			if (applied === undefined) {
				applied = asks;
				return;
			}
			const before = applied;
			applied = asks;
			for (const [ref, emoji] of Object.entries(asks)) {
				if (before[ref] === emoji) continue;
				queue = queue.then(() => apply(ref, emoji)).catch((error: unknown) => console.error(`[pclaw] reaction ${ref}`, error));
			}
		});
	}

	async function attach(addr: string, conversation: Conversation) {
		if (deliveries.has(addr)) return;
		deliveries.set(addr, { stop: async () => undefined });
		const delivery = await deliver(agent.harness, conversation.id, outbox(addr, conversation), context);
		const unsync = await syncReactions(addr, conversation);
		deliveries.set(addr, {
			stop: async () => {
				unsync();
				await delivery.stop();
			},
		});
	}

	/** Where a thread forks from its channel: the entry behind the message it started on, if that's still visible. */
	async function forkPoint(thread: AnyThreadChannel, parent: Conversation): Promise<{ at?: EntryId; quote?: string }> {
		const visible = (await parent.context(context)).entries;
		const isVisible = (id: EntryId | undefined) => id !== undefined && visible.some((entry) => entry.id === id);
		const sent = (await agent.harness.snapshot(SentMessages, context))?.messages[thread.id];
		const asked = await parent.commit((tx) => tx.submissionByRequest(parent.id, `discord:${thread.id}`), context);
		const candidate =
			sent?.conversation === parent.id ? sent.entry : asked !== undefined && "answer" in asked && asked.answer !== undefined ? asked.answer : asked?.entry;
		if (isVisible(candidate)) return { at: candidate! };
		// Started on a message pclaw can't place (too old, or from before pclaw): fork at the latest and quote it.
		const starter = await thread.fetchStarterMessage().catch(() => null);
		const latest = visible.at(-1)?.id;
		return {
			...(latest === undefined ? {} : { at: latest }),
			...(starter?.content ? { quote: `[this thread started from a message from ${stamp(starter.createdTimestamp, config.timeZone)}: "${clip(starter.content)}"]` } : {}),
		};
	}

	async function conversationFor(message: Message): Promise<{ addr: string; conversation: Conversation; extra: string[] } | undefined> {
		const channel = message.channel;
		if (channel.isDMBased()) {
			const addr = address.dm(message.author.id);
			const conversation = await agent.conversationFor(addr, context);
			await agent.describe(conversation.id, { label: "Discord DM" }, context);
			return { addr, conversation, extra: [] };
		}
		if (channel.isThread() && channel.parentId !== null && channels.has(channel.parentId)) {
			const addr = address.thread(channel.id);
			const known = (await agent.addresses(context))[addr];
			if (known !== undefined) return { addr, conversation: (await agent.harness.conversation(known, context))!, extra: [] };
			const parent = await agent.conversationFor(address.channel(channel.parentId), context);
			const { at, quote } = await forkPoint(channel, parent);
			const conversation =
				at === undefined
					? await agent.conversationFor(addr, context)
					: await agent.forkFor(addr, parent, at, { label: channel.name }, context);
			await agent.describe(conversation.id, { label: channel.name, parent: parent.id }, context);
			return { addr, conversation, extra: quote === undefined ? [] : [quote] };
		}
		if (channel.type === ChannelType.GuildText && channels.has(channel.id)) {
			const addr = address.channel(channel.id);
			const conversation = await agent.conversationFor(addr, context);
			await agent.describe(conversation.id, { label: `#${channel.name}` }, context);
			return { addr, conversation, extra: [] };
		}
		return undefined;
	}

	client.on(Events.MessageCreate, async (message) => {
		try {
			if (message.author.bot) return;
			if (ownerId === undefined && message.channel.isDMBased()) {
				ownerId = message.author.id;
				saveConfig({ discordOwnerId: ownerId });
				console.log(`[pclaw] paired with ${message.author.tag} (${ownerId})`);
			}
			if (message.author.id !== ownerId) return;
			const route = await conversationFor(message);
			if (route === undefined) return;
			await attach(route.addr, route.conversation);
			const extra = [...route.extra, ...(await replyContext(message, client.user!.id, config.timeZone))];
			// Messages sent while pclaw is working join the current run at its next step, like a person cutting in.
			await route.conversation.submit(
				{
					type: "input",
					content: await toInput(message, config.timeZone, extra),
					whenBusy: "steer",
					requestId: `discord:${message.id}`,
				},
				context,
			);
		} catch (error) {
			console.error("[pclaw] couldn't handle a Discord message", error);
		}
	});

	// The owner's reactions on pclaw's messages reach it as a short input: an acknowledgment, an answer, a go-ahead.
	client.on(Events.MessageReactionAdd, async (partial, partialUser) => {
		try {
			if (partialUser.id !== ownerId) return;
			const reaction = partial.partial ? await partial.fetch() : partial;
			const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
			if (message.author.id !== client.user!.id) return;
			const known = await agent.addresses(context);
			const addr = Object.keys(known).find((key) =>
				message.channel.isDMBased() ? key === address.dm(ownerId!) : key === address.channel(message.channelId) || key === address.thread(message.channelId),
			);
			if (addr === undefined) return;
			const conversation = await agent.harness.conversation(known[addr]!, context);
			const emoji = reaction.emoji.name ?? "?";
			const content = `[${stamp(Date.now(), config.timeZone)}]\n[reacted ${emoji} to your message from ${stamp(message.createdTimestamp, config.timeZone)}: "${clip(message.content)}"]`;
			await conversation?.submit(
				{ type: "input", content, whenBusy: "followUp", requestId: `discord-reaction:${message.id}:${emoji}:${Date.now()}` },
				context,
			);
		} catch (error) {
			console.error("[pclaw] couldn't handle a reaction", error);
		}
	});

	// Join threads as they open in pclaw's channels, so their messages reliably reach it.
	client.on(Events.ThreadCreate, async (thread) => {
		if (thread.parentId !== null && channels.has(thread.parentId) && !thread.joined) {
			await thread.join().catch((error: unknown) => console.error("[pclaw] couldn't join a thread", error));
		}
	});

	client.once(Events.ClientReady, async (ready) => {
		console.log(`[pclaw] on Discord as ${ready.user.tag}`);
		if (ready.guilds.cache.size === 0) {
			console.log(
				"[pclaw] Not in any server yet, so nobody can DM it. Add it to a server you're in:\n" +
					`  https://discord.com/oauth2/authorize?client_id=${ready.application.id}&scope=bot&permissions=0`,
			);
		}
		// Reattach every Discord conversation, so replies written while pclaw was down go out now.
		for (const [addr, id] of Object.entries(await agent.addresses(context))) {
			if (!addr.startsWith("discord:")) continue;
			const conversation = await agent.harness.conversation(id, context);
			if (conversation !== undefined) await attach(addr, conversation).catch((error: unknown) => console.error(`[pclaw] ${addr}`, error));
		}
		if (ownerId === undefined) console.log("[pclaw] Waiting for a DM. The first person to message it becomes its owner.");
	});

	await client.login(config.discordToken);
	return {
		stop: async () => {
			for (const delivery of deliveries.values()) await delivery.stop();
			await client.destroy();
		},
	};
}
