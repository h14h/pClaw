import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function expandPath(value: string): string {
	return resolve(REPO_ROOT, value.replace(/^~(?=$|\/)/, homedir()));
}

function here(name: string): string {
	return fileURLToPath(new URL(`./prompts/${name}`, import.meta.url));
}

export type PromptFeatureFlags = {
	allowT3?: boolean;
	allowPages?: boolean;
	/** Active channel ("telegram", "discord", etc.), for stripping channel-specific instructions. */
	channel?: string;
};

export type PromptResolverOptions = {
	profileDir?: string;
	personaDir?: string;
	voiceFile?: string;
};

export type PromptSpec = {
	readonly file: string;
	readonly name: string;
	readonly description: string;
};

const PROMPT_METADATA = {
	voice: {
		filename: "voice.md",
		name: "Voice",
		description: "How the model you talk to sounds. Each model profile or bot persona can supply its own.",
	},
	front: {
		filename: "front.md",
		name: "How pclaw works",
		description: "How the model you talk to works: delegation, jobs, memory, and message formats. It follows the voice guide.",
	},
	worker: {
		filename: "worker.md",
		name: "Worker prompt",
		description: "For every worker job: added to the end of pi's coding-agent prompt, or put in front of a Muse Code job's first message.",
	},
	memory: {
		filename: "memory.md",
		name: "Notes pass",
		description: "How the background pass decides what from a conversation goes into the notes.",
	},
	cleanup: {
		filename: "cleanup.md",
		name: "Nightly notes cleanup",
		description: "How the notes are tidied each night: checking new notes against the day's conversation, merging, and retiring what's out of date.",
	},
	compaction: {
		filename: "compaction.md",
		name: "Summarizing",
		description: "How older messages are summarized when a conversation gets long.",
	},
	episode: {
		filename: "episode.md",
		name: "Episode summary",
		description: "How ended sessions are distilled into short episodes for recent-episodes continuity and recall.",
	},
	guidance: {
		filename: "guidance.md",
		name: "Guidance templates",
		description: "The advice the decision model picks between, shown to the front model as a hint it can ignore.",
	},
} as const;

export type PromptName = keyof typeof PROMPT_METADATA;

export type PromptResolver = {
	readonly profileDir: string | undefined;
	readonly personaDir: string | undefined;
	readonly voiceFile: string | undefined;
	file(name: PromptName): string;
	read(name: PromptName): string;
	frontPrompt(flags?: PromptFeatureFlags): string;
	formattingFile(name: string): string;
	readFormatting(channel: string, flags?: PromptFeatureFlags): string | undefined;
	entries(): Record<PromptName, PromptSpec>;
};

/**
 * Strip T3 / machine-control and/or page-publishing instructions from the rendered `front.md`
 * when those capabilities are disabled, keeping `front.md` readable and editable as plain markdown.
 */
export function filterFrontPrompt(text: string, flags: PromptFeatureFlags = {}): string {
	let out = text;
	if (flags.allowT3 === false || flags.channel === "telegram") {
		out = out.replace(
			/ In a channel a thread opens under their message, and that thread is the session: updates, the result, and follow-ups all stay in it\. Each thread is its own conversation, and they may have several going\./g,
			"",
		);
	}
	if (flags.allowT3 === false) {
		out = out
			.replace(
				/, run commands on their machines \([^)]+\), and work in their code and repositories, GitHub included\./g,
				", analyze documents, and run code or scripts in their workspace.",
			)
			.replace(/ Would they want to open this later\? If not, it isn't a job\./g, "")
			.replace(/^- `start_job`[^\n]*\n?/gm, "")
			.replace(/`delegate` or `start_job`/g, "`delegate`")
			.replace(/^Other T3 tools are there when you need them:[^\n]*\n*/gm, "")
			.replace(
				/`<worker-report>` is a worker finishing, and `<job-update>` is a job's agent finishing a turn\. Both are for you, not them\./g,
				"`<worker-report>` is a worker finishing. It's for you, not them.",
			)
			.replace(/^A job's card already shows its status,[^\n]*\n*/gm, "")
			.replace(/ or `message_job`/g, "")
			.replace(/ Never guess how something is going: `list_jobs` has the real state\./g, " Never guess how something is going: `list_workers` has the real state.")
			.replace(/ If T3 is down, `start_job` still works: the job waits and starts itself\./g, "")
			.replace(/^`<job-result>` records how a job ended[^\n]*\n*/gm, "");
	}
	if (flags.allowPages === false) {
		out = out
			.replace(/ and private web pages/g, "")
			.replace(/, files, or pages\./g, ", or files.")
			.replace(/ For a web page, say so in the brief\./g, "");
	}
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip T3 / page-publishing references from a per-app formatting guide when disabled. */
export function filterFormattingPrompt(text: string, flags: PromptFeatureFlags = {}): string {
	let out = text;
	if (flags.allowT3 === false) {
		out = out.replace(/ \/ `start_job`/g, "");
	}
	if (flags.allowPages === false) {
		out = out.replace(/ and offer the full writeup as a page\./g, " and offer to send the full writeup as a file.");
	}
	return out.trim();
}

const REMOTE_BROWSER_GUIDANCE = [
	"- Use `agent-browser` (`open <url>`, `snapshot -i`, `click @ref`, `screenshot <path>`, `close`) when `web_fetch` misses JS-rendered content or prices, when a public search form needs interaction, or when capturing a visual/product image to save and report back.",
	"- Always run `agent-browser close` before finishing.",
	"- Never attempt to solve CAPTCHAs or anti-bot challenges; stop and report if blocked.",
].join("\n");

/**
 * Adapt `worker.md` for an isolated remote SSH VM sandbox (no pclaw systemd service rules,
 * rely on Muse's native `web_search` and `web_fetch` instead of host CLI tools, and add `agent-browser` guidance).
 */
export function filterWorkerPrompt(text: string, options: { remote?: boolean } = {}): string {
	let out = text;
	if (options.remote === true) {
		out = out
			.replace(/^- You run inside pclaw's service,[^\n]*\n?/gm, "")
			.replace(/Use `search` for the web:/g, "Use `web_search` for the web:")
			.replace(/Open a page with `read_page`/g, "Open a page with `web_fetch`");
		if (/^- Open a page with `web_fetch`[^\n]*$/m.test(out)) {
			out = out.replace(/^(- Open a page with `web_fetch`[^\n]*)$/m, `$1\n${REMOTE_BROWSER_GUIDANCE}`);
		} else {
			out = `${out.trimEnd()}\n\n${REMOTE_BROWSER_GUIDANCE}`;
		}
	}
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Per-bot prompt resolver without mutating shared module state.
 * Resolution order:
 *   1. `voiceFile` (for `voice` only)
 *   2. `personaDir/<filename>` if present
 *   3. `profileDir/<filename>` if present
 *   4. shared `src/prompts/<filename>`
 */
export function createPromptResolver(options: PromptResolverOptions = {}): PromptResolver {
	const profileDir = options.profileDir;
	const personaDir = options.personaDir === undefined ? undefined : expandPath(options.personaDir);
	const voiceFile = options.voiceFile === undefined ? undefined : expandPath(options.voiceFile);

	function resolveFilename(filename: string): string {
		if (filename === "voice.md" && voiceFile !== undefined) return voiceFile;
		if (personaDir !== undefined) {
			const fromPersona = join(personaDir, filename);
			if (existsSync(fromPersona)) return fromPersona;
		}
		if (profileDir !== undefined) {
			const fromProfile = join(profileDir, filename);
			if (existsSync(fromProfile)) return fromProfile;
		}
		return here(filename);
	}

	const file = (name: PromptName) => resolveFilename(PROMPT_METADATA[name].filename);
	const read = (name: PromptName) => readFileSync(file(name), "utf8");
	const formattingFileFor = (name: string) => resolveFilename(`formatting/${name}`);

	return {
		profileDir,
		personaDir,
		voiceFile,
		file,
		read,
		frontPrompt(flags?: PromptFeatureFlags) {
			const voice = read("voice").trim();
			const front = filterFrontPrompt(read("front"), flags);
			return `${voice}\n\n${front}`;
		},
		formattingFile: formattingFileFor,
		readFormatting(channel: string, flags?: PromptFeatureFlags) {
			if (!/^[a-z0-9-]+$/.test(channel)) return undefined;
			const target = formattingFileFor(`${channel}.md`);
			if (!existsSync(target)) return undefined;
			return filterFormattingPrompt(readFileSync(target, "utf8"), flags);
		},
		entries() {
			const record = {} as Record<PromptName, PromptSpec>;
			for (const name of Object.keys(PROMPT_METADATA) as PromptName[]) {
				const meta = PROMPT_METADATA[name];
				record[name] = {
					get file() {
						return file(name);
					},
					name: meta.name,
					description: meta.description,
				};
			}
			return record;
		},
	};
}

/** The active model profile's folder for legacy module-level helpers. */
let profileDir: string | undefined;

export function useProfile(dir: string): void {
	profileDir = dir;
}

function defaultResolver(): PromptResolver {
	return createPromptResolver(profileDir === undefined ? {} : { profileDir });
}

/**
 * The prompts, kept in the repo so changes are versioned. Read on every use, so an edit (from the dashboard or a text
 * editor) applies to the next model request.
 */
export const prompts: Record<PromptName, PromptSpec> = {
	voice: {
		get file() {
			return defaultResolver().file("voice");
		},
		name: PROMPT_METADATA.voice.name,
		description: PROMPT_METADATA.voice.description,
	},
	front: {
		get file() {
			return defaultResolver().file("front");
		},
		name: PROMPT_METADATA.front.name,
		description: PROMPT_METADATA.front.description,
	},
	worker: {
		get file() {
			return defaultResolver().file("worker");
		},
		name: PROMPT_METADATA.worker.name,
		description: PROMPT_METADATA.worker.description,
	},
	memory: {
		get file() {
			return defaultResolver().file("memory");
		},
		name: PROMPT_METADATA.memory.name,
		description: PROMPT_METADATA.memory.description,
	},
	cleanup: {
		get file() {
			return defaultResolver().file("cleanup");
		},
		name: PROMPT_METADATA.cleanup.name,
		description: PROMPT_METADATA.cleanup.description,
	},
	compaction: {
		get file() {
			return defaultResolver().file("compaction");
		},
		name: PROMPT_METADATA.compaction.name,
		description: PROMPT_METADATA.compaction.description,
	},
	episode: {
		get file() {
			return defaultResolver().file("episode");
		},
		name: PROMPT_METADATA.episode.name,
		description: PROMPT_METADATA.episode.description,
	},
	guidance: {
		get file() {
			return defaultResolver().file("guidance");
		},
		name: PROMPT_METADATA.guidance.name,
		description: PROMPT_METADATA.guidance.description,
	},
};

export function readPrompt(name: PromptName): string {
	return defaultResolver().read(name);
}

/** The whole system prompt's first part: the voice, then how pclaw works. */
export function frontPrompt(flags?: PromptFeatureFlags): string {
	return defaultResolver().frontPrompt(flags);
}

/** Where the per-app formatting files live: <dir>/<channel>.md. */
export const formattingDir = here("formatting");

/**
 * How to format messages for one app: src/prompts/formatting/<channel>.md. Picked by where the conversation lives, so
 * Telegram or WhatsApp get their own file when they're added.
 */
export function readFormatting(channel: string, flags?: PromptFeatureFlags): string | undefined {
	return defaultResolver().readFormatting(channel, flags);
}

/** The active profile's formatting file, else the shared one. */
export function formattingFile(name: string): string {
	return defaultResolver().formattingFile(name);
}
