import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { Config, UserSandboxConfig } from "./config.ts";
import { isPagesEnabled } from "./config.ts";
import { runLocalWorker, type WorkerOptions, type WorkerResult } from "./extensions/workers.ts";
import { MUSE, musePreamble, museTranscript } from "./muse.ts";
import { type LiveWorkerHandle, PCLAW_PWD_PREFIX, runMuseMsp } from "./muse-msp.ts";
import type { ResolvedUser, UserRegistry } from "./users.ts";

const REPORT_LIMIT = 12_000;
const DEFAULT_SSH_WORK_DIR = "~/work";
const DEFAULT_SSH_INBOX_DIR = "~/inbox";
const DEFAULT_SSH_MUSE_BIN = "~/.local/bin/muse";
const SSH_FILE_TIMEOUT_MS = 120_000;

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
	museBin?: string;
	/** Injectable for tests (defaults to "ssh"). */
	sshCommand?: string;
	spawnFn?: typeof spawn;
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

export function createSshSandbox(options: SshSandboxOptions): WorkerSandbox {
	const host = validateSshHost(options.host);
	const workDir = options.workDir?.trim() || DEFAULT_SSH_WORK_DIR;
	const inboxDir = options.inboxDir?.trim() || DEFAULT_SSH_INBOX_DIR;
	const museBin = options.museBin?.trim() || DEFAULT_SSH_MUSE_BIN;
	const sshCommand = options.sshCommand ?? "ssh";
	const spawnFn = options.spawnFn ?? spawn;

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
				allowPages: false,
				remote: true,
			});
			const prompt = `${first ? `${preamble}\n\n---\n\n` : ""}Message from pclaw:\n\n${req.message}`;
			const remoteCmd = buildRemoteMuseServeCommand({
				museBin,
				workDir,
				model: req.job.model,
			});
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
			});
			return { ok: result.ok, output: clip(result.output) };
		},
		async putFile(localPath, filename, signal) {
			const bytes = readFileSync(localPath);
			const remoteCmd = buildRemotePutCommand(inboxDir, filename);
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
						rejectPromise(new Error(`SSH putFile to ${host} exited ${code}: ${stderr.trim() || "unknown error"}`));
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
		},
		async getFile(remotePath, maxBytes, signal) {
			const clean = validateFilePathInput(remotePath);
			if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
				throw new Error("Invalid maxBytes limit.");
			}
			const remoteCmd = buildRemoteGetCommand(workDir, inboxDir, clean, maxBytes);
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
						rejectPromise(new Error(stderr.trim() || `SSH getFile from ${host} exited ${code}.`));
						return;
					}
					const data = new Uint8Array(Buffer.concat(chunks, totalBytes));
					resolvePromise({ data, filename: basename(clean), sizeBytes: data.byteLength });
				});
			});
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
		return {
			user,
			sandbox,
			sessionDir,
			allowPages: isPagesEnabled(this.#config, sandbox.type),
		};
	}

	/** All worker session directories (default + every configured user) for transcript lookup. */
	allSessionDirs(): string[] {
		const dirs = new Set<string>([this.#defaultSessionDir]);
		for (const user of this.#users.all()) dirs.add(this.#users.pathsFor(user.id).workerSessions);
		return [...dirs];
	}
}
