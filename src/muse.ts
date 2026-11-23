import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { skillDescription } from "./dashboard/files.ts";
import type { WorkerItem } from "./dashboard/types.ts";
import { filterWorkerPrompt } from "./prompts.ts";

/**
 * Muse Code as a worker harness: `muse serve` runs an MSP v1 JSON-RPC session over stdio so workers support
 * live mid-turn steering (`turn/steer`), queueing (`turn/start` with `ifBusy: "queue"`), and clean interrupts
 * (`turn/interrupt`). pclaw logs the MSP event stream to `muse_<session id>.jsonl` beside pi's session files,
 * parses both MSP v1 and legacy `muse exec --json` transcripts, and continues the same Muse session for follow-ups.
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
 * How a worker hands pclaw pictures to send: real, checked image files with exact paths and captions in the report.
 * `dir` is where it saves them.
 */
export function imageContract(dir: string): string {
	const where = dir.endsWith("/") ? dir : `${dir}/`;
	return [
		"## Images",
		`When the person asks for images or photos, or a product or visual comparison would clearly be better with them, save 1–4 clean images into \`${where}\`: .jpg, .png, or .webp, straight from the source image URL (not a page, not a thumbnail sprite).`,
		"Check every file before you list it: the download returned HTTP 200, and the file is a real, non-empty image (`file <path>` says JPEG, PNG, or WebP image data, or the first bytes are the image's magic number). Delete and skip anything that's an HTML page, an error, or empty. Never list an image you didn't verify.",
		`In your report, under "Images", list each one as its exact \`${where}...\` path and a short caption (what it shows, and the source).`,
	].join("\n\n");
}

/**
 * Put in front of a Muse session's first message: pclaw's worker prompt, then where its tools and skills are. Muse takes
 * no appended system prompt or extension, so they come as text and a command.
 *
 * When `remote: true` (an isolated SSH VM sandbox), uses a VM-safe preamble: relies on Muse's native `web_search` and
 * `web_fetch`, omits host `worker-cli.ts` paths, omits `systemctl --user restart pclaw`, omits `publish_page`, and omits
 * host-local skill paths.
 */
export function musePreamble(options: {
	promptFile: string;
	cliFile: string;
	skills: string[];
	allowPages?: boolean;
	remote?: boolean;
	/** The local workspace, where images are saved. */
	cwd?: string;
}): string {
	const workerPrompt = filterWorkerPrompt(readFileSync(options.promptFile, "utf8"), { remote: options.remote });
	if (options.remote === true) {
		return [
			workerPrompt,
			"## Tools here",
			"Use your built-in `web_search` and `web_fetch` tools when instructions say `search` or `read_page`.",
			"Don't schedule anything (no cron jobs or reminders): pclaw handles follow-ups.",
			"Put files you create in this workspace directory and report their exact paths so pclaw can send them to the user.",
			imageContract("~/work/"),
		].join("\n\n");
	}
	const allowPages = options.allowPages !== false;
	const cli = `${process.execPath} ${options.cliFile}`;
	const visibleSkills = allowPages ? options.skills : options.skills.filter((dir) => basename(dir) !== "web-page");
	const skills = visibleSkills
		.map((dir) => {
			const file = join(dir, "SKILL.md");
			const description = existsSync(file) ? skillDescription(file) : undefined;
			return `- ${basename(dir)}${description === undefined ? "" : ` (${description})`}: ${file}`;
		})
		.join("\n");
	return [
		workerPrompt,
		"## Tools here",
		"Where these instructions or a skill say `search` or `read_page`, use your `web_search` and `web_fetch` tools. pclaw's own are commands, if those fail:",
		`- search: \`${cli} search "<query>" [--max 5]\``,
		`- read_page: \`${cli} read <url> [--find "a few words"] [--offset 8000]\``,
		...(allowPages ? [`\`publish_page\` is a command: \`${cli} publish <slug>\`, run from this directory.`] : []),
		"Don't schedule anything (no cron jobs or reminders): pclaw handles follow-ups.",
		...(skills === "" ? [] : ["Skills: when a job matches one, read its SKILL.md first and follow it.", skills]),
		imageContract(options.cwd ?? "."),
	].join("\n\n");
}

export function museServeArgs(options: { model: string }): string[] {
	return [
		"serve",
		"--model", options.model,
		// Headless, with the same reach pi workers have: approvalMode is set to "allowAll" on the wire,
		// and Muse's bubblewrap sandbox can't start on Ubuntu boxes that restrict unprivileged user namespaces.
		// Omitting `--trust-workspace` keeps workspace skills/rules untrusted by default.
		"--disable-sandbox",
		"--disable-request-user-input",
	];
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

type Payload = {
	kind?: string;
	terminal?: string;
	reason?: string | null;
	text?: string;
	prompt?: string;
	call_id?: string;
	tool_name?: string;
	arguments?: Record<string, unknown>;
	input?: Record<string, unknown>;
	correlation_facts?: { tool_name?: string; outcome?: string };
};
type MspItemPayload = {
	itemId?: string;
	kind?: string;
	status?: string;
	text?: string;
	tool?: string;
	args?: string;
	visibleOutput?: string;
	failureReason?: string;
	commandText?: string;
	fallbackText?: string;
};

/** `received_at` is pclaw's own (milliseconds): Muse's `recorded_at` isn't wall-clock time. */
type Event = {
	received_at?: number;
	payload?: Payload;
	method?: string;
	params?: { item?: MspItemPayload; terminal?: string; reason?: string; error?: { message?: string } };
};

function parse(line: string): Event | undefined {
	try {
		return JSON.parse(line) as Event;
	} catch {
		return undefined;
	}
}

function parseToolArgs(raw: string | undefined): unknown {
	if (raw === undefined || raw.trim() === "") return {};
	try {
		return JSON.parse(raw);
	} catch {
		return { raw };
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

/** A Muse transcript (MSP v1 or legacy `muse exec`) as the worker's dashboard transcript. Tolerates a half-written last line. */
export function parseMuseSession(jsonl: string): WorkerItem[] {
	const items: WorkerItem[] = [];
	const callArgs = new Map<string, Record<string, unknown>>();
	const mspIndex = new Map<string, number>();

	const upsertMsp = (itemId: string | undefined, item: WorkerItem) => {
		if (itemId === undefined) {
			items.push(item);
			return;
		}
		const idx = mspIndex.get(itemId);
		if (idx !== undefined) {
			items[idx] = item;
		} else {
			mspIndex.set(itemId, items.length);
			items.push(item);
		}
	};

	for (const line of jsonl.split("\n")) {
		const event = parse(line);
		if (event === undefined) continue;
		const at = event.received_at ?? 0;

		// MSP v1 notifications (`{ received_at, method, params }`)
		if (event.method !== undefined && event.params !== undefined) {
			const item = event.params.item;
			if (item === undefined || typeof item.kind !== "string") continue;

			if (item.kind === "userMessage" && event.method === "item/completed" && typeof item.text === "string") {
				upsertMsp(item.itemId, { kind: "from-pclaw", at, text: item.text.replace(FROM_PCLAW, "") });
			} else if (
				item.kind === "toolCall" &&
				(event.method === "item/started" || event.method === "item/updated" || event.method === "item/completed")
			) {
				const name = item.tool ?? "tool";
				const result = item.visibleOutput ?? item.failureReason ?? "";
				let args = parseToolArgs(item.args);
				if (typeof args === "object" && args !== null && result !== "") {
					try {
						const parsed = JSON.parse(result) as Record<string, unknown>;
						if (typeof parsed === "object" && parsed !== null) {
							const picked: Record<string, unknown> = { ...(args as Record<string, unknown>) };
							for (const key of ["command", "query", "url", "path", "file_path"] as const) {
								if (typeof parsed[key] === "string" && picked[key] === undefined) picked[key] = parsed[key];
							}
							args = picked;
						}
					} catch {}
				}
				const isError =
					item.status === "failed" ||
					item.status === "rejected" ||
					item.status === "timedOut" ||
					item.status === "cancelled" ||
					result.startsWith("tool denied");
				upsertMsp(item.itemId, { kind: "tool", at, name, args, result, ...(isError ? { isError: true } : {}) });
			} else if (item.kind === "webSearch" && event.method === "item/completed") {
				upsertMsp(item.itemId, {
					kind: "tool",
					at,
					name: "web_search",
					args: item.fallbackText ? { query: item.fallbackText } : {},
					result: item.text ?? item.fallbackText ?? "",
				});
			} else if (item.kind === "agentMessage" && event.method === "item/completed" && item.text?.trim()) {
				upsertMsp(item.itemId, { kind: "text", at, text: item.text.trim() });
			}
			continue;
		}

		// Legacy `muse exec --json` events (`{ received_at, payload }`)
		const payload = event.payload;
		if (payload === undefined) continue;
		if (payload.kind === "tool_call" && payload.call_id !== undefined) {
			const args = payload.arguments ?? payload.input;
			if (args !== undefined && typeof args === "object") callArgs.set(payload.call_id, args);
		} else if (payload.kind === "turn_input_user" && payload.prompt !== undefined) {
			items.push({ kind: "from-pclaw", at, text: payload.prompt.replace(FROM_PCLAW, "") });
		} else if (payload.kind === "tool_result") {
			const name = payload.correlation_facts?.tool_name ?? payload.tool_name ?? "tool";
			const result = payload.text ?? "";
			let args: unknown = payload.call_id !== undefined ? (callArgs.get(payload.call_id) ?? {}) : {};
			try {
				// Shell and JSON tool results often carry command / query / path / url metadata.
				const parsed = JSON.parse(result) as Record<string, unknown>;
				if (typeof parsed === "object" && parsed !== null) {
					const picked: Record<string, unknown> = typeof args === "object" && args !== null ? { ...(args as Record<string, unknown>) } : {};
					for (const key of ["command", "query", "url", "path", "file_path"] as const) {
						if (typeof parsed[key] === "string" && picked[key] === undefined) picked[key] = parsed[key];
					}
					args = picked;
				}
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
