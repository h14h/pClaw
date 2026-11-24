import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { loadProfile } from "./profiles.ts";
import type { ServiceId } from "./search.ts";

export const home = process.env.PCLAW_HOME ?? join(homedir(), ".pclaw");
const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

export const paths = {
	config: join(home, "config.json"),
	db: join(home, "pclaw.sqlite"),
	chatDb: join(home, "chat.sqlite"),
	/** SQLite database holding distilled session episodes and FTS5 recall index. 0600. */
	indexDb: join(home, "pclaw-index.sqlite"),
	notes: join(home, "notes.md"),
	/** Notes the nightly cleanup retired or replaced, with when and why. Never shown to models. */
	notesArchive: join(home, "notes-archive.md"),
	/** When the nightly notes cleanup last ran. */
	notesCleanup: join(home, "notes-cleanup.json"),
	/** Where workers run and leave files. */
	work: join(home, "work"),
	workerSessions: join(home, "worker-sessions"),
	/** T3 Code OAuth pairing (client id, tokens, pending PKCE state). 0600, never shown to models. */
	t3Auth: join(home, "t3.json"),
	/** Jobs and where they stand. */
	jobs: join(home, "jobs.json"),
	/** Every decision-model call, what was shown, and what happened next. See docs/decision-evals.md. */
	decisions: join(home, "decisions.jsonl"),
	/** Voice memos as they were sent, so a transcript can be checked or redone. */
	voice: join(home, "voice"),
	/** Inbound files (PDFs, documents, etc.) saved for workers to inspect. */
	inbox: join(home, "inbox"),
};

export type UserSandboxConfig =
	| { type: "local"; workDir?: string }
	| { type: "ssh"; host: string; workDir?: string; inboxDir?: string; museBin?: string };

export interface UserConfig {
	name: string;
	timeZone?: string;
	telegram?: string;
	discord?: string;
	sandbox?: UserSandboxConfig;
}

export type SessionResetClientConfig = {
	idleMinutes?: number | null;
	dailyHour?: number | null;
};

export type SessionResetConfig = {
	enabled?: boolean;
	/** Reset idle conversation after this many minutes without a turn. Default 180 (3h). */
	idleMinutes?: number;
	/** Local hour (0–23) for daily session rollover, or null to disable. Default 4 (4am). */
	dailyHour?: number | null;
	/** Minimum quiet minutes required before dailyHour rollover fires (prevents cutting off active 3:59am chat). Default 30. */
	dailyMinQuietMinutes?: number;
	/** Emergency token compaction threshold while sessionReset is enabled. Default 110_000. */
	emergencyCompactTokens?: number;
	/** Maximum recent episodes injected into <recent-episodes> at session start. Default 6. */
	maxRecentEpisodes?: number;
	/** Lookback window in hours for <recent-episodes>. Default 72. */
	recentEpisodesHours?: number;
	/** Per-client overrides keyed by client ("telegram", "discord:dm", "discord:thread", "matrix", etc.). */
	clients?: Record<string, SessionResetClientConfig>;
};

export type ResolvedSessionResetPolicy = {
	clientKey: string;
	idleMinutes: number | null;
	dailyHour: number | null;
	dailyMinQuietMinutes: number;
};

/** Map a conversation route address onto its session-reset client key. */
export function sessionResetClientKey(address: string): string {
	const [channel, kind] = address.split(":");
	if (channel === "telegram") return "telegram";
	if (channel === "discord") {
		if (kind === "dm") return "discord:dm";
		if (kind === "thread" || kind === "channel") return "discord:thread";
		return "discord";
	}
	if (channel === "matrix") return "matrix";
	return channel ?? address;
}

/** Resolve effective idle/daily session-reset policy for a conversation address. */
export function resolveSessionResetPolicy(
	config: SessionResetConfig | undefined,
	address: string,
): ResolvedSessionResetPolicy {
	const clientKey = sessionResetClientKey(address);
	const defaultIdle = config?.idleMinutes ?? 180;
	const defaultDaily = config?.dailyHour !== undefined ? config.dailyHour : 4;
	const dailyMinQuietMinutes = config?.dailyMinQuietMinutes ?? 30;
	const override = config?.clients?.[clientKey];

	let idleMinutes: number | null;
	if (override?.idleMinutes !== undefined) {
		idleMinutes = override.idleMinutes;
	} else if (clientKey === "discord:thread") {
		idleMinutes = 1440;
	} else {
		idleMinutes = defaultIdle;
	}

	let dailyHour: number | null;
	if (override?.dailyHour !== undefined) {
		dailyHour = override.dailyHour;
	} else if (clientKey === "discord:thread") {
		dailyHour = null;
	} else {
		dailyHour = defaultDaily;
	}

	return { clientKey, idleMinutes, dailyHour, dailyMinQuietMinutes };
}

export type Config = {
	discordToken?: string;
	/** The one Discord user pclaw answers. Set by pairing on the first DM when absent. */
	discordOwnerId?: string;
	/** Server channels pclaw answers in (besides DMs). Threads in them become forks of the channel's conversation. */
	discordChannels: string[];
	/** Telegram Bot API token from @BotFather. */
	telegramToken?: string;
	/** The paired Telegram owner user ID. Set on first DM when neither this nor `telegramAllowedUsers` is configured. */
	telegramOwnerId?: string;
	/** Telegram user IDs allowed to talk to pclaw. When non-empty, only these users (plus `telegramOwnerId`) are served. */
	telegramAllowedUsers: string[];
	/** Telegram group/supergroup chat IDs where pclaw answers allowed users. */
	telegramAllowedGroups: string[];
	/** Canonical multi-user map (`userId -> UserConfig`). When unset/empty, single-owner mode applies. */
	users?: Record<string, UserConfig>;
	/** The folder in profiles/ for the model you talk to. Its provider, model, and reasoning level win over the ones below. */
	profile: string;
	/** Optional bot-specific voice.md path (overrides the model profile's voice.md without editing profiles/). */
	voiceFile?: string;
	/** Optional bot-specific persona directory whose .md files override the model profile's prompts. */
	personaDir?: string;
	/** The model you talk to: fast, tuned for conversation, hands real work to workers. */
	provider: string;
	model: string;
	thinkingLevel: ModelThinkingLevel;
	/** pi's auth.json by default, so one sign-in covers pclaw and its pi workers. */
	authFile: string;
	timeZone: string;
	/** pi, for workers on a pi provider: its default coding-agent prompt and tools. */
	workerCommand: string;
	/** Muse Code, for workers on the `muse` provider. */
	museCommand: string;
	/** `muse` runs worker jobs in Muse Code; any other provider runs them in pi. */
	workerProvider: string;
	workerModel: string;
	workerThinkingLevel: ModelThinkingLevel;
	/** Reasoning for jobs the front model marks quick; deep jobs use workerThinkingLevel. */
	workerQuickThinkingLevel: ModelThinkingLevel;
	workerTimeoutMinutes: number;
	/**
	 * Skills workers can use besides pclaw's own (src/skills/): folders with a SKILL.md, e.g. a publishing skill kept with
	 * your own scripts. A leading ~ is your home folder. Their markdown files are editable from the dashboard.
	 */
	workerSkills: string[];
	/** Web search for quick_search and workers. TAVILY_API_KEY in the environment works too. */
	tavilyApiKey?: string;
	/** The other search service, for comparing with Tavily. PARALLEL_API_KEY in the environment works too. */
	parallelApiKey?: string;
	/** Which service runs searches and which reads pages (src/search.ts). */
	searchService: ServiceId;
	pageService: ServiceId;
	/** The dashboard listens on 127.0.0.1 only; a proxy puts it on the tailnet. */
	dashboardPort: number;
	/** Where published pages are reachable, as the person would open them. Unset disables publish_page unless pagePublisher is set. */
	pagesUrl?: string;
	/** A publisher command for pages (`<command> <slug> <dir>`, prints the URL). Unset: pclaw serves them itself. */
	pagePublisher?: string;
	/** How long a conversation stays quiet before the memory pass updates the notes from it. */
	memoryQuietMinutes: number;
	/** Summarize older messages once a request's prompt passes this many tokens. */
	summarizeAtTokens: number;
	/** Roughly how many tokens of the most recent conversation stay word for word after a summary. */
	keepRecentTokens: number;
	/** Gate T3 / Jobs. Default true when t3Url is non-empty, false when allowT3 === false or t3Url is unset/empty. */
	allowT3?: boolean;
	/** T3 Code server origin for its official MCP endpoint (`<t3Url>/mcp`). */
	t3Url: string;
	/** OAuth redirect URI for T3 pairing, as the browser reaches the dashboard. Defaults to the local dashboard. */
	t3RedirectUri?: string;
	/** Let pclaw send messages into T3 threads on the owner's behalf. Off until the owner turns it on. */
	t3AllowSend: boolean;
	/** Project for T3 worker threads (`workerProvider: "t3"`), launched in a fresh worktree. Unset: workers launch scratch threads. */
	t3WorkerProjectId?: string;
	/** Base ref for a T3 worker's worktree. Defaults to "main". */
	t3WorkerBaseRef?: string;
	/** How often watched T3 threads are polled for waiting/finished/failed. */
	t3PollSeconds: number;
	/** How often jobs are checked in T3. */
	jobPollSeconds: number;
	/** How often a running job's card can refresh and its thread can get an update. */
	jobProgressSeconds: number;
	/** T3 model for jobs unless the front model picks another. */
	jobModel: string;
	/** A channel for one always-current message listing every job. It's for reading only: pclaw never answers there. */
	discordBoardChannel?: string;
	/** For test instances: never mention the owner or add them to a thread. */
	discordQuiet?: boolean;
	/**
	 * A decision model's `/v1/decisions` server, asked first with a tight timeout. Unset, or when it doesn't answer, the
	 * front model answers the same questions in a small structured prompt (see `decisionFallback`).
	 */
	decisionUrl?: string;
	/** Whether the front model stands in for the decision model when it's unset or down. Default true. */
	decisionFallback?: boolean;
	/** The model for that stand-in, on the front model's provider. Defaults to the front model. */
	decisionFallbackModel?: string;
	/** A speech-to-text server (deploy/speech-server.py). Unset: voice memos can't be heard unless `speechFallbackUrl` is set. */
	speechUrl?: string;
	/** Cloud OpenAI-compatible `/v1/audio/transcriptions` fallback used when `speechUrl` is unreachable or unset. */
	speechFallbackUrl?: string;
	/** Model for `speechFallbackUrl`. Defaults to `"gpt-transcribe"`. */
	speechFallbackModel?: string;
	/** Optional Bearer API key for `speechFallbackUrl` (omitted for keyless endpoints such as `llm.int.exe.xyz`). */
	speechFallbackApiKey?: string;
	/** Share of decisions asked and logged but not shown, for comparing behavior with and without hints. */
	decisionHoldout: number;
	/** Per-client idle/daily session reset & episode distillation. Opt-in (`enabled: true`). */
	sessionReset?: SessionResetConfig;
};

type StoredConfig = Partial<Config>;

export const defaults: Config = {
	discordChannels: [],
	telegramAllowedUsers: [],
	telegramAllowedGroups: [],
	profile: "muse-spark-1.3",
	provider: "meta",
	model: "muse-spark-1.3",
	thinkingLevel: "medium",
	authFile: join(piAgentDir, "auth.json"),
	timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	workerCommand: "pi",
	museCommand: "muse",
	workerProvider: "muse",
	workerModel: "muse-wonder-full-1.0",
	workerThinkingLevel: "high",
	workerQuickThinkingLevel: "medium",
	workerTimeoutMinutes: 30,
	workerSkills: [],
	searchService: "tavily",
	pageService: "tavily",
	dashboardPort: 7421,
	memoryQuietMinutes: 20,
	summarizeAtTokens: 60_000,
	keepRecentTokens: 16_000,
	t3Url: "http://127.0.0.1:3773",
	t3AllowSend: false,
	t3PollSeconds: 60,
	jobPollSeconds: 15,
	jobProgressSeconds: 45,
	jobModel: "claude-opus-5-5",
	decisionHoldout: 0.2,
};

/** Whether T3 / Jobs features are enabled for this config. */
export function isT3Enabled(config: Pick<Config, "allowT3" | "t3Url">): boolean {
	if (config.allowT3 === false) return false;
	return typeof config.t3Url === "string" && config.t3Url.trim() !== "";
}

/** Whether publish_page is enabled for this config and sandbox type. */
export function isPagesEnabled(config: Pick<Config, "pagesUrl" | "pagePublisher">, sandboxType: "local" | "ssh" = "local"): boolean {
	if (sandboxType === "ssh") return false;
	return Boolean(config.pagesUrl?.trim() || config.pagePublisher?.trim());
}

function readStored(): StoredConfig {
	if (!existsSync(paths.config)) return {};
	return JSON.parse(readFileSync(paths.config, "utf8")) as StoredConfig;
}

function parseListEnv(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const lower = value.trim().toLowerCase();
	if (lower === "1" || lower === "true" || lower === "yes") return true;
	if (lower === "0" || lower === "false" || lower === "no") return false;
	return undefined;
}

/** Defaults, then config.json, then environment variables. */
export function loadConfig(): Config {
	const env = process.env;
	const fromEnv: StoredConfig = {
		discordToken: env.DISCORD_TOKEN,
		discordOwnerId: env.PCLAW_DISCORD_OWNER_ID,
		telegramToken: env.TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_TOKEN,
		telegramOwnerId: env.PCLAW_TELEGRAM_OWNER_ID,
		telegramAllowedUsers: parseListEnv(env.PCLAW_TELEGRAM_ALLOWED_USERS),
		telegramAllowedGroups: parseListEnv(env.PCLAW_TELEGRAM_ALLOWED_GROUPS),
		profile: env.PCLAW_PROFILE,
		voiceFile: env.PCLAW_VOICE_FILE,
		personaDir: env.PCLAW_PERSONA_DIR,
		provider: env.PCLAW_PROVIDER,
		model: env.PCLAW_MODEL,
		thinkingLevel: env.PCLAW_THINKING as ModelThinkingLevel | undefined,
		timeZone: env.PCLAW_TZ,
		workerModel: env.PCLAW_WORKER_MODEL,
		workerThinkingLevel: env.PCLAW_WORKER_THINKING as ModelThinkingLevel | undefined,
		dashboardPort: env.PCLAW_DASHBOARD_PORT === undefined ? undefined : Number(env.PCLAW_DASHBOARD_PORT),
		tavilyApiKey: env.TAVILY_API_KEY,
		parallelApiKey: env.PARALLEL_API_KEY,
		allowT3: parseBoolEnv(env.PCLAW_ALLOW_T3),
		t3Url: env.PCLAW_T3_URL,
		t3RedirectUri: env.PCLAW_T3_REDIRECT_URI,
		speechFallbackUrl: env.PCLAW_SPEECH_FALLBACK_URL,
		speechFallbackModel: env.PCLAW_SPEECH_FALLBACK_MODEL,
		speechFallbackApiKey: env.PCLAW_SPEECH_FALLBACK_API_KEY,
	};
	const defined = Object.fromEntries(Object.entries(fromEnv).filter(([, value]) => value !== undefined));
	const merged = { ...defaults, ...readStored(), ...defined };
	const profile = loadProfile(merged.profile);
	return { ...merged, provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel, ...defined };
}

export function saveConfig(patch: StoredConfig): void {
	ensureHome();
	writePrivate(paths.config, JSON.stringify({ ...readStored(), ...patch }, null, "\t") + "\n");
}

export function ensureHome(): void {
	mkdirSync(home, { recursive: true, mode: 0o700 });
}

/** Write through a temp file so a crash never leaves a half-written file, readable only by this user. */
export function writePrivate(file: string, contents: string): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, contents, { mode: 0o600 });
	renameSync(temp, file);
}
