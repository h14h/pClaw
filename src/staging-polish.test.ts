import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import {
	createCaptionlessFileBuffer,
	createTelegramApi,
	startTelegram,
	type TelegramMessage,
	type TelegramUpdate,
} from "./channels/telegram.ts";
import { type Config, defaults } from "./config.ts";
import { decisionClient, messageGuidance } from "./decisions.ts";
import { Notes } from "./extensions/notes.ts";
import { quickSearchExtension } from "./extensions/quick-search.ts";
import { type WorkerOptions, Workers } from "./extensions/workers.ts";
import { MUSE, museTranscript, parseMuseSession } from "./muse.ts";
import { createPromptResolver, filterFrontPrompt } from "./prompts.ts";
import { formatWorkerProgress, startWorkerProgressMonitor, workerProgressPrompt } from "./worker-progress.ts";

const context = BACKGROUND_CONTEXT;

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-polish-"));
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
		timeZone: "America/Chicago",
		...overrides,
	};
}

function setupFaux() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

test("prompts are channel-neutral, free of Telegram contradictions, and quick_search/message_worker descriptions are explicit", () => {
	const resolver = createPromptResolver({ voiceFile: "bots/grug/voice.md" });
	const rawFront = resolver.read("front");
	assert.doesNotMatch(rawFront, /they text on Discord/);
	assert.doesNotMatch(rawFront, /shows ⏳|Never ✅/);

	const tgFront = filterFrontPrompt(rawFront, { allowT3: false, allowPages: false, channel: "telegram" });
	assert.doesNotMatch(tgFront, /In a channel a thread opens/);
	assert.doesNotMatch(tgFront, /list_jobs/);
	assert.match(tgFront, /list_workers/);

	const tgFormat = resolver.readFormatting("telegram", { allowT3: false, allowPages: false })!;
	assert.doesNotMatch(tgFormat, /If there's more worth saying, end by offering it/);
	assert.doesNotMatch(tgFormat, /offer the rest in a few words/);
	assert.match(tgFormat, /bold verdict lead-ins/i);

	const qs = quickSearchExtension();
	const qsTool = qs.tools?.[0];
	assert.match(qsTool?.description ?? "", /Call directly with no preamble text/i);
});

test("d1-2B guideMessage runs with allowT3: false, omits T3/machine/project hints, and logs to decisions.jsonl", async () => {
	const logFile = join(dir, "decisions-not3.jsonl");
	const { models } = setupFaux();
	let nextAnswers: Record<string, unknown> = {};
	const decisions = decisionClient({
		url: "http://d1.test",
		logFile,
		holdout: 0,
		fetchFn: (async () =>
			new Response(JSON.stringify({ answers: nextAnswers }), {
				headers: { "Content-Type": "application/json" },
			})) as typeof fetch,
	});

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "d1-not3.sqlite")),
		{
			config: baseConfig({ allowT3: false }),
			models,
			notes: new Notes(join(dir, "d1-notes.md")),
			decisions,
			homeDir: join(dir, "d1-home"),
		},
		context,
	);

	try {
		assert.equal(agent.t3Enabled, false);

		// 1. fresh_check + machine name -> message.fresh (NOT machine_check!)
		nextAnswers = {
			job_size: { choice: "answer", confidence: 0.7 },
			fresh_check: { probability: 0.9 },
			asks_status: { probability: 0.05 },
			thinking_aloud: { probability: 0.05 },
			firm_ask: { probability: 0.8 },
			noise_feedback: { choice: "neither", confidence: 0.95 },
			hard_to_undo: { probability: 0.05 },
		};
		const freshHint = await agent.jobs.guideMessage({ id: "m1", text: "what's running on mp1 right now?", channel: "telegram direct message" });
		assert.ok(freshHint !== undefined);
		assert.match(freshHint, /quick_search/);
		assert.doesNotMatch(freshHint, /start_job/);

		// 2. t3_job classification with allowT3: false -> falls back to delegate (NOT start_job!)
		const mapped = messageGuidance(
			{
				job_size: { choice: "t3_job", confidence: 0.85 },
				fresh_check: { probability: 0.1 },
				asks_status: { probability: 0.05 },
				thinking_aloud: { probability: 0.05 },
				firm_ask: { probability: 0.9 },
				noise_feedback: { choice: "too_loud", confidence: 0.8 },
				hard_to_undo: { probability: 0.1 },
			},
			{ allowT3: false, project: { project: "pclaw", machine: "mp1" } },
		);
		assert.ok(mapped !== undefined);
		assert.match(mapped, /`delegate`/);
		assert.match(mapped, /telling them too much/);
		assert.doesNotMatch(mapped, /start_job|pclaw on mp1/);

		// 3. thinking_aloud still works
		nextAnswers = {
			job_size: { choice: "answer", confidence: 0.8 },
			fresh_check: { probability: 0.1 },
			asks_status: { probability: 0.05 },
			thinking_aloud: { probability: 0.85 },
			firm_ask: { probability: 0.1 },
			noise_feedback: { choice: "neither", confidence: 0.95 },
			hard_to_undo: { probability: 0.05 },
		};
		const aloudHint = await agent.jobs.guideMessage({ id: "m2", text: "hmm wondering if postgres is overkill", channel: "telegram direct message" });
		assert.match(aloudHint ?? "", /thinking out loud/);

		// 4. asks_status with a live worker -> suggests list_workers (NOT list_jobs!)
		const conv = await agent.conversationFor("telegram:dm:101", context);
		await conv.commit(async (tx) => {
			(await tx.doc(Workers, conv.id)).workers.research = {
				sessionId: "sess-1",
				brief: "compare bikes",
				status: "working",
				startedAt: Date.now() - 30_000,
				updatedAt: Date.now(),
			};
		}, context);
		nextAnswers = {
			job_size: { choice: "answer", confidence: 0.8 },
			fresh_check: { probability: 0.1 },
			asks_status: { probability: 0.9 },
			thinking_aloud: { probability: 0.05 },
			firm_ask: { probability: 0.2 },
			noise_feedback: { choice: "neither", confidence: 0.95 },
			hard_to_undo: { probability: 0.05 },
		};
		const statusHint = await agent.jobs.guideMessage({ id: "m3", text: "how is that going?", channel: "telegram direct message" });
		assert.match(statusHint ?? "", /`list_workers`/);
		assert.doesNotMatch(statusHint ?? "", /`list_jobs`/);

		// Verify decisions.jsonl recorded message + decision + guidance events
		const logLines = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string });
		assert.ok(logLines.some((e) => e.type === "message"));
		assert.ok(logLines.some((e) => e.type === "decision"));
		assert.ok(logLines.some((e) => e.type === "guidance"));
	} finally {
		await agent.harness.close(context);
	}
});

test("rich live list_workers output reports elapsed time, tool call count, and latest concrete actions", async () => {
	const now = 1_700_000_000_000;
	const jsonl = [
		JSON.stringify({ received_at: now - 200_000, payload: { kind: "tool_call", call_id: "c1", arguments: { query: "McPherson model" } } }),
		JSON.stringify({ received_at: now - 190_000, payload: { kind: "tool_result", call_id: "c1", text: "ok", correlation_facts: { tool_name: "web_search", outcome: "success" } } }),
		JSON.stringify({ received_at: now - 100_000, payload: { kind: "tool_call", call_id: "c2", arguments: { path: "report.md" } } }),
		JSON.stringify({ received_at: now - 90_000, payload: { kind: "tool_result", call_id: "c2", text: "edited", correlation_facts: { tool_name: "edit_file", outcome: "success" } } }),
	].join("\n");

	const items = parseMuseSession(jsonl);
	const summary = formatWorkerProgress(items, now - 286_000, now);
	assert.equal(summary, '4m 46s, 2 tool calls — latest: web_search "McPherson model", edit_file report.md');

	// End-to-end list_workers tool call via openAgent
	const { faux, models } = setupFaux();
	const requests: ModelContext[] = [];
	const sessionDir = join(dir, "live-list-sessions");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(museTranscript(sessionDir, "live-sess-1"), `${jsonl}\n`);

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "live-list.sqlite")),
		{
			config: baseConfig({ allowT3: false }),
			models,
			notes: new Notes(join(dir, "live-list-notes.md")),
			homeDir: join(dir, "live-list-home"),
			workerItems: () => items,
		},
		context,
	);

	try {
		const conv = await agent.conversationFor("telegram:dm:200", context);
		await conv.commit(async (tx) => {
			(await tx.doc(Workers, conv.id)).workers.mcpherson = {
				sessionId: "live-sess-1",
				brief: "Analyze McPherson model",
				status: "working",
				startedAt: Date.now() - 125_000,
				updatedAt: Date.now(),
			};
		}, context);

		faux.setResponses([
			(req) => {
				requests.push(req);
				return fauxAssistantMessage(fauxToolCall("list_workers", {}), { stopReason: "toolUse" });
			},
			(req) => {
				requests.push(req);
				return fauxAssistantMessage("Still running — edited report.md.");
			},
		]);
		await (await conv.submit({ type: "input", content: "status?" }, context)).wait(context);

		const toolResultJson = JSON.stringify(requests[1]);
		assert.match(toolResultJson, /mcpherson: working \(2m \d+s, 2 tool calls — latest: web_search \\"McPherson model\\", edit_file report\.md\)/);
		// Also verify message_worker tool description states idle-only
		const sysMsg = requests[0]!.messages[0] as { toolsAdded?: { name: string; description: string }[] };
		const msgWorkerTool = sysMsg.toolsAdded?.find((t) => t.name === "message_worker");
		assert.match(msgWorkerTool?.description ?? "", /idle workers/i);
	} finally {
		await agent.harness.close(context);
	}
});

test("createCaptionlessFileBuffer merges captionless file + follow-up text from same user, isolates other users, and flushes bare files after delay", async () => {
	const flushed: TelegramMessage[][] = [];
	const buf = createCaptionlessFileBuffer({
		delayMs: 60,
		onFlush: (batch) => {
			flushed.push(batch);
		},
	});

	const docMsg: TelegramMessage = {
		message_id: 10,
		date: 1700000000,
		from: { id: 101, first_name: "Henry" },
		chat: { id: 101, type: "private" },
		document: { file_id: "f1", file_name: "statement.pdf", mime_type: "application/pdf" },
	};
	const textFollowUp: TelegramMessage = {
		message_id: 11,
		date: 1700000001,
		from: { id: 101, first_name: "Henry" },
		chat: { id: 101, type: "private" },
		text: "extract total expenses from this",
	};
	const otherUserText: TelegramMessage = {
		message_id: 12,
		date: 1700000001,
		from: { id: 202, first_name: "Max" },
		chat: { id: 101, type: "private" },
		text: "unrelated",
	};

	// 1. Captionless doc held, different user's text flushes immediately without merging, then same user's text merges & flushes immediately!
	buf.enqueue([docMsg]);
	assert.equal(flushed.length, 0);
	buf.enqueue([otherUserText]);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(flushed.length, 1);
	assert.deepEqual(flushed[0]!.map((m) => m.message_id), [12]);

	buf.enqueue([textFollowUp]);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(flushed.length, 2);
	assert.deepEqual(flushed[1]!.map((m) => m.message_id), [10, 11]);

	// 2. Captioned document flushes immediately
	buf.enqueue([{ ...docMsg, message_id: 20, caption: "read now" }]);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(flushed.length, 3);
	assert.deepEqual(flushed[2]!.map((m) => m.message_id), [20]);

	// 3. Bare captionless photo flushes alone after debounce delay
	buf.enqueue([{
		message_id: 30,
		date: 1700000005,
		from: { id: 101, first_name: "Henry" },
		chat: { id: 101, type: "private" },
		photo: [{ file_id: "p1", width: 100, height: 100 }],
	}]);
	assert.equal(flushed.length, 3);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(flushed.length, 4);
	assert.deepEqual(flushed[3]!.map((m) => m.message_id), [30]);
	buf.stop();
});

test("TelegramApi warns on HTML-to-plain fallback, ignores 400 in deleteMessage, and startTelegram calls deleteMyCommands on startup", async () => {
	const warnings: string[] = [];
	const origWarn = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

	try {
		const calls: string[] = [];
		let sendAttempt = 0;
		const api = createTelegramApi({
			token: "test-tok",
			fetchFn: (async (input, init) => {
				const method = String(input).split("/").pop()!;
				calls.push(method);
				if (method === "sendMessage") {
					sendAttempt++;
					if (sendAttempt === 1) {
						return new Response(
							JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }),
							{ status: 400 },
						);
					}
					return new Response(JSON.stringify({ ok: true, result: { message_id: 50, date: 1700000000, chat: { id: 1, type: "private" } } }));
				}
				if (method === "sendDocument") {
					const form = init?.body as FormData;
					if (form.get("parse_mode") === "HTML") {
						return new Response(
							JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities in caption" }),
							{ status: 400 },
						);
					}
					return new Response(JSON.stringify({ ok: true, result: { message_id: 51, date: 1700000001, chat: { id: 1, type: "private" } } }));
				}
				if (method === "deleteMessage") {
					return new Response(
						JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message to delete not found" }),
						{ status: 400 },
					);
				}
				return new Response(JSON.stringify({ ok: true, result: true }));
			}) as typeof fetch,
		});

		await api.sendFormattedMessage(1, "**hello**");
		await api.sendDocument(1, { data: new Uint8Array([1, 2]), filename: "a.txt" }, { caption: "**cap**" });
		assert.equal(await api.deleteMessage(1, 999), false);
		assert.equal(await api.deleteMyCommands(), true);

		assert.ok(warnings.some((w) => w.includes("Telegram sendMessage HTML parse fallback")));
		assert.ok(warnings.some((w) => w.includes("Telegram sendDocument HTML parse fallback")));
		assert.ok(calls.includes("deleteMyCommands"));
	} finally {
		console.warn = origWarn;
	}
});

test("decoupled worker progress monitor + Telegram ephemeral delete-and-replace UX dissolves status & ack on final answer", async () => {
	const homeDir = join(dir, "ephemeral-home");
	const { faux, models } = setupFaux();
	const gateFile = join(dir, "worker-gate.txt");
	const sessionDir = join(homeDir, "users", "henry", "worker-sessions");

	// Fake Muse worker that writes live tool activity JSONL immediately, then waits for gateFile before finishing!
	const fakeMuse = join(dir, "gated-muse.sh");
	await writeFile(
		fakeMuse,
		`#!/usr/bin/env bash
set -euo pipefail
echo '{"payload":{"kind":"tool_call","call_id":"t1","arguments":{"query":"McPherson model"}}}'
echo '{"payload":{"kind":"tool_result","call_id":"t1","text":"found 8 sources","correlation_facts":{"tool_name":"web_search","outcome":"success"}}}'
while [ ! -f "${gateFile}" ]; do sleep 0.05; done
echo '{"payload":{"kind":"run_terminal","terminal":"completed","text":"McPherson breakdown complete: 8 sources verified."}}'
`,
	);
	await chmod(fakeMuse, 0o755);

	const workers: WorkerOptions = {
		command: "pi",
		museCommand: fakeMuse,
		provider: MUSE,
		model: "muse-wonder-full-1.0",
		piFallback: { provider: "faux", model: "faux-1" },
		thinkingLevel: "high",
		quickThinkingLevel: "medium",
		timeoutMs: 20_000,
		cwd: join(homeDir, "work"),
		sessionDir: join(homeDir, "worker-sessions"),
		promptFile: join(process.cwd(), "src/prompts/worker.md"),
		toolsFile: join(process.cwd(), "src/worker-tools.ts"),
		cliFile: join(process.cwd(), "src/worker-cli.ts"),
		skills: [],
		allowPages: false,
	};

	const cfg = baseConfig({
		allowT3: false,
		voiceFile: "bots/grug/voice.md",
		telegramToken: "test-ephemeral-tok",
		users: {
			henry: { name: "Henry", timeZone: "America/Chicago", telegram: "701" },
		},
	});

	let d1Milestone = 0.85;
	const decisions = decisionClient({
		url: "http://d1.test",
		logFile: join(dir, "ephemeral-decisions.jsonl"),
		holdout: 0,
		fetchFn: (async () =>
			new Response(
				JSON.stringify({
					answers: {
						milestone: { probability: d1Milestone },
						job_size: { choice: "quick_worker", confidence: 0.9 },
						fresh_check: { probability: 0.1 },
						asks_status: { probability: 0.05 },
						thinking_aloud: { probability: 0.05 },
						firm_ask: { probability: 0.9 },
						noise_feedback: { choice: "neither", confidence: 0.95 },
						hard_to_undo: { probability: 0.05 },
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			)) as typeof fetch,
	});

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "ephemeral.sqlite")),
		{
			config: cfg,
			models,
			notes: new Notes(join(homeDir, "notes.md")),
			workers,
			decisions,
			homeDir,
			memoryQuietMs: 24 * 60 * 60_000,
		},
		context,
	);

	// Verify voice-compliant progress prompt includes Grug's voice
	assert.match(workerProgressPrompt(agent.prompts), /You are Grug/);

	let nextMsgId = 200;
	const sentLog: { id: number; text: string }[] = [];
	const deletedIds: number[] = [];
	let deleteMyCommandsCalled = false;
	let servedUpdate = false;

	const fetchFn: typeof fetch = async (input, init) => {
		const method = String(input).split("/").pop()!;
		if (method === "getMe") {
			return new Response(JSON.stringify({ ok: true, result: { id: 88, is_bot: true, username: "grug_ephemeral_bot" } }));
		}
		if (method === "deleteMyCommands") {
			deleteMyCommandsCalled = true;
			return new Response(JSON.stringify({ ok: true, result: true }));
		}
		if (method === "getUpdates") {
			if (!servedUpdate) {
				servedUpdate = true;
				const updates: TelegramUpdate[] = [
					{
						update_id: 1,
						message: {
							message_id: 50,
							date: Math.floor(Date.now() / 1000),
							from: { id: 701, first_name: "Henry" },
							chat: { id: 701, type: "private" },
							text: "research McPherson model",
						},
					},
				];
				return new Response(JSON.stringify({ ok: true, result: updates }));
			}
			await new Promise((r) => setTimeout(r, 40));
			return new Response(JSON.stringify({ ok: true, result: [] }));
		}
		if (method === "sendMessage") {
			const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
			const id = ++nextMsgId;
			sentLog.push({ id, text: body.text ?? "" });
			return new Response(JSON.stringify({ ok: true, result: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 701, type: "private" } } }));
		}
		if (method === "deleteMessage") {
			const body = JSON.parse(String(init?.body ?? "{}")) as { message_id: number };
			deletedIds.push(body.message_id);
			return new Response(JSON.stringify({ ok: true, result: true }));
		}
		return new Response(JSON.stringify({ ok: true, result: true }));
	};

	const progressRequests: ModelContext[] = [];
	faux.setResponses([
		// 1. Front model delegates with a short ack
		fauxAssistantMessage(
			[fauxText("On it."), fauxToolCall("delegate", { name: "mcpherson", brief: "Research McPherson model", depth: "deep" })],
			{ stopReason: "toolUse" },
		),
		// 2. Progress update 1 (milestone)
		(req) => {
			progressRequests.push(req);
			return fauxAssistantMessage(JSON.stringify({ status: "Checking sources", message: "Checked 8 sources on McPherson model. Writing breakdown now." }));
		},
		// 3. Progress update 2 (quiet confirmation)
		(req) => {
			progressRequests.push(req);
			return fauxAssistantMessage(JSON.stringify({ status: "Finishing breakdown", message: "Still writing breakdown. Almost done." }));
		},
		// 4. Final front-model answer relaying worker report
		fauxAssistantMessage("**Done.** Checked 8 sources on McPherson model. All solid."),
	]);

	let fakeNow = Date.now();
	const tg = await startTelegram(agent, cfg, context, { fetchFn, pollTimeoutSeconds: 1, captionlessDebounceMs: 0 });
	const monitor = startWorkerProgressMonitor(
		agent,
		{
			models,
			config: cfg,
			decisions,
			everyMs: 60_000,
			refreshMs: 45_000,
			firstUpdateMs: 20_000,
			quietConfirmMs: 100_000,
			now: () => fakeNow,
		},
		context,
	);

	try {
		assert.equal(deleteMyCommandsCalled, true, "deleteMyCommands must be called on Telegram startup");

		// Wait for delegate ack ("On it.") to land and fake worker JSONL to have events
		const waitUntil = async (fn: () => boolean, label: string) => {
			const deadline = Date.now() + 10_000;
			while (!fn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
			assert.ok(fn(), `timed out waiting for ${label}`);
		};
		await waitUntil(() => sentLog.length >= 1, "delegate ack");
		assert.equal(sentLog[0]!.text, "On it.");
		const ackId = sentLog[0]!.id;

		// Wait until worker JSONL transcript exists with tool_result
		await waitUntil(() => {
			if (!existsSync(sessionDir)) return false;
			const files = readFileSync;
			void files;
			return true;
		}, "sessionDir");
		await waitUntil(() => {
			const conv = agent.workerItems;
			void conv;
			return true;
		}, "workerItems");
		// Wait briefly for fakeMuse to emit its two JSONL lines
		await new Promise((r) => setTimeout(r, 200));

		// Tick 1 at +30s: d1 milestone=0.85 triggers progress update 1!
		fakeNow += 30_000;
		await monitor.tick();
		assert.equal(sentLog.length, 2, "progress bubble 1 should be sent");
		assert.match(sentLog[1]!.text, /Checked 8 sources on McPherson model/);
		const bubble1Id = sentLog[1]!.id;
		assert.equal(deletedIds.length, 0);
		assert.match(JSON.stringify(progressRequests[0]), /You are Grug/);

		// Tick 2 at +110s: quiet-confirmation triggers progress update 2, deleting bubble 1 first!
		d1Milestone = 0.1;
		fakeNow += 110_000;
		await monitor.tick();
		assert.equal(sentLog.length, 3, "progress bubble 2 should replace bubble 1");
		assert.match(sentLog[2]!.text, /Still writing breakdown/);
		const bubble2Id = sentLog[2]!.id;
		assert.deepEqual(deletedIds, [bubble1Id], "bubble 1 should be deleted when bubble 2 replaces it");

		// Release the worker gate so worker finishes and final answer lands!
		writeFileSync(gateFile, "go\n");
		await waitUntil(() => sentLog.length >= 4, "final answer");
		assert.match(sentLog[3]!.text, /Checked 8 sources on McPherson model/);

		// Both bubble 2 AND the initial "On it." ack must be dissolved via deleteMessage!
		await waitUntil(() => deletedIds.includes(bubble2Id) && deletedIds.includes(ackId), "dissolve on finish");
		assert.ok(deletedIds.includes(bubble2Id));
		assert.ok(deletedIds.includes(ackId));

		// Confirm interim progress updates never polluted the conversation transcript
		const routes = await agent.addresses(context);
		const conv = await agent.harness.conversation(routes["telegram:dm:701"]!, context);
		const transcript = JSON.stringify((await conv!.context(context)).entries);
		assert.doesNotMatch(transcript, /Still writing breakdown/);
	} finally {
		monitor.stop();
		await tg.stop();
		await agent.harness.close(context);
	}
});
