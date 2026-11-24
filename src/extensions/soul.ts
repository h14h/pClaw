import type { Context } from "@earendil-works/chord/context";
import {
	AssistantEntry,
	type ConversationId,
	defineExtension,
	type DocumentReader,
	type EntryRecord,
	type Harness,
	section,
	UserEntry,
} from "@earendil-works/pi-durable";
import {
	frontPrompt,
	type PromptFeatureFlags,
	type PromptResolver,
	readFormatting,
} from "../prompts.ts";
import { addressOf, channelOf, Routes } from "../routes.ts";
import type { UserRegistry } from "../users.ts";

const CROSS_CLIENT_WINDOW_MS = 24 * 60 * 60_000;

export type PromptFlagsResolver = (
	read: DocumentReader,
	conversationId: ConversationId,
	context: Context,
) => Promise<PromptFeatureFlags>;

export type SoulOptions = {
	timeZone: string;
	prompts?: PromptResolver;
	flags?: PromptFeatureFlags;
	resolveFlags?: PromptFlagsResolver;
	users?: UserRegistry;
	harness?: { current?: Harness };
	now?: () => number;
};

function latestMessageTimestamp(entries: readonly EntryRecord[]): number | undefined {
	for (const entry of entries) {
		if (!UserEntry.is(entry) && !AssistantEntry.is(entry)) continue;
		const msg = entry.model?.[0] as { timestamp?: unknown } | undefined;
		if (typeof msg?.timestamp === "number") return msg.timestamp;
	}
	return undefined;
}

/**
 * Compute a static 1-line `<cross-client>` tail hint for an inbound user message when the person
 * recently switched channels (another channel for the same user had newer activity within 24h than
 * the current conversation's last message). Never mutates `pi.system` / KV cache, never leaks across
 * users, and never emits inside group chats.
 */
export async function crossClientHint(
	options: {
		harness?: Harness;
		users?: UserRegistry;
		now?: () => number;
	},
	conversationId: ConversationId,
	context: Context,
): Promise<string | undefined> {
	const harness = options.harness;
	if (harness === undefined) return undefined;
	const nowFn = options.now ?? Date.now;
	const users = options.users;
	const routes = (await harness.snapshot(Routes, context))?.conversations ?? {};
	const currentAddress = Object.keys(routes).find((addr) => routes[addr] === conversationId);
	if (currentAddress === undefined) return undefined;
	const currentChannel = currentAddress.split(":")[0];

	const currentConv = await harness.conversation(conversationId, context);
	const currentLastAt =
		currentConv === undefined
			? undefined
			: latestMessageTimestamp((await currentConv.entries({}, 10, undefined, context)).items);

	if (users?.enabled) {
		const user = users.resolveAddress(currentAddress);
		if (user === undefined) return undefined;
		let best: { channel: string; at: number } | undefined;
		for (const [otherAddr, otherId] of Object.entries(routes)) {
			if (otherId === conversationId) continue;
			const otherChannel = otherAddr.split(":")[0];
			if (otherChannel === undefined || otherChannel === currentChannel) continue;
			if (users.resolveAddress(otherAddr)?.id !== user.id) continue;
			const otherConv = await harness.conversation(otherId, context);
			if (otherConv === undefined) continue;
			const page = await otherConv.entries({}, 10, undefined, context);
			const at = latestMessageTimestamp(page.items);
			if (at !== undefined && (best === undefined || at > best.at)) {
				best = { channel: otherChannel, at };
			}
		}
		if (best === undefined) return undefined;
		const ageMs = nowFn() - best.at;
		if (ageMs < 0 || ageMs > CROSS_CLIENT_WINDOW_MS) return undefined;
		if (currentLastAt !== undefined && best.at <= currentLastAt) return undefined;
		return `<cross-client>Recent activity with ${user.name} on ${best.channel}; use recall if they reference it.</cross-client>`;
	}

	// Single-owner multi-client mode (e.g. Discord + Telegram sharing one owner): never leak into Telegram groups.
	if (currentAddress.startsWith("telegram:group:")) return undefined;
	let best: { channel: string; at: number } | undefined;
	for (const [otherAddr, otherId] of Object.entries(routes)) {
		if (otherId === conversationId) continue;
		if (otherAddr.startsWith("telegram:group:")) continue;
		const otherChannel = otherAddr.split(":")[0];
		if (otherChannel === undefined || otherChannel === currentChannel) continue;
		const otherConv = await harness.conversation(otherId, context);
		if (otherConv === undefined) continue;
		const page = await otherConv.entries({}, 10, undefined, context);
		const at = latestMessageTimestamp(page.items);
		if (at !== undefined && (best === undefined || at > best.at)) {
			best = { channel: otherChannel, at };
		}
	}
	if (best === undefined) return undefined;
	const ageMs = nowFn() - best.at;
	if (ageMs < 0 || ageMs > CROSS_CLIENT_WINDOW_MS) return undefined;
	if (currentLastAt !== undefined && best.at <= currentLastAt) return undefined;
	return `<cross-client>Recent activity on ${best.channel}; use recall if they reference it.</cross-client>`;
}

/**
 * The front model's system prompt: the active voice, how pclaw works (src/prompts/front.md), and the user's time
 * zone. Rendered deterministically with zero time-varying fields so the KV prompt cache stays 100% warm across turns.
 */
export function soulExtension(timeZoneOrOptions: string | SoulOptions) {
	const opts: SoulOptions =
		typeof timeZoneOrOptions === "string" ? { timeZone: timeZoneOrOptions } : timeZoneOrOptions;

	return defineExtension({
		name: "pclaw.soul",
		sections: [
			section(
				"front",
				async (input, context) => {
					const channel = await channelOf(input.read, input.conversationId, context);
					const baseFlags =
						opts.resolveFlags !== undefined
							? await opts.resolveFlags(input.read, input.conversationId, context)
							: opts.flags;
					const flags = { ...baseFlags, ...(channel === undefined ? {} : { channel }) };
					return opts.prompts !== undefined ? opts.prompts.frontPrompt(flags) : frontPrompt(flags);
				},
				{ tag: false },
			),
			section("time-zone", async (input, context) => {
				let tz = opts.timeZone;
				if (opts.users?.enabled) {
					const address = await addressOf(input.read, input.conversationId, context);
					const user = opts.users.resolveAddress(address);
					if (user?.timeZone !== undefined) tz = user.timeZone;
				}
				return `They live in the ${tz} time zone unless they say otherwise.`;
			}),
		],
	});
}

/**
 * The rules for the app the conversation is on (src/prompts/formatting/<app>.md): what renders, how long a message can
 * be. Install it last so it ends the system prompt: the model follows rules it read last far more reliably, which
 * `pnpm prose-lab` showed when the same rules sat before the notes.
 */
export function formattingExtension(options?: {
	prompts?: PromptResolver;
	flags?: PromptFeatureFlags;
	resolveFlags?: PromptFlagsResolver;
}) {
	return defineExtension({
		name: "pclaw.formatting",
		sections: [
			section("formatting", async (input, context) => {
				const channel = await channelOf(input.read, input.conversationId, context);
				if (channel === undefined) return undefined;
				const flags =
					options?.resolveFlags !== undefined
						? await options.resolveFlags(input.read, input.conversationId, context)
						: options?.flags;
				return options?.prompts !== undefined
					? options.prompts.readFormatting(channel, flags)
					: readFormatting(channel, flags);
			}),
		],
	});
}
