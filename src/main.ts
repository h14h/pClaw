#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import { startDiscord } from "./channels/discord.ts";
import { startTelegram } from "./channels/telegram.ts";
import { chatInTerminal } from "./channels/terminal.ts";
import { type Config, ensureHome, loadConfig, paths, saveConfig } from "./config.ts";
import { startContextKeeper } from "./context-keeper.ts";
import { startNotesCleanup } from "./notes-cleanup.ts";
import { FileCredentialStore } from "./credentials.ts";
import { startDashboard } from "./dashboard/server.ts";
import { Notes } from "./extensions/notes.ts";
import { workerOptions } from "./extensions/workers.ts";
import { MUSE } from "./muse.ts";
import { listProfiles, loadProfile, registerProfiles } from "./profiles.ts";
import { useProfile } from "./prompts.ts";
import { chooseService, serviceReady, services } from "./search.ts";
import { startSessionKeeper } from "./session-keeper.ts";
import { startWorkerProgressMonitor } from "./worker-progress.ts";

const context = BACKGROUND_CONTEXT;

async function createPclawModels() {
	const models = createModels({ credentials: new FileCredentialStore(loadConfig().authFile) });
	models.setProvider(metaProvider());
	models.setProvider(xaiProvider());
	await registerProfiles(models, listProfiles().map((name) => loadProfile(name)));
	return models;
}

async function ask(question: string): Promise<string> {
	const lines = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await lines.question(question)).trim();
	} finally {
		lines.close();
	}
}

const terminalLogin: AuthInteraction = {
	prompt: async (prompt) => ask(`${prompt.message} `),
	notify: (event) => {
		if (event.type === "device_code") {
			console.log(`\nOpen ${event.verificationUri} and enter the code ${event.userCode}\n`);
		} else if (event.type === "auth_url") {
			console.log(`\nOpen ${event.url}${event.instructions === undefined ? "" : `\n${event.instructions}`}\n`);
		} else {
			console.log(event.message);
		}
	},
};

async function login(): Promise<void> {
	const config = loadConfig();
	console.log(`Signing in to ${config.provider} (a Muse Code subscription works for meta).`);
	console.log(`The sign-in is saved to ${config.authFile}, shared with pi.`);
	await (await createPclawModels()).login(config.provider, "oauth", terminalLogin);
	console.log("Signed in.");
}

/** False when there's no credential or it can't be refreshed (an expired sign-in needs a new login). */
async function signedIn(models: Awaited<ReturnType<typeof createPclawModels>>, provider: string): Promise<boolean> {
	try {
		return (await models.getAuth(provider)) !== undefined;
	} catch {
		return false;
	}
}

async function setup(): Promise<void> {
	ensureHome();
	const config = loadConfig();
	const models = await createPclawModels();
	if (!(await signedIn(models, config.provider))) await login();
	else console.log(`Already signed in to ${config.provider}.`);

	if (config.workerProvider === MUSE) {
		const muse = spawnSync(config.museCommand, ["usage"], { encoding: "utf8" });
		if (muse.error !== undefined) {
			console.log(`\nWorkers run Muse Code, and \`${config.museCommand}\` didn't start. Install Muse Code and run \`muse login\`.\n`);
		} else if (muse.status !== 0) {
			console.log(`\nWorkers run Muse Code, and it isn't signed in. Run \`${config.museCommand} login\`.\n`);
		} else {
			console.log(`Workers will use Muse Code with ${config.workerModel} (${config.workerThinkingLevel}).`);
		}
	} else {
		const worker = spawnSync(config.workerCommand, ["--version"], { encoding: "utf8" });
		if (worker.status !== 0) {
			console.log(
				`\nWorkers run pi, and \`${config.workerCommand}\` didn't start. Install it with\n` +
					"  npm install -g @earendil-works/pi-coding-agent\n",
			);
		} else {
			console.log(`Workers will use pi ${worker.stdout.trim()} with ${config.workerModel} (${config.workerThinkingLevel}).`);
		}
	}

	if (config.tavilyApiKey === undefined) {
		console.log("\nWeb search uses Tavily (free tier at https://app.tavily.com). Paste an API key, or press enter to skip.");
		const key = await ask("Tavily API key: ");
		if (key !== "") saveConfig({ tavilyApiKey: key });
	}
	if (config.parallelApiKey === undefined) {
		console.log("\nOptional: a Parallel key (https://platform.parallel.ai) to compare its search with Tavily's. Enter skips.");
		const key = await ask("Parallel API key: ");
		if (key !== "") saveConfig({ parallelApiKey: key });
	}

	let hasChannel = config.discordToken !== undefined || config.telegramToken !== undefined;
	if (config.discordToken === undefined) {
		console.log(
			"\nCreate a Discord bot at https://discord.com/developers/applications:\n" +
				"  New Application > Bot > Reset Token, and copy the token.\n" +
				"  On the same page, turn off Public Bot so nobody else can add it to a server.\n" +
				"  Press enter to skip if you're using Telegram instead.\n",
		);
		const token = await ask("Discord bot token: ");
		if (token !== "") {
			saveConfig({ discordToken: token });
			hasChannel = true;
		}
	}
	if (config.telegramToken === undefined) {
		console.log("\nOptional: create a Telegram bot with @BotFather and paste its token. Press enter to skip.");
		const token = await ask("Telegram bot token: ");
		if (token !== "") {
			saveConfig({ telegramToken: token });
			hasChannel = true;
		}
	}
	if (!hasChannel) throw new Error("No Discord or Telegram bot token entered.");
	console.log(`\nDone. Settings are in ${paths.config}. Start it with \`pnpm start\`, then DM the bot.`);
}

/** Search (src/search.ts) reads its keys and choices from the environment, here and in the pi workers it starts. */
function setUpSearch(config: Config): void {
	if (config.tavilyApiKey !== undefined) process.env.TAVILY_API_KEY = config.tavilyApiKey;
	if (config.parallelApiKey !== undefined) process.env.PARALLEL_API_KEY = config.parallelApiKey;
	chooseService("search", config.searchService);
	chooseService("pages", config.pageService);
	for (const id of new Set([config.searchService, config.pageService])) {
		if (!serviceReady(id)) console.log(`[pclaw] No ${services[id].name} key: searches through it will fail. Run \`pnpm setup\`.`);
	}
}

async function start(): Promise<void> {
	const config = loadConfig();
	const models = await createPclawModels();
	if (!(await signedIn(models, config.provider))) {
		throw new Error(`Not signed in to ${config.provider}, or the sign-in expired. Run \`pnpm setup\`.`);
	}
	ensureHome();
	// Workers' publish_page tool reads these; leave unset when pagesUrl / pagePublisher are not configured.
	if (config.pagesUrl !== undefined && config.pagesUrl.trim() !== "") process.env.PCLAW_PAGES_URL = config.pagesUrl;
	else delete process.env.PCLAW_PAGES_URL;
	if (config.pagePublisher !== undefined && config.pagePublisher.trim() !== "") process.env.PCLAW_PAGE_PUBLISHER = config.pagePublisher;
	else delete process.env.PCLAW_PAGE_PUBLISHER;
	setUpSearch(config);
	const notes = new Notes(paths.notes);
	useProfile(loadProfile(config.profile).dir);
	console.log(`[pclaw] profile ${config.profile}${config.voiceFile ? ` (voice ${config.voiceFile})` : ""}`);
	const workers = workerOptions(config, paths);
	if (config.discordToken === undefined && config.telegramToken === undefined) {
		throw new Error("No Discord or Telegram token configured. Run `pnpm setup` or set DISCORD_TOKEN / TELEGRAM_BOT_TOKEN.");
	}
	const agent = await openAgent(await openNodeSqliteStorage(paths.db), { config, models, notes, workers }, context);
	const backfill = await agent.searchIndex.backfillAll(agent.harness, context, agent.users);
	const idxStats = agent.searchIndex.stats();
	console.log(
		`[pclaw] search index ready (${backfill.conversations} conversations, +${backfill.indexed} new; total ${idxStats.totalDocs}: ${idxStats.episodes} episodes, ${idxStats.messages} messages, ${idxStats.workerReports} reports)`,
	);
	const discord = config.discordToken === undefined ? undefined : await startDiscord(agent, config, context);
	const telegram = config.telegramToken === undefined ? undefined : await startTelegram(agent, config, context);
	const dashboard = await startDashboard({ agent, config, models, notes, workers, port: config.dashboardPort }, context);
	const sessionResetEnabled = config.sessionReset?.enabled === true;
	const compactThreshold = sessionResetEnabled
		? (config.sessionReset?.emergencyCompactTokens ?? 110_000)
		: config.summarizeAtTokens;
	const contextKeeper = startContextKeeper(agent, compactThreshold, context, undefined, {
		checkNotesCopies: !sessionResetEnabled,
	});
	const sessionKeeper = sessionResetEnabled ? startSessionKeeper(agent, { models, config }, context) : undefined;
	const notesCleanup = startNotesCleanup(
		agent,
		{
			models,
			config,
			notes,
			archive: paths.notesArchive,
			stateFile: paths.notesCleanup,
			users: agent.users,
			prompts: agent.prompts,
		},
		context,
	);
	const jobKeeper = agent.t3Enabled ? agent.jobs.startKeeper(context, config.jobPollSeconds * 1000, config.jobProgressSeconds * 1000) : undefined;
	const workerProgress = startWorkerProgressMonitor(
		agent,
		{
			models,
			config,
			decisions: agent.jobs.decisions,
			everyMs: config.jobPollSeconds * 1000,
			refreshMs: config.jobProgressSeconds * 1000,
		},
		context,
	);
	console.log(
		`[pclaw] jobs ${agent.t3Enabled ? "on" : "off"}, users ${agent.users.enabled ? agent.users.all().length : "single-owner"}, session-reset ${sessionResetEnabled ? "on" : "off"}, decision model ${config.decisionUrl ?? "off"}${config.decisionFallback === false ? "" : `, fallback ${config.decisionFallbackModel ?? config.model}`}`,
	);

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		console.log("[pclaw] stopping");
		contextKeeper.stop();
		sessionKeeper?.stop();
		notesCleanup.stop();
		jobKeeper?.stop();
		workerProgress.stop();
		await discord?.stop();
		await telegram?.stop();
		await dashboard.stop();
		await agent.harness.close(context);
		agent.searchIndex.close();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

async function chat(): Promise<void> {
	const config = loadConfig();
	const models = await createPclawModels();
	ensureHome();
	setUpSearch(config);
	const agent = await openAgent(await openNodeSqliteStorage(paths.chatDb), { config, models, notes: new Notes(paths.notes) }, context);
	await chatInTerminal(agent, config, context);
	await agent.harness.close(context);
	agent.searchIndex.close();
}

const commands: Record<string, () => Promise<void>> = { start, setup, login, chat };
const help = `pclaw: a small personal assistant you text on Discord

  pnpm start          start the bot
  pnpm setup          sign in and connect Discord
  pnpm chat           talk to it in this terminal (separate history)
  pnpm pclaw login    sign in to the model provider again

Files live in ${paths.config.replace(/\/config\.json$/, "")}.`;

const command = process.argv[2] ?? "start";
const run = commands[command];
if (run === undefined) {
	console.log(help);
	process.exit(command === "help" || command === "--help" || command === "-h" ? 0 : 1);
}
run().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
