import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import { ReplyThreads } from "./channels/reply-threads.ts";
import { startTelegram, type TelegramUpdate } from "./channels/telegram.ts";
import { type Config, defaults } from "./config.ts";
import type { WorkerItem } from "./dashboard/types.ts";
import { decisionClient } from "./decisions.ts";
import { Notes } from "./extensions/notes.ts";
import { Workers } from "./extensions/workers.ts";
import { interruptWorthy, SIDE_CHAT_RULE, startWorkerProgressMonitor, type WorkerProgressUpdateEvent } from "./worker-progress.ts";

const context = BACKGROUND_CONTEXT;

const config = (overrides: Partial<Config> = {}): Config => ({
	...defaults,
	provider: "faux",
	model: "faux-1",
	thinkingLevel: "off",
	timeZone: "UTC",
	telegramToken: "fake-token",
	telegramAllowedUsers: [],
	telegramAllowedGroups: [],
	...overrides,
});

const waitFor = (predicate: () => boolean, ms = 5_000) =>
	new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + ms;
		const tick = () => {
			if (predicate()) resolve();
			else if (Date.now() > deadline) reject(new Error("timed out waiting for condition"));
			else setTimeout(tick, 15);
		};
		tick();
	});

const lastText = (request: ModelContext) => JSON.stringify(request.messages.at(-1));
const isProgressRequest = (request: ModelContext) => lastText(request).includes("Already told them:");

test("breadcrumbs: plain one-topic chat, quotes while a worker runs, and quotes jumps back to an older message", () => {
	const threads = new ReplyThreads("telegram");
	const addr = "telegram:dm:1";
	const reply = (replyTo: string, workingAsks: string[] = [], isAck = false) => {
		const quoted = threads.quote(addr, replyTo, { workingAsks, isAck });
		if (!isAck) threads.sent(addr, replyTo);
		return quoted;
	};

	// 1. Single-threaded chat with nothing in the background: plain.
	threads.heard(addr, 10);
	assert.equal(reply("telegram:10"), undefined);
	threads.posted(addr, [11]);
	threads.heard(addr, 12);
	assert.equal(reply("telegram:12"), undefined);
	threads.posted(addr, [13, 14]);

	// 2. Side chat while a worker runs for another ask: quotes their message.
	threads.heard(addr, 15);
	assert.equal(reply("telegram:15", ["telegram:12"]), "15");
	threads.posted(addr, [16]);
	// The worker's own report (its worker still marked working) isn't side chat, and the chat already moved on: quoted.
	assert.equal(reply("telegram:12", ["telegram:12"]), "12");
	// A worker with no ask on record still counts as other work.
	threads.heard(addr, 17);
	assert.equal(reply("telegram:17", [""]), "17");
	threads.posted(addr, [18]);

	// 3. Swipe-reply to the message right above: plain.
	threads.heard(addr, 19, 18);
	assert.equal(reply("telegram:19"), undefined);
	threads.posted(addr, [20, 21]);
	// ...to any chunk of the newest multi-part reply: still plain.
	threads.heard(addr, 22, 20);
	assert.equal(reply("telegram:22"), undefined);
	threads.posted(addr, [23]);
	// Swipe-reply to an older message, no worker running: the follow-up is quoted, once.
	threads.heard(addr, 24, 11);
	assert.ok(threads.isOldTopic(addr, "telegram:24"));
	assert.equal(reply("telegram:24"), "24");
	assert.equal(reply("telegram:24"), undefined);
	assert.equal(threads.isOldTopic(addr, "telegram:24"), false);

	// Discord snowflakes compare as big integers.
	const discord = new ReplyThreads("discord");
	discord.heard("d", "1300000000000000001");
	discord.posted("d", ["1300000000000000005"]);
	discord.heard("d", "1300000000000000009", "1300000000000000001");
	assert.equal(discord.quote("d", "discord:1300000000000000009"), "1300000000000000009");
	discord.heard("d", "1300000000000000012", "1300000000000000009");
	assert.equal(discord.quote("d", "discord:1300000000000000012"), undefined);
	// Nothing known about the chat yet (just restarted): a swipe-reply can't be judged, so plain.
	const fresh = new ReplyThreads("telegram");
	fresh.heard(addr, 5, 1);
	assert.equal(fresh.quote(addr, "telegram:5"), undefined);
});

test("breadcrumbs: a worker ack stays plain when solo and quotes when another worker runs or the chat moved on", () => {
	const threads = new ReplyThreads("telegram");
	const addr = "telegram:dm:2";
	threads.heard(addr, 30);
	// Its own worker may already show as working: still solo.
	assert.equal(threads.quote(addr, "telegram:30", { isAck: true, workingAsks: [] }), undefined);
	assert.equal(threads.quote(addr, "telegram:30", { isAck: true, workingAsks: ["telegram:30"] }), undefined);
	// Another worker is already running.
	assert.equal(threads.quote(addr, "telegram:30", { isAck: true, workingAsks: ["telegram:20", "telegram:30"] }), "30");
	// The chat moved on before the ack went out.
	threads.heard(addr, 31);
	assert.equal(threads.quote(addr, "telegram:30", { isAck: true, workingAsks: ["telegram:30"] }), "30");
	// An ack for a jump back stays plain, and leaves the jump for the report to quote.
	threads.posted(addr, [32]);
	threads.heard(addr, 33, 30);
	assert.equal(threads.quote(addr, "telegram:33", { isAck: true, workingAsks: ["telegram:33"] }), undefined);
	assert.equal(threads.quote(addr, "telegram:33", {}), "33");
});

/** A Telegram bot over a mock Bot API, recording every sendMessage. */
async function telegramHarness(dir: string, respond: (request: ModelContext) => string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 40 }, () => (request: ModelContext) => fauxAssistantMessage(respond(request))));
	const cfg = config();
	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "pclaw.sqlite")),
		{ config: cfg, models, notes: new Notes(join(dir, "notes.md")) },
		context,
	);
	const updateQueue: TelegramUpdate[][] = [];
	let wakePoll: (() => void) | undefined;
	const sent: Record<string, unknown>[] = [];
	const uploads: unknown[] = [];
	const fetchFn: typeof fetch = async (input, init) => {
		const method = String(input).split("/").pop()!;
		if (init?.body instanceof FormData) {
			const raw = init.body.get("reply_parameters");
			uploads.push(raw === null ? undefined : JSON.parse(String(raw)));
			return new Response(JSON.stringify({ ok: true, result: { message_id: 900, date: 1_700_000_000, chat: { id: 501, type: "private" } } }));
		}
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: "pclaw_test_bot" } }));
		if (method === "getUpdates") {
			if (updateQueue.length > 0) return new Response(JSON.stringify({ ok: true, result: updateQueue.shift()! }));
			return new Promise<Response>((resolve, reject) => {
				const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
				init?.signal?.addEventListener("abort", onAbort, { once: true });
				wakePoll = () => {
					init?.signal?.removeEventListener("abort", onAbort);
					resolve(new Response(JSON.stringify({ ok: true, result: updateQueue.shift() ?? [] })));
				};
			});
		}
		if (method === "sendMessage") {
			sent.push(body);
			return new Response(JSON.stringify({ ok: true, result: { message_id: 200 + sent.length, date: 1_700_000_010, chat: { id: 501, type: "private" } } }));
		}
		return new Response(JSON.stringify({ ok: true, result: true }));
	};
	const say = (id: number, text: string, replyTo?: number) => {
		updateQueue.push([
			{
				update_id: id,
				message: {
					message_id: id,
					date: 1_700_000_000 + id,
					chat: { id: 501, type: "private" },
					from: { id: 501, first_name: "Henry" },
					text,
					...(replyTo === undefined
						? {}
						: {
								reply_to_message: {
									message_id: replyTo,
									date: 1_700_000_000,
									chat: { id: 501, type: "private" },
									from: replyTo >= 200 ? { id: 999, is_bot: true, first_name: "pclaw" } : { id: 501, first_name: "Henry" },
									text: "earlier",
								},
							}),
				},
			},
		]);
		wakePoll?.();
	};
	const tg = await startTelegram(agent, cfg, context, {
		apiBase: "https://tg.test",
		fetchFn,
		pollTimeoutSeconds: 1,
		captionlessDebounceMs: 0,
		inboxDir: join(dir, "inbox"),
		voiceDir: join(dir, "voice"),
		onOwnerPaired: () => undefined,
	});
	const close = async () => {
		await tg.stop();
		await agent.harness.close(context);
	};
	return { agent, sent, uploads, say, close };
}

const answerByTopic = (request: ModelContext) => {
	const last = lastText(request);
	return last.includes("bears") ? "Yes, 24-17." : last.includes("pizza") ? "On pizza." : last.includes("soup") ? "On soup." : "ok";
};

test("Telegram: side chat while a worker runs quotes their message; a jump back to an older message quotes the follow-up", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-breadcrumbs-"));
	try {
		const { agent, sent, say, close } = await telegramHarness(dir, answerByTopic);
		try {
			// One topic, nothing running: plain.
			say(100, "pizza places?");
			await waitFor(() => sent.length >= 1);
			assert.equal(sent[0]?.text, "On pizza.");
			assert.equal(sent[0]?.reply_parameters, undefined);

			// Swipe-reply to the bot's message right above: still plain.
			say(101, "pizza near me", 201);
			await waitFor(() => sent.length >= 2);
			assert.equal(sent[1]?.reply_parameters, undefined);

			// Swipe-reply to their older message (not the one right above): the reply quotes the follow-up.
			say(102, "back to the pizza thing", 100);
			await waitFor(() => sent.length >= 3);
			assert.deepEqual(sent[2]?.reply_parameters, { message_id: 102, allow_sending_without_reply: true });

			// A worker is now running for an earlier ask: unrelated side chat quotes its own message.
			const conversation = await agent.conversationFor("telegram:dm:501", context);
			await conversation.commit(async (tx) => {
				(await tx.doc(Workers, conversation.id)).workers.soup = {
					sessionId: "sess-soup",
					brief: "find soup",
					status: "working",
					startedAt: Date.now(),
					updatedAt: Date.now(),
					ask: "telegram:102",
				};
			}, context);
			assert.deepEqual(await agent.activeWorkerAsks(conversation.id, context), ["telegram:102"]);
			say(103, "Did the bears win?");
			await waitFor(() => sent.length >= 4);
			assert.equal(sent[3]?.text, "Yes, 24-17.");
			assert.deepEqual(sent[3]?.reply_parameters, { message_id: 103, allow_sending_without_reply: true });

			// Once the worker is done, a normal turn is plain again.
			await conversation.commit(async (tx) => {
				(await tx.doc(Workers, conversation.id)).workers.soup!.status = "idle";
			}, context);
			say(104, "soup?");
			await waitFor(() => sent.length >= 5);
			assert.equal(sent[4]?.reply_parameters, undefined);
		} finally {
			await close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Telegram progress update quotes the worker's ask after they talked about something else, silently, and moves the chat onto it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-breadcrumbs-progress-"));
	try {
		const { agent, sent, uploads, say, close } = await telegramHarness(dir, answerByTopic);
		try {
			say(50, "pizza places?");
			await waitFor(() => sent.length >= 1);
			say(60, "Did the bears win?");
			await waitFor(() => sent.length >= 2);
			assert.equal(sent[1]?.reply_parameters, undefined);

			const surface = agent.progressSurfaces.get("telegram")!;
			const event: WorkerProgressUpdateEvent = {
				address: "telegram:dm:501",
				workerName: "pizza",
				sessionId: "sess-pizza",
				message: "The menu site is down; trying the delivery apps instead.",
				replyTo: "telegram:50",
				silent: true,
			};
			await surface.update(event);
			assert.equal(sent[2]?.text, "The menu site is down; trying the delivery apps instead.");
			assert.deepEqual(sent[2]?.reply_parameters, { message_id: 50, allow_sending_without_reply: true });
			assert.equal(sent[2]?.disable_notification, true);

			// The chat is on the pizza topic now, so the next reply about the bears quotes its own ask.
			await agent.fileSenders.get("telegram")!("telegram:dm:501", { data: new Uint8Array([1]), filename: "box.csv" }, { replyTo: "telegram:60" });
			assert.deepEqual(uploads.at(-1), { message_id: 60, allow_sending_without_reply: true });
			say(61, "and the score?");
			await waitFor(() => sent.length >= 4);
			// 61 is the latest message and the chat is on it: plain.
			assert.equal(sent[3]?.reply_parameters, undefined);

			// Not mid-side-chat: a plain, notifying update while the chat is on that ask.
			await surface.update({ ...event, replyTo: "telegram:61", silent: false, message: "Found it." });
			assert.equal(sent[4]?.reply_parameters, undefined);
			assert.equal(sent[4]?.disable_notification, undefined);
		} finally {
			await close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("progress monitor: passes the worker's ask, stays quiet on routine progress during side chat, and speaks up for failures and stalls", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-breadcrumbs-monitor-"));
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const progressRequests: ModelContext[] = [];
		let progressReply: { status: string; message: string | null } = { status: "Searching", message: "Checking tavern pizza spots." };
		faux.setResponses(
			Array.from({ length: 40 }, () => (request: ModelContext) => {
				if (!isProgressRequest(request)) return fauxAssistantMessage(answerByTopic(request));
				progressRequests.push(request);
				return fauxAssistantMessage(JSON.stringify(progressReply));
			}),
		);
		const items: WorkerItem[] = [{ kind: "tool", at: Date.now(), name: "web_search", args: { query: "tavern pizza" }, result: "10 results" }];
		const cfg = config({ telegramToken: undefined });
		const decisions = decisionClient({ logFile: join(dir, "decisions.jsonl") });
		const agent = await openAgent(
			await openNodeSqliteStorage(join(dir, "pclaw.sqlite")),
			{ config: cfg, models, notes: new Notes(join(dir, "notes.md")), decisions, homeDir: join(dir, "home"), workerItems: () => items },
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
			{ models, config: cfg, decisions, everyMs: 60_000, refreshMs: 10_000, firstUpdateMs: 10_000, quietConfirmMs: 100_000, now: () => fakeNow },
			context,
		);
		try {
			const conversation = await agent.conversationFor("telegram:dm:909", context);
			await conversation.submit({ type: "input", content: "[Sun 2026-11-22 12:00]\nfind tavern pizza", requestId: "telegram:50" }, context);
			await conversation.waitForIdle(context);
			const startedAt = Date.now();
			fakeNow = startedAt;
			await conversation.commit(async (tx) => {
				(await tx.doc(Workers, conversation.id)).workers.pizza = {
					sessionId: "sess-pizza",
					brief: "find tavern pizza",
					status: "working",
					startedAt,
					updatedAt: startedAt,
					ask: "telegram:50",
				};
			}, context);

			// They're waiting on it: a normal update, carrying the ask, not silent, with no side-chat rules.
			fakeNow += 20_000;
			await monitor.tick();
			assert.equal(updates.length, 1);
			assert.equal(updates[0]?.replyTo, "telegram:50");
			assert.equal(updates[0]?.silent, undefined);
			assert.doesNotMatch(lastText(progressRequests[0]!), /side conversation/);

			// They start talking about something else.
			await new Promise((resolve) => setTimeout(resolve, 5));
			await conversation.submit({ type: "input", content: "[Sun 2026-11-22 12:01]\nDid the bears win?", requestId: "telegram:60" }, context);
			await conversation.waitForIdle(context);

			// Routine progress during the side chat: no model call, no update.
			items.push({ kind: "tool", at: Date.now(), name: "web_search", args: { query: "pizza reviews" }, result: "8 results" });
			fakeNow += 20_000;
			await monitor.tick();
			assert.equal(progressRequests.length, 1);
			assert.equal(updates.length, 1);

			// A failure is worth breaking in for: the prompt carries the conversation and the interrupt-only rule.
			progressReply = { status: "Retrying", message: "The pizza site is down, so I'm trying the delivery apps." };
			items.push({ kind: "tool", at: Date.now(), name: "fetch", args: { url: "https://pizza.test" }, result: "503 error", isError: true });
			fakeNow += 20_000;
			await monitor.tick();
			assert.equal(progressRequests.length, 2);
			const sideRequest = lastText(progressRequests[1]!);
			assert.match(sideRequest, /side conversation about something else/);
			assert.match(sideRequest, /Did the bears win\?/);
			assert.match(sideRequest, /Yes, 24-17\./);
			assert.ok(sideRequest.includes(JSON.stringify(SIDE_CHAT_RULE).slice(1, 60)));
			assert.equal(updates.length, 2);
			assert.deepEqual(
				{ replyTo: updates[1]?.replyTo, silent: updates[1]?.silent, message: updates[1]?.message },
				{ replyTo: "telegram:50", silent: true, message: "The pizza site is down, so I'm trying the delivery apps." },
			);

			// The model may still judge an interrupt-worthy moment not worth it: nothing posts.
			progressReply = { status: "Retrying", message: null };
			items.push({ kind: "tool", at: Date.now(), name: "fetch", args: { url: "https://pizza2.test" }, result: "retrying after timeout" });
			fakeNow += 20_000;
			await monitor.tick();
			assert.equal(progressRequests.length, 3);
			assert.equal(updates.length, 2);

			// A long silent stall gets one note, not one per tick.
			progressReply = { status: "Stuck", message: "Pizza search has gone quiet for a few minutes; still waiting on it." };
			fakeNow += 200_000;
			await monitor.tick();
			assert.equal(progressRequests.length, 4);
			assert.match(lastText(progressRequests[3]!), /no new activity for 3m 20s/);
			assert.equal(updates.length, 3);
			assert.equal(updates[2]?.silent, true);
			fakeNow += 200_000;
			await monitor.tick();
			assert.equal(progressRequests.length, 4);
			assert.equal(updates.length, 3);
		} finally {
			monitor.stop();
			unregister();
			await agent.harness.close(context);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("interrupt-worthy activity: failures, retries, blockers, and pivots; not routine progress", () => {
	assert.ok(interruptWorthy("failed fetch\nresult: 503"));
	assert.ok(interruptWorthy("ran bash\nresult: ENOENT: no such file or directory"));
	assert.ok(interruptWorthy("said: the API timed out, retrying with a smaller page"));
	assert.ok(interruptWorthy("said: that source is blocked, switching approach"));
	assert.equal(interruptWorthy("ran web_search\nresult: 10 results"), false);
	assert.equal(interruptWorthy("said: found three good places, writing it up"), false);
});
