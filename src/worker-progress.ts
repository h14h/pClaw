import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Agent } from "./agent.ts";
import type { Config } from "./config.ts";
import type { WorkerItem } from "./dashboard/types.ts";
import { type Decisions, progressGuidance, progressQuestions, yes } from "./decisions.ts";
import { describeActivity } from "./extensions/jobs.ts";
import { Workers } from "./extensions/workers.ts";
import { type PromptResolver, readPrompt } from "./prompts.ts";

const SECRETS = /(password|passwd|token|secret|api[_-]?key|authorization)/i;
const DEFAULT_QUIET_CONFIRM_MS = 105_000;

export type WorkerProgressUpdateEvent = {
	address: string;
	workerName: string;
	sessionId: string;
	message: string;
	status?: string;
};

export type WorkerProgressFinishEvent = {
	address: string;
	workerName: string;
	sessionId: string;
	ok: boolean;
};

export type WorkerProgressSurface = {
	update(event: WorkerProgressUpdateEvent): Promise<void>;
	finish?(event: WorkerProgressFinishEvent): Promise<void>;
};

/** Registry of per-channel live worker progress surfaces (e.g. Telegram ephemeral DM bubbles). */
export class ProgressSurfaces {
	readonly #surfaces = new Map<string, WorkerProgressSurface>();

	register(channel: string, surface: WorkerProgressSurface): () => void {
		this.#surfaces.set(channel, surface);
		return () => {
			if (this.#surfaces.get(channel) === surface) this.#surfaces.delete(channel);
		};
	}

	get(channel: string): WorkerProgressSurface | undefined {
		return this.#surfaces.get(channel);
	}
}

export function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (totalMin < 60) return `${totalMin}m ${sec}s`;
	const hours = Math.floor(totalMin / 60);
	const min = totalMin % 60;
	return `${hours}h ${String(min).padStart(2, "0")}m`;
}

function formatToolAction(item: Extract<WorkerItem, { kind: "tool" }>): string {
	const args = item.args;
	let argText: string | undefined;
	if (args !== null && typeof args === "object") {
		const record = args as Record<string, unknown>;
		for (const key of ["query", "path", "file_path", "url", "command", "pattern"] as const) {
			const val = record[key];
			if (typeof val === "string" && val.trim() !== "") {
				argText = val.trim();
				break;
			}
		}
		if (argText === undefined) {
			for (const [key, val] of Object.entries(record)) {
				if (!SECRETS.test(key) && typeof val === "string" && val.trim() !== "") {
					argText = val.trim();
					break;
				}
			}
		}
	}
	if (argText === undefined || SECRETS.test(argText)) return item.name;
	const clean = argText.replace(/\s+/g, " ");
	const clipped = clean.length > 52 ? `${clean.slice(0, 51)}…` : clean;
	return /\s/.test(clipped) ? `${item.name} "${clipped}"` : `${item.name} ${clipped}`;
}

/**
 * Rich one-line progress summary for `list_workers`:
 * e.g. `4m 46s, 18 tool calls — latest: web_search "McPherson model", edit_file report.md`
 */
export function formatWorkerProgress(items: WorkerItem[], startedAt: number | undefined, now = Date.now()): string {
	const elapsed = startedAt === undefined ? undefined : formatElapsed(now - startedAt);
	const tools = items.filter((item): item is Extract<WorkerItem, { kind: "tool" }> => item.kind === "tool");
	if (tools.length === 0) {
		return elapsed === undefined ? "starting up" : `${elapsed}, starting up`;
	}
	const count = `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`;
	const latest = tools.slice(-2).map(formatToolAction).join(", ");
	const prefix = elapsed === undefined ? count : `${elapsed}, ${count}`;
	return `${prefix} — latest: ${latest}`;
}

const WORKER_PROGRESS_TASK = `Right now a background worker is partway through a task for the user. You'll get the task brief, elapsed time, what you already told them, and the newest worker activity. Reply with JSON only: {"status": "...", "message": "..." or null}.

- "status": a few plain words on where it stands, at most 80 characters.
- "message": one crisp, concrete line (at most 160 characters) strictly following your voice guide above — match its capitalization, grammar, and brevity (do not switch to lowercase if your voice uses normal capitalization). State what changed, what was found, or what stage is underway now. Never narrate raw tool names, file paths, shell commands, or secrets. Never repeat what you already said.
- Return null for "message" if nothing meaningful happened yet unless the prompt notes it has been quiet and asks for a brief confirmation that work is still moving.`;

/** Voice-compliant system prompt for live worker progress updates. */
export function workerProgressPrompt(prompts?: PromptResolver): string {
	return `${(prompts?.read("voice") ?? readPrompt("voice")).trim()}\n\n${WORKER_PROGRESS_TASK}`;
}

export async function generateWorkerProgressUpdate(options: {
	models: Models;
	config: Pick<Config, "provider" | "model">;
	prompts?: PromptResolver;
	workerName: string;
	brief: string;
	elapsedMs: number;
	told: string[];
	activity: string;
	hint?: string;
	quietConfirm?: boolean;
	signal?: AbortSignal;
}): Promise<{ status?: string; message?: string }> {
	try {
		const model = options.models.getModel(options.config.provider, options.config.model);
		if (model === undefined) throw new Error(`unknown model ${options.config.provider}/${options.config.model}`);
		const quietNote = options.quietConfirm
			? `Elapsed: ${formatElapsed(options.elapsedMs)}. It has been quiet for a while and the worker is actively progressing; send one short confirmation of what it's doing now.`
			: `Elapsed: ${formatElapsed(options.elapsedMs)}.`;
		const content = [
			`Task (${options.workerName}):\n${options.brief.slice(0, 800)}`,
			`Already told them: ${options.told.join(" / ") || "nothing"}`,
			quietNote,
			...(options.hint === undefined ? [] : [options.hint]),
			`Recent activity:\n${options.activity}`,
		].join("\n\n");
		const reply = await options.models.completeSimple(
			model,
			{
				systemPrompt: workerProgressPrompt(options.prompts),
				messages: [{ role: "user", content, timestamp: Date.now() }],
			},
			{ reasoning: "low", signal: options.signal ?? AbortSignal.timeout(30_000) },
		);
		const raw = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		const parsed = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "{}") as { status?: string; message?: string | null };
		const status = typeof parsed.status === "string" ? parsed.status.trim().slice(0, 120) : undefined;
		const message = typeof parsed.message === "string" ? parsed.message.trim().slice(0, 300) : undefined;
		return { ...(status ? { status } : {}), ...(message ? { message } : {}) };
	} catch (error) {
		console.error(`[pclaw] worker progress ${options.workerName}: ${error instanceof Error ? error.message : error}`);
		return {};
	}
}

type TrackedRun = {
	startedAt: number;
	lastCheckedAt: number;
	lastNoteAt?: number;
	position: number;
	told: string[];
};

export type WorkerProgressMonitorOptions = {
	models: Models;
	config: Config;
	decisions: Decisions;
	everyMs?: number;
	refreshMs?: number;
	firstUpdateMs?: number;
	quietConfirmMs?: number;
	now?: () => number;
};

/**
 * Decoupled periodic live worker progress monitor.
 * Runs independently of `allowT3` for any channel that registers a `WorkerProgressSurface`
 * (e.g. Telegram DMs with ephemeral delete-and-replace status bubbles), leaving Discord's
 * existing thread + card keeper untouched.
 */
export function startWorkerProgressMonitor(
	agent: Agent,
	options: WorkerProgressMonitorOptions,
	context: Context,
): { stop(): void; tick(): Promise<void> } {
	const everyMs = options.everyMs ?? Math.max(5, options.config.jobPollSeconds) * 1000;
	const refreshMs = options.refreshMs ?? Math.max(10, options.config.jobProgressSeconds) * 1000;
	const firstUpdateMs = options.firstUpdateMs ?? Math.min(refreshMs, 30_000);
	const quietConfirmMs = options.quietConfirmMs ?? DEFAULT_QUIET_CONFIRM_MS;
	const nowFn = options.now ?? Date.now;

	const tracked = new Map<string, TrackedRun>();
	let running = false;

	const tick = async () => {
		if (running) return;
		running = true;
		try {
			const now = nowFn();
			const activeKeys = new Set<string>();
			for (const [address, conversationId] of Object.entries(await agent.addresses(context))) {
				const channel = address.split(":")[0];
				if (channel === undefined) continue;
				const surface = agent.progressSurfaces.get(channel);
				if (surface === undefined) continue;

				const workersDoc = await agent.harness.snapshot(Workers, conversationId, context);
				for (const [name, worker] of Object.entries(workersDoc?.workers ?? {})) {
					if (worker.status !== "working") continue;
					const key = `${conversationId}:${name}:${worker.sessionId}`;
					activeKeys.add(key);

					let state = tracked.get(key);
					if (state === undefined) {
						state = {
							startedAt: worker.startedAt ?? now,
							lastCheckedAt: worker.startedAt ?? now,
							position: 0,
							told: [],
						};
						tracked.set(key, state);
					}

					const minWait = state.lastNoteAt === undefined ? firstUpdateMs : refreshMs;
					if (now - state.lastCheckedAt < minWait) continue;

					const items = agent.workerItems(worker.sessionId);
					const fresh = items.slice(state.position);
					const freshActivity = describeActivity(fresh);
					const quietAge = now - (state.lastNoteAt ?? state.startedAt);
					const quietDue = quietAge >= quietConfirmMs;

					if (freshActivity === "" && (!quietDue || items.length === 0)) {
						state.lastCheckedAt = now;
						continue;
					}

					const activity =
						freshActivity || describeActivity(items.slice(-4)) || formatWorkerProgress(items, state.startedAt, now);

					const decisionId = `worker-progress:${name}:${worker.sessionId}:${items.length}`;
					let hint: string | undefined;
					let milestone: number | undefined;
					let arm: string = "none";

					if (options.decisions.configured && freshActivity !== "") {
						const decided = await options.decisions.ask({
							id: decisionId,
							site: "progress",
							job: name,
							timeoutMs: 3_000,
							state: { recent_activity: freshActivity.slice(-1_500) },
							questions: progressQuestions,
						});
						if (decided !== undefined) {
							arm = decided.arm;
							milestone = yes(decided.answers.milestone);
							if (decided.arm === "guided") hint = progressGuidance(decided.answers);
							if (milestone < 0.5 && !quietDue) {
								state.position = items.length;
								state.lastCheckedAt = now;
								options.decisions.record({
									type: "progress",
									id: decisionId,
									job: name,
									arm,
									milestone,
									posted: false,
								});
								continue;
							}
						}
					}

					const { status, message } = await generateWorkerProgressUpdate({
						models: options.models,
						config: options.config,
						prompts: agent.prompts,
						workerName: name,
						brief: worker.brief,
						elapsedMs: now - state.startedAt,
						told: state.told,
						activity,
						...(hint === undefined ? {} : { hint }),
						quietConfirm: quietDue,
					});

					state.position = items.length;
					state.lastCheckedAt = now;
					let posted = false;
					if (message !== undefined && message !== "") {
						await surface
							.update({
								address,
								workerName: name,
								sessionId: worker.sessionId,
								message,
								...(status === undefined ? {} : { status }),
							})
							.catch((error: unknown) => console.error(`[pclaw] progress surface ${channel}/${name}`, error));
						state.lastNoteAt = now;
						state.told = [...state.told, message].slice(-5);
						posted = true;
					}
					options.decisions.record({
						type: "progress",
						id: decisionId,
						job: name,
						arm,
						...(milestone === undefined ? {} : { milestone }),
						quietConfirm: quietDue,
						posted,
					});
				}
			}

			for (const key of tracked.keys()) {
				if (!activeKeys.has(key)) tracked.delete(key);
			}
		} finally {
			running = false;
		}
	};

	const timer = setInterval(() => void tick().catch((error: unknown) => console.error("[pclaw] worker progress", error)), everyMs);
	return { stop: () => clearInterval(timer), tick };
}
