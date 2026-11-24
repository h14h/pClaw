import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { AssistantEntry, type ConversationId, type EntryRecord, UserEntry } from "@earendil-works/pi-durable";
import type { Agent } from "./agent.ts";
import type { Config } from "./config.ts";
import type { WorkerItem } from "./dashboard/types.ts";
import { type Decided, type Decisions, workerProgressGuidance, workerProgressQuestions, yes } from "./decisions.ts";
import { describeActivity } from "./extensions/jobs.ts";
import { type WorkerAside, type WorkerRecord, Workers } from "./extensions/workers.ts";
import { type PromptResolver, readPrompt } from "./prompts.ts";

const SECRETS = /(password|passwd|token|secret|api[_-]?key|authorization)/i;
const DEFAULT_QUIET_CONFIRM_MS = 105_000;
/** After this many posted progress updates in one worker run, widen spacing to avoid chatter on long runs. */
export const DEFAULT_BACKOFF_AFTER_UPDATES = 2;
/** Widened minimum spacing between normal progress updates after `DEFAULT_BACKOFF_AFTER_UPDATES` updates. */
export const DEFAULT_BACKOFF_REFRESH_MS = 120_000;
/** No new worker activity for this long is a stall worth interrupting a side conversation for. */
export const STALL_MS = 180_000;
/** Activity that's worth breaking into a side conversation for: a failure, a snag, a retry, a blocker, a pivot. */
const INTERRUPT_WORTHY =
	/(^|\n)failed |\b(error|errors|failed|failure|fails|retry|retrying|retried|workaround|not found|no such file|missing|blocked|denied|forbidden|unauthorized|timed out|timeout|cannot|can't|couldn't|unable|exception|traceback|crash(ed)?|pivot(ing)?|switching approach|giving up)\b/i;

export type WorkerProgressUpdateEvent = {
	address: string;
	workerName: string;
	sessionId: string;
	message: string;
	status?: string;
	/** The person's message the work answers ("telegram:<id>"), for quoting once the chat has moved on. */
	replyTo?: string;
	/** Post without a notification: they're mid-conversation about something else. */
	silent?: boolean;
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

const WORKER_PROGRESS_TASK = `Right now you're partway through a task for the user, working on it in the background while you keep talking with them. You'll get the task brief, elapsed time, what you already told them, and your newest activity on it. Reply with JSON only: {"status": "...", "message": "..." or null}.

- "status": a few plain words on where it stands, at most 80 characters.
- "message": one crisp, concrete line (at most 160 characters) strictly following your voice guide above — match its capitalization, grammar, and brevity (do not switch to lowercase if your voice uses normal capitalization). State what changed, what you found, or what you're on now. Never repeat what you already said.
- You are one assistant doing several things at once: speak in the first person ("I'm checking…", "Still comparing shorter frames…", "I looked at the photo…"). Never mention a worker, background worker, agent, subagent, delegating, your inbox, context, memory, or compaction, and never name tools, files, paths, shell commands, or secrets.
- Return null for "message" if nothing meaningful happened yet unless the prompt notes it has been quiet and asks for a brief confirmation that work is still moving.`;

/** Whether fresh worker activity is worth interrupting a side conversation for. */
export function interruptWorthy(activity: string): boolean {
	return INTERRUPT_WORTHY.test(activity);
}

/** The person chatting about something else while a worker runs. */
export type SideChat = {
	/** How long ago they last wrote. */
	lastUserAgoMs: number;
	/** The last few turns of the conversation, oldest first, clipped. */
	recent: string[];
	/** Their messages about something else since this work was last on topic. */
	count?: number;
	/** Short previews of those, oldest first. */
	previews?: string[];
};

function entryText(entry: EntryRecord): string {
	const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

function entryTime(entry: EntryRecord): number | undefined {
	const timestamp = (entry.model?.[0] as { timestamp?: unknown } | undefined)?.timestamp;
	return typeof timestamp === "number" ? timestamp : undefined;
}

/** A message the person typed (or spoke): stamped "[...]" input, not a worker report, job result, or reaction. */
function isChat(text: string): boolean {
	return text.startsWith("[") && !/^\[[^\]\n]*\]\n\[reacted /.test(text);
}

const clipTurn = (text: string) => {
	const flat = text.replace(/^\[[^\]\n]*\]\n/, "").replace(/\s+/g, " ").trim();
	return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
};

/** The last few turns of the conversation, oldest first, clipped. */
export function recentTurns(entries: readonly EntryRecord[], limit = 3): string[] {
	const turns: string[] = [];
	for (const entry of entries) {
		const user = UserEntry.is(entry);
		if (!user && !AssistantEntry.is(entry)) continue;
		const text = entryText(entry).trim();
		if (text === "") continue;
		if (user) {
			if (isChat(text)) turns.push(`They said: ${clipTurn(text)}`);
		} else turns.push(`You said: ${clipTurn(text)}`);
	}
	return turns.slice(-limit);
}

/**
 * Whether the person has been chatting since `startedAt` (the work's start, or the last time they spoke about it),
 * read from the conversation's entries: undefined when they haven't, else how recently and what about. Every message
 * counts, so this is only the stand-in for when no decision model has read what their messages were.
 */
export function sideChatSince(entries: readonly EntryRecord[], startedAt: number, now: number): SideChat | undefined {
	let lastUserAt: number | undefined;
	const turns: string[] = [];
	for (const entry of entries) {
		const user = UserEntry.is(entry);
		if (!user && !AssistantEntry.is(entry)) continue;
		const text = entryText(entry).trim();
		if (text === "") continue;
		if (user) {
			if (!isChat(text)) continue;
			const at = entryTime(entry);
			if (at !== undefined && at >= startedAt) lastUserAt = at;
			turns.push(`They said: ${clipTurn(text)}`);
		} else turns.push(`You said: ${clipTurn(text)}`);
	}
	if (lastUserAt === undefined) return undefined;
	return { lastUserAgoMs: Math.max(0, now - lastUserAt), recent: turns.slice(-3) };
}

/** Side chat from what the decision model read: their messages about something else since the work was on topic. */
export function sideChatFromAsides(asides: readonly WorkerAside[], topicAt: number, now: number, recent: string[]): SideChat | undefined {
	const since = asides.filter((aside) => aside.at >= topicAt);
	const last = since.at(-1);
	if (last === undefined) return undefined;
	return { lastUserAgoMs: Math.max(0, now - last.at), recent, count: since.length, previews: since.map((aside) => aside.preview).slice(-3) };
}

/** A real stall: say so even mid-conversation. */
export const STALL_RULE =
	'It has gone quiet for a while. Write one short line saying it hasn\'t stopped and what you\'re still on or waiting for. Don\'t return null. If they\'re talking about something else, say which task this is about and phrase it so it sits next to that conversation.';

/** What a progress update may say while they're talking about something else. */
export const SIDE_CHAT_RULE =
	'Stay quiet: return null for "message" for normal progress, even good progress. Only write a message if the work failed, hit a snag and is retrying or working around it, is blocked or missing something, changed course in a big way, or has stalled badly: something they would want to know even mid-conversation. If you do, keep it short, say what the work is about so it is clear which topic it belongs to, and phrase it so it sits naturally next to that conversation instead of cutting across it.';

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
	/** They're chatting about something else: speak only if something went wrong or needs them. */
	sideChat?: SideChat;
	/** How long the worker has shown no new activity, when that's a stall. */
	stalledMs?: number;
	signal?: AbortSignal;
}): Promise<{ status?: string; message?: string }> {
	try {
		const model = options.models.getModel(options.config.provider, options.config.model);
		if (model === undefined) throw new Error(`unknown model ${options.config.provider}/${options.config.model}`);
		const quietNote = options.quietConfirm
			? `Elapsed: ${formatElapsed(options.elapsedMs)}. It has been quiet for a while and the work is actively progressing; send one short confirmation of what you're doing now.`
			: `Elapsed: ${formatElapsed(options.elapsedMs)}.`;
		const side = options.sideChat;
		const sideNote =
			side === undefined
				? []
				: [
						`They're in a side conversation about something else right now (they last wrote ${formatElapsed(side.lastUserAgoMs)} ago), while this work runs in the background. The conversation so far:\n${side.recent.join("\n") || "(nothing yet)"}`,
						// A genuine stall is worth saying even mid-conversation: no "stay quiet" rule then.
						...(options.stalledMs === undefined ? [SIDE_CHAT_RULE] : []),
					];
		const stallNote = options.stalledMs === undefined ? [] : [`This work has shown no new activity for ${formatElapsed(options.stalledMs)}.`, STALL_RULE];
		const content = [
			`Task (${options.workerName}):\n${options.brief.slice(0, 800)}`,
			`Already told them: ${options.told.join(" / ") || "nothing"}`,
			side === undefined ? quietNote : `Elapsed: ${formatElapsed(options.elapsedMs)}.`,
			...stallNote,
			...sideNote,
			...(options.hint === undefined ? [] : [options.hint]),
			`Recent activity:\n${options.activity || "(nothing new)"}`,
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
	/** Number of progress updates posted for this worker run (drives cadence backoff on long runs). */
	postedCount: number;
	/** Worker items seen so far, and when that count last grew: for telling a stall. */
	seen: number;
	lastActivityAt: number;
	/** A stall was already reported; reset when activity resumes. */
	stallNoted: boolean;
};

export type WorkerProgressMonitorOptions = {
	models: Models;
	config: Config;
	decisions: Decisions;
	everyMs?: number;
	refreshMs?: number;
	firstUpdateMs?: number;
	/** Widened minimum spacing between updates after `backoffAfterUpdates` posted updates (default 120s). */
	backoffRefreshMs?: number;
	/** Number of posted updates after which cadence widens to `backoffRefreshMs` (default 2). */
	backoffAfterUpdates?: number;
	quietConfirmMs?: number;
	stallMs?: number;
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
	const backoffAfterUpdates = options.backoffAfterUpdates ?? DEFAULT_BACKOFF_AFTER_UPDATES;
	const backoffRefreshMs = options.backoffRefreshMs ?? Math.max(refreshMs, DEFAULT_BACKOFF_REFRESH_MS);
	const quietConfirmMs = options.quietConfirmMs ?? DEFAULT_QUIET_CONFIRM_MS;
	const stallMs = options.stallMs ?? STALL_MS;
	const nowFn = options.now ?? Date.now;

	/**
	 * Their messages about something other than `worker` since it was last on topic (`topicAt`). With a decision model,
	 * only the messages it read as side chat or new work count: a steer or status check never does. Without one, every
	 * message since then does.
	 */
	const sideChat = async (conversationId: ConversationId, worker: WorkerRecord, topicAt: number, now: number): Promise<SideChat | undefined> => {
		try {
			if (options.decisions.configured && (worker.asides ?? []).every((aside) => aside.at < topicAt)) return undefined;
			const conversation = await agent.harness.conversation(conversationId, context);
			if (conversation === undefined) return undefined;
			const entries = (await conversation.context(context)).entries;
			return options.decisions.configured
				? sideChatFromAsides(worker.asides ?? [], topicAt, Date.now(), recentTurns(entries))
				: sideChatSince(entries, topicAt, Date.now());
		} catch (error) {
			console.error("[pclaw] worker progress: couldn't read the conversation", error);
			return undefined;
		}
	};

	const tracked = new Map<string, TrackedRun>();
	let running = false;
	let stopped = false;
	const stopController = new AbortController();

	const isWorkerStillActive = async (
		conversationId: ConversationId,
		name: string,
		sessionId: string,
		run: WorkerRecord["run"],
	): Promise<boolean> => {
		if (stopped || context.abortSignal?.aborted === true) return false;
		const latest = (await agent.harness.snapshot(Workers, conversationId, context))?.workers[name];
		return latest !== undefined && latest.status === "working" && latest.sessionId === sessionId && latest.run === run;
	};

	const tick = async () => {
		if (running || stopped || context.abortSignal?.aborted === true) return;
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
							postedCount: 0,
							seen: 0,
							lastActivityAt: worker.startedAt ?? now,
							stallNoted: false,
						};
						tracked.set(key, state);
					}

					const minWait = state.lastNoteAt === undefined ? firstUpdateMs : refreshMs;
					if (now - state.lastCheckedAt < minWait) continue;

					const items = agent.workerItems(worker.sessionId);
					const fresh = items.slice(state.position);
					const freshActivity = describeActivity(fresh);
					if (items.length > state.seen) {
						state.seen = items.length;
						state.lastActivityAt = now;
						state.stallNoted = false;
					}
					const startedAt = worker.startedAt ?? state.startedAt;
					const sinceUpdateMs = now - (state.lastNoteAt ?? state.startedAt);
					const quietDue = sinceUpdateMs >= quietConfirmMs;
					const stalledMs = now - state.lastActivityAt;
					// A stall is noted once it's actually been said; until then every check may still say it.
					const stalled = !state.stallNoted && stalledMs >= stallMs;
					const errors = freshActivity !== "" && interruptWorthy(freshActivity);
					const topicAt = Math.max(startedAt, worker.touchedAt ?? 0);
					const replyTo = worker.ask === undefined ? {} : { replyTo: worker.ask };
					const decisionId = `worker-progress:${name}:${worker.sessionId}:${items.length}`;

					// They're talking about something else: only a failure, a snag, or a bad stall is worth breaking in for.
					const side = await sideChat(conversationId, worker, topicAt, now);

					// Cadence backoff on long runs: after `backoffAfterUpdates` posted updates, widen minimum spacing
					// unless a stall, quiet-confirm, or side-chat failure/retry warrants speaking sooner.
					if (
						state.postedCount >= backoffAfterUpdates &&
						state.lastNoteAt !== undefined &&
						now - state.lastNoteAt < backoffRefreshMs &&
						!stalled &&
						!quietDue &&
						!(side !== undefined && errors)
					) {
						continue;
					}

					const settle = () => {
						state.position = items.length;
						state.lastCheckedAt = now;
					};
					if (side === undefined && freshActivity === "" && !stalled && (!quietDue || items.length === 0)) {
						state.lastCheckedAt = now;
						continue;
					}
					if (side !== undefined && freshActivity === "" && !stalled) {
						settle();
						options.decisions.record({ type: "progress", id: decisionId, job: name, arm: "side-chat", posted: false });
						continue;
					}

					// One read on all three: how the timing looks, what the work is doing, and what the conversation is doing.
					let decided: Decided | undefined;
					if (options.decisions.configured) {
						decided = await options.decisions.ask({
							id: decisionId,
							site: "progress",
							job: name,
							timeoutMs: 3_000,
							state: {
								timing: {
									elapsedSec: Math.round((now - startedAt) / 1000),
									sinceLastUpdateSec: Math.round(sinceUpdateMs / 1000),
									sinceLastTopicTouchSec: Math.max(0, Math.round((Date.now() - topicAt) / 1000)),
									quietForSec: Math.round(stalledMs / 1000),
								},
								work: {
									task: worker.brief.slice(0, 300),
									recent_activity: freshActivity.slice(-1_500) || "(nothing new)",
									tool_calls: items.filter((item) => item.kind === "tool").length,
									errors_or_retries: errors,
									stalled: stalledMs >= stallMs,
									already_told: state.told.slice(-2),
								},
								conversation: {
									unrelated_messages: side?.count ?? (side === undefined ? 0 : 1),
									...(side?.previews === undefined ? {} : { unrelated_previews: side.previews }),
								},
							},
							questions: workerProgressQuestions(side !== undefined),
						});
					}
					const guided = decided?.arm === "guided";
					const worth = decided === undefined ? undefined : yes(decided.answers.worth_updating);
					const interrupt = decided === undefined ? undefined : yes(decided.answers.interrupt_worthy);
					const arm = side !== undefined ? "side-chat" : (decided?.arm ?? "none");
					// The guided arm follows the read; the control arm (and no read at all) keeps the plain rules.
					const go =
						stalled ||
						(side !== undefined
							? guided
								? (interrupt ?? 0) >= 0.5
								: errors
							: guided
								? (worth ?? 0) >= 0.5 || quietDue
								: true);
					if (!go) {
						settle();
						options.decisions.record({
							type: "progress",
							id: decisionId,
							job: name,
							arm,
							...(decided === undefined ? {} : { read: decided.arm }),
							...(worth === undefined ? {} : { worth }),
							...(interrupt === undefined ? {} : { interrupt }),
							posted: false,
						});
						continue;
					}

					// Skip generating an update if the worker already finished while d1/sideChat was in flight.
					if (!(await isWorkerStillActive(conversationId, name, worker.sessionId, worker.run))) {
						activeKeys.delete(key);
						tracked.delete(key);
						continue;
					}

					const hint = guided && decided !== undefined && side === undefined ? workerProgressGuidance(decided.answers, agent.prompts) : undefined;
					const activity =
						side !== undefined ? freshActivity : freshActivity || describeActivity(items.slice(-4)) || formatWorkerProgress(items, state.startedAt, now);
					const genSignal =
						context.abortSignal === undefined
							? AbortSignal.any([stopController.signal, AbortSignal.timeout(30_000)])
							: AbortSignal.any([context.abortSignal, stopController.signal, AbortSignal.timeout(30_000)]);
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
						quietConfirm: side === undefined && quietDue && !stalled,
						...(side === undefined ? {} : { sideChat: side }),
						...(stalled ? { stalledMs } : {}),
						signal: genSignal,
					});

					// Re-check right before posting so a progress bubble can never land after the worker completed or stopped.
					if (!(await isWorkerStillActive(conversationId, name, worker.sessionId, worker.run))) {
						activeKeys.delete(key);
						tracked.delete(key);
						continue;
					}

					settle();
					let posted = false;
					if (message !== undefined && message !== "") {
						await surface
							.update({
								address,
								workerName: name,
								sessionId: worker.sessionId,
								message,
								...(status === undefined ? {} : { status }),
								...replyTo,
								...(side === undefined ? {} : { silent: true }),
							})
							.catch((error: unknown) => console.error(`[pclaw] progress surface ${channel}/${name}`, error));
						state.lastNoteAt = now;
						state.postedCount += 1;
						state.told = [...state.told, message].slice(-5);
						posted = true;
						if (stalled) state.stallNoted = true;
					}
					options.decisions.record({
						type: "progress",
						id: decisionId,
						job: name,
						arm,
						...(decided === undefined ? {} : { read: decided.arm }),
						...(worth === undefined ? {} : { worth }),
						...(interrupt === undefined ? {} : { interrupt }),
						quietConfirm: quietDue,
						stalled,
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
	return {
		stop: () => {
			stopped = true;
			clearInterval(timer);
			stopController.abort();
		},
		tick,
	};
}
