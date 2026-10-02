import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Cursor,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Harness,
	UserEntry,
} from "@earendil-works/pi-durable";
import { Routes } from "../routes.ts";
import { stamp } from "../time.ts";

const SCAN_LIMIT = 5_000;
const RESULTS = 6;
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

/**
 * Search everything said in every conversation, including what summaries have replaced. Messages still in the current
 * context are left out, since the model can already see them.
 */
export function recallExtension(harness: { current?: Harness }, timeZone: string) {
	async function archive(currentId: string, context: Context) {
		const h = harness.current;
		if (h === undefined) throw new Error("pclaw is still starting up.");
		const visible = new Set(
			((await (await h.conversation(currentId as never, context))?.context(context))?.entries ?? []).map((entry) => String(entry.id)),
		);
		const seen = new Set<string>();
		const messages: { who: "them" | "pclaw"; text: string; at: number }[] = [];
		for (const id of Object.values((await h.snapshot(Routes, context))?.conversations ?? {})) {
			const conversation = await h.conversation(id, context);
			let cursor: Cursor | undefined;
			let scanned = 0;
			do {
				const page = await conversation!.entries({}, 200, cursor, context);
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
		return messages;
	}

	return defineExtension({
		name: "pclaw.recall",
		tools: [
			defineTool({
				name: "recall",
				description:
					"Search everything said in past conversations, including messages that are no longer in view. Use it when " +
					"they refer to something from before what you can see (\"what was that case you found\", \"like we talked " +
					"about last month\"), or when your notes mention something and you need the details. Search with a few " +
					"distinctive words, not a sentence.",
				parameters: Type.Object({ query: Type.String({ description: "A few distinctive words, e.g. \"walnut NAS case\"." }) }),
				replay: "safe",
				execute: async ({ query }, api, context) => {
					const hits = search(await archive(String(api.conversationId), context), query);
					const text =
						hits.length === 0
							? "Nothing found. Try different words, or ask them."
							: hits.map((hit) => `[${stamp(hit.at, timeZone)}] ${hit.who}: ${hit.text}`).join("\n\n");
					return { content: [{ type: "text" as const, text }] };
				},
			}),
		],
	});
}
