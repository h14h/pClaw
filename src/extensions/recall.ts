import type { Context } from "@earendil-works/chord/context";
import { lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Harness,
	UserEntry,
} from "@earendil-works/pi-durable";
import { Routes } from "../routes.ts";
import { parseSince, scopeForAddress, type SearchHit, type SearchIndex } from "../search-index.ts";
import { stamp } from "../time.ts";
import type { UserRegistry } from "../users.ts";

const SCAN_LIMIT = 5_000;
const RESULTS = 6;
const FTS_RESULTS = 8;
const SNIPPET = 600;
const STOP = new Set(
	"the and for that this with you your are was were have has had but not what when where which who how about from they them their there then than just like into out our can could would should will did does all any some its it's i'm".split(
		" ",
	),
);

export type Hit = { at: number; who: "them" | "pclaw"; text: string; score: number };

const terms = (query: string) =>
	[...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9'.-]*/g) ?? [])].filter((term) => term.length > 2 && !STOP.has(term));

function textOf(entry: EntryRecord): { who: "them" | "pclaw"; text: string; at: number } | undefined {
	const message = entry.model?.[0];
	if (message === undefined || message.role === "system" || message.role === "toolResult") return undefined;
	const content = message.content;
	const text = (typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))
		.replace(/^\[[^\]\n]*\]\n?/, "")
		.trim();
	if (text === "" || text.startsWith("NO_REPLY")) return undefined;
	if (UserEntry.is(entry) && message.role === "user") return { who: "them", text, at: message.timestamp };
	if (AssistantEntry.is(entry) && message.role === "assistant") return { who: "pclaw", text, at: message.timestamp };
	return undefined;
}

function snippet(text: string, words: string[]): string {
	if (text.length <= SNIPPET) return text;
	const lower = text.toLowerCase();
	const first = Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0), text.length);
	const start = Math.max(0, first - SNIPPET / 3);
	return `${start > 0 ? "…" : ""}${text.slice(start, start + SNIPPET).trim()}…`;
}

/** Rank messages by how many query terms they contain, then by recency. Exact phrase matches count extra. */
export function search(messages: { who: "them" | "pclaw"; text: string; at: number }[], query: string): Hit[] {
	const words = terms(query);
	if (words.length === 0) return [];
	const phrase = query.toLowerCase().trim();
	return messages
		.map((message) => {
			const lower = message.text.toLowerCase();
			const score = words.filter((word) => lower.includes(word)).length + (phrase.length > 5 && lower.includes(phrase) ? words.length : 0);
			return { ...message, text: snippet(message.text, words), score };
		})
		.filter((hit) => hit.score >= Math.min(2, words.length))
		.sort((a, b) => b.score - a.score || b.at - a.at)
		.slice(0, RESULTS);
}

function formatFtsHit(hit: SearchHit, tz: string): string {
	const when = stamp(hit.timestamp, tz);
	if (hit.kind === "episode") {
		return `[${when} · ${hit.channel} · episode] ${hit.title}\n${hit.snippet}`;
	}
	if (hit.kind === "worker_report") {
		const label = hit.title ? `report (${hit.title})` : "report";
		return `[${when} · ${hit.channel} · ${label}] ${hit.snippet}`;
	}
	return `[${when} · ${hit.channel} · chat] ${hit.who}: ${hit.snippet}`;
}

/**
 * Search everything said in past conversations, including distilled episodes, worker reports, and messages no longer
 * in active context. Messages still visible in the current conversation's active context are excluded.
 *
 * Strictly partitioned by canonical `userId` in multi-user mode (cross-client continuity across Telegram/Discord
 * without cross-user leakage). Shared group chats only search their own history.
 */
export function recallExtension(
	harness: { current?: Harness },
	timeZone: string,
	options?: { users?: UserRegistry; index?: SearchIndex; now?: () => number },
) {
	const users = options?.users;
	const index = options?.index;
	const nowFn = options?.now ?? Date.now;

	async function allowedRoutes(currentId: string, context: Context): Promise<{
		routes: [string, ConversationId][];
		currentAddress: string | undefined;
		scope: string;
		timeZone: string;
	}> {
		const h = harness.current;
		if (h === undefined) throw new Error("pclaw is still starting up.");
		const allRoutes = (await h.snapshot(Routes, context))?.conversations ?? {};
		const entries = Object.entries(allRoutes) as [string, ConversationId][];
		const currentEntry = entries.find(([, id]) => String(id) === currentId);
		const currentAddress = currentEntry?.[0];
		const scope = scopeForAddress(currentAddress, currentId, users);

		let resolvedTimeZone = timeZone;
		if (users?.enabled) {
			const caller = users.resolveAddress(currentAddress);
			if (caller?.timeZone !== undefined) resolvedTimeZone = caller.timeZone;
		}

		const matching = entries.filter(([addr, id]) => scopeForAddress(addr, id, users) === scope);
		return { routes: matching, currentAddress, scope, timeZone: resolvedTimeZone };
	}

	async function legacyArchive(currentId: string, context: Context) {
		const h = harness.current;
		if (h === undefined) throw new Error("pclaw is still starting up.");
		const visible = new Set(
			((await (await h.conversation(currentId as never, context))?.context(context))?.entries ?? []).map((entry) => String(entry.id)),
		);
		const { routes, timeZone: resolvedTimeZone } = await allowedRoutes(currentId, context);

		const seen = new Set<string>();
		const messages: { who: "them" | "pclaw"; text: string; at: number }[] = [];
		for (const [, id] of routes) {
			const conversation = await h.conversation(id, context);
			if (conversation === undefined) continue;
			let cursor: Cursor | undefined;
			let scanned = 0;
			do {
				const page = await conversation.entries({}, 200, cursor, context);
				for (const entry of page.items) {
					const key = String(entry.id);
					if (seen.has(key) || visible.has(key)) continue;
					seen.add(key);
					const message = textOf(entry);
					if (message !== undefined) messages.push(message);
				}
				scanned += page.items.length;
				cursor = page.next;
			} while (cursor !== undefined && scanned < SCAN_LIMIT);
		}
		return { messages, timeZone: resolvedTimeZone };
	}

	return defineExtension({
		name: "pclaw.recall",
		tools: [
			defineTool({
				name: "recall",
				description:
					"Search past sessions, distilled episode summaries, worker reports, and older messages no longer in view. " +
					"Use it when they refer to something from earlier (\"what was that case you found\", \"like we talked about " +
					"last week\"), or when your notes or recent episodes mention something and you need specifics. Search with " +
					"a few distinctive words, not a sentence.",
				parameters: obj(
					{
						query: str({ description: "A few distinctive words, e.g. \"walnut NAS case\"." }),
						kind: opt(
							union([lit("all"), lit("episodes"), lit("messages")], {
								description: "Optional filter: \"all\" (default), \"episodes\" (session summaries only), or \"messages\" (raw chat & worker reports).",
							}),
						),
						since: opt(
							str({
								description: "Optional time cutoff: ISO date (\"2026-11-01\") or relative window (\"7d\", \"24h\", \"2w\").",
							}),
						),
					},
					{ open: true },
				),
				replay: "safe",
				execute: async ({ query, kind, since }, api, context) => {
					const currentId = String(api.conversationId);
					if (index === undefined) {
						const { messages, timeZone: tz } = await legacyArchive(currentId, context);
						const hits = search(messages, query);
						const text =
							hits.length === 0
								? "Nothing found. Try different words, or ask them."
								: hits.map((hit) => `[${stamp(hit.at, tz)}] ${hit.who}: ${hit.text}`).join("\n\n");
						return { output: [{ type: "text" as const, text }] };
					}

					const h = harness.current;
					if (h === undefined) throw new Error("pclaw is still starting up.");
					const { routes, scope, timeZone: tz } = await allowedRoutes(currentId, context);
					for (const [addr, id] of routes) {
						await index.syncConversation(h, id, addr, context, users);
					}

					const currentConv = await h.conversation(api.conversationId, context);
					const visibleIds = new Set(
						((await currentConv?.context(context))?.entries ?? []).map((entry) => Number(entry.id)),
					);
					const sinceMs = parseSince(since, nowFn());
					const hits = index.search({
						userId: scope,
						query,
						...(kind === undefined ? {} : { kind }),
						...(sinceMs === undefined ? {} : { sinceMs }),
						limit: FTS_RESULTS,
						excludeConversationId: currentId,
						excludeEntryIds: visibleIds,
					});

					const text =
						hits.length === 0
							? "Nothing found. Try different words, or ask them."
							: hits.map((hit) => formatFtsHit(hit, tz)).join("\n\n");
					return { output: [{ type: "text" as const, text }] };
				},
			}),
		],
	});
}
