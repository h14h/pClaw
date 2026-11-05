import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	ActionRowBuilder,
	type AnyThreadChannel,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	type Message,
	MessageFlags,
	Partials,
	type SendableChannels,
	ThreadAutoArchiveDuration,
} from "discord.js";
import type { Agent } from "../agent.ts";
import { type Config, paths, saveConfig } from "../config.ts";
import { deliver, type Outbox } from "../delivery.ts";
import type { Job, JobState, JobSurface } from "../extensions/jobs.ts";
import { Reactions } from "../extensions/reactions.ts";
import { Workers } from "../extensions/workers.ts";
import { type Heard, memoLabel, transcribe } from "../speech.ts";
import { stamp } from "../time.ts";

const MAX_MESSAGE = 2000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPING_REFRESH_MS = 8_000;
const QUOTE_LIMIT = 800;
const RESYNC_ON_ATTACH = 10;
/** Text channels in a category with this name are served without being listed in `discordChannels`. */
const PROJECTS_CATEGORY = "projects";

const JOB_LABELS: Record<JobState, string> = {
	working: "🟡 Working",
	needs_you: "🙋 Needs you",
	idle: "💤 Paused",
	blocked: "⚠️ Blocked",
	done: "✅ Done",
	failed: "❌ Failed",
	stopped: "⏹️ Stopped",
	closed: "📦 Closed",
};

const unix = (ms: number) => Math.floor(ms / 1000);

/** Whether pclaw answers in a channel. The board never counts, so nothing there can pull the owner's attention. */
export function serves(channelId: string, listed: Set<string>, category: string | undefined, board: string | undefined): boolean {
	if (channelId === board) return false;
	return listed.has(channelId) || category?.toLowerCase() === PROJECTS_CATEGORY;
}

/**
 * Where to show typing, so that no activity means nothing is happening: the thread of anything running, or, with no
 * thread (a DM), the conversation it started in.
 */
export function typingTargets(conversations: { address: string; workers: { status: string }[] }[], jobs: Pick<Job, "origin" | "background" | "state" | "worker" | "discordThreadId">[]): string[] {
	const running = jobs.filter((job) => job.state === "working");
	const inThreads = running.flatMap((job) => (job.discordThreadId === undefined ? [] : [`discord:thread:${job.discordThreadId}`]));
	const shown = (address: string) => running.some((job) => job.origin === address && job.worker !== undefined && job.discordThreadId !== undefined);
	const workers = conversations.filter(({ address, workers }) => workers.some((worker) => worker.status === "working") && !shown(address)).map(({ address }) => address);
	const background = running.filter((job) => job.background === true && job.discordThreadId === undefined).map((job) => job.origin);
	return [...new Set([...inThreads, ...workers, ...background])];
}

/** A job's status card. `<t:...:R>` renders as "12 minutes ago" and keeps itself current. */
export function jobCard(job: Job): string {
	const where = job.worker === undefined ? [job.machine, job.project].filter(Boolean).join(" · ") : "";
	const state = [JOB_LABELS[job.state], where, `started <t:${unix(job.startedAt)}:R>`].filter(Boolean).join(" · ");
	return [state, job.status].join("\n");
}

/** The one message that lists everything: what's live, then what ended in the last day. */
export function jobBoard(jobs: Job[], now = Date.now()): string {
	const line = (job: Job) => `${JOB_LABELS[job.state].split(" ")[0]} ${job.discordThreadId === undefined ? job.title : `<#${job.discordThreadId}>`} · ${job.machine} · ${job.status}`;
	const ended = (job: Job) => job.state === "done" || job.state === "failed" || job.state === "stopped" || job.state === "closed";
	const live = jobs.filter((job) => !ended(job));
	const recent = jobs.filter((job) => ended(job) && now - job.updatedAt < 24 * 60 * 60_000);
	const lines = [`**Jobs** · updated <t:${unix(now)}:R>`, ...(live.length === 0 ? ["Nothing running."] : live.map(line)), ...(recent.length === 0 ? [] : ["", "**Last 24 hours**", ...recent.map(line)])];
	return lines.join("\n").slice(0, MAX_MESSAGE);
}

/**
 * How pclaw maps Discord onto Pi Durable conversations:
 *   discord:dm:<user>        a DM: one long conversation
 *   discord:channel:<id>     a server channel on the allowlist: one long conversation
 *   discord:thread:<id>      a thread in such a channel: a fork of the channel's conversation at the message the thread
 *                            started from, so it knows everything up to that point and then goes its own way
 * A job's thread is one of these too, with a status card first. It's a session: the work and its result stay in it, and
 * replies land silently unless pinged.
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
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
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

async function toInput(message: Message, timeZone: string, context: string[], memo?: Heard): Promise<UserInput> {
	const parts: (TextContent | ImageContent)[] = [];
	const notes: string[] = memo === undefined ? [] : [memoLabel(memo.seconds), memo.text];
	for (const attachment of message.attachments.values()) {
		const type = attachment.contentType ?? "";
		if (type.startsWith("audio/")) {
			if (memo === undefined) notes.push("[sent a voice memo, but pclaw couldn't transcribe it]");
			continue;
		}
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
	const { jobs } = agent;

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

	/** Whether pclaw answers in this channel: it's on the list, or it sits in the Projects category. */
	function served(channelId: string): boolean {
		const channel = client.channels.cache.get(channelId);
		const category = channel !== undefined && "parent" in channel ? channel.parent?.name : undefined;
		return serves(channelId, channels, category, config.discordBoardChannel);
	}

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
				// About a job: silent unless the front model asked to notify, and then only the first message does.
				const mode = jobs.delivery(addr, text);
				for (const [index, chunk] of splitMessage(text).entries()) {
					const ping = mode === "ping" && index === 0 && config.discordQuiet !== true;
					const message = await channel.send({
						content: ping ? `<@${ownerId}> ${chunk}`.slice(0, MAX_MESSAGE) : chunk,
						...(mode === "silent" || (mode === "ping" && !ping) ? { flags: MessageFlags.SuppressNotifications } : {}),
					});
					sent.push(message.id);
				}
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
		// documentState() only attaches to a document that exists, and a conversation has none until its first reaction.
		await conversation.commit((tx) => tx.doc(Reactions, conversation.id), context);
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
				// On attach, bring the most recent asks up to date (a change may have landed while pclaw was down);
				// older ones are assumed applied, so a restart doesn't refetch every message ever reacted to.
				const recent = Object.entries(asks).slice(-RESYNC_ON_ATTACH);
				applied = Object.fromEntries(Object.entries(asks).slice(0, -RESYNC_ON_ATTACH));
				for (const [ref, emoji] of recent) applied[ref] = `${emoji}\u0000stale`;
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

	/** The conversation behind a thread in a served channel, forked from the channel's on first use. */
	async function threadRoute(channel: AnyThreadChannel): Promise<{ addr: string; conversation: Conversation; extra: string[] }> {
		const addr = address.thread(channel.id);
		const known = (await agent.addresses(context))[addr];
		if (known !== undefined) return { addr, conversation: (await agent.harness.conversation(known, context))!, extra: [] };
		const parent = await agent.conversationFor(address.channel(channel.parentId!), context);
		const { at, quote } = await forkPoint(channel, parent);
		const conversation =
			at === undefined
				? await agent.conversationFor(addr, context)
				: await agent.forkFor(addr, parent, at, { label: channel.name }, context);
		await agent.describe(conversation.id, { label: channel.name, parent: parent.id }, context);
		return { addr, conversation, extra: quote === undefined ? [] : [quote] };
	}

	async function conversationFor(message: Message): Promise<{ addr: string; conversation: Conversation; extra: string[] } | undefined> {
		const channel = message.channel;
		if (channel.isDMBased()) {
			const addr = address.dm(message.author.id);
			const conversation = await agent.conversationFor(addr, context);
			await agent.describe(conversation.id, { label: "Discord DM" }, context);
			return { addr, conversation, extra: [] };
		}
		if (channel.isThread() && channel.parentId !== null && served(channel.parentId)) return threadRoute(channel);
		if (channel.type === ChannelType.GuildText && served(channel.id)) {
			const addr = address.channel(channel.id);
			const conversation = await agent.conversationFor(addr, context);
			await agent.describe(conversation.id, { label: `#${channel.name}` }, context);
			return { addr, conversation, extra: [] };
		}
		return undefined;
	}

	/** The first audio attachment as text, or undefined. A failure leaves a note for the front model to pass on. */
	async function hear(message: Message): Promise<Heard | undefined> {
		const attachment = message.attachments.find((each) => each.contentType?.startsWith("audio/") === true);
		if (attachment === undefined || config.speechUrl === undefined) return undefined;
		const id = `message:${message.id}`;
		try {
			if (message.channel.isSendable()) await message.channel.sendTyping();
			const download = await fetch(attachment.url);
			if (!download.ok) throw new Error(`Discord returned ${download.status}`);
			const audio = new Uint8Array(await download.arrayBuffer());
			mkdirSync(paths.voice, { recursive: true, mode: 0o700 });
			writeFileSync(join(paths.voice, `${message.id}.ogg`), audio, { mode: 0o600 });
			const heard = await transcribe(config.speechUrl, audio);
			jobs.decisions.record({ type: "voice", id, ok: true, seconds: heard.seconds, ms: heard.ms, words: heard.text.split(/\s+/).filter(Boolean).length });
			console.log(`[pclaw] heard a ${Math.round(heard.seconds)}s voice memo in ${heard.ms}ms`);
			return heard;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			jobs.decisions.record({ type: "voice", id, ok: false, error: reason });
			console.error(`[pclaw] couldn't hear a voice memo: ${reason}`);
			return undefined;
		}
	}

	const cardControls = (job: Job) => {
		const row = new ActionRowBuilder<ButtonBuilder>();
		if (job.link !== undefined) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open in T3").setURL(job.link));
		return row.components.length === 0 ? [] : [row];
	};

	const threadOf = async (job: Job): Promise<AnyThreadChannel | undefined> => {
		const channel = job.discordThreadId === undefined ? null : await client.channels.fetch(job.discordThreadId).catch(() => null);
		return channel?.isThread() ? channel : undefined;
	};

	const surface: JobSurface = {
		async open(job) {
			const [, kind, id] = job.origin.split(":");
			let thread: AnyThreadChannel | undefined;
			if (kind === "thread") {
				const channel = await client.channels.fetch(id!);
				if (channel?.isThread()) thread = channel;
			} else if (kind === "channel") {
				const channel = await client.channels.fetch(id!);
				if (channel?.type !== ChannelType.GuildText) return undefined;
				const name = job.title.slice(0, 100);
				const options = { name, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek };
				if (job.ask?.startsWith("discord:")) {
					const message = await channel.messages.fetch(job.ask.slice("discord:".length));
					thread = message.thread ?? (await message.startThread(options));
				} else thread = await channel.threads.create(options);
			}
			if (thread === undefined) return undefined;
			const card = await thread.send({ content: jobCard(job), components: cardControls(job), flags: MessageFlags.SuppressNotifications });
			if (ownerId !== undefined && config.discordQuiet !== true) await thread.members.add(ownerId).catch((error: unknown) => console.error("[pclaw] couldn't add the owner to a job thread", error));
			return { discordThreadId: thread.id, cardMessageId: card.id };
		},
		async card(job) {
			if (job.cardMessageId === undefined) return;
			const thread = await threadOf(job);
			const card = await thread?.messages.fetch(job.cardMessageId);
			await card?.edit({ content: jobCard(job), components: cardControls(job) });
		},
		async note(job, text) {
			await (await threadOf(job))?.send({ content: text, flags: MessageFlags.SuppressNotifications });
		},
		async board(all) {
			if (config.discordBoardChannel === undefined) return;
			const channel = await client.channels.fetch(config.discordBoardChannel).catch(() => null);
			if (channel === null || !channel.isSendable() || !("messages" in channel)) return;
			const content = jobBoard(all);
			const existing = jobs.store.boardMessageId === undefined ? undefined : await channel.messages.fetch(jobs.store.boardMessageId).catch(() => undefined);
			// It's only ever read on purpose: nothing here may mention anyone or leave a notice.
			const allowedMentions = { parse: [] };
			if (existing !== undefined) await existing.edit({ content, allowedMentions });
			else jobs.store.boardMessageId = (await channel.send({ content, allowedMentions, flags: MessageFlags.SuppressNotifications })).id;
		},
		async conversation(job) {
			const thread = await threadOf(job);
			if (thread === undefined) return agent.conversationFor(job.origin, context);
			if (thread.archived === true) await thread.setArchived(false).catch(() => undefined);
			const route = await threadRoute(thread);
			await attach(route.addr, route.conversation);
			return route.conversation;
		},
		async remember(job, text) {
			// The channel's conversation keeps the outcome, without running the model or saying anything there.
			const conversation = await agent.conversationFor(job.origin, context);
			const content = `<job-result job="${job.id}" thread="${job.discordThreadId}">${job.title} finished in its thread:\n${text}</job-result>`;
			await conversation.submit({ type: "write", entry: { kind: "pclaw.job-result", data: { job: job.id }, model: [{ role: "user", content, timestamp: Date.now() }] } }, context);
		},
	};
	jobs.surface.current = surface;

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
			const memo = await hear(message);
			const guidance = await jobs.guideMessage({
				id: message.id,
				text: [message.content, memo?.text].filter(Boolean).join("\n"),
				channel: "name" in message.channel && message.channel.name !== null ? message.channel.name : "direct message",
				...(message.channel.isThread() ? { discordThreadId: message.channelId } : {}),
				...(memo === undefined ? {} : { voice: true }),
			});
			const extra = [...route.extra, ...(await replyContext(message, client.user!.id, config.timeZone)), ...(guidance === undefined ? [] : [guidance])];
			// Messages sent while pclaw is working join the current run at its next step, like a person cutting in.
			await route.conversation.submit(
				{
					type: "input",
					content: await toInput(message, config.timeZone, extra, memo),
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
			const job = jobs.store.forThread(message.channelId);
			if (job !== undefined) jobs.decisions.record({ type: "reaction", job: job.id, decision: job.decision, emoji, message: message.id });
			const content = `[${stamp(Date.now(), config.timeZone)}]\n[reacted ${emoji} to your message from ${stamp(message.createdTimestamp, config.timeZone)}: "${clip(message.content)}"]`;
			await conversation?.submit(
				{ type: "input", content, whenBusy: "followUp", requestId: `discord-reaction:${message.id}:${emoji}:${Date.now()}` },
				context,
			);
		} catch (error) {
			console.error("[pclaw] couldn't handle a reaction", error);
		}
	});

	// A run's typing ends when it hands work off, so keep it going for as long as that work is really running.
	const keepTyping = setInterval(() => {
		void (async () => {
			const known = await agent.addresses(context);
			const conversations = await Promise.all(
				[...deliveries.keys()].flatMap((address) => {
					const id = known[address];
					return id === undefined ? [] : [agent.harness.snapshot(Workers, id, context).then((doc) => ({ address, workers: Object.values(doc?.workers ?? {}) }))];
				}),
			);
			for (const addr of typingTargets(conversations, jobs.store.active())) await (await target(addr))?.sendTyping();
		})().catch((error: unknown) => console.error("[pclaw] typing", error));
	}, TYPING_REFRESH_MS);

	// Join threads as they open in pclaw's channels, so their messages reliably reach it.
	client.on(Events.ThreadCreate, async (thread) => {
		if (thread.parentId !== null && served(thread.parentId) && !thread.joined) {
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
			clearInterval(keepTyping);
			delete jobs.surface.current;
			await client.destroy();
		},
	};
}
