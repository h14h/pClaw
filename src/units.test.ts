import assert from "node:assert/strict";
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
