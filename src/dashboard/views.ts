import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type EntryRecord, type LiveState, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { SILENT } from "../delivery.ts";
import { NotesUpdate } from "../extensions/memory.ts";
import type { LiveStatus, TimelineItem, Usage, WorkerItem } from "./types.ts";

const WORKER_TOOLS = new Set(["delegate", "message_worker", "stop_worker"]);
const STAMP = /^\[[^\]\n]*\]\n?/;
const REPORT = /^<worker-report worker="([^"]*)" status="(done|failed)">\n?([\s\S]*?)\n?<\/worker-report>(?:\n\([^\n]*\))?$/;
const FOLLOW_UP = /^<follow-up>([\s\S]*)<\/follow-up>$/;
const REACTED = /^\[reacted (\S+) to your message from [^:]*: "([\s\S]*)"\]$/;

const textOf = (content: UserMessage["content"] | ToolResultMessage["content"]): string =>
	typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

function userItem(entry: EntryRecord, message: UserMessage): TimelineItem {
	const at = message.timestamp;
	const body = textOf(message.content).replace(STAMP, "").trim();
	const report = REPORT.exec(body);
	if (report !== null) {
		return { kind: "event", id: String(entry.id), at, event: "worker-report", worker: report[1]!, ok: report[2] === "done", text: report[3]!.trim() };
	}
	const reacted = REACTED.exec(body);
	if (reacted !== null) return { kind: "event", id: String(entry.id), at, event: "reaction", emoji: reacted[1]!, text: reacted[2]! };
	const followUp = FOLLOW_UP.exec(body);
	if (followUp !== null) return { kind: "event", id: String(entry.id), at, event: "follow-up", text: followUp[1]!.trim() };
	const images = typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length;
	return { kind: "message", id: String(entry.id), at, text: body, images };
}

/**
 * The transcript as the dashboard shows it: the person's messages, internal events, every reply with whether it was
 * delivered, and each tool call joined to its result. Delivery follows `replyCollector` in delivery.ts: within a run,
 * the final reply wins and earlier text is superseded, unless the final reply is empty.
 */
export function buildTimeline(entries: readonly EntryRecord[], idle = true, reactions: Record<string, string> = {}): TimelineItem[] {
	const items: TimelineItem[] = [];
	const tools = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
	let interim: Extract<TimelineItem, { kind: "reply" }>[] = [];

	for (const entry of entries) {
		if (NotesUpdate.is(entry)) {
			const { added, removed, at } = entry.data as { added: string[]; removed: string[]; at: number };
			const text = [...added.map((note) => `+ ${note}`), ...removed.map((note) => `- ${note}`)].join("\n");
			items.push({ kind: "event", id: String(entry.id), at, event: "notes", text });
			continue;
		}
		const message = entry.model?.[0] as Message | undefined;
		if (message === undefined) continue;

		if (UserEntry.is(entry) && message.role === "user") {
			// The previous run ended without an answer (delegate ends it): what it said along the way went out.
			for (const held of interim) held.delivered = true;
			interim = [];
			const item = userItem(entry, message);
			const reaction = reactions[String(entry.id)];
			if (item.kind === "message" && reaction) item.reaction = reaction;
			items.push(item);
		} else if (ToolResultEntry.is(entry) && message.role === "toolResult") {
			const tool = tools.get(message.toolCallId);
			if (tool !== undefined) {
				tool.result = textOf(message.content);
				if (message.isError) tool.isError = true;
			}
		} else if (AssistantEntry.is(entry) && message.role === "assistant") {
			const assistant = message as AssistantMessage;
			if (assistant.stopReason === "aborted") continue;
			const text = assistant.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("")
				.trim();
			const reply: Extract<TimelineItem, { kind: "reply" }> = {
				kind: "reply",
				id: String(entry.id),
				at: assistant.timestamp,
				text,
				delivered: false,
				model: assistant.model,
				usage: { input: assistant.usage.input, output: assistant.usage.output, cacheRead: assistant.usage.cacheRead },
			};
			if (assistant.stopReason === "error") {
				reply.error = assistant.errorMessage ?? "unknown error";
				reply.delivered = true;
				for (const held of interim) held.held = "superseded";
				interim = [];
				items.push(reply);
			} else if (assistant.stopReason === "toolUse") {
				if (text !== "") {
					interim.push(reply);
					items.push(reply);
				}
			} else if (text.startsWith(SILENT)) {
				reply.held = "silent";
				for (const held of interim) held.held = "silent";
				interim = [];
				items.push(reply);
			} else if (text !== "") {
				reply.delivered = true;
				for (const held of interim) held.held = "superseded";
				interim = [];
				items.push(reply);
			} else {
				// An empty answer: what was said along the way went out instead.
				for (const held of interim) held.delivered = true;
				interim = [];
			}
			for (const part of assistant.content) {
				if (part.type !== "toolCall") continue;
				const tool: Extract<TimelineItem, { kind: "tool" }> = {
					kind: "tool",
					id: part.id,
					at: assistant.timestamp,
					name: part.name,
					args: part.arguments,
				};
				const worker = part.arguments.name;
				if (WORKER_TOOLS.has(part.name) && typeof worker === "string") tool.worker = worker;
				tools.set(part.id, tool);
				items.push(tool);
			}
		}
	}
	if (idle) for (const held of interim) held.delivered = true;
	return items;
}

export function liveStatus(live: Readonly<LiveState> | undefined): LiveStatus {
	if (live?.run === undefined) return { state: "idle" };
	const running = (live.tools ?? []).filter((tool) => tool.status !== "done").map((tool) => tool.name);
	if (live.generation === undefined && running.length > 0) return { state: "tools", tools: running };
	const partial = live.generation?.message as AssistantMessage | undefined;
	const text = partial?.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("")
		.trim();
	return {
		state: "generating",
		...(partial?.timestamp === undefined ? {} : { since: partial.timestamp }),
		...(text ? { text } : {}),
	};
}

type UsageLike = { input: number; output: number; cacheRead: number; cost: { total: number } };

export function sumUsage(state: { models?: Record<string, UsageLike> } | undefined): Usage {
	const total: Usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const usage of Object.values(state?.models ?? {})) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cost += usage.cost.total;
	}
	return total;
}

const FROM_PCLAW = /^Message from pclaw:\s*/;

/** A pi session file (JSONL) as the worker's transcript. Tolerates a half-written last line. */
export function parseWorkerSession(jsonl: string): WorkerItem[] {
	const items: WorkerItem[] = [];
	const tools = new Map<string, Extract<WorkerItem, { kind: "tool" }>>();
	for (const line of jsonl.split("\n")) {
		if (line.trim() === "") continue;
		let record: { type?: string; timestamp?: string; message?: Message };
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const message = record.message;
		if (record.type !== "message" || message === undefined) continue;
		const at = record.timestamp === undefined ? 0 : Date.parse(record.timestamp);
		if (message.role === "user") {
			items.push({ kind: "from-pclaw", at, text: textOf(message.content).replace(FROM_PCLAW, "") });
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "thinking" && part.thinking.trim() !== "") items.push({ kind: "thinking", at, text: part.thinking.trim() });
				else if (part.type === "text" && part.text.trim() !== "") items.push({ kind: "text", at, text: part.text.trim() });
				else if (part.type === "toolCall") {
					const tool: Extract<WorkerItem, { kind: "tool" }> = { kind: "tool", at, name: part.name, args: part.arguments };
					tools.set(part.id, tool);
					items.push(tool);
				}
			}
		} else if (message.role === "toolResult") {
			const tool = tools.get(message.toolCallId);
			if (tool !== undefined) {
				tool.result = textOf(message.content);
				if (message.isError) tool.isError = true;
			}
		}
	}
	return items;
}

/** read_page calls in one worker session file, and the ones that failed. */
export function pageReadsIn(jsonl: string): { total: number; failures: { host: string; at: number; error: string }[] } {
	const urls = new Map<string, string>();
	const failures: { host: string; at: number; error: string }[] = [];
	let total = 0;
	for (const line of jsonl.split("\n")) {
		let record: { type?: string; timestamp?: string; message?: Message };
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const message = record.message;
		if (record.type !== "message" || message === undefined) continue;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall" && part.name === "read_page" && typeof part.arguments.url === "string") urls.set(part.id, part.arguments.url);
			}
		} else if (message.role === "toolResult" && message.toolName === "read_page") {
			total++;
			const url = urls.get(message.toolCallId);
			if (!message.isError || url === undefined) continue;
			let host = url;
			try {
				host = new URL(url).hostname.replace(/^www\./, "");
			} catch {}
			failures.push({ host, at: record.timestamp === undefined ? 0 : Date.parse(record.timestamp), error: textOf(message.content).slice(0, 200) });
		}
	}
	return { total, failures };
}
