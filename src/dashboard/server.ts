import { existsSync, readdirSync, readFileSync, statSync, unwatchFile, watch, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttachedReplicatedState, Context, JsonValue } from "@earendil-works/chord";
import {
	type ConversationId,
	type ConversationView as DurableView,
	type DocumentState,
	LiveDoc,
	type LiveState,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Agent } from "../agent.ts";
import type { Config } from "../config.ts";
import { FollowUps } from "../extensions/follow-ups.ts";
import { ConversationInfo, Routes } from "../routes.ts";
import type { Notes } from "../extensions/notes.ts";
import { Reactions } from "../extensions/reactions.ts";
import { type WorkerOptions, Workers } from "../extensions/workers.ts";
import { PUBLISHED, SLUG } from "../pages.ts";
import { prompts } from "../prompts.ts";
import { SettingsError, settingsApi } from "./settings.ts";
import type {
	Change,
	ConversationSummary,
	ConversationView,
	ModelsUpdate,
	Overview,
	PageReadFailure,
	Settings,
	WorkerDetail,
	WorkerSummary,
} from "./types.ts";
import { buildTimeline, liveStatus, pageReadsIn, parseWorkerSession, sumUsage } from "./views.ts";

const WEB_DIST = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json",
	".woff2": "font/woff2",
	".webp": "image/webp",
	".jpg": "image/jpeg",
	".txt": "text/plain; charset=utf-8",
};

function fallbackLabel(address: string): string {
	if (address.startsWith("discord:dm:")) return "Discord DM";
	if (address === "terminal") return "Terminal";
	return address;
}

type Watched = {
	view: AttachedReplicatedState<DurableView>;
	workers: DocumentState<{ workers: Record<string, JsonValue> }> | undefined;
	followUps: DocumentState<{ items: Record<string, JsonValue> }> | undefined;
};

/**
 * The dashboard: a small read-only HTTP server inside the pclaw process (Pi Durable storage has one owner, so it can't
 * be a separate process). Serves the built web app, JSON views of each conversation, worker transcripts read from pi's
 * session files, and a server-sent event stream that says what changed.
 */
export async function startDashboard(
	options: { agent: Agent; config: Config; models: Models; notes: Notes; workers: WorkerOptions; port: number },
	context: Context,
): Promise<{ port: number; stop(): Promise<void> }> {
	const { agent, config, notes, workers } = options;
	const settings = settingsApi(options);
	const { harness } = agent;
	const watched = new Map<string, Watched>();
	const clients = new Set<ServerResponse>();
	const cleanups: (() => void)[] = [];

	// Coalesce bursts (a streaming reply commits every 100 ms) into one event per key.
	const pending = new Map<string, Change>();
	let flush: NodeJS.Timeout | undefined;
	function emit(change: Change) {
		pending.set(JSON.stringify(change), change);
		flush ??= setTimeout(() => {
			flush = undefined;
			for (const change of pending.values()) {
				const frame = `data: ${JSON.stringify(change)}\n\n`;
				for (const client of clients) client.write(frame);
			}
			pending.clear();
		}, 150);
	}

	async function watchConversation(id: ConversationId): Promise<Watched | undefined> {
		const known = watched.get(String(id));
		if (known !== undefined) return known;
		const conversation = await harness.conversation(id, context);
		if (conversation === undefined) return undefined;
		const view = await conversation.viewState(context);
		// documentState() only attaches to documents that exist; create empty ones so later changes are seen.
		await conversation.commit(async (tx) => {
			await tx.doc(Workers, id);
			await tx.doc(FollowUps, id);
			await tx.doc(Reactions, id);
		}, context);
		const workerDoc = await harness.documentState(Workers, id, context);
		const followUpDoc = await harness.documentState(FollowUps, id, context);
		const reactionsDoc = await harness.documentState(Reactions, id, context);
		const entry: Watched = { view, workers: workerDoc, followUps: followUpDoc };
		watched.set(String(id), entry);
		const changed = async () => {
			emit({ scope: "conversation", id: String(id) });
			emit({ scope: "overview" });
		};
		cleanups.push(view.subscribe(changed));
		if (workerDoc !== undefined) cleanups.push(workerDoc.subscribe(changed));
		if (followUpDoc !== undefined) cleanups.push(followUpDoc.subscribe(changed));
		if (reactionsDoc !== undefined) cleanups.push(reactionsDoc.subscribe(changed));
		return entry;
	}

	async function conversations(): Promise<[string, ConversationId][]> {
		const routes = Object.entries(await agent.addresses(context));
		for (const [, id] of routes) await watchConversation(id);
		return routes;
	}

	async function hydrated<T>(state: { value: T | undefined; subscribe(fn: (value: T) => Promise<void>): () => void }): Promise<T> {
		if (state.value !== undefined) return state.value;
		return new Promise((resolve) => {
			const stop = state.subscribe(async (value) => {
				stop();
				resolve(value);
			});
		});
	}

	const workerSummaries = async (id: ConversationId): Promise<WorkerSummary[]> => {
		const doc = await harness.snapshot(Workers, id, context);
		return Object.entries(doc?.workers ?? {})
			.map(([name, worker]) => ({
				name,
				status: worker.status,
				brief: worker.brief,
				...(worker.startedAt === undefined ? {} : { startedAt: worker.startedAt }),
				updatedAt: worker.updatedAt,
			}))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	};

	async function describe(address: string, id: ConversationId): Promise<{ label: string; parentId?: string; forkedAt?: string }> {
		const info = (await harness.snapshot(ConversationInfo, context))?.conversations[String(id)];
		return {
			label: info?.label ?? fallbackLabel(address),
			...(info?.parent === undefined ? {} : { parentId: String(info.parent) }),
			...(info?.forkedAt === undefined ? {} : { forkedAt: String(info.forkedAt) }),
		};
	}

	// Page-read stats from the workers' session files, recomputed only for files that changed.
	const readStats = new Map<string, { mtime: number; stats: ReturnType<typeof pageReadsIn> }>();
	function pageReads(): Overview["pageReads"] {
		if (!existsSync(workers.sessionDir)) return { total: 0, failing: [] };
		let total = 0;
		const byHost = new Map<string, PageReadFailure>();
		for (const name of readdirSync(workers.sessionDir)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(workers.sessionDir, name);
			const mtime = statSync(file).mtimeMs;
			let cached = readStats.get(file);
			if (cached?.mtime !== mtime) {
				cached = { mtime, stats: pageReadsIn(readFileSync(file, "utf8")) };
				readStats.set(file, cached);
			}
			total += cached.stats.total;
			for (const failure of cached.stats.failures) {
				const entry = byHost.get(failure.host) ?? { host: failure.host, failures: 0, lastAt: 0, lastError: "" };
				entry.failures++;
				if (failure.at >= entry.lastAt) Object.assign(entry, { lastAt: failure.at, lastError: failure.error });
				byHost.set(failure.host, entry);
			}
		}
		return { total, failing: [...byHost.values()].sort((a, b) => b.failures - a.failures || b.lastAt - a.lastAt) };
	}

	async function overview(): Promise<Overview> {
		const list: ConversationSummary[] = [];
		for (const [address, id] of await conversations()) {
			const live = await harness.snapshot(LiveDoc, id, context);
			const { forkedAt: _forkedAt, ...described } = await describe(address, id);
			list.push({
				id: String(id),
				address,
				...described,
				busy: live?.run !== undefined,
				workersRunning: (await workerSummaries(id)).filter((worker) => worker.status === "working").length,
			});
		}
		return {
			front: { provider: config.provider, model: config.model, thinkingLevel: config.thinkingLevel },
			worker: { provider: workers.provider, model: workers.model, thinkingLevel: workers.thinkingLevel },
			conversations: list,
			notes: notes.read(),
			pageReads: pageReads(),
		};
	}

	/** pclaw's reaction on each of the person's messages, keyed by transcript entry id. */
	async function reactionsByEntry(id: ConversationId): Promise<Record<string, string>> {
		const asks = (await harness.snapshot(Reactions, id, context))?.asks ?? {};
		const conversation = await harness.conversation(id, context);
		const byEntry: Record<string, string> = {};
		for (const [ref, emoji] of Object.entries(asks)) {
			if (emoji === "" || conversation === undefined) continue;
			const record = await conversation.commit((tx) => tx.submissionByRequest(id, ref), context);
			if (record !== undefined && "entry" in record && record.entry !== undefined) byEntry[String(record.entry)] = emoji;
		}
		return byEntry;
	}

	async function conversationView(idText: string): Promise<ConversationView | undefined> {
		const routes = await conversations();
		const route = routes.find(([, id]) => String(id) === idText);
		if (route === undefined) return undefined;
		const [address, id] = route;
		const view = await hydrated((await watchConversation(id))!.view);
		const followUps = await harness.snapshot(FollowUps, id, context);
		const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
		return {
			id: idText,
			address,
			...(await describe(address, id)),
			live: liveStatus(live),
			timeline: buildTimeline(view.entries, live?.run === undefined, await reactionsByEntry(id)),
			workers: await workerSummaries(id),
			followUps: Object.entries(followUps?.items ?? {})
				.map(([taskId, item]) => ({ id: taskId, at: item.dueAt, note: item.note, ...(item.repeat === undefined ? {} : { repeat: item.repeat }) }))
				.sort((a, b) => a.at - b.at),
			usage: sumUsage(view.docs[UsageDoc.definition.kind] as UsageState | undefined),
		};
	}

	function sessionFile(sessionId: string): string | undefined {
		if (!existsSync(workers.sessionDir)) return undefined;
		const name = readdirSync(workers.sessionDir).find((file) => file.endsWith(`_${sessionId}.jsonl`));
		return name === undefined ? undefined : join(workers.sessionDir, name);
	}

	async function workerDetail(idText: string, name: string): Promise<WorkerDetail | undefined> {
		const route = (await conversations()).find(([, id]) => String(id) === idText);
		if (route === undefined) return undefined;
		const id = route[1];
		const worker = (await harness.snapshot(Workers, id, context))?.workers[name];
		const summary = (await workerSummaries(id)).find((each) => each.name === name);
		if (worker === undefined || summary === undefined) return undefined;
		const file = sessionFile(worker.sessionId);
		return {
			...summary,
			model: { provider: workers.provider, model: workers.model, thinkingLevel: workers.thinkingLevel },
			transcript: file === undefined ? [] : parseWorkerSession(readFileSync(file, "utf8")),
		};
	}

	// pi appends to its session file as the worker goes; each write is a worker change.
	if (existsSync(workers.sessionDir)) {
		const watcher = watch(workers.sessionDir, async (_event, file) => {
			const sessionId = file?.match(/_([0-9a-f-]+)\.jsonl$/)?.[1];
			if (sessionId === undefined) return;
			for (const [, id] of await conversations()) {
				const docs = (await harness.snapshot(Workers, id, context))?.workers ?? {};
				for (const [name, worker] of Object.entries(docs)) {
					if (worker.sessionId === sessionId) emit({ scope: "worker", conversationId: String(id), name });
				}
			}
		});
		cleanups.push(() => watcher.close());
	}
	watchFile(notes.file, { interval: 2_000 }, () => emit({ scope: "overview" }));
	cleanups.push(() => unwatchFile(notes.file));
	// Prompts can also be edited outside the dashboard.
	for (const { file } of Object.values(prompts)) {
		watchFile(file, { interval: 2_000 }, () => emit({ scope: "settings" }));
		cleanups.push(() => unwatchFile(file));
	}

	/** Writes only from the dashboard's own pages: JSON bodies (no simple cross-site form posts) from the same origin. */
	async function readJson(request: IncomingMessage): Promise<unknown> {
		if (!(request.headers["content-type"] ?? "").startsWith("application/json")) throw new SettingsError("Send JSON.");
		const origin = request.headers.origin;
		if (origin !== undefined && new URL(origin).host !== request.headers.host) throw new SettingsError("Cross-origin write refused.");
		let body = "";
		for await (const chunk of request) {
			body += chunk;
			if (body.length > 1_000_000) throw new SettingsError("Too large.");
		}
		return JSON.parse(body);
	}

	async function write(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
		if (request.method !== "PUT") return false;
		try {
			let result: Settings | undefined;
			const prompt = /^\/api\/settings\/prompts\/([^/]+)$/.exec(path);
			if (path === "/api/settings/models") result = await settings.updateModels((await readJson(request)) as ModelsUpdate, context);
			else if (prompt !== null) result = settings.savePrompt(prompt[1]!, ((await readJson(request)) as { text?: unknown }).text);
			else return false;
			emit({ scope: "settings" });
			emit({ scope: "overview" });
			json(response, result);
		} catch (error) {
			if (!(error instanceof SettingsError) && !(error instanceof SyntaxError)) throw error;
			response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
		}
		return true;
	}

	/** Published pages (src/pages.ts) from the workers' pages/ folder. Unpublished drafts aren't served. */
	function servePage(path: string, response: ServerResponse): boolean {
		const match = /^\/pages\/([^/]+)(\/.*)?$/.exec(path);
		if (match === null) return false;
		const slug = decodeURIComponent(match[1]!);
		const root = join(workers.cwd, "pages", slug);
		if (!SLUG.test(slug) || !existsSync(join(root, PUBLISHED))) {
			response.writeHead(404, { "Content-Type": "text/plain" }).end("No such page.");
			return true;
		}
		if (match[2] === undefined) {
			response.writeHead(301, { Location: `/pages/${slug}/` }).end();
			return true;
		}
		const rest = normalize(decodeURIComponent(match[2])).replace(/^(\.\.[/\\])+/, "");
		let file = join(root, rest);
		if (file.endsWith("/") || (existsSync(file) && statSync(file).isDirectory())) file = join(file, "index.html");
		if (!file.startsWith(`${root}/`) || !existsSync(file) || file.endsWith(PUBLISHED)) {
			response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found.");
			return true;
		}
		response.writeHead(200, {
			"Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
			"Cache-Control": "no-cache",
			// Pages are self-contained; this enforces it in the browser too.
			"Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'none'",
		});
		response.end(readFileSync(file));
		return true;
	}

	function serveStatic(request: IncomingMessage, response: ServerResponse) {
		if (!existsSync(join(WEB_DIST, "index.html"))) {
			response.writeHead(503, { "Content-Type": "text/plain" }).end("The dashboard isn't built. Run `pnpm --filter pclaw-web build`.");
			return;
		}
		const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
		let file = join(WEB_DIST, path);
		if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, "index.html");
		const immutable = file.includes(`${WEB_DIST}assets/`);
		response.writeHead(200, {
			"Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
			"Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
		});
		response.end(readFileSync(file));
	}

	const json = (response: ServerResponse, body: unknown) =>
		response.writeHead(body === undefined ? 404 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body ?? { error: "not found" }));

	const server = createServer(async (request, response) => {
		try {
			const path = new URL(request.url ?? "/", "http://x").pathname;
			if (await write(request, response, path)) return;
			if (request.method !== "GET") return void response.writeHead(405).end();
			if (path === "/api/overview") return json(response, await overview());
			if (path === "/api/settings") return json(response, settings.get());
			if (path === "/api/events") {
				response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
				response.write(": hello\n\n");
				clients.add(response);
				const ping = setInterval(() => response.write(": ping\n\n"), 25_000);
				request.on("close", () => {
					clearInterval(ping);
					clients.delete(response);
				});
				return;
			}
			const worker = /^\/api\/conversations\/([^/]+)\/workers\/([^/]+)$/.exec(path);
			if (worker !== null) return json(response, await workerDetail(decodeURIComponent(worker[1]!), decodeURIComponent(worker[2]!)));
			const conversation = /^\/api\/conversations\/([^/]+)$/.exec(path);
			if (conversation !== null) return json(response, await conversationView(decodeURIComponent(conversation[1]!)));
			if (path.startsWith("/api/")) return json(response, undefined);
			if (servePage(path, response)) return;
			serveStatic(request, response);
		} catch (error) {
			console.error("[pclaw] dashboard", error);
			if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" }).end("dashboard error");
		}
	});

	await conversations();
	// New conversations (a thread's first message) show up in the overview at once.
	const routesState = await harness.documentState(Routes, context);
	const infoState = await harness.documentState(ConversationInfo, context);
	const conversationsChanged = async () => emit({ scope: "overview" });
	if (routesState !== undefined) cleanups.push(routesState.subscribe(conversationsChanged));
	if (infoState !== undefined) cleanups.push(infoState.subscribe(conversationsChanged));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;
	console.log(`[pclaw] dashboard on http://127.0.0.1:${port}`);

	return {
		port,
		stop: async () => {
			clearTimeout(flush);
			for (const cleanup of cleanups) cleanup();
			for (const client of clients) client.end();
			for (const state of watched.values()) state.view.dispose();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
