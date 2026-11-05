/**
 * The prose lab's moving parts, shared by the command line (lab.ts) and the web page (server.ts): scenarios replayed
 * from real conversations, system prompts assembled the way pclaw does, replies with pclaw's tools stubbed out, and a
 * second model judging how each reply reads.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Api, AssistantMessage, Context, Message, Model, ModelThinkingLevel, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { home, loadConfig, paths } from "../config.ts";
import { FileCredentialStore } from "../credentials.ts";
import { readAssistantReply, replyCollector } from "../delivery.ts";
import { followUpsExtension } from "../extensions/follow-ups.ts";
import { Notes, notesExtension } from "../extensions/notes.ts";
import { quickSearchExtension } from "../extensions/quick-search.ts";
import { reactionsExtension } from "../extensions/reactions.ts";
import { recallExtension } from "../extensions/recall.ts";
import { workerOptions, workersExtension } from "../extensions/workers.ts";
import { formattingDir, frontPrompt } from "../prompts.ts";
import { stamp } from "../time.ts";
import { discordChecks, words } from "./checks.ts";
import type { Judgment, Result, Score } from "./types.ts";

export const LAB = join(home, "prose-lab");
const SCENARIOS = join(LAB, "scenarios");
const VARIANTS = join(LAB, "variants");

export type Scenario = {
	name: string;
	/** What the person last asked, for the judge. */
	ask: string;
	/** The conversation up to and including the message being answered. */
	messages: Message[];
	/** quick_search results from the real run, handed back in order. */
	searches: string[];
	/** What pclaw actually sent. */
	live?: string;
};

export type { Judgment, Result, Score };

export const config = loadConfig();
const models = createModels({ credentials: new FileCredentialStore(config.authFile) });
models.setProvider(metaProvider());
models.setProvider(xaiProvider());

// ---- Scenarios ----

export function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const isPerson = (message: Message) =>
	message.role === "user" && !/^<(worker-report|follow-up)/m.test(textOf(message)) && !textOf(message).includes("[reacted ");

/** Turns in the main conversation (the one with the most entries), each the message at an entry id and what led up to it. */
export function extract(ids: number[]): { saved: Scenario[]; missing: number[] } {
	const db = new DatabaseSync(paths.db, { readOnly: true });
	const [main] = db.prepare("select conversation_id as id from entries group by 1 order by count(*) desc limit 1").all() as { id: number }[];
	const rows = db.prepare("select id, record from entries where conversation_id = ? order by id").all(main!.id) as { id: number; record: string }[];
	const flat: { entry: number; message: Message }[] = [];
	for (const row of rows) {
		const record = JSON.parse(row.record) as { model?: Message[] };
		// System entries are prompt updates from that time; the variant under test supplies its own.
		for (const message of record.model ?? []) if (message.role !== "system") flat.push({ entry: row.id, message: clean(message) });
	}
	mkdirSync(SCENARIOS, { recursive: true });
	const saved: Scenario[] = [];
	const missing: number[] = [];
	for (const id of ids) {
		const at = flat.findIndex((item) => item.entry === id && item.message.role === "user");
		if (at === -1) {
			missing.push(id);
			continue;
		}
		// The three messages before this one from either side of the conversation, then this one.
		let start = at;
		for (let users = 0; start > 0 && users < 3; ) if (flat[--start]!.message.role === "user") users++;
		const messages = flat.slice(start, at + 1).map((item) => item.message);
		const trigger = textOf(flat[at]!.message);
		const ask = textOf([...messages].reverse().find(isPerson) ?? flat[at]!.message);
		const after: Message[] = [];
		for (const item of flat.slice(at + 1)) {
			if (item.message.role === "user") break;
			after.push(item.message);
		}
		const searches = after.flatMap((message) => (message.role === "toolResult" && message.toolName === "quick_search" ? [textOf(message)] : []));
		const live = delivered(after.filter((message): message is AssistantMessage => message.role === "assistant"));
		const label = /worker="([^"]+)"/.exec(trigger)?.[1] ?? trigger.replace(/^\[[^\]]*\]\s*/, "").toLowerCase().split(/\W+/).filter(Boolean).slice(0, 4).join("-");
		const scenario: Scenario = { name: `${id}-${label}`, ask, messages, searches, ...(live === undefined ? {} : { live }) };
		writeFileSync(join(SCENARIOS, `${scenario.name}.json`), JSON.stringify(scenario, null, "\t"));
		saved.push(scenario);
	}
	return { saved, missing };
}

export function scenarios(): Scenario[] {
	if (!existsSync(SCENARIOS)) return [];
	return readdirSync(SCENARIOS)
		.filter((file) => file.endsWith(".json"))
		.map((file) => JSON.parse(readFileSync(join(SCENARIOS, file), "utf8")) as Scenario)
		.sort((a, b) => parseInt(a.name) - parseInt(b.name));
}

/** A one-off scenario from a message typed in: no history, stamped the way a Discord message is. */
export function adHoc(text: string, index: number): Scenario {
	const label = text.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 4).join("-");
	return {
		name: `typed-${index + 1}-${label}`,
		ask: text,
		messages: [{ role: "user", content: `[${stamp(Date.now(), config.timeZone)}]\n${text}`, timestamp: Date.now() }],
		searches: [],
	};
}

/** Without reasoning traces (they're signed for one request) or images. */
function clean(message: Message): Message {
	if (message.role === "assistant") return { ...message, content: message.content.filter((part) => part.type !== "thinking") };
	if (message.role === "user" && typeof message.content !== "string") return { ...message, content: message.content.filter((part) => part.type === "text") };
	return message;
}

/** Use the same reply selection as Discord delivery. */
function delivered(replies: AssistantMessage[]): string | undefined {
	const collector = replyCollector();
	const sent: string[] = [];
	for (const message of replies) {
		const reply = readAssistantReply(message);
		const text = reply === undefined ? undefined : collector.take(reply);
		if (text !== undefined) sent.push(text);
	}
	const held = collector.flush();
	if (held !== undefined) sent.push(held);
	return sent.length === 0 ? undefined : sent.join("\n\n");
}

/**
 * pclaw's earlier replies with the markdown taken out. The model copies the style of its own recent messages, so this
 * shows how a prompt does once the conversation has turned over, rather than against a history in the old style.
 */
export function plainEarlier(message: Message): Message {
	if (message.role !== "assistant") return message;
	return { ...message, content: message.content.map((part) => (part.type === "text" ? { ...part, text: withoutMarkdown(part.text) } : part)) };
}

/** Worker reports as if workers wrote them without markdown, to see how much of the reply's shape is copied from them. */
export function plainReport(message: Message): Message {
	if (message.role !== "user" || !textOf(message).startsWith("<worker-report")) return message;
	return { ...message, content: withoutMarkdown(textOf(message)) };
}

function withoutMarkdown(text: string): string {
	return text
		.replace(/\*\*([^*\n]+)\*\*/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^\s*(-{3,}|\*{3,})\s*$/gm, "")
		.replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
		.replace(/^\|\s*(.*?)\s*\|\s*$/gm, (_, row: string) => row.split(/\s*\|\s*/).join(", "));
}

// ---- Prompts ----

/** front.md plus the app's rules, put together in the order pclaw renders its sections: front, time zone, notes, rules. */
export function assemble(front: string, rules: string | undefined): string {
	const tag = (name: string, body: string) => `<${name}>\n${body.trim()}\n</${name}>`;
	return [
		front.trim(),
		tag("time-zone", `They live in the ${config.timeZone} time zone unless they say otherwise.`),
		tag("notes", new Notes(paths.notes).read().trim() || "(nothing yet)"),
		...(rules === undefined ? [] : [tag("formatting", rules)]),
	].join("\n\n");
}

/** What pclaw sends today on `platform`. */
export function livePrompt(platform: string): string {
	const rules = join(formattingDir, `${platform}.md`);
	return assemble(frontPrompt(), existsSync(rules) ? readFileSync(rules, "utf8") : undefined);
}

/** A variant folder's prompt; `live` is pclaw's own and `none` is no system prompt at all. */
export function variantPrompt(variant: string, platform: string): string | undefined {
	if (variant === "none") return undefined;
	if (variant === "live") return livePrompt(platform);
	const dir = join(VARIANTS, variant);
	if (!existsSync(join(dir, "front.md"))) throw new Error(`No variant ${variant}: make ${dir}/front.md`);
	const rules = join(dir, `${platform}.md`);
	return assemble(readFileSync(join(dir, "front.md"), "utf8"), existsSync(rules) ? readFileSync(rules, "utf8") : undefined);
}

// ---- Replies ----

/** pclaw's real tool definitions, so the model sees the same choices it has in production. */
const tools: Tool[] = (() => {
	const none = {};
	const extensions = [
		notesExtension(new Notes(paths.notes)),
		followUpsExtension(config.timeZone),
		workersExtension(workerOptions(config, paths), none),
		recallExtension(none, config.timeZone),
		reactionsExtension(none),
		quickSearchExtension(),
	];
	return extensions.flatMap((extension) => (extension.tools ?? []).map(({ name, description, parameters }) => ({ name, description, parameters })));
})();

/** Canned tool results, so a run can call tools without doing anything. A delegate ends the run, as in pclaw. */
function stub(call: ToolCall, scenario: Scenario, searchesUsed: { count: number }): { text: string; ends: boolean } {
	const args = call.arguments as Record<string, unknown>;
	switch (call.name) {
		case "delegate":
			return { text: `${String(args.name ?? "worker")} is on it.`, ends: true };
		case "message_worker":
			return { text: "Sent.", ends: true };
		case "quick_search":
			return { text: scenario.searches[searchesUsed.count++] ?? `No results for "${String(args.query)}".`, ends: false };
		case "react":
			return { text: `Reacted ${String(args.emoji ?? "")}.`, ends: false };
		case "remember":
			return { text: "Saved.", ends: false };
		case "recall":
			return { text: "Nothing else found.", ends: false };
		default:
			return { text: "Done.", ends: false };
	}
}

async function answer(model: Model<Api>, system: string | undefined, scenario: Scenario, used: string[], thinking: ModelThinkingLevel) {
	const messages = [...scenario.messages];
	const replies: AssistantMessage[] = [];
	const searchesUsed = { count: 0 };
	for (let round = 0; round < 5; round++) {
		const reply = await complete(model, { ...(system === undefined ? {} : { systemPrompt: system }), messages, tools }, thinking);
		replies.push(reply);
		messages.push(reply);
		const calls = reply.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (calls.length === 0) break;
		let ends = false;
		for (const call of calls) {
			used.push(call.name === "react" ? `react ${String((call.arguments as { emoji?: unknown }).emoji)}` : call.name);
			const result = stub(call, scenario, searchesUsed);
			ends ||= result.ends;
			const message: ToolResultMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: result.text }], isError: false, timestamp: Date.now() };
			messages.push(message);
		}
		if (ends) break;
	}
	return delivered(replies);
}

/** xAI turns requests away when it's busy; wait and try again rather than lose the sample. */
async function complete(model: Model<Api>, request: Context, reasoning: ModelThinkingLevel): Promise<AssistantMessage> {
	for (let attempt = 1; ; attempt++) {
		const reply = await models.completeSimple(model, request, reasoning === "off" ? {} : { reasoning });
		if (reply.stopReason !== "error") return reply;
		if (attempt === 5 || !/capacity|rate limit|429|503|overloaded|terminated|connection/i.test(reply.errorMessage ?? "")) throw new Error(reply.errorMessage ?? "model error");
		await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
	}
}

export type RunOptions = {
	/** Variant name to system prompt; undefined sends none. */
	prompts: Record<string, string | undefined>;
	scenarios: Scenario[];
	runs: number;
	platform: string;
	judging: boolean;
	thinking: ModelThinkingLevel;
	/** Called as each reply finishes, in whatever order they finish. */
	onResult?: (result: Result) => void;
	/** Checked before each reply starts; true skips the rest. */
	stopped?: () => boolean;
};

/** Every variant answers every scenario `runs` times, a dozen at a time. */
export async function replyAll(options: RunOptions): Promise<Result[]> {
	const front = models.getModel(config.provider, config.model);
	if (front === undefined) throw new Error(`Unknown model ${config.provider}/${config.model}`);
	const jobs = Object.keys(options.prompts).flatMap((variant) =>
		options.scenarios.flatMap((scenario) => Array.from({ length: options.runs }, (_, run) => ({ variant, scenario, run }))),
	);
	const results = await pool(jobs, 12, async ({ variant, scenario, run }): Promise<Result | undefined> => {
		if (options.stopped?.()) return undefined;
		const started = performance.now();
		const result: Result = { variant, scenario: scenario.name, run, tools: [], checks: [], ms: 0 };
		try {
			const reply = await answer(front, options.prompts[variant], scenario, result.tools, options.thinking);
			if (reply !== undefined) result.reply = reply;
			if (reply !== undefined && options.platform === "discord") result.checks = discordChecks(reply);
			if (options.judging && reply !== undefined) result.judge = await judge(scenario, reply, options.platform, result.tools.includes("quick_search"));
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
		}
		result.ms = performance.now() - started;
		options.onResult?.(result);
		return result;
	});
	return results.filter((result): result is Result => result !== undefined);
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await work(items[index]!);
			}
		}),
	);
	return results;
}

// ---- Judging ----

const JUDGE = `You judge replies a personal assistant sent its owner in a chat app. The owner wants it to sound like a sharp, \
well-informed friend texting: the same personality everywhere, adapted to the app. Read what the owner asked, what the assistant \
had to work with, and the reply, then score 1 to 5:

- natural: reads like a person texting, not a report, memo, or slide deck. Penalize headings, bold-label sections, a "short \
version" followed by the long version, stacked summaries, filler, announcing structure, and service-desk tone.
- economy: no word vomit. Every sentence earns its place and the length fits the moment. A detailed question can get a longer \
answer, but it should still be the decision and the few facts that carry it, with the rest offered. Penalize restating, \
hedging piles, and dumping everything a source said.
- substance: answers what was actually asked, keeps the decisive facts, numbers, and catches, and doesn't drop something the \
owner would be annoyed to miss or invent anything not in the material.

Platform: {platform}. On Discord, tables, headings and --- show up broken, a message over 2000 characters splits in two, \
and heavy bold reads as shouting. Count those against natural.

Reply with only JSON: {"natural": n, "economy": n, "substance": n, "note": "one sentence on the biggest problem, or what works"}`;

async function judge(scenario: Scenario, reply: string, platform: string, searched: boolean): Promise<Judgment> {
	// The worker model judges when pi can run it; Muse Code workers run outside pi-ai, so then the front model does.
	const model = models.getModel(config.workerProvider, config.workerModel) ?? models.getModel(config.provider, config.model);
	if (model === undefined) throw new Error(`Unknown judge model ${config.workerModel}`);
	const material = textOf(scenario.messages.at(-1)!);
	const searches = searched && scenario.searches.length > 0 ? `\n\nWhat its web searches returned:\n${scenario.searches.join("\n\n").slice(0, 8_000)}` : "";
	const input = `The owner asked:\n${scenario.ask}\n\nThe message the assistant was answering:\n${material.slice(0, 14_000)}${searches}\n\nThe assistant's reply:\n${reply}`;
	const verdict = await complete(model, { systemPrompt: JUDGE.replace("{platform}", platform), messages: [{ role: "user", content: input, timestamp: Date.now() }] }, "medium");
	const json = /\{[\s\S]*\}/.exec(textOf(verdict))?.[0];
	if (json === undefined) throw new Error(`judge: no JSON in ${textOf(verdict).slice(0, 200)}`);
	return JSON.parse(json) as Judgment;
}

// ---- Scoring ----

export function score(variants: string[], results: Result[]): Score[] {
	const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
	return variants.map((variant) => {
		const mine = results.filter((result) => result.variant === variant);
		const replied = mine.filter((result) => result.reply !== undefined);
		const judged = mine.flatMap((result) => (result.judge === undefined ? [] : [result.judge]));
		const mean = (pick: (judgment: Judgment) => number) => (judged.length === 0 ? undefined : judged.reduce((sum, each) => sum + pick(each), 0) / judged.length);
		const failed: Record<string, number> = {};
		for (const result of replied) for (const check of result.checks) failed[check.rule] = (failed[check.rule] ?? 0) + 1;
		const natural = mean((each) => each.natural);
		const economy = mean((each) => each.economy);
		const substance = mean((each) => each.substance);
		return {
			variant,
			clean: replied.filter((result) => result.checks.length === 0).length,
			replied: replied.length,
			errors: mine.filter((result) => result.error !== undefined).length,
			medianChars: median(replied.map((result) => result.reply!.length)),
			medianWords: median(replied.map((result) => words(result.reply!))),
			...(natural === undefined ? {} : { natural }),
			...(economy === undefined ? {} : { economy }),
			...(substance === undefined ? {} : { substance }),
			failed,
		};
	});
}
