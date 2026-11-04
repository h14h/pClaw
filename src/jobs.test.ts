import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import { jobBoard, jobCard } from "./channels/discord.ts";
import { type Config, defaults } from "./config.ts";
import { type Answers, armOf, decisionClient, messageGuidance, messageQuestions, parseTemplates, readTurn, turnGuidance } from "./decisions.ts";
import { summarize } from "./decision-report.ts";
import { deliver } from "./delivery.ts";
import { type Job, type JobBackend, JobStore, type JobSurface, readItems, type ThreadItem, type ThreadView, turnEnded } from "./extensions/jobs.ts";
import { Notes } from "./extensions/notes.ts";
import { readPrompt } from "./prompts.ts";

const context = BACKGROUND_CONTEXT;
const config: Config = { ...defaults, provider: "faux", model: "faux-1", thinkingLevel: "off", timeZone: "America/Chicago", t3AllowSend: true };

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-jobs-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

const noul = (value: number) => ({ noul: value });
const choice = (value: string, confidence = 0.8) => ({ choice: value, confidence });
const NEEDS_YOU: Answers = {
	asks_owner: noul(0.8),
	real_decision: noul(0.9),
	failed: noul(0.05),
	waiting_on_system: noul(0.1),
	job_complete: noul(0.05),
	worth_keeping: noul(0.2),
	hard_to_undo: noul(0.1),
};

/** A decision server that gives `answers`, or fails when there are none. */
function decisionServer(answers: Answers | undefined): typeof fetch {
	return (async () => {
		if (answers === undefined) throw new Error("connection refused");
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as typeof fetch;
}

function fakeBackend() {
	const running: ThreadView = { status: "running", activeRunId: "run-1", latestRunId: "run-1", pendingRequestCount: 0, runCount: 1, itemCount: 2, settled: false };
	const state = {
		view: running,
		items: [{ type: "assistant_message", text: "Should the map use tiles or a heightmap?" }] as ThreadItem[],
		launched: [] as Record<string, unknown>[],
		sent: [] as string[],
		interrupted: 0,
	};
	const backend: JobBackend = {
		launch: async (args) => {
			state.launched.push(args);
			return { threadId: "t3-thread", link: "https://t3.example/thread" };
		},
		peek: async () => state.view,
		read: async (_thread, _env, from) => ({ items: state.items, position: from + state.items.length }),
		pending: async () => [],
		send: async (_thread, _env, message) => void state.sent.push(message),
		interrupt: async () => void state.interrupted++,
		projects: async () => [{ id: "p-game", title: "hexfall", machine: "pc1", environmentId: "env-pc1", hasRepo: true }],
		linkFor: (_thread, _env, link) => link,
	};
	return { state, backend, running };
}

function fakeSurface(conversation: () => Promise<Awaited<ReturnType<JobSurface["conversation"]>>>) {
	const cards: string[] = [];
	const shared: string[] = [];
	const surface: JobSurface = {
		open: async () => ({ discordThreadId: "777", cardMessageId: "778" }),
		card: async (job) => void cards.push(job.state),
		board: async () => undefined,
		conversation,
		share: async (_job, text) => void shared.push(text),
	};
	return { surface, cards, shared };
}

function setup(name: string, answers: Answers | undefined, holdout = 0) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const log = join(dir, `${name}.jsonl`);
	const decisions = decisionClient({ url: "http://decide.test", logFile: log, holdout, fetchFn: decisionServer(answers) });
	return { faux, models, decisions, log, store: new JobStore(join(dir, `${name}.json`)) };
}

const lastMessage = (request: ModelContext) => JSON.stringify(request.messages.at(-1));
const summary = (state: string, line: string) => () => fauxAssistantMessage(JSON.stringify({ state, line }));
const start = (args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxText("on it"), fauxToolCall("start_job", args)], { stopReason: "toolUse" });

async function open(name: string, parts: ReturnType<typeof setup>, backend: JobBackend, refreshMs = 3_600_000) {
	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, `${name}.sqlite`)),
		{ config, models: parts.models, notes: new Notes(join(dir, `${name}-notes.md`)), decisions: parts.decisions, jobStore: parts.store, jobBackend: backend },
		context,
	);
	const conversation = await agent.conversationFor("discord:channel:42", context);
	const replies: string[] = [];
	const outbox = {
		async send(text: string) {
			// "on it" answers in the channel; everything after that is in the job's thread.
			replies.push(`${agent.jobs.delivery(text === "on it" ? "discord:channel:42" : "discord:thread:777", text)}: ${text}`);
		},
		working() {},
	};
	const delivery = await deliver(agent.harness, conversation.id, outbox, context);
	const { surface, cards, shared } = fakeSurface(async () => conversation);
	agent.jobs.surface.current = surface;
	const keeper = agent.jobs.startKeeper(context, 3_600_000, refreshMs);
	/** Wait out everything submitted so far. */
	const idle = async () => {
		for (let quiet = 0, i = 0; quiet < 5 && i < 1_000; i++) {
			const live = await agent.harness.snapshot(LiveDoc, conversation.id, context);
			quiet = live?.run === undefined ? quiet + 1 : 0;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	const close = async () => {
		keeper.stop();
		await delivery.stop();
		await agent.harness.close(context);
	};
	return { agent, conversation, replies, cards, shared, keeper, idle, close };
}

test("a job launches in T3, stays quiet while running, and wakes the model with a hint when a turn ends", async () => {
	const parts = setup("flow", NEEDS_YOU);
	const { state, backend, running } = fakeBackend();
	const requests: ModelContext[] = [];
	parts.faux.setResponses([
		start({ title: "Map proof", brief: "Build a desert map.", project: "hexfall", emoji: "🗺️" }),
		summary("needs_you", "Needs a call on tiles or a heightmap."),
		(request) => {
			requests.push(request);
			return fauxAssistantMessage([fauxToolCall("ping_owner", { job: parts.store.all()[0]!.id })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("tiles or a heightmap? i'd go heightmap"),
	]);
	const { conversation, replies, cards, keeper, idle, close } = await open("flow", parts, backend);

	await conversation.submit({ type: "input", content: "build me a desert map on the game project", requestId: "discord:9" }, context);
	await idle();
	const job = parts.store.all()[0]!;
	assert.equal(state.launched.length, 1);
	assert.equal(state.launched[0]!.environmentId, "env-pc1");
	assert.equal(state.launched[0]!.projectId, "p-game");
	assert.deepEqual(state.launched[0]!.workspaceStrategy, { type: "worktree", baseRef: "main" });
	assert.match(String(state.launched[0]!.message), /Build a desert map\.$/);
	assert.equal(job.discordThreadId, "777");
	assert.equal(job.machine, "pc1");

	await keeper.tick();
	assert.equal(requests.length, 0, "a running job wakes nothing");

	state.view = { ...running, status: "completed", activeRunId: null };
	await keeper.tick();
	await idle();
	assert.equal(parts.store.get(job.id)!.state, "needs_you");
	assert.equal(parts.store.get(job.id)!.status, "Needs a call on tiles or a heightmap.");
	assert.ok(cards.includes("needs_you"));
	const update = lastMessage(requests[0]!);
	assert.match(update, /<job-update job=/);
	assert.match(update, /<guidance read=/);
	assert.match(update, /worth interrupting/);
	assert.equal(replies.at(-1), "ping: tiles or a heightmap? i'd go heightmap");
	assert.equal(parts.store.get(job.id)!.pingNext, undefined);

	await keeper.tick();
	assert.equal(requests.length, 1, "the same turn is reported once");
	await close();
	const log = (await readFile(parts.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; mode?: string });
	assert.deepEqual(log.map((event) => event.type), ["job", "decision", "guidance", "wake", "delivery"]);
	assert.equal(log.at(-1)!.mode, "ping");
});

test("with the decision model down, a job update still reaches the model, with no hint", async () => {
	const parts = setup("down", undefined);
	const { state, backend, running } = fakeBackend();
	const requests: ModelContext[] = [];
	parts.faux.setResponses([
		start({ title: "Scratch", brief: "Check something." }),
		summary("done", "All done."),
		(request) => {
			requests.push(request);
			return fauxAssistantMessage("NO_REPLY");
		},
	]);
	const { conversation, replies, keeper, idle, close } = await open("down", parts, backend);
	await conversation.submit({ type: "input", content: "check it", requestId: "discord:9" }, context);
	await idle();
	assert.equal(state.launched[0]!.scratch, true);
	state.view = { ...running, status: "completed", activeRunId: null };
	await keeper.tick();
	await idle();
	assert.match(lastMessage(requests[0]!), /<job-update/);
	assert.doesNotMatch(lastMessage(requests[0]!), /<guidance/);
	assert.equal(parts.store.all()[0]!.state, "done");
	assert.deepEqual(replies, ["undefined: on it"]);
	await close();
});

test("a control event logs the hint but doesn't show it", async () => {
	const parts = setup("control", NEEDS_YOU, 1);
	const { state, backend, running } = fakeBackend();
	const requests: ModelContext[] = [];
	parts.faux.setResponses([
		start({ title: "Scratch", brief: "Check something." }),
		summary("needs_you", "Waiting."),
		(request) => {
			requests.push(request);
			return fauxAssistantMessage("NO_REPLY");
		},
	]);
	const { conversation, keeper, idle, close } = await open("control", parts, backend);
	await conversation.submit({ type: "input", content: "check it", requestId: "discord:9" }, context);
	await idle();
	state.view = { ...running, status: "completed", activeRunId: null };
	await keeper.tick();
	await idle();
	assert.doesNotMatch(lastMessage(requests[0]!), /<guidance/);
	const log = await readFile(parts.log, "utf8");
	assert.match(log, /"type":"guidance".*"shown":false/);
	await close();
});

test("the card refreshes mid-turn without waking anyone, and the turn's end still has the agent's last words", async () => {
	const parts = setup("refresh", NEEDS_YOU);
	const { state, backend, running } = fakeBackend();
	const requests: ModelContext[] = [];
	parts.faux.setResponses([
		start({ title: "Scratch", brief: "Check something." }),
		summary("idle", "Asking about tiles."),
		summary("needs_you", "Needs a call."),
		(request) => {
			requests.push(request);
			return fauxAssistantMessage("NO_REPLY");
		},
	]);
	const { conversation, keeper, idle, close } = await open("refresh", parts, backend, 0);
	await conversation.submit({ type: "input", content: "check it", requestId: "discord:9" }, context);
	await idle();
	await keeper.tick();
	assert.equal(parts.store.all()[0]!.status, "Asking about tiles.");
	assert.equal(requests.length, 0);
	state.items = [];
	state.view = { ...running, status: "completed", activeRunId: null };
	await keeper.tick();
	await idle();
	assert.match(lastMessage(requests[0]!), /tiles or a heightmap/);
	await close();
});

test("tracking an existing T3 thread doesn't report its old turns", async () => {
	const parts = setup("adopt", NEEDS_YOU);
	const { state, backend, running } = fakeBackend();
	state.view = { ...running, status: "completed", activeRunId: null, itemCount: 50 };
	parts.faux.setResponses([start({ title: "Theirs", thread_id: "existing", machine: "pc1" })]);
	const { conversation, keeper, idle, close } = await open("adopt", parts, backend);
	await conversation.submit({ type: "input", content: "keep an eye on that thread", requestId: "discord:9" }, context);
	await idle();
	await keeper.tick();
	const job = parts.store.all()[0]!;
	assert.equal(job.threadId, "existing");
	assert.equal(job.state, "idle");
	assert.equal(state.launched.length, 0);
	assert.equal(state.sent.length, 0);
	await close();
});

test("a turn counts as ended on what T3 reports, including pending questions mid-run", () => {
	const view = (patch: Partial<ThreadView>): ThreadView => ({ status: "running", activeRunId: "r", latestRunId: "r", pendingRequestCount: 0, runCount: 1, itemCount: 1, settled: false, ...patch });
	assert.equal(turnEnded(view({})), false);
	assert.equal(turnEnded(view({ status: "preparing" })), false);
	assert.equal(turnEnded(view({ status: "idle", runCount: 0 })), false);
	assert.equal(turnEnded(view({ pendingRequestCount: 1 })), true);
	assert.equal(turnEnded(view({ status: "completed" })), true);
	assert.equal(turnEnded(view({ status: "failed" })), true);
});

test("reading a thread finds the agent's last words and who spoke to it last", () => {
	assert.deepEqual(readItems([{ type: "user_message", creationSource: "mcp", text: "go" }, { type: "assistant_message", text: "done" }]), { lastMessage: "done", ownerDriving: false });
	assert.equal(readItems([{ type: "user_message", creationSource: "web", text: "try again" }]).ownerDriving, true);
});

test("every template a read can pick exists", () => {
	const templates = parseTemplates(readPrompt("guidance"));
	const outcomes = ["finished", "needs_owner", "procedural", "blocked", "still_going"].map((name) => `turn.${name}`);
	const names = [...outcomes, "surface.ping", "surface.note", "surface.card", "place.parent", "place.thread", "no_news", "owner_driving", "caution"];
	names.push("message.t3_job", "message.quick_worker", "message.project", "message.status", "message.steer", "message.too_loud", "message.too_quiet", "follow_up.wait");
	for (const name of names) assert.ok(templates[name], `missing template ${name}`);
});

test("a turn's read combines d1's answers with what's known for certain", () => {
	const away = { ownerDriving: false, repeat: false };
	assert.deepEqual(readTurn(NEEDS_YOU, away), { outcome: "needs_owner", surface: "ping" });
	assert.deepEqual(readTurn({ ...NEEDS_YOU, asks_owner: noul(0.45) }, away), { outcome: "needs_owner", surface: "ping" }, "asks sit just under one half");
	assert.deepEqual(readTurn(NEEDS_YOU, { ownerDriving: true, repeat: false }), { outcome: "needs_owner", surface: "card" }, "they're already there");
	assert.deepEqual(readTurn(NEEDS_YOU, { ownerDriving: false, repeat: true }), { outcome: "needs_owner", surface: "card" }, "they've heard it");
	assert.equal(readTurn({ ...NEEDS_YOU, real_decision: noul(0.2) }, away).outcome, "procedural");
	assert.equal(readTurn({ ...NEEDS_YOU, asks_owner: noul(0.1), waiting_on_system: noul(0.95) }, away).outcome, "still_going");
	assert.equal(readTurn({ ...NEEDS_YOU, asks_owner: noul(0.1), failed: noul(0.9) }, away).outcome, "blocked");
	assert.deepEqual(readTurn({ ...NEEDS_YOU, asks_owner: noul(0.1), job_complete: noul(0.9) }, away), { outcome: "finished", surface: "ping" });
});

test("hints reflect the read, and stay out of the way when nothing stands out", () => {
	const hint = turnGuidance({ ...NEEDS_YOU, hard_to_undo: noul(0.9) }, { ownerDriving: true, repeat: true })!;
	assert.match(hint, /same message as last time/);
	assert.match(hint, /already seen this/);
	assert.match(hint, /card already covers/);
	assert.match(hint, /explicit yes/);
	const chat = { job_size: choice("answer"), asks_status: noul(0.05), noise_feedback: choice("neither"), hard_to_undo: noul(0.02) };
	assert.equal(messageGuidance(chat), undefined);
	const job = messageGuidance({ ...chat, job_size: choice("t3_job") }, { project: "hexfall", machine: "pc1" })!;
	assert.match(job, /hexfall on pc1/);
	assert.ok("in_job" in messageQuestions(true));
	assert.ok(!("in_job" in messageQuestions(false)));
});

test("arms are stable and split near the holdout", () => {
	assert.equal(armOf("turn:a:1", 0.2), armOf("turn:a:1", 0.2));
	const controls = Array.from({ length: 2_000 }, (_, index) => armOf(`event-${index}`, 0.2)).filter((arm) => arm === "control").length;
	assert.ok(controls > 300 && controls < 500, `${controls} controls`);
});

test("the card and board read at a glance", () => {
	const job: Job = { id: "a", title: "Map proof", brief: "", threadId: "t", machine: "pc1", project: "hexfall", origin: "discord:channel:1", state: "needs_you", status: "Tiles or heightmap?", told: [], startedAt: 1_000_000, updatedAt: 1_000_000, discordThreadId: "9" };
	assert.match(jobCard(job), /🙋 Needs you · pc1 · hexfall\nTiles or heightmap\?/);
	const board = jobBoard([job, { ...job, id: "b", title: "Old", state: "done", discordThreadId: "8", updatedAt: 1_000_000 }], 1_000_000);
	assert.match(board, /🙋 <#9> · pc1/);
	assert.match(board, /Last 24 hours\*\*\n✅ <#8>/);
	assert.match(jobBoard([], 1_000_000), /Nothing running/);
});

test("the report counts what a hint did against the control arm", () => {
	const at = (minutes: number) => new Date(1_800_000_000_000 + minutes * 60_000).toISOString();
	const decision = (id: string, arm: string) => ({ type: "decision", id, site: "job-turn", arm, ok: true, ms: 100, job: "j", at: at(0), templates: "v1", answers: {} });
	const read = (id: string, surface: string) => ({ type: "guidance", id, at: at(0), surface, outcome: "finished", summaryState: "done" });
	const report = summarize([
		decision("1", "guided"),
		read("1", "ping"),
		{ type: "wake", job: "j", decision: "1", arm: "guided", at: at(0) },
		{ type: "delivery", job: "j", decision: "1", mode: "ping", at: at(1) },
		{ type: "reaction", job: "j", decision: "1", emoji: "👍", at: at(2) },
		decision("2", "guided"),
		read("2", "card"),
		{ type: "wake", job: "j", decision: "2", arm: "guided", at: at(3) },
		decision("3", "control"),
		read("3", "card"),
		{ type: "wake", job: "j", decision: "3", arm: "control", at: at(4) },
		{ type: "delivery", job: "j", decision: "3", mode: "silent", at: at(5) },
		{ type: "decision", id: "m", site: "message", arm: "guided", ok: true, ms: 90, at: at(6), templates: "v1", answers: { asks_status: { noul: 0.9 }, noise_feedback: { choice: "too_loud", confidence: 0.8 } } },
		{ type: "decision", id: "x", site: "message", arm: "guided", ok: false, ms: 1500, at: at(7), templates: "v1" },
	]);
	assert.equal(report.wakes, 3);
	assert.equal(report.pings, 1);
	assert.equal(report.pingsPerWake, 1 / 3);
	assert.equal(report.arms.guided!.followed, 2);
	assert.equal(report.arms.guided!.turns, 2);
	assert.equal(report.arms.control!.followed, 0);
	assert.equal(report.statusAsks, 1);
	assert.equal(report.tooLoud, 1);
	assert.equal(report.positiveReactions, 1);
	assert.equal(report.failed, 1);
	assert.deepEqual(report.outcomeAgreement, { agree: 3, compared: 3 });
});
