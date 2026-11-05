import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { loadProfile } from "./profiles.ts";
import type { ServiceId } from "./search.ts";

export const home = process.env.PCLAW_HOME ?? join(homedir(), ".pclaw");
const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

export const paths = {
	config: join(home, "config.json"),
	db: join(home, "pclaw.sqlite"),
	chatDb: join(home, "chat.sqlite"),
	notes: join(home, "notes.md"),
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
};

export type Config = {
	discordToken?: string;
	/** The one Discord user pclaw answers. Set by pairing on the first DM when absent. */
	discordOwnerId?: string;
	/** Server channels pclaw answers in (besides DMs). Threads in them become forks of the channel's conversation. */
	discordChannels: string[];
	/** The folder in profiles/ for the model you talk to. Its provider, model, and reasoning level win over the ones below. */
	profile: string;
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
	/** Where published pages are reachable, as the person would open them. Defaults to the dashboard's /pages. */
	pagesUrl?: string;
	/** A publisher command for pages (`<command> <slug> <dir>`, prints the URL). Unset: pclaw serves them itself. */
	pagePublisher?: string;
	/** How long a conversation stays quiet before the memory pass updates the notes from it. */
	memoryQuietMinutes: number;
	/** Summarize older messages once a request's prompt passes this many tokens. */
	summarizeAtTokens: number;
	/** Roughly how many tokens of the most recent conversation stay word for word after a summary. */
	keepRecentTokens: number;
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
	/** A decision model's `/v1/decisions` server. Unset: no hints, and the front model decides alone. */
	decisionUrl?: string;
	/** A speech-to-text server (deploy/speech-server.py). Unset: voice memos can't be heard. */
	speechUrl?: string;
	/** Share of decisions asked and logged but not shown, for comparing behavior with and without hints. */
	decisionHoldout: number;
};

type StoredConfig = Partial<Config>;

export const defaults: Config = {
	discordChannels: [],
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

function readStored(): StoredConfig {
	if (!existsSync(paths.config)) return {};
	return JSON.parse(readFileSync(paths.config, "utf8")) as StoredConfig;
}

/** Defaults, then config.json, then environment variables. */
export function loadConfig(): Config {
	const env = process.env;
	const fromEnv: StoredConfig = {
		discordToken: env.DISCORD_TOKEN,
		discordOwnerId: env.PCLAW_DISCORD_OWNER_ID,
		profile: env.PCLAW_PROFILE,
		provider: env.PCLAW_PROVIDER,
		model: env.PCLAW_MODEL,
		thinkingLevel: env.PCLAW_THINKING as ModelThinkingLevel | undefined,
		timeZone: env.PCLAW_TZ,
		workerModel: env.PCLAW_WORKER_MODEL,
		workerThinkingLevel: env.PCLAW_WORKER_THINKING as ModelThinkingLevel | undefined,
		dashboardPort: env.PCLAW_DASHBOARD_PORT === undefined ? undefined : Number(env.PCLAW_DASHBOARD_PORT),
		tavilyApiKey: env.TAVILY_API_KEY,
		parallelApiKey: env.PARALLEL_API_KEY,
		t3Url: env.PCLAW_T3_URL,
		t3RedirectUri: env.PCLAW_T3_REDIRECT_URI,
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
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, contents, { mode: 0o600 });
	renameSync(temp, file);
}
