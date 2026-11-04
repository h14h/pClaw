#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { type Answers, readTurn, TURN_TAIL, turnQuestions } from "./decisions.ts";

/**
 * Replays labeled turns through the decision model, to check a change to the questions or the model before living with
 * it. Cases hold real conversations, so they stay outside the repo, in ~/.pclaw/evals.
 *
 *   pnpm decisions:replay ~/.pclaw/evals/nov-2.json
 *
 * A case: { "id": "...", "state": { "last_message": "...", "owner_driving_directly": true, "repeat": false },
 *           "expected": { "outcome": "needs_owner", "surface": "card" } }
 */

export type Case = { id: string; state: { last_message: string; owner_driving_directly?: boolean; repeat?: boolean }; expected: { outcome?: string; surface?: string } };
type Result = { id: string; expected: Case["expected"]; got: { outcome: string; surface: string } };

const file = process.argv[2];
if (file === undefined) throw new Error("usage: decision-replay.ts <cases.json> [--url <decision server>]");
const at = process.argv.indexOf("--url");
const url = (at === -1 ? loadConfig().decisionUrl : process.argv[at + 1])?.replace(/\/$/, "");
if (url === undefined) throw new Error("No decisionUrl configured.");

const cases = JSON.parse(readFileSync(file, "utf8")) as Case[];
const results: Result[] = [];
for (const each of cases) {
	const response = await fetch(`${url}/v1/decisions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: JSON.stringify({ last_message: each.state.last_message.slice(-TURN_TAIL) }), questions: turnQuestions }) });
	const { answers } = (await response.json()) as { answers: Answers };
	results.push({ id: each.id, expected: each.expected, got: readTurn(answers, { ownerDriving: each.state.owner_driving_directly === true, repeat: each.state.repeat === true }) });
}

const score = (name: string, matches: (result: Result) => boolean | undefined) => {
	const judged = results.map(matches).filter((value) => value !== undefined);
	const right = judged.filter(Boolean).length;
	console.log(`${name}: ${right}/${judged.length}${judged.length === 0 ? "" : ` (${Math.round((right / judged.length) * 100)}%)`}`);
};
score("outcome", (result) => (result.expected.outcome === undefined ? undefined : result.got.outcome === result.expected.outcome));
score("surface", (result) => (result.expected.surface === undefined ? undefined : result.got.surface === result.expected.surface));

const wanted = results.filter((result) => result.expected.surface === "ping");
const pinged = results.filter((result) => result.got.surface === "ping");
const hits = pinged.filter((result) => result.expected.surface === "ping").length;
console.log(`pings: precision ${hits}/${pinged.length}, recall ${hits}/${wanted.length}`);
for (const result of results) {
	const wrong = result.got.surface !== result.expected.surface || result.got.outcome !== result.expected.outcome;
	if (wrong) console.log(`  ${result.id}: wanted ${result.expected.outcome}/${result.expected.surface}, got ${result.got.outcome}/${result.got.surface}`);
}
writeFileSync(`${file}.results.json`, `${JSON.stringify(results, null, "\t")}\n`);
