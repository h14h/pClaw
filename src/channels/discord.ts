import type { Context } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import type { Agent } from "../agent.ts";
import { type Config, saveConfig } from "../config.ts";
import { deliver, type Outbox } from "../delivery.ts";
import { stamp } from "../time.ts";

const MAX_MESSAGE = 2000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPING_REFRESH_MS = 8_000;

const dmAddress = (userId: string) => `discord:dm:${userId}`;

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

async function toInput(message: Message, timeZone: string): Promise<UserInput> {
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
	const text = [`[${stamp(message.createdTimestamp, timeZone)}]`, message.content, ...notes].filter(Boolean).join("\n");
	return parts.length === 0 ? text : [{ type: "text", text }, ...parts];
}

/**
 * pclaw on Discord. Answers DMs from its owner only; the first person to DM it becomes the owner when none is
 * configured. Guild channels are ignored for now.
 */
export async function startDiscord(agent: Agent, config: Config, context: Context): Promise<{ stop(): Promise<void> }> {
	if (config.discordToken === undefined) throw new Error("No Discord token. Run `pnpm setup`.");
	let ownerId = config.discordOwnerId;

	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
		// DM channels are not cached until used; without this, the first DM after a restart is dropped.
		partials: [Partials.Channel],
	});

	const deliveries = new Map<string, { stop(): Promise<void> }>();

	function dmOutbox(userId: string): Outbox {
		let typing: NodeJS.Timeout | undefined;
		const channel = async () => (await client.users.fetch(userId)).createDM();
		return {
			async send(text) {
				const dm = await channel();
				for (const chunk of splitMessage(text)) await dm.send(chunk);
			},
			working(busy) {
				clearInterval(typing);
				typing = undefined;
				if (!busy) return;
				const ping = () => void channel().then((dm) => dm.sendTyping()).catch(() => undefined);
				ping();
				typing = setInterval(ping, TYPING_REFRESH_MS);
			},
		};
	}

	async function attach(userId: string) {
		const address = dmAddress(userId);
		if (deliveries.has(address)) return;
		const conversation = await agent.conversationFor(address, context);
		deliveries.set(address, await deliver(agent.harness, conversation.id, dmOutbox(userId), context));
	}

	client.on(Events.MessageCreate, async (message) => {
		try {
			if (message.author.bot || !message.channel.isDMBased()) return;
			if (ownerId === undefined) {
				ownerId = message.author.id;
				saveConfig({ discordOwnerId: ownerId });
				console.log(`[pclaw] paired with ${message.author.tag} (${ownerId})`);
			}
			if (message.author.id !== ownerId) return;
			await attach(ownerId);
			const conversation = await agent.conversationFor(dmAddress(ownerId), context);
			// Messages sent while pclaw is working join the current run at its next step, like a person cutting in.
			await conversation.submit(
				{ type: "input", content: await toInput(message, config.timeZone), whenBusy: "steer", requestId: `discord:${message.id}` },
				context,
			);
		} catch (error) {
			console.error("[pclaw] couldn't handle a Discord message", error);
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
		if (ownerId !== undefined) await attach(ownerId);
		else console.log("[pclaw] Waiting for a DM. The first person to message it becomes its owner.");
	});

	await client.login(config.discordToken);
	return {
		stop: async () => {
			for (const delivery of deliveries.values()) await delivery.stop();
			await client.destroy();
		},
	};
}
