import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { AssistantEntry, type EntryRecord, UserEntry } from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";
import { STRIP_GUIDANCE } from "./decisions.ts";
import { redactCoordinates, STRIP_LOCATION } from "./location.ts";
import { type PromptResolver, readPrompt } from "./prompts.ts";
import { type EpisodeRecord, STRIP_CROSS_CLIENT } from "./search-index.ts";
import { stamp } from "./time.ts";

const MESSAGE_LIMIT = 1_500;
const TRANSCRIPT_LIMIT = 40_000;
const DEFAULT_EPISODES_MAX_CHARS = 4_000;
const WORKER_REPORT_RE = /^<worker-report\s+worker="([^"]+)"\s+status="([^"]+)">\s*([\s\S]*?)\s*<\/worker-report>/;
const INTERNAL_SKIP_RE = /^<(follow-up|job-update|job-result)[\s>]/;

export type SessionTranscript = {
	lines: string[];
	humanTurns: number;
	startedAt?: number;
	endedAt?: number;
	firstEntryId?: number;
	lastEntryId?: number;
};

export type DistilledEpisode = {
	skip: boolean;
	title: string;
	summary: string;
};

const textOf = (message: Message): string =>
	typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** Extract human-facing turns and worker findings from an active session's entries. */
export function extractSessionTranscript(entries: readonly EntryRecord[]): SessionTranscript {
	const lines: string[] = [];
	let humanTurns = 0;
	let startedAt: number | undefined;
	let endedAt: number | undefined;
	let firstEntryId: number | undefined;
	let lastEntryId: number | undefined;

	const recordSpan = (entryId: number, ts: number | undefined) => {
		if (firstEntryId === undefined) firstEntryId = entryId;
		lastEntryId = entryId;
		if (typeof ts === "number") {
			startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
			endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
		}
	};

	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message === undefined) continue;
		const ts = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : undefined;
		let line: string | undefined;

		if (UserEntry.is(entry) && message.role === "user") {
			const cleaned = textOf(message).replace(STRIP_GUIDANCE, "").replace(STRIP_CROSS_CLIENT, "").replace(STRIP_LOCATION, "").trim();
			const workerMatch = WORKER_REPORT_RE.exec(cleaned);
			if (workerMatch !== null) {
				const name = workerMatch[1]!.trim();
				const status = workerMatch[2]!.trim();
				const body = workerMatch[3]!.trim();
				if (body !== "") {
					line = `[worker ${name} (${status})]: ${body}`;
					recordSpan(Number(entry.id), ts);
				}
			} else if (cleaned !== "" && !INTERNAL_SKIP_RE.test(cleaned)) {
				line = `them: ${cleaned}`;
				humanTurns++;
				recordSpan(Number(entry.id), ts);
			}
		} else if (AssistantEntry.is(entry) && message.role === "assistant") {
			const cleaned = textOf(message).trim();
			if ((message as AssistantMessage).stopReason !== "error" && cleaned !== "" && !cleaned.startsWith("NO_REPLY")) {
				line = `pclaw: ${cleaned}`;
				humanTurns++;
				recordSpan(Number(entry.id), ts);
			}
		}

		if (line !== undefined) {
			line = redactCoordinates(line);
			lines.push(line.length > MESSAGE_LIMIT ? `${line.slice(0, MESSAGE_LIMIT)} [...]` : line);
		}
	}

	while (lines.join("\n\n").length > TRANSCRIPT_LIMIT && lines.length > 1) {
		lines.shift();
	}

	return {
		lines,
		humanTurns,
		...(startedAt === undefined ? {} : { startedAt }),
		...(endedAt === undefined ? {} : { endedAt }),
		...(firstEntryId === undefined ? {} : { firstEntryId }),
		...(lastEntryId === undefined ? {} : { lastEntryId }),
	};
}

/** Parse `{ skip, title, summary }` JSON out of the model reply, tolerating code fences. */
export function parseEpisodeResponse(reply: string): DistilledEpisode {
	const match = /\{[\s\S]*\}/.exec(reply);
	if (match === null) throw new Error(`episode distill: no JSON in reply: ${reply.slice(0, 200)}`);
	const parsed = JSON.parse(match[0]) as { skip?: unknown; title?: unknown; summary?: unknown };
	const skip = parsed.skip === true;
	const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
	let summary = "";
	if (typeof parsed.summary === "string") {
		summary = parsed.summary.trim();
	} else if (Array.isArray(parsed.summary)) {
		summary = parsed.summary
			.filter((item): item is string => typeof item === "string" && item.trim() !== "")
			.map((item) => (item.trim().startsWith("-") ? item.trim() : `- ${item.trim()}`))
			.join("\n");
	}
	if (skip || title === "" || summary === "") {
		return { skip: true, title: "", summary: "" };
	}
	return { skip: false, title, summary };
}

/** Distill an ended session transcript into a terse episode summary using the front model at low reasoning. */
export async function distillEpisode(options: {
	models: Models;
	config: Pick<Config, "provider" | "model">;
	transcript: string;
	prompts?: PromptResolver;
	systemPrompt?: string;
	signal?: AbortSignal;
}): Promise<DistilledEpisode> {
	const model = options.models.getModel(options.config.provider, options.config.model);
	if (model === undefined) throw new Error(`episode distill: unknown model ${options.config.provider}/${options.config.model}`);
	const systemPrompt = options.systemPrompt ?? options.prompts?.read("episode") ?? readPrompt("episode");
	const reply = await options.models.completeSimple(
		model,
		{
			systemPrompt,
			messages: [{ role: "user", content: options.transcript, timestamp: Date.now() }],
		},
		{ reasoning: "low", ...(options.signal === undefined ? {} : { signal: options.signal }) },
	);
	if (reply.stopReason === "error") throw new Error(`episode distill: ${reply.errorMessage ?? "model error"}`);
	return parseEpisodeResponse(textOf(reply));
}

function formatEpisodeHeaderDate(at: number, timeZone: string): string {
	// Compact form of stamp(): "Mon 2026-11-23 09:41"
	const full = stamp(at, timeZone);
	const paren = full.indexOf(" (");
	return paren === -1 ? full : full.slice(0, paren);
}

/** Format recent episodes chronologically within `maxChars` (~4,000 chars / ~1,000 tokens). */
export function formatRecentEpisodes(
	episodes: readonly EpisodeRecord[],
	timeZone: string,
	maxChars = DEFAULT_EPISODES_MAX_CHARS,
): string {
	if (episodes.length === 0) return "None yet.";
	// Sort oldest-to-newest so they read as a natural timeline, keeping the most recent ones if over cap.
	const chronological = [...episodes].sort((a, b) => a.endedAt - b.endedAt || a.id - b.id);
	const blocks = chronological.map(
		(ep) => `[${formatEpisodeHeaderDate(ep.endedAt, timeZone)} · ${ep.channel}] ${ep.title}\n${ep.summary.trim()}`,
	);
	while (blocks.length > 1 && blocks.join("\n\n").length > maxChars) {
		blocks.shift();
	}
	const joined = blocks.join("\n\n");
	return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars - 1).trimEnd()}…`;
}
