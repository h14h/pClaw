import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { splitMessage } from "./channels/discord.ts";
import { replyCollector } from "./delivery.ts";
import { nextOccurrence } from "./extensions/follow-ups.ts";
import { Notes } from "./extensions/notes.ts";
import { isEmoji } from "./extensions/reactions.ts";
import { search } from "./extensions/recall.ts";
import { checkPage } from "./pages.ts";
import { findInPage, pageWindow } from "./search.ts";
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
	// NO_REPLY drops everything from the run.
	collect({ kind: "interim", text: "hm" });
	assert.equal(collect({ kind: "final", silent: true }), undefined);
	assert.equal(collect({ kind: "final", text: "fresh run", silent: false }), "fresh run");
	// A run that ends right after a tool call (delegate) sends what was written with the call.
	collect({ kind: "interim", text: "on it, back in a few" });
	assert.equal(flush(), "on it, back in a few");
	assert.equal(flush(), undefined);
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
