import type { Context } from "@earendil-works/chord/context";
import {
	AssistantEntry,
	defineExtension,
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

export type SoulOptions = {
	timeZone: string;
	prompts?: PromptResolver;
	flags?: PromptFeatureFlags;
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

export function formatRelativeAge(ageMs: number): string {
	const mins = Math.max(0, Math.round(ageMs / 60_000));
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	return `${hours}h ago`;
}

/**
 * The front model's system prompt: the active voice, how pclaw works (src/prompts/front.md), the user's time
 * zone, and (in multi-user mode) a 1-line cross-client awareness hint when the user recently spoke on another
 * client. Rendered before every request, so edits apply right away; Pi Durable only resends a section when it
 * changes, which keeps the prompt cache warm otherwise.
 */
export function soulExtension(timeZoneOrOptions: string | SoulOptions) {
	const opts: SoulOptions =
		typeof timeZoneOrOptions === "string" ? { timeZone: timeZoneOrOptions } : timeZoneOrOptions;
	const nowFn = opts.now ?? Date.now;

	return defineExtension({
		name: "pclaw.soul",
		sections: [
			section(
				"front",
				async (input, context) => {
					const channel = await channelOf(input.read, input.conversationId, context);
					const flags = { ...opts.flags, ...(channel === undefined ? {} : { channel }) };
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
			section("cross-client", async (input, context) => {
				const users = opts.users;
				const harness = opts.harness?.current;
				if (!users?.enabled || harness === undefined) return undefined;
				const routes = (await input.read.snapshot(Routes, context))?.conversations ?? {};
				const currentAddress = Object.keys(routes).find((addr) => routes[addr] === input.conversationId);
				if (currentAddress === undefined) return undefined;
				const user = users.resolveAddress(currentAddress);
				if (user === undefined) return undefined;
				const currentChannel = currentAddress.split(":")[0];
				let best: { channel: string; at: number } | undefined;
				for (const [otherAddr, otherId] of Object.entries(routes)) {
					if (otherId === input.conversationId) continue;
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
				return `Recent activity with ${user.name} on ${best.channel} (${formatRelativeAge(ageMs)}); use recall if they reference it.`;
			}),
		],
	});
}

/**
 * The rules for the app the conversation is on (src/prompts/formatting/<app>.md): what renders, how long a message can
 * be. Install it last so it ends the system prompt: the model follows rules it read last far more reliably, which
 * `pnpm prose-lab` showed when the same rules sat before the notes.
 */
export function formattingExtension(options?: { prompts?: PromptResolver; flags?: PromptFeatureFlags }) {
	return defineExtension({
		name: "pclaw.formatting",
		sections: [
			section("formatting", async (input, context) => {
				const channel = await channelOf(input.read, input.conversationId, context);
				if (channel === undefined) return undefined;
				return options?.prompts !== undefined
					? options.prompts.readFormatting(channel, options.flags)
					: readFormatting(channel, options?.flags);
			}),
		],
	});
}
