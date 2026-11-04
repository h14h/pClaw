/** The prose lab page's API shapes. The web app (lab-web/) imports these with `import type`. */
import type { Check } from "./checks.ts";

export type Judgment = { natural: number; economy: number; substance: number; note: string };

export type Result = {
	variant: string;
	scenario: string;
	run: number;
	reply?: string;
	tools: string[];
	checks: Check[];
	judge?: Judgment;
	error?: string;
	ms: number;
};

export type Score = {
	variant: string;
	/** Replies that passed every platform check, of all replies. */
	clean: number;
	replied: number;
	errors: number;
	medianChars: number;
	medianWords: number;
	/** Judge means, when judged. */
	natural?: number;
	economy?: number;
	substance?: number;
	/** Failed check counts by rule. */
	failed: Record<string, number>;
};

export const THINKING = ["off", "minimal", "low", "medium", "high"] as const;
export type Thinking = (typeof THINKING)[number];

export type ScenarioSummary = { name: string; ask: string; messages: number; live?: string };

export type Setup = {
	model: string;
	judge: string;
	thinking: Thinking;
	platforms: string[];
	scenarios: ScenarioSummary[];
	/** pclaw's prompt today, by platform. */
	live: Record<string, string>;
};

/** One prompt under test. An empty prompt sends no system prompt at all. */
export type Contender = { label: string; prompt: string };

export type RunRequest = {
	contenders: Contender[];
	/** Saved scenarios by name. */
	scenarios: string[];
	/** Messages typed in for this run, each answered with no history. */
	typed: string[];
	runs: number;
	platform: string;
	judging: boolean;
	thinking: Thinking;
};

export type RunStatus = "running" | "done" | "stopped" | "failed";

export type RunSummary = {
	id: string;
	startedAt: number;
	finishedAt?: number;
	status: RunStatus;
	error?: string;
	labels: string[];
	done: number;
	total: number;
	scores: Score[];
};

export type RunView = RunSummary & {
	request: RunRequest;
	model: string;
	scenarios: ScenarioSummary[];
	/** Each contender is variant "0", "1", ... in its results, by position in request.contenders. */
	results: Result[];
};
