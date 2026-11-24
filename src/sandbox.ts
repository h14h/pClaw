import { spawn } from "node:child_process";
import {
	copyFileSync,
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config, UserSandboxConfig } from "./config.ts";
import { isPagesEnabled } from "./config.ts";
import { runLocalWorker, type WorkerOptions, type WorkerResult } from "./extensions/workers.ts";
import { MUSE, musePreamble, museTranscript } from "./muse.ts";
import { type LiveWorkerHandle, PCLAW_PWD_PREFIX, runMuseMsp } from "./muse-msp.ts";
import { SLUG } from "./pages.ts";
import type { ResolvedUser, UserRegistry } from "./users.ts";

const REPORT_LIMIT = 12_000;
const DEFAULT_SSH_WORK_DIR = "~/work";
const DEFAULT_SSH_INBOX_DIR = "~/inbox";
const DEFAULT_SSH_SITE_DIR = "~/site";
const DEFAULT_SSH_MUSE_BIN = "~/.local/bin/muse";
const SSH_FILE_TIMEOUT_MS = 120_000;
const SSH_CLEANUP_TIMEOUT_MS = 5_000;
export const MAX_PAGES_BYTES = 25 * 1024 * 1024;
const MAX_PAGES_ARCHIVE_BYTES = 26 * 1024 * 1024;

const EXTERNAL_HTML_PATTERNS = [
	/<script\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//gi,
	/<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\//gi,
	/<link\b[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\/[^>]*\brel\s*=\s*["']?stylesheet["']?/gi,
	/<(img|iframe|source|video|audio|embed|object|track)\b[^>]*\b(src|srcset|data)\s*=\s*["']?\s*(https?:)?\/\//gi,
];
const EXTERNAL_CSS_PATTERNS = [
	/url\(\s*["']?\s*(https?:)?\/\//gi,
	/@import\s+(?:url\(\s*)?["']?\s*(https?:)?\/\//gi,
];
/** Best-effort remote teardown for any headless browser processes left on an SSH VM after a worker run. */
export const REMOTE_BROWSER_CLEANUP_COMMAND =
	'export PATH="$HOME/.local/bin:$PATH"; agent-browser close >/dev/null 2>&1 || true; pkill -f \'[a]gent-browser-linux|[.]agent-browser/browsers/|[c]hrome-headless-shell|[c]hromium\' >/dev/null 2>&1 || true';
/** ssh exits 255 for its own failures (connection refused, reset, auth): the remote command never ran. */
const SSH_OWN_FAILURE = 255;
const SSH_RETRY_DELAY_MS = 1_000;

/** An ssh command that exited non-zero, with its code. */
export class SshExitError extends Error {
	readonly code: number | null;
	constructor(message: string, code: number | null) {
		super(message);
		this.name = "SshExitError";
		this.code = code;
	}
}

/** Run `attempt`, and once more after a short wait if ssh itself failed (exit 255). */
export async function retrySshFailure<T>(attempt: () => Promise<T>, signal?: AbortSignal, delayMs = SSH_RETRY_DELAY_MS): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		if (!(error instanceof SshExitError) || error.code !== SSH_OWN_FAILURE || signal?.aborted === true) throw error;
		console.warn(`[pclaw] ${error.message.split("\n")[0]}; retrying once`);
		await sleep(delayMs, undefined, signal === undefined ? undefined : { signal });
		return attempt();
	}
}

export const SSH_BASE_ARGS = [
	"-o", "BatchMode=yes",
	"-o", "StrictHostKeyChecking=accept-new",
	"-o", "ConnectTimeout=15",
] as const;

export type SandboxRunRequest = {
	sessionId: string;
	sessionDir: string;
	message: string;
	thinking: string;
	job: { provider: string; model: string };
	signal?: AbortSignal;
	timeoutMs: number;
	workerOptions: WorkerOptions;
	onHandle?: (handle: LiveWorkerHandle) => void;
};

export type SandboxFile = {
	data: Uint8Array;
	filename: string;
	sizeBytes: number;
};

/**
 * Pluggable worker execution & file-staging boundary.
 * - `local`: runs workers directly on the host in a user/bot local workDir.
 * - `ssh`: runs Muse Code inside a pre-provisioned persistent exe.dev VM over SSH.
 */
export interface WorkerSandbox {
	readonly type: "local" | "ssh";
	readonly workDir: string;
	readonly inboxDir: string;
	prepare(): void;
	runWorker(req: SandboxRunRequest): Promise<WorkerResult>;
	putFile(localPath: string, filename: string, signal?: AbortSignal): Promise<string>;
	getFile(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<SandboxFile>;
	syncPages?(targetDir: string, slug: string, signal?: AbortSignal): Promise<{ fileCount: number; totalBytes: number }>;
}

/** Strict POSIX single-quote escaping: safe for arbitrary strings (newlines, $, backticks, quotes). */
export function shellQuote(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Turn a remote path into a safe POSIX shell expression that expands a leading `~/` to `$HOME/`
 * while single-quoting everything else.
 */
export function remotePathExpr(remotePath: string): string {
	if (remotePath === "~") return '"$HOME"';
	if (remotePath.startsWith("~/")) return `"$HOME"/${shellQuote(remotePath.slice(2))}`;
	return shellQuote(remotePath);
}

/** Sanitize an untrusted filename so it cannot contain directory separators or control characters. */
export function sanitizeFilename(name: string): string {
	const base = basename(name).replace(/[\x00-\x1f/\\:*?"<>|]/g, "_").trim();
	return base === "" || base === "." || base === ".." ? "file" : base.slice(0, 120);
}

function validateFilePathInput(filePath: string): string {
	const trimmed = filePath.trim();
	if (trimmed === "") throw new Error("File path cannot be empty.");
	if (/[\x00-\x1f]/.test(trimmed)) throw new Error("File path contains invalid control characters.");
	if (trimmed.split(/[\\/]/).includes("..")) throw new Error(`Path "${filePath}" cannot contain ".." segments.`);
	return trimmed;
}

function validateSshHost(host: string): string {
	const trimmed = host.trim();
	if (trimmed === "" || trimmed.startsWith("-") || /[\s\x00-\x1f]/.test(trimmed)) {
		throw new Error(`Invalid SSH host "${host}".`);
	}
	return trimmed;
}

function isWithinRoot(targetReal: string, rootReal: string): boolean {
	const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
	return targetReal.startsWith(prefix);
}

function clip(text: string): string {
	return text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT)}\n[report cut off at ${REPORT_LIMIT} characters]` : text;
}

/** Minimal environment for SSH subprocesses: never leaks mp1's API keys or bot tokens. */
export function sshEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: source.HOME ?? homedir(),
	};
	for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "SSH_AUTH_SOCK"] as const) {
		if (source[key] !== undefined) env[key] = source[key];
	}
	return env;
}

export function createLocalSandbox(options: {
	workDir: string;
	inboxDir: string;
	allowPages?: boolean;
}): WorkerSandbox {
	const workDir = resolve(options.workDir.replace(/^~(?=$|\/)/, homedir()));
	const inboxDir = resolve(options.inboxDir.replace(/^~(?=$|\/)/, homedir()));

	return {
		type: "local",
		workDir,
		inboxDir,
		prepare() {
			mkdirSync(workDir, { recursive: true, mode: 0o700 });
			mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
		},
		runWorker(req) {
			mkdirSync(workDir, { recursive: true, mode: 0o700 });
			mkdirSync(req.sessionDir, { recursive: true, mode: 0o700 });
			const effective: WorkerOptions = {
				...req.workerOptions,
				cwd: workDir,
				sessionDir: req.sessionDir,
				...(options.allowPages === undefined ? {} : { allowPages: options.allowPages }),
			};
			return runLocalWorker(effective, req.sessionId, req.message, req.signal, req.thinking, req.job, req.onHandle);
		},
		async putFile(localPath, filename) {
			mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
			const realInbox = realpathSync(inboxDir);
			const realSrc = realpathSync(localPath);
			if (isWithinRoot(realSrc, realInbox)) return localPath;
			const dest = join(inboxDir, sanitizeFilename(filename));
			copyFileSync(localPath, dest);
			return dest;
		},
		async getFile(filePath, maxBytes) {
			const clean = validateFilePathInput(filePath);
			const expanded = clean.replace(/^~(?=$|\/)/, homedir());
			const candidate = expanded.startsWith("/") ? resolve(expanded) : resolve(workDir, expanded);
			if (!existsSync(candidate)) throw new Error(`File not found: ${filePath}`);
			const realTarget = realpathSync(candidate);
			const allowedRoots = [workDir, inboxDir]
				.filter((root) => existsSync(root))
				.map((root) => realpathSync(root));
			if (!allowedRoots.some((root) => isWithinRoot(realTarget, root))) {
				throw new Error(`Access denied: "${filePath}" is outside the allowed workspace/inbox.`);
			}
			const stat = statSync(realTarget);
			if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
			if (stat.size > maxBytes) {
				throw new Error(`File "${basename(realTarget)}" is too large (${stat.size} bytes, limit ${maxBytes} bytes).`);
			}
			const data = new Uint8Array(readFileSync(realTarget));
			if (data.byteLength > maxBytes) {
				throw new Error(`File "${basename(realTarget)}" exceeds limit (${maxBytes} bytes).`);
			}
			return { data, filename: basename(realTarget), sizeBytes: data.byteLength };
		},
	};
}

export type SshSandboxOptions = {
	host: string;
	workDir?: string;
	inboxDir?: string;
	siteDir?: string;
	museBin?: string;
	allowPages?: boolean;
	/** Injectable for tests (defaults to "ssh"). */
	sshCommand?: string;
	spawnFn?: typeof spawn;
	/** Wait before retrying after ssh's own failure (exit 255). */
	retryDelayMs?: number;
	/** Remote teardown command run after every worker run finishes, aborts, or times out. */
	cleanupCommand?: string;
	/** Timeout in milliseconds for post-run remote browser teardown (default 5000). */
	cleanupTimeoutMs?: number;
};

/** Build the remote POSIX shell command that launches `muse serve` (MSP v1 over stdio) in `workDir`. */
export function buildRemoteMuseServeCommand(options: {
	museBin: string;
	workDir: string;
	model: string;
}): string {
	const workExpr = remotePathExpr(options.workDir);
	const museExpr = remotePathExpr(options.museBin);
	return [
		"set -e",
		'export PATH="$HOME/.local/bin:$PATH"',
		`mkdir -p ${workExpr}`,
		`cd ${workExpr}`,
		`printf '${PCLAW_PWD_PREFIX}%s\\n' "$PWD"`,
		`exec ${museExpr} serve --model ${shellQuote(options.model)} --disable-sandbox --disable-request-user-input`,
	].join("; ");
}

/** Build the remote POSIX shell command that reads the prompt from stdin and runs `muse exec --json` (legacy). */
export function buildRemoteMuseCommand(options: {
	museBin: string;
	workDir: string;
	model: string;
	effort: string;
	sessionId: string;
}): string {
	const workExpr = remotePathExpr(options.workDir);
	const museExpr = remotePathExpr(options.museBin);
	const effort = options.effort === "off" ? "none" : options.effort;
	return [
		"set -e",
		'export PATH="$HOME/.local/bin:$PATH"',
		`mkdir -p ${workExpr}`,
		`cd ${workExpr}`,
		'prompt_file=$(mktemp)',
		`trap 'rm -f "$prompt_file"' EXIT`,
		'cat > "$prompt_file"',
		`${museExpr} exec --json` +
			` --model ${shellQuote(options.model)}` +
			` --reasoning-effort ${shellQuote(effort)}` +
			` --session-id ${shellQuote(options.sessionId)}` +
			' --workspace "$PWD"' +
			" --approval-mode never --disable-sandbox --disable-request-user-input --no-foreign-personal-context" +
			' "$(cat "$prompt_file")" < /dev/null',
	].join("; ");
}

/** Build the remote POSIX shell command that writes stdin into `<inboxDir>/<filename>` atomically. */
export function buildRemotePutCommand(inboxDir: string, filename: string): string {
	const inboxExpr = remotePathExpr(inboxDir);
	const safe = sanitizeFilename(filename);
	return [
		"set -e",
		`mkdir -p ${inboxExpr}`,
		`cd ${inboxExpr}`,
		`dest="$PWD/"${shellQuote(safe)}`,
		'tmp="${dest}.tmp.$$"',
		`trap 'rm -f "$tmp"' EXIT`,
		'cat > "$tmp"',
		'mv -f "$tmp" "$dest"',
		'printf "%s\\n" "$dest"',
	].join("; ");
}

/** Build the remote POSIX shell command that enforces realpath confinement + maxBytes and streams file bytes. */
export function buildRemoteGetCommand(workDir: string, inboxDir: string, remotePath: string, maxBytes: number): string {
	const workExpr = remotePathExpr(workDir);
	const inboxExpr = remotePathExpr(inboxDir);
	const reqExpr = remotePathExpr(remotePath);
	const limit = Math.max(0, Math.floor(maxBytes));
	return [
		"set -e",
		`work_root=$(realpath -m ${workExpr})`,
		`inbox_root=$(realpath -m ${inboxExpr})`,
		`req=${reqExpr}`,
		'case "$req" in /*) candidate="$req" ;; *) candidate="$work_root/$req" ;; esac',
		'target=$(realpath -e "$candidate" 2>/dev/null) || { echo "File not found" >&2; exit 2; }',
		'[ -f "$target" ] || { echo "Not a regular file" >&2; exit 3; }',
		'case "$target" in "$work_root"/*|"$inbox_root"/*) ;; *) echo "Path outside allowed sandbox roots" >&2; exit 4 ;; esac',
		'size=$(wc -c < "$target")',
		`if [ "$size" -gt ${limit} ]; then echo "File exceeds size limit ($size > ${limit} bytes)" >&2; exit 5; fi`,
		'cat "$target"',
	].join("; ");
}

/** Build the remote POSIX shell command that streams `<siteDir>/dist` as a gzipped tar archive to stdout. */
export function buildRemoteSyncPagesCommand(siteDir: string = DEFAULT_SSH_SITE_DIR): string {
	const distPath = `${siteDir.replace(/\/+$/, "")}/dist`;
	const distExpr = remotePathExpr(distPath);
	return [
		"set -e",
		`dist=${distExpr}`,
		'[ -d "$dist" ] || { echo "Built site dist directory not found: $dist" >&2; exit 2; }',
		'tar -czf - -C "$dist" .',
	].join("; ");
}

/**
 * Verify an extracted pages staging directory before atomically swapping it into production:
 * - only regular files and directories (no symlinks, FIFOs, sockets, or devices)
 * - total size <= 25 MiB
 * - `<stagingDir>/index.html` and `<stagingDir>/<slug>/index.html` exist
 * - no HTML or CSS file references external `http(s)://` or `//` script/stylesheet/media assets
 */
export function validateStagedPages(stagingDir: string, slug: string): { fileCount: number; totalBytes: number } {
	if (!SLUG.test(slug)) {
		throw new Error(`Invalid page slug "${slug}". Use 1-63 lowercase letters, digits, or hyphens.`);
	}
	const root = resolve(stagingDir);
	let fileCount = 0;
	let totalBytes = 0;
	const problems: string[] = [];

	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const rel = full.slice(root.length + 1);
			const st = lstatSync(full);
			if (st.isSymbolicLink()) {
				throw new Error(`Symlink rejected in published pages: ${rel}`);
			}
			if (st.isDirectory()) {
				walk(full);
				continue;
			}
			if (!st.isFile()) {
				throw new Error(`Unsupported file type rejected in published pages: ${rel}`);
			}
			fileCount += 1;
			totalBytes += st.size;
			if (totalBytes > MAX_PAGES_BYTES) {
				throw new Error(
					`Published pages exceed size limit (${totalBytes} bytes > ${MAX_PAGES_BYTES} bytes).`,
				);
			}
			const ext = extname(full).toLowerCase();
			if (ext === ".html" || ext === ".htm" || ext === ".css") {
				const text = readFileSync(full, "utf8");
				const patterns = ext === ".css" ? EXTERNAL_CSS_PATTERNS : EXTERNAL_HTML_PATTERNS;
				for (const pattern of patterns) {
					pattern.lastIndex = 0;
					const match = pattern.exec(text);
					if (match) {
						problems.push(`${rel} loads external asset: ${match[0].slice(0, 100)}`);
					}
				}
			}
		}
	};

	walk(root);

	const homeIndex = join(root, "index.html");
	if (!existsSync(homeIndex) || !lstatSync(homeIndex).isFile()) {
		throw new Error("Published pages missing required root index.html.");
	}
	const slugIndex = join(root, slug, "index.html");
	if (!existsSync(slugIndex) || !lstatSync(slugIndex).isFile()) {
		throw new Error(`Published pages missing required "${slug}/index.html". Did the worker run \`grug-page build ${slug}\`?`);
	}
	if (problems.length > 0) {
		throw new Error(`Published pages blocked by external asset check:\n- ${problems.join("\n- ")}`);
	}
	return { fileCount, totalBytes };
}

export function createSshSandbox(options: SshSandboxOptions): WorkerSandbox {
	const host = validateSshHost(options.host);
	const workDir = options.workDir?.trim() || DEFAULT_SSH_WORK_DIR;
	const inboxDir = options.inboxDir?.trim() || DEFAULT_SSH_INBOX_DIR;
	const siteDir = options.siteDir?.trim() || DEFAULT_SSH_SITE_DIR;
	const museBin = options.museBin?.trim() || DEFAULT_SSH_MUSE_BIN;
	const allowPages = options.allowPages === true;
	const sshCommand = options.sshCommand ?? "ssh";
	const spawnFn = options.spawnFn ?? spawn;
	const retryDelayMs = options.retryDelayMs ?? SSH_RETRY_DELAY_MS;
	const cleanupCommand = options.cleanupCommand ?? REMOTE_BROWSER_CLEANUP_COMMAND;
	const cleanupTimeoutMs = options.cleanupTimeoutMs ?? SSH_CLEANUP_TIMEOUT_MS;

	const cleanupRemoteBrowsers = (): Promise<void> =>
		new Promise((resolveCleanup) => {
			if (cleanupCommand.trim() === "") {
				resolveCleanup();
				return;
			}
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolveCleanup();
			};
			let child: ReturnType<typeof spawnFn>;
			try {
				child = spawnFn(sshCommand, [...SSH_BASE_ARGS, host, cleanupCommand], {
					stdio: ["ignore", "ignore", "ignore"],
					env: sshEnv(),
				});
			} catch {
				resolveCleanup();
				return;
			}
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				finish();
			}, cleanupTimeoutMs);
			timer.unref();
			child.on("error", finish);
			child.on("close", finish);
		});

	return {
		type: "ssh",
		workDir,
		inboxDir,
		prepare() {
			// Persistent VM is pre-provisioned; never create or mutate VMs here.
		},
		async runWorker(req) {
			if (req.job.provider !== MUSE) {
				return {
					ok: false,
					output: `SSH sandbox requires workerProvider "muse" (got "${req.job.provider}").`,
				};
			}
			mkdirSync(req.sessionDir, { recursive: true, mode: 0o700 });
			const transcript = museTranscript(req.sessionDir, req.sessionId);
			const first = !existsSync(transcript);
			const preamble = musePreamble({
				promptFile: req.workerOptions.promptFile,
				cliFile: req.workerOptions.cliFile,
				skills: [],
				allowPages,
				remote: true,
			});
			const prompt = `${first ? `${preamble}\n\n---\n\n` : ""}Message from pclaw:\n\n${req.message}`;
			const remoteCmd = buildRemoteMuseServeCommand({
				museBin,
				workDir,
				model: req.job.model,
			});
			try {
				const result = await runMuseMsp({
					spawnProcess: () =>
						spawnFn(sshCommand, [...SSH_BASE_ARGS, host, remoteCmd], {
							stdio: ["pipe", "pipe", "pipe"],
							env: sshEnv(),
						}),
					sessionId: req.sessionId,
					model: req.job.model,
					effort: req.thinking,
					prompt,
					transcript,
					resume: !first,
					timeoutMs: req.timeoutMs,
					...(req.signal === undefined ? {} : { signal: req.signal }),
					...(req.onHandle === undefined ? {} : { onHandle: req.onHandle }),
					label: `${sshCommand} to ${host}`,
					preInitRetryDelayMs: retryDelayMs,
				});
				return { ok: result.ok, output: clip(result.output) };
			} finally {
				await cleanupRemoteBrowsers();
			}
		},
		async putFile(localPath, filename, signal) {
			const bytes = readFileSync(localPath);
			const remoteCmd = buildRemotePutCommand(inboxDir, filename);
			const attempt = () => {
				const timeout = AbortSignal.timeout(SSH_FILE_TIMEOUT_MS);
				const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

				return new Promise<string>((resolvePromise, rejectPromise) => {
					const child = spawnFn(sshCommand, [...SSH_BASE_ARGS, host, remoteCmd], {
						stdio: ["pipe", "pipe", "pipe"],
						env: sshEnv(),
						signal: combined,
					});
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
					child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
					child.stdin.on("error", () => {});
					child.on("error", (error) => rejectPromise(new Error(`SSH putFile to ${host} failed: ${error.message}`)));
					child.on("close", (code) => {
						if (code !== 0) {
							rejectPromise(new SshExitError(`SSH putFile to ${host} exited ${code}: ${stderr.trim() || "unknown error"}`, code));
							return;
						}
						const dest = stdout.trim().split("\n").at(-1)?.trim();
						if (!dest) {
							rejectPromise(new Error(`SSH putFile to ${host} returned no destination path.`));
							return;
						}
						resolvePromise(dest);
					});
					child.stdin.end(bytes);
				});
			};
			return retrySshFailure(attempt, signal, retryDelayMs);
		},
		async getFile(remotePath, maxBytes, signal) {
			const clean = validateFilePathInput(remotePath);
			if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
				throw new Error("Invalid maxBytes limit.");
			}
			const remoteCmd = buildRemoteGetCommand(workDir, inboxDir, clean, maxBytes);
			const attempt = () => {
				const timeout = AbortSignal.timeout(SSH_FILE_TIMEOUT_MS);
				const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

				return new Promise<SandboxFile>((resolvePromise, rejectPromise) => {
					const child = spawnFn(sshCommand, [...SSH_BASE_ARGS, host, remoteCmd], {
						stdio: ["ignore", "pipe", "pipe"],
						env: sshEnv(),
						signal: combined,
					});
					const chunks: Buffer[] = [];
					let totalBytes = 0;
					let overflow = false;
					let stderr = "";
					child.stdout.on("data", (chunk: Buffer) => {
						totalBytes += chunk.byteLength;
						if (totalBytes > maxBytes) {
							overflow = true;
							child.kill("SIGKILL");
							return;
						}
						chunks.push(chunk);
					});
					child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
					child.on("error", (error) => {
						if (!overflow) rejectPromise(new Error(`SSH getFile from ${host} failed: ${error.message}`));
					});
					child.on("close", (code) => {
						if (overflow) {
							rejectPromise(new Error(`File "${basename(clean)}" exceeds limit (${maxBytes} bytes).`));
							return;
						}
						if (code !== 0) {
							rejectPromise(new SshExitError(stderr.trim() || `SSH getFile from ${host} exited ${code}.`, code));
							return;
						}
						const data = new Uint8Array(Buffer.concat(chunks, totalBytes));
						resolvePromise({ data, filename: basename(clean), sizeBytes: data.byteLength });
					});
				});
			};
			return retrySshFailure(attempt, signal, retryDelayMs);
		},
		async syncPages(targetDir, slug, signal) {
			if (!SLUG.test(slug)) {
				throw new Error(`Invalid page slug "${slug}". Use 1-63 lowercase letters, digits, or hyphens.`);
			}
			const resolvedTarget = resolve(targetDir);
			const parentDir = dirname(resolvedTarget);
			mkdirSync(parentDir, { recursive: true });

			const remoteCmd = buildRemoteSyncPagesCommand(siteDir);
			const archivePath = join(
				parentDir,
				`.pages-archive-${slug}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`,
			);
			const stagingDir = mkdtempSync(join(parentDir, `.pages-stage-${slug}-`));

			const downloadArchive = () => {
				const timeout = AbortSignal.timeout(SSH_FILE_TIMEOUT_MS);
				const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

				return new Promise<void>((resolvePromise, rejectPromise) => {
					const out = createWriteStream(archivePath, { mode: 0o600 });
					const child = spawnFn(sshCommand, [...SSH_BASE_ARGS, host, remoteCmd], {
						stdio: ["ignore", "pipe", "pipe"],
						env: sshEnv(),
						signal: combined,
					});
					let receivedBytes = 0;
					let overflow = false;
					let stderr = "";
					let settled = false;
					const fail = (err: Error) => {
						if (settled) return;
						settled = true;
						out.destroy();
						rejectPromise(err);
					};

					out.on("error", (err) => {
						child.kill("SIGKILL");
						fail(new Error(`Failed writing pages archive: ${err.message}`));
					});
					child.stdout.on("data", (chunk: Buffer) => {
						receivedBytes += chunk.byteLength;
						if (receivedBytes > MAX_PAGES_ARCHIVE_BYTES) {
							overflow = true;
							child.kill("SIGKILL");
							return;
						}
						out.write(chunk);
					});
					child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
					child.on("error", (err) => {
						if (!overflow) fail(new Error(`SSH syncPages from ${host} failed: ${err.message}`));
					});
					child.on("close", (code) => {
						if (settled) return;
						if (overflow) {
							fail(new Error(`Pages archive exceeds size limit (${MAX_PAGES_ARCHIVE_BYTES} bytes).`));
							return;
						}
						if (code !== 0) {
							fail(
								new SshExitError(
									stderr.trim() || `SSH syncPages from ${host} exited ${code}.`,
									code,
								),
							);
							return;
						}
						out.end(() => {
							if (!settled) {
								settled = true;
								resolvePromise();
							}
						});
					});
				});
			};

			const extractArchive = () =>
				new Promise<void>((resolveExtract, rejectExtract) => {
					const timeout = AbortSignal.timeout(SSH_FILE_TIMEOUT_MS);
					const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
					const child = spawn("tar", ["-xzf", archivePath, "--no-same-owner", "--no-same-permissions", "-C", stagingDir], {
						stdio: ["ignore", "ignore", "pipe"],
						signal: combined,
					});
					let stderr = "";
					child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
					child.on("error", (err) => rejectExtract(new Error(`Failed to extract pages archive: ${err.message}`)));
					child.on("close", (code) => {
						if (code !== 0) {
							rejectExtract(new Error(`tar extraction failed (exit ${code}): ${stderr.trim() || "unknown error"}`));
							return;
						}
						resolveExtract();
					});
				});

			try {
				await retrySshFailure(downloadArchive, signal, retryDelayMs);
				await extractArchive();
				const stats = validateStagedPages(stagingDir, slug);

				if (existsSync(resolvedTarget)) {
					const backupDir = join(
						parentDir,
						`.pages-old-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					);
					renameSync(resolvedTarget, backupDir);
					try {
						renameSync(stagingDir, resolvedTarget);
					} catch (swapErr) {
						try {
							renameSync(backupDir, resolvedTarget);
						} catch {}
						throw swapErr;
					}
					rmSync(backupDir, { recursive: true, force: true });
				} else {
					renameSync(stagingDir, resolvedTarget);
				}

				return stats;
			} finally {
				rmSync(archivePath, { force: true });
				if (existsSync(stagingDir)) {
					rmSync(stagingDir, { recursive: true, force: true });
				}
			}
		},
	};
}

export type SandboxManagerOptions = {
	config: Config;
	users: UserRegistry;
	defaultWorkDir: string;
	defaultInboxDir: string;
	defaultSessionDir: string;
	sshCommand?: string;
	spawnFn?: typeof spawn;
};

/** Manages per-user sandboxes and per-user worker session directories, with clean single-owner fallback. */
export class SandboxManager {
	readonly #config: Config;
	readonly #users: UserRegistry;
	readonly #defaultSandbox: WorkerSandbox;
	readonly #defaultSessionDir: string;
	readonly #sshCommand?: string;
	readonly #spawnFn?: typeof spawn;
	readonly #byUser = new Map<string, WorkerSandbox>();

	constructor(options: SandboxManagerOptions) {
		this.#config = options.config;
		this.#users = options.users;
		this.#defaultSessionDir = options.defaultSessionDir;
		if (options.sshCommand !== undefined) this.#sshCommand = options.sshCommand;
		if (options.spawnFn !== undefined) this.#spawnFn = options.spawnFn;
		this.#defaultSandbox = createLocalSandbox({
			workDir: options.defaultWorkDir,
			inboxDir: options.defaultInboxDir,
			allowPages: isPagesEnabled(options.config, "local"),
		});
	}

	sandboxForUser(user: ResolvedUser | undefined): WorkerSandbox {
		if (user === undefined) return this.#defaultSandbox;
		let existing = this.#byUser.get(user.id);
		if (existing !== undefined) return existing;
		const userPaths = this.#users.pathsFor(user.id);
		const spec: UserSandboxConfig = user.sandbox ?? { type: "local" };
		existing =
			spec.type === "ssh"
				? createSshSandbox({
						host: spec.host,
						...(spec.workDir === undefined ? {} : { workDir: spec.workDir }),
						...(spec.inboxDir === undefined ? {} : { inboxDir: spec.inboxDir }),
						...(spec.museBin === undefined ? {} : { museBin: spec.museBin }),
						allowPages: isPagesEnabled(this.#config, "ssh", user),
						...(this.#sshCommand === undefined ? {} : { sshCommand: this.#sshCommand }),
						...(this.#spawnFn === undefined ? {} : { spawnFn: this.#spawnFn }),
					})
				: createLocalSandbox({
						workDir: spec.workDir ?? userPaths.work,
						inboxDir: userPaths.inbox,
						allowPages: isPagesEnabled(this.#config, "local"),
					});
		this.#byUser.set(user.id, existing);
		return existing;
	}

	forAddress(address: string | undefined): {
		user: ResolvedUser | undefined;
		sandbox: WorkerSandbox;
		sessionDir: string;
		allowPages: boolean;
	} {
		const user = this.#users.resolveAddress(address);
		const sandbox = this.sandboxForUser(user);
		const sessionDir = user === undefined ? this.#defaultSessionDir : this.#users.pathsFor(user.id).workerSessions;
		const allowPages =
			user !== undefined
				? isPagesEnabled(this.#config, sandbox.type, user)
				: isPagesEnabled(this.#config, "local") &&
					(!this.#users.enabled || this.#users.all().some((u) => (u.sandbox?.type ?? "local") !== "ssh"));
		return {
			user,
			sandbox,
			sessionDir,
			allowPages,
		};
	}

	/** All worker session directories (default + every configured user) for transcript lookup. */
	allSessionDirs(): string[] {
		const dirs = new Set<string>([this.#defaultSessionDir]);
		for (const user of this.#users.all()) dirs.add(this.#users.pathsFor(user.id).workerSessions);
		return [...dirs];
	}
}
