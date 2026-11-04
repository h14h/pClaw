/**
 * A loop for tuning how the front model writes. Replays real moments from a conversation against prompt variants, checks
 * each reply the way Discord would show it, and has a second model judge how it reads:
 *
 *   pnpm prose-lab extract 1384 936 727 ...        save those turns (by entry id) as scenarios
 *   pnpm prose-lab run none live my-try --runs 3   reply to every scenario with each variant
 *
 * A variant is a folder in ~/.pclaw/prose-lab/variants/ with front.md (the prose prompt, same everywhere) and
 * <platform>.md (the app's rules, appended after it). `live` is what pclaw uses now; `none` sends no system prompt.
 * Scenarios come from your own conversations, so everything lives under ~/.pclaw/prose-lab, out of the repo.
 * `pnpm prose-lab serve` does the same from a web page.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	config,
	extract,
	LAB,
	plainEarlier,
	plainReport,
	type Result,
	replyAll,
	type Scenario,
	type Score,
	scenarios as allScenarios,
	score,
	variantPrompt,
} from "./engine.ts";

function option(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
}

async function run(args: string[]) {
	const runs = Number(option(args, "--runs") ?? 1);
	const only = option(args, "--only")?.split(",");
	const platform = option(args, "--platform") ?? "discord";
	const judging = !args.includes("--no-judge");
	const history = option(args, "--history") ?? "raw";
	const reports = option(args, "--reports") ?? "raw";
	const thinking = (option(args, "--thinking") ?? config.thinkingLevel) as ModelThinkingLevel;
	const variants = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
	const scenarios = allScenarios()
		.filter((scenario) => only === undefined || only.some((part) => scenario.name.includes(part)))
		.map((scenario) => (history === "plain" ? { ...scenario, messages: scenario.messages.map(plainEarlier) } : scenario))
		.map((scenario) => (reports === "plain" ? { ...scenario, messages: scenario.messages.map(plainReport) } : scenario));
	if (variants.length === 0 || scenarios.length === 0) throw new Error("Name at least one variant, and extract some scenarios first.");
	const prompts = Object.fromEntries(variants.map((variant) => [variant, variantPrompt(variant, platform)]));
	const total = variants.length * scenarios.length * runs;
	console.log(`${total} replies from ${config.model}, ${platform}, ${history} history, ${reports} reports, ${thinking} thinking${judging ? ", judged" : ""}`);

	let done = 0;
	const results = await replyAll({ prompts, scenarios, runs, platform, judging, thinking, onResult: () => process.stdout.write(`\r${++done}/${total}`) });
	process.stdout.write("\n");

	const dir = join(LAB, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "results.json"), JSON.stringify({ platform, model: config.model, variants, results }, null, "\t"));
	writeFileSync(join(dir, "replies.md"), sideBySide(scenarios, variants, results));
	for (const variant of variants) writeFileSync(join(dir, `${variant}.system.md`), prompts[variant] ?? "(none)");
	console.log(table(score(variants, results)));
	console.log(`Replies side by side: ${join(dir, "replies.md")}`);
}

function table(scores: Score[]): string {
	const mean = (value: number | undefined) => (value === undefined ? "-" : value.toFixed(1));
	const rows = scores.map((each) => [
		each.variant,
		`${each.clean}/${each.replied}`,
		String(each.medianChars),
		String(each.medianWords),
		mean(each.natural),
		mean(each.economy),
		mean(each.substance),
		Object.entries(each.failed).map(([rule, count]) => `${rule} ${count}`).join(", ") + (each.errors > 0 ? ` errors ${each.errors}` : ""),
	]);
	const header = ["variant", "clean", "chars", "words", "natural", "economy", "substance", "failed checks"];
	const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
	return [header, ...rows].map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ")).join("\n");
}

function sideBySide(scenarios: Scenario[], variants: string[], results: Result[]): string {
	const parts: string[] = [];
	for (const scenario of scenarios) {
		parts.push(`# ${scenario.name}\n\n> ${scenario.ask.replace(/\n/g, "\n> ")}\n`);
		if (scenario.live !== undefined) parts.push(`## what pclaw actually sent (${scenario.live.length} chars)\n\n${scenario.live}\n`);
		for (const variant of variants) {
			for (const result of results.filter((each) => each.scenario === scenario.name && each.variant === variant)) {
				const meta = [
					result.reply === undefined ? "no reply" : `${result.reply.length} chars`,
					result.tools.length > 0 ? `tools: ${result.tools.join(", ")}` : "",
					result.checks.map((check) => `✗ ${check.rule}`).join(" "),
					result.judge === undefined ? "" : `judge ${result.judge.natural}/${result.judge.economy}/${result.judge.substance}: ${result.judge.note}`,
					result.error ?? "",
				].filter(Boolean);
				parts.push(`## ${variant} #${result.run + 1}\n\n_${meta.join(" · ")}_\n\n${result.reply ?? ""}\n`);
			}
		}
	}
	return parts.join("\n");
}

const [command, ...rest] = process.argv.slice(2);
if (command === "extract") {
	const { saved, missing } = extract(rest.map(Number));
	for (const scenario of saved) console.log(`${scenario.name}: ${scenario.messages.length} messages, live reply ${scenario.live?.length ?? 0} chars`);
	for (const id of missing) console.log(`${id}: no user message there`);
} else if (command === "run") await run(rest);
else if (command === "serve") await import("./server.ts");
else {
	console.log("Usage: pnpm prose-lab extract <entry id>...   or   pnpm prose-lab run <variant>... [--runs N] [--only a,b] [--platform discord] [--no-judge]   or   pnpm prose-lab serve");
	process.exit(1);
}
