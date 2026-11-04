import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTask, defineTool, type Harness, type TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { MUSE, museArgs, musePreamble, museRun, museTranscript } from "../muse.ts";
import { pairedClient, runT3Turn } from "../t3-client.ts";
import { prompts } from "../prompts.ts";
import { currentAsk, FAILED, isEmoji, Reactions, setReaction, WORKING } from "./reactions.ts";

/**
 * Workers are coding agents on a slower, smarter model: Muse Code (worker provider `muse`), T3 Code threads
 * (provider `t3`: each job is a full-access T3 thread, launched in its own worktree when a project is configured),
 * or pi (any other provider, with pi's default coding-agent prompt and tools). The front model writes a brief, a
 * durable task runs the agent to completion and posts the result back into the conversation as a
 * `<worker-report>`, and the front model tells the person what matters. Each worker keeps one session in the
 * harness it started in — for T3, the thread id, kept in `t3_<session id>.json` beside the other session files —
 * so follow-ups on the same job continue where it left off.
 */

/** The worker provider id that runs jobs as T3 Code threads instead of a local process. */
export const T3 = "t3";

type WorkerStatus = "working" | "idle" | "stopped" | "failed";
/** The harness and model a job runs on. Absent on jobs from before Muse workers, which all ran in pi. */
type Job = { provider: string; model: string };

type Worker = Partial<Job> & {
	sessionId: string;
	brief: string;
	depth?: Depth;
	status: WorkerStatus;
	run?: TaskId;
	startedAt?: number;
	updatedAt: number;
};

export const Workers = defineDoc<{ workers: Record<string, Worker> }>({
	kind: "pclaw.workers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ workers: {} }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

export type WorkerOptions = {
	/** pi. */
	command: string;
	museCommand: string;
	/** For new jobs: `muse` runs Muse Code; any other provider runs pi with it. */
	provider: string;
	model: string;
	/** A pi provider and model for pi jobs from before Muse workers, when new jobs go to Muse. */
	piFallback: Job;
	thinkingLevel: string;
	timeoutMs: number;
	/** Workers run here. */
	cwd: string;
	sessionDir: string;
	/** Appended to pi's default system prompt. */
	promptFile: string;
	/** pclaw's pi extension for workers (search, read_page, publish_page). */
	toolsFile: string;
	/** The same tools as a command, for harnesses without extensions. */
	cliFile: string;
	/** Reasoning for quick jobs; deep jobs use `thinkingLevel`. */
	quickThinkingLevel: string;
	/** pi skills (directories with SKILL.md): pclaw's own, e.g. web-page, then config.workerSkills. */
	skills: string[];
	/** T3 worker threads: where T3 lives and the pairing to use. Absent: provider `t3` reports it isn't set up. */
	t3?: { url: string; storeFile: string; projectId?: string; baseRef?: string };
};

export type Depth = "quick" | "deep";

/** pclaw's own skills. */
const SKILLS = fileURLToPath(new URL("../skills", import.meta.url));

export function workerOptions(config: Config, paths: { work: string; workerSessions: string; t3Auth?: string }): WorkerOptions {
	return {
		command: config.workerCommand,
		museCommand: config.museCommand,
		provider: config.workerProvider,
		model: config.workerModel,
		piFallback: { provider: config.provider, model: config.model },
		thinkingLevel: config.workerThinkingLevel,
		timeoutMs: config.workerTimeoutMinutes * 60_000,
		cwd: paths.work,
		sessionDir: paths.workerSessions,
		promptFile: prompts.worker.file,
		toolsFile: fileURLToPath(new URL("../worker-tools.ts", import.meta.url)),
		cliFile: fileURLToPath(new URL("../worker-cli.ts", import.meta.url)),
		quickThinkingLevel: config.workerQuickThinkingLevel,
		skills: [
			...readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(SKILLS, entry.name)),
			...config.workerSkills.map((dir) => resolve(dir.replace(/^~(?=$|\/)/, homedir()))),
		],
		...(paths.t3Auth === undefined
			? {}
			: {
					t3: {
						url: config.t3Url,
						storeFile: paths.t3Auth,
						...(config.t3WorkerProjectId === undefined ? {} : { projectId: config.t3WorkerProjectId }),
						...(config.t3WorkerBaseRef === undefined ? {} : { baseRef: config.t3WorkerBaseRef }),
					},
				}),
	};
}

const REPORT_LIMIT = 12_000;

export function prepareWorkspace(options: WorkerOptions): void {
	mkdirSync(options.cwd, { recursive: true, mode: 0o700 });
	mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 });
}

export type WorkerResult = { ok: boolean; output: string };

/** The harness and model for a run: the job's own, else (an older pi job) pi on the current or fallback model. */
export function jobOf(options: WorkerOptions, job: Partial<Job>): Job {
	if (job.provider !== undefined && job.model !== undefined) return { provider: job.provider, model: job.model };
	// Jobs with no provider of their own are pi jobs from before Muse/T3 workers, so they stay in pi.
	return options.provider === MUSE || options.provider === T3 ? options.piFallback : { provider: options.provider, model: options.model };
}

/** Run one turn of the worker's session and return its final answer. Rejects only when `signal` aborts it. */
export function runWorker(
	options: WorkerOptions,
	sessionId: string,
	message: string,
	signal?: AbortSignal,
	depth: Depth = "deep",
	job: Job = jobOf(options, {}),
): Promise<WorkerResult> {
	const thinking = depth === "quick" ? options.quickThinkingLevel : options.thinkingLevel;
	if (job.provider === T3) return runT3(options, job, sessionId, message, signal);
	return job.provider === MUSE ? runMuse(options, job, sessionId, message, thinking, signal) : runPi(options, job, sessionId, message, thinking, signal);
}

/** Where a T3 worker's thread id (its session) is kept, beside the pi/Muse session files. */
export function t3SessionFile(sessionDir: string, sessionId: string): string {
	return join(sessionDir, `t3_${sessionId}.json`);
}

/**
 * One turn of a T3 worker: launch a full-access thread on the first run (in its own worktree off
 * `t3.baseRef` when a project is configured, else a scratch thread), send into it on follow-ups, and wait
 * for the run to settle. Aborting interrupts the thread, the way stop_worker kills a process. The model is
 * the job's `workerModel`, so for provider `t3` it must name a model from T3's orchestrator_capabilities.
 */
export async function runT3(options: WorkerOptions, job: Job, sessionId: string, message: string, signal?: AbortSignal): Promise<WorkerResult> {
	if (options.t3 === undefined) return { ok: false, output: "The T3 worker provider is selected, but pclaw has no T3 pairing configured for workers." };
	const file = t3SessionFile(options.sessionDir, sessionId);
	let threadId: string | undefined;
	try {
		threadId = (JSON.parse(readFileSync(file, "utf8")) as { threadId?: string }).threadId;
	} catch {
		// A first run, or a session file pclaw can't read: launch fresh.
	}
	try {
		const client = await pairedClient(options.t3.url, options.t3.storeFile);
		const title = message.split("\n").find((line) => line.trim() !== "")?.trim().slice(0, 80) ?? `pclaw worker ${sessionId.slice(0, 8)}`;
		const result = await runT3Turn(client, {
			threadId,
			title: `pclaw worker: ${title}`,
			message,
			projectId: options.t3.projectId,
			scratch: options.t3.projectId === undefined ? true : undefined,
			workspaceStrategy:
				options.t3.projectId === undefined
					? undefined
					: { type: "worktree", baseRef: options.t3.baseRef ?? "main", branch: `pclaw/${sessionId.slice(0, 8)}` },
			modelSelection: job.model === "" ? undefined : { model: job.model },
			runtimeMode: "full-access",
			timeoutMs: options.timeoutMs,
			signal,
			onThreadId: (launched) => writeFileSync(file, JSON.stringify({ threadId: launched }) + "\n", { mode: 0o600 }),
		});
		return { ok: result.ok, output: clip(`[T3 thread ${result.threadId}]\n${result.output}`) };
	} catch (error) {
		if (signal?.aborted) throw error;
		return { ok: false, output: clip(`T3 worker failed: ${error instanceof Error ? error.message : String(error)}`) };
	}
}

function runPi(options: WorkerOptions, job: Job, sessionId: string, message: string, thinking: string, signal?: AbortSignal): Promise<WorkerResult> {
	const args = [
		"-p",
		"--provider", job.provider,
		"--model", job.model,
		"--thinking", thinking,
		"--session-dir", options.sessionDir,
		"--session-id", sessionId,
		"--append-system-prompt", options.promptFile,
		// pclaw's own tools, not the owner's personal pi setup: no other extensions, skills, or AGENTS.md files.
		"--no-extensions", "--extension", options.toolsFile,
		"--no-skills", ...options.skills.flatMap((skill) => ["--skill", skill]),
		"--no-context-files", "--no-prompt-templates", "--no-themes",
		// Trust project-local files in the workspace without an interactive prompt.
		"--approve",
		// pi reads a leading @ as a file to attach.
		`Message from pclaw:\n\n${message}`,
	];
	return spawnWorker(options, options.command, args, signal, (code, stdout, stderr) => {
		if (code === 0) return { ok: true, output: clip(stdout.trim()) || "(the worker finished without saying anything)" };
		// pi prints startup warnings to stderr; they're noise in a failure report.
		const errors = stderr.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("Warning:")).join("\n");
		return { ok: false, output: clip(`exit ${code}\n${errors || stdout.trim()}`) };
	});
}

function runMuse(options: WorkerOptions, job: Job, sessionId: string, message: string, thinking: string, signal?: AbortSignal): Promise<WorkerResult> {
	const transcript = museTranscript(options.sessionDir, sessionId);
	// pclaw's worker prompt goes in front of the session's first message; later turns are in the same Muse session.
	const first = !existsSync(transcript);
	const prompt = `${first ? `${musePreamble(options)}\n\n---\n\n` : ""}Message from pclaw:\n\n${message}`;
	const run = museRun(transcript);
	const args = museArgs({ model: job.model, effort: thinking, sessionId, cwd: options.cwd }, prompt);
	const finish = (code: number | null, _stdout: string, stderr: string): WorkerResult => {
		const result = run.finish();
		if (result !== undefined) return { ok: result.ok, output: clip(result.output) };
		// Muse prints its setup notes to stderr as "muse: ..."; they're noise in a failure report.
		const errors = stderr.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("muse: ")).join("\n");
		return { ok: false, output: clip(`exit ${code}\n${errors || "Muse ended without a result."}`) };
	};
	return spawnWorker(options, options.museCommand, args, signal, finish, (chunk) => run.write(chunk));
}

/** Run a worker process. `finish` reads its result; a timeout or a failure to start becomes a failed result. */
function spawnWorker(
	options: WorkerOptions,
	command: string,
	args: string[],
	signal: AbortSignal | undefined,
	finish: (code: number | null, stdout: string, stderr: string) => WorkerResult,
	onStdout?: (chunk: string) => void,
): Promise<WorkerResult> {
	const timeout = AbortSignal.timeout(options.timeoutMs);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			// A streaming harness keeps its own record; only plain output is gathered here.
			if (onStdout === undefined) stdout += chunk.toString();
			else onStdout(chunk.toString());
		});
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", (error) => {
			if (signal?.aborted) reject(signal.reason);
			else if (timeout.aborted) resolve({ ok: false, output: `Timed out after ${options.timeoutMs / 60_000} minutes.\n${clip(stdout)}` });
			else resolve({ ok: false, output: `Couldn't start ${command}: ${error.message}` });
		});
		child.on("close", (code) => {
			if (signal?.aborted || timeout.aborted) return;
			resolve(finish(code, stdout, stderr));
		});
	});
}

function clip(text: string): string {
	return text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT)}\n[report cut off at ${REPORT_LIMIT} characters]` : text;
}

/** Put in front of a quick job's brief. Speed comes from scope, never from skipping the checking. */
export const QUICK_NOTE =
	"This is a quick job: aim to finish in about a minute with a few good sources. Confirm the facts the answer rests " +
	"on, and if confirming more would take much longer, stop and report what you've confirmed, marking anything you " +
	"haven't. Don't guess to fill gaps.";

const RESUME =
	"pclaw restarted while you were working on this, so your last turn was cut off. Check what you'd already done, " +
	"finish the job, and report as usual. Don't redo anything that already happened.";

export const CLOSE_HINT = "(Their message that asked for this shows its status as a reaction. Use `react` to close it while you reply.)";

export function reportMessage(name: string, result: WorkerResult, hint = false): string {
	const report = `<worker-report worker="${name}" status="${result.ok ? "done" : "failed"}">\n${result.output}\n</worker-report>`;
	return hint ? `${report}\n${CLOSE_HINT}` : report;
}

/** `ask` is the person's message that asked for this run, which carries its status reaction. */
type RunInput = Partial<Job> & { name: string; sessionId: string; message: string; ask?: string; depth?: Depth };
type RunState = { phase: "run" } | { phase: "report"; ok: boolean; output: string };

export function workersExtension(options: WorkerOptions, harness: { current?: Harness }) {
	const Run = defineTask<RunInput, RunState, null>({
		name: "pclaw.worker-run",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				// A memo outlives a crash: if it's already set, the worker was cut off mid-run and resumes its own session.
				const resumed = (await runtime.memo<boolean>("started", context)) === true;
				if (!resumed) await runtime.memo("started", true, context);
				const message = task.input.depth === "quick" ? `${QUICK_NOTE}\n\n${task.input.message}` : task.input.message;
				const result = await runWorker(
					options,
					task.input.sessionId,
					resumed ? RESUME : message,
					context.abortSignal,
					task.input.depth,
					jobOf(options, task.input),
				);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", ...result } }), context);
			},
			report: async (task, runtime, context) => {
				const { ok, output } = task.state.checkpoint;
				const requestId = `worker-report:${task.id}`;
				const { ask } = task.input;
				if (ask !== undefined) {
					// Before the report goes in: its run must find the ask, and the working badge comes off (a failure says so).
					await runtime.commit(async (tx) => {
						(await tx.doc(Reactions, runtime.conversationId)).reports[requestId] = ask;
						await setReaction(tx, runtime.conversationId, ask, ok ? "" : FAILED);
						return undefined;
					}, context);
				}
				const conversation = await runtime.conversation(runtime.conversationId, context);
				await conversation?.submit(
					{
						type: "input",
						content: reportMessage(task.input.name, { ok, output }, ask !== undefined),
						whenBusy: "followUp",
						requestId,
					},
					context,
				);
				await runtime.commit(async (tx) => {
					const worker = (await tx.doc(Workers, runtime.conversationId)).workers[task.input.name];
					if (worker !== undefined && worker.run === task.id) {
						worker.status = ok ? "idle" : "failed";
						delete worker.run;
						worker.updatedAt = runtime.now();
					}
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				if (task.input.ask !== undefined) await setReaction(tx, runtime.conversationId, task.input.ask, "");
				const worker = (await tx.doc(Workers, runtime.conversationId)).workers[task.input.name];
				if (worker !== undefined && worker.run === task.id) {
					worker.status = "stopped";
					delete worker.run;
					worker.updatedAt = runtime.now();
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
	// Background: a running worker never keeps the conversation busy, so the person can keep talking.
	const background = { ownership: { kind: "conversation" }, background: true } as const;

	return defineExtension({
		name: "pclaw.workers",
		tasks: [Run],
		tools: [
			defineTool({
				name: "delegate",
				description:
					"Hand a job to a worker: a slower, more capable agent with a shell, files, and the web. Use it for " +
					"research, comparisons, lookups, browsing, making or reading files, or anything that takes more than a " +
					"minute of careful work. The worker can't see this conversation, so the brief must stand alone. Its " +
					"report comes back to you as a <worker-report>.",
				parameters: Type.Object({
					name: Type.String({ description: "Short name for this job, like nas-parts or llc-annual-report." }),
					brief: Type.String({
						description:
							"Self-contained brief: the goal and why, relevant facts and preferences, constraints, and what to report back.",
					}),
					depth: Type.Optional(
						Type.Union([Type.Literal("quick"), Type.Literal("deep")], {
							description:
								"quick (default): a lookup or simple comparison, a few searches, done in a minute or two. deep: real research where getting it right takes many sources and careful checking.",
						}),
					),
					emoji: Type.Optional(
						Type.String({
							description:
								"A reaction for their message while the job runs: the literal emoji for the topic if there is one (🖥️ for a computer, 🍜 for ramen). Defaults to ⏳.",
						}),
					),
				}),
				execute: async ({ name, brief, emoji, depth = "quick" }, api, context) => {
					const ask = await currentAsk(harness.current, api, api.conversationId, context);
					const badge = emoji !== undefined && isEmoji(emoji.trim()) ? emoji.trim() : WORKING;
					const started = await api.commit(async (tx) => {
						if (ask !== undefined) await setReaction(tx, api.conversationId, ask, badge);
						const doc = await tx.doc(Workers, api.conversationId);
						const existing = doc.workers[name];
						if (existing !== undefined) {
							// A job that failed or was stopped can be restarted under its name, in its own session.
							if (existing.status !== "failed" && existing.status !== "stopped") return false;
							// It stays in the harness its session is in.
							const job = jobOf(options, existing);
							existing.run = await tx.createTask(Run, { name, sessionId: existing.sessionId, message: brief, depth, ...job, ...(ask === undefined ? {} : { ask }) }, background);
							Object.assign(existing, job);
							existing.status = "working";
							existing.brief = brief;
							existing.depth = depth;
							existing.startedAt = existing.updatedAt = Date.now();
							return true;
						}
						const sessionId = randomUUID();
						const job = { provider: options.provider, model: options.model };
						const run = await tx.createTask(Run, { name, sessionId, message: brief, depth, ...job, ...(ask === undefined ? {} : { ask }) }, background);
						const now = Date.now();
						doc.workers[name] = { ...job, sessionId, brief, depth, status: "working", run, startedAt: now, updatedAt: now };
						return true;
					}, context);
					if (!started) throw new Error(`There's already a worker named ${name}. Use message_worker, or pick a new name.`);
					// End the turn here: what was written alongside this call is the reply, with no second request.
					return { ...text(`${name} is on it.`), control: { terminate: true } };
				},
			}),
			defineTool({
				name: "message_worker",
				description:
					"Send a follow-up, correction, answer, or go-ahead to a worker you started earlier. It remembers the job.",
				parameters: Type.Object({ name: Type.String(), message: Type.String() }),
				execute: async ({ name, message }, api, context) => {
					const ask = await currentAsk(harness.current, api, api.conversationId, context);
					const outcome = await api.commit(async (tx) => {
						const worker = (await tx.doc(Workers, api.conversationId)).workers[name];
						if (worker === undefined) return `No worker named ${name}.`;
						if (worker.status === "working") return `${name} is still working. Wait for its report, or stop it first.`;
						if (ask !== undefined) await setReaction(tx, api.conversationId, ask, WORKING);
						const job = jobOf(options, worker);
						worker.run = await tx.createTask(Run, { name, sessionId: worker.sessionId, message, depth: worker.depth ?? "deep", ...job, ...(ask === undefined ? {} : { ask }) }, background);
						Object.assign(worker, job);
						worker.status = "working";
						worker.startedAt = worker.updatedAt = Date.now();
						return undefined;
					}, context);
					if (outcome !== undefined) throw new Error(outcome);
					return { ...text(`Sent to ${name}.`), control: { terminate: true } };
				},
			}),
			defineTool({
				name: "stop_worker",
				description: "Stop a worker mid-job. It keeps its memory, so message_worker can restart it later.",
				parameters: Type.Object({ name: Type.String() }),
				execute: async ({ name }, api, context) => {
					const worker = (await api.snapshot(Workers, api.conversationId, context))?.workers[name];
					if (worker?.run === undefined) return text(`${name} isn't running.`);
					if (harness.current === undefined) throw new Error("pclaw is still starting up.");
					await harness.current.abortTask(worker.run, context);
					return text(`Stopped ${name}.`);
				},
			}),
			defineTool({
				name: "list_workers",
				description: "List workers and what each is doing.",
				parameters: Type.Object({}),
				execute: async (_args, api, context) => {
					const workers = Object.entries((await api.snapshot(Workers, api.conversationId, context))?.workers ?? {});
					if (workers.length === 0) return text("No workers yet.");
					workers.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
					return text(workers.map(([name, worker]) => `${name}: ${worker.status}. ${worker.brief.slice(0, 160)}`).join("\n"));
				},
			}),
		],
	});
}
