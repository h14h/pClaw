import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "../agent.ts";
import { type Config, defaults } from "../config.ts";
import { Notes } from "../extensions/notes.ts";
import { Reactions } from "../extensions/reactions.ts";
import { CLOSE_HINT } from "../extensions/workers.ts";
import { discordMessages } from "./discord.ts";
import { ReplyThreads } from "./reply-threads.ts";
import { buildTelegramUserInput, startTelegram, type TelegramMessage, type TelegramUpdate } from "./telegram.ts";

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

test("Telegram threads interleaved and out-of-order worker replies to their ask, and keeps normal turns plain", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-tg-threads-"));
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// Answer each turn by what it was about, so the order of sends is easy to read.
		const answer = (request: ModelContext) => {
			const last = lastText(request);
			const label =
				last.includes("worker=\\\"wa\\\"") ? "A is done"
				: last.includes("worker=\\\"wb2\\\"") ? "B part two is done"
				: last.includes("worker=\\\"wb\\\"") ? "B is done"
				: last.includes("topic A") ? "on A"
				: last.includes("topic B") ? "on B"
				: "ok";
			return fauxAssistantMessage(label);
		};
		faux.setResponses(Array.from({ length: 10 }, () => answer));

		const config: Config = {
			...defaults,
			provider: "faux",
			model: "faux-1",
			thinkingLevel: "off",
			timeZone: "UTC",
			telegramToken: "fake-token",
			telegramAllowedUsers: [],
			telegramAllowedGroups: [],
		};
		const agent = await openAgent(
			await openNodeSqliteStorage(join(dir, "pclaw.sqlite")),
			{ config, models, notes: new Notes(join(dir, "notes.md")) },
			BACKGROUND_CONTEXT,
		);

		const updateQueue: TelegramUpdate[][] = [];
		let wakePoll: (() => void) | undefined;
		const sent: Record<string, unknown>[] = [];
		const uploads: { method: string; replyParameters: unknown }[] = [];
		const mockFetch: typeof fetch = async (input, init) => {
			const method = String(input).split("/").pop()!;
			if (init?.body instanceof FormData) {
				const raw = init.body.get("reply_parameters");
				uploads.push({ method, replyParameters: raw === null ? undefined : JSON.parse(String(raw)) });
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
		const say = (id: number, text: string) => {
			updateQueue.push([
				{ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, chat: { id: 501, type: "private" }, from: { id: 501, first_name: "Henry" }, text } },
			]);
			wakePoll?.();
		};

		const tg = await startTelegram(agent, config, BACKGROUND_CONTEXT, {
			apiBase: "https://tg.test",
			fetchFn: mockFetch,
			pollTimeoutSeconds: 1,
			captionlessDebounceMs: 0,
			inboxDir: join(dir, "inbox"),
			voiceDir: join(dir, "voice"),
			onOwnerPaired: () => undefined,
		});
		const conversation = await agent.conversationFor("telegram:dm:501", BACKGROUND_CONTEXT);
		/** A worker's report for the job `ask` started, the way workers.ts submits it. */
		const report = async (worker: string, ask: string) => {
			const requestId = `worker-report:${worker}`;
			await conversation.commit(async (tx) => {
				(await tx.doc(Reactions, conversation.id)).reports[requestId] = ask;
			}, BACKGROUND_CONTEXT);
			await conversation.submit(
				{ type: "input", content: `<worker-report worker="${worker}" status="done">\nfinished\n</worker-report>`, whenBusy: "followUp", requestId },
				BACKGROUND_CONTEXT,
			);
		};

		try {
			// A normal turn stays plain.
			say(100, "topic A");
			await waitFor(() => sent.length >= 1);
			assert.equal(sent[0]?.text, "on A");
			assert.equal(sent[0]?.reply_parameters, undefined);

			// They move on to B: also plain.
			say(101, "topic B");
			await waitFor(() => sent.length >= 2);
			assert.equal(sent[1]?.text, "on B");
			assert.equal(sent[1]?.reply_parameters, undefined);

			// A's worker finishes after they moved on: it quotes A, and deleted targets still send.
			await report("wa", "telegram:100");
			await waitFor(() => sent.length >= 3);
			assert.equal(sent[2]?.text, "A is done");
			assert.deepEqual(sent[2]?.reply_parameters, { message_id: 100, allow_sending_without_reply: true });

			// B's worker lands after A's report went out: concurrent workers out of order, so it quotes B.
			await report("wb", "telegram:101");
			await waitFor(() => sent.length >= 4);
			assert.equal(sent[3]?.text, "B is done");
			assert.deepEqual(sent[3]?.reply_parameters, { message_id: 101, allow_sending_without_reply: true });

			// Another report for B right after: the chat is already on B, so plain.
			await report("wb2", "telegram:101");
			await waitFor(() => sent.length >= 5);
			assert.equal(sent[4]?.text, "B part two is done");
			assert.equal(sent[4]?.reply_parameters, undefined);

			// A file for A, sent while the chat is on B, threads to A too.
			const sender = agent.fileSenders.get("telegram")!;
			await sender("telegram:dm:501", { data: new Uint8Array([1, 2, 3]), filename: "a.csv" }, { replyTo: "telegram:100" });
			assert.deepEqual(uploads.at(-1), { method: "sendDocument", replyParameters: { message_id: 100, allow_sending_without_reply: true } });
			// ...and a second file for A follows plainly.
			await sender("telegram:dm:501", { data: new Uint8Array([4]), filename: "a2.csv" }, { replyTo: "telegram:100" });
			assert.deepEqual(uploads.at(-1), { method: "sendDocument", replyParameters: undefined });

			// The mapping comes from durable records, so it holds after every run has ended.
			await conversation.waitForIdle(BACKGROUND_CONTEXT);
			const users = (await conversation.context(BACKGROUND_CONTEXT)).entries.filter((entry) => UserEntry.is(entry));
			const asks = await Promise.all(users.map((entry) => agent.askOf(conversation.id, entry.id, BACKGROUND_CONTEXT)));
			assert.deepEqual(asks, ["telegram:100", "telegram:101", "telegram:100", "telegram:101", "telegram:101"]);
		} finally {
			await tg.stop();
			await agent.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Discord replies stay plain on a normal turn and quote the ask natively when interleaved", () => {
	const threads = new ReplyThreads("discord");
	const addr = "discord:dm:7";
	const send = (text: string, replyTo: string) => {
		const target = threads.target(addr, replyTo);
		const messages = discordMessages(text, { mode: undefined, ...(target === undefined ? {} : { replyTo: target }) });
		threads.sent(addr, replyTo);
		return messages;
	};

	threads.heard(addr, "111");
	assert.deepEqual(send("on A", "discord:111"), [{ content: "on A" }]);

	threads.heard(addr, "222");
	assert.deepEqual(send("on B", "discord:222"), [{ content: "on B" }]);

	// A's report after they moved on to B: a native reply on the first chunk only, never failing, never re-pinging.
	const long = `${"a".repeat(1_500)}\n\n${"b".repeat(1_500)}`;
	const interleaved = send(long, "discord:111");
	assert.equal(interleaved.length, 2);
	assert.deepEqual(interleaved[0]?.reply, { messageReference: "111", failIfNotExists: false });
	assert.deepEqual(interleaved[0]?.allowedMentions, { parse: [], repliedUser: false });
	assert.equal(interleaved[1]?.reply, undefined);

	// Out of order: B's report after A's went out quotes B; a second one for B is plain.
	assert.deepEqual(send("B done", "discord:222")[0]?.reply, { messageReference: "222", failIfNotExists: false });
	assert.deepEqual(send("B more", "discord:222"), [{ content: "B more" }]);

	// Other channels' refs and follow-ups (no ref) never thread.
	assert.equal(threads.target(addr, "telegram:111"), undefined);
	assert.equal(threads.target(addr, undefined), undefined);
	// Nothing heard yet (just restarted): plain.
	assert.equal(new ReplyThreads("discord").target(addr, "discord:111"), undefined);

	// A ping still mentions the owner when it quotes.
	const pinged = discordMessages("done", { mode: "ping", ownerId: "42", replyTo: "111" });
	assert.equal(pinged[0]?.content, "<@42> done");
	assert.deepEqual(pinged[0]?.allowedMentions, { parse: ["users"], repliedUser: false });
});

const fakeApi = (downloads: string[], files: Record<string, string> = {}) => ({
	async getFile(fileId: string) {
		return { file_id: fileId, file_path: files[fileId] ?? `files/${fileId}` };
	},
	async downloadFile(filePath: string) {
		downloads.push(filePath);
		return new Uint8Array(Buffer.from(`bytes:${filePath}`));
	},
	async sendChatAction() {
		return true;
	},
});

const reply = (text: string, replyTo: Partial<TelegramMessage> & { message_id: number }): TelegramMessage => ({
	message_id: 500,
	date: 1_700_001_000,
	chat: { id: 101, type: "private" },
	from: { id: 101, first_name: "Alice" },
	text,
	reply_to_message: { date: 1_700_000_000, chat: { id: 101, type: "private" }, from: { id: 101, first_name: "Alice" }, ...replyTo },
});

test("swiping to reply to an older photo shows it again, stages it, and names where it's saved", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-tg-reply-photo-"));
	try {
		const inboxDir = join(dir, "inbox");
		const staged: string[] = [];
		const stageFile = async (_localPath: string, filename: string) => {
			staged.push(filename);
			return `~/inbox/${filename}`;
		};
		const photo = [
			{ file_id: "thumb", width: 90, height: 90, file_size: 100 },
			{ file_id: "plant.jpg", width: 1280, height: 960, file_size: 50_000 },
		];

		// Captioned, from before pclaw saved photos: downloaded again, saved, staged, and the label keeps "photo".
		const downloads: string[] = [];
		const captioned = await buildTelegramUserInput([reply("what about this one?", { message_id: 70, photo, caption: "my monstera" })], {
			api: fakeApi(downloads),
			timeZone: "UTC",
			botId: 999,
			inboxDir,
			stageFile,
		});
		assert.deepEqual(downloads, ["files/plant.jpg"]);
		assert.ok(Array.isArray(captioned.content));
		const text = captioned.content[0]!.type === "text" ? captioned.content[0]!.text : "";
		assert.match(text, /\[replying to their own photo from .* \(saved at ~\/inbox\/tg-101-70-photo-70\.jpg\): "my monstera"\]/);
		const images = captioned.content.filter((part) => part.type === "image");
		assert.equal(images.length, 1);
		assert.equal(images[0]!.mimeType, "image/jpeg");
		assert.equal(Buffer.from(images[0]!.data, "base64").toString("utf8"), "bytes:files/plant.jpg");
		assert.equal(readFileSync(join(inboxDir, "tg-101-70-photo-70.jpg"), "utf8"), "bytes:files/plant.jpg");
		assert.deepEqual(staged, ["tg-101-70-photo-70.jpg"]);

		// Captionless, already in the inbox: no download, the saved bytes go inline, and it's staged again.
		mkdirSync(inboxDir, { recursive: true });
		writeFileSync(join(inboxDir, "tg-101-71-photo-71.png"), "saved-png");
		const again: string[] = [];
		const captionless = await buildTelegramUserInput([reply("and this?", { message_id: 71, photo })], {
			api: fakeApi(again),
			timeZone: "UTC",
			botId: 999,
			inboxDir,
			stageFile,
		});
		assert.deepEqual(again, []);
		assert.ok(Array.isArray(captionless.content));
		const text2 = captionless.content[0]!.type === "text" ? captionless.content[0]!.text : "";
		assert.match(text2, /\[replying to their own photo from [^\]]* \(saved at ~\/inbox\/tg-101-71-photo-71\.png\)\]/);
		const inline = captionless.content.filter((part) => part.type === "image");
		assert.equal(inline.length, 1);
		assert.equal(inline[0]!.mimeType, "image/png");
		assert.equal(Buffer.from(inline[0]!.data, "base64").toString("utf8"), "saved-png");

		// Without a workspace to stage to, the local path is named.
		const local = await buildTelegramUserInput([reply("this", { message_id: 71, photo })], { api: fakeApi([]), timeZone: "UTC", inboxDir });
		assert.ok(Array.isArray(local.content));
		assert.match(local.content[0]!.type === "text" ? local.content[0]!.text : "", new RegExp(`saved at ${join(inboxDir, "tg-101-71-photo-71.png").replace(/[.]/g, "\\.")}`));

		// A failed download keeps the reply context and says nothing false about a saved copy.
		const broken = await buildTelegramUserInput([reply("this?", { message_id: 72, photo, caption: "old one" })], {
			api: { ...fakeApi([]), downloadFile: async () => Promise.reject(new Error("gone")) },
			timeZone: "UTC",
			inboxDir,
		});
		assert.equal(typeof broken.content, "string");
		assert.match(String(broken.content), /\[replying to their own photo from [^\]]*: "old one"\]/);
		assert.doesNotMatch(String(broken.content), /saved at/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("swiping to reply to an older document keeps its label and caption and names where it's staged", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-tg-reply-doc-"));
	try {
		const inboxDir = join(dir, "inbox");
		const stageFile = async (_localPath: string, filename: string) => `~/inbox/${filename}`;
		const document = { file_id: "lease.pdf", file_name: "lease.pdf", mime_type: "application/pdf", file_size: 4096 };

		// Captioned, not saved yet: downloaded, saved under the inbox name, staged; a PDF isn't shown inline.
		const downloads: string[] = [];
		const captioned = await buildTelegramUserInput([reply("when does it end?", { message_id: 80, document, caption: "new lease" })], {
			api: fakeApi(downloads),
			timeZone: "UTC",
			botId: 999,
			inboxDir,
			stageFile,
		});
		assert.deepEqual(downloads, ["files/lease.pdf"]);
		assert.equal(typeof captioned.content, "string");
		assert.match(String(captioned.content), /\[replying to their own file "lease\.pdf" from .* \(saved at ~\/inbox\/tg-101-80-lease\.pdf\): "new lease"\]/);
		assert.ok(existsSync(join(inboxDir, "tg-101-80-lease.pdf")));

		// Captionless, already saved: reused without downloading.
		const again: string[] = [];
		const captionless = await buildTelegramUserInput([reply("and the deposit?", { message_id: 80, document })], {
			api: fakeApi(again),
			timeZone: "UTC",
			botId: 999,
			inboxDir,
			stageFile,
		});
		assert.deepEqual(again, []);
		assert.match(String(captionless.content), /\[replying to their own file "lease\.pdf" from [^\]]* \(saved at ~\/inbox\/tg-101-80-lease\.pdf\)\]/);

		// An image sent as a file comes back inline too.
		const imageDoc = { file_id: "scan.png", file_name: "scan.png", mime_type: "image/png", file_size: 2048 };
		const scan = await buildTelegramUserInput([reply("read this", { message_id: 81, document: imageDoc })], {
			api: fakeApi([]),
			timeZone: "UTC",
			inboxDir,
			stageFile,
		});
		assert.ok(Array.isArray(scan.content));
		assert.equal(scan.content.filter((part) => part.type === "image")[0]?.mimeType, "image/png");

		// Staging failure: still replies with context, without a path that workers couldn't open.
		const unstaged = await buildTelegramUserInput([reply("?", { message_id: 80, document, caption: "new lease" })], {
			api: fakeApi([]),
			timeZone: "UTC",
			inboxDir,
			stageFile: async () => Promise.reject(new Error("vm offline")),
		});
		assert.match(String(unstaged.content), /\[replying to their own file "lease\.pdf" from [^\]]*: "new lease"\]/);
		assert.doesNotMatch(String(unstaged.content), /saved at/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the close hint steers the reaction away from a reflexive 👍", () => {
	assert.match(CLOSE_HINT, /don't default to 👍/);
	assert.match(CLOSE_HINT, /never use a positive reaction on bad, missing, or failed results/);
});
