import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { jobBoard, jobCard, serves, typingTargets } from "./channels/discord.ts";
import { type Config, defaults } from "./config.ts";
import type { WorkerItem } from "./dashboard/types.ts";
import { type Answers, armOf, decisionClient, messageGuidance, messageQuestions, parseTemplates, readTurn, turnGuidance } from "./decisions.ts";
import { compareLanes, compareModalities, type LogEvent, summarize } from "./decision-report.ts";
import { deliver } from "./delivery.ts";
import { describeActivity, type Job, type JobBackend, JobStore, type JobSurface, readItems, type ThreadItem, type ThreadView, turnEnded } from "./extensions/jobs.ts";
import { Workers } from "./extensions/workers.ts";
import { Notes } from "./extensions/notes.ts";
import { readPrompt } from "./prompts.ts";
import { memoLabel, transcribe } from "./speech.ts";

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
		settled: 0,
	};
	const backend: JobBackend = {
		launch: async (args) => {
			state.launched.push(args);
			return { threadId: "t3-thread" };
		},
		peek: async () => state.view,
		read: async (_thread, _env, from) => ({ items: state.items, position: from + state.items.length }),
		pending: async () => [],
		send: async (_thread, _env, message) => void state.sent.push(message),
		interrupt: async () => void state.interrupted++,
		settle: async () => void state.settled++,
		projects: async () => [{ id: "p-game", title: "hexfall", machine: "pc1", environmentId: "env-pc1", hasRepo: true }],
		machines: async () => [{ machine: "mp1" }, { machine: "pc1", environmentId: "env-pc1" }, { machine: "mm1", environmentId: "env-mm1" }],
		linkFor: async (thread) => `https://t3.example/${thread}`,
	};
	return { state, backend, running };
}

function fakeSurface(conversation: () => Promise<Awaited<ReturnType<JobSurface["conversation"]>>>) {
	const cards: string[] = [];
	const shared: string[] = [];
	const notes: string[] = [];
	const surface: JobSurface = {
		open: async (job) => (job.origin.startsWith("discord:dm:") ? undefined : { discordThreadId: "777", cardMessageId: "778" }),
		card: async (job) => void cards.push(job.state),
		note: async (_job, text) => void notes.push(text),
		board: async () => undefined,
		conversation,
		remember: async (_job, text) => void shared.push(text),
	};
	return { surface, cards, shared, notes };
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

async function open(name: string, parts: ReturnType<typeof setup>, backend: JobBackend, refreshMs = 3_600_000, address = "discord:channel:42", workerItems?: () => WorkerItem[]) {
	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, `${name}.sqlite`)),
		{ config, models: parts.models, notes: new Notes(join(dir, `${name}-notes.md`)), decisions: parts.decisions, jobStore: parts.store, jobBackend: backend, ...(workerItems === undefined ? {} : { workerItems }) },
		context,
	);
	const conversation = await agent.conversationFor(address, context);
	const replies: string[] = [];
	const outbox = {
		async send(text: string) {
			// "on it" answers in the channel; everything after that is in the job's thread.
			replies.push(`${agent.jobs.delivery(text === "on it" ? "discord:channel:42" : "discord:thread:777", text)}: ${text}`);
		},
		working() {},
	};
	const delivery = await deliver(agent.harness, conversation.id, outbox, context);
	const { surface, cards, shared, notes } = fakeSurface(async () => conversation);
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
	return { agent, conversation, replies, cards, shared, notes, keeper, idle, close };
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

test("a machine with no projects can still run a scratch job", async () => {
	const parts = setup("scratch", NEEDS_YOU);
	const { state, backend } = fakeBackend();
	parts.faux.setResponses([start({ title: "Check", brief: "Run hostname.", machine: "MM1" })]);
	const { conversation, idle, close } = await open("scratch", parts, backend);
	await conversation.submit({ type: "input", content: "check mm1", requestId: "discord:9" }, context);
	await idle();
	assert.equal(state.launched[0]!.environmentId, "env-mm1");
	assert.equal(state.launched[0]!.scratch, true);
	assert.equal(parts.store.all()[0]!.machine, "mm1");
	await close();
});

test("a worker's thread gets updates in its own words, and only when there's something to say", async () => {
	const parts = setup("worker", { milestone: noul(0.8) });
	const { backend } = fakeBackend();
	const seen: ModelContext[] = [];
	const update = (status: string, message: string | null) => (request: ModelContext) => {
		seen.push(request);
		return fauxAssistantMessage(JSON.stringify({ status, message }));
	};
	parts.faux.setResponses([update("Reading the ledger", "two of these look stuck on docking, checking why."), update("Still on the ledger", null)]);
	const items: WorkerItem[] = [];
	const { agent, conversation, notes, cards, shared, keeper, close } = await open("worker", parts, backend, 0, "discord:channel:42", () => items);
	const setStatus = (status: "working" | "idle") =>
		conversation.commit(async (tx) => {
			(await tx.doc(Workers, conversation.id)).workers["docking-status"] = { sessionId: "session", brief: "Check docking.", status, updatedAt: 1 };
		}, context);
	await setStatus("working");
	const session = await agent.jobs.openSession({ name: "docking-status", brief: "Check docking.", sessionId: "session", conversationId: conversation.id, ask: "discord:9" }, context);
	assert.equal(session?.id, conversation.id);
	const job = parts.store.all()[0]!;
	assert.equal(job.title, "docking status");
	assert.equal(job.discordThreadId, "777");

	await keeper.tick();
	assert.deepEqual(notes, [], "nothing new, nothing to say");
	items.push({ kind: "tool", at: 1, name: "bash", args: { command: "ledger:status --issue 3117" }, result: "Dock settlement: verified" });
	await keeper.tick();
	assert.deepEqual(notes, ["two of these look stuck on docking, checking why."]);
	assert.equal(parts.store.get(job.id)!.status, "Reading the ledger");
	assert.match(JSON.stringify(seen[0]), /texting the user/, "it's pclaw's voice");
	assert.match(lastMessage(seen[0]!), /real step forward/);

	items.push({ kind: "tool", at: 2, name: "bash", args: { command: "gh issue view 3124" }, result: "open" });
	await keeper.tick();
	assert.equal(notes.length, 1, "more of the same stays off the thread");
	assert.equal(parts.store.get(job.id)!.status, "Still on the ledger", "but the card keeps up");
	assert.match(lastMessage(seen[1]!), /stuck on docking/, "it knows what it said");

	await agent.jobs.workerReporting({ name: "docking-status", conversationId: conversation.id, ok: true }, context);
	assert.equal(parts.store.get(job.id)!.state, "done");
	assert.equal(agent.jobs.delivery("discord:thread:777", "all clear, none of them are stuck.\nmore detail"), "ping", "the result reaches them");
	assert.equal(parts.store.get(job.id)!.status, "all clear, none of them are stuck.");
	assert.deepEqual(shared, ["all clear, none of them are stuck.\nmore detail"], "the channel remembers it");
	assert.equal(agent.jobs.delivery("discord:thread:777", "anything else?"), "silent");
	assert.equal(shared.length, 1);
	assert.equal(cards.at(-1), "done");
	await setStatus("idle");
	await keeper.tick();
	assert.equal(parts.store.get(job.id)!.state, "done");
	await close();
});

test("a finished worker doesn't ping someone who's already in its thread", async () => {
	const parts = setup("here", NEEDS_YOU);
	const { backend } = fakeBackend();
	const { agent, conversation, close } = await open("here", parts, backend);
	await agent.jobs.openSession({ name: "w", brief: "b", sessionId: "s", conversationId: conversation.id }, context);
	await agent.jobs.guideMessage({ id: "1", text: "how's it going", channel: "w", discordThreadId: "777" });
	await agent.jobs.workerReporting({ name: "w", conversationId: conversation.id, ok: true }, context);
	assert.equal(agent.jobs.delivery("discord:thread:777", "done"), "silent");
	await close();
});

test("delegating in a channel moves the worker into its thread, with its report and follow-ups", async () => {
	const parts = setup("session", undefined);
	const { backend } = fakeBackend();
	const command = join(dir, "fake-pi.sh");
	await writeFile(command, "#!/bin/sh\necho 'none of them are stuck'\n");
	await chmod(command, 0o755);
	const reports: string[] = [];
	parts.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("delegate", { name: "docking", brief: "Check docking." })], { stopReason: "toolUse" }),
		(request) => {
			reports.push(lastMessage(request));
			return fauxAssistantMessage("all clear, nothing's stuck");
		},
	]);
	const workers = { command, provider: "xai", model: "w", thinkingLevel: "high", timeoutMs: 10_000, cwd: join(dir, "work"), sessionDir: join(dir, "sessions"), promptFile: join(dir, "w.md"), toolsFile: join(dir, "t.ts"), cliFile: join(dir, "c.ts"), museCommand: "muse", piFallback: { provider: "xai", model: "w" }, quickThinkingLevel: "medium", skills: [] };
	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "session.sqlite")),
		{ config, models: parts.models, notes: new Notes(join(dir, "session-notes.md")), decisions: parts.decisions, jobStore: parts.store, jobBackend: backend, workers },
		context,
	);
	const channel = await agent.conversationFor("discord:channel:42", context);
	const thread = await agent.conversationFor("discord:thread:777", context);
	const { surface } = fakeSurface(async () => thread);
	agent.jobs.surface.current = surface;
	const inChannel: string[] = [];
	const inThread: string[] = [];
	const quiet = () => undefined;
	const channelDelivery = await deliver(agent.harness, channel.id, { send: async (text) => void inChannel.push(text), working: quiet }, context);
	const threadDelivery = await deliver(agent.harness, thread.id, { send: async (text) => void inThread.push(text), working: quiet }, context);

	await channel.submit({ type: "input", content: "are my sessions stuck?", requestId: "discord:9" }, context);
	for (let i = 0; i < 500 && inThread.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));

	assert.deepEqual(inThread, ["all clear, nothing's stuck"]);
	assert.deepEqual(inChannel, [], "the channel stays clean");
	assert.match(reports[0]!, /<worker-report worker=\\"docking\\" status=\\"done\\">/);
	assert.equal((await agent.harness.snapshot(Workers, channel.id, context))?.workers.docking, undefined);
	assert.equal((await agent.harness.snapshot(Workers, thread.id, context))?.workers.docking?.status, "idle");
	assert.equal(parts.store.all()[0]!.state, "done");
	await channelDelivery.stop();
	await threadDelivery.stop();
	await agent.harness.close(context);
});

test("a worker in a DM needs no thread", async () => {
	const parts = setup("worker-dm", NEEDS_YOU);
	const { backend } = fakeBackend();
	const { agent, conversation, close } = await open("worker-dm", parts, backend, 3_600_000, "discord:dm:1");
	assert.equal(await agent.jobs.openSession({ name: "x", brief: "y", sessionId: "s", conversationId: conversation.id }, context), undefined);
	assert.equal(parts.store.all().length, 0);
	await close();
});

test("a background job in a DM gets no Discord thread, reports where it started, and settles its T3 thread", async () => {
	const parts = setup("background", { ...NEEDS_YOU, asks_owner: noul(0.05), job_complete: noul(0.9) });
	const { state, backend, running } = fakeBackend();
	state.items = [{ type: "assistant_message", text: "Godot 4.7.2." }];
	const requests: ModelContext[] = [];
	parts.faux.setResponses([
		start({ title: "Godot version", brief: "Read the version.", machine: "pc1", background: true }),
		summary("done", "It's 4.7.2."),
		(request) => {
			requests.push(request);
			return fauxAssistantMessage("it's 4.7.2");
		},
	]);
	const { conversation, keeper, idle, close } = await open("background", parts, backend, 3_600_000, "discord:dm:1");
	await conversation.submit({ type: "input", content: "what godot is on pc1", requestId: "discord:9" }, context);
	await idle();
	const job = parts.store.all()[0]!;
	assert.equal(job.discordThreadId, undefined);
	state.view = { ...running, status: "completed", activeRunId: null };
	await keeper.tick();
	await idle();
	assert.match(lastMessage(requests[0]!), /surface=\\"none\\"/);
	assert.equal(state.settled, 1);
	state.view = { ...state.view, settled: true };
	await keeper.tick();
	assert.equal(parts.store.get(job.id)!.state, "closed");
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
		() => fauxAssistantMessage(JSON.stringify({ status: "Asking about tiles.", message: null })),
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
	const names = [...outcomes, "surface.ping", "surface.note", "surface.card", "no_news", "owner_driving", "caution"];
	names.push("message.t3_job", "message.quick_worker", "message.fresh", "message.machine_check", "message.project", "message.voice", "message.thinking_aloud", "message.status", "message.steer", "message.too_loud", "message.too_quiet", "follow_up.wait");
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
	const chat = { job_size: choice("answer"), fresh_check: noul(0.1), asks_status: noul(0.05), noise_feedback: choice("neither"), hard_to_undo: noul(0.02) };
	assert.equal(messageGuidance(chat), undefined);
	const project = { project: "hexfall", machine: "pc1" };
	const job = messageGuidance({ ...chat, job_size: choice("t3_job") }, { project })!;
	assert.match(job, /hexfall on pc1/);
	const status = messageGuidance({ ...chat, job_size: choice("t3_job"), asks_status: noul(0.9) }, { project, liveJobs: true })!;
	assert.match(status, /asking how a job is going/);
	assert.doesNotMatch(status, /open and steer/);
	assert.doesNotMatch(messageGuidance({ ...chat, job_size: choice("quick_worker", 0.75), asks_status: noul(0.6) })!, /how a job is going/, "nothing's running");
	assert.match(messageGuidance({ ...chat, fresh_check: noul(0.9) })!, /quick_search/);
	assert.match(messageGuidance({ ...chat, fresh_check: noul(0.9) }, { namesMachine: true })!, /background: true/);
	assert.doesNotMatch(messageGuidance({ ...chat, job_size: choice("t3_job"), fresh_check: noul(0.7) })!, /right now/, "build work isn't a lookup");
	assert.equal(messageGuidance({ ...chat, job_size: choice("quick_worker", 0.6) }), undefined, "a simple question can read as research");
	const musing = { ...chat, job_size: choice("t3_job"), thinking_aloud: noul(0.9), firm_ask: noul(0.05) };
	assert.match(messageGuidance(musing)!, /thinking out loud/);
	assert.doesNotMatch(messageGuidance(musing)!, /open and steer/, "an idea isn't a job");
	const memo = messageGuidance(musing, { voice: true })!;
	assert.match(memo, /pick out the asks/);
	assert.doesNotMatch(memo, /don't start work/, "a rambling memo can end in a real ask");
	assert.ok("in_job" in messageQuestions(true));
	assert.ok(!("in_job" in messageQuestions(false)));
});

test("arms are stable and split near the holdout", () => {
	assert.equal(armOf("turn:a:1", 0.2), armOf("turn:a:1", 0.2));
	const controls = Array.from({ length: 2_000 }, (_, index) => armOf(`event-${index}`, 0.2)).filter((arm) => arm === "control").length;
	assert.ok(controls > 300 && controls < 500, `${controls} controls`);
});

test("typing shows wherever work is running, so silence means nothing is", () => {
	const dm = "discord:dm:1";
	const channel = "discord:channel:2";
	const none = [{ address: dm, workers: [{ status: "idle" }] }];
	assert.deepEqual(typingTargets(none, []), []);
	assert.deepEqual(typingTargets([{ address: dm, workers: [{ status: "working" }] }], []), [dm]);
	assert.deepEqual(typingTargets([], [{ origin: dm, background: true, state: "working" }]), [dm]);
	assert.deepEqual(typingTargets([], [{ origin: dm, background: true, state: "done" }]), []);
	assert.deepEqual(typingTargets([], [{ origin: channel, state: "working", discordThreadId: "9" }]), ["discord:thread:9"], "a job's thread, even a full job");
	const worker = { origin: channel, state: "working" as const, discordThreadId: "9", worker: { name: "a", conversationId: "1" as never } };
	assert.deepEqual(typingTargets([{ address: channel, workers: [{ status: "working" }] }], [worker]), ["discord:thread:9"], "the thread, not the channel too");
	assert.deepEqual(typingTargets([{ address: channel, workers: [{ status: "working" }] }], []), [channel], "with no thread, the channel");
});

test("the board channel is never served, whatever else says so", () => {
	const listed = new Set(["board", "span"]);
	assert.equal(serves("span", listed, undefined, "board"), true);
	assert.equal(serves("board", listed, undefined, "board"), false);
	assert.equal(serves("board", listed, "Projects", "board"), false);
	assert.equal(serves("game", listed, "Projects", "board"), true);
	assert.equal(serves("other", listed, "Text Channels", "board"), false);
});

test("activity for updates leaves out secrets", () => {
	const activity = describeActivity([
		{ kind: "tool", at: 1, name: "bash", args: { command: "ledger:status" }, result: "docked\nAPI_KEY=abc123\nok" },
		{ kind: "from-pclaw", at: 2, text: "brief" },
		{ kind: "thinking", at: 3, text: "hmm" },
	]);
	assert.match(activity, /ran ledger:status/);
	assert.match(activity, /docked/);
	assert.doesNotMatch(activity, /abc123|brief|hmm/);
});

test("the card and board read at a glance", () => {
	const job: Job = { id: "a", title: "Map proof", brief: "", threadId: "t", machine: "pc1", project: "hexfall", origin: "discord:channel:1", state: "needs_you", status: "Tiles or heightmap?", told: [], startedAt: 1_000_000, updatedAt: 1_000_000, discordThreadId: "9" };
	assert.match(jobCard(job), /^🙋 Needs you · pc1 · hexfall · started <t:1000:R>\nTiles or heightmap\?$/);
	assert.match(jobCard({ ...job, worker: { name: "a", conversationId: "1" as never } }), /^🙋 Needs you · started/, "where a worker runs isn't news");
	const board = jobBoard([job, { ...job, id: "b", title: "Old", state: "done", discordThreadId: "8", updatedAt: 1_000_000 }], 1_000_000);
	assert.match(board, /🙋 <#9> · pc1/);
	assert.match(board, /Last 24 hours\*\*\n✅ <#8>/);
	assert.match(jobBoard([], 1_000_000), /Nothing running/);
});

test("voice memos go to the speech server, and a failure says so", async () => {
	const sent: unknown[] = [];
	const server = (async (_url: string, init: RequestInit) => {
		sent.push(init.body);
		return new Response(JSON.stringify({ text: "keep going on the dialog", seconds: 83.4, ms: 90 }), { status: 200 });
	}) as unknown as typeof fetch;
	const heard = await transcribe("http://speech.test/", new Uint8Array([1, 2]), server);
	assert.equal(heard.text, "keep going on the dialog");
	assert.equal(sent.length, 1);
	assert.match(memoLabel(heard.seconds), /voice memo, 1m 23s/);
	assert.match(memoLabel(9), /voice memo, 9s/);
	const down = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
	await assert.rejects(transcribe("http://speech.test", new Uint8Array([1]), down), /returned 500/);
});

test("the report compares text and voice", () => {
	const at = (minutes: number) => new Date(1_800_000_000_000 + minutes * 60_000).toISOString();
	const decision = (id: string, answers: Answers): LogEvent => ({ type: "decision", id, site: "message", ok: true, at: at(0), answers });
	const lanes = compareModalities([
		{ type: "message", id: "a", modality: "voice", words: 300, channel: "general", at: at(0) },
		decision("a", { thinking_aloud: noul(0.9), firm_ask: noul(0.1), corrects: noul(0) }),
		{ type: "message", id: "b", modality: "text", words: 8, channel: "general", at: at(5) },
		decision("b", { thinking_aloud: noul(0.1), firm_ask: noul(0.9), corrects: noul(0.9) }),
		{ type: "message", id: "c", modality: "text", words: 4, channel: "general", at: at(600) },
		decision("c", { thinking_aloud: noul(0.1), firm_ask: noul(0.9), corrects: noul(0.9) }),
	]);
	assert.deepEqual(lanes.voice, { messages: 1, medianWords: 300, thinkingAloud: 1, firmAsks: 0, corrected: 1 });
	assert.equal(lanes.text!.messages, 2);
	assert.equal(lanes.text!.corrected, 0, "a correction hours later isn't about this message");
});

test("the report compares workers with background and full jobs", () => {
	const at = (minutes: number) => new Date(1_800_000_000_000 + minutes * 60_000).toISOString();
	const events: LogEvent[] = [
		{ type: "worker", at: at(0), ok: true, ms: 120_000 },
		{ type: "worker", at: at(1), ok: false, ms: 1_800_000 },
		{ type: "job", event: "start", job: "quick", background: true, at: at(0) },
		{ type: "wake", job: "quick", state: "done", at: at(1) },
		{ type: "job", event: "start", job: "big", background: false, at: at(0) },
		{ type: "wake", job: "big", state: "failed", at: at(10) },
		{ type: "wake", job: "big", state: "done", at: at(20) },
		{ type: "job", event: "start", job: "theirs", adopted: true, at: at(0) },
	];
	const lanes = compareLanes(events);
	assert.deepEqual([lanes.worker.runs, lanes.worker.failed, lanes.worker.p50min], [2, 1, 2]);
	assert.deepEqual([lanes.background.runs, lanes.background.failed, lanes.background.p50min], [1, 0, 1]);
	assert.deepEqual([lanes.job.runs, lanes.job.failed, lanes.job.p50min], [1, 1, 10]);
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
