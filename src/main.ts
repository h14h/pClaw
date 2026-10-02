#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import { startDiscord } from "./channels/discord.ts";
import { chatInTerminal } from "./channels/terminal.ts";
import { ensureHome, loadConfig, paths, saveConfig } from "./config.ts";
import { startContextKeeper } from "./context-keeper.ts";
import { FileCredentialStore } from "./credentials.ts";
import { startDashboard } from "./dashboard/server.ts";
import { Notes } from "./extensions/notes.ts";
import { workerOptions } from "./extensions/workers.ts";

const context = BACKGROUND_CONTEXT;

function createPclawModels() {
	const models = createModels({ credentials: new FileCredentialStore(loadConfig().authFile) });
	models.setProvider(xaiProvider());
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
	console.log(`Signing in to ${config.provider} (a SuperGrok or X Premium subscription works for xAI).`);
	console.log(`The sign-in is saved to ${config.authFile}, shared with pi.`);
	await createPclawModels().login(config.provider, "oauth", terminalLogin);
	console.log("Signed in.");
}

/** False when there's no credential or it can't be refreshed (an expired sign-in needs a new login). */
async function signedIn(models: ReturnType<typeof createPclawModels>, provider: string): Promise<boolean> {
	try {
		return (await models.getAuth(provider)) !== undefined;
	} catch {
		return false;
	}
}

async function setup(): Promise<void> {
	ensureHome();
	const config = loadConfig();
	const models = createPclawModels();
	if (!(await signedIn(models, config.provider))) await login();
	else console.log(`Already signed in to ${config.provider}.`);

	const worker = spawnSync(config.workerCommand, ["--version"], { encoding: "utf8" });
	if (worker.status !== 0) {
		console.log(
			`\nWorkers run pi, and \`${config.workerCommand}\` didn't start. Install it with\n` +
				"  npm install -g @earendil-works/pi-coding-agent\n",
		);
	} else {
		console.log(`Workers will use pi ${worker.stdout.trim()} with ${config.workerModel} (${config.workerThinkingLevel}).`);
	}

	if (config.tavilyApiKey === undefined) {
		console.log("\nWeb search uses Tavily (free tier at https://app.tavily.com). Paste an API key, or press enter to skip.");
		const key = await ask("Tavily API key: ");
		if (key !== "") saveConfig({ tavilyApiKey: key });
	}

	if (config.discordToken === undefined) {
		console.log(
			"\nCreate a Discord bot at https://discord.com/developers/applications:\n" +
				"  New Application > Bot > Reset Token, and copy the token.\n" +
				"  On the same page, turn off Public Bot so nobody else can add it to a server.\n",
		);
		const token = await ask("Bot token: ");
		if (token === "") throw new Error("No token entered.");
		saveConfig({ discordToken: token });
	}
	console.log(`\nDone. Settings are in ${paths.config}. Start it with \`pnpm start\`, then DM the bot.`);
}

async function start(): Promise<void> {
	const config = loadConfig();
	const models = createPclawModels();
	if (!(await signedIn(models, config.provider))) {
		throw new Error(`Not signed in to ${config.provider}, or the sign-in expired. Run \`pnpm setup\`.`);
	}
	ensureHome();
	// Search (src/search.ts) reads the key from the environment, in this process and in the pi workers it starts.
	if (config.tavilyApiKey !== undefined) process.env.TAVILY_API_KEY = config.tavilyApiKey;
	else console.log("[pclaw] No Tavily key: quick_search and worker search will fail. Run `pnpm setup`.");
	const notes = new Notes(paths.notes);
	const workers = workerOptions(config, paths);
	const agent = await openAgent(await openNodeSqliteStorage(paths.db), { config, models, notes, workers }, context);
	const discord = await startDiscord(agent, config, context);
	const dashboard = await startDashboard({ agent, config, models, notes, workers, port: config.dashboardPort }, context);
	const contextKeeper = startContextKeeper(agent, config.summarizeAtTokens, context);

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		console.log("[pclaw] stopping");
		contextKeeper.stop();
		await discord.stop();
		await dashboard.stop();
		await agent.harness.close(context);
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

async function chat(): Promise<void> {
	const config = loadConfig();
	const models = createPclawModels();
	ensureHome();
	if (config.tavilyApiKey !== undefined) process.env.TAVILY_API_KEY = config.tavilyApiKey;
	const agent = await openAgent(await openNodeSqliteStorage(paths.chatDb), { config, models, notes: new Notes(paths.notes) }, context);
	await chatInTerminal(agent, config, context);
	await agent.harness.close(context);
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
