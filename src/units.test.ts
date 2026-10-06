import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { splitMessage } from "./channels/discord.ts";
import { readAssistantReply, replyCollector } from "./delivery.ts";
import { nextOccurrence } from "./extensions/follow-ups.ts";
import { Notes } from "./extensions/notes.ts";
import { isEmoji } from "./extensions/reactions.ts";
import { search } from "./extensions/recall.ts";
import { checkPage } from "./pages.ts";
import { discordChecks } from "./prose-lab/checks.ts";
import { findInPage, pageWindow, readPage, search as webSearch } from "./search.ts";
import { stamp, utcOffset } from "./time.ts";

test("stamp gives weekday, local time, zone, and offset", () => {
	const at = Date.parse("2026-10-02T16:41:00Z");
	assert.equal(stamp(at, "America/Los_Angeles"), "Fri 2026-10-02 09:41 (America/Los_Angeles, UTC-07:00)");
	assert.equal(utcOffset(at, "UTC"), "UTC+00:00");
});

test("daily follow-ups keep their wall-clock time across a DST change", () => {
	// 9:00 on Sat Oct 31 2026 in Los Angeles is PDT; DST ends Nov 1, so the next 9:00 is PST.
	const due = Date.parse("2026-10-31T09:00:00-07:00");
	const next = nextOccurrence(due, "daily", "America/Los_Angeles");
	assert.equal(new Date(next).toISOString(), "2026-11-01T17:00:00.000Z");
	assert.equal(nextOccurrence(due, "weekly", "UTC") - due, 7 * 24 * 60 * 60 * 1000);
});

test("splitMessage keeps chunks under the limit and prefers paragraph breaks", () => {
	const text = `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`;
	const chunks = splitMessage(text);
	assert.deepEqual(chunks, ["a".repeat(1500), "b".repeat(1500)]);
	assert.ok(splitMessage("x".repeat(4500)).every((chunk) => chunk.length <= 2000));
	assert.deepEqual(splitMessage("short"), ["short"]);
});

test("notes add and forget lines", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-notes-"));
	try {
		const notes = new Notes(join(dir, "notes.md"));
		notes.add("Likes oat milk");
		notes.add("Partner is Sam\nmet in 2019");
		assert.equal(notes.read(), "- Likes oat milk\n- Partner is Sam met in 2019\n");
		assert.deepEqual(notes.remove("oat"), ["- Likes oat milk"]);
		assert.equal(notes.read(), "- Partner is Sam met in 2019\n");
		assert.deepEqual(notes.remove(""), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("one run becomes one message: the answer wins over text said around tool calls", () => {
	const { take: collect, flush } = replyCollector();
	assert.equal(collect({ kind: "interim", text: "I'll check." }), undefined);
	assert.equal(collect({ kind: "final", text: "checking now.", silent: false }), "checking now.");
	// With no answer, the interim text goes out instead of nothing.
	collect({ kind: "interim", text: "saved that." });
	assert.equal(collect({ kind: "final", silent: false }), "saved that.");
	// NO_REPLY suppresses short chatter, including on follow-ups and worker reports.
	collect({ kind: "interim", text: "hm" });
	assert.equal(collect({ kind: "final", silent: true }), undefined);
	assert.equal(collect({ kind: "final", text: "fresh run", silent: false }), "fresh run");
	// A run that ends right after a tool call (delegate) sends what was written with the call.
	collect({ kind: "interim", text: "on it, back in a few" });
	assert.equal(flush(), "on it, back in a few");
	assert.equal(flush(), undefined);
});

test("a substantive answer alongside tools survives a short final or NO_REPLY", () => {
	const answer = "The walnut N4 is $135 for the case alone. It fits six drives, but you still need the motherboard, power supply, and disks. I'd price the whole build before buying it.";
	for (const final of [undefined, "done, notes updated", "NO_REPLY"]) {
		const collector = replyCollector();
		collector.take({ kind: "interim", text: "I'll check." });
		collector.take({ kind: "interim", text: answer });
		collector.take({ kind: "interim", text: "saving that" });
		assert.equal(
			collector.take({ kind: "final", ...(final === undefined || final === "NO_REPLY" ? {} : { text: final }), silent: final === "NO_REPLY" }),
			final === "done, notes updated" ? `${answer}\n\n${final}` : answer,
		);
		assert.equal(collector.flush(), undefined);
		assert.equal(collector.take({ kind: "final", silent: true }), undefined);
	}
	const collector = replyCollector();
	collector.take({ kind: "interim", text: answer });
	assert.equal(collector.take({ kind: "final", text: answer.slice(0, 42), silent: false }), answer);
	collector.take({ kind: "interim", text: answer });
	const final = "The N4 fits six drives. The $135 buys the case only, so budget separately for the board, PSU, and disks.";
	assert.equal(collector.take({ kind: "final", text: final, silent: false }), final);
});

test("recall ranks messages by matching terms, then recency", () => {
	const messages = [
		{ who: "them" as const, at: 1, text: "I want a quiet case for a home NAS, 4-6 drives" },
		{ who: "pclaw" as const, at: 2, text: "Jonsbo N3 is the quiet NAS case pick, walnut is the N4" },
		{ who: "them" as const, at: 3, text: "my ankle hurts after sitting" },
	];
	const hits = search(messages, "walnut NAS case");
	assert.deepEqual(
		hits.map((hit) => hit.at),
		[2, 1],
	);
	assert.deepEqual(search(messages, "the and of"), []);
});

test("reply text drops consecutive identical parts but keeps distinct parts and later repeats", () => {
	assert.deepEqual(readAssistantReply(fauxAssistantMessage([fauxText("yeah, fair."), fauxText("yeah, fair.")])), {
		kind: "final", text: "yeah, fair.", silent: false,
	});
	assert.deepEqual(readAssistantReply(fauxAssistantMessage([fauxText("one"), fauxText("two"), fauxText("one")])), {
		kind: "final", text: "onetwoone", silent: false,
	});
	assert.deepEqual(readAssistantReply(fauxAssistantMessage([fauxText("answer"), fauxText("answer")], { stopReason: "toolUse" })), {
		kind: "interim", text: "answer",
	});
	assert.deepEqual(readAssistantReply(fauxAssistantMessage("NO_REPLY")), { kind: "final", silent: true });
});

test("isEmoji accepts single emoji, including joined and flagged ones, and nothing else", () => {
	for (const emoji of ["✅", "🖥️", "👍🏽", "❤️", "👨‍👩‍👧", "🇺🇸", "⚠️"]) assert.ok(isEmoji(emoji), emoji);
	for (const text of [":tada:", "done", "✅ done", ""]) assert.ok(!isEmoji(text), text);
});

test("read_page pages through long text and finds passages by keyword", () => {
	const page = Array.from({ length: 400 }, (_, i) => (i === 300 ? "The Node 304 ships with three Silent Series R2 fans." : `Filler paragraph ${i} about cases.`)).join("\n\n");
	const first = pageWindow(page);
	assert.ok(first.length < 8_200);
	assert.match(first, /\[characters 0–8000 of \d+\. Next: offset=8000/);
	assert.match(pageWindow(page, 8_000), /^.*Filler paragraph/s);
	const found = findInPage(page, "Silent Series fans");
	assert.match(found, /^\d+ of \d+ matching passages, best first:/);
	assert.match(found.split("---")[0]!, /three Silent Series R2 fans/);
	assert.match(findInPage(page, "zeppelin"), /Nothing on the page mentions zeppelin/);
	assert.equal(pageWindow("short page"), "short page");
});

test("checkPage refuses pages that load from outside, and allows links out", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-page-"));
	try {
		const head = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>T</title><link rel="stylesheet" href="style.css"></head>';
		writeFileSync(join(dir, "style.css"), "");
		const page = (html: string) => writeFileSync(join(dir, "index.html"), head + html);
		page('<p>Fetch your gear. <a href="https://example.com">source</a></p>');
		assert.deepEqual(checkPage(dir), []);
		writeFileSync(join(dir, "index.html"), '<main class="page"><h1>No head</h1></main>');
		assert.match(checkPage(dir).join(), /doctype.*viewport.*title.*style\.css/s);
		page('<script src="https://cdn.example.com/x.js"></script>');
		assert.match(checkPage(dir).join(), /loads from outside the page/);
		page("<script>fetch('/api')</script>");
		assert.match(checkPage(dir).join(), /uses the network/);
		page("<style>@import url(https://fonts.example.com/a.css);</style>");
		assert.match(checkPage(dir).join(), /loads from outside the page/);
		assert.match(checkPage(join(dir, "missing")).join(), /no index.html/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Parallel: search sends the query as objective and keywords, and page reads use full content", async (t) => {
	process.env.PARALLEL_API_KEY = "k";
	const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
	const replies = [
		{ results: [{ url: "https://a.example", title: "A", publish_date: "2026-09-01", excerpts: ["one", "two"] }] },
		{ results: [{ url: "https://a.example", full_content: "  the page  ", excerpts: [] }], errors: [] },
		{ results: [], errors: [{ url: "https://b.example", error_type: "fetch_failed", http_status_code: 403 }] },
	];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
		return new Response(JSON.stringify(replies.shift()));
	});
	const found = await webSearch("quiet nas case", { service: "parallel", maxResults: 3 });
	assert.deepEqual(found, { results: [{ title: "A (2026-09-01)", url: "https://a.example", content: "one\n\ntwo" }] });
	assert.equal(sent[0]?.url, "https://api.parallel.ai/v1/search");
	assert.equal(sent[0]?.headers["x-api-key"], "k");
	assert.deepEqual([sent[0]?.body.objective, sent[0]?.body.search_queries], ["quiet nas case", ["quiet nas case"]]);
	assert.equal(await readPage("https://a.example", { service: "parallel" }), "the page");
	await assert.rejects(readPage("https://b.example", { service: "parallel" }), /Couldn't read https:\/\/b.example: fetch_failed, HTTP 403/);
});

test("prose lab: Discord checks allow emphasis but catch bold sections, tables, headings, long messages, and unwrapped links", () => {
	const rules = (text: string) => discordChecks(text).map((check) => check.rule);
	assert.deepEqual(rules("walnut case. the $135 is just the case, though."), []);
	assert.deepEqual(rules("| a | b |\n|---|---|\n| 1 | 2 |"), ["table"]);
	assert.deepEqual(rules("### what they say\nstuff\n---\nmore"), ["heading", "rule"]);
	assert.deepEqual(rules("**one** **two** **three**"), []);
	assert.deepEqual(rules("**one** **two** **three** **four** **five** **six**"), []);
	assert.deepEqual(rules("**one** **two** **three** **four** **five** **six** **seven**"), ["bold"]);
	assert.deepEqual(rules("**The options**\nTake the walnut case."), ["bold"]);
	assert.deepEqual(rules("**Price:** $135 for the case."), ["bold"]);
	assert.deepEqual(rules("The **walnut case** is **$135**, before parts."), []);
	assert.deepEqual(rules("The *walnut case* is _quiet_."), []);
	assert.deepEqual(rules("x".repeat(2001)), ["length"]);
	assert.deepEqual(rules("<https://a.example> and <https://b.example>"), []);
	assert.deepEqual(rules("https://a.example and [b](https://b.example)"), ["links"]);
	assert.deepEqual(rules("just one https://a.example"), []);
});
