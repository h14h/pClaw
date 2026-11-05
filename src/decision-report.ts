#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { type Answers, pick, yes } from "./decisions.ts";

/**
 * Reads decisions.jsonl and reports the measures in docs/decision-evals.md.
 *
 *   pnpm decisions               everything so far
 *   pnpm decisions --since 7     the last 7 days
 *   pnpm decisions --templates a1b2c3d4     one version of the templates
 */

export type LogEvent = {
	type: string;
	at: string;
	id?: string;
	site?: string;
	arm?: string;
	ok?: boolean;
	ms?: number;
	job?: string;
	decision?: string;
	mode?: string;
	emoji?: string;
	answers?: Answers;
	templates?: string;
	summaryState?: string;
	state?: string;
	outcome?: string;
	surface?: string;
	event?: string;
	background?: boolean;
	adopted?: boolean;
	worker?: boolean;
	posted?: boolean;
	modality?: string;
	words?: number;
	channel?: string;
};

type Arm = { turns: number; followed: number; quiet: number; notes: number; pings: number };

const GOOD = new Set(["👍", "✅", "❤️", "🙏", "🔥", "🎉", "💯"]);
const BAD = new Set(["👎", "🔕", "😴", "🤫", "😡", "❌"]);
const RESPONSE_MS = 2 * 60 * 60_000;

const percentile = (values: number[], share: number) => [...values].sort((a, b) => a - b)[Math.floor(share * (values.length - 1))] ?? 0;

/** What a hint's surface pick would look like if the front model did exactly that. */
const actualSurface = (mode: string | undefined) => (mode === undefined ? "card" : mode === "ping" || mode === "shared" ? "ping" : "note");

type Lane = { runs: number; failed: number; p50min: number; p90min: number };

function lane(durations: number[], failed: number): Lane {
	const minutes = (ms: number) => Math.round(ms / 6_000) / 10;
	return { runs: durations.length, failed, p50min: minutes(percentile(durations, 0.5)), p90min: minutes(percentile(durations, 0.9)) };
}

/** Workers against background and full jobs: how often each is used, how long a first answer takes, how often it fails. */
export function compareLanes(events: LogEvent[]): Record<"worker" | "background" | "job", Lane> {
	const workers = events.filter((event) => event.type === "worker");
	const starts = events.filter((event) => event.type === "job" && event.event === "start" && event.adopted !== true && event.worker !== true);
	const wakes = events.filter((event) => event.type === "wake");
	const jobLane = (background: boolean) => {
		const mine = starts.filter((start) => (start.background === true) === background);
		const first = mine.flatMap((start) => {
			const wake = wakes.find((each) => each.job === start.job);
			return wake === undefined ? [] : [{ ms: Date.parse(wake.at) - Date.parse(start.at), failed: wake.state === "failed" || wake.state === "blocked" }];
		});
		return lane(first.map((each) => each.ms), first.filter((each) => each.failed).length);
	};
	return {
		worker: lane(workers.flatMap((event) => (event.ms === undefined ? [] : [event.ms])), workers.filter((event) => event.ok === false).length),
		background: jobLane(true),
		job: jobLane(false),
	};
}

type Modality = { messages: number; medianWords: number; thinkingAloud: number; firmAsks: number; corrected: number };

/**
 * Text against voice. "Corrected" is the owner's next message in that place correcting pclaw, soon after: the nearest
 * thing to a measure of whether pclaw understood. See H8 for why this can only ever be suggestive.
 */
export function compareModalities(events: LogEvent[]): Record<string, Modality> {
	const answers = new Map(events.filter((event) => event.type === "decision" && event.site === "message" && event.ok === true).map((event) => [event.id, event.answers]));
	const messages = events.filter((event) => event.type === "message");
	const result: Record<string, Modality> = {};
	for (const modality of new Set(messages.map((event) => event.modality ?? "text"))) {
		const mine = messages.filter((event) => (event.modality ?? "text") === modality);
		const read = (name: string, event: LogEvent) => yes(answers.get(event.id)?.[name]);
		const corrected = mine.filter((event) => {
			const next = messages.find((other) => other.channel === event.channel && Date.parse(other.at) > Date.parse(event.at));
			return next !== undefined && Date.parse(next.at) - Date.parse(event.at) < RESPONSE_MS && read("corrects", next) >= 0.5;
		});
		result[modality] = {
			messages: mine.length,
			medianWords: percentile(mine.map((event) => event.words ?? 0), 0.5),
			thinkingAloud: mine.filter((event) => read("thinking_aloud", event) >= 0.7).length,
			firmAsks: mine.filter((event) => read("firm_ask", event) >= 0.5).length,
			corrected: corrected.length,
		};
	}
	return result;
}

export function summarize(events: LogEvent[]) {
	const decisions = events.filter((event) => event.type === "decision");
	const asked = decisions.filter((event) => event.ok === true);
	const byId = new Map(asked.map((event) => [event.id, event]));
	const deliveries = events.filter((event) => event.type === "delivery");
	const wakes = events.filter((event) => event.type === "wake");
	const reactions = events.filter((event) => event.type === "reaction");
	const messages = asked.filter((event) => event.site === "message");
	const reads = new Map(events.filter((event) => event.type === "guidance" && event.surface !== undefined).map((event) => [event.id, event]));
	const arms: Record<string, Arm> = {};
	let agree = 0;
	let compared = 0;

	for (const wake of wakes) {
		const read = reads.get(wake.decision);
		const arm = (arms[wake.arm ?? "none"] ??= { turns: 0, followed: 0, quiet: 0, notes: 0, pings: 0 });
		const mode = deliveries.find((delivery) => delivery.decision === wake.decision && delivery.decision !== undefined)?.mode;
		const actual = actualSurface(mode);
		arm.turns++;
		if (actual === "card") arm.quiet++;
		else if (actual === "note") arm.notes++;
		else arm.pings++;
		if (read?.surface === actual) arm.followed++;
	}

	for (const guidance of events.filter((event) => event.type === "guidance" && event.summaryState !== undefined)) {
		const { outcome } = guidance;
		if (outcome === undefined) continue;
		compared++;
		const same: Record<string, string> = { finished: "done", needs_owner: "needs_you", blocked: "blocked", procedural: "idle", still_going: "idle" };
		if (same[outcome] === guidance.summaryState) agree++;
	}

	const pings = deliveries.filter((delivery) => delivery.mode === "ping");
	const answered = pings.filter((ping) => {
		const sent = Date.parse(ping.at);
		const replied = messages.some((message) => message.job === ping.job && Date.parse(message.at) > sent && Date.parse(message.at) - sent < RESPONSE_MS);
		const liked = reactions.some((reaction) => reaction.decision === ping.decision && GOOD.has(reaction.emoji ?? ""));
		return replied || liked;
	});

	return {
		wakes: wakes.length,
		jobs: new Set(wakes.map((wake) => wake.job)).size,
		pings: pings.length,
		pingsPerWake: wakes.length === 0 ? 0 : pings.length / wakes.length,
		pingsAnswered: answered.length,
		arms,
		statusAsks: messages.filter((event) => yes(event.answers?.asks_status) >= 0.5).length,
		tooLoud: messages.filter((event) => pick(event.answers?.noise_feedback).choice === "too_loud" && pick(event.answers?.noise_feedback).p >= 0.5).length,
		tooQuiet: messages.filter((event) => pick(event.answers?.noise_feedback).choice === "too_quiet" && pick(event.answers?.noise_feedback).p >= 0.5).length,
		positiveReactions: reactions.filter((reaction) => GOOD.has(reaction.emoji ?? "")).length,
		negativeReactions: reactions.filter((reaction) => BAD.has(reaction.emoji ?? "")).length,
		decisions: decisions.length,
		failed: decisions.length - asked.length,
		p50ms: percentile(asked.map((event) => event.ms ?? 0), 0.5),
		p95ms: percentile(asked.map((event) => event.ms ?? 0), 0.95),
		outcomeAgreement: compared === 0 ? undefined : { agree, compared },
		templates: [...new Set(decisions.map((event) => event.templates))],
		lanes: compareLanes(events),
		modalities: compareModalities(events),
		updates: { checked: events.filter((event) => event.type === "progress").length, posted: events.filter((event) => event.type === "progress" && event.posted === true).length },
	};
}

function print(report: ReturnType<typeof summarize>): void {
	const share = (part: number, whole: number) => (whole === 0 ? "n/a" : `${part}/${whole} (${Math.round((part / whole) * 100)}%)`);
	console.log(`Decisions: ${report.decisions}, failed ${report.failed}, p50 ${report.p50ms}ms, p95 ${report.p95ms}ms, templates ${report.templates.join(", ") || "none"}`);
	console.log(`\nInterruptions (H1): ${report.pings} pings over ${report.wakes} turns in ${report.jobs} jobs = ${report.pingsPerWake.toFixed(2)} per turn`);
	console.log(`Ping value (H2): answered or liked within 2h ${share(report.pingsAnswered, report.pings)}, reactions +${report.positiveReactions} -${report.negativeReactions}`);
	console.log(`Felt noise (H3): status checks ${report.statusAsks}, "too loud" ${report.tooLoud}, "too quiet" ${report.tooQuiet}`);
	console.log(`Progress updates (H7): posted ${share(report.updates.posted, report.updates.checked)} of new activity`);
	console.log("\nDoes a hint change anything? (H4)");
	for (const [name, arm] of Object.entries(report.arms)) {
		console.log(`  ${name}: ${arm.turns} turns, quiet ${share(arm.quiet, arm.turns)}, note ${share(arm.notes, arm.turns)}, ping ${share(arm.pings, arm.turns)}, matched d1's pick ${share(arm.followed, arm.turns)}`);
	}
	const agreement = report.outcomeAgreement;
	console.log(`\nd1 vs the front model on the job's state (H5): ${agreement === undefined ? "n/a" : share(agreement.agree, agreement.compared)}`);
	console.log("\nText vs voice (H8)");
	for (const [name, each] of Object.entries(report.modalities)) {
		console.log(`  ${name}: ${each.messages} messages, median ${each.medianWords} words, thinking aloud ${share(each.thinkingAloud, each.messages)}, firm asks ${share(each.firmAsks, each.messages)}, then corrected ${share(each.corrected, each.messages)}`);
	}
	console.log("\nWorkers vs T3 (H6): runs, failures, minutes to a first answer");
	for (const [name, each] of Object.entries(report.lanes)) console.log(`  ${name}: ${each.runs} runs, ${each.failed} failed, median ${each.p50min}, p90 ${each.p90min}`);
}

function option(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at === -1 ? undefined : process.argv[at + 1];
}

if (process.argv[1]?.endsWith("decision-report.ts")) {
	if (!existsSync(paths.decisions)) {
		console.log(`Nothing logged yet at ${paths.decisions}.`);
		process.exit(0);
	}
	const since = option("--since");
	const templates = option("--templates");
	const after = since === undefined ? 0 : Date.now() - Number(since) * 24 * 60 * 60_000;
	const events = readFileSync(paths.decisions, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as LogEvent)
		.filter((event) => Date.parse(event.at) >= after && (templates === undefined || event.type !== "decision" || event.templates === templates));
	print(summarize(events));
}
