import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readPrompt } from "./prompts.ts";

/**
 * A decision model (Liquid's d1 family) as a source of hints. Given a state and named questions it returns
 * probabilities in one forward pass, with no generated text. Its answers pick sections of src/prompts/guidance.md, and
 * those reach the front model inside `<guidance>`, which it's free to ignore. Nothing here decides what pclaw does:
 * with no decision model configured, or when it's unreachable, there's simply no hint.
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
export type Site = "job-turn" | "message" | "project" | "follow-up";
export type Arm = "guided" | "control";
export type Decided = { id: string; site: Site; arm: Arm; answers: Answers };

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

export function decisionClient(options: {
	url?: string;
	logFile: string;
	holdout?: number;
	timeoutMs?: number;
	fetchFn?: typeof fetch;
}): Decisions {
	const { url, logFile, holdout = 0.2, timeoutMs = 2_500, fetchFn = fetch } = options;
	const record: Decisions["record"] = (event) => {
		try {
			appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
		} catch (error) {
			console.error("[pclaw] couldn't write the decision log", error);
		}
	};
	return {
		configured: url !== undefined,
		record,
		ask: async ({ id, site, state, questions, job, timeoutMs: limit = timeoutMs }) => {
			if (url === undefined) return undefined;
			const arm = armOf(id, holdout);
			const started = performance.now();
			const stateText = typeof state === "string" ? state : JSON.stringify(state);
			const base = { type: "decision", id, site, arm, templates: templatesVersion(), ...(job === undefined ? {} : { job }), state: stateText.slice(0, STATE_LOG_LIMIT) };
			try {
				const response = await fetchFn(`${url.replace(/\/$/, "")}/v1/decisions`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ state: stateText, questions }),
					signal: AbortSignal.timeout(limit),
				});
				if (!response.ok) throw new Error(`decision model returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
				const { answers } = (await response.json()) as { answers: Answers };
				const ms = Math.round(performance.now() - started);
				record({ ...base, ok: true, ms, answers });
				console.log(`[pclaw] decide ${site} ${arm} ${ms}ms ${brief(answers)}${job === undefined ? "" : ` job=${job}`}`);
				return { id, site, arm, answers };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				record({ ...base, ok: false, ms: Math.round(performance.now() - started), error: message });
				console.error(`[pclaw] decide ${site} failed, going without a hint: ${message}`);
				return undefined;
			}
		},
	};
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

function templatesVersion(): string {
	try {
		return createHash("sha256").update(readPrompt("guidance")).digest("hex").slice(0, 8);
	} catch {
		return "unknown";
	}
}

/** A `<guidance>` block from template names, with the raw read on top so the front model can weigh it. */
export function renderGuidance(answers: Answers, picks: string[], values: Record<string, string> = {}, templates = parseTemplates(readPrompt("guidance"))): string | undefined {
	const lines = picks.flatMap((name) => {
		const text = templates[name];
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
	worth_keeping: { type: "noul", instructions: "Does this message report an outcome someone would want to find later, like something shipped, built, decided, or learned?" },
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

export function turnGuidance(answers: Answers, facts: TurnFacts, templates?: Record<string, string>): string | undefined {
	const { outcome, surface } = readTurn(answers, facts);
	const picks = [`turn.${outcome}`];
	if (facts.ownerDriving) picks.push("owner_driving");
	if (facts.repeat) picks.push("no_news");
	picks.push(`surface.${surface}`);
	if (outcome === "finished") picks.push(yes(answers.worth_keeping) >= 0.5 ? "place.parent" : "place.thread");
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
				answer: "A reply from the assistant right now: chat, an opinion, a small question",
				quick_worker: "Research, a comparison, or a lookup that takes a few minutes",
				t3_job: "Real work on code, a repository, a game project, or a named machine",
			},
		},
		asks_status: { type: "noul", instructions: "Is the owner asking how something running is going, or whether it finished?" },
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

export function messageGuidance(answers: Answers, project?: { project: string; machine: string }, templates?: Record<string, string>): string | undefined {
	const picks: string[] = [];
	const size = pick(answers.job_size);
	if (size.choice === "t3_job" && size.p >= 0.5) {
		picks.push("message.t3_job");
		if (project !== undefined) picks.push("message.project");
	} else if (size.choice === "quick_worker" && size.p >= 0.5) picks.push("message.quick_worker");
	const inJob = pick(answers.in_job).choice;
	if (yes(answers.asks_status) >= 0.5 || inJob === "status") picks.push("message.status");
	else if (inJob === "steer") picks.push("message.steer");
	const noise = pick(answers.noise_feedback);
	if (noise.choice !== undefined && noise.choice !== "neither" && noise.p >= 0.5) picks.push(`message.${noise.choice}`);
	if (yes(answers.hard_to_undo) >= 0.5) picks.push("caution");
	return renderGuidance(answers, picks, project ?? {}, templates);
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

// Decision set: a follow-up came due.

export const followUpQuestions: Questions = {
	good_moment: { type: "noul", instructions: "Given the time and when the owner was last active, is this a reasonable moment to send this follow-up?" },
	still_relevant: { type: "noul", instructions: "Is this follow-up still relevant, or has recent conversation already handled it?" },
};

export function followUpGuidance(answers: Answers, templates?: Record<string, string>): string | undefined {
	return yes(answers.good_moment) < 0.5 || yes(answers.still_relevant) < 0.5 ? renderGuidance(answers, ["follow_up.wait"], {}, templates) : undefined;
}
