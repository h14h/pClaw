import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext, Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	AssistantEntry,
	defineExtension,
	defineTool,
	type EntryId,
	SystemEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";
import { openAgent } from "./agent.ts";
import { isDelegateAck } from "./channels/reply-threads.ts";
import { type Config, defaults, resolveSessionResetPolicy, sessionResetClientKey } from "./config.ts";
import { latestRequest, startContextKeeper } from "./context-keeper.ts";
import { deliver } from "./delivery.ts";
import { formatRecentEpisodes, parseEpisodeResponse } from "./episodes.ts";
import { JobStore } from "./extensions/jobs.ts";
import { Memory } from "./extensions/memory.ts";
import { Notes } from "./extensions/notes.ts";
import { reportMessage, Workers } from "./extensions/workers.ts";
import { buildFtsQuery, parseSince } from "./search-index.ts";
import { crossedDailyBoundary, evaluateSessionReset, startSessionKeeper } from "./session-keeper.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pclaw-session-mgmt-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function setupFaux() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models, provider: faux.provider.id, model: faux.models[0]!.id };
}

function makeConfig(
	faux: { provider: string; model: string },
	overrides: Partial<Config> = {},
): Config {
	return {
		...defaults,
		provider: faux.provider,
		model: faux.model,
		thinkingLevel: "off",
		allowT3: false,
		timeZone: "America/Chicago",
		decisionFallback: false,
		...overrides,
	};
}

function withUsage(
	msg: ReturnType<typeof fauxAssistantMessage>,
	usage: Partial<Usage>,
) {
	return {
		...msg,
		usage: {
			...msg.usage,
			...usage,
		},
	};
}

// ---------------------------------------------------------------------------
// Phase 0: Cache-buster fixes & pi.reset safety
// ---------------------------------------------------------------------------

test("Phase 0: section ordering is deterministic and zero pi.system mutations occur across turns, remember(), and clock ticks", async () => {
	const { faux, models, provider, model } = setupFaux();
	let nowMs = Date.parse("2026-11-23T15:00:00Z");
	const homeDir = join(dir, "cache-stability");
	const notes = new Notes(join(homeDir, "notes.md"));
	notes.add("Prefers terse answers");

	const requests: ModelContext[] = [];
	faux.setResponses([
		(req) => {
			requests.push(req);
			return fauxAssistantMessage("hi");
		},
		(req) => {
			requests.push(req);
			return fauxAssistantMessage(fauxToolCall("remember", { note: "Has a dog named Pepper" }), { stopReason: "toolUse" });
		},
		(req) => {
			requests.push(req);
			return fauxAssistantMessage("saved pepper");
		},
		(req) => {
			requests.push(req);
			return fauxAssistantMessage("still warm cache");
		},
	]);

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "cache-stability.sqlite")),
		{
			config: makeConfig({ provider, model }, { sessionReset: { enabled: true } }),
			models,
			notes,
			homeDir,
			memoryQuietMs: 24 * 60 * 60_000,
			now: () => nowMs,
		},
		context,
	);

	try {
		const conv = await agent.conversationFor("telegram:dm:42", context);
		await (await conv.submit({ type: "input", content: "turn 1" }, context)).wait(context);
		nowMs += 60_000;
		await (await conv.submit({ type: "input", content: "remember my dog pepper" }, context)).wait(context);
		nowMs += 120_000;
		await (await conv.submit({ type: "input", content: "turn 3 after 2 minutes" }, context)).wait(context);

		const ctxEntries = (await conv.context(context)).entries;
		const systemEntries = ctxEntries.filter((e) => SystemEntry.is(e));
		assert.equal(systemEntries.length, 1, "expected exactly 1 baseline pi.system entry with zero mid-session mutations");

		const sections = (systemEntries[0]!.model?.[0] as { sections?: Record<string, string> }).sections!;
		assert.deepEqual(Object.keys(sections), ["front", "time-zone", "notes", "recent-episodes", "formatting"]);
		assert.equal(sections["recent-episodes"], "<recent-episodes>\nNone yet.\n</recent-episodes>");
		assert.match(notes.read(), /Has a dog named Pepper/);
	} finally {
		await agent.harness.close(context);
		agent.searchIndex.close();
	}
});

test("Phase 0: delivery catchUp, flushMemory, isDelegateAck, and context-keeper latestRequest all survive pi.reset cleanly", async () => {
	const { faux, models, provider, model } = setupFaux();
	const nowMs = Date.now();
	const homeDir = join(dir, "reset-safety");
	const notes = new Notes(join(homeDir, "notes.md"));

	faux.setResponses([
		() => withUsage(fauxAssistantMessage("pre-reset reply"), { input: 95_000 }),
		// Memory flush model call
		() => fauxAssistantMessage('{"add": ["Uses standing desk"], "remove": []}'),
		// Turn 2 (after reset, while delivery detached)
		() => withUsage(fauxAssistantMessage("post-reset offline reply"), { input: 1_200 }),
		// Second memory flush (post-reset only)
		() => fauxAssistantMessage('{"add": ["Likes dark roast coffee"], "remove": []}'),
	]);

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "reset-safety.sqlite")),
		{
			config: makeConfig({ provider, model }, { sessionReset: { enabled: true } }),
			models,
			notes,
			homeDir,
			memoryQuietMs: 24 * 60 * 60_000,
			now: () => nowMs,
		},
		context,
	);

	try {
		const conv = await agent.conversationFor("telegram:dm:99", context);
		const sent: { text: string; entry: EntryId; replyTo?: string }[] = [];
		const outbox = {
			send: async (text: string, entry: EntryId, meta?: { replyTo?: string }) => {
				sent.push({ text, entry, ...(meta?.replyTo === undefined ? {} : { replyTo: meta.replyTo }) });
			},
			working: () => {},
		};

		// Attach delivery, send turn 1 -> delivered & Delivered.last updated.
		const d1 = await deliver(agent.harness, conv.id, outbox, context, {
			askOf: (entry) => agent.askOf(conv.id, entry, context),
		});
		await (await conv.submit({ type: "input", content: "I bought a standing desk", requestId: "telegram:1001" }, context)).wait(context);
		await d1.stop();
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.text, "pre-reset reply");
		assert.equal(sent[0]!.replyTo, "telegram:1001");

		// Pre-reset latestRequest sees the non-zero prompt token count from turn 1.
		const beforeResetReq = await latestRequest(agent, conv.id, context);
		assert.ok(beforeResetReq !== undefined && beforeResetReq.tokens > 1_000);

		// Manually append a pre-reset delegate ack entry to test isDelegateAck across pi.reset.
		const ackEntry = await conv.commit(async (tx) => {
			return await tx.appendEntry(AssistantEntry, conv.id, {
				model: [
					fauxAssistantMessage(
						[
							{ type: "text", text: "on it" },
							fauxToolCall("delegate", { name: "test-job", brief: "do thing" }),
						],
						{ stopReason: "toolUse" },
					),
				],
			});
		}, context);
		const ackEntryId = ackEntry.id;
		assert.equal(await isDelegateAck(conv, ackEntryId, context), true);

		// Flush memory before reset -> saves note & advances Memory.reviewed.
		const flushed1 = await agent.flushMemory(conv.id, context);
		assert.deepEqual(flushed1.added, ["Uses standing desk"]);
		assert.match(notes.read(), /Uses standing desk/);
		const reviewedBefore = (await agent.harness.snapshot(Memory, conv.id, context))?.reviewed;
		assert.ok(reviewedBefore !== undefined);

		// Commit pi.reset!
		await conv.reset(undefined, context);

		// 1. context-keeper latestRequest MUST return undefined after reset (ignores pre-reset high-token entry).
		assert.equal(await latestRequest(agent, conv.id, context), undefined);
		const ck = startContextKeeper(agent, 1_000, context, 60_000, { checkNotesCopies: false });
		await ck.tick();
		ck.stop();

		// 2. isDelegateAck STILL resolves pre-reset ackEntryId by exact ID!
		assert.equal(await isDelegateAck(conv, ackEntryId, context), true);

		// 3. Submit a post-reset turn while delivery is detached, then re-attach delivery -> catchUp MUST deliver it!
		await (await conv.submit({ type: "input", content: "I like dark roast coffee", requestId: "telegram:1002" }, context)).wait(context);
		const d2 = await deliver(agent.harness, conv.id, outbox, context, {
			askOf: (entry) => agent.askOf(conv.id, entry, context),
		});
		await d2.stop();
		// Catch-up delivers both the manually appended pre-reset ack ("on it") and the post-reset reply without dropping across pi.reset,
		// and NEVER re-sends the already-delivered "pre-reset reply".
		assert.equal(sent.filter((s) => s.text === "pre-reset reply").length, 1);
		const postReset = sent.find((s) => s.text === "post-reset offline reply");
		assert.ok(postReset !== undefined, "delivery catchUp across pi.reset must deliver post-reset reply without dropping it");
		assert.equal(postReset.replyTo, "telegram:1002");

		// 4. Subsequent flushMemory reads only entries past Memory.reviewed (post-reset).
		const flushed2 = await agent.flushMemory(conv.id, context);
		assert.deepEqual(flushed2.added, ["Likes dark roast coffee"]);
		assert.match(notes.read(), /Likes dark roast coffee/);
	} finally {
		await agent.harness.close(context);
		agent.searchIndex.close();
	}
});

// ---------------------------------------------------------------------------
// Phase 1 & 2: Per-client policies, session-keeper, episodes & <recent-episodes>
// ---------------------------------------------------------------------------

test("Phase 1: per-client timeout policy mapping & daily boundary quiet guardrail", () => {
	assert.equal(sessionResetClientKey("telegram:dm:123"), "telegram");
	assert.equal(sessionResetClientKey("telegram:group:-456"), "telegram");
	assert.equal(sessionResetClientKey("discord:dm:789"), "discord:dm");
	assert.equal(sessionResetClientKey("discord:thread:111"), "discord:thread");
	assert.equal(sessionResetClientKey("discord:channel:222"), "discord:thread");
	assert.equal(sessionResetClientKey("matrix:room:!abc"), "matrix");

	const cfg: Config["sessionReset"] = {
		enabled: true,
		idleMinutes: 180,
		dailyHour: 4,
		dailyMinQuietMinutes: 30,
		clients: {
			telegram: { idleMinutes: 120, dailyHour: 4 },
		},
	};
	assert.deepEqual(resolveSessionResetPolicy(cfg, "telegram:dm:1"), {
		clientKey: "telegram",
		idleMinutes: 120,
		dailyHour: 4,
		dailyMinQuietMinutes: 30,
	});
	assert.deepEqual(resolveSessionResetPolicy(cfg, "discord:dm:1"), {
		clientKey: "discord:dm",
		idleMinutes: 180,
		dailyHour: 4,
		dailyMinQuietMinutes: 30,
	});
	// Discord threads default to 24h idle and no daily reset unless explicitly overridden.
	assert.deepEqual(resolveSessionResetPolicy(cfg, "discord:thread:99"), {
		clientKey: "discord:thread",
		idleMinutes: 1440,
		dailyHour: null,
		dailyMinQuietMinutes: 30,
	});

	// Daily boundary guardrail in America/Chicago (CST = UTC-6 in Nov):
	// 03:55 local -> 04:05 local = crossed 4am, only 10m quiet -> must NOT cut off late-night chat.
	const t355 = Date.parse("2026-11-23T09:55:00Z"); // 03:55 CST
	const t405 = Date.parse("2026-11-23T10:05:00Z"); // 04:05 CST
	const t430 = Date.parse("2026-11-23T10:30:00Z"); // 04:30 CST
	const t1000 = Date.parse("2026-11-23T16:00:00Z"); // 10:00 CST

	assert.equal(crossedDailyBoundary(t355, t405, 4, "America/Chicago"), true);
	assert.equal(
		evaluateSessionReset({ address: "telegram:dm:1", config: cfg, lastTurnAt: t355, now: t405, timeZone: "America/Chicago" }).shouldReset,
		false,
	);
	assert.equal(
		evaluateSessionReset({ address: "telegram:dm:1", config: cfg, lastTurnAt: t355, now: t430, timeZone: "America/Chicago" }).shouldReset,
		true,
	);
	// Same day after 4am: 04:05 -> 05:00 (55m quiet, < 120m idle, same reset day) -> false.
	assert.equal(
		evaluateSessionReset({ address: "telegram:dm:1", config: cfg, lastTurnAt: t405, now: t405 + 55 * 60_000, timeZone: "America/Chicago" }).shouldReset,
		false,
	);
	// Same day after 4am: 04:05 -> 10:00 (355m quiet >= 120m idle) -> true via idle trigger!
	assert.equal(
		evaluateSessionReset({ address: "telegram:dm:1", config: cfg, lastTurnAt: t405, now: t1000, timeZone: "America/Chicago" }).shouldReset,
		true,
	);
	// Discord thread at 355m quiet (< 1440m, dailyHour: null) -> false!
	assert.equal(
		evaluateSessionReset({ address: "discord:thread:99", config: cfg, lastTurnAt: t355, now: t1000, timeZone: "America/Chicago" }).shouldReset,
		false,
	);
});

test("Phase 1 & 2: session-keeper blocks on active workers/jobs, distills episode with persona prompt, resets, and injects frozen <recent-episodes>", async () => {
	const { faux, models, provider, model } = setupFaux();
	let nowMs = Date.now();
	const homeDir = join(dir, "session-keeper-e2e");
	const notes = new Notes(join(homeDir, "notes.md"));
	const jobStore = new JobStore(join(homeDir, "jobs.json"));

	let episodeSystemPrompt = "";
	const requests: ModelContext[] = [];
	faux.setResponses([
		// 1. User conversation turn
		(req) => {
			requests.push(req);
			return fauxAssistantMessage("Jonsbo N4 walnut case $135, fits 6 drives.");
		},
		// 2. Pre-reset memory flush
		() => fauxAssistantMessage('{"add": ["Building 6-drive NAS in Jonsbo N4 walnut case"], "remove": []}'),
		// 3. Episode distillation call
		(req) => {
			episodeSystemPrompt = JSON.stringify(req);
			return fauxAssistantMessage(
				'```json\n{"skip": false, "title": "NAS case pick: Jonsbo N4", "summary": "- Picked Jonsbo N4 walnut case ($135, 6 drives)\\n- Open: pick SFX PSU"}\n```',
			);
		},
		// 4. First turn of NEW session (after pi.reset)
		(req) => {
			requests.push(req);
			return fauxAssistantMessage("Corsair SF750 fits N4.");
		},
		// 5. Second turn of NEW session (verify <recent-episodes> stays frozen!)
		(req) => {
			requests.push(req);
			return fauxAssistantMessage("Yep, SF750 quiet.");
		},
	]);

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "session-keeper-e2e.sqlite")),
		{
			config: makeConfig(
				{ provider, model },
				{
					personaDir: "bots/grug",
					sessionReset: { enabled: true, idleMinutes: 180, dailyHour: 4 },
				},
			),
			models,
			notes,
			homeDir,
			jobStore,
			memoryQuietMs: 24 * 60 * 60_000,
			now: () => nowMs,
		},
		context,
	);

	try {
		const conv = await agent.conversationFor("telegram:dm:501", context);
		await (await conv.submit({ type: "input", content: "compare 6-drive walnut NAS cases" }, context)).wait(context);

		const keeper = startSessionKeeper(
			agent,
			{
				models,
				config: makeConfig({ provider, model }, { personaDir: "bots/grug", sessionReset: { enabled: true, idleMinutes: 180, dailyHour: 4 } }),
				everyMs: 60_000,
				now: () => nowMs,
			},
			context,
		);

		try {
			// Advance past idle threshold (4 hours)
			nowMs += 4 * 60 * 60_000;

			// Block 1: active worker in Workers doc prevents reset.
			await conv.commit(async (tx) => {
				(await tx.doc(Workers, conv.id)).workers["nas-research"] = {
					sessionId: "sess-1",
					status: "working",
					brief: "research cases",
					updatedAt: nowMs,
				};
			}, context);
			await keeper.tick();
			assert.equal(agent.searchIndex.stats().episodes, 0, "must not reset while worker is working");

			// Clear worker, add active job -> still blocked.
			await conv.commit(async (tx) => {
				(await tx.doc(Workers, conv.id)).workers["nas-research"]!.status = "idle";
			}, context);
			jobStore.put({
				id: "job-1",
				title: "NAS job",
				brief: "compare cases",
				threadId: "t3-thread-1",
				machine: "mp1",
				origin: "telegram:dm:501",
				state: "working",
				status: "working",
				told: [],
				startedAt: nowMs,
				updatedAt: nowMs,
			});
			await keeper.tick();
			assert.equal(agent.searchIndex.stats().episodes, 0, "must not reset while job is active");

			// Mark job done -> now tick() flushes memory, distills episode, indexes messages, and resets!
			jobStore.put({ ...jobStore.get("job-1")!, state: "done" });
			await keeper.tick();

			// Verify Grug's bots/grug/episode.md prompt was used!
			assert.match(episodeSystemPrompt, /ultracave fragments/);
			assert.match(notes.read(), /Jonsbo N4 walnut case/);

			const stats = agent.searchIndex.stats();
			assert.equal(stats.episodes, 1);
			assert.ok(stats.messages >= 2);

			// Verify active context was reset (only the ResetEntry remains).
			const postResetEntries = (await conv.context(context)).entries;
			assert.equal(postResetEntries.length, 1);
			assert.equal(postResetEntries[0]!.kind, "pi.reset");

			// New session turn 1: fresh baseline pi.system injects <recent-episodes> + fresh <notes>.
			nowMs += 60_000;
			await (await conv.submit({ type: "input", content: "what PSU for that case?" }, context)).wait(context);
			const newSessionSystem = (await conv.context(context)).entries.filter((e) => SystemEntry.is(e));
			assert.equal(newSessionSystem.length, 1);
			const secs = (newSessionSystem[0]!.model?.[0] as { sections?: Record<string, string> }).sections!;
			assert.match(secs["recent-episodes"] ?? "", /NAS case pick: Jonsbo N4/);
			assert.match(secs["recent-episodes"] ?? "", /\$135, 6 drives/);
			assert.match(secs.notes ?? "", /Jonsbo N4 walnut case/);

			// Even if another episode is saved externally mid-session, <recent-episodes> stays frozen!
			agent.searchIndex.saveEpisode({
				userId: "owner",
				conversationId: String(conv.id),
				channel: "discord",
				startedAt: nowMs,
				endedAt: nowMs,
				firstEntryId: 900,
				lastEntryId: 901,
				title: "External mid-session episode",
				summary: "- should not mutate live session prompt",
				createdAt: nowMs,
			});
			nowMs += 60_000;
			await (await conv.submit({ type: "input", content: "is it quiet?" }, context)).wait(context);
			const afterTurn2System = (await conv.context(context)).entries.filter((e) => SystemEntry.is(e));
			assert.equal(afterTurn2System.length, 1, "recent-episodes must remain frozen mid-session");
		} finally {
			keeper.stop();
		}
	} finally {
		await agent.harness.close(context);
		agent.searchIndex.close();
	}
});

test("Phase 2 helpers: parseEpisodeResponse handles skip & array summaries, formatRecentEpisodes respects char cap", () => {
	assert.deepEqual(parseEpisodeResponse('{"skip": true, "title": "", "summary": ""}'), {
		skip: true,
		title: "",
		summary: "",
	});
	const arr = parseEpisodeResponse('{"skip": false, "title": "Tax prep", "summary": ["Filed 1099", "- Paid $400"]}');
	assert.equal(arr.skip, false);
	assert.equal(arr.summary, "- Filed 1099\n- Paid $400");

	const formatted = formatRecentEpisodes(
		[
			{
				id: 1,
				userId: "owner",
				conversationId: "1",
				channel: "telegram",
				startedAt: 1_700_000_000_000,
				endedAt: 1_700_000_000_000,
				firstEntryId: 1,
				lastEntryId: 2,
				title: "Old big episode",
				summary: `- ${"a".repeat(2500)}`,
				createdAt: 1_700_000_000_000,
			},
			{
				id: 2,
				userId: "owner",
				conversationId: "1",
				channel: "discord",
				startedAt: 1_700_010_000_000,
				endedAt: 1_700_010_000_000,
				firstEntryId: 3,
				lastEntryId: 4,
				title: "New concise episode",
				summary: "- Picked SF750",
				createdAt: 1_700_010_000_000,
			},
		],
		"America/Chicago",
		500,
	);
	assert.match(formatted, /New concise episode/);
	assert.doesNotMatch(formatted, /Old big episode/);
	assert.ok(formatted.length <= 500);
});

// ---------------------------------------------------------------------------
// Phase 3: SQLite FTS5 recall v2 & strict multi-user isolation
// ---------------------------------------------------------------------------

test("Phase 3: FTS5 recall searches episodes, messages, and worker reports, handles special chars, filters kind/since, and enforces strict multi-user isolation", async () => {
	const { faux, models, provider, model } = setupFaux();
	let nowMs = Date.parse("2026-11-23T15:00:00Z");
	const homeDir = join(dir, "recall-fts5");

	// Unit checks on query sanitizer and since parser
	assert.ok(buildFtsQuery('C++ "foo:bar" (test) AND OR NOT -bad *') !== undefined);
	assert.equal(parseSince("7d", nowMs), nowMs - 7 * 86_400_000);
	assert.equal(parseSince("24h", nowMs), nowMs - 24 * 3_600_000);
	assert.equal(parseSince("2026-11-01T00:00:00Z", nowMs), Date.parse("2026-11-01T00:00:00Z"));

	const multiConfig = makeConfig(
		{ provider, model },
		{
			users: {
				henry: { name: "Henry", timeZone: "America/Chicago", telegram: "100", discord: "200" },
				max: { name: "Max", timeZone: "America/New_York", telegram: "101", discord: "201" },
				willy: { name: "Willy", timeZone: "America/Los_Angeles", telegram: "102" },
			},
		},
	);

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "recall-fts5.sqlite")),
		{
			config: multiConfig,
			models,
			notes: new Notes(join(homeDir, "notes.md")),
			homeDir,
			memoryQuietMs: 24 * 60 * 60_000,
			now: () => nowMs,
		},
		context,
	);

	try {
		// Verify 0600 permissions on pclaw-index.sqlite
		const mode = statSync(agent.searchIndex.path).mode & 0o777;
		assert.equal(mode, 0o600);

		const henryTg = await agent.conversationFor("telegram:dm:100", context);
		const henryDc = await agent.conversationFor("discord:dm:200", context);
		const maxTg = await agent.conversationFor("telegram:dm:101", context);
		const willyTg = await agent.conversationFor("telegram:dm:102", context);
		const group = await agent.conversationFor("telegram:group:-999", context);

		// Populate history for Henry (including a <worker-report>), Max, and Willy.
		faux.setResponses([
			() => fauxAssistantMessage("Looked at Synology vs custom cobalt ZFS server."),
			() => fauxAssistantMessage("Relayed cobalt ZFS benchmark numbers."),
			() => fauxAssistantMessage("Max's emerald kubernetes cluster looks healthy."),
			() => fauxAssistantMessage("Willy's saffron sourdough hydration is 78%."),
		]);

		await (await henryTg.submit({ type: "input", content: "research cobalt ZFS pool layouts" }, context)).wait(context);
		await (
			await henryTg.submit(
				{
					type: "input",
					content: reportMessage("zfs-bench", {
						ok: true,
						output: "Benchmark result: cobalt ZFS raidz2 hit 1840 MB/s sequential read on 6x Exos X20 drives.",
					}),
				},
				context,
			)
		).wait(context);
		await (await maxTg.submit({ type: "input", content: "check my emerald kubernetes nodes" }, context)).wait(context);
		await (await willyTg.submit({ type: "input", content: "saffron sourdough starter schedule" }, context)).wait(context);

		// Save an episode for Henry too.
		agent.searchIndex.saveEpisode({
			userId: "user:henry",
			conversationId: String(henryTg.id),
			channel: "telegram",
			startedAt: nowMs - 3600_000,
			endedAt: nowMs - 1800_000,
			firstEntryId: 1,
			lastEntryId: 4,
			title: "Cobalt ZFS raidz2 build",
			summary: "- Selected raidz2 on 6x Exos X20 drives (1840 MB/s)\n- Open: order HBA card",
			createdAt: nowMs,
		});

		// Backfill once -> indexes all messages + worker report; backfill twice -> idempotent (+0 new).
		const b1 = await agent.searchIndex.backfillAll(agent.harness, context, agent.users);
		assert.ok(b1.indexed >= 7);
		const b2 = await agent.searchIndex.backfillAll(agent.harness, context, agent.users);
		assert.equal(b2.indexed, 0);
		assert.equal(agent.searchIndex.stats().workerReports, 1);

		// Reset Henry's Telegram session so the cobalt messages & worker report leave active context.
		await henryTg.reset(undefined, context);

		// Henry calls recall on Telegram (after reset) for cobalt ZFS + special-char query + kind/since + isolation check!
		const recallResponses: ModelContext[] = [];
		faux.setResponses([
			() => fauxAssistantMessage(fauxToolCall("recall", { query: "cobalt ZFS raidz2" }), { stopReason: "toolUse" }),
			(req) => {
				recallResponses.push(req);
				return fauxAssistantMessage(fauxToolCall("recall", { query: "cobalt ZFS", kind: "episodes" }), { stopReason: "toolUse" });
			},
			(req) => {
				recallResponses.push(req);
				return fauxAssistantMessage(fauxToolCall("recall", { query: "Exos X20 1840 MB/s (bench) : *" }), { stopReason: "toolUse" });
			},
			(req) => {
				recallResponses.push(req);
				return fauxAssistantMessage(fauxToolCall("recall", { query: "emerald kubernetes saffron sourdough" }), { stopReason: "toolUse" });
			},
			(req) => {
				recallResponses.push(req);
				return fauxAssistantMessage("done");
			},
		]);
		await (await henryTg.submit({ type: "input", content: "what were those ZFS speeds?" }, context)).wait(context);

		const toolResults = recallResponses.at(-1)!.messages.filter((m) => m.role === "toolResult");
		const r0 = JSON.stringify(toolResults[0]);
		const r1 = JSON.stringify(toolResults[1]);
		const r2 = JSON.stringify(toolResults[2]);
		const r3 = JSON.stringify(toolResults[3]);

		// r0: matches episode + worker report + messages (episode boosted first!)
		assert.match(r0, /episode\] Cobalt ZFS raidz2 build/);
		assert.match(r0, /report \(zfs-bench\)/);
		// r1: kind="episodes" returns ONLY episodes
		assert.match(r1, /episode\] Cobalt ZFS raidz2 build/);
		assert.doesNotMatch(r1, /report \(zfs-bench\)/);
		// r2: special-char query safely finds worker report without FTS5 syntax error!
		assert.match(r2, /1840 MB\/s/);
		// r3: Henry CANNOT see Max's kubernetes or Willy's sourdough!
		assert.match(r3, /Nothing found/);
		assert.doesNotMatch(r3, /emerald|saffron/);

		// Henry on Discord can also recall his own Telegram episode & report (cross-client continuity).
		const dcRecall = agent.searchIndex.search({ userId: "user:henry", query: "Exos X20", limit: 5 });
		assert.ok(dcRecall.length >= 2);
		assert.ok(henryDc.id !== henryTg.id);

		// Max, Willy, and shared group CANNOT see Henry's cobalt ZFS data!
		assert.equal(agent.searchIndex.search({ userId: "user:max", query: "cobalt ZFS" }).length, 0);
		assert.equal(agent.searchIndex.search({ userId: "user:willy", query: "cobalt ZFS" }).length, 0);
		assert.equal(agent.searchIndex.search({ userId: `conv:${group.id}`, query: "cobalt ZFS" }).length, 0);
	} finally {
		await agent.harness.close(context);
		agent.searchIndex.close();
	}
});

// ---------------------------------------------------------------------------
// Phase 4: Static per-channel AgentChange tool scoping
// ---------------------------------------------------------------------------

test("Phase 4: static per-channel AgentChange excludes Discord-only ping_owner on Telegram, supports opt-in channel extensions, and survives setModel()", async () => {
	const { faux, models, provider, model } = setupFaux();
	const homeDir = join(dir, "channel-scoping");

	const matrixOnlyExt = defineExtension({
		name: "pclaw.matrix.test",
		tools: [
			defineTool({
				name: "matrix_room_topic",
				description: "Test Matrix-only tool.",
				parameters: obj({ topic: str() }),
				execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
			}),
		],
	});

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "channel-scoping.sqlite")),
		{
			config: makeConfig({ provider, model }, { allowT3: true, t3Url: "http://127.0.0.1:3773" }),
			models,
			notes: new Notes(join(homeDir, "notes.md")),
			homeDir,
			jobStore: new JobStore(join(homeDir, "jobs.json")),
			channelExtensions: { matrix: [matrixOnlyExt] },
			memoryQuietMs: 24 * 60 * 60_000,
		},
		context,
	);

	try {
		const tg = await agent.conversationFor("telegram:dm:101", context);
		const dc = await agent.conversationFor("discord:dm:201", context);
		const mx = await agent.conversationFor("matrix:room:!abc", context);

		const tgTools = (await tg.agent(context)).tools.map((t) => t.name);
		const dcTools = (await dc.agent(context)).tools.map((t) => t.name);
		const mxTools = (await mx.agent(context)).tools.map((t) => t.name);

		assert.ok(!tgTools.includes("ping_owner"), "Telegram must never receive Discord-only ping_owner");
		assert.ok(!tgTools.includes("matrix_room_topic"), "Telegram must never receive Matrix-only tools");
		assert.ok(tgTools.includes("recall") && tgTools.includes("remember"));

		assert.ok(dcTools.includes("ping_owner"), "Discord keeps ping_owner when T3 is enabled");
		assert.ok(!dcTools.includes("matrix_room_topic"), "Discord must not receive Matrix-only tools");

		assert.ok(mxTools.includes("matrix_room_topic"), "Matrix receives its opt-in channel extension");
		assert.ok(!mxTools.includes("ping_owner"), "Matrix excludes Discord-only ping_owner");

		// Calling setModel() must preserve every conversation's static per-channel scoping!
		await agent.setModel({ provider, model, thinkingLevel: "low" }, context);
		const tgAfter = await tg.agent(context);
		const dcAfter = await dc.agent(context);
		const mxAfter = await mx.agent(context);

		assert.equal(tgAfter.thinkingLevel, "low");
		assert.ok(!tgAfter.tools.some((t) => t.name === "ping_owner"), "setModel must preserve Telegram exclusion of ping_owner");
		assert.ok(dcAfter.tools.some((t) => t.name === "ping_owner"), "setModel must preserve Discord ping_owner");
		assert.ok(mxAfter.tools.some((t) => t.name === "matrix_room_topic"), "setModel must preserve Matrix channel extension");
	} finally {
		await agent.harness.close(context);
		agent.searchIndex.close();
	}
});
