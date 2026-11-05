import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The active model profile's folder. Its .md files override the shared ones here by name. */
let profileDir: string | undefined;

export function useProfile(dir: string): void {
	profileDir = dir;
}

/** The active profile's copy of a prompt file, else the shared one. */
function resolved(name: string): string {
	const own = profileDir === undefined ? undefined : join(profileDir, name);
	return own !== undefined && existsSync(own) ? own : here(name);
}

/**
 * The prompts, kept in the repo so changes are versioned. Read on every use, so an edit (from the dashboard or a text
 * editor) applies to the next model request.
 */
export const prompts = {
	voice: {
		get file() {
			return resolved("voice.md");
		},
		name: "Voice",
		description: "How the model you talk to sounds. Each model profile has its own, tuned to that model.",
	},
	front: {
		get file() {
			return resolved("front.md");
		},
		name: "How pclaw works",
		description: "How the model you talk to works: delegation, jobs, memory, and message formats. It follows the voice guide.",
	},
	worker: {
		get file() {
			return resolved("worker.md");
		},
		name: "Worker prompt",
		description: "For every worker job: added to the end of pi's coding-agent prompt, or put in front of a Muse Code job's first message.",
	},
	memory: {
		get file() {
			return resolved("memory.md");
		},
		name: "Notes pass",
		description: "How the background pass decides what from a conversation goes into the notes.",
	},
	compaction: {
		get file() {
			return resolved("compaction.md");
		},
		name: "Summarizing",
		description: "How older messages are summarized when a conversation gets long.",
	},
	guidance: {
		get file() {
			return resolved("guidance.md");
		},
		name: "Guidance templates",
		description: "The advice the decision model picks between, shown to the front model as a hint it can ignore.",
	},
};

export type PromptName = keyof typeof prompts;

function here(name: string): string {
	return fileURLToPath(new URL(`./prompts/${name}`, import.meta.url));
}

export function readPrompt(name: PromptName): string {
	return readFileSync(prompts[name].file, "utf8");
}

/** The whole system prompt's first part: the voice, then how pclaw works. */
export function frontPrompt(): string {
	return `${readPrompt("voice").trim()}\n\n${readPrompt("front").trim()}`;
}

/** Where the per-app formatting files live: <dir>/<channel>.md. */
export const formattingDir = here("formatting");

/**
 * How to format messages for one app: src/prompts/formatting/<channel>.md. Picked by where the conversation lives, so
 * Telegram or WhatsApp get their own file when they're added.
 */
export function readFormatting(channel: string): string | undefined {
	if (!/^[a-z0-9-]+$/.test(channel)) return undefined;
	const file = formattingFile(`${channel}.md`);
	return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

/** The active profile's formatting file, else the shared one. */
export function formattingFile(name: string): string {
	return resolved(`formatting/${name}`);
}
