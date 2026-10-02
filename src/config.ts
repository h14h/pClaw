import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

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
};

export type Config = {
	discordToken?: string;
	/** The one Discord user pclaw answers. Set by pairing on the first DM when absent. */
	discordOwnerId?: string;
	/** The model you talk to: fast, tuned for conversation, hands real work to workers. */
	provider: string;
	model: string;
	thinkingLevel: ModelThinkingLevel;
	/** pi's auth.json by default, so one sign-in covers pclaw and its pi workers. */
	authFile: string;
	timeZone: string;
	/** The worker: a pi process with its default coding-agent prompt and tools. */
	workerCommand: string;
	workerProvider: string;
	workerModel: string;
	workerThinkingLevel: ModelThinkingLevel;
	workerTimeoutMinutes: number;
	/** The dashboard listens on 127.0.0.1 only; a proxy puts it on the tailnet. */
	dashboardPort: number;
};

type StoredConfig = Partial<Config>;

export const defaults: Config = {
	provider: "xai",
	model: "grok-4.5",
	thinkingLevel: "medium",
	authFile: join(piAgentDir, "auth.json"),
	timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	workerCommand: "pi",
	workerProvider: "xai",
	workerModel: "grok-4.7",
	workerThinkingLevel: "high",
	workerTimeoutMinutes: 30,
	dashboardPort: 7421,
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
		provider: env.PCLAW_PROVIDER,
		model: env.PCLAW_MODEL,
		thinkingLevel: env.PCLAW_THINKING as ModelThinkingLevel | undefined,
		timeZone: env.PCLAW_TZ,
		workerModel: env.PCLAW_WORKER_MODEL,
		workerThinkingLevel: env.PCLAW_WORKER_THINKING as ModelThinkingLevel | undefined,
		dashboardPort: env.PCLAW_DASHBOARD_PORT === undefined ? undefined : Number(env.PCLAW_DASHBOARD_PORT),
	};
	const defined = Object.fromEntries(Object.entries(fromEnv).filter(([, value]) => value !== undefined));
	return { ...defaults, ...readStored(), ...defined };
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
