import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The prompts, kept in the repo so changes are versioned. Read on every use, so an edit (from the dashboard or a text
 * editor) applies to the next model request.
 */
export const prompts = {
	front: {
		file: here("front.md"),
		name: "Front prompt",
		description: "The model you talk to: how it sounds and how pclaw works. This is its whole system prompt.",
	},
	worker: {
		file: here("worker.md"),
		name: "Worker prompt",
		description: "Added to the end of pi's default coding-agent prompt for every worker run.",
	},
	memory: {
		file: here("memory.md"),
		name: "Notes pass",
		description: "How the background pass decides what from a conversation goes into the notes.",
	},
	compaction: {
		file: here("compaction.md"),
		name: "Summarizing",
		description: "How older messages are summarized when a conversation gets long.",
	},
} as const;

export type PromptName = keyof typeof prompts;

function here(name: string): string {
	return fileURLToPath(new URL(`./prompts/${name}`, import.meta.url));
}

export function readPrompt(name: PromptName): string {
	return readFileSync(prompts[name].file, "utf8");
}

/** Where the per-app formatting files live: <dir>/<channel>.md. */
export const formattingDir = here("formatting");

/**
 * How to format messages for one app: src/prompts/formatting/<channel>.md. Picked by where the conversation lives, so
 * Telegram or WhatsApp get their own file when they're added.
 */
export function readFormatting(channel: string): string | undefined {
	if (!/^[a-z0-9-]+$/.test(channel)) return undefined;
	const file = join(formattingDir, `${channel}.md`);
	return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}
