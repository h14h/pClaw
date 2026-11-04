import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { skillDescription } from "./dashboard/files.ts";
import type { WorkerItem } from "./dashboard/types.ts";

/**
 * Muse Code as a worker harness: `muse exec` runs one turn of a Muse session headless and streams its events as JSONL.
 * pclaw keeps that stream as the job's transcript (`muse_<session id>.jsonl` beside pi's session files), reads the
 * report from the run's terminal event, and continues the same Muse session for follow-ups.
 */

/** The worker provider id that sends jobs to Muse Code instead of pi. */
export const MUSE = "muse";

/** Reasoning levels pclaw offers for Muse workers (Muse also has none and ultra). */
export const MUSE_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function museTranscript(sessionDir: string, sessionId: string): string {
	return join(sessionDir, `muse_${sessionId}.jsonl`);
}

/** Models Muse offers, from the catalog it caches; the configured one when that isn't readable. */
export function museModels(fallback: string): { id: string; name: string }[] {
	const dir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "muse", "model-catalog");
	const found = new Map<string, string>();
	try {
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
			const catalog = JSON.parse(readFileSync(join(dir, file), "utf8")) as { rows?: { model_id?: string; display_label?: string; visibility?: string; context_limit?: number | null }[] };
			for (const row of catalog.rows ?? []) {
				// Visible chat models: image and other non-chat models have no context limit.
				if (row.model_id !== undefined && row.visibility === "visible" && row.context_limit) found.set(row.model_id, row.display_label ?? row.model_id);
			}
		}
	} catch {}
	if (!found.has(fallback)) found.set(fallback, fallback);
	return [...found].map(([id, name]) => ({ id, name }));
}

/**
 * Put in front of a Muse session's first message: pclaw's worker prompt, then where its tools and skills are. Muse takes
 * no appended system prompt or extension, so they come as text and a command.
 */
export function musePreamble(options: { promptFile: string; cliFile: string; skills: string[] }): string {
	const cli = `${process.execPath} ${options.cliFile}`;
	const skills = options.skills
		.map((dir) => {
			const file = join(dir, "SKILL.md");
			const description = existsSync(file) ? skillDescription(file) : undefined;
			return `- ${basename(dir)}${description === undefined ? "" : ` (${description})`}: ${file}`;
		})
		.join("\n");
	return [
		readFileSync(options.promptFile, "utf8").trim(),
		"## Tools here",
		"Where these instructions or a skill say `search` or `read_page`, use your `web_search` and `web_fetch` tools. pclaw's own are commands, if those fail:",
		`- search: \`${cli} search "<query>" [--max 5]\``,
		`- read_page: \`${cli} read <url> [--find "a few words"] [--offset 8000]\``,
		`\`publish_page\` is a command: \`${cli} publish <slug>\`, run from this directory.`,
		"Don't schedule anything (no cron jobs or reminders): pclaw handles follow-ups.",
		...(skills === "" ? [] : ["Skills: when a job matches one, read its SKILL.md first and follow it.", skills]),
	].join("\n\n");
}

export function museArgs(options: { model: string; effort: string; sessionId: string; cwd: string }, prompt: string): string[] {
	return [
		"exec", "--json",
		"--model", options.model,
		"--reasoning-effort", options.effort === "off" ? "none" : options.effort,
		"--session-id", options.sessionId,
		"--workspace", options.cwd,
		// Headless, with the same reach pi workers have: nobody is there to approve, and Muse's bubblewrap sandbox
		// can't start on this box (Ubuntu restricts unprivileged user namespaces). The brief's rules are the gate.
		"--approval-mode", "never", "--disable-sandbox", "--disable-request-user-input",
		// pclaw's prompt and skills only, not the owner's personal Claude Code rules and skills.
		"--no-foreign-personal-context",
		prompt,
	];
}

type Payload = { kind?: string; terminal?: string; reason?: string | null; text?: string; prompt?: string; call_id?: string; correlation_facts?: { tool_name?: string; outcome?: string } };
/** `received_at` is pclaw's own (milliseconds): Muse's `recorded_at` isn't wall-clock time. */
type Event = { received_at?: number; payload?: Payload };

function parse(line: string): Event | undefined {
	try {
		return JSON.parse(line) as Event;
	} catch {
		return undefined;
	}
}

/** Collects one `muse exec --json` run: appends each event to the transcript and keeps the terminal one. */
export function museRun(transcript: string) {
	let buffered = "";
	let terminal: Payload | undefined;
	const take = (line: string) => {
		if (line.trim() === "") return;
		const event = parse(line);
		appendFileSync(transcript, `${event === undefined ? line : JSON.stringify({ received_at: Date.now(), ...event })}\n`, { mode: 0o600 });
		if (event?.payload?.kind === "run_terminal") terminal = event.payload;
	};
	return {
		write(chunk: string) {
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) take(line);
		},
		/** The run's outcome, or undefined when Muse ended without one. */
		finish(): { ok: boolean; output: string } | undefined {
			take(buffered);
			buffered = "";
			if (terminal === undefined) return undefined;
			const text = terminal.text?.trim() ?? "";
			if (terminal.terminal === "completed") return { ok: true, output: text || "(the worker finished without saying anything)" };
			return { ok: false, output: `Muse run ${terminal.terminal ?? "ended"}${terminal.reason ? `: ${terminal.reason}` : ""}${text ? `\n${text}` : ""}` };
		},
	};
}

const FROM_PCLAW = /^[\s\S]*?Message from pclaw:\s*/;

/** A Muse transcript as the worker's dashboard transcript. Tolerates a half-written last line. */
export function parseMuseSession(jsonl: string): WorkerItem[] {
	const items: WorkerItem[] = [];
	for (const line of jsonl.split("\n")) {
		const event = parse(line);
		const payload = event?.payload;
		if (payload === undefined) continue;
		const at = event?.received_at ?? 0;
		if (payload.kind === "turn_input_user" && payload.prompt !== undefined) {
			items.push({ kind: "from-pclaw", at, text: payload.prompt.replace(FROM_PCLAW, "") });
		} else if (payload.kind === "tool_result") {
			const name = payload.correlation_facts?.tool_name ?? "tool";
			const result = payload.text ?? "";
			let args: unknown = {};
			try {
				// Shell results carry the command they ran.
				const command = (JSON.parse(result) as { command?: unknown }).command;
				if (typeof command === "string") args = { command };
			} catch {}
			items.push({ kind: "tool", at, name, args, result, ...(payload.correlation_facts?.outcome === "failure" || result.startsWith("tool denied") ? { isError: true } : {}) });
		} else if (payload.kind === "run_terminal" && payload.text?.trim()) {
			items.push({ kind: "text", at, text: payload.text.trim() });
		}
	}
	return items;
}

/** Whether a worker session file is a Muse transcript (pi's session files are named <time>_<id>.jsonl). */
export function isMuseTranscript(file: string): boolean {
	return basename(file).startsWith("muse_") && existsSync(file);
}
