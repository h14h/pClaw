#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs a model profile through pclaw's real harness, with its real prompts and tools, against evals/cases.json. Workers
 * and T3 are fakes, so nothing gets launched. Cases are synthetic on purpose: profiles can run on any provider, and this
 * keeps real conversations and notes away from them.
 *
 *   pnpm evals muse-spark-1.3                         every case, twice
 *   pnpm evals gpt-6.1-terra --runs 3 --only build,fix
 *   pnpm evals muse-spark-1.3 --holdout               the cases tuning never sees
 *
 * Results go to ~/.pclaw/evals/runs/<profile>/. See docs/tuning-profiles.md.
 */

type Expect = {
	toolsAll?: string[];
	toolsAny?: string[];
	toolsNone?: string[];
	reply?: "text" | "silent" | "any";
	match?: string[];
	avoid?: string[];
	maxChars?: number;
	judge?: boolean;
};
type Case = { id: string; message: string; raw?: boolean; tags: string[]; expect: Expect };
type Run = { id: string; run: number; ok: boolean; failures: string[]; tools: string[]; reply: string; ms: number; outputTokens: number; judge?: { score: number; why: string } };

const home = join(homedir(), ".pclaw");
const repo = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const name = args[0];
if (name === undefined || name.startsWith("--")) {
	console.error("usage: pnpm evals <profile> [--runs N] [--only a,b] [--holdout] [--no-judge]");
	process.exit(1);
}
const runs = Number(option("--runs") ?? 2);
const only = option("--only")?.split(",");
const holdout = args.includes("--holdout");
const judging = !args.includes("--no-judge");

// config.ts reads this on import, so it's set first: nothing here touches the live pclaw's data.
const scratch = mkdtempSync(join(tmpdir(), "pclaw-evals-"));
process.env.PCLAW_HOME = scratch;
process.env.PCLAW_PROFILE = name;

const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
const { createModels } = await import("@earendil-works/pi-ai/models");
const { metaProvider } = await import("@earendil-works/pi-ai/providers/meta");
const { AssistantEntry, LiveDoc } = await import("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { openAgent } = await import("./agent.ts");
const { loadConfig } = await import("./config.ts");
const { FileCredentialStore } = await import("./credentials.ts");
const { decisionClient } = await import("./decisions.ts");
const { JobStore } = await import("./extensions/jobs.ts");
const { Notes } = await import("./extensions/notes.ts");
const { listProfiles, loadProfile, registerProfiles } = await import("./profiles.ts");
type JobBackend = import("./extensions/jobs.ts").JobBackend;

const config = { ...loadConfig(), t3AllowSend: true, timeZone: "America/Chicago", decisionUrl: undefined };
const models = createModels({ credentials: new FileCredentialStore(config.authFile) });
models.setProvider(metaProvider());
await registerProfiles(models, listProfiles().map((each) => loadProfile(each)));

const backend: JobBackend = {
	launch: async () => ({ threadId: "eval" }),
	peek: async () => ({ status: "running", activeRunId: "r", latestRunId: "r", pendingRequestCount: 0, runCount: 1, itemCount: 1, settled: false }),
	read: async (_thread, _environment, from) => ({ items: [], position: from }),
	pending: async () => [],
	send: async () => undefined,
	interrupt: async () => undefined,
	settle: async () => undefined,
	projects: async () => [
		{ id: "p1", title: "hexfall", machine: "pc1", environmentId: "e1", hasRepo: true },
		{ id: "p2", title: "span", machine: "mp1", hasRepo: true },
	],
	machines: async () => [{ machine: "mp1" }, { machine: "pc1", environmentId: "e1" }, { machine: "mm1", environmentId: "e2" }],
	linkFor: async (thread) => `https://example.test/${thread}`,
};

const fakeWorker = join(scratch, "worker.sh");
writeFileSync(fakeWorker, "#!/bin/sh\nsleep 1\necho 'Done. The report goes here.'\n");
chmodSync(fakeWorker, 0o755);
const notes = join(scratch, "notes.md");
writeFileSync(notes, readFileSync(join(repo, "evals/notes.md"), "utf8"));

const agent = await openAgent(
	await openNodeSqliteStorage(join(scratch, "evals.sqlite")),
	{
		config,
		models,
		notes: new Notes(notes),
		jobBackend: backend,
		jobStore: new JobStore(join(scratch, "jobs.json")),
		decisions: decisionClient({ logFile: join(scratch, "decisions.jsonl") }),
		workers: { command: fakeWorker, provider: "xai", model: "w", thinkingLevel: "high", timeoutMs: 20_000, cwd: join(scratch, "work"), sessionDir: join(scratch, "sessions"), promptFile: join(scratch, "w.md"), toolsFile: join(scratch, "t.ts"), cliFile: join(scratch, "c.ts"), museCommand: "muse", piFallback: { provider: "xai", model: "w" }, quickThinkingLevel: "medium", skills: [] },
	},
	context,
);

/** A neutral judge for how a reply reads, the same one for every profile. */
async function judge(message: string, reply: string): Promise<{ score: number; why: string } | undefined> {
	const model = models.getModel("meta", "muse-wonder-1.0");
	if (model === undefined) return undefined;
	const system =
		'You grade a text from a personal assistant. A 5 reads like a perceptive, capable person texting a friend: says the useful thing first, no filler, no service-desk phrases, right size for the moment. A 3 is fine but generic. A 1 reads like a chatbot. Reply with JSON only: {"score": 1-5, "why": "one short sentence"}.';
	try {
		const answer = await models.completeSimple(model, { systemPrompt: system, messages: [{ role: "user", content: `They said: ${message.slice(0, 600)}\n\nThe assistant replied: ${reply}`, timestamp: Date.now() }] }, { reasoning: "low", signal: AbortSignal.timeout(60_000) });
		const raw = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		return JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "") as { score: number; why: string };
	} catch {
		return undefined;
	}
}

function grade(expect: Expect, tools: string[], reply: string, silent: boolean, error: string | undefined): string[] {
	const failures: string[] = [];
	if (error !== undefined) failures.push(`error: ${error.slice(0, 160)}`);
	for (const tool of expect.toolsAll ?? []) if (!tools.includes(tool)) failures.push(`should have called ${tool}`);
	if (expect.toolsAny !== undefined && !expect.toolsAny.some((tool) => tools.includes(tool))) failures.push(`should have called one of ${expect.toolsAny.join(", ")}`);
	for (const tool of expect.toolsNone ?? []) if (tools.includes(tool)) failures.push(`shouldn't have called ${tool}`);
	if (expect.reply === "text" && (reply === "" || silent)) failures.push("should have written a reply");
	if (expect.reply === "silent" && !silent) failures.push(`should have stayed quiet, said: ${reply.slice(0, 100)}`);
	for (const pattern of expect.match ?? []) if (!new RegExp(pattern, "i").test(reply)) failures.push(`reply should match ${pattern}`);
	for (const pattern of expect.avoid ?? []) if (new RegExp(pattern, "im").test(reply)) failures.push(`reply shouldn't match ${pattern}`);
	if (expect.maxChars !== undefined && reply.length > expect.maxChars) failures.push(`reply is ${reply.length} characters, over ${expect.maxChars}`);
	return failures;
}

const cases = (JSON.parse(readFileSync(join(repo, holdout ? "evals/holdout.json" : "evals/cases.json"), "utf8")) as Case[]).filter((each) => only === undefined || only.includes(each.id));
const results: Run[] = [];
for (let run = 0; run < runs; run++) {
	for (const each of cases) {
		const conversation = await agent.conversationFor(`discord:channel:eval-${run}-${each.id}`, context);
		const started = performance.now();
		await conversation.submit({ type: "input", content: `[Thu 2026-11-05 14:00 (America/Chicago, UTC-06:00)]\n${each.message}`, requestId: `eval:${run}:${each.id}` }, context);
		let quiet = 0;
		for (let tick = 0; tick < 1_800 && quiet < 6; tick++) {
			const live = await agent.harness.snapshot(LiveDoc, conversation.id, context);
			quiet = live?.run === undefined ? quiet + 1 : 0;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const ms = Math.round(performance.now() - started - 600);
		const tools: string[] = [];
		const said: string[] = [];
		let outputTokens = 0;
		let error: string | undefined;
		for (const entry of (await conversation.context(context)).entries) {
			if (!AssistantEntry.is(entry)) continue;
			const message = entry.model?.[0] as unknown as { content: { type: string; text?: string; name?: string; arguments?: Record<string, unknown> }[]; usage: { output: number }; errorMessage?: string };
			outputTokens += message.usage.output;
			if (message.errorMessage !== undefined) error = message.errorMessage;
			for (const part of message.content) {
				if (part.type === "toolCall") tools.push(part.name === "start_job" && part.arguments?.background === true ? "start_job(bg)" : part.name!);
				if (part.type === "text" && part.text?.trim()) said.push(part.text.trim());
			}
		}
		const reply = said.at(-1) ?? "";
		const silent = reply === "" || reply.startsWith("NO_REPLY");
		const failures = grade(each.expect, tools, silent ? "" : reply, silent, error);
		const scored = judging && each.expect.judge === true && !silent ? await judge(each.message, reply) : undefined;
		if (scored !== undefined && scored.score < 4) failures.push(`judge gave ${scored.score}: ${scored.why}`);
		results.push({ id: each.id, run, ok: failures.length === 0, failures, tools, reply, ms, outputTokens, ...(scored === undefined ? {} : { judge: scored }) });
		console.log(`${failures.length === 0 ? "pass" : "FAIL"} ${each.id} r${run} ${(ms / 1000).toFixed(1)}s ${tools.join(",") || "-"}${failures.length === 0 ? "" : ` | ${failures.join("; ")}`}`);
	}
}
await agent.harness.close(context);

const passed = results.filter((each) => each.ok).length;
const times = results.map((each) => each.ms).sort((a, b) => a - b);
const judged = results.flatMap((each) => (each.judge === undefined ? [] : [each.judge.score]));
const summary = {
	profile: name,
	model: config.model,
	thinkingLevel: config.thinkingLevel,
	set: holdout ? "holdout" : "cases",
	passed,
	total: results.length,
	medianSeconds: Math.round(times[Math.floor(times.length / 2)]! / 100) / 10,
	outputTokens: results.reduce((sum, each) => sum + each.outputTokens, 0),
	judgeAverage: judged.length === 0 ? undefined : Math.round((judged.reduce((sum, each) => sum + each, 0) / judged.length) * 10) / 10,
};
const dir = join(home, "evals", "runs", name);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}${holdout ? "-holdout" : ""}.json`);
writeFileSync(file, `${JSON.stringify({ summary, results }, null, "\t")}\n`, { mode: 0o600 });
console.log(`\n${name}: ${passed}/${results.length} passed, median ${summary.medianSeconds}s, ${summary.outputTokens} output tokens${summary.judgeAverage === undefined ? "" : `, voice ${summary.judgeAverage}/5`}\n${file}`);
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
