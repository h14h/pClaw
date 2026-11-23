import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Models } from "@earendil-works/pi-ai/models";
import { type PromptResolver, readPrompt } from "./prompts.ts";

/**
 * A decision model (Liquid's d1 family) as a source of hints. Given a state and named questions it returns
 * probabilities in one forward pass, with no generated text. Its answers pick sections of src/prompts/guidance.md, and
 * those reach the front model inside `<guidance>`, which it's free to ignore. Nothing here decides what pclaw does:
 * with no decision model configured, or when it's unreachable, there's simply no hint.
 *
 * d1 runs at home, so it's asked with a tight timeout. When it isn't configured, or doesn't answer in time, a small
 * structured prompt to a cloud model (`fallback`) answers the same questions in the same shape, so callers never
 * care which one answered. The log says which (`backend`).
 *
 * Every call lands in decisions.jsonl. A share of events (`holdout`) are controls: the question is asked and logged,
 * but the hint isn't shown, so hinted and unhinted behavior can be compared. See docs/decision-evals.md.
 */

export type Question =
	| { type: "noul"; instructions: string }
	| { type: "choice"; instructions: string; criteria: Record<string, string> };
export type Questions = Record<string, Question>;
export type Answer = { noul?: number; probability?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> };
export type Answers = Record<string, Answer>;
export type Site = "job-turn" | "message" | "project" | "follow-up" | "progress" | "in-worker";
export type Arm = "guided" | "control";
export type Backend = "d1" | "fallback";
export type Decided = { id: string; site: Site; arm: Arm; answers: Answers; backend?: Backend };

/** A cloud model that answers when d1 can't: the front model, asked for a few numbers with no tools. */
export type DecisionFallback = {
	models: Models;
	provider: string;
	model: string;
	/** How long the fallback may take. */
	timeoutMs?: number;
};

export type Decisions = {
	readonly configured: boolean;
	ask(request: { id: string; site: Site; state: unknown; questions: Questions; job?: string; timeoutMs?: number }): Promise<Decided | undefined>;
	/** Add a line to the log: what was shown, and what happened next. */
	record(event: Record<string, unknown> & { type: string }): void;
};

const STATE_LOG_LIMIT = 6_000;

/** The same event always lands in the same arm, so a retry can't change it. */
export function armOf(id: string, holdout: number): Arm {
	return createHash("sha256").update(id).digest()[0]! / 256 < holdout ? "control" : "guided";
}

/** The longest d1 is waited on, whatever a caller asks: a home ISP outage must never stall a reply. */
export const D1_TIMEOUT_MS = 2_500;
const FALLBACK_TIMEOUT_MS = 4_000;

export function decisionClient(options: {
	url?: string;
	logFile: string;
	holdout?: number;
	timeoutMs?: number;
	fetchFn?: typeof fetch;
	fallback?: DecisionFallback;
	prompts?: PromptResolver;
}): Decisions {
	const { url, logFile, holdout = 0.2, timeoutMs = D1_TIMEOUT_MS, fetchFn = fetch, fallback, prompts } = options;
	const record: Decisions["record"] = (event) => {
		try {
			appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
		} catch (error) {
			console.error("[pclaw] couldn't write the decision log", error);
		}
	};
	const askD1 = async (stateText: string, questions: Questions, limit: number): Promise<Answers> => {
		const response = await fetchFn(`${url!.replace(/\/$/, "")}/v1/decisions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ state: stateText, questions }),
			signal: AbortSignal.timeout(Math.min(limit, D1_TIMEOUT_MS)),
		});
		if (!response.ok) throw new Error(`decision model returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
		const { answers } = (await response.json()) as { answers: Answers };
		return answers;
	};
	return {
		configured: url !== undefined || fallback !== undefined,
		record,
		ask: async ({ id, site, state, questions, job, timeoutMs: limit = timeoutMs }) => {
			if (url === undefined && fallback === undefined) return undefined;
			const arm = armOf(id, holdout);
			const stateText = typeof state === "string" ? state : JSON.stringify(state);
			const base = { type: "decision", id, site, arm, templates: templatesVersion(prompts), ...(job === undefined ? {} : { job }), state: stateText.slice(0, STATE_LOG_LIMIT) };
			const suffix = job === undefined ? "" : ` job=${job}`;
			const attempts: [Backend, () => Promise<Answers>][] = [
				...(url === undefined ? [] : [["d1", () => askD1(stateText, questions, limit)] as [Backend, () => Promise<Answers>]]),
				...(fallback === undefined ? [] : [["fallback", () => askFallback(fallback, stateText, questions)] as [Backend, () => Promise<Answers>]]),
			];
			for (const [backend, attempt] of attempts) {
				const started = performance.now();
				try {
					const answers = await attempt();
					const ms = Math.round(performance.now() - started);
					record({ ...base, backend, ok: true, ms, answers });
					console.log(`[pclaw] decide ${site} ${arm} ${backend} ${ms}ms ${brief(answers)}${suffix}`);
					return { id, site, arm, answers, backend };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					record({ ...base, backend, ok: false, ms: Math.round(performance.now() - started), error: message });
					console.error(`[pclaw] decide ${site} ${backend} failed${backend === "d1" && fallback !== undefined ? ", trying the fallback" : ", going without a hint"}: ${message}`);
				}
			}
			return undefined;
		},
	};
}

const FALLBACK_SYSTEM =
	"You label a situation for a router. Read the state, then answer every question. Reply with one JSON object and nothing else. " +
	'For a yes/no question, the value is the probability of yes, a number from 0 to 1. For a pick-one question, the value is "<option>:<confidence>", ' +
	"the option's key and a confidence from 0 to 1.";

/** The fallback's prompt: the state, then each question with its options. */
export function fallbackPrompt(stateText: string, questions: Questions): string {
	const lines = Object.entries(questions).map(([name, question]) =>
		question.type === "noul"
			? `- ${name} (yes/no): ${question.instructions}`
			: `- ${name} (pick one of ${Object.entries(question.criteria).map(([key, text]) => `${key} = ${text}`).join("; ")}): ${question.instructions}`,
	);
	return `State:\n${stateText.slice(0, STATE_LOG_LIMIT)}\n\nQuestions:\n${lines.join("\n")}\n\nJSON keys: ${Object.keys(questions).join(", ")}`;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Read the fallback's JSON into d1's answer shape. Questions it skipped or garbled are left out. */
export function parseFallbackAnswers(raw: string, questions: Questions): Answers {
	const parsed = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "{}") as Record<string, unknown>;
	const answers: Answers = {};
	for (const [name, question] of Object.entries(questions)) {
		const value = parsed[name];
		if (question.type === "noul") {
			const p = typeof value === "number" ? value : typeof value === "boolean" ? (value ? 1 : 0) : typeof value === "string" ? Number(value) : Number.NaN;
			if (Number.isFinite(p)) answers[name] = { noul: clamp01(p) };
			continue;
		}
		let choice: string | undefined;
		let confidence: number | undefined;
		if (typeof value === "string") {
			const at = value.lastIndexOf(":");
			const tail = at === -1 ? Number.NaN : Number(value.slice(at + 1));
			choice = (Number.isFinite(tail) ? value.slice(0, at) : value).trim();
			if (Number.isFinite(tail)) confidence = clamp01(tail);
		} else if (value !== null && typeof value === "object") {
			const record = value as { choice?: unknown; confidence?: unknown };
			if (typeof record.choice === "string") choice = record.choice.trim();
			if (typeof record.confidence === "number") confidence = clamp01(record.confidence);
		}
		if (choice !== undefined && choice in question.criteria) answers[name] = { choice, confidence: confidence ?? 0.75 };
	}
	if (Object.keys(answers).length === 0) throw new Error(`fallback gave no usable answers: ${raw.slice(0, 120)}`);
	return answers;
}

async function askFallback(fallback: DecisionFallback, stateText: string, questions: Questions): Promise<Answers> {
	const model = fallback.models.getModel(fallback.provider, fallback.model);
	if (model === undefined) throw new Error(`unknown fallback model ${fallback.provider}/${fallback.model}`);
	const reply = await fallback.models.completeSimple(
		model,
		{ systemPrompt: FALLBACK_SYSTEM, messages: [{ role: "user", content: fallbackPrompt(stateText, questions), timestamp: Date.now() }] },
		{ temperature: 0, maxTokens: 150, signal: AbortSignal.timeout(fallback.timeoutMs ?? FALLBACK_TIMEOUT_MS) },
	);
	if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? `fallback ${reply.stopReason}`);
	return parseFallbackAnswers(reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""), questions);
}

/** The probability behind a yes/no answer. */
export const yes = (answer: Answer | undefined): number => answer?.probability ?? answer?.noul ?? 0;

/** `{ choice, p }` for a pick-one answer. */
export function pick(answer: Answer | undefined): { choice?: string; p: number } {
	if (answer?.choice === undefined) return { p: 0 };
	return { choice: answer.choice, p: answer.confidence ?? answer.probabilities?.[answer.choice] ?? 0 };
}

function brief(answers: Answers): string {
	return Object.entries(answers)
		.map(([name, answer]) => (answer.choice !== undefined ? `${name}=${answer.choice}(${pick(answer).p.toFixed(2)})` : `${name}=${yes(answer).toFixed(2)}`))
		.join(" ");
}

/** The sections of guidance.md by heading. Read on every use, so an edit applies to the next decision. */
export function parseTemplates(markdown: string): Record<string, string> {
	const sections: Record<string, string> = {};
	for (const part of markdown.split(/^## /m).slice(1)) {
		const end = part.indexOf("\n");
		if (end !== -1) sections[part.slice(0, end).trim()] = part.slice(end + 1).trim();
	}
	return sections;
}

export type GuidanceTemplates = Record<string, string> | PromptResolver;

function isPromptResolver(value: GuidanceTemplates): value is PromptResolver {
	return typeof (value as PromptResolver).read === "function";
}

function resolveTemplates(templates?: GuidanceTemplates): Record<string, string> {
	if (templates === undefined) return parseTemplates(readPrompt("guidance"));
	return isPromptResolver(templates) ? parseTemplates(templates.read("guidance")) : templates;
}

function templatesVersion(prompts?: PromptResolver): string {
	try {
		return createHash("sha256").update(prompts?.read("guidance") ?? readPrompt("guidance")).digest("hex").slice(0, 8);
	} catch {
		return "unknown";
	}
}

/** A `<guidance>` block from template names, with the raw read on top so the front model can weigh it. */
export function renderGuidance(answers: Answers, picks: string[], values: Record<string, string> = {}, templates?: GuidanceTemplates): string | undefined {
	const resolved = resolveTemplates(templates);
	const lines = picks.flatMap((name) => {
		const text = resolved[name];
		return text === undefined ? [] : [Object.entries(values).reduce((line, [key, value]) => line.replaceAll(`{${key}}`, value), text)];
	});
	if (lines.length === 0) return undefined;
	return `<guidance read="${brief(answers)}">\n${lines.join("\n")}\n</guidance>`;
}

export const STRIP_GUIDANCE = /<guidance[\s\S]*?<\/guidance>\s*/g;

// Decision set: a job's agent ended a turn. d1-2B reads small factual questions about the end of a message far better
// than it judges the whole situation (see the replay in docs/decision-evals.md), so it answers those and `readTurn`
// combines them with what's known for certain.

/** How much of the agent's last message d1 sees. Agents put the ask at the end. */
export const TURN_TAIL = 1_200;

export const turnQuestions: Questions = {
	asks_owner: { type: "noul", instructions: "Does this message end by asking the reader to approve, choose, or answer something before the work continues?" },
	real_decision: {
		type: "noul",
		instructions: "Is the reader being asked to settle what the product or policy should be: a tradeoff, a requirement, or a limit? Answer no if it only asks permission for the next routine step, like opening a PR, running a review, running a checklist, or merging.",
	},
	failed: { type: "noul", instructions: "Does this message report that the work failed, or that it can't continue because of an error or missing access?" },
	waiting_on_system: { type: "noul", instructions: "Does this message say the agent is waiting on an automated check or will continue on its own?" },
	job_complete: { type: "noul", instructions: "Does this message say all the work is finished, with nothing left to do?" },
	hard_to_undo: { type: "noul", instructions: "Is the agent about to do, or asking to do, something outward-facing and hard to undo: send, buy, book, pay, delete, post, merge, or deploy?" },
};

export type TurnFacts = {
	/** The owner spoke to the agent directly most recently, so they're already there. */
	ownerDriving: boolean;
	/** The agent's last message is the one already reported. */
	repeat: boolean;
};
export type TurnOutcome = "finished" | "needs_owner" | "procedural" | "blocked" | "still_going";
export type TurnRead = { outcome: TurnOutcome; surface: "ping" | "note" | "card" };

/** Asks often score just under one half, and a missed ask costs more than a stray hint. */
const ASK_THRESHOLD = 0.4;

export function readTurn(answers: Answers, facts: TurnFacts): TurnRead {
	const asks = yes(answers.asks_owner);
	let outcome: TurnOutcome = "still_going";
	if (yes(answers.waiting_on_system) >= 0.6 && asks < 0.6) outcome = "still_going";
	else if (asks >= ASK_THRESHOLD) outcome = yes(answers.real_decision) >= 0.5 ? "needs_owner" : "procedural";
	else if (yes(answers.failed) >= 0.6) outcome = "blocked";
	else if (yes(answers.job_complete) >= 0.5) outcome = "finished";
	const matters = outcome === "needs_owner" || outcome === "blocked" || outcome === "finished";
	const surface = facts.ownerDriving || facts.repeat || !matters ? "card" : "ping";
	return { outcome, surface };
}

export function turnGuidance(answers: Answers, facts: TurnFacts, templates?: GuidanceTemplates): string | undefined {
	const { outcome, surface } = readTurn(answers, facts);
	const picks = [`turn.${outcome}`];
	if (facts.ownerDriving) picks.push("owner_driving");
	if (facts.repeat) picks.push("no_news");
	picks.push(`surface.${surface}`);
	if (yes(answers.hard_to_undo) >= 0.5) picks.push("caution");
	return renderGuidance(answers, picks, {}, templates);
}

// Decision set: the owner sent a message.

export function messageQuestions(inJobThread: boolean): Questions {
	return {
		job_size: {
			type: "choice",
			instructions: "What does this message need?",
			criteria: {
				answer: "A reply right now: chat, an opinion, an explanation, or a quick fact",
				quick_worker: "Research, a comparison, a lookup, or a one-off check, with nothing to build or keep",
				t3_job: "Changing code or files, building something, or long work the owner would want to open and steer",
			},
		},
		fresh_check: {
			type: "noul",
			instructions: "Would a correct answer depend on how something is right now, outside this conversation? Examples: a live system, what's installed or running, a price, opening hours, a schedule, a score, the weather, news, or a recent release. Answer no for timeless facts, explanations, opinions, and chat.",
		},
		asks_status: { type: "noul", instructions: "Is the owner asking how something running is going, or whether it finished?" },
		thinking_aloud: { type: "noul", instructions: "Is the owner thinking out loud or floating an idea, rather than asking for something to be done now?" },
		firm_ask: { type: "noul", instructions: "Does this message contain a clear, firm request to do something?" },
		corrects: { type: "noul", instructions: "Is the owner correcting the assistant, or saying it misunderstood them?" },
		noise_feedback: {
			type: "choice",
			instructions: "Is the owner commenting on how much the assistant notifies them?",
			criteria: { too_loud: "They hear too much, or want it to stop", too_quiet: "They wanted to hear sooner or more", neither: "Not about notifications" },
		},
		hard_to_undo: { type: "noul", instructions: "Is the owner asking for something outward-facing and hard to undo: send, buy, book, pay, delete, post, merge, or deploy?" },
		...(inJobThread
			? {
					in_job: {
						type: "choice",
						instructions: "This message is in a job's thread. What is it?",
						criteria: { status: "A question about how the job is going", steer: "Instructions for the job's agent", side: "A question or comment for the assistant itself" },
					},
				}
			: {}),
	};
}

/** Facts about the moment a message arrived, known for certain. */
export type MessageFacts = {
	/** Something is running or waiting, so a question about status has something to be about. */
	liveJobs?: boolean;
	/** The message names one of the owner's machines. */
	namesMachine?: boolean;
	/** It was spoken. One read of a long memo can miss an ask at the end, so it gets its own hint. */
	voice?: boolean;
	project?: { project: string; machine: string };
	/** When false, omit T3 / machine-check / project hints while keeping all non-T3 hints active. */
	allowT3?: boolean;
};

/** Simple questions can read as research, so that hint needs a firmer read unless the answer has to be looked up. */
const WORKER_THRESHOLD = 0.7;

export function messageGuidance(answers: Answers, facts: MessageFacts = {}, templates?: GuidanceTemplates): string | undefined {
	const allowT3 = facts.allowT3 !== false;
	const picks: string[] = [];
	const size = pick(answers.job_size);
	const inJob = pick(answers.in_job).choice;
	const fresh = yes(answers.fresh_check) >= 0.5;
	// A question about running work mentions the work, so it reads as new work unless this comes first.
	if ((yes(answers.asks_status) >= 0.5 && facts.liveJobs === true) || inJob === "status") picks.push("message.status");
	else if (allowT3 && inJob === "steer") picks.push("message.steer");
	else if (facts.voice === true) picks.push("message.voice");
	else if (yes(answers.thinking_aloud) >= 0.7 && yes(answers.firm_ask) < 0.3) picks.push("message.thinking_aloud");
	else if (allowT3 && size.choice === "t3_job" && size.p >= 0.5) {
		picks.push("message.t3_job");
		if (facts.project !== undefined) picks.push("message.project");
	} else if (fresh) picks.push(allowT3 && facts.namesMachine === true ? "message.machine_check" : "message.fresh");
	else if ((size.choice === "quick_worker" && size.p >= WORKER_THRESHOLD) || (!allowT3 && size.choice === "t3_job" && size.p >= WORKER_THRESHOLD)) {
		picks.push("message.quick_worker");
	}
	const noise = pick(answers.noise_feedback);
	if (noise.choice !== undefined && noise.choice !== "neither" && noise.p >= 0.5) picks.push(`message.${noise.choice}`);
	if (yes(answers.hard_to_undo) >= 0.5) picks.push("caution");
	const rendered = renderGuidance(answers, picks, allowT3 ? (facts.project ?? {}) : {}, templates);
	if (rendered === undefined || allowT3) return rendered;
	return rendered.replaceAll("`list_jobs`", "`list_workers`");
}

// Decision set: a message arrived while one or more workers are running in this conversation (a DM included).

export type WorkerIntent = "steer" | "status" | "side_chat" | "new_work";
export const WORKER_INTENTS: readonly WorkerIntent[] = ["steer", "status", "side_chat", "new_work"];

/** `workers` are the running ones, as `{ name, goal }`; a second question picks which one when there are several. */
export function inWorkerQuestions(workers: { name: string; goal: string }[]): Questions {
	return {
		intent: {
			type: "choice",
			instructions: "Work is running in the background for the person (see running_work). What is their new message?",
			criteria: {
				steer: "It changes, redirects, narrows, widens, corrects, or adds a constraint or preference to the running work",
				status: "It asks how the running work is going, whether it's done, or what it found so far",
				side_chat: "It's about something else: chat, a question, or a comment unrelated to the running work",
				new_work: "It asks for a separate new task, unrelated to the running work",
			},
		},
		...(workers.length > 1
			? {
					which: {
						type: "choice",
						instructions: "Which piece of running work is the message most about?",
						criteria: Object.fromEntries(workers.map((worker, index) => [`w${index}`, `${worker.name}: ${worker.goal.slice(0, 160)}`])),
					},
				}
			: {}),
	};
}

/** Below this, an intent read isn't trusted enough to shape the hint. */
export const INTENT_THRESHOLD = 0.5;

/** The intent and the worker it's about, from an in-worker read. Undefined when the read is missing or unsure. */
export function readWorkerIntent(answers: Answers, workers: string[]): { intent: WorkerIntent; worker?: string; p: number } | undefined {
	const { choice, p } = pick(answers.intent);
	if (choice === undefined || !WORKER_INTENTS.includes(choice as WorkerIntent)) return undefined;
	const which = pick(answers.which).choice;
	const index = which === undefined ? (workers.length === 1 ? 0 : -1) : Number(which.slice(1));
	const worker = workers[index];
	return { intent: choice as WorkerIntent, p, ...(worker === undefined ? {} : { worker }) };
}

export function inWorkerGuidance(answers: Answers, workers: string[], templates?: GuidanceTemplates): string | undefined {
	const read = readWorkerIntent(answers, workers);
	if (read === undefined || read.p < INTENT_THRESHOLD) return undefined;
	return renderGuidance(answers, [`worker.${read.intent}`], { worker: read.worker ?? workers.join(" or ") }, templates);
}

export const projectQuestion = (projects: { title: string; machine: string }[]): Questions => ({
	project: {
		type: "choice",
		instructions: "Which project is this work for? Use the channel name as well as the message.",
		criteria: {
			...Object.fromEntries(projects.map((project, index) => [`p${index}`, `${project.title} on ${project.machine}`])),
			none: "None of these",
		},
	},
});

// Decision set: a running job did something new.

export const progressQuestions: Questions = {
	milestone: {
		type: "noul",
		instructions: "Does this activity show something a person following along would want to hear: a finding, a stage finished, a change of direction, or something that worked? Answer no for routine listing, searching, or reading that hasn't turned anything up yet.",
	},
};

export const progressGuidance = (answers: Answers, templates?: GuidanceTemplates): string | undefined =>
	renderGuidance(answers, [yes(answers.milestone) >= 0.5 ? "progress.milestone" : "progress.routine"], {}, templates);

/** A running worker's progress, judged on timing, its own state, and what the conversation is doing. */
export function workerProgressQuestions(sideChat: boolean): Questions {
	return {
		worth_updating: {
			type: "noul",
			instructions:
				"Would a person waiting on this work want a short update now? Yes for a finding, a stage finished, a change of direction, a failure or retry, or a long silence. No for routine searching or reading that hasn't turned anything up, or right after the last update.",
		},
		...(sideChat
			? {
					interrupt_worthy: {
						type: "noul",
						instructions:
							"The person is talking about something else right now. Is this worth breaking into that conversation for: the work failed, is stuck or retrying, needs them, changed course in a big way, or has gone quiet for a long time?",
					},
				}
			: {}),
	};
}

export const workerProgressGuidance = (answers: Answers, templates?: GuidanceTemplates): string | undefined =>
	renderGuidance(answers, [yes(answers.worth_updating) >= 0.5 ? "progress.milestone" : "progress.routine"], {}, templates);

// Decision set: a follow-up came due.

export const followUpQuestions: Questions = {
	good_moment: { type: "noul", instructions: "Given the time and when the owner was last active, is this a reasonable moment to send this follow-up?" },
	still_relevant: { type: "noul", instructions: "Is this follow-up still relevant, or has recent conversation already handled it?" },
};

export function followUpGuidance(answers: Answers, templates?: GuidanceTemplates): string | undefined {
	return yes(answers.good_moment) < 0.5 || yes(answers.still_relevant) < 0.5 ? renderGuidance(answers, ["follow_up.wait"], {}, templates) : undefined;
}
