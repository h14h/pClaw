import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "../agent.ts";
import { type Config, defaults } from "../config.ts";
import { Notes } from "../extensions/notes.ts";
import {
	isTelegramReactionEmoji,
	markdownToTelegramHtml,
	normalizeTelegramReaction,
	splitPlainText,
	splitTelegramHtml,
	stripTelegramHtml,
	TELEGRAM_REACTION_EMOJIS,
} from "./telegram-format.ts";
import {
	authorizeTelegramMessage,
	buildTelegramUserInput,
	createMediaGroupBuffer,
	createTelegramApi,
	extractReplyContext,
	startTelegram,
	type TelegramMessage,
	type TelegramUpdate,
	telegramTypingTargets,
} from "./telegram.ts";

/** Verify every HTML tag in a Telegram HTML chunk is properly nested and closed. */
function assertBalancedTelegramHtml(chunk: string): void {
	const stack: string[] = [];
	const re = /<(\/?)([a-z][a-z0-9-]*)(?:\s+[^>]*)?>/gi;
	for (const match of chunk.matchAll(re)) {
		const isClose = match[1] === "/";
		const name = match[2]!.toLowerCase();
		if (!isClose) {
			stack.push(name);
		} else {
			const top = stack.pop();
			assert.equal(top, name, `Mismatched closing tag </${name}> (expected </${top}>) in: ${chunk}`);
		}
	}
	assert.deepEqual(stack, [], `Unclosed tags ${JSON.stringify(stack)} in: ${chunk}`);
}

test("markdownToTelegramHtml converts inline formatting, escapes HTML, and preserves code/identifiers", () => {
	assert.equal(
		markdownToTelegramHtml("Hello **bold**, *italic*, ***both***, ~~old~~, and ||secret||."),
		"Hello <b>bold</b>, <i>italic</i>, <b><i>both</i></b>, <s>old</s>, and <tg-spoiler>secret</tg-spoiler>.",
	);
	assert.equal(
		markdownToTelegramHtml("a < b && c > d & <script>x</script>"),
		"a &lt; b &amp;&amp; c &gt; d &amp; &lt;script&gt;x&lt;/script&gt;",
	);
	assert.equal(
		markdownToTelegramHtml("Keep my_snake_case_var and foo__bar__baz and 2 * 3 * 4 intact, but _italic_ and __bold__ work."),
		"Keep my_snake_case_var and foo__bar__baz and 2 * 3 * 4 intact, but <i>italic</i> and <b>bold</b> work.",
	);
	assert.equal(
		markdownToTelegramHtml("Nested **bold with *italic* and `a < b`** plus \\*literal\\* and **unclosed"),
		"Nested <b>bold with <i>italic</i> and <code>a &lt; b</code></b> plus *literal* and **unclosed",
	);
	assert.equal(
		markdownToTelegramHtml("Double backtick ``use `tick` here`` works."),
		"Double backtick <code>use `tick` here</code> works.",
	);
});

test("markdownToTelegramHtml handles links, Discord autolinks, and unsafe schemes", () => {
	assert.equal(
		markdownToTelegramHtml("Read [**Wiki**](https://en.wikipedia.org/wiki/C_(programming_language)) and <https://example.com/a&b>."),
		'Read <a href="https://en.wikipedia.org/wiki/C_(programming_language)"><b>Wiki</b></a> and https://example.com/a&amp;b.',
	);
	// Reject javascript: links; leave literal escaped text.
	assert.equal(markdownToTelegramHtml("[click](javascript:alert(1))"), "[click](javascript:alert(1))");
	// Query params with & are properly escaped in href.
	assert.equal(
		markdownToTelegramHtml('[search](https://example.com?a=1&b="2")'),
		'<a href="https://example.com?a=1&amp;b=&quot;2&quot;">search</a>',
	);
});

test("markdownToTelegramHtml handles fenced code blocks, headings, lists, tables, and rules", () => {
	const md = [
		"## Deploy steps",
		"",
		"- First **step**",
		"  - Nested detail",
		"1. Run `pnpm test`",
		"",
		"---",
		"",
		"```ts",
		"const x = a < b && c > d;",
		"```",
		"",
		"```",
		"plain <block>",
		"```",
		"",
		"| Service | Port |",
		"| --- | ---: |",
		"| App | 3000 |",
		"| DB | `5432` |",
	].join("\n");

	const html = markdownToTelegramHtml(md);
	assert.equal(
		html,
		[
			"<b>Deploy steps</b>",
			"",
			"• First <b>step</b>",
			"  ◦ Nested detail",
			"1. Run <code>pnpm test</code>",
			"",
			'<pre><code class="language-ts">const x = a &lt; b &amp;&amp; c &gt; d;</code></pre>',
			"",
			"<pre>plain &lt;block&gt;</pre>",
			"",
			"• <b>Service</b>: App · <b>Port</b>: 3000",
			"• <b>Service</b>: DB · <b>Port</b>: <code>5432</code>",
		].join("\n"),
	);
	assertBalancedTelegramHtml(html);

	// Unclosed fenced code block closes cleanly instead of breaking HTML.
	const unclosed = markdownToTelegramHtml("```bash\necho <hi>");
	assert.equal(unclosed, '<pre><code class="language-bash">echo &lt;hi&gt;</code></pre>');
	assertBalancedTelegramHtml(unclosed);

	// Heading with bold inside never double-nests <b><b>.
	assert.equal(markdownToTelegramHtml("# **Important** title"), "<b>Important title</b>");
});

test("markdownToTelegramHtml handles blockquotes, expandable blockquotes, and flattens nested quotes", () => {
	assert.equal(
		markdownToTelegramHtml("> Short quote with **bold**"),
		"<blockquote>Short quote with <b>bold</b></blockquote>",
	);
	assert.equal(
		markdownToTelegramHtml(">! Collapsible line 1\n>! Collapsible line 2"),
		"<blockquote expandable>Collapsible line 1\nCollapsible line 2</blockquote>",
	);
	assert.equal(
		markdownToTelegramHtml("**>Telegram style line 1\n>line 2||"),
		"<blockquote expandable>Telegram style line 1\nline 2</blockquote>",
	);
	// Long quote auto-collapses to expandable blockquote.
	const longQuote = Array.from({ length: 5 }, (_, idx) => `> Line ${idx + 1}`).join("\n");
	assert.equal(
		markdownToTelegramHtml(longQuote),
		"<blockquote expandable>Line 1\nLine 2\nLine 3\nLine 4\nLine 5</blockquote>",
	);
	// Nested quotes are flattened so Telegram never rejects with Nested blockquote error.
	const nested = markdownToTelegramHtml("> Outer\n>> Inner");
	assert.equal(nested, "<blockquote>Outer\n&gt; Inner</blockquote>");
	assert.equal((nested.match(/<blockquote/g) ?? []).length, 1);
	assertBalancedTelegramHtml(nested);
});

test("splitTelegramHtml never breaks open HTML tags, entities, code blocks, or surrogate pairs", () => {
	// Split a long fenced code block across chunks while preserving <pre><code class="language-ts"> in each chunk.
	const codeLines = Array.from({ length: 40 }, (_, i) => `const line_${i} = "value_${i} & <ok>";`).join("\n");
	const html = markdownToTelegramHtml(`Intro text.\n\n\`\`\`ts\n${codeLines}\n\`\`\`\n\nOutro **bold** text.`);
	const chunks = splitTelegramHtml(html, 220);
	assert.ok(chunks.length > 3, `expected multiple chunks, got ${chunks.length}`);
	for (const chunk of chunks) {
		assert.ok(chunk.length <= 220, `chunk exceeded limit: ${chunk.length}`);
		assertBalancedTelegramHtml(chunk);
		assert.ok(!/&[a-z#0-9]*$/i.test(chunk), `cut inside HTML entity: ${chunk}`);
	}
	assert.ok(chunks.some((c) => c.includes('<pre><code class="language-ts">') && c.includes("</code></pre>")));
	assert.match(stripTelegramHtml(chunks.join("\n")), /Intro text\./);
	assert.match(stripTelegramHtml(chunks.join("\n")), /const line_39 = "value_39 & <ok>";/);
	assert.match(stripTelegramHtml(chunks.join("\n")), /Outro bold text\./);

	// Split a long bold+link span cleanly and reopen both tags.
	const longBold = `<b>${"word ".repeat(60)}</b>`;
	const boldChunks = splitTelegramHtml(longBold, 80);
	assert.ok(boldChunks.length >= 4);
	for (const chunk of boldChunks) {
		assert.ok(chunk.length <= 80);
		assertBalancedTelegramHtml(chunk);
		assert.ok(chunk.startsWith("<b>") && chunk.endsWith("</b>"));
	}

	// Surrogate pairs (emoji) are never split in half.
	const emojiHtml = `<b>${"🔥".repeat(40)}</b>`;
	const emojiChunks = splitTelegramHtml(emojiHtml, 30);
	for (const chunk of emojiChunks) {
		assert.ok(chunk.length <= 30);
		assertBalancedTelegramHtml(chunk);
		assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), "trailing lone high surrogate");
		assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk), "leading lone low surrogate");
	}

	// Plain text fallback splitter respects limit too.
	const plainChunks = splitPlainText("x".repeat(9000), 4096);
	assert.equal(plainChunks.length, 3);
	assert.ok(plainChunks.every((c) => c.length <= 4096));
});

test("normalizeTelegramReaction enforces Telegram's exact ReactionTypeEmoji whitelist", () => {
	const whitelist = new Set<string>(TELEGRAM_REACTION_EMOJIS);
	// Every official emoji maps to itself.
	for (const emoji of TELEGRAM_REACTION_EMOJIS) {
		assert.equal(normalizeTelegramReaction(emoji), emoji);
		assert.ok(isTelegramReactionEmoji(emoji));
	}
	// Variation selectors and skin-tone modifiers normalize to exact canonical strings.
	assert.equal(normalizeTelegramReaction("❤️"), "❤");
	assert.equal(normalizeTelegramReaction("⚡️"), "⚡");
	assert.equal(normalizeTelegramReaction("✍️"), "✍");
	assert.equal(normalizeTelegramReaction("👍🏽"), "👍");
	assert.ok(isTelegramReactionEmoji("❤️"));
	assert.ok(isTelegramReactionEmoji("👍🏽"));

	// pclaw's core emojis not in Telegram's whitelist map cleanly to valid reactions.
	assert.ok(!isTelegramReactionEmoji("⏳"));
	assert.ok(!isTelegramReactionEmoji("✅"));
	assert.ok(!isTelegramReactionEmoji("⚠️"));
	assert.equal(normalizeTelegramReaction("⏳"), "👀");
	assert.equal(normalizeTelegramReaction("✅"), "👍");
	assert.equal(normalizeTelegramReaction("⚠️"), "😢");
	assert.equal(normalizeTelegramReaction("❌"), "😢");
	assert.equal(normalizeTelegramReaction("🖥️"), "👨‍💻");
	assert.equal(normalizeTelegramReaction("🚀"), "🔥");

	// Unknown topical emojis fall back to a valid Telegram emoji (never REACTION_INVALID).
	const fallbackResult = normalizeTelegramReaction("🍜");
	assert.ok(fallbackResult !== undefined && whitelist.has(fallbackResult));
	assert.equal(normalizeTelegramReaction("🍜", "👀"), "👀");

	// Empty clears reaction.
	assert.equal(normalizeTelegramReaction(""), undefined);
	assert.equal(normalizeTelegramReaction("   "), undefined);
});

test("authorizeTelegramMessage enforces owner pairing, allowlist, and group rules", () => {
	const dmFrom = (id: number, isBot = false): TelegramMessage => ({
		message_id: 1,
		date: 1_700_000_000,
		chat: { id, type: "private" },
		from: { id, is_bot: isBot, first_name: "Alice" },
		text: "hi",
	});
	const groupFrom = (chatId: number, userId: number): TelegramMessage => ({
		message_id: 2,
		date: 1_700_000_000,
		chat: { id: chatId, type: "supergroup", title: "Home Lab" },
		from: { id: userId, first_name: "Alice" },
		text: "hi",
	});

	// Bots are always ignored.
	assert.deepEqual(
		authorizeTelegramMessage(dmFrom(10, true), { allowedUsers: new Set(), allowedGroups: new Set() }),
		{ allowed: false },
	);

	// Unpaired instance pairs first DM user, but never pairs in a group.
	assert.deepEqual(
		authorizeTelegramMessage(dmFrom(101), { allowedUsers: new Set(), allowedGroups: new Set() }),
		{ allowed: true, pairedOwnerId: "101", addr: "telegram:dm:101", label: "Telegram DM", isGroup: false },
	);
	assert.deepEqual(
		authorizeTelegramMessage(groupFrom(-1001, 101), { allowedUsers: new Set(), allowedGroups: new Set(["-1001"]) }),
		{ allowed: false },
	);

	// Owner-only mode rejects strangers.
	const ownerState = { ownerId: "101", allowedUsers: new Set<string>(), allowedGroups: new Set(["-1001"]) };
	assert.equal(authorizeTelegramMessage(dmFrom(101), ownerState).allowed, true);
	assert.equal(authorizeTelegramMessage(dmFrom(202), ownerState).allowed, false);

	// Explicit allowlist enforces listed users and listed groups.
	const allowlistState = { allowedUsers: new Set(["101", "202"]), allowedGroups: new Set(["-1001"]) };
	assert.deepEqual(authorizeTelegramMessage(dmFrom(202), allowlistState), {
		allowed: true,
		addr: "telegram:dm:202",
		label: "Telegram DM",
		isGroup: false,
	});
	assert.equal(authorizeTelegramMessage(dmFrom(303), allowlistState).allowed, false);
	assert.deepEqual(authorizeTelegramMessage(groupFrom(-1001, 202), allowlistState), {
		allowed: true,
		addr: "telegram:group:-1001",
		label: "Home Lab",
		isGroup: true,
	});
	assert.equal(authorizeTelegramMessage(groupFrom(-9999, 202), allowlistState).allowed, false);
	assert.equal(authorizeTelegramMessage(groupFrom(-1001, 303), allowlistState).allowed, false);
});

test("createMediaGroupBuffer batches album updates by media_group_id in arrival order", async () => {
	const batches: TelegramMessage[][] = [];
	const buffer = createMediaGroupBuffer({
		delayMs: 30,
		onFlush: (msgs) => {
			batches.push(msgs);
		},
	});
	const photoMsg = (id: number, group: string, caption?: string): TelegramMessage => ({
		message_id: id,
		date: 1_700_000_000,
		chat: { id: 42, type: "private" },
		from: { id: 42, first_name: "Alice" },
		media_group_id: group,
		...(caption === undefined ? {} : { caption }),
		photo: [{ file_id: `f-${id}`, width: 800, height: 600 }],
	});

	buffer.add(photoMsg(10, "album-1", "Look at these two"));
	buffer.add(photoMsg(11, "album-1"));
	buffer.add(photoMsg(20, "album-2", "Separate album"));

	await new Promise((resolve) => setTimeout(resolve, 90));
	buffer.stop();

	assert.equal(batches.length, 2);
	assert.deepEqual(
		batches[0]!.map((m) => m.message_id),
		[10, 11],
	);
	assert.deepEqual(
		batches[1]!.map((m) => m.message_id),
		[20],
	);
});

test("extractReplyContext and buildTelegramUserInput normalize replies, quotes, albums, voice, and documents", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-tg-input-"));
	try {
		const downloaded: string[] = [];
		const fakeApi = {
			async getFile(fileId: string) {
				return { file_id: fileId, file_path: `files/${fileId}` };
			},
			async downloadFile(filePath: string) {
				downloaded.push(filePath);
				return new Uint8Array(Buffer.from(`bytes:${filePath}`));
			},
			async sendChatAction() {
				return true;
			},
		};

		// Partial quote takes precedence over full reply text.
		const quotedMsg: TelegramMessage = {
			message_id: 50,
			date: 1_700_000_100,
			chat: { id: 101, type: "private" },
			from: { id: 101, first_name: "Alice" },
			text: "Yes, this part!",
			reply_to_message: {
				message_id: 49,
				date: 1_700_000_000,
				chat: { id: 101, type: "private" },
				from: { id: 999, is_bot: true, username: "pclawbot" },
				text: "Full earlier bot reply with lots of extra details",
			},
			quote: { text: "extra details" },
		};
		const quoteCtx = extractReplyContext(quotedMsg, 999, "UTC");
		assert.equal(quoteCtx.length, 1);
		assert.match(quoteCtx[0]!, /^\[quoting your message from .*: "extra details"\]$/);

		// Album of 2 photos (picks largest PhotoSize photo[-1]), plus a PDF document saved to inbox, plus voice transcribed.
		const album: TelegramMessage[] = [
			{
				message_id: 60,
				date: 1_700_000_200,
				chat: { id: 101, type: "private" },
				from: { id: 101, first_name: "Alice" },
				caption: "Check these receipts",
				media_group_id: "g1",
				photo: [
					{ file_id: "small.jpg", width: 90, height: 90, file_size: 1000 },
					{ file_id: "large1.jpg", width: 1200, height: 900, file_size: 120_000 },
				],
			},
			{
				message_id: 61,
				date: 1_700_000_200,
				chat: { id: 101, type: "private" },
				from: { id: 101, first_name: "Alice" },
				media_group_id: "g1",
				photo: [{ file_id: "large2.png", width: 1000, height: 800, file_size: 80_000 }],
				document: { file_id: "invoice.pdf", file_name: "../invoice (2026).pdf", mime_type: "application/pdf", file_size: 2048 },
				voice: { file_id: "memo.ogg", duration: 12, mime_type: "audio/ogg", file_size: 5000 },
			},
		];

		const built = await buildTelegramUserInput(album, {
			api: fakeApi,
			timeZone: "UTC",
			botId: 999,
			inboxDir: join(dir, "inbox"),
			voiceDir: join(dir, "voice"),
			speechUrl: "http://speech.test",
			transcribeFn: async () => ({ text: "please log the total", seconds: 12, ms: 90 }),
		});

		assert.equal(built.hasVoice, true);
		assert.ok(Array.isArray(built.content));
		const textPart = built.content[0]!;
		assert.equal(textPart.type, "text");
		assert.match(textPart.text, /Check these receipts/);
		assert.match(textPart.text, /\[voice memo, 12s/);
		assert.match(textPart.text, /please log the total/);
		assert.match(textPart.text, /\[attached file "\.\.\/invoice \(2026\)\.pdf" \(application\/pdf, \d+ bytes\), saved at /);

		// Verify sanitized file was written inside inboxDir (no path traversal).
		const savedPath = join(dir, "inbox", "tg-101-61-invoice (2026).pdf");
		assert.ok(existsSync(savedPath));
		assert.equal(readFileSync(savedPath, "utf8"), "bytes:files/invoice.pdf");

		// Verify largest photos (not small.jpg) were attached as ImageContent.
		const images = built.content.filter((p) => p.type === "image");
		assert.equal(images.length, 2);
		assert.equal(images[0]!.mimeType, "image/jpeg");
		assert.equal(images[1]!.mimeType, "image/png");
		assert.ok(!downloaded.includes("files/small.jpg"));
		assert.ok(downloaded.includes("files/large1.jpg"));
		assert.ok(downloaded.includes("files/large2.png"));

		// Oversized document (> 20 MB) is not downloaded and explains the Telegram limit cleanly.
		const hugeDoc: TelegramMessage = {
			message_id: 62,
			date: 1_700_000_300,
			chat: { id: 101, type: "private" },
			from: { id: 101, first_name: "Alice" },
			document: { file_id: "huge.zip", file_name: "huge.zip", mime_type: "application/zip", file_size: 25 * 1024 * 1024 },
		};
		const hugeBuilt = await buildTelegramUserInput([hugeDoc], { api: fakeApi, timeZone: "UTC", inboxDir: join(dir, "inbox") });
		assert.equal(typeof hugeBuilt.content, "string");
		assert.match(String(hugeBuilt.content), /20 MB limit/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("buildTelegramUserInput saves and stages compressed photos while keeping them inline", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-tg-photo-"));
	try {
		const inboxDir = join(dir, "inbox");
		const fakeApi = {
			async getFile(fileId: string) {
				return { file_id: fileId, file_path: `photos/${fileId}` };
			},
			async downloadFile(filePath: string) {
				return new Uint8Array(Buffer.from(`bytes:${filePath}`));
			},
			async sendChatAction() {
				return true;
			},
		};
		const photoMsg = (id: number, fileId: string, extra: Partial<TelegramMessage> = {}): TelegramMessage => ({
			message_id: id,
			date: 1_700_000_400,
			chat: { id: 101, type: "private" },
			from: { id: 101, first_name: "Alice" },
			photo: [
				{ file_id: "thumb", width: 90, height: 90, file_size: 100 },
				{ file_id: fileId, width: 1280, height: 960, file_size: 50_000 },
			],
			...extra,
		});

		// Single photo: inline ImageContent for the front model, plus a saved file staged to the VM inbox.
		const staged: { localPath: string; filename: string }[] = [];
		const stageFile = async (localPath: string, filename: string) => {
			staged.push({ localPath, filename });
			return `~/inbox/${filename}`;
		};
		const single = await buildTelegramUserInput([photoMsg(70, "big.jpg", { caption: "what's this plant?" })], {
			api: fakeApi,
			timeZone: "UTC",
			inboxDir,
			stageFile,
		});
		assert.ok(Array.isArray(single.content));
		const singleImages = single.content.filter((p) => p.type === "image");
		assert.equal(singleImages.length, 1);
		assert.equal(singleImages[0]!.mimeType, "image/jpeg");
		assert.equal(Buffer.from(singleImages[0]!.data, "base64").toString("utf8"), "bytes:photos/big.jpg");
		const singleLocal = join(inboxDir, "tg-101-70-photo-70.jpg");
		assert.equal(readFileSync(singleLocal, "utf8"), "bytes:photos/big.jpg");
		assert.deepEqual(staged, [{ localPath: singleLocal, filename: "tg-101-70-photo-70.jpg" }]);
		const singleText = single.content[0]!;
		assert.equal(singleText.type, "text");
		assert.match(singleText.text, /what's this plant\?/);
		assert.match(singleText.text, /\[attached photo "photo-70\.jpg" \(image\/jpeg, \d+ bytes\), saved at ~\/inbox\/tg-101-70-photo-70\.jpg\]/);

		// Album: each photo gets its own file (message id + MIME-derived extension), none overwritten.
		staged.length = 0;
		const album = await buildTelegramUserInput(
			[
				photoMsg(80, "a.jpg", { media_group_id: "g2", caption: "receipts" }),
				photoMsg(81, "b.jpg", { media_group_id: "g2" }),
				photoMsg(82, "c.png", { media_group_id: "g2" }),
			],
			{ api: fakeApi, timeZone: "UTC", inboxDir, stageFile },
		);
		assert.ok(Array.isArray(album.content));
		assert.equal(album.content.filter((p) => p.type === "image").length, 3);
		assert.deepEqual(
			staged.map((s) => s.filename),
			["tg-101-80-photo-80.jpg", "tg-101-81-photo-81.jpg", "tg-101-82-photo-82.png"],
		);
		assert.equal(readFileSync(join(inboxDir, "tg-101-80-photo-80.jpg"), "utf8"), "bytes:photos/a.jpg");
		assert.equal(readFileSync(join(inboxDir, "tg-101-81-photo-81.jpg"), "utf8"), "bytes:photos/b.jpg");
		assert.equal(readFileSync(join(inboxDir, "tg-101-82-photo-82.png"), "utf8"), "bytes:photos/c.png");
		for (const name of ["tg-101-80-photo-80.jpg", "tg-101-81-photo-81.jpg", "tg-101-82-photo-82.png"]) {
			assert.ok(album.plainText.includes(`saved at ~/inbox/${name}]`), `missing staged path for ${name}`);
		}

		// Staging failure: warn, keep the inline image, and point at the local copy.
		const originalWarn = console.warn;
		const warnings: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args);
		};
		let failed: Awaited<ReturnType<typeof buildTelegramUserInput>>;
		try {
			failed = await buildTelegramUserInput([photoMsg(90, "d.jpg")], {
				api: fakeApi,
				timeZone: "UTC",
				inboxDir,
				stageFile: async () => {
					throw new Error("Connection refused");
				},
			});
		} finally {
			console.warn = originalWarn;
		}
		assert.equal(warnings.length, 1);
		assert.ok(Array.isArray(failed.content));
		const failedImages = failed.content.filter((p) => p.type === "image");
		assert.equal(failedImages.length, 1);
		assert.equal(Buffer.from(failedImages[0]!.data, "base64").toString("utf8"), "bytes:photos/d.jpg");
		assert.match(
			failed.plainText,
			/\[attached photo "photo-90\.jpg" \(image\/jpeg, \d+ bytes\), saved locally at .*tg-101-90-photo-90\.jpg, but staging to workspace failed: Connection refused\]/,
		);

		// No staging hook: the local inbox path is given instead.
		const local = await buildTelegramUserInput([photoMsg(91, "e.jpg")], { api: fakeApi, timeZone: "UTC", inboxDir });
		assert.ok(local.plainText.includes(`saved at ${join(inboxDir, "tg-101-91-photo-91.jpg")}]`));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("createTelegramApi falls back to plain text on 400 parse errors, maps reactions, and uploads documents", async () => {
	const calls: { method: string; body: unknown }[] = [];
	let failHtmlOnce = true;

	const mockFetch: typeof fetch = async (input, init) => {
		const url = String(input);
		const method = url.split("/").pop()!;
		if (init?.body instanceof FormData) {
			calls.push({
				method,
				body: {
					chat_id: init.body.get("chat_id"),
					caption: init.body.get("caption"),
					parse_mode: init.body.get("parse_mode"),
					hasDocument: init.body.get("document") !== null,
				},
			});
			return new Response(JSON.stringify({ ok: true, result: { message_id: 99, date: 1_700_000_000, chat: { id: 7, type: "private" } } }));
		}
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ method, body });
		if (method === "sendMessage" && body.parse_mode === "HTML" && failHtmlOnce) {
			failHtmlOnce = false;
			return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag" }), {
				status: 400,
			});
		}
		if (method === "sendMessage") {
			return new Response(JSON.stringify({ ok: true, result: { message_id: 55, date: 1_700_000_000, chat: { id: 7, type: "private" }, text: body.text } }));
		}
		return new Response(JSON.stringify({ ok: true, result: true }));
	};

	const api = createTelegramApi({ token: "test-token", apiBase: "https://tg.test", fetchFn: mockFetch });
	const sent = await api.sendFormattedMessage(7, "Hello **world** https://example.com");
	assert.equal(sent.length, 1);
	// First attempt used HTML + disabled link preview; second retried plain text without parse_mode.
	assert.deepEqual(calls[0], {
		method: "sendMessage",
		body: {
			chat_id: 7,
			text: "Hello <b>world</b> https://example.com",
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
		},
	});
	assert.deepEqual(calls[1], {
		method: "sendMessage",
		body: {
			chat_id: 7,
			text: "Hello world https://example.com",
			link_preview_options: { is_disabled: true },
		},
	});

	// Reaction normalization maps ⏳ -> 👀 and undefined -> [].
	await api.setMessageReaction(7, 12, "⏳");
	await api.setMessageReaction(7, 12, undefined);
	assert.deepEqual(calls[2], {
		method: "setMessageReaction",
		body: { chat_id: 7, message_id: 12, reaction: [{ type: "emoji", emoji: "👀" }] },
	});
	assert.deepEqual(calls[3], {
		method: "setMessageReaction",
		body: { chat_id: 7, message_id: 12, reaction: [] },
	});

	// Outbound document upload formats caption as HTML.
	await api.sendDocument(7, { data: new Uint8Array([1, 2, 3]), filename: "report.pdf" }, { caption: "See **summary**" });
	assert.deepEqual(calls[4], {
		method: "sendDocument",
		body: { chat_id: "7", caption: "See <b>summary</b>", parse_mode: "HTML", hasDocument: true },
	});
});

test("startTelegram end-to-end: pairs owner, loads telegram.md formatting, delivers HTML, syncs reactions, and handles NO_REPLY + inbound reaction", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-tg-e2e-"));
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const requests: ModelContext[] = [];
		faux.setResponses([
			(request) => {
				requests.push(request);
				return fauxAssistantMessage(fauxToolCall("react", { emoji: "✅" }), { stopReason: "toolUse" });
			},
			(request) => {
				requests.push(request);
				return fauxAssistantMessage("All **done** — see [docs](https://example.com).");
			},
			(request) => {
				requests.push(request);
				return fauxAssistantMessage("NO_REPLY");
			},
		]);

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

		const updateQueue: TelegramUpdate[][] = [
			[
				{
					update_id: 1,
					message: {
						message_id: 100,
						date: 1_700_000_000,
						chat: { id: 501, type: "private" },
						from: { id: 501, first_name: "Henry" },
						text: "status check?",
					},
				},
			],
		];
		let wakePoll: (() => void) | undefined;
		const sentMessages: Record<string, unknown>[] = [];
		const reactions: Record<string, unknown>[] = [];
		const actions: Record<string, unknown>[] = [];
		const pollParams: Record<string, unknown>[] = [];
		let pairedOwner: string | undefined;

		const waitFor = (predicate: () => boolean, ms = 5_000) =>
			new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + ms;
				const tick = () => {
					if (predicate()) resolve();
					else if (Date.now() > deadline) reject(new Error("timed out waiting for Telegram condition"));
					else setTimeout(tick, 15);
				};
				tick();
			});

		const mockFetch: typeof fetch = async (input, init) => {
			const method = String(input).split("/").pop()!;
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			if (method === "getMe") {
				return new Response(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: "pclaw_test_bot" } }));
			}
			if (method === "getUpdates") {
				pollParams.push(body);
				if (updateQueue.length > 0) {
					return new Response(JSON.stringify({ ok: true, result: updateQueue.shift()! }));
				}
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
				sentMessages.push(body);
				return new Response(
					JSON.stringify({ ok: true, result: { message_id: 200 + sentMessages.length, date: 1_700_000_010, chat: { id: 501, type: "private" } } }),
				);
			}
			if (method === "setMessageReaction") {
				reactions.push(body);
				return new Response(JSON.stringify({ ok: true, result: true }));
			}
			if (method === "sendChatAction") {
				actions.push(body);
				return new Response(JSON.stringify({ ok: true, result: true }));
			}
			return new Response(JSON.stringify({ ok: true, result: true }));
		};

		const tg = await startTelegram(agent, config, BACKGROUND_CONTEXT, {
			apiBase: "https://tg.test",
			fetchFn: mockFetch,
			mediaGroupDelayMs: 25,
			pollTimeoutSeconds: 1,
			inboxDir: join(dir, "inbox"),
			voiceDir: join(dir, "voice"),
			onOwnerPaired: (id) => {
				pairedOwner = id;
			},
		});

		try {
			await waitFor(() => sentMessages.length >= 1 && reactions.length >= 1);
			assert.equal(pairedOwner, "501");
			assert.deepEqual(pollParams[0]?.allowed_updates, ["message", "message_reaction"]);
			assert.equal(sentMessages[0]?.parse_mode, "HTML");
			assert.deepEqual(sentMessages[0]?.link_preview_options, { is_disabled: true });
			assert.equal(sentMessages[0]?.text, 'All <b>done</b> — see <a href="https://example.com">docs</a>.');
			// `✅` from react tool was automatically normalized to Telegram-valid `👍`.
			assert.deepEqual(reactions[0], {
				chat_id: "501",
				message_id: 100,
				reaction: [{ type: "emoji", emoji: "👍" }],
			});
			// System prompt automatically included src/prompts/formatting/telegram.md via channelOf -> "telegram".
			assert.match(JSON.stringify(requests[0]), /Formatting for Telegram/);
			assert.ok(actions.some((a) => a.action === "typing"));

			// Send an inbound user reaction on the bot's message #201; model responds NO_REPLY so nothing extra is sent.
			updateQueue.push([
				{
					update_id: 2,
					message_reaction: {
						chat: { id: 501, type: "private" },
						message_id: 201,
						user: { id: 501, first_name: "Henry" },
						date: 1_700_000_020,
						old_reaction: [],
						new_reaction: [{ type: "emoji", emoji: "🔥" }],
					},
				},
			]);
			wakePoll?.();
			await waitFor(() => requests.length >= 3);
			assert.match(JSON.stringify(requests[2]?.messages.at(-1)), /reacted 🔥 to your message/);
			assert.equal(sentMessages.length, 1);
		} finally {
			await tg.stop();
			await agent.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("telegramTypingTargets picks active workers and jobs on telegram routes only", () => {
	assert.deepEqual(
		telegramTypingTargets(
			[
				{ address: "telegram:dm:1", workers: [{ status: "working" }] },
				{ address: "discord:dm:2", workers: [{ status: "working" }] },
			],
			[
				{ origin: "telegram:group:-100", state: "working", background: true },
				{ origin: "telegram:dm:3", state: "done" },
				{ origin: "discord:dm:4", state: "working" },
			],
		),
		["telegram:dm:1", "telegram:group:-100"],
	);
});
