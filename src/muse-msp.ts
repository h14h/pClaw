import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Minimal, zero-dependency MSP v1 (Muse Session Protocol) JSON-RPC 2.0 client over stdio.
 * Works identically whether the child process is a local `muse serve` or an `ssh ... exec muse serve`
 * tunnel into a remote exe.dev VM.
 */

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** Generate an RFC 9562 UUIDv7 (required for MSP v1 `commandId` and new `sessionId`). */
export function uuidv7(nowMs = Date.now()): string {
	const bytes = randomBytes(16);
	const ms = BigInt(Math.max(0, Math.floor(nowMs)));
	bytes[0] = Number((ms >> 40n) & 0xffn);
	bytes[1] = Number((ms >> 32n) & 0xffn);
	bytes[2] = Number((ms >> 24n) & 0xffn);
	bytes[3] = Number((ms >> 16n) & 0xffn);
	bytes[4] = Number((ms >> 8n) & 0xffn);
	bytes[5] = Number(ms & 0xffn);
	bytes[6] = (bytes[6]! & 0x0f) | 0x70;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidv7(id: string): boolean {
	return UUIDV7_RE.test(id);
}

/**
 * Ensure an identifier is a valid UUIDv7 for `session/start`.
 * - Already UUIDv7 -> returned unchanged.
 * - Legacy UUID (e.g. UUIDv4 from before MSP) or arbitrary string -> deterministically mapped to a valid UUIDv7
 *   so repeated runs against the same pclaw worker id land on the same Muse session.
 */
export function toMuseSessionId(id: string): string {
	if (UUIDV7_RE.test(id)) return id.toLowerCase();
	const bytes = UUID_ANY_RE.test(id)
		? Buffer.from(id.replace(/-/g, ""), "hex")
		: createHash("sha256").update(id).digest().subarray(0, 16);
	const copy = Buffer.from(bytes);
	copy[6] = (copy[6]! & 0x0f) | 0x70;
	copy[8] = (copy[8]! & 0x3f) | 0x80;
	const hex = copy.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeReasoningEffort(effort: string | undefined): string | undefined {
	if (effort === undefined || effort === "") return undefined;
	const mapped = effort === "off" ? "none" : effort;
	return VALID_EFFORTS.has(mapped) ? mapped : undefined;
}

/** Prefix printed by remote SSH wrapper before `exec muse serve` to report the resolved absolute `$PWD`. */
export const PCLAW_PWD_PREFIX = "__PCLAW_PWD__=";

export type LiveWorkerHandle = {
	/** Steer the running worker mid-turn (`turn/steer`), falling back to `turn/start` (`ifBusy: "queue"`) if the turn just changed/ended. */
	steer(message: string, effort?: string): Promise<{ disposition: "steered" | "queued" | "started"; turnId: string }>;
	/** Queue a follow-up turn to run immediately after the current turn finishes (`turn/start` with `ifBusy: "queue"`). */
	queue(message: string, effort?: string): Promise<{ disposition: "queued" | "started"; turnId: string }>;
	/** Cleanly interrupt the current turn (`turn/interrupt`) and stop the worker. */
	interrupt(): Promise<void>;
};

export type MuseMspRunOptions = {
	/** Spawn `muse serve` (local or via SSH) with `stdio: ["pipe", "pipe", "pipe"]`. */
	spawnProcess: () => ChildProcessWithoutNullStreams;
	/** Worker session UUID (reused across turns). */
	sessionId: string;
	/** Absolute workspace path, or omitted when SSH prelude provides `__PCLAW_PWD__=<path>`. */
	workspaceRoot?: string;
	/** Model id for `session/start` / `session/resume`. */
	model: string;
	/** Reasoning effort (`"off"` maps to `"none"`). */
	effort: string;
	/** Prompt text for the initial turn (including preamble on first turn). */
	prompt: string;
	/** Local JSONL transcript path where MSP notifications are appended. */
	transcript: string;
	/** When true, tries `session/resume` first before falling back to `session/start`. */
	resume: boolean;
	/** Hard timeout in milliseconds. */
	timeoutMs: number;
	/** Abort signal (e.g. Pi Durable task abort). */
	signal?: AbortSignal;
	/** Called as soon as the session is open and the initial turn is accepted. */
	onHandle?: (handle: LiveWorkerHandle) => void;
	/** Human-readable process label for startup failure messages. */
	label?: string;
	/** Grace window (ms) to wait for a `pure_followup` successor turn after an unconsumed `turn/steer` (default 5000). */
	steerGraceMs?: number;
	/** Wait before the one retry when the process exits 255 (ssh's own failure) before `initialize` answers (default 1000). */
	preInitRetryDelayMs?: number;
};

/** What a run's report may hold before workers clip it (their REPORT_LIMIT is 12,000): the newest answer comes first. */
export const MSP_REPORT_BUDGET = 11_500;
/** Each earlier turn's share of the report, when there's room for it at all. */
const EARLIER_TURN_LIMIT = 600;

/**
 * One report from every turn of a run. A steer or queued follow-up supersedes what came before, so the last answer
 * leads, whole, and earlier answers follow only as brief context while they fit: they can never push it past the clip.
 */
export function reportFromTurns(outputs: readonly string[], budget = MSP_REPORT_BUDGET): string {
	const final = outputs.at(-1) ?? "";
	const earlier = outputs.slice(0, -1);
	if (earlier.length === 0) return final;
	const heading = "\n\n---\n\nEarlier in this run, before later messages changed the ask:";
	let room = budget - final.length - heading.length;
	const kept: string[] = [];
	for (let index = earlier.length - 1; index >= 0 && room > 0; index--) {
		const text = earlier[index]!;
		const brief = text.length > EARLIER_TURN_LIMIT ? `${text.slice(0, EARLIER_TURN_LIMIT - 1)}…` : text;
		const piece = `\n\n${brief}`;
		if (piece.length > room) break;
		kept.unshift(piece);
		room -= piece.length;
	}
	return kept.length === 0 ? final : `${final}${heading}${kept.join("")}`;
}

/**
 * Run one Muse worker execution over `muse serve` (MSP v1 JSON-RPC over stdio). If the process exits 255 before
 * `initialize` answers (for ssh, it never reached the VM, or dropped before any turn), nothing ran yet, so it's
 * retried once after a short wait. Never after a turn started.
 */
export async function runMuseMsp(options: MuseMspRunOptions): Promise<{ ok: boolean; output: string }> {
	const first = await runMuseMspOnce(options);
	if (first.preInitExit !== 255 || options.signal?.aborted) return { ok: first.ok, output: first.output };
	console.warn(`[pclaw] ${options.label ?? "muse serve"} exited 255 before the session opened; retrying once`);
	try {
		await sleep(options.preInitRetryDelayMs ?? 1_000, undefined, options.signal === undefined ? undefined : { signal: options.signal });
	} catch {
		throw options.signal?.reason ?? new Error("Aborted");
	}
	const second = await runMuseMspOnce(options);
	return { ok: second.ok, output: second.output };
}

type JsonRpcErrorObj = {
	code: number;
	message: string;
	data?: Record<string, unknown>;
};

type JsonRpcMessage = {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: JsonRpcErrorObj;
};

export class MspRpcError extends Error {
	readonly code: number;
	readonly method: string;
	readonly data?: Record<string, unknown>;

	constructor(method: string, error: JsonRpcErrorObj) {
		super(`MSP ${method} failed (${error.code}): ${error.message}`);
		this.name = "MspRpcError";
		this.code = error.code;
		this.method = method;
		if (error.data !== undefined) this.data = error.data;
	}
}

export class WorkerRunEndedError extends Error {
	constructor() {
		super("Worker run already finished.");
		this.name = "WorkerRunEndedError";
	}
}

type ApprovalChoice = {
	choiceId: string;
	decision: string;
	label?: string;
};

type MspItem = {
	itemId?: string;
	commandId?: string;
	kind?: string;
	turnId?: string | null;
	status?: string;
	text?: string;
	messagePhase?: string;
	tool?: string;
	args?: string;
	visibleOutput?: string;
	failureReason?: string;
	steered?: boolean;
};

const PERSISTED_ITEM_KINDS = new Set(["userMessage", "agentMessage", "toolCall", "reasoning", "webSearch", "userShell"]);

function shouldPersistNotification(method: string, params: Record<string, unknown> | undefined): boolean {
	if (method === "turn/started" || method === "turn/completed") return true;
	const item = params?.item as MspItem | undefined;
	if (item === undefined || typeof item.kind !== "string") return false;
	if (method === "item/completed") return PERSISTED_ITEM_KINDS.has(item.kind);
	if (method === "item/started" || method === "item/updated") return item.kind === "toolCall";
	return false;
}

function isSessionNotFound(error: unknown): boolean {
	if (!(error instanceof MspRpcError)) return false;
	return error.code === -32020 || error.data?.kind === "sessionNotFound" || /not found/i.test(error.message);
}

function isSessionConflict(error: unknown): boolean {
	if (!(error instanceof MspRpcError)) return false;
	return (
		error.data?.reason === "session_id_conflict" ||
		/session_id_conflict|already exists/i.test(error.message)
	);
}

function pickApprovalChoice(choices: readonly ApprovalChoice[]): ApprovalChoice | undefined {
	return (
		choices.find((choice) => choice.decision === "approvedForSession") ??
		choices.find((choice) => choice.decision === "approved") ??
		choices[0]
	);
}

function formatTurnError(params: Record<string, unknown>): string {
	const terminal = typeof params.terminal === "string" ? params.terminal : "ended";
	const err = params.error as { kind?: string; message?: string } | undefined;
	const reason = typeof params.reason === "string" ? params.reason : undefined;
	const detail = err?.message ?? reason;
	return `Muse run ${terminal}${detail ? `: ${detail}` : ""}`;
}

type OnceResult = { ok: boolean; output: string; preInitExit?: number | null };

/**
 * One attempt: keeps the server alive while turns (initial + any live steered or queued turns) run,
 * logs MSP notifications to `transcript`, and tears down cleanly when all turns finish.
 */
async function runMuseMspOnce(options: MuseMspRunOptions): Promise<OnceResult> {
	if (options.signal?.aborted) throw options.signal.reason;

	const child = options.spawnProcess();
	const label = options.label ?? "muse serve";
	const transcript = options.transcript;
	const mspSessionId = toMuseSessionId(options.sessionId);
	const steerGraceMs = options.steerGraceMs ?? 5_000;

	let nextId = 1;
	const pending = new Map<
		number,
		{
			method: string;
			resolve: (result: Record<string, unknown>) => void;
			reject: (error: Error) => void;
			timer?: NodeJS.Timeout;
		}
	>();

	let stdoutBuf = "";
	let stderr = "";
	let resolvedWorkspaceRoot = options.workspaceRoot;
	let sessionIdOnWire = mspSessionId;
	let activeTurnId: string | undefined;
	const outstandingTurns = new Set<string>();
	/** Accepted `turn/steer` commandIds not yet observed as consumed (either in-turn `userMessage` or `pure_followup` `turn/started`). */
	const pendingSteers = new Set<string>();
	let steerGraceTimer: NodeJS.Timeout | undefined;
	const turnOrder: string[] = [];
	const turnTerminals = new Map<string, { terminal: string; errorText?: string }>();
	const turnAgentMessages = new Map<string, { itemId: string; phase?: string; text: string }[]>();
	const itemDeltaText = new Map<string, { turnId?: string; phase?: string; text: string }>();

	let inFlightControl = 0;
	let closing = false;
	let closed = false;
	let timedOut = false;
	let aborted = false;
	let interruptedByUser = false;
	let spawnFailed: Error | undefined;
	/** `initialize` answered: from here on the session may have started work, so a failure is never retried. */
	let initialized = false;

	let settleRun!: (value: OnceResult) => void;
	let failRun!: (error: unknown) => void;
	const donePromise = new Promise<OnceResult>((resolve, reject) => {
		settleRun = resolve;
		failRun = reject;
	});
	// Prevent unhandled rejection if startup fails before we await donePromise.
	donePromise.catch(() => undefined);

	let settled = false;
	const timers = new Set<NodeJS.Timeout>();
	const trackTimer = (timer: NodeJS.Timeout): NodeJS.Timeout => {
		timer.unref();
		timers.add(timer);
		return timer;
	};
	const clearTimers = () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		steerGraceTimer = undefined;
	};
	const clearSteerGraceTimer = () => {
		if (steerGraceTimer === undefined) return;
		clearTimeout(steerGraceTimer);
		timers.delete(steerGraceTimer);
		steerGraceTimer = undefined;
	};

	const rejectAllPending = (reason: Error) => {
		for (const [id, entry] of pending) {
			if (entry.timer !== undefined) clearTimeout(entry.timer);
			pending.delete(id);
			entry.reject(reason);
		}
	};

	const writeJson = (payload: Record<string, unknown>): boolean => {
		if (closed || child.stdin.destroyed || !child.stdin.writable) return false;
		try {
			child.stdin.write(`${JSON.stringify(payload)}\n`);
			return true;
		} catch {
			return false;
		}
	};

	const request = <T extends Record<string, unknown> = Record<string, unknown>>(
		method: string,
		params?: Record<string, unknown>,
		timeoutMs = 30_000,
	): Promise<T> => {
		if (closed) return Promise.reject(new Error(`MSP connection closed before ${method}.`));
		const id = nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = trackTimer(
				setTimeout(() => {
					pending.delete(id);
					reject(new Error(`MSP ${method} timed out after ${timeoutMs}ms.`));
				}, timeoutMs),
			);
			pending.set(id, {
				method,
				resolve: (res) => resolve(res as T),
				reject,
				timer,
			});
			const ok = writeJson({
				jsonrpc: "2.0",
				id,
				method,
				...(params === undefined ? {} : { params }),
			});
			if (!ok) {
				clearTimeout(timer);
				timers.delete(timer);
				pending.delete(id);
				reject(new Error(`Failed to write MSP ${method} to stdin.`));
			}
		});
	};

	const notify = (method: string, params?: Record<string, unknown>): void => {
		writeJson({
			jsonrpc: "2.0",
			method,
			...(params === undefined ? {} : { params }),
		});
	};

	const respond = (id: number | string, result: Record<string, unknown>): void => {
		writeJson({ jsonrpc: "2.0", id, result });
	};

	const respondError = (id: number | string, code: number, message: string): void => {
		writeJson({ jsonrpc: "2.0", id, error: { code, message } });
	};

	const appendTranscript = (method: string, params: Record<string, unknown> | undefined) => {
		if (!shouldPersistNotification(method, params)) return;
		try {
			appendFileSync(
				transcript,
				`${JSON.stringify({ received_at: Date.now(), method, ...(params === undefined ? {} : { params }) })}\n`,
				{ mode: 0o600 },
			);
		} catch (error) {
			console.error(`[pclaw] failed writing Muse MSP transcript: ${error instanceof Error ? error.message : error}`);
		}
	};

	const bestOutputForTurn = (turnId: string): string => {
		const completed = turnAgentMessages.get(turnId) ?? [];
		const finals = completed.filter((msg) => msg.phase === "finalAnswer" && msg.text.trim() !== "");
		if (finals.length > 0) return finals.at(-1)!.text.trim();
		const nonEmpty = completed.filter((msg) => msg.text.trim() !== "");
		if (nonEmpty.length > 0) return nonEmpty.at(-1)!.text.trim();
		// Fallback to accumulated deltas for this turn if item/completed omitted text.
		let deltaFallback = "";
		for (const entry of itemDeltaText.values()) {
			if (entry.turnId === turnId && entry.text.trim() !== "") deltaFallback = entry.text.trim();
		}
		return deltaFallback;
	};

	const computeOutcome = (): { ok: boolean; output: string } | undefined => {
		if (turnOrder.length === 0) return undefined;
		let lastTurnId = turnOrder.at(-1)!;
		let lastTerminal = turnTerminals.get(lastTurnId);
		if (lastTerminal === undefined && closing) {
			// If a late notification raced after shutdown began, fall back to the last turn that actually settled.
			for (let i = turnOrder.length - 1; i >= 0; i--) {
				const candidate = turnOrder[i]!;
				const term = turnTerminals.get(candidate);
				if (term !== undefined) {
					lastTurnId = candidate;
					lastTerminal = term;
					break;
				}
			}
		}
		if (lastTerminal === undefined) return undefined;

		const outputs = turnOrder
			.filter((tid) => turnTerminals.has(tid))
			.map((tid) => bestOutputForTurn(tid))
			.filter((text) => text !== "");
		const combinedText = reportFromTurns(outputs);

		// If any turn failed (and wasn't superseded by a later completed turn), report failure.
		if (lastTerminal.terminal === "completed") {
			return { ok: true, output: combinedText || "(the worker finished without saying anything)" };
		}
		const base = lastTerminal.errorText ?? `Muse run ${lastTerminal.terminal}`;
		return { ok: false, output: combinedText ? `${base}\n${combinedText}` : base };
	};

	const terminateChild = () => {
		if (closed) return;
		try {
			if (!child.stdin.destroyed) child.stdin.end();
		} catch {}
		trackTimer(
			setTimeout(() => {
				if (!closed) {
					try {
						child.kill("SIGTERM");
					} catch {}
				}
			}, 250),
		);
		trackTimer(
			setTimeout(() => {
				if (!closed) {
					try {
						child.kill("SIGKILL");
					} catch {}
				}
			}, 2_250),
		);
	};

	const finishIfDrained = () => {
		if (closing || settled) return;
		if (outstandingTurns.size > 0 || inFlightControl > 0) {
			clearSteerGraceTimer();
			return;
		}
		if (pendingSteers.size > 0) {
			// When `turn/steer` arrives after T1's final model step starts, Muse lets T1 emit `turn/completed`
			// without consuming the steer, then spawns a `pure_followup` successor turn (~25ms later) whose
			// `turnId` equals the steer's `commandId`. Wait briefly for that successor turn before leaving.
			if (steerGraceTimer === undefined) {
				steerGraceTimer = trackTimer(
					setTimeout(() => {
						steerGraceTimer = undefined;
						pendingSteers.clear();
						finishIfDrained();
					}, steerGraceMs),
				);
			}
			return;
		}
		clearSteerGraceTimer();
		closing = true;
		void (async () => {
			try {
				await request("session/leave", { commandId: uuidv7(), sessionId: sessionIdOnWire }, 1_500);
			} catch {
				// Best-effort lease release before shutdown.
			}
			terminateChild();
		})();
	};

	const consumePendingSteer = (commandId: string | undefined, fallbackOldest = false) => {
		if (commandId !== undefined && pendingSteers.delete(commandId)) {
			return true;
		}
		if (fallbackOldest && pendingSteers.size > 0) {
			const oldest = pendingSteers.values().next().value;
			if (oldest !== undefined) {
				pendingSteers.delete(oldest);
				return true;
			}
		}
		return false;
	};

	const handleNotification = (method: string, params: Record<string, unknown> | undefined) => {
		appendTranscript(method, params);
		if (params === undefined) return;

		if (method === "turn/started") {
			if (closing) return;
			const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
			const commandId = typeof params.commandId === "string" ? params.commandId : undefined;
			clearSteerGraceTimer();
			if (commandId !== undefined) pendingSteers.delete(commandId);
			if (turnId !== undefined) {
				pendingSteers.delete(turnId);
				activeTurnId = turnId;
				outstandingTurns.add(turnId);
				if (!turnOrder.includes(turnId)) turnOrder.push(turnId);
			}
			return;
		}

		if (method === "item/started") {
			const item = params.item as MspItem | undefined;
			if (item?.kind === "agentMessage" && typeof item.itemId === "string") {
				itemDeltaText.set(item.itemId, {
					...(typeof item.turnId === "string" ? { turnId: item.turnId } : {}),
					...(typeof item.messagePhase === "string" ? { phase: item.messagePhase } : {}),
					text: typeof item.text === "string" ? item.text : "",
				});
			}
			return;
		}

		if (method === "item/delta") {
			const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
			const field = typeof params.field === "string" ? params.field : "text";
			const delta = typeof params.delta === "string" ? params.delta : "";
			if (itemId !== undefined && field === "text" && delta !== "") {
				const existing = itemDeltaText.get(itemId);
				if (existing !== undefined) existing.text += delta;
			}
			return;
		}

		if (method === "item/completed") {
			const item = params.item as MspItem | undefined;
			if (item?.kind === "userMessage") {
				const cmdId = typeof item.commandId === "string" ? item.commandId : undefined;
				if (item.steered === true || (cmdId !== undefined && pendingSteers.has(cmdId))) {
					const removed = consumePendingSteer(cmdId, item.steered === true && cmdId === undefined);
					if (removed && outstandingTurns.size === 0 && inFlightControl === 0) finishIfDrained();
				}
				return;
			}
			if (item?.kind === "agentMessage" && typeof item.itemId === "string") {
				const turnId =
					typeof item.turnId === "string"
						? item.turnId
						: (itemDeltaText.get(item.itemId)?.turnId ?? activeTurnId);
				const text =
					typeof item.text === "string" && item.text.length > 0
						? item.text
						: (itemDeltaText.get(item.itemId)?.text ?? "");
				if (turnId !== undefined) {
					const list = turnAgentMessages.get(turnId) ?? [];
					const idx = list.findIndex((entry) => entry.itemId === item.itemId);
					const record = {
						itemId: item.itemId,
						...(typeof item.messagePhase === "string" ? { phase: item.messagePhase } : {}),
						text,
					};
					if (idx >= 0) list[idx] = record;
					else list.push(record);
					turnAgentMessages.set(turnId, list);
				}
			}
			return;
		}

		if (method === "turn/unqueued") {
			const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
			if (turnId !== undefined) {
				pendingSteers.delete(turnId);
				outstandingTurns.delete(turnId);
				finishIfDrained();
			}
			return;
		}

		if (method === "turn/completed") {
			const turnId = typeof params.turnId === "string" ? params.turnId : activeTurnId;
			const terminal = typeof params.terminal === "string" ? params.terminal : "completed";
			if (turnId !== undefined) {
				if (!turnOrder.includes(turnId)) turnOrder.push(turnId);
				turnTerminals.set(turnId, {
					terminal,
					...(terminal === "completed" ? {} : { errorText: formatTurnError(params) }),
				});
				outstandingTurns.delete(turnId);
				if (activeTurnId === turnId) activeTurnId = undefined;
			}
			finishIfDrained();
		}
	};

	const handleServerRequest = (id: number | string, method: string, params: Record<string, unknown> | undefined) => {
		if (method === "approval/request") {
			respond(id, {});
			const approvalId = typeof params?.approvalId === "string" ? params.approvalId : undefined;
			const requirementId = typeof params?.currentRequirementId === "string" ? params.currentRequirementId : undefined;
			const sessionId = typeof params?.sessionId === "string" ? params.sessionId : sessionIdOnWire;
			const choices = Array.isArray(params?.availableChoices) ? (params.availableChoices as ApprovalChoice[]) : [];
			const picked = pickApprovalChoice(choices);
			if (approvalId !== undefined && requirementId !== undefined && picked !== undefined) {
				void request("approval/decide", {
					commandId: uuidv7(),
					sessionId,
					approvalId,
					requirementId,
					choiceId: picked.choiceId,
				}).catch((error: unknown) => {
					console.error(`[pclaw] MSP approval/decide failed: ${error instanceof Error ? error.message : error}`);
				});
			}
			return;
		}
		if (method === "userInput/request") {
			respond(id, {});
			console.warn("[pclaw] Muse worker emitted userInput/request in headless mode.");
			return;
		}
		respondError(id, -32601, `Unsupported client request: ${method}`);
	};

	const handleLine = (rawLine: string) => {
		const line = rawLine.trim();
		if (line === "") return;
		if (line.startsWith(PCLAW_PWD_PREFIX)) {
			const pwd = line.slice(PCLAW_PWD_PREFIX.length).trim();
			if (pwd !== "") resolvedWorkspaceRoot = pwd;
			return;
		}
		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse(line) as JsonRpcMessage;
		} catch {
			return;
		}
		// Response to our client request
		if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
			const entry = pending.get(Number(msg.id));
			if (entry === undefined) return;
			pending.delete(Number(msg.id));
			if (entry.timer !== undefined) {
				clearTimeout(entry.timer);
				timers.delete(entry.timer);
			}
			if (msg.error !== undefined) {
				entry.reject(new MspRpcError(entry.method, msg.error));
			} else {
				entry.resolve(msg.result ?? {});
			}
			return;
		}
		// Server-initiated request
		if (msg.id !== undefined && msg.id !== null && msg.method !== undefined) {
			handleServerRequest(msg.id, msg.method, msg.params);
			return;
		}
		// Notification
		if (msg.method !== undefined) {
			handleNotification(msg.method, msg.params);
		}
	};

	child.stdout.on("data", (chunk: Buffer) => {
		stdoutBuf += chunk.toString("utf8");
		let nl: number;
		while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
			const line = stdoutBuf.slice(0, nl);
			stdoutBuf = stdoutBuf.slice(nl + 1);
			handleLine(line);
		}
	});

	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});

	child.stdin.on("error", () => {
		// EPIPE on early exit; handled by close/error.
	});

	const sendInterruptAndKill = async () => {
		if (closed) return;
		closing = true;
		clearSteerGraceTimer();
		pendingSteers.clear();
		try {
			await request(
				"turn/interrupt",
				{
					commandId: uuidv7(),
					sessionId: sessionIdOnWire,
					...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
				},
				2_000,
			);
		} catch {
			// Best-effort interrupt.
		}
		terminateChild();
	};

	const onAbort = () => {
		aborted = true;
		void sendInterruptAndKill();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const hardTimeout = trackTimer(
		setTimeout(() => {
			timedOut = true;
			void sendInterruptAndKill();
		}, options.timeoutMs),
	);

	const cleanupListeners = () => {
		clearTimeout(hardTimeout);
		clearTimers();
		options.signal?.removeEventListener("abort", onAbort);
	};

	child.on("error", (error) => {
		spawnFailed = error;
		closed = true;
		cleanupListeners();
		rejectAllPending(error);
		if (settled) return;
		settled = true;
		if (aborted || options.signal?.aborted) {
			failRun(options.signal?.reason ?? error);
		} else {
			settleRun({ ok: false, output: `Couldn't start ${label}: ${error.message}` });
		}
	});

	child.on("close", (code) => {
		if (stdoutBuf.trim() !== "") {
			handleLine(stdoutBuf);
			stdoutBuf = "";
		}
		closed = true;
		cleanupListeners();
		rejectAllPending(new Error(`MSP process exited with code ${code ?? "null"}.`));
		if (settled) return;
		settled = true;
		if (aborted || options.signal?.aborted) {
			failRun(options.signal?.reason ?? new Error("Aborted"));
			return;
		}
		if (timedOut) {
			settleRun({ ok: false, output: `Timed out after ${options.timeoutMs / 60_000} minutes.` });
			return;
		}
		const outcome = computeOutcome();
		if (outcome !== undefined) {
			settleRun(outcome);
			return;
		}
		if (interruptedByUser) {
			settleRun({ ok: false, output: "Muse run cancelled." });
			return;
		}
		const errors = stderr
			.split("\n")
			.filter((line) => line.trim() !== "" && !line.startsWith("muse: ") && !line.startsWith("muse serve:"))
			.join("\n");
		settleRun({
			ok: false,
			output: `exit ${code}\n${errors || "Muse ended without a result."}`,
			...(initialized ? {} : { preInitExit: code }),
		});
	});

	const enqueueTurn = async (
		message: string,
		effort?: string,
	): Promise<{ disposition: "queued" | "started"; turnId: string }> => {
		if (closing || closed) throw new WorkerRunEndedError();
		inFlightControl++;
		try {
			if (closing || closed) throw new WorkerRunEndedError();
			const eff = normalizeReasoningEffort(effort);
			const res = await request<{ turnId?: string; disposition?: string }>("turn/start", {
				commandId: uuidv7(),
				sessionId: sessionIdOnWire,
				input: [{ type: "text", text: `Message from pclaw:\n\n${message}` }],
				ifBusy: "queue",
				...(eff === undefined ? {} : { reasoningEffort: eff }),
			});
			const turnId = typeof res.turnId === "string" ? res.turnId : uuidv7();
			outstandingTurns.add(turnId);
			if (!turnOrder.includes(turnId)) turnOrder.push(turnId);
			if (res.disposition === "started") activeTurnId = turnId;
			return {
				disposition: res.disposition === "started" ? "started" : "queued",
				turnId,
			};
		} finally {
			inFlightControl--;
			finishIfDrained();
		}
	};

	const handle: LiveWorkerHandle = {
		async steer(message, effort) {
			if (closing || closed) throw new WorkerRunEndedError();
			inFlightControl++;
			let shouldFallbackToQueue = false;
			try {
				if (closing || closed) throw new WorkerRunEndedError();
				const eff = normalizeReasoningEffort(effort);
				const expected = activeTurnId;
				if (expected !== undefined) {
					const steerCommandId = uuidv7();
					pendingSteers.add(steerCommandId);
					try {
						const res = await request<{ turnId?: string }>("turn/steer", {
							commandId: steerCommandId,
							sessionId: sessionIdOnWire,
							expectedTurnId: expected,
							input: [{ type: "text", text: `Message from pclaw:\n\n${message}` }],
							...(eff === undefined ? {} : { reasoningEffort: eff }),
						});
						const turnId = typeof res.turnId === "string" ? res.turnId : expected;
						if (!turnTerminals.has(turnId)) outstandingTurns.add(turnId);
						return { disposition: "steered", turnId };
					} catch (error) {
						pendingSteers.delete(steerCommandId);
						if (closing || closed) throw new WorkerRunEndedError();
						// Expected turn likely just completed or changed: fall back cleanly to turn/start(ifBusy:"queue").
						if (!(error instanceof MspRpcError)) throw error;
						shouldFallbackToQueue = true;
					}
				} else {
					shouldFallbackToQueue = true;
				}
			} finally {
				inFlightControl--;
				if (!shouldFallbackToQueue) finishIfDrained();
			}
			return enqueueTurn(message, effort);
		},
		queue(message, effort) {
			return enqueueTurn(message, effort);
		},
		async interrupt() {
			interruptedByUser = true;
			await sendInterruptAndKill();
		},
	};

	try {
		await request("initialize", {
			clientInfo: { name: "pclaw", title: "pclaw", version: "0.1.0" },
		});
		initialized = true;
		notify("initialized");

		const ensureAllowAll = async (sessionResult: Record<string, unknown>) => {
			const sess = sessionResult.session as { approvalMode?: { mode?: string } } | undefined;
			if (sess?.approvalMode?.mode !== "allowAll") {
				await request("session/setApprovalMode", {
					commandId: uuidv7(),
					sessionId: sessionIdOnWire,
					mode: "allowAll",
				});
			}
		};

		const startFresh = async () => {
			sessionIdOnWire = mspSessionId;
			return request("session/start", {
				commandId: uuidv7(),
				sessionId: sessionIdOnWire,
				...(resolvedWorkspaceRoot === undefined ? {} : { workspaceRoot: resolvedWorkspaceRoot }),
				modelId: options.model,
				approvalMode: "allowAll",
			});
		};

		const resumeExisting = async (id: string) => {
			sessionIdOnWire = id;
			const resumed = await request("session/resume", {
				commandId: uuidv7(),
				sessionId: sessionIdOnWire,
				excludeItems: true,
				modelId: options.model,
			});
			await ensureAllowAll(resumed);
			return resumed;
		};

		if (options.resume) {
			try {
				await resumeExisting(mspSessionId);
			} catch (error) {
				if (isSessionNotFound(error) && options.sessionId !== mspSessionId) {
					// Legacy pre-MSP UUIDv4 session on disk: try resuming with the raw sessionId before starting fresh.
					try {
						await resumeExisting(options.sessionId);
					} catch (legacyErr) {
						if (!isSessionNotFound(legacyErr)) throw legacyErr;
						await startFresh();
					}
				} else if (isSessionNotFound(error)) {
					await startFresh();
				} else {
					throw error;
				}
			}
		} else {
			try {
				await startFresh();
			} catch (error) {
				if (isSessionConflict(error)) {
					await resumeExisting(mspSessionId);
				} else {
					throw error;
				}
			}
		}

		const reasoningEffort = normalizeReasoningEffort(options.effort);
		const started = await request<{ turnId?: string; disposition?: string }>("turn/start", {
			commandId: uuidv7(),
			sessionId: sessionIdOnWire,
			input: [{ type: "text", text: options.prompt }],
			...(reasoningEffort === undefined ? {} : { reasoningEffort }),
		});
		const turnId = typeof started.turnId === "string" ? started.turnId : uuidv7();
		outstandingTurns.add(turnId);
		if (!turnOrder.includes(turnId)) turnOrder.push(turnId);
		if (started.disposition === "started") activeTurnId = turnId;

		options.onHandle?.(handle);
		// In case the turn completed synchronously during turn/start response processing.
		finishIfDrained();
	} catch (error) {
		if (spawnFailed !== undefined) return donePromise;
		if (aborted || options.signal?.aborted) throw options.signal?.reason ?? error;
		terminateChild();
		if (!settled) {
			settled = true;
			const msg = error instanceof Error ? error.message : String(error);
			settleRun({ ok: false, output: msg });
		}
	}

	return donePromise;
}
