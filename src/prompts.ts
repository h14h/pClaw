import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The two prompts the owner edits, kept in the repo so changes are versioned. Read on every use, so an edit (from the
 * dashboard or a text editor) applies to the next model request.
 */
export const prompts = {
	front: {
		file: fileURLToPath(new URL("./prompts/front.md", import.meta.url)),
		path: "src/prompts/front.md",
		description: "The model you talk to: how it sounds and how pclaw works. This is its whole system prompt.",
	},
	worker: {
		file: fileURLToPath(new URL("./prompts/worker.md", import.meta.url)),
		path: "src/prompts/worker.md",
		description: "Added to the end of pi's default coding-agent prompt for every worker run.",
	},
} as const;

export type PromptName = keyof typeof prompts;

/** The memory pass's instructions. Not editable from the dashboard yet. */
const memoryPrompt = fileURLToPath(new URL("./prompts/memory.md", import.meta.url));

export function readPrompt(name: PromptName | "memory"): string {
	return readFileSync(name === "memory" ? memoryPrompt : prompts[name].file, "utf8");
}

export function writePrompt(name: PromptName, text: string): void {
	const { file } = prompts[name];
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, text.endsWith("\n") ? text : `${text}\n`);
	renameSync(temp, file);
}

/**
 * How to format messages for one app: src/prompts/formatting/<channel>.md. Picked by where the conversation lives, so
 * Telegram or WhatsApp get their own file when they're added.
 */
export function readFormatting(channel: string): string | undefined {
	if (!/^[a-z0-9-]+$/.test(channel)) return undefined;
	const file = fileURLToPath(new URL(`./prompts/formatting/${channel}.md`, import.meta.url));
	return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}
