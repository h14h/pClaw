import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writePrivate } from "./config.ts";

/**
 * A minimal client for T3 Code's official MCP endpoint (`<t3>/mcp`, Streamable HTTP, OAuth 2.1 + PKCE).
 * pclaw has no general MCP client, and T3 rejects its plain session bearers at /mcp (`invalid_mcp_credential`),
 * so this implements just the pieces pclaw needs: discovery, dynamic client registration, the authorize/token
 * exchange, initialize, tools/list, and tools/call. Tokens live in one 0600 file and never enter model context.
 */

export type T3Tool = { name: string; description?: string; inputSchema?: unknown };
export type T3Thread = { id: string; title?: string; status: string; updatedAt?: string; raw: Record<string, unknown> };
export type T3Project = { id: string; title?: string; workspaceRoot?: string; raw: Record<string, unknown> };
/**
 * Every MCP tool pclaw knows how to reach, by purpose. Keys map to T3's canonical tool names in
 * `CANONICAL_TOOLS` below (verified against the live 83-tool list); only the four original keys keep
 * regex fallbacks, since those predate the canonical names. Anything T3 offers that has no key here
 * is still reachable by exact name through `callTool` / the extension's `t3_call`.
 */
export type T3ToolMap = Partial<Record<T3ToolKey, string>>;
export type T3ToolKey =
	| "list" | "get" | "send" | "threadUpdate" | "threadOrganize" | "threadLaunch" | "threadWait" | "threadInterrupt"
	| "threadSearch" | "threadFork" | "threadMergeBack" | "threadTransfers" | "threadConfiguration" | "threadConfigure"
	| "sendAttachments"
	| "queueList" | "queueRead" | "queueEdit" | "queueCancel" | "queueReorder" | "queuePromote"
	| "pendingList" | "pendingRead" | "pendingRespond"
	| "projectList" | "projectRead" | "projectCreate" | "projectUpdate" | "projectDelete" | "projectClone"
	| "scheduleTask" | "scheduledList" | "scheduledUpdate" | "scheduledDelete" | "scheduledRunNow"
	| "delegateTask" | "taskStatus" | "taskCancel" | "workflowStop" | "createThreads"
	| "capabilities" | "requestSecret"
	| "attachmentPrepare" | "attachmentDiscard"
	| "environmentRead" | "environmentPreferencesUpdate"
	| "previewList" | "previewClose"
	| "worktreeHandoff" | "worktreeStatus" | "worktreeList"
	| "linkPullRequest" | "unlinkPullRequest" | "listThreadPullRequests" | "watchPullRequest" | "unwatchPullRequest"
	| "writePullRequestGuides" | "readPullRequestGuide"
	| "deviceList" | "deviceOpen" | "deviceClose" | "deviceScreenshot"
	| "htmlRender" | "htmlPreview"
	| "previewDialog" | "previewStatus" | "previewOpen" | "previewNavigate" | "previewResize" | "previewSetAppearance"
	| "previewClick" | "previewType" | "previewHover" | "previewSelect" | "previewDrag" | "previewUpload" | "previewPress"
	| "previewScroll" | "previewEvaluate" | "previewWaitFor" | "previewRecordingStart" | "previewRecordingStop" | "previewSnapshot";

export const CANONICAL_TOOLS: Record<T3ToolKey, string> = {
	list: "t3_thread_list", get: "t3_thread_read", send: "t3_thread_send",
	threadUpdate: "t3_thread_update", threadOrganize: "t3_thread_organize", threadLaunch: "t3_thread_launch",
	threadWait: "t3_thread_wait", threadInterrupt: "t3_thread_interrupt", threadSearch: "t3_thread_search",
	threadFork: "t3_thread_fork", threadMergeBack: "t3_thread_merge_back", threadTransfers: "t3_thread_transfers",
	threadConfiguration: "t3_thread_configuration", threadConfigure: "t3_thread_configure",
	sendAttachments: "t3_thread_send_attachments",
	queueList: "t3_queue_list", queueRead: "t3_queue_read", queueEdit: "t3_queue_edit", queueCancel: "t3_queue_cancel",
	queueReorder: "t3_queue_reorder", queuePromote: "t3_queue_promote_to_steer",
	pendingList: "t3_pending_request_list", pendingRead: "t3_pending_request_read", pendingRespond: "t3_pending_request_respond",
	projectList: "t3_project_list", projectRead: "t3_project_read", projectCreate: "t3_project_create",
	projectUpdate: "t3_project_update", projectDelete: "t3_project_delete", projectClone: "t3_project_clone",
	scheduleTask: "schedule_task", scheduledList: "list_scheduled_tasks", scheduledUpdate: "update_scheduled_task",
	scheduledDelete: "delete_scheduled_task", scheduledRunNow: "run_scheduled_task_now",
	delegateTask: "delegate_task", taskStatus: "task_status", taskCancel: "task_cancel",
	workflowStop: "t3_workflow_stop", createThreads: "create_threads",
	capabilities: "orchestrator_capabilities", requestSecret: "request_secret",
	attachmentPrepare: "t3_attachment_prepare_upload", attachmentDiscard: "t3_attachment_discard",
	environmentRead: "t3_environment_read", environmentPreferencesUpdate: "t3_environment_preferences_update",
	previewList: "t3_preview_list", previewClose: "t3_preview_close",
	worktreeHandoff: "t3_worktree_handoff", worktreeStatus: "t3_worktree_status", worktreeList: "t3_worktree_list",
	linkPullRequest: "link_pull_request", unlinkPullRequest: "unlink_pull_request",
	listThreadPullRequests: "list_thread_pull_requests", watchPullRequest: "watch_pull_request",
	unwatchPullRequest: "unwatch_pull_request", writePullRequestGuides: "write_pull_request_guides",
	readPullRequestGuide: "read_pull_request_guide",
	deviceList: "device_list", deviceOpen: "device_open", deviceClose: "device_close", deviceScreenshot: "device_screenshot",
	htmlRender: "html_render", htmlPreview: "html_preview",
	previewDialog: "preview_dialog", previewStatus: "preview_status", previewOpen: "preview_open",
	previewNavigate: "preview_navigate", previewResize: "preview_resize", previewSetAppearance: "preview_set_appearance",
	previewClick: "preview_click", previewType: "preview_type", previewHover: "preview_hover", previewSelect: "preview_select",
	previewDrag: "preview_drag", previewUpload: "preview_upload", previewPress: "preview_press",
	previewScroll: "preview_scroll", previewEvaluate: "preview_evaluate", previewWaitFor: "preview_wait_for",
	previewRecordingStart: "preview_recording_start", previewRecordingStop: "preview_recording_stop",
	previewSnapshot: "preview_snapshot",
};

export type T3PendingPairing = { state: string; verifier: string; redirectUri: string; createdAt: number };
export type T3Store = {
	clientId?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	scope?: string;
	pending?: T3PendingPairing;
	tools?: T3ToolMap;
};

export function loadT3Store(file: string): T3Store {
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T3Store;
	} catch {
		return {};
	}
}

export function saveT3Store(file: string, store: T3Store): void {
	writePrivate(file, JSON.stringify(store, null, "\t") + "\n");
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export function codeChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

export type OAuthServer = { authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint?: string; resource: string };

/** OAuth + protected-resource discovery (RFC 8414 / RFC 9728), as advertised by T3's 401 response. */
export async function discoverOAuth(t3Url: string, fetchFn: typeof fetch = fetch): Promise<OAuthServer> {
	const resourceResponse = await fetchFn(`${t3Url}/.well-known/oauth-protected-resource/mcp`);
	if (!resourceResponse.ok) throw new Error(`T3 resource discovery failed: HTTP ${resourceResponse.status}`);
	const resourceMeta = (await resourceResponse.json()) as { resource?: string };
	const serverResponse = await fetchFn(`${t3Url}/.well-known/oauth-authorization-server`);
	if (!serverResponse.ok) throw new Error(`T3 OAuth discovery failed: HTTP ${serverResponse.status}`);
	const meta = (await serverResponse.json()) as { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string };
	return {
		authorizationEndpoint: meta.authorization_endpoint,
		tokenEndpoint: meta.token_endpoint,
		...(meta.registration_endpoint === undefined ? {} : { registrationEndpoint: meta.registration_endpoint }),
		resource: resourceMeta.resource ?? `${t3Url}/mcp`,
	};
}

export async function registerClient(server: OAuthServer, redirectUri: string, fetchFn: typeof fetch = fetch): Promise<string> {
	if (server.registrationEndpoint === undefined) throw new Error("T3 did not advertise dynamic client registration.");
	const response = await fetchFn(server.registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "pclaw",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: "orchestration:read orchestration:operate",
		}),
	});
	if (!response.ok) throw new Error(`T3 client registration failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
	const body = (await response.json()) as { client_id?: string };
	if (body.client_id === undefined) throw new Error("T3 client registration returned no client_id.");
	return body.client_id;
}

export function authorizeUrl(args: {
	authorizationEndpoint: string;
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
	scope: string;
	resource: string;
}): string {
	const url = new URL(args.authorizationEndpoint);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: args.clientId,
		redirect_uri: args.redirectUri,
		state: args.state,
		code_challenge: args.challenge,
		code_challenge_method: "S256",
		scope: args.scope,
		resource: args.resource,
	}).toString();
	return url.toString();
}

/** Start pairing: register once, remember the PKCE verifier privately, and return the URL the owner approves. */
export async function startPairing(options: { t3Url: string; storeFile: string; redirectUri: string }): Promise<string> {
	const server = await discoverOAuth(options.t3Url);
	const store = loadT3Store(options.storeFile);
	store.clientId ??= await registerClient(server, options.redirectUri);
	const pending: T3PendingPairing = {
		state: base64url(randomBytes(24)),
		verifier: base64url(randomBytes(48)),
		redirectUri: options.redirectUri,
		createdAt: Date.now(),
	};
	store.pending = pending;
	saveT3Store(options.storeFile, store);
	return authorizeUrl({
		authorizationEndpoint: server.authorizationEndpoint,
		clientId: store.clientId,
		redirectUri: pending.redirectUri,
		state: pending.state,
		challenge: codeChallenge(pending.verifier),
		scope: "orchestration:read orchestration:operate",
		resource: server.resource,
	});
}

/** Finish pairing from the dashboard callback (or a pasted redirect URL). Returns the granted scope. */
export async function completePairing(options: { t3Url: string; storeFile: string; code: string; state?: string }): Promise<string> {
	const store = loadT3Store(options.storeFile);
	const pending = store.pending;
	if (pending === undefined || store.clientId === undefined) throw new Error("No T3 pairing is in progress. Start pairing first.");
	if (options.state !== undefined && options.state !== pending.state) throw new Error("That pairing link doesn't match the one pclaw started. Start pairing again.");
	const server = await discoverOAuth(options.t3Url);
	const response = await fetch(server.tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: options.code,
			redirect_uri: pending.redirectUri,
			client_id: store.clientId,
			code_verifier: pending.verifier,
			resource: server.resource,
		}),
	});
	if (!response.ok) throw new Error(`T3 token exchange failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
	const body = (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
	store.accessToken = body.access_token;
	if (body.refresh_token !== undefined) store.refreshToken = body.refresh_token;
	if (body.expires_in !== undefined) store.expiresAt = Date.now() + body.expires_in * 1000;
	if (body.scope !== undefined) store.scope = body.scope;
	delete store.pending;
	delete store.tools;
	saveT3Store(options.storeFile, store);
	return body.scope ?? "";
}

async function refreshIfNeeded(t3Url: string, storeFile: string): Promise<string> {
	const store = loadT3Store(storeFile);
	if (store.accessToken === undefined) throw new Error("pclaw isn't paired with T3 yet.");
	if (store.expiresAt === undefined || store.expiresAt > Date.now() + 60_000 || store.refreshToken === undefined || store.clientId === undefined) return store.accessToken;
	const server = await discoverOAuth(t3Url);
	const response = await fetch(server.tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: store.refreshToken, client_id: store.clientId, resource: server.resource }),
	});
	if (!response.ok) throw new Error("pclaw's T3 pairing has expired. Pair again to reconnect.");
	const body = (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
	store.accessToken = body.access_token;
	if (body.refresh_token !== undefined) store.refreshToken = body.refresh_token;
	if (body.expires_in !== undefined) store.expiresAt = Date.now() + body.expires_in * 1000;
	saveT3Store(storeFile, store);
	return store.accessToken;
}

/** Build a client from the stored pairing. */
export async function pairedClient(t3Url: string, storeFile: string): Promise<T3Client> {
	return new T3Client(t3Url, await refreshIfNeeded(t3Url, storeFile));
}

/**
 * Tool names come from the server's tools/list, never hard-coded: T3's built-in MCP surface can rename tools
 * between versions. Matching is by purpose, and `t3_status` shows the owner what was found.
 */
export function pickTools(tools: { name: string }[]): T3ToolMap {
	const names = new Set(tools.map((tool) => tool.name));
	const map: T3ToolMap = {};
	// Exact canonical names first: no guessing at the full toolset's names or arguments.
	for (const [key, canonical] of Object.entries(CANONICAL_TOOLS) as [T3ToolKey, string][]) {
		if (names.has(canonical)) map[key] = canonical;
	}
	// The original four predate the canonical names, so they keep their drift-tolerant fallbacks.
	const all = [...names];
	const pick = (...patterns: RegExp[]) => patterns.flatMap((pattern) => all.filter((name) => pattern.test(name)))[0];
	map.list ??= pick(/list[_-]?threads?$/i, /threads?[_-]?list/i, /list/i);
	map.get ??= pick(/get[_-]?thread/i, /thread[_-]?(get|read|show)/i, /get/i);
	map.send ??= pick(/send[_-]?(message|prompt)/i, /thread.*(send|message|prompt|turn)/i, /send/i);
	map.projectList ??= pick(/list[_-]?projects?$/i, /projects?[_-]?list/i, /project[_-]?list/i);
	return map;
}

/** Drop undefined fields: several T3 tools reject excess or null-ish properties they didn't ask for. */
export function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

/** The new thread's id from a launch result, in whichever shape the server used. */
export function launchedThreadId(value: unknown): string | undefined {
	const record = asRecord(value);
	if (record === undefined) return undefined;
	const thread = asRecord(record.thread);
	const candidates = [record.threadId, record.id, thread?.id, thread?.threadId, asRecord(record.result)?.threadId, asRecord(asRecord(record.result)?.thread)?.id];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate !== "") return candidate;
	if (Array.isArray(record.threads)) return launchedThreadId(record.threads[0]);
	return undefined;
}

function itemText(record: Record<string, unknown>): string | undefined {
	for (const key of ["text", "content", "message", "body"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return value;
		if (Array.isArray(value)) {
			const joined = value.flatMap((part) => { const p = asRecord(part); return p !== undefined && typeof p.text === "string" ? [p.text] : typeof part === "string" ? [part] : []; }).join("\n").trim();
			if (joined !== "") return joined;
		}
	}
	return undefined;
}

/** The last assistant message in a thread-read result; falls back to the last text item of any kind. */
export function lastAssistantText(value: unknown): string | undefined {
	const record = asRecord(value);
	const arrays: unknown[] = [];
	const collect = (node: unknown, depth: number) => {
		if (depth > 3 || node === null || typeof node !== "object") return;
		if (Array.isArray(node)) { arrays.push(node); return; }
		for (const key of ["items", "messages", "timeline", "entries", "data", "result", "thread"]) collect((node as Record<string, unknown>)[key], depth + 1);
	};
	collect(value, 0);
	let lastAny: string | undefined;
	let lastAssistant: string | undefined;
	for (const array of arrays) {
		for (const item of array as unknown[]) {
			const itemRecord = asRecord(item);
			if (itemRecord === undefined) continue;
			const text = itemText(itemRecord);
			if (text === undefined) continue;
			lastAny = text;
			const marker = [itemRecord.role, itemRecord.type, itemRecord.kind, itemRecord.author].filter((v) => typeof v === "string").join(" ").toLowerCase();
			if (/assistant|agent|model/.test(marker) && !/user|human/.test(marker)) lastAssistant = text;
		}
	}
	return lastAssistant ?? lastAny ?? (record !== undefined ? itemText(record) : typeof value === "string" && value.trim() !== "" ? value : undefined);
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function statusOf(record: Record<string, unknown>): string {
	const turn = asRecord(record.turn);
	const candidates = [record.status, record.state, record.phase, turn?.state, turn?.status];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate !== "") return candidate;
	return "unknown";
}

/** Normalize whatever list/get shape the server returns into threads; unknown shapes give []. */
export function parseThreads(value: unknown): T3Thread[] {
	const record = asRecord(value);
	const items = Array.isArray(value) ? value : record === undefined ? [] : [record.threads, record.items, record.data, record.result, record].find(Array.isArray) ?? (record.id !== undefined || record.threadId !== undefined ? [record] : []);
	const threads: T3Thread[] = [];
	for (const item of items) {
		const raw = asRecord(item);
		if (raw === undefined) continue;
		const id = raw.id ?? raw.threadId ?? raw.thread_id;
		if (typeof id !== "string" && typeof id !== "number") continue;
		threads.push({
			id: String(id),
			...(typeof raw.title === "string" ? { title: raw.title } : typeof raw.name === "string" ? { title: raw.name } : {}),
			status: statusOf(raw),
			...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
			raw,
		});
	}
	return threads;
}

/** Normalize a project-list result (`{projects:[…]}` on current T3); unknown shapes give []. */
export function parseProjects(value: unknown): T3Project[] {
	const record = asRecord(value);
	const items = Array.isArray(value) ? value : record === undefined ? [] : [record.projects, record.items, record.data, record.result].find(Array.isArray) ?? (record.id !== undefined || record.projectId !== undefined ? [record] : []);
	const projects: T3Project[] = [];
	for (const item of items) {
		const raw = asRecord(item);
		if (raw === undefined) continue;
		const id = raw.id ?? raw.projectId ?? raw.project_id;
		if (typeof id !== "string" && typeof id !== "number") continue;
		projects.push({
			id: String(id),
			...(typeof raw.title === "string" ? { title: raw.title } : typeof raw.name === "string" ? { title: raw.name } : {}),
			...(typeof raw.workspaceRoot === "string" ? { workspaceRoot: raw.workspaceRoot } : {}),
			raw,
		});
	}
	return projects;
}

export type AttentionKind = "waiting" | "finished" | "failed";
export type AttentionEvent = { thread: T3Thread; kind: AttentionKind; signature: string };

export function threadSignature(thread: T3Thread): string {
	return `${thread.status}|${thread.updatedAt ?? ""}`;
}

function attentionKind(status: string): AttentionKind | undefined {
	const value = status.toLowerCase();
	if (/fail|error|interrupt|cancel/.test(value)) return "failed";
	if (/wait|attention|requires|question|input|approval|blocked/.test(value)) return "waiting";
	if (/complete|finish|done|settled|idle/.test(value)) return "finished";
	return undefined;
}

/** Events for threads whose signature changed into a state the owner should hear about. */
export function attentionEvents(previous: Map<string, string>, threads: T3Thread[]): AttentionEvent[] {
	const events: AttentionEvent[] = [];
	for (const thread of threads) {
		const signature = threadSignature(thread);
		// First sight of a thread is a baseline, not news: only transitions ping.
		if (!previous.has(thread.id) || previous.get(thread.id) === thread.status || previous.get(thread.id) === signature) continue;
		const kind = attentionKind(thread.status);
		if (kind !== undefined) events.push({ thread, kind, signature });
	}
	return events;
}

type RpcResult = { result?: unknown; error?: { code?: number; message?: string } };

function parseRpcBody(text: string, contentType: string): RpcResult {
	if (contentType.includes("text/event-stream")) {
		const data = text
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim());
		const last = data.at(-1);
		if (last === undefined) throw new Error("T3 MCP returned an empty event stream.");
		return JSON.parse(last) as RpcResult;
	}
	return JSON.parse(text) as RpcResult;
}

export class T3Client {
	readonly #url: string;
	readonly #token: string;
	readonly #fetchFn: typeof fetch;
	#sessionId: string | undefined;
	#ready: Promise<void> | undefined;
	#tools: T3ToolMap | undefined;

	constructor(t3Url: string, accessToken: string, fetchFn: typeof fetch = fetch) {
		this.#url = `${t3Url.replace(/\/$/, "")}/mcp`;
		this.#token = accessToken;
		this.#fetchFn = fetchFn;
	}

	async #rpc(method: string, params?: Record<string, unknown>, notification = false): Promise<unknown> {
		const response = await this.#fetchFn(this.#url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: ["Bearer", this.#token].join(" "),
				...(this.#sessionId === undefined ? {} : { "Mcp-Session-Id": this.#sessionId }),
			},
			body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: Math.floor(Math.random() * 1_000_000_000) }), method, ...(params === undefined ? {} : { params }) }),
		});
		this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
		const text = await response.text();
		if (!response.ok) throw new Error(`T3 MCP ${method} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
		if (notification || text === "") return undefined;
		const body = parseRpcBody(text, response.headers.get("content-type") ?? "");
		if (body.error !== undefined) throw new Error(`T3 MCP ${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
		return body.result;
	}

	async #ensureReady(): Promise<void> {
		this.#ready ??= (async () => {
			await this.#rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pclaw", version: "0.1.0" } });
			await this.#rpc("notifications/initialized", {}, true);
		})();
		return this.#ready;
	}

	async listTools(): Promise<T3Tool[]> {
		await this.#ensureReady();
		const result = asRecord(await this.#rpc("tools/list", {}));
		const tools = Array.isArray(result?.tools) ? result.tools : [];
		const parsed = tools.flatMap((tool) => {
			const record = asRecord(tool);
			return record !== undefined && typeof record.name === "string"
				? [{ name: record.name, ...(typeof record.description === "string" ? { description: record.description } : {}), inputSchema: record.inputSchema }]
				: [];
		});
		this.#tools = pickTools(parsed);
		return parsed;
	}

	async toolMap(): Promise<T3ToolMap> {
		if (this.#tools === undefined) await this.listTools();
		return this.#tools ?? {};
	}

	/** Call a tool and unwrap MCP content: structuredContent, else JSON text, else plain text. */
	async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
		await this.#ensureReady();
		const result = asRecord(await this.#rpc("tools/call", { name, arguments: args }));
		if (result === undefined) return undefined;
		if (result.isError === true) throw new Error(`T3 tool ${name} failed: ${JSON.stringify(result.content ?? result).slice(0, 500)}`);
		if (result.structuredContent !== undefined) return result.structuredContent;
		const content = Array.isArray(result.content) ? result.content : [];
		const texts = content.flatMap((part) => {
			const record = asRecord(part);
			return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
		});
		const joined = texts.join("\n");
		try {
			return JSON.parse(joined) as unknown;
		} catch {
			return joined;
		}
	}

	async listProjects(args: Record<string, unknown> = {}): Promise<T3Project[]> {
		const { projectList } = await this.toolMap();
		if (projectList === undefined) throw new Error("T3's MCP server offered no project-listing tool. Run t3_status to see what it offers.");
		return parseProjects(await this.callTool(projectList, args));
	}

	/** T3 requires `projectId` for clients not running inside a thread (`target_required` otherwise). */
	async listThreads(args: Record<string, unknown> | string = {}): Promise<T3Thread[]> {
		const { list } = await this.toolMap();
		if (list === undefined) throw new Error("T3's MCP server offered no thread-listing tool. Run t3_status to see what it offers.");
		return parseThreads(await this.callTool(list, typeof args === "string" ? { projectId: args } : args));
	}

	/** Fill argument names from the tool's own inputSchema, so a renamed parameter doesn't break the call. */
	async #argsFor(toolName: string, values: { threadId: string; message?: string; projectId?: string }): Promise<Record<string, unknown>> {
		const tools = await this.listTools();
		const schema = asRecord(tools.find((tool) => tool.name === toolName)?.inputSchema);
		const properties = asRecord(schema?.properties) ?? {};
		const keys = Object.keys(properties);
		const threadKey = keys.find((key) => /thread/i.test(key)) ?? keys.find((key) => key === "id") ?? "threadId";
		const args: Record<string, unknown> = { [threadKey]: values.threadId };
		// Only forward projectId when the tool declares it: current t3_thread_read rejects excess properties.
		const projectKey = keys.find((key) => /project/i.test(key));
		if (values.projectId !== undefined && projectKey !== undefined) args[projectKey] = values.projectId;
		if (values.message !== undefined) {
			const messageKey = keys.find((key) => /message|prompt|text|content/i.test(key)) ?? "message";
			args[messageKey] = values.message;
		}
		return args;
	}

	async getThread(threadId: string, projectId?: string): Promise<unknown> {
		const { get } = await this.toolMap();
		if (get === undefined) throw new Error("T3's MCP server offered no thread-reading tool. Run t3_status to see what it offers.");
		return this.callTool(get, await this.#argsFor(get, { threadId, ...(projectId === undefined ? {} : { projectId }) }));
	}

	async sendMessage(threadId: string, message: string, options: { mode?: "auto" | "queue" | "steer" | "restart"; clientRequestId?: string } = {}): Promise<unknown> {
		const { send } = await this.toolMap();
		if (send === undefined) throw new Error("T3's MCP server offered no send-message tool. Run t3_status to see what it offers.");
		// With explicit mode/idempotency options, pass the live schema's exact argument names.
		if (options.mode !== undefined || options.clientRequestId !== undefined)
			return this.callTool(send, compactArgs({ threadId, message, mode: options.mode, clientRequestId: options.clientRequestId }));
		return this.callTool(send, await this.#argsFor(send, { threadId, message }));
	}

	/** Call any mapped tool with explicit, verbatim arguments (no name guessing for the full toolset). */
	async callMapped(key: T3ToolKey, args: Record<string, unknown> = {}): Promise<unknown> {
		const name = (await this.toolMap())[key];
		if (name === undefined) throw new Error(`T3's MCP server offered no ${CANONICAL_TOOLS[key]} tool. Run t3_status to see what it offers.`);
		return this.callTool(name, compactArgs(args));
	}

	/** Launch a top-level thread (`t3_thread_launch`). Returns the raw result; use launchedThreadId for its id. */
	async launchThread(args: T3LaunchArgs): Promise<unknown> {
		return this.callMapped("threadLaunch", { ...args });
	}

	async waitThread(threadId: string, options: { runId?: string; timeoutMs?: number } = {}): Promise<unknown> {
		return this.callMapped("threadWait", { threadId, runId: options.runId, timeoutMs: options.timeoutMs });
	}

	async interruptThread(threadId: string, options: { runId?: string; reason?: string; clientRequestId?: string } = {}): Promise<unknown> {
		return this.callMapped("threadInterrupt", { threadId, runId: options.runId, reason: options.reason, clientRequestId: options.clientRequestId });
	}

	async updateThread(
		threadId: string,
		args: { action: "rename" | "regenerate_title" | "link_pull_request" | "unlink_pull_request"; title?: string; pullRequest?: Record<string, unknown>; clientRequestId?: string },
	): Promise<unknown> {
		return this.callMapped("threadUpdate", { threadId, ...args });
	}

	async organizeThread(
		threadId: string,
		args: { action: "pin" | "unpin" | "snooze" | "unsnooze" | "settle" | "unsettle" | "archive" | "unarchive" | "mark_unread"; snoozedUntil?: string },
	): Promise<unknown> {
		return this.callMapped("threadOrganize", { threadId, ...args });
	}

	async searchThreads(args: { query: string; limit?: number; projectId?: string }): Promise<unknown> {
		return this.callMapped("threadSearch", { ...args });
	}

	async editQueuedRun(threadId: string, queuedRunId: string, text: string): Promise<unknown> {
		return this.callMapped("queueEdit", { threadId, queuedRunId, text });
	}

	async cancelQueuedRun(threadId: string, queuedRunId: string): Promise<unknown> {
		return this.callMapped("queueCancel", { threadId, queuedRunId });
	}

	async getProject(projectId: string): Promise<unknown> {
		return this.callMapped("projectRead", { projectId });
	}
}

export type T3WorkspaceStrategy =
	| { type: "root"; branch?: string }
	| { type: "existing_worktree"; worktreePath: string; branch?: string }
	| { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean };

export type T3LaunchArgs = {
	title: string;
	projectId?: string;
	scratch?: boolean;
	message?: string;
	/** `{model, provider?, instanceId?, options?}` from orchestrator_capabilities. */
	modelSelection?: Record<string, unknown>;
	runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
	interactionMode?: "default" | "plan";
	workspaceStrategy?: T3WorkspaceStrategy;
	attachments?: unknown[];
};

export type T3TurnResult = { threadId: string; ok: boolean; output: string; status: string };

function waitStatus(value: unknown): { status: string; timedOut: boolean } {
	const record = asRecord(value);
	const nested = asRecord(record?.run) ?? asRecord(record?.thread);
	const status = [record?.status, record?.state, nested?.status, nested?.state].find((v) => typeof v === "string" && v !== "") as string | undefined;
	return { status: status ?? "unknown", timedOut: record?.timedOut === true };
}

const TERMINAL = /complete|finish|done|settled|idle|fail|error|interrupt|cancel|rolled_back/i;

/**
 * Run one worker turn in a T3 thread: launch it (or send into an existing thread), wait for the run to
 * settle with `t3_thread_wait`, then read the thread back for its last assistant message. An abort
 * interrupts the thread and rethrows, like a killed worker process; an overall timeout interrupts too
 * and reports failure. `onThreadId` fires as soon as a launch lands, so callers can persist the id
 * (the worker's session) before anything can go wrong.
 */
export async function runT3Turn(
	client: T3Client,
	options: {
		threadId?: string;
		title: string;
		message: string;
		projectId?: string;
		scratch?: boolean;
		workspaceStrategy?: T3WorkspaceStrategy;
		modelSelection?: Record<string, unknown>;
		runtimeMode?: T3LaunchArgs["runtimeMode"];
		interactionMode?: T3LaunchArgs["interactionMode"];
		timeoutMs: number;
		signal?: AbortSignal;
		onThreadId?: (threadId: string) => void;
	},
): Promise<T3TurnResult> {
	let threadId = options.threadId;
	if (threadId === undefined) {
		const launched = await client.launchThread({
			title: options.title,
			projectId: options.projectId,
			scratch: options.scratch,
			workspaceStrategy: options.workspaceStrategy,
			modelSelection: options.modelSelection,
			runtimeMode: options.runtimeMode,
			interactionMode: options.interactionMode,
			message: options.message,
		});
		threadId = launchedThreadId(launched);
		if (threadId === undefined) throw new Error(`T3 thread launch returned no thread id: ${JSON.stringify(launched).slice(0, 300)}`);
		options.onThreadId?.(threadId);
	} else {
		await client.sendMessage(threadId, options.message);
	}
	const deadline = Date.now() + options.timeoutMs;
	let status = "unknown";
	for (;;) {
		if (options.signal?.aborted) {
			await client.interruptThread(threadId, { reason: "Stopped by pclaw." }).catch(() => undefined);
			throw options.signal.reason;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			await client.interruptThread(threadId, { reason: "Timed out in pclaw." }).catch(() => undefined);
			return { threadId, ok: false, output: `Timed out after ${Math.round(options.timeoutMs / 60_000)} minutes in T3 thread ${threadId}.`, status: "timeout" };
		}
		// Wait in chunks so an abort is noticed between waits even on a long run.
		const waited = waitStatus(await client.waitThread(threadId, { timeoutMs: Math.min(remaining, 120_000) }));
		status = waited.status;
		// A waiting thread needs a human/agent answer, so the turn is over from the worker's perspective.
		if (!waited.timedOut && (TERMINAL.test(status) || /waiting/i.test(status) || status === "unknown")) break;
		// A non-blocking wait implementation could return at once; don't spin against it.
		if (!waited.timedOut) await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	const read = await client.getThread(threadId).catch(() => undefined);
	const output = lastAssistantText(read) ?? (read === undefined ? "(couldn't read the T3 thread back)" : JSON.stringify(read).slice(0, 4_000));
	return { threadId, ok: /complete|finish|done|settled|idle/i.test(status), output: /waiting/i.test(status) ? `T3 thread is waiting for an answer.\n${output}` : output, status };
}
