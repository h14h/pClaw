import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import {
	authorizeTelegramMessage,
	buildTelegramUserInput,
	startTelegram,
	type TelegramMessage,
	type TelegramUpdate,
} from "./channels/telegram.ts";
import { type Config, defaults, isPagesEnabled, isT3Enabled } from "./config.ts";
import { decisionClient, messageGuidance, renderGuidance } from "./decisions.ts";
import { deliver } from "./delivery.ts";
import { Notes } from "./extensions/notes.ts";
import { type WorkerOptions, workerOptions } from "./extensions/workers.ts";
import { MUSE, musePreamble, museTranscript, parseMuseSession } from "./muse.ts";
import { cleanupNotesForUsers } from "./notes-cleanup.ts";
import { createPromptResolver } from "./prompts.ts";
import {
	buildRemoteMuseServeCommand,
	createLocalSandbox,
	createSshSandbox,
	remotePathExpr,
	shellQuote,
	SSH_BASE_ARGS,
} from "./sandbox.ts";
import { isGroupAddress, UserRegistry } from "./users.ts";

const context = BACKGROUND_CONTEXT;

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-multi-user-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<Config> = {}): Config {
	return {
		...defaults,
		provider: "faux",
		model: "faux-1",
		thinkingLevel: "off",
		timeZone: "America/Los_Angeles",
		...overrides,
	};
}

function setupFaux() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

function makeFakeWorkers(subDir: string, overrides: Partial<WorkerOptions> = {}): WorkerOptions {
	const root = join(dir, subDir);
	mkdirSync(root, { recursive: true });
	const promptFile = join(root, "worker.md");
	writeFileSync(
		promptFile,
		readFileSync(new URL("./prompts/worker.md", import.meta.url), "utf8"),
	);
	return {
		command: "pi",
		museCommand: "muse",
		provider: MUSE,
		model: "muse-wonder-full-1.0",
		piFallback: { provider: "faux", model: "faux-1" },
		thinkingLevel: "high",
		quickThinkingLevel: "medium",
		timeoutMs: 15_000,
		cwd: join(root, "work"),
		sessionDir: join(root, "worker-sessions"),
		promptFile,
		toolsFile: join(root, "worker-tools.ts"),
		cliFile: join(root, "worker-cli.ts"),
		skills: [],
		allowPages: false,
		...overrides,
	};
}

function inbox() {
	const sent: string[] = [];
	let wake: (() => void) | undefined;
	return {
		sent,
		outbox: {
			async send(text: string) {
				sent.push(text);
				wake?.();
			},
			working() {},
		},
		until(count: number, ms = 10_000) {
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`only got ${JSON.stringify(sent)}`)), ms);
				const check = () => {
					if (sent.length >= count) {
						clearTimeout(timer);
						resolve();
					}
				};
				wake = check;
				check();
			});
		},
	};
}

test("canonical user resolution across Telegram & Discord + allowlist enforcement", () => {
	const homeDir = join(dir, "registry-home");
	const registry = new UserRegistry(
		{
			max: { name: "Max", timeZone: "America/New_York", telegram: "1001", discord: "2001" },
			willy: { name: "Willy", timeZone: "America/Chicago", telegram: "1002" },
		},
		homeDir,
	);

	assert.equal(registry.enabled, true);
	assert.equal(registry.resolveExternal("telegram", "1001")?.id, "max");
	assert.equal(registry.resolveExternal("discord", "2001")?.id, "max");
	assert.equal(registry.resolveExternal("telegram", "1002")?.id, "willy");
	assert.equal(registry.resolveExternal("discord", "9999"), undefined);
	assert.deepEqual(registry.allowedExternalIds("telegram").sort(), ["1001", "1002"]);
	assert.deepEqual(registry.allowedExternalIds("discord"), ["2001"]);

	// DM addresses map to canonical users; group/channel/thread addresses never do.
	assert.equal(registry.resolveAddress("telegram:dm:1001")?.id, "max");
	assert.equal(registry.resolveAddress("discord:dm:2001")?.id, "max");
	assert.equal(registry.resolveAddress("telegram:group:-500"), undefined);
	assert.equal(registry.resolveAddress("discord:channel:777"), undefined);
	assert.equal(registry.resolveAddress("discord:thread:888"), undefined);
	assert.equal(isGroupAddress("telegram:group:-500"), true);
	assert.equal(isGroupAddress("discord:channel:777"), true);
	assert.equal(isGroupAddress("discord:thread:888"), true);
	assert.equal(isGroupAddress("telegram:dm:1001"), false);
	assert.equal(isGroupAddress("discord:dm:2001"), false);

	// Per-user partitioned paths
	assert.equal(registry.pathsFor("max").notes, join(homeDir, "users", "max", "notes.md"));
	assert.equal(registry.pathsFor("max").inbox, join(homeDir, "users", "max", "inbox"));
	assert.equal(registry.pathsFor("willy").inbox, join(homeDir, "users", "willy", "inbox"));
	assert.notEqual(registry.pathsFor("max").inbox, registry.pathsFor("willy").inbox);

	// Telegram auth with multi-user allowlist disables auto-pairing for unknown senders.
	const authState = {
		allowedUsers: new Set(registry.allowedExternalIds("telegram")),
		allowedGroups: new Set(["-500"]),
		disablePairing: true,
	};
	const dmFrom = (id: number): TelegramMessage => ({
		message_id: 1,
		date: 1700000000,
		from: { id, first_name: "Test" },
		chat: { id, type: "private" },
		text: "hi",
	});
	const okMax = authorizeTelegramMessage(dmFrom(1001), authState);
	assert.equal(okMax.allowed, true);
	assert.equal(okMax.allowed ? okMax.addr : "", "telegram:dm:1001");
	assert.equal(authorizeTelegramMessage(dmFrom(9999), authState).allowed, false);
	// Even if no telegram users were listed yet, disablePairing prevents stranger pairing.
	assert.equal(
		authorizeTelegramMessage(dmFrom(9999), {
			allowedUsers: new Set(),
			allowedGroups: new Set(),
			disablePairing: true,
		}).allowed,
		false,
	);
	// Group chat requires allowlisted group AND mapped user.
	assert.equal(
		authorizeTelegramMessage(
			{
				message_id: 2,
				date: 1700000001,
				from: { id: 1001, first_name: "Max" },
				chat: { id: -500, type: "supergroup", title: "Crew" },
				text: "yo",
			},
			authState,
		).allowed,
		true,
	);
	assert.equal(
		authorizeTelegramMessage(
			{
				message_id: 3,
				date: 1700000002,
				from: { id: 9999, first_name: "Stranger" },
				chat: { id: -500, type: "supergroup", title: "Crew" },
				text: "yo",
			},
			authState,
		).allowed,
		false,
	);

	// Invalid user ids and duplicate external ids fail fast.
	assert.throws(() => new UserRegistry({ "../evil": { name: "Evil" } }, homeDir));
	assert.throws(
		() =>
			new UserRegistry(
				{
					a: { name: "A", telegram: "1001" },
					b: { name: "B", telegram: "1001" },
				},
				homeDir,
			),
	);
});

test("bot voice override (voiceFile) leaves muse-ember untouched and allowT3: false hides T3/jobs/pages", async () => {
	const emberVoiceBefore = readFileSync(new URL("../profiles/muse-ember/voice.md", import.meta.url), "utf8");

	// Instance A: Grug with voiceFile override, allowT3: false, no pagesUrl.
	const { faux: fauxGrug, models: modelsGrug } = setupFaux();
	const grugRequests: ModelContext[] = [];
	fauxGrug.setResponses([
		(req) => {
			grugRequests.push(req);
			return fauxAssistantMessage("kept it simple.");
		},
	]);
	const grugConfig = baseConfig({
		profile: "muse-ember",
		voiceFile: "bots/grug/voice.md",
		allowT3: false,
		pagesUrl: undefined,
	});
	assert.equal(isT3Enabled(grugConfig), false);
	assert.equal(isPagesEnabled(grugConfig, "local"), false);

	const grugAgent = await openAgent(
		await openNodeSqliteStorage(join(dir, "grug-voice.sqlite")),
		{
			config: grugConfig,
			models: modelsGrug,
			notes: new Notes(join(dir, "grug-notes.md")),
			workers: makeFakeWorkers("grug-voice-workers"),
			homeDir: join(dir, "grug-voice-home"),
		},
		context,
	);

	// Instance B: Pinchy-like default single-owner with muse-ember & T3 enabled (simultaneous, no global clobbering!).
	const { faux: fauxPinchy, models: modelsPinchy } = setupFaux();
	const pinchyRequests: ModelContext[] = [];
	fauxPinchy.setResponses([
		(req) => {
			pinchyRequests.push(req);
			return fauxAssistantMessage("on it.");
		},
	]);
	const pinchyConfig = baseConfig({
		profile: "muse-ember",
		pagesUrl: "https://pinchy.tailnet/pages",
	});
	assert.equal(isT3Enabled(pinchyConfig), true);
	assert.equal(isPagesEnabled(pinchyConfig, "local"), true);
	assert.equal(isPagesEnabled(pinchyConfig, "ssh"), false);

	const pinchyAgent = await openAgent(
		await openNodeSqliteStorage(join(dir, "pinchy-voice.sqlite")),
		{
			config: pinchyConfig,
			models: modelsPinchy,
			notes: new Notes(join(dir, "pinchy-notes.md")),
			workers: makeFakeWorkers("pinchy-voice-workers", { allowPages: true }),
			homeDir: join(dir, "pinchy-voice-home"),
		},
		context,
	);

	try {
		const grugConv = await grugAgent.conversationFor("telegram:dm:101", context);
		await (await grugConv.submit({ type: "input", content: "hey" }, context)).wait(context);

		const pinchyConv = await pinchyAgent.conversationFor("discord:dm:999", context);
		await (await pinchyConv.submit({ type: "input", content: "hey" }, context)).wait(context);

		// Grug got bots/grug/voice.md and zero T3/job tools or prompt instructions.
		assert.equal(grugAgent.t3Enabled, false);
		assert.equal(await grugAgent.jobs.guideMessage({ id: "1", text: "hi", channel: "telegram" }), undefined);
		const grugReq = grugRequests[0]!;
		const grugSystemMsg = grugReq.messages[0] as { sections?: Record<string, string>; toolsAdded?: { name: string }[] };
		const grugSystem = JSON.stringify(grugSystemMsg.sections ?? grugSystemMsg);
		const grugToolNames = (grugSystemMsg.toolsAdded ?? grugReq.tools ?? []).map((t) => t.name);

		assert.match(grugSystem, /You are Grug/);
		assert.doesNotMatch(grugSystem, /start_job|list_projects|list_jobs|message_job|ping_owner|<job-update>|<job-result>|mp1, pc1, mm1/);
		assert.doesNotMatch(grugSystem, /private web pages/);
		for (const forbidden of ["start_job", "list_jobs", "message_job", "stop_job", "list_projects", "ping_owner", "tool_search"]) {
			assert.ok(!grugToolNames.includes(forbidden), `tool ${forbidden} should be hidden when allowT3 is false`);
		}
		assert.ok(!grugToolNames.some((name) => name.startsWith("t3_")), "no t3_* tools should be registered");
		assert.ok(grugToolNames.includes("delegate"), "delegate should still be registered");
		assert.ok(grugToolNames.includes("send_file"), "send_file should be registered");

		// Pinchy got profiles/muse-ember/voice.md and T3/job tools, unaffected by Grug!
		const pinchyReq = pinchyRequests[0]!;
		const pinchySystemMsg = pinchyReq.messages[0] as { sections?: Record<string, string>; toolsAdded?: { name: string }[] };
		const pinchySystem = JSON.stringify(pinchySystemMsg.sections ?? pinchySystemMsg);
		const pinchyToolNames = (pinchySystemMsg.toolsAdded ?? pinchyReq.tools ?? []).map((t) => t.name);
		assert.match(pinchySystem, /Write like a perceptive, capable person/);
		assert.doesNotMatch(pinchySystem, /You are Grug/);
		assert.match(pinchySystem, /start_job/);
		assert.ok(pinchyToolNames.includes("start_job"));
		assert.ok(pinchyToolNames.includes("tool_search"));

		// profiles/muse-ember/voice.md on disk is completely unchanged.
		assert.equal(readFileSync(new URL("../profiles/muse-ember/voice.md", import.meta.url), "utf8"), emberVoiceBefore);

		// workerOptions omits web-page skill when pagesUrl is unset, includes it when pagesUrl is set.
		const optsNoPages = workerOptions(grugConfig, { work: join(dir, "w1"), workerSessions: join(dir, "s1") });
		assert.equal(optsNoPages.allowPages, false);
		assert.ok(!optsNoPages.skills.some((s) => s.endsWith("/web-page")));
		const optsWithPages = workerOptions(pinchyConfig, { work: join(dir, "w2"), workerSessions: join(dir, "s2") });
		assert.equal(optsWithPages.allowPages, true);
		assert.ok(optsWithPages.skills.some((s) => s.endsWith("/web-page")));
	} finally {
		await grugAgent.harness.close(context);
		await pinchyAgent.harness.close(context);
	}
});

test("strict cross-user isolation for notes, timezone, cross-client awareness, recall, memory-keeper, and nightly cleanup", async () => {
	const homeDir = join(dir, "isolation-home");
	const { faux, models } = setupFaux();
	let nowMs = Date.now();

	const multiConfig = baseConfig({
		allowT3: false,
		voiceFile: "bots/grug/voice.md",
		timeZone: "UTC",
		users: {
			max: { name: "Max", timeZone: "America/New_York", telegram: "101", discord: "201" },
			willy: { name: "Willy", timeZone: "America/Chicago", telegram: "102" },
		},
	});

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "isolation.sqlite")),
		{
			config: multiConfig,
			models,
			notes: new Notes(join(homeDir, "notes.md")),
			workers: makeFakeWorkers("isolation-workers"),
			homeDir,
			memoryQuietMs: 24 * 60 * 60_000,
			now: () => nowMs,
		},
		context,
	);

	try {
		const maxTg = await agent.conversationFor("telegram:dm:101", context);
		const maxDc = await agent.conversationFor("discord:dm:201", context);
		const willyTg = await agent.conversationFor("telegram:dm:102", context);
		const sharedGroup = await agent.conversationFor("telegram:group:-777", context);

		const requests: Record<string, ModelContext[]> = { maxTg: [], maxDc: [], willyTg: [], group: [] };

		// 1. Max on Telegram saves a note and talks about his quicksilver router.
		faux.setResponses([
			(req) => {
				requests.maxTg!.push(req);
				return fauxAssistantMessage(fauxToolCall("remember", { note: "Max runs Postgres 17 on his homelab" }), {
					stopReason: "toolUse",
				});
			},
			(req) => {
				requests.maxTg!.push(req);
				return fauxAssistantMessage("noted. quicksilver router config looks clean.");
			},
		]);
		await (await maxTg.submit({ type: "input", content: "setting up my quicksilver homelab router with postgres 17" }, context)).wait(context);

		// 2. Willy on Telegram saves a different note and talks about his secret tungsten spreadsheet.
		faux.setResponses([
			(req) => {
				requests.willyTg!.push(req);
				return fauxAssistantMessage(fauxToolCall("remember", { note: "Willy tracks invoices in tungsten spreadsheet" }), {
					stopReason: "toolUse",
				});
			},
			(req) => {
				requests.willyTg!.push(req);
				return fauxAssistantMessage("got it, noted.");
			},
		]);
		await (await willyTg.submit({ type: "input", content: "my secret tungsten spreadsheet is on drive" }, context)).wait(context);

		// Verify isolated per-user notes files on disk (root notes.md untouched!).
		const maxNotesFile = agent.users.pathsFor("max").notes;
		const willyNotesFile = agent.users.pathsFor("willy").notes;
		assert.match(readFileSync(maxNotesFile, "utf8"), /Postgres 17/);
		assert.doesNotMatch(readFileSync(maxNotesFile, "utf8"), /tungsten/);
		assert.match(readFileSync(willyNotesFile, "utf8"), /tungsten/);
		assert.doesNotMatch(readFileSync(willyNotesFile, "utf8"), /Postgres 17/);
		assert.equal(existsSync(join(homeDir, "notes.md")), false);

		// Advance clock 25 minutes so Max's Telegram activity triggers cross-client awareness on Discord!
		nowMs += 25 * 60_000;

		// 3. Max switches to Discord: sees his own notes, America/New_York tz, cross-client Telegram hint,
		//    can recall his own Telegram quicksilver router message, and CANNOT recall Willy's tungsten spreadsheet!
		faux.setResponses([
			(req) => {
				requests.maxDc!.push(req);
				return fauxAssistantMessage(fauxToolCall("recall", { query: "quicksilver homelab router" }), { stopReason: "toolUse" });
			},
			(req) => {
				requests.maxDc!.push(req);
				return fauxAssistantMessage(fauxToolCall("recall", { query: "secret tungsten spreadsheet" }), { stopReason: "toolUse" });
			},
			(req) => {
				requests.maxDc!.push(req);
				return fauxAssistantMessage("found your router note, nothing on tungsten.");
			},
		]);
		await (await maxDc.submit({ type: "input", content: "check router and tungsten" }, context)).wait(context);

		const maxDcFirst = requests.maxDc![0]!;
		const maxDcJson = JSON.stringify(maxDcFirst);
		assert.match(maxDcJson, /Max runs Postgres 17/);
		assert.doesNotMatch(maxDcJson, /Willy tracks invoices/);
		assert.match(maxDcJson, /America\/New_York/);
		assert.match(maxDcJson, /Recent activity with Max on telegram \(25m ago\); use recall if they reference it\./);

		// Inspect recall tool results returned to Max on Discord
		const maxDcFinal = JSON.stringify(requests.maxDc!.at(-1));
		assert.match(maxDcFinal, /quicksilver homelab router/);
		assert.match(maxDcFinal, /Nothing found/);
		assert.doesNotMatch(maxDcFinal, /secret tungsten spreadsheet.*drive/);

		// Verify Willy sees America/Chicago tz and NEVER sees Max's notes
		const willyJson = JSON.stringify(requests.willyTg![0]);
		assert.match(willyJson, /America\/Chicago/);
		assert.doesNotMatch(willyJson, /Postgres 17/);

		// 4. Shared group chat: NEVER loads any user's private notes, refuses remember, and recall NEVER leaks private DMs!
		faux.setResponses([
			(req) => {
				requests.group!.push(req);
				return fauxAssistantMessage(fauxToolCall("remember", { note: "Group secret should not save" }), { stopReason: "toolUse" });
			},
			(req) => {
				requests.group!.push(req);
				return fauxAssistantMessage(fauxToolCall("recall", { query: "quicksilver homelab router" }), { stopReason: "toolUse" });
			},
			(req) => {
				requests.group!.push(req);
				return fauxAssistantMessage("group reply done.");
			},
		]);
		await (await sharedGroup.submit({ type: "input", content: "anyone remember max's router?" }, context)).wait(context);

		const groupPrompt = JSON.stringify(requests.group![0]);
		assert.doesNotMatch(groupPrompt, /Postgres 17/);
		assert.doesNotMatch(groupPrompt, /tungsten/);
		const groupFinal = JSON.stringify(requests.group!.at(-1));
		assert.match(groupFinal, /Private notes aren't used in shared group chats/);
		assert.match(groupFinal, /Nothing found/);
		assert.doesNotMatch(readFileSync(maxNotesFile, "utf8"), /Group secret/);
		assert.doesNotMatch(readFileSync(willyNotesFile, "utf8"), /Group secret/);

		// 5. Nightly notes cleanup runs independently per user with zero cross-user leakage!
		const cleanupPrompts: string[] = [];
		faux.setResponses([
			// Cleanup for Max
			(req) => {
				cleanupPrompts.push(JSON.stringify(req));
				return fauxAssistantMessage(
					JSON.stringify({
						merge: [],
						update: [{ id: "n1", text: "Max runs Postgres 17 on his quicksilver homelab" }],
						retire: [],
					}),
				);
			},
			// Cleanup for Willy
			(req) => {
				cleanupPrompts.push(JSON.stringify(req));
				return fauxAssistantMessage(
					JSON.stringify({
						merge: [],
						update: [],
						retire: [{ id: "n1", why: "moved to new tool" }],
					}),
				);
			},
		]);

		const cleanupResults = await cleanupNotesForUsers(
			agent,
			{
				models,
				config: multiConfig,
				users: agent.users,
				prompts: agent.prompts,
				now: nowMs + 60_000,
				force: true,
			},
			context,
		);

		assert.equal(cleanupPrompts.length, 2);
		// Max's cleanup saw Max's telegram + discord convos, NEVER Willy's or group chat!
		assert.match(cleanupPrompts[0]!, /telegram:dm:101/);
		assert.match(cleanupPrompts[0]!, /discord:dm:201/);
		assert.doesNotMatch(cleanupPrompts[0]!, /telegram:dm:102/);
		assert.doesNotMatch(cleanupPrompts[0]!, /telegram:group:-777/);
		assert.doesNotMatch(cleanupPrompts[0]!, /Willy tracks invoices|is on drive/);

		// Willy's cleanup saw ONLY Willy's telegram convo, NEVER Max's or group chat!
		assert.match(cleanupPrompts[1]!, /telegram:dm:102/);
		assert.doesNotMatch(cleanupPrompts[1]!, /telegram:dm:101/);
		assert.doesNotMatch(cleanupPrompts[1]!, /discord:dm:201/);
		assert.doesNotMatch(cleanupPrompts[1]!, /telegram:group:-777/);
		assert.doesNotMatch(cleanupPrompts[1]!, /Postgres 17/);

		assert.equal(cleanupResults.max?.changes.length, 1);
		assert.equal(cleanupResults.willy?.changes.length, 1);
		assert.match(readFileSync(maxNotesFile, "utf8"), /quicksilver homelab/);
		assert.match(readFileSync(agent.users.pathsFor("max").notesArchive, "utf8"), /replaced by/);
		assert.equal(existsSync(agent.users.pathsFor("max").notesCleanup), true);
		assert.doesNotMatch(readFileSync(willyNotesFile, "utf8"), /tungsten/);
		assert.match(readFileSync(agent.users.pathsFor("willy").notesArchive, "utf8"), /retired \(moved to new tool\)/);
		assert.equal(existsSync(agent.users.pathsFor("willy").notesCleanup), true);
	} finally {
		await agent.harness.close(context);
	}
});

test("memory-keeper updates only the user's private notes and skips shared group chats", async () => {
	const homeDir = join(dir, "keeper-home");
	const { faux, models } = setupFaux();
	let nowMs = Date.now();

	const multiConfig = baseConfig({
		allowT3: false,
		users: {
			max: { name: "Max", telegram: "301" },
			willy: { name: "Willy", telegram: "302" },
		},
	});

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "keeper.sqlite")),
		{
			config: multiConfig,
			models,
			notes: new Notes(join(homeDir, "notes.md")),
			workers: makeFakeWorkers("keeper-workers"),
			homeDir,
			memoryQuietMs: 50,
			now: () => nowMs,
		},
		context,
	);

	try {
		const maxConv = await agent.conversationFor("telegram:dm:301", context);
		const groupConv = await agent.conversationFor("telegram:group:-888", context);

		let memoryReviewCalls = 0;
		faux.setResponses([
			// Front reply to Max
			fauxAssistantMessage("cool, noted."),
			// Front reply to group
			fauxAssistantMessage("sounds good everyone."),
			// Memory keeper pass (should only run for Max, NOT group!)
			(req) => {
				memoryReviewCalls++;
				assert.doesNotMatch(JSON.stringify(req), /group chatter/);
				return fauxAssistantMessage(JSON.stringify({ add: ["Max prefers dark roast coffee"], remove: [] }));
			},
		]);

		await (await maxConv.submit({ type: "input", content: "i only drink dark roast coffee" }, context)).wait(context);
		await (await groupConv.submit({ type: "input", content: "random group chatter about lunch" }, context)).wait(context);

		// Wait past quietMs for keepers to run
		nowMs = Date.now() + 500;
		const deadline = Date.now() + 5_000;
		while (memoryReviewCalls === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		// Give group keeper a moment to ensure it never calls review
		await new Promise((r) => setTimeout(r, 150));

		assert.equal(memoryReviewCalls, 1);
		assert.match(readFileSync(agent.users.pathsFor("max").notes, "utf8"), /dark roast coffee/);
		assert.equal(existsSync(agent.users.pathsFor("willy").notes), false);
		assert.equal(existsSync(join(homeDir, "notes.md")), false);
	} finally {
		await agent.harness.close(context);
	}
});

test("WorkerSandbox local: putFile, getFile, path confinement, symlink escape rejection, and size limits", async () => {
	const root = join(dir, "local-sandbox");
	const workDir = join(root, "work");
	const inboxDir = join(root, "inbox");
	const outsideDir = join(root, "outside");
	mkdirSync(workDir, { recursive: true });
	mkdirSync(inboxDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });

	const secretOutside = join(outsideDir, "secret.txt");
	writeFileSync(secretOutside, "top-secret");
	writeFileSync(join(workDir, "query.sql"), "SELECT 1;\n");
	writeFileSync(join(inboxDir, "invoice.pdf"), "PDFBYTES");
	symlinkSync(secretOutside, join(workDir, "escape-link.txt"));

	const sandbox = createLocalSandbox({ workDir, inboxDir, allowPages: false });

	// Valid reads from workDir (relative & absolute) and inboxDir
	const sql = await sandbox.getFile("query.sql", 1024);
	assert.equal(sql.filename, "query.sql");
	assert.equal(Buffer.from(sql.data).toString("utf8"), "SELECT 1;\n");

	const pdf = await sandbox.getFile(join(inboxDir, "invoice.pdf"), 1024);
	assert.equal(pdf.filename, "invoice.pdf");
	assert.equal(Buffer.from(pdf.data).toString("utf8"), "PDFBYTES");

	// Put file stages from outside into inbox
	const staged = await sandbox.putFile(secretOutside, "../bad/staged.txt");
	assert.equal(staged, join(inboxDir, "staged.txt"));
	assert.equal(readFileSync(staged, "utf8"), "top-secret");

	// Confinement rejections
	await assert.rejects(() => sandbox.getFile("../outside/secret.txt", 1024), /cannot contain "\.\."/);
	await assert.rejects(() => sandbox.getFile(secretOutside, 1024), /outside the allowed workspace/);
	await assert.rejects(() => sandbox.getFile("escape-link.txt", 1024), /outside the allowed workspace/);
	await assert.rejects(() => sandbox.getFile("query.sql", 4), /too large/);
});

test("WorkerSandbox ssh: safe escaping, env isolation, JSONL streaming, putFile, getFile confinement & size cap", async () => {
	const root = join(dir, "ssh-sandbox-test");
	const fakeVmHome = join(root, "vm-home");
	const sessionDir = join(root, "worker-sessions");
	const logDir = join(root, "logs");
	mkdirSync(fakeVmHome, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });

	// Create a fake `muse serve` binary on the "VM" that speaks MSP v1 JSON-RPC, logs args/prompt/workspaceRoot, and streams MSP events.
	const fakeMuse = join(root, "fake-muse.mjs");
	await writeFile(
		fakeMuse,
		`#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(logDir, "muse-args.txt"))}, args.join("\\n") + "\\n");
const stateFile = ${JSON.stringify(join(logDir, "muse-sessions.json"))};
const loadSessions = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {});
const saveSessions = (s) => writeFileSync(stateFile, JSON.stringify(s));
let sessionId = "";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		send({ id: msg.id, result: { serverInfo: { name: "fake-muse", version: "1.0.0" } } });
	} else if (msg.method === "session/start") {
		sessionId = msg.params.sessionId;
		writeFileSync(${JSON.stringify(join(logDir, "muse-workspace.txt"))}, String(msg.params.workspaceRoot ?? ""));
		const sessions = loadSessions();
		sessions[sessionId] = true;
		saveSessions(sessions);
		send({ id: msg.id, result: { session: { sessionId, approvalMode: { mode: msg.params.approvalMode ?? "allowAll" } } } });
	} else if (msg.method === "session/resume") {
		const sessions = loadSessions();
		if (!sessions[msg.params.sessionId]) {
			send({ id: msg.id, error: { code: -32020, message: "session not found", data: { kind: "sessionNotFound" } } });
			return;
		}
		sessionId = msg.params.sessionId;
		send({ id: msg.id, result: { session: { sessionId, approvalMode: { mode: "allowAll" } } } });
	} else if (msg.method === "turn/start") {
		const prompt = msg.params.input.map((p) => p.text ?? "").join("\\n");
		const turnId = msg.params.commandId;
		writeFileSync(${JSON.stringify(join(logDir, "muse-prompt.txt"))}, prompt);
		send({ id: msg.id, result: { commandId: msg.params.commandId, disposition: "started", startedNewTurn: true, status: "accepted", turnId } });
		send({ method: "turn/started", params: { sessionId, turnId, commandId: msg.params.commandId } });
		send({ method: "item/completed", params: { sessionId, item: { itemId: "u-" + turnId, kind: "userMessage", status: "completed", text: prompt, turnId } } });
		send({ method: "item/completed", params: { sessionId, item: { itemId: "a-" + turnId, kind: "agentMessage", messagePhase: "finalAnswer", status: "completed", text: "remote vm result ok", turnId } } });
		send({ method: "turn/completed", params: { sessionId, turnId, terminal: "completed" } });
	} else if (msg.method === "session/leave") {
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted" } });
		process.exit(0);
	}
});
`,
	);
	await chmod(fakeMuse, 0o755);

	// Create a fake `ssh` script that records argv + env, sets HOME=fakeVmHome, and executes the remote sh command!
	const fakeSsh = join(root, "fake-ssh.sh");
	await writeFile(
		fakeSsh,
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "${join(logDir, "ssh-args.txt")}"
env > "${join(logDir, "ssh-env.txt")}"
cmd="\${@: -1}"
HOME="${fakeVmHome}" exec bash -c "$cmd"
`,
	);
	await chmod(fakeSsh, 0o755);

	// Verify helper quoting & preamble safety directly
	assert.equal(shellQuote("a'b $(rm -rf /)"), `'a'\\''b $(rm -rf /)'`);
	assert.equal(remotePathExpr("~/work"), '"$HOME"/\'work\'');
	const remoteCmdPreview = buildRemoteMuseServeCommand({
		museBin: "~/.local/bin/muse",
		workDir: "~/work",
		model: "muse-wonder-full-1.0",
	});
	assert.match(remoteCmdPreview, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
	assert.match(remoteCmdPreview, /exec "\$HOME"\/'\.local\/bin\/muse' serve --model 'muse-wonder-full-1\.0'/);
	assert.match(remoteCmdPreview, /--disable-sandbox --disable-request-user-input/);

	// Verify VM-safe preamble omits host worker-cli.ts, systemctl restart, and publish_page
	const fakeWorkerOpts = makeFakeWorkers("ssh-worker-opts");
	const remotePreamble = musePreamble({
		promptFile: fakeWorkerOpts.promptFile,
		cliFile: fakeWorkerOpts.cliFile,
		skills: fakeWorkerOpts.skills,
		allowPages: false,
		remote: true,
	});
	assert.match(remotePreamble, /web_search/);
	assert.match(remotePreamble, /web_fetch/);
	assert.doesNotMatch(remotePreamble, /worker-cli\.ts/);
	assert.doesNotMatch(remotePreamble, /systemctl --user restart pclaw/);
	assert.doesNotMatch(remotePreamble, /publish_page/);

	// Set host secrets in process.env to prove SSH sandbox NEVER leaks them into ssh subprocess env.
	const prevTavily = process.env.TAVILY_API_KEY;
	const prevParallel = process.env.PARALLEL_API_KEY;
	const prevTg = process.env.TELEGRAM_BOT_TOKEN;
	process.env.TAVILY_API_KEY = "super-secret-tavily";
	process.env.PARALLEL_API_KEY = "super-secret-parallel";
	process.env.TELEGRAM_BOT_TOKEN = "super-secret-telegram";

	try {
		const sandbox = createSshSandbox({
			host: "grug-max.exe.xyz",
			workDir: "~/work",
			inboxDir: "~/inbox",
			museBin: fakeMuse,
			sshCommand: fakeSsh,
		});

		const pwnMarker = join(root, "SHOULD_NOT_EXIST");
		const injectionPrompt = `Check 'quotes' and $(touch ${pwnMarker}) and \`touch ${pwnMarker}\` and $HOME`;

		// Turn 1: first run includes VM-safe preamble and streams JSONL transcript locally.
		const res1 = await sandbox.runWorker({
			sessionId: "11111111-2222-3333-4444-555555555555",
			sessionDir,
			message: injectionPrompt,
			thinking: "medium",
			job: { provider: MUSE, model: "muse-wonder-full-1.0" },
			timeoutMs: 15_000,
			workerOptions: fakeWorkerOpts,
		});

		assert.equal(res1.ok, true);
		assert.equal(res1.output, "remote vm result ok");
		assert.equal(existsSync(pwnMarker), false, "shell injection payload must never execute");

		// Verify SSH options and host
		const sshArgs = readFileSync(join(logDir, "ssh-args.txt"), "utf8").trim().split("\n");
		for (const opt of SSH_BASE_ARGS) assert.ok(sshArgs.includes(opt), `missing ssh arg ${opt}`);
		assert.ok(sshArgs.includes("grug-max.exe.xyz"));

		// Verify NO mp1 secrets leaked into ssh child env
		const sshEnvDump = readFileSync(join(logDir, "ssh-env.txt"), "utf8");
		assert.doesNotMatch(sshEnvDump, /TAVILY_API_KEY|PARALLEL_API_KEY|TELEGRAM_BOT_TOKEN|super-secret/);

		// Verify exact prompt arrived intact at remote muse without shell expansion
		const receivedPrompt1 = readFileSync(join(logDir, "muse-prompt.txt"), "utf8");
		assert.match(receivedPrompt1, /## Tools here/);
		assert.ok(receivedPrompt1.includes(injectionPrompt), "prompt must arrive verbatim without expansion");

		// Verify JSONL transcript was streamed locally
		const transcriptPath = museTranscript(sessionDir, "11111111-2222-3333-4444-555555555555");
		assert.equal(existsSync(transcriptPath), true);
		const parsedItems = parseMuseSession(readFileSync(transcriptPath, "utf8"));
		assert.ok(parsedItems.some((item) => item.kind === "text" && item.text === "remote vm result ok"));

		// Turn 2: reuses session id and omits preamble!
		const res2 = await sandbox.runWorker({
			sessionId: "11111111-2222-3333-4444-555555555555",
			sessionDir,
			message: "follow-up turn",
			thinking: "medium",
			job: { provider: MUSE, model: "muse-wonder-full-1.0" },
			timeoutMs: 15_000,
			workerOptions: fakeWorkerOpts,
		});
		assert.equal(res2.ok, true);
		const receivedPrompt2 = readFileSync(join(logDir, "muse-prompt.txt"), "utf8");
		assert.doesNotMatch(receivedPrompt2, /## Tools here/);
		assert.equal(receivedPrompt2, "Message from pclaw:\n\nfollow-up turn");

		// putFile stages into VM ~/inbox/<filename> and returns the exact VM path
		const localPdf = join(root, "local-invoice.pdf");
		writeFileSync(localPdf, "PDF-CONTENT-123");
		const remotePath = await sandbox.putFile(localPdf, "invoice 01.pdf");
		assert.equal(remotePath, join(fakeVmHome, "inbox", "invoice 01.pdf"));
		assert.equal(readFileSync(remotePath, "utf8"), "PDF-CONTENT-123");

		// getFile reads from ~/work and ~/inbox
		writeFileSync(join(fakeVmHome, "work", "schema.sql"), "CREATE TABLE t(id INT);\n");
		const gotWork = await sandbox.getFile("schema.sql", 4096);
		assert.equal(gotWork.filename, "schema.sql");
		assert.equal(Buffer.from(gotWork.data).toString("utf8"), "CREATE TABLE t(id INT);\n");

		const gotInbox = await sandbox.getFile(remotePath, 4096);
		assert.equal(gotInbox.filename, "invoice 01.pdf");
		assert.equal(Buffer.from(gotInbox.data).toString("utf8"), "PDF-CONTENT-123");

		// getFile rejects .. traversal, outside paths, symlink escapes, and oversized files
		writeFileSync(join(fakeVmHome, "private.key"), "SECRETKEY");
		symlinkSync(join(fakeVmHome, "private.key"), join(fakeVmHome, "work", "bad-link.key"));

		await assert.rejects(() => sandbox.getFile("../private.key", 4096), /cannot contain "\.\."/);
		await assert.rejects(() => sandbox.getFile(join(fakeVmHome, "private.key"), 4096), /outside allowed sandbox roots/);
		await assert.rejects(() => sandbox.getFile("bad-link.key", 4096), /outside allowed sandbox roots/);
		await assert.rejects(() => sandbox.getFile("schema.sql", 5), /exceeds size limit|exceeds limit/);

		// Reject invalid SSH hosts (option injection)
		assert.throws(() => createSshSandbox({ host: "-oProxyCommand=evil" }), /Invalid SSH host/);
	} finally {
		if (prevTavily === undefined) delete process.env.TAVILY_API_KEY;
		else process.env.TAVILY_API_KEY = prevTavily;
		if (prevParallel === undefined) delete process.env.PARALLEL_API_KEY;
		else process.env.PARALLEL_API_KEY = prevParallel;
		if (prevTg === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
		else process.env.TELEGRAM_BOT_TOKEN = prevTg;
	}
});

test("buildTelegramUserInput stages documents via sandbox.putFile and handles SSH failure gracefully", async () => {
	const inboxDir = join(dir, "tg-stage-inbox");
	const docMsg: TelegramMessage = {
		message_id: 42,
		date: 1700000000,
		from: { id: 101, first_name: "Max" },
		chat: { id: 101, type: "private" },
		caption: "read this pdf",
		document: { file_id: "doc-1", file_name: "statement.pdf", mime_type: "application/pdf", file_size: 12 },
	};
	const api = {
		getFile: async () => ({ file_id: "doc-1", file_path: "documents/statement.pdf" }),
		downloadFile: async () => new Uint8Array(Buffer.from("PDF-BYTES-OK")),
		sendChatAction: async () => true,
	};

	// Success staging to remote VM inbox
	const staged = await buildTelegramUserInput([docMsg], {
		api,
		timeZone: "America/New_York",
		inboxDir,
		stageFile: async (_localPath, filename) => `/home/exedev/inbox/${filename}`,
	});
	assert.match(staged.plainText, /saved at \/home\/exedev\/inbox\/tg-101-42-statement\.pdf/);

	// Graceful failure when SSH is unreachable
	const failed = await buildTelegramUserInput([docMsg], {
		api,
		timeZone: "America/New_York",
		inboxDir,
		stageFile: async () => {
			throw new Error("Connection refused");
		},
	});
	assert.match(failed.plainText, /saved locally at .*tg-101-42-statement\.pdf, but staging to workspace failed: Connection refused/);
});

test("send_file end-to-end: enforces per-user confinement and sends documents & photos via Telegram", async () => {
	const homeDir = join(dir, "send-file-home");
	const { faux, models } = setupFaux();

	const multiConfig = baseConfig({
		allowT3: false,
		telegramToken: "test-token",
		users: {
			max: { name: "Max", timeZone: "America/New_York", telegram: "501" },
			willy: { name: "Willy", timeZone: "America/Chicago", telegram: "502" },
		},
	});

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "send-file.sqlite")),
		{
			config: multiConfig,
			models,
			notes: new Notes(join(homeDir, "notes.md")),
			workers: makeFakeWorkers("send-file-workers"),
			homeDir,
		},
		context,
	);

	// Prepare Max's workspace files and Willy's private file
	const maxWork = agent.users.pathsFor("max").work;
	const willyWork = agent.users.pathsFor("willy").work;
	mkdirSync(maxWork, { recursive: true, mode: 0o700 });
	mkdirSync(willyWork, { recursive: true, mode: 0o700 });
	writeFileSync(join(maxWork, "export.sql"), "SELECT * FROM channels;\n");
	writeFileSync(join(maxWork, "plot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(willyWork, "willy-secret.md"), "Willy private doc");

	// Mock Telegram Bot API fetch
	const uploads: { method: string; chatId: string; filename: string; caption?: string; bytes: Uint8Array }[] = [];
	const sentMessages: string[] = [];
	let updatesServed = false;
	const queuedUpdates: TelegramUpdate[] = [
		{
			update_id: 1,
			message: {
				message_id: 10,
				date: 1700000000,
				from: { id: 501, first_name: "Max" },
				chat: { id: 501, type: "private" },
				text: "send me export.sql, plot.png, and try willy's file",
			},
		},
	];

	const fetchFn: typeof fetch = async (input, init) => {
		const url = String(input);
		const method = url.split("/").pop()!;
		if (method === "getMe") {
			return new Response(JSON.stringify({ ok: true, result: { id: 99, is_bot: true, username: "grug_test_bot" } }));
		}
		if (method === "getUpdates") {
			if (!updatesServed) {
				updatesServed = true;
				return new Response(JSON.stringify({ ok: true, result: queuedUpdates }));
			}
			await new Promise((r) => setTimeout(r, 50));
			return new Response(JSON.stringify({ ok: true, result: [] }));
		}
		if (method === "sendDocument" || method === "sendPhoto") {
			const form = init?.body as FormData;
			const field = method === "sendPhoto" ? "photo" : "document";
			const file = form.get(field) as File;
			const bytes = new Uint8Array(await file.arrayBuffer());
			const caption = form.get("caption");
			uploads.push({
				method,
				chatId: String(form.get("chat_id")),
				filename: file.name,
				...(typeof caption === "string" ? { caption } : {}),
				bytes,
			});
			return new Response(
				JSON.stringify({
					ok: true,
					result: { message_id: 100 + uploads.length, date: 1700000005, chat: { id: 501, type: "private" } },
				}),
			);
		}
		if (method === "sendMessage") {
			const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
			if (body.text) sentMessages.push(body.text);
			return new Response(
				JSON.stringify({
					ok: true,
					result: { message_id: 200 + sentMessages.length, date: 1700000006, chat: { id: 501, type: "private" } },
				}),
			);
		}
		return new Response(JSON.stringify({ ok: true, result: true }));
	};

	const requests: ModelContext[] = [];
	faux.setResponses([
		(req) => {
			requests.push(req);
			return fauxAssistantMessage(fauxToolCall("send_file", { path: "export.sql", caption: "SQL export" }), {
				stopReason: "toolUse",
			});
		},
		(req) => {
			requests.push(req);
			return fauxAssistantMessage(fauxToolCall("send_file", { path: "plot.png", asPhoto: true }), {
				stopReason: "toolUse",
			});
		},
		(req) => {
			requests.push(req);
			return fauxAssistantMessage(fauxToolCall("send_file", { path: join(willyWork, "willy-secret.md") }), {
				stopReason: "toolUse",
			});
		},
		(req) => {
			requests.push(req);
			return fauxAssistantMessage("sent your sql and chart; blocked from accessing another workspace.");
		},
	]);

	const tg = await startTelegram(agent, multiConfig, context, { fetchFn, pollTimeoutSeconds: 1 });
	try {
		// Wait until final reply lands on mocked Telegram
		const deadline = Date.now() + 10_000;
		while (sentMessages.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 40));
		}

		assert.equal(uploads.length, 2, "only Max's two valid files should be uploaded");
		assert.equal(uploads[0]?.method, "sendDocument");
		assert.equal(uploads[0]?.chatId, "501");
		assert.equal(uploads[0]?.filename, "export.sql");
		assert.equal(uploads[0]?.caption, "SQL export");
		assert.equal(Buffer.from(uploads[0]!.bytes).toString("utf8"), "SELECT * FROM channels;\n");

		assert.equal(uploads[1]?.method, "sendPhoto");
		assert.equal(uploads[1]?.chatId, "501");
		assert.equal(uploads[1]?.filename, "plot.png");
		assert.deepEqual([...uploads[1]!.bytes], [0x89, 0x50, 0x4e, 0x47]);

		// Verify Willy's file was rejected with confinement error
		const finalReqText = JSON.stringify(requests.at(-1));
		assert.match(finalReqText, /outside the allowed workspace/);
		assert.equal(sentMessages.length, 1);
	} finally {
		await tg.stop();
		await agent.harness.close(context);
	}
});

test("createPromptResolver resolves personaDir and voiceFile independently without mutating global state", async () => {
	const personaDir = join(dir, "persona-test");
	mkdirSync(personaDir, { recursive: true });
	writeFileSync(join(personaDir, "voice.md"), "Persona voice");
	const overrideVoice = join(dir, "override-voice.md");
	writeFileSync(overrideVoice, "Explicit override voice");

	const r1 = createPromptResolver({ personaDir });
	const r2 = createPromptResolver({ personaDir, voiceFile: overrideVoice });
	assert.equal(r1.read("voice"), "Persona voice");
	assert.equal(r2.read("voice"), "Explicit override voice");
	// r1 is unaffected by r2
	assert.equal(r1.read("voice"), "Persona voice");
});

test("createPromptResolver with personaDir bots/grug resolves voice, front, formatting/telegram, and guidance", async () => {
	const grug = createPromptResolver({ personaDir: "bots/grug" });
	assert.ok(grug.file("voice").endsWith("bots/grug/voice.md"));
	assert.ok(grug.file("front").endsWith("bots/grug/front.md"));
	assert.ok(grug.file("guidance").endsWith("bots/grug/guidance.md"));
	assert.ok(grug.formattingFile("telegram.md").endsWith("bots/grug/formatting/telegram.md"));
	// Shared prompts without persona overrides still fall back to src/prompts/.
	assert.ok(grug.file("worker").endsWith("src/prompts/worker.md"));

	const frontPrompt = grug.frontPrompt({ allowT3: false, allowPages: false, channel: "telegram" });
	assert.match(frontPrompt, /# ultracave/);
	assert.match(frontPrompt, /# How Grug works/);
	assert.doesNotMatch(frontPrompt, /start_job|list_projects|list_jobs|message_job|ping_owner/);

	const tgFormatting = grug.readFormatting("telegram", { allowT3: false, allowPages: false })!;
	assert.match(tgFormatting, /You are in Telegram chat\. User reads on phone, like texts\./);
	assert.match(tgFormatting, /Reply in ultracave fragments: drop articles, copulas, filler; payload only\./);

	// Default Pinchy resolver (profiles/muse-ember) does NOT pick up any bots/grug/* files.
	const pinchy = createPromptResolver({ profileDir: "profiles/muse-ember" });
	assert.ok(pinchy.file("voice").endsWith("profiles/muse-ember/voice.md"));
	assert.ok(pinchy.file("front").endsWith("src/prompts/front.md"));
	assert.ok(pinchy.file("guidance").endsWith("src/prompts/guidance.md"));
	assert.ok(pinchy.formattingFile("telegram.md").endsWith("src/prompts/formatting/telegram.md"));
	assert.doesNotMatch(pinchy.frontPrompt({ channel: "telegram" }), /# ultracave|You are Grug/);
	assert.doesNotMatch(pinchy.readFormatting("telegram")!, /ultracave/);

	// renderGuidance & messageGuidance use bots/grug/guidance.md when passed the Grug resolver,
	// while the default (no resolver) keeps src/prompts/guidance.md untouched.
	const grugRendered = renderGuidance({ fresh_check: { probability: 0.9 } }, ["message.fresh"], {}, grug)!;
	assert.match(grugRendered, /Depends on state right now\. Do not answer from memory or notes\./);
	const defaultRendered = renderGuidance({ fresh_check: { probability: 0.9 } }, ["message.fresh"])!;
	assert.match(defaultRendered, /This depends on how things are right now/);

	const grugStatus = messageGuidance(
		{ asks_status: { probability: 0.9 } },
		{ allowT3: false, liveJobs: true },
		grug,
	)!;
	assert.match(grugStatus, /User seems to ask job status\. Check with `list_workers` before answering\. Never guess\./);

	// decisionClient records templates hash for the persona's guidance.md.
	const logFile = join(dir, "grug-decisions.jsonl");
	const defaultLogFile = join(dir, "default-decisions.jsonl");
	const fakeFetch = (async () =>
		new Response(JSON.stringify({ answers: { fresh_check: { probability: 0.9 } } }), {
			headers: { "Content-Type": "application/json" },
		})) as typeof fetch;
	const grugDecisions = decisionClient({ url: "http://d1.test", logFile, holdout: 0, fetchFn: fakeFetch, prompts: grug });
	const defaultDecisions = decisionClient({ url: "http://d1.test", logFile: defaultLogFile, holdout: 0, fetchFn: fakeFetch });
	await grugDecisions.ask({ id: "g1", site: "message", state: "hi", questions: { fresh_check: { type: "noul", instructions: "fresh?" } } });
	await defaultDecisions.ask({ id: "d1", site: "message", state: "hi", questions: { fresh_check: { type: "noul", instructions: "fresh?" } } });
	const grugTemplatesHash = (JSON.parse(readFileSync(logFile, "utf8").trim()) as { templates: string }).templates;
	const defaultTemplatesHash = (JSON.parse(readFileSync(defaultLogFile, "utf8").trim()) as { templates: string }).templates;
	assert.notEqual(grugTemplatesHash, defaultTemplatesHash);
});
