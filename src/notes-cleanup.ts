import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { AssistantEntry, type EntryRecord } from "@earendil-works/pi-durable";
import type { Agent } from "./agent.ts";
import { type Config, ensureHome, writePrivate } from "./config.ts";
import { conversationText, NotesUpdate } from "./extensions/memory.ts";
import type { Notes } from "./extensions/notes.ts";
import { readPrompt } from "./prompts.ts";

/**
 * The nightly notes cleanup. The notes only grow during the day: the memory pass and `remember` add lines, and nothing
 * steps back to tidy them. Once a night this checks what was saved that day against what was actually said, merges
 * notes that say the same thing or are versions of one status, and retires what's no longer true or useful. Retired and
 * replaced lines go to an archive file, not away. In the memory lab this was the change that helped: no cost to
 * recalling plain facts, and more current answers about facts that had changed.
 */

/** Local hour the cleanup runs at, or soon after if pclaw was down. */
const RUN_HOUR = 4;
const CHECK_MS = 10 * 60_000;
const RETRY_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const TRANSCRIPT_LIMIT = 60_000;
/** A night that would drop more than this share of the notes (or 5, whichever is more) is skipped as suspect. */
const MAX_DROPPED_SHARE = 0.25;

export type CleanupReply = {
	merge: { ids: string[]; text: string }[];
	update: { id: string; text: string }[];
	retire: { id: string; why: string }[];
};
export type CleanupResult = { changes: string[]; skipped?: string };
/** What was said since the last cleanup, and the notes pclaw saved in that time. */
export type Day = { conversation: string; saved: Set<string> };

const bare = (line: string) => line.replace(/^-\s*/, "").replace(/\s*\n\s*/g, " ").trim();
const noteLines = (file: string) => file.split("\n").map(bare).filter((line) => line !== "");

/** The model's input: the notes numbered oldest first, the ones saved since the last cleanup marked new, and the day. */
export function cleanupInput(file: string, day: Day, today: string): { input: string; lines: string[] } {
	const lines = noteLines(file);
	const listing = lines.map((line, index) => `[n${index + 1}]${day.saved.has(line) ? " (new)" : ""} ${line}`).join("\n");
	return { input: `Today is ${today}.\n\nNotes:\n\n${listing}\n\nConversation since the last cleanup:\n\n${day.conversation || "(nothing)"}`, lines };
}

/** Pull the reply's JSON out, tolerating a code fence or stray text, and drop anything malformed. */
export function parseCleanup(reply: string): CleanupReply {
	const match = /\{[\s\S]*\}/.exec(reply);
	if (match === null) throw new Error(`notes cleanup: no JSON in reply: ${reply.slice(0, 200)}`);
	const value = JSON.parse(match[0]) as Record<string, unknown>;
	const list = (key: string) => (Array.isArray(value[key]) ? (value[key] as unknown[]) : []).filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
	const text = (item: unknown) => (typeof item === "string" ? item.trim() : "");
	return {
		merge: list("merge").flatMap((item) => (Array.isArray(item.ids) && text(item.text) !== "" ? [{ ids: item.ids.map(text), text: text(item.text) }] : [])),
		update: list("update").flatMap((item) => (text(item.id) !== "" && text(item.text) !== "" ? [{ id: text(item.id), text: text(item.text) }] : [])),
		retire: list("retire").flatMap((item) => (text(item.id) !== "" ? [{ id: text(item.id), why: text(item.why) }] : [])),
	};
}

/**
 * Apply a reply to the notes file, each change in place so the file keeps its order. A note the person edited or
 * removed since the input was built is left alone, as is any note a change already touched. Old lines go to `archive`.
 */
export function applyCleanup(notes: Notes, lines: string[], reply: CleanupReply, today: string, archive: string): CleanupResult {
	const byId = (id: string) => lines[Number(/^n(\d+)$/.exec(id)?.[1] ?? 0) - 1];
	const touched = new Set<string>();
	const free = (line: string | undefined): line is string => line !== undefined && !touched.has(line);
	const merges = reply.merge.map((each) => ({ ...each, parts: [...new Set(each.ids.map(byId))].filter(free) })).filter((each) => each.parts.length >= 2);
	const dropped = reply.retire.length + merges.reduce((sum, each) => sum + each.parts.length - 1, 0);
	const limit = Math.max(5, Math.ceil(lines.length * MAX_DROPPED_SHARE));
	if (dropped > limit) return { changes: [], skipped: `would drop ${dropped} of ${lines.length} notes (limit ${limit})` };

	const changes: string[] = [];
	const archived: string[] = [];
	for (const { parts, text } of merges) {
		if (!parts.every(free) || !notes.replace(parts[0]!, text)) continue;
		for (const part of parts.slice(1)) notes.replace(part, undefined);
		for (const part of parts) touched.add(part);
		changes.push(`merged ${parts.length} notes → ${text}`);
		archived.push(...parts.map((part) => `- ${today} merged into "${bare(text)}": ${part}`));
	}
	for (const { id, text } of reply.update) {
		const line = byId(id);
		if (!free(line) || !notes.replace(line, text)) continue;
		touched.add(line);
		changes.push(`fixed: ${line} → ${text}`);
		archived.push(`- ${today} replaced by "${bare(text)}": ${line}`);
	}
	for (const { id, why } of reply.retire) {
		const line = byId(id);
		if (!free(line) || !notes.replace(line, undefined)) continue;
		touched.add(line);
		changes.push(`retired (${why || "no reason given"}): ${line}`);
		archived.push(`- ${today} retired${why === "" ? "" : ` (${why})`}: ${line}`);
	}
	if (archived.length > 0) {
		ensureHome();
		if (!existsSync(archive)) writePrivate(archive, "# Retired notes\n\nWhat the nightly cleanup took out of the notes, newest last. pclaw doesn't see this file.\n\n");
		appendFileSync(archive, `${archived.join("\n")}\n`);
	}
	return { changes };
}

const timestampOf = (entry: EntryRecord): number | undefined => {
	const message = entry.model?.[0] as (Message & { timestamp?: number }) | undefined;
	if (typeof message?.timestamp === "number") return message.timestamp;
	const at = NotesUpdate.is(entry) ? (entry.data as { at?: unknown }).at : undefined;
	return typeof at === "number" ? at : undefined;
};

/** Every conversation since `since`: what was said, and the notes saved by `remember` or the memory pass. */
export async function daySince(agent: Agent, since: number, context: Context): Promise<Day> {
	const parts: string[] = [];
	const saved = new Set<string>();
	for (const [address, id] of Object.entries(await agent.addresses(context))) {
		const conversation = await agent.harness.conversation(id, context);
		if (conversation === undefined) continue;
		const recent: EntryRecord[] = [];
		let cursor: Parameters<typeof conversation.entries>[2];
		do {
			const page = await conversation.entries({}, 200, cursor, context);
			// A fork's history includes its parent's; those entries are read with the parent.
			const own = page.items.filter((entry) => entry.conversationId === id);
			recent.push(...own.filter((entry) => (timestampOf(entry) ?? since) >= since));
			cursor = page.items.some((entry) => (timestampOf(entry) ?? since) < since) ? undefined : page.next;
		} while (cursor !== undefined);
		recent.reverse();
		for (const entry of recent) {
			if (NotesUpdate.is(entry)) for (const note of (entry.data as { added?: string[] }).added ?? []) saved.add(bare(note));
			if (AssistantEntry.is(entry)) {
				for (const part of (entry.model?.[0] as { content?: unknown } | undefined)?.content as { type?: string; name?: string; arguments?: { note?: unknown } }[] | undefined ?? []) {
					if (part.type === "toolCall" && part.name === "remember" && typeof part.arguments?.note === "string") saved.add(bare(part.arguments.note));
				}
			}
		}
		const { lines } = conversationText(recent);
		if (lines.length > 0) parts.push(`## ${address}\n\n${lines.join("\n\n")}`);
	}
	let conversation = parts.join("\n\n");
	if (conversation.length > TRANSCRIPT_LIMIT) conversation = `[...]\n${conversation.slice(-TRANSCRIPT_LIMIT)}`;
	return { conversation, saved };
}

/** One cleanup of the notes file. */
export async function cleanupNotes(
	options: { models: Models; config: Pick<Config, "provider" | "model">; notes: Notes; archive: string },
	day: Day,
	today: string,
	signal?: AbortSignal,
): Promise<CleanupResult> {
	const { models, config, notes } = options;
	const { input, lines } = cleanupInput(notes.read(), day, today);
	if (lines.length === 0) return { changes: [] };
	const model = models.getModel(config.provider, config.model);
	if (model === undefined) throw new Error(`notes cleanup: unknown model ${config.provider}/${config.model}`);
	const reply = await models.completeSimple(
		model,
		{ systemPrompt: readPrompt("cleanup"), messages: [{ role: "user", content: input, timestamp: Date.now() }] },
		{ reasoning: "medium", ...(signal === undefined ? {} : { signal }) },
	);
	if (reply.stopReason === "error") throw new Error(`notes cleanup: ${reply.errorMessage ?? "model error"}`);
	const text = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
	return applyCleanup(notes, lines, parseCleanup(text), today, options.archive);
}

/** Runs the cleanup once a night, at `RUN_HOUR` local time or the first check after it. */
export function startNotesCleanup(
	agent: Agent,
	options: { models: Models; config: Config; notes: Notes; archive: string; stateFile: string },
	context: Context,
): { stop(): void } {
	const local = (at: number, part: "day" | "hour") =>
		new Intl.DateTimeFormat("en-CA", part === "day" ? { timeZone: options.config.timeZone, year: "numeric", month: "2-digit", day: "2-digit" } : { timeZone: options.config.timeZone, hour: "2-digit", hourCycle: "h23" }).format(at);
	const lastRun = (): number | undefined => {
		try {
			const value = (JSON.parse(readFileSync(options.stateFile, "utf8")) as { lastRun?: unknown }).lastRun;
			return typeof value === "number" ? value : undefined;
		} catch {
			return undefined;
		}
	};
	let attempted = 0;
	let running = false;
	const check = async () => {
		const now = Date.now();
		const last = lastRun();
		if (running || Number(local(now, "hour")) < RUN_HOUR || (last !== undefined && local(last, "day") === local(now, "day")) || now - attempted < RETRY_MS) return;
		running = true;
		attempted = now;
		try {
			const day = await daySince(agent, last ?? now - DAY_MS, context);
			const result = await cleanupNotes(options, day, local(now, "day"), AbortSignal.timeout(5 * 60_000));
			writePrivate(options.stateFile, JSON.stringify({ lastRun: now }));
			if (result.skipped !== undefined) console.error(`[pclaw] notes cleanup skipped: ${result.skipped}`);
			else console.log(`[pclaw] notes cleanup: ${result.changes.length === 0 ? "nothing to change" : `\n  ${result.changes.join("\n  ")}`}`);
		} finally {
			running = false;
		}
	};
	const timer = setInterval(() => void check().catch((error: unknown) => console.error("[pclaw] notes cleanup failed", error)), CHECK_MS);
	return { stop: () => clearInterval(timer) };
}
