/**
 * The prose lab as a web page: paste two system prompts, pick scenarios, and watch both answer side by side with checks
 * and judge scores. Serves lab-web/dist and a small JSON API on loopback (PROSE_LAB_PORT, default 7423). Runs are kept
 * in ~/.pclaw/prose-lab/web/, one file each.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { adHoc, config, LAB, livePrompt, replyAll, type Scenario, scenarios, score } from "./engine.ts";
import { type RunRequest, type RunSummary, type RunView, type Setup, THINKING, type Thinking } from "./types.ts";

const PORT = Number(process.env.PROSE_LAB_PORT ?? 7423);
const DIST = fileURLToPath(new URL("../../lab-web/dist/", import.meta.url));
const RUNS = join(LAB, "web");
const PLATFORMS = ["discord"];
const MAX_REPLIES = 400;
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};

mkdirSync(RUNS, { recursive: true });

/** Every run, newest first. A run that was going when the server stopped is marked stopped. */
const runs = new Map<string, RunView>();
for (const file of readdirSync(RUNS).filter((name) => name.endsWith(".json"))) {
	const run = JSON.parse(readFileSync(join(RUNS, file), "utf8")) as RunView;
	if (run.status === "running") run.status = "stopped";
	runs.set(run.id, run);
}
const stopping = new Set<string>();

const save = (run: RunView) => writeFileSync(join(RUNS, `${run.id}.json`), JSON.stringify(run));
const summary = ({ request: _, model: __, scenarios: ___, results: ____, ...rest }: RunView): RunSummary => rest;

function setup(): Setup {
	return {
		model: config.model,
		judge: config.workerModel,
		thinking: config.thinkingLevel as Thinking,
		platforms: PLATFORMS,
		scenarios: scenarios().map(({ name, ask, messages, live }) => ({ name, ask, messages: messages.length, ...(live === undefined ? {} : { live }) })),
		live: Object.fromEntries(PLATFORMS.map((platform) => [platform, livePrompt(platform)])),
	};
}

class BadRequest extends Error {}

function start(request: RunRequest): RunView {
	const saved = new Map(scenarios().map((scenario) => [scenario.name, scenario]));
	const picked: Scenario[] = [
		...request.scenarios.map((name) => saved.get(name) ?? fail(`No scenario ${name}`)),
		...request.typed.map((text) => text.trim()).filter(Boolean).map(adHoc),
	];
	if (request.contenders.length === 0) fail("Add a prompt to test.");
	if (picked.length === 0) fail("Pick a scenario or type a message.");
	if (!PLATFORMS.includes(request.platform)) fail(`Unknown platform ${request.platform}`);
	if (!THINKING.includes(request.thinking)) fail(`Unknown thinking level ${request.thinking}`);
	const perScenario = Math.max(1, Math.min(10, Math.floor(request.runs)));
	const total = request.contenders.length * picked.length * perScenario;
	if (total > MAX_REPLIES) fail(`That's ${total} replies; keep it under ${MAX_REPLIES}.`);

	const id = new Date().toISOString().replace(/[:.]/g, "-");
	const labels = request.contenders.map((contender, index) => contender.label.trim() || String.fromCharCode(65 + index));
	const run: RunView = {
		id,
		startedAt: Date.now(),
		status: "running",
		labels,
		done: 0,
		total,
		scores: [],
		request: { ...request, runs: perScenario },
		model: config.model,
		scenarios: picked.map(({ name, ask, messages, live }) => ({ name, ask, messages: messages.length, ...(live === undefined ? {} : { live }) })),
		results: [],
	};
	runs.set(id, run);
	save(run);

	const variants = request.contenders.map((_, index) => String(index));
	const prompts = Object.fromEntries(request.contenders.map((contender, index) => [String(index), contender.prompt.trim() === "" ? undefined : contender.prompt]));
	void replyAll({
		prompts,
		scenarios: picked,
		runs: perScenario,
		platform: request.platform,
		judging: request.judging,
		thinking: request.thinking,
		stopped: () => stopping.has(id),
		onResult: (result) => {
			run.results.push(result);
			run.done++;
			run.scores = score(variants, run.results);
			save(run);
		},
	})
		.then(() => {
			run.status = stopping.has(id) ? "stopped" : "done";
		})
		.catch((error: unknown) => {
			run.status = "failed";
			run.error = error instanceof Error ? error.message : String(error);
		})
		.finally(() => {
			stopping.delete(id);
			run.finishedAt = Date.now();
			save(run);
		});
	return run;
}

function fail(message: string): never {
	throw new BadRequest(message);
}

function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

async function body<T>(request: IncomingMessage): Promise<T> {
	let text = "";
	for await (const chunk of request) text += chunk;
	try {
		return JSON.parse(text) as T;
	} catch {
		fail("Body isn't JSON.");
	}
}

function serveStatic(request: IncomingMessage, response: ServerResponse) {
	if (!existsSync(join(DIST, "index.html"))) {
		response.writeHead(503, { "content-type": "text/plain" });
		response.end("The page isn't built. Run `pnpm --filter prose-lab-web build`.");
		return;
	}
	const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
	let file = join(DIST, path);
	if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
	const immutable = file.startsWith(join(DIST, "assets"));
	response.writeHead(200, {
		"content-type": TYPES[extname(file)] ?? "application/octet-stream",
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	});
	response.end(readFileSync(file));
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://x");
	const parts = url.pathname.split("/").filter(Boolean);
	try {
		if (parts[0] !== "api") return serveStatic(request, response);
		if (request.method === "GET" && parts[1] === "setup") return json(response, 200, setup());
		if (parts[1] === "runs" && parts.length === 2) {
			if (request.method === "GET") return json(response, 200, [...runs.values()].map(summary).sort((a, b) => b.startedAt - a.startedAt));
			if (request.method === "POST") return json(response, 200, summary(start(await body<RunRequest>(request))));
		}
		const run = parts[1] === "runs" ? runs.get(parts[2] ?? "") : undefined;
		if (run !== undefined && request.method === "GET" && parts.length === 3) return json(response, 200, run);
		if (run !== undefined && request.method === "POST" && parts[3] === "stop") {
			if (run.status === "running") stopping.add(run.id);
			return json(response, 200, summary(run));
		}
		json(response, 404, { error: "Not found" });
	} catch (error) {
		if (error instanceof BadRequest) return json(response, 400, { error: error.message });
		console.error("[prose-lab]", error);
		json(response, 500, { error: error instanceof Error ? error.message : String(error) });
	}
});

server.listen(PORT, "127.0.0.1", () => console.log(`[prose-lab] on http://127.0.0.1:${PORT}`));
