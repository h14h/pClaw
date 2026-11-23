import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import { type Config, defaults } from "./config.ts";
import type { WorkerItem } from "./dashboard/types.ts";
import { type Answers, decisionClient, inWorkerQuestions, parseFallbackAnswers, type Questions, readWorkerIntent } from "./decisions.ts";
import { Notes } from "./extensions/notes.ts";
import { Workers } from "./extensions/workers.ts";
import { SIDE_CHAT_RULE, startWorkerProgressMonitor, type WorkerProgressUpdateEvent } from "./worker-progress.ts";

const context = BACKGROUND_CONTEXT;
const config: Config = { ...defaults, provider: "faux", model: "faux-1", thinkingLevel: "off", timeZone: "UTC", allowT3: false };

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-decisions-steer-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

const questions: Questions = {
	job_size: { type: "choice", instructions: "What does this need?", criteria: { answer: "a reply", quick_worker: "research" } },
	fresh_check: { type: "noul", instructions: "Does it need a fresh look?" },
};

const d1 = (answers: Answers) =>
	(async () => new Response(JSON.stringify({ answers }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;

const logLines = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type: string; backend?: string; ok?: boolean; intent?: string });

test("decisions: d1 answers first when it's up, and the fallback is never asked", async () => {
	const { faux, models } = setup();
	let fallbackCalls = 0;
	faux.setResponses([
		() => {
			fallbackCalls++;
			return fauxAssistantMessage("{}");
		},
	]);
	const logFile = join(dir, "d1-primary.jsonl");
	const decisions = decisionClient({
		url: "http://d1.test",
		logFile,
		holdout: 0,
		fetchFn: d1({ job_size: { choice: "quick_worker", confidence: 0.8 } }),
		fallback: { models, provider: "faux", model: "faux-1" },
	});
	assert.equal(decisions.configured, true);
	const decided = await decisions.ask({ id: "a", site: "message", state: { message: "compare frames" }, questions });
	assert.equal(decided?.backend, "d1");
	assert.equal(decided?.answers.job_size?.choice, "quick_worker");
	assert.equal(fallbackCalls, 0);
	assert.deepEqual(logLines(logFile).map((line) => [line.backend, line.ok]), [["d1", true]]);
});

test("decisions: the cloud fallback answers in d1's shape when no d1 is configured", async () => {
	const { faux, models } = setup();
	const requests: ModelContext[] = [];
	faux.setResponses([
		(request) => {
			requests.push(request);
			return fauxAssistantMessage('{"job_size": "answer:0.9", "fresh_check": 0.2}');
		},
	]);
	const logFile = join(dir, "fallback-only.jsonl");
	const decisions = decisionClient({ logFile, holdout: 0, fallback: { models, provider: "faux", model: "faux-1" } });
	assert.equal(decisions.configured, true);
	const decided = await decisions.ask({ id: "b", site: "message", state: { message: "hi" }, questions });
	assert.equal(decided?.backend, "fallback");
	assert.deepEqual(decided?.answers, { job_size: { choice: "answer", confidence: 0.9 }, fresh_check: { noul: 0.2 } });
	assert.match(JSON.stringify(requests[0]), /one JSON object/);
	assert.match(JSON.stringify(requests[0]?.messages), /JSON keys: job_size, fresh_check/);
	assert.deepEqual(logLines(logFile).map((line) => [line.backend, line.ok]), [["fallback", true]]);
});

test("decisions: a d1 error or timeout falls back automatically, and nothing configured means no hint", async () => {
	const { faux, models } = setup();
	faux.setResponses([
		() => fauxAssistantMessage('{"job_size": "quick_worker:0.7", "fresh_check": 0.9}'),
		() => fauxAssistantMessage('{"job_size": "answer", "fresh_check": "0.1"}'),
	]);
	const logFile = join(dir, "fallback-after-d1.jsonl");
	const erroring = decisionClient({
		url: "http://d1.test",
		logFile,
		holdout: 0,
		fetchFn: (async () => new Response("down", { status: 502 })) as typeof fetch,
		fallback: { models, provider: "faux", model: "faux-1" },
	});
	const afterError = await erroring.ask({ id: "c", site: "message", state: "x", questions });
	assert.equal(afterError?.backend, "fallback");
	assert.equal(afterError?.answers.job_size?.choice, "quick_worker");

	// d1 hangs (a home ISP outage): it's cut off at the timeout and the fallback answers.
	const hanging = decisionClient({
		url: "http://d1.test",
		logFile,
		holdout: 0,
		timeoutMs: 50,
		fetchFn: ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out"))))) as typeof fetch,
		fallback: { models, provider: "faux", model: "faux-1" },
	});
	const started = Date.now();
	const afterTimeout = await hanging.ask({ id: "d", site: "message", state: "x", questions });
	assert.ok(Date.now() - started < 2_000);
	assert.equal(afterTimeout?.backend, "fallback");
	assert.deepEqual(afterTimeout?.answers, { job_size: { choice: "answer", confidence: 0.75 }, fresh_check: { noul: 0.1 } });
	assert.deepEqual(logLines(logFile).map((line) => [line.backend, line.ok]), [["d1", false], ["fallback", true], ["d1", false], ["fallback", true]]);

	const none = decisionClient({ logFile: join(dir, "none.jsonl") });
	assert.equal(none.configured, false);
	assert.equal(await none.ask({ id: "e", site: "message", state: "x", questions }), undefined);
});

test("parseFallbackAnswers drops garbled and unknown answers, and rejects a reply with nothing usable", () => {
	assert.deepEqual(parseFallbackAnswers('Sure! {"job_size": "nonsense:0.9", "fresh_check": 1.7}', questions), { fresh_check: { noul: 1 } });
	assert.throws(() => parseFallbackAnswers("no json here", questions));
});

test("in-worker read picks the intent and, with several running, which work it's about", () => {
	const two = inWorkerQuestions([{ name: "frames", goal: "compare bike frames" }, { name: "pizza", goal: "find pizza" }]);
	assert.ok("intent" in two && "which" in two);
	assert.ok(!("which" in inWorkerQuestions([{ name: "frames", goal: "compare bike frames" }])));
	assert.deepEqual(readWorkerIntent({ intent: { choice: "steer", confidence: 0.8 }, which: { choice: "w1", confidence: 0.9 } }, ["frames", "pizza"]), { intent: "steer", p: 0.8, worker: "pizza" });
	assert.deepEqual(readWorkerIntent({ intent: { choice: "status", confidence: 0.6 } }, ["frames"]), { intent: "status", p: 0.6, worker: "frames" });
	assert.equal(readWorkerIntent({ intent: { choice: "bogus", confidence: 0.9 } }, ["frames"]), undefined);
});

test("a DM steer is read as a steer (not side chat), keeps progress updates on, and a stall is only noted once it's said", async () => {
	const { faux, models } = setup();
	const progressRequests: ModelContext[] = [];
	let progressReply: { status: string; message: string | null } = { status: "Comparing", message: "I'm comparing shorter frames now." };
	faux.setResponses(
		Array.from({ length: 20 }, () => (request: ModelContext) => {
			progressRequests.push(request);
			return fauxAssistantMessage(JSON.stringify(progressReply));
		}),
	);
	let intent: Answers["intent"] = { choice: "steer", confidence: 0.9 };
	const logFile = join(dir, "in-worker.jsonl");
	const decisions = decisionClient({
		url: "http://d1.test",
		logFile,
		holdout: 0,
		fetchFn: (async (_url: string, init?: RequestInit) => {
			const asked = Object.keys((JSON.parse(String(init?.body)) as { questions: Questions }).questions);
			const answers: Answers = asked.includes("intent")
				? { intent: intent! }
				: asked.includes("worth_updating")
					? { worth_updating: { probability: 0.9 }, interrupt_worthy: { probability: 0.1 } }
					: { job_size: { choice: "answer", confidence: 0.9 } };
			return new Response(JSON.stringify({ answers }), { headers: { "Content-Type": "application/json" } });
		}) as typeof fetch,
	});
	const items: WorkerItem[] = [{ kind: "tool", at: Date.now(), name: "web_search", args: { query: "bike frames" }, result: "10 results" }];
	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "in-worker.sqlite")),
		{ config, models, notes: new Notes(join(dir, "in-worker-notes.md")), decisions, homeDir: join(dir, "in-worker-home"), workerItems: () => items },
		context,
	);
	const updates: WorkerProgressUpdateEvent[] = [];
	const unregister = agent.progressSurfaces.register("telegram", {
		async update(event) {
			updates.push(event);
		},
	});
	let fakeNow = Date.now();
	const monitor = startWorkerProgressMonitor(
		agent,
		{ models, config, decisions, everyMs: 60_000, refreshMs: 10_000, firstUpdateMs: 10_000, quietConfirmMs: 100_000, now: () => fakeNow },
		context,
	);
	try {
		const conversation = await agent.conversationFor("telegram:dm:777", context);
		const startedAt = Date.now() - 1_000;
		fakeNow = startedAt;
		await conversation.commit(async (tx) => {
			(await tx.doc(Workers, conversation.id)).workers.frames = {
				sessionId: "sess-frames",
				brief: "compare bike frames under $2k",
				status: "working",
				startedAt,
				updatedAt: startedAt,
				ask: "telegram:50",
			};
		}, context);
		const worker = async () => (await agent.harness.snapshot(Workers, conversation.id, context))?.workers.frames;

		// A steer in a DM: the hint says to steer it live, and it's recorded as on topic.
		const steerHint = await agent.jobs.guideMessage({ id: "m1", text: "only frames under 52cm", channel: "telegram direct message", conversationId: conversation.id });
		assert.match(steerHint ?? "", /message_worker/);
		assert.match(steerHint ?? "", /frames/);
		assert.doesNotMatch(steerHint ?? "", /job_size/, "a confident steer stands alone");
		assert.ok((await worker())?.touchedAt !== undefined);
		assert.equal((await worker())?.asides, undefined);

		// Progress after the steer: a normal, notifying update. The steer isn't side chat.
		fakeNow += 20_000;
		await monitor.tick();
		assert.equal(updates.length, 1);
		assert.equal(updates[0]?.silent, undefined);
		assert.doesNotMatch(JSON.stringify(progressRequests[0]?.messages), /side conversation/);
		assert.match(JSON.stringify(progressRequests[0]), /first person/);

		// Something unrelated: recorded as an aside, and routine progress stays quiet.
		intent = { choice: "side_chat", confidence: 0.85 };
		const sideHint = await agent.jobs.guideMessage({ id: "m2", text: "did the bears win?", channel: "telegram direct message", conversationId: conversation.id });
		assert.match(sideHint ?? "", /side topic/);
		assert.deepEqual((await worker())?.asides?.map((aside) => [aside.intent, aside.preview]), [["side_chat", "did the bears win?"]]);
		items.push({ kind: "tool", at: Date.now(), name: "web_search", args: { query: "frame geometry" }, result: "8 results" });
		fakeNow += 20_000;
		await monitor.tick();
		assert.equal(progressRequests.length, 1);
		assert.equal(updates.length, 1);

		// A real stall during the side chat: the prompt drops the stay-quiet rule. The model says nothing, so the
		// stall isn't marked noted, and the next check asks again and posts.
		progressReply = { status: "Waiting", message: null };
		fakeNow += 200_000;
		await monitor.tick();
		assert.equal(progressRequests.length, 2);
		const stallRequest = JSON.stringify(progressRequests[1]?.messages);
		assert.match(stallRequest, /no new activity for 3m 20s/);
		assert.ok(!stallRequest.includes(JSON.stringify(SIDE_CHAT_RULE).slice(1, 60)));
		assert.equal(updates.length, 1);
		progressReply = { status: "Waiting", message: "Bike frames: still waiting on one shop's sizing chart." };
		fakeNow += 20_000;
		await monitor.tick();
		assert.equal(progressRequests.length, 3);
		assert.equal(updates.length, 2);
		assert.equal(updates[1]?.silent, true);
		fakeNow += 20_000;
		await monitor.tick();
		assert.equal(progressRequests.length, 3, "a stall that was said isn't said again");

		// Steering again puts it back on topic: the aside is cleared.
		intent = { choice: "steer", confidence: 0.9 };
		await agent.jobs.guideMessage({ id: "m3", text: "actually include steel frames", channel: "telegram direct message", conversationId: conversation.id });
		assert.equal((await worker())?.asides, undefined);

		const intents = logLines(logFile).filter((line) => line.type === "in-worker").map((line) => line.intent);
		assert.deepEqual(intents, ["steer", "side_chat", "steer"]);
	} finally {
		monitor.stop();
		unregister();
		await agent.harness.close(context);
	}
});
