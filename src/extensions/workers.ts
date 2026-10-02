import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTask, defineTool, type Harness, type TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { prompts } from "../prompts.ts";

/**
 * Workers are pi processes: the default coding-agent prompt and tools, on a slower, smarter model. The front model
 * writes a brief, a durable task runs pi to completion and posts the result back into the conversation as a
 * `<worker-report>`, and the front model tells the person what matters. Each worker keeps one pi session, so
 * follow-ups on the same job continue where it left off.
 */

type WorkerStatus = "working" | "idle" | "stopped" | "failed";
type Worker = { sessionId: string; brief: string; status: WorkerStatus; run?: TaskId; startedAt?: number; updatedAt: number };

export const Workers = defineDoc<{ workers: Record<string, Worker> }>({
	kind: "pclaw.workers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ workers: {} }),
});

export type WorkerOptions = {
	command: string;
	provider: string;
	model: string;
	thinkingLevel: string;
	timeoutMs: number;
	/** Workers run here. */
	cwd: string;
	sessionDir: string;
	/** Appended to pi's default system prompt. */
	promptFile: string;
};

export function workerOptions(config: Config, paths: { work: string; workerSessions: string }): WorkerOptions {
	return {
		command: config.workerCommand,
		provider: config.workerProvider,
		model: config.workerModel,
		thinkingLevel: config.workerThinkingLevel,
		timeoutMs: config.workerTimeoutMinutes * 60_000,
		cwd: paths.work,
		sessionDir: paths.workerSessions,
		promptFile: prompts.worker.file,
	};
}

const REPORT_LIMIT = 12_000;

export function prepareWorkspace(options: WorkerOptions): void {
	mkdirSync(options.cwd, { recursive: true, mode: 0o700 });
	mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 });
}

export type WorkerResult = { ok: boolean; output: string };

/** Run one pi turn in the worker's session and return its final answer. Rejects only when `signal` aborts it. */
export function runWorker(options: WorkerOptions, sessionId: string, message: string, signal?: AbortSignal): Promise<WorkerResult> {
	const args = [
		"-p",
		"--provider", options.provider,
		"--model", options.model,
		"--thinking", options.thinkingLevel,
		"--session-dir", options.sessionDir,
		"--session-id", sessionId,
		"--append-system-prompt", options.promptFile,
		// Trust project-local files in the workspace without an interactive prompt.
		"--approve",
		// pi reads a leading @ as a file to attach.
		`Message from pclaw:\n\n${message}`,
	];
	const timeout = AbortSignal.timeout(options.timeoutMs);
	return new Promise((resolve, reject) => {
		const child = spawn(options.command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", (error) => {
			if (signal?.aborted) reject(signal.reason);
			else if (timeout.aborted) resolve({ ok: false, output: `Timed out after ${options.timeoutMs / 60_000} minutes.\n${clip(stdout)}` });
			else resolve({ ok: false, output: `Couldn't start ${options.command}: ${error.message}` });
		});
		child.on("close", (code) => {
			if (signal?.aborted || timeout.aborted) return;
			if (code === 0) resolve({ ok: true, output: clip(stdout.trim()) || "(the worker finished without saying anything)" });
			else resolve({ ok: false, output: clip(`exit ${code}\n${stderr.trim() || stdout.trim()}`) });
		});
	});
}

function clip(text: string): string {
	return text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT)}\n[report cut off at ${REPORT_LIMIT} characters]` : text;
}

const RESUME =
	"pclaw restarted while you were working on this, so your last turn was cut off. Check what you'd already done, " +
	"finish the job, and report as usual. Don't redo anything that already happened.";

export function reportMessage(name: string, result: WorkerResult): string {
	return `<worker-report worker="${name}" status="${result.ok ? "done" : "failed"}">\n${result.output}\n</worker-report>`;
}

type RunInput = { name: string; sessionId: string; message: string };
type RunState = { phase: "run" } | { phase: "report"; ok: boolean; output: string };

export function workersExtension(options: WorkerOptions, harness: { current?: Harness }) {
	const Run = defineTask<RunInput, RunState, null>({
		name: "pclaw.worker-run",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				// A memo outlives a crash: if it's already set, pi was cut off mid-run and resumes its own session.
				const resumed = (await runtime.memo<boolean>("started", context)) === true;
				if (!resumed) await runtime.memo("started", true, context);
				const result = await runWorker(
					options,
					task.input.sessionId,
					resumed ? RESUME : task.input.message,
					context.abortSignal,
				);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", ...result } }), context);
			},
			report: async (task, runtime, context) => {
				const { ok, output } = task.state.checkpoint;
				const conversation = await runtime.conversation(runtime.conversationId, context);
				await conversation?.submit(
					{
						type: "input",
						content: reportMessage(task.input.name, { ok, output }),
						whenBusy: "followUp",
						requestId: `worker-report:${task.id}`,
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

	const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
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
				}),
				execute: async ({ name, brief }, api, context) => {
					const started = await api.commit(async (tx) => {
						const doc = await tx.doc(Workers, api.conversationId);
						if (doc.workers[name] !== undefined) return false;
						const sessionId = randomUUID();
						const run = await tx.createTask(Run, { name, sessionId, message: brief }, background);
						const now = Date.now();
						doc.workers[name] = { sessionId, brief, status: "working", run, startedAt: now, updatedAt: now };
						return true;
					}, context);
					if (!started) throw new Error(`There's already a worker named ${name}. Use message_worker, or pick a new name.`);
					return text(`${name} is on it.`);
				},
			}),
			defineTool({
				name: "message_worker",
				description:
					"Send a follow-up, correction, answer, or go-ahead to a worker you started earlier. It remembers the job.",
				parameters: Type.Object({ name: Type.String(), message: Type.String() }),
				execute: async ({ name, message }, api, context) => {
					const outcome = await api.commit(async (tx) => {
						const worker = (await tx.doc(Workers, api.conversationId)).workers[name];
						if (worker === undefined) return `No worker named ${name}.`;
						if (worker.status === "working") return `${name} is still working. Wait for its report, or stop it first.`;
						worker.run = await tx.createTask(Run, { name, sessionId: worker.sessionId, message }, background);
						worker.status = "working";
						worker.startedAt = worker.updatedAt = Date.now();
						return undefined;
					}, context);
					if (outcome !== undefined) throw new Error(outcome);
					return text(`Sent to ${name}.`);
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
