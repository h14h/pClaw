import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isoDate, lintPage } from "../sites/grug-pages/lib/page-lint.mjs";
import { REMOTE_PAGES_GUIDANCE } from "./prompts.ts";

/** A page that passes every editorial lint rule; each test breaks one thing. */
const GOOD = `---
title: "Norway in a Nutshell from Oslo"
subtitle: "Take two days if you can and sleep in Flåm."
date: "2026-11-25"
summary: "Oslo to Bergen by train, fjord boat and bus. Five legs in about 12 hours."
---

import { StatGrid, Stat, Figure, Carousel, Sources, Table, Callout } from "@components/mdx";

Self-guided. Fjord Tours bundles trains, boat and bus into one ticket.

<StatGrid columns={2}>
  <Stat label="In one day" value="~12 hours" note="Oslo to Bergen, Seabound leg times" />
  <Stat label="From price" value="3,131 NOK" note="Oslo → Bergen one way, checked 26 Nov 2026" />
</StatGrid>

<Figure priority src="img/a.jpg" alt="Fjord" caption="Nærøyfjord from Bakkanosi, farms for scale." credit="Vincent / Wikimedia Commons, CC BY-SA 4.0" href="https://commons.wikimedia.org/x" />

## Route

<Table compact>

| Leg | Mode | Time | Notes |
| --- | --- | --- | --- |
| 1. Oslo → Myrdal | Bergen Railway | ~4 h 40 min | Plateau |

</Table>

<Carousel label="Leg 2 photos">
<Figure src="img/b.jpg" alt="Valley" caption="Flåmsdalen from the Flåm Railway, above the river." credit="A / Wikimedia Commons, CC BY 2.0" href="https://x/b" />
<Figure src="img/c.jpg" alt="Falls" caption="Kjosfossen, the Flåm Railway's photo stop." credit="B / Wikimedia Commons, CC BY 2.5" href="https://x/c" />
</Carousel>

<Sources checked="2026-11-26">
1. [Norway in a Nutshell®, Fjord Tours](https://www.fjordtours.com/x). Route, season, luggage.
2. [The Bergen Line, Vy](https://www.vy.no/x). 471.25 km; about 6.5 to 7.5 hours.
</Sources>
`;

const breakIt = (from: string, to: string) => {
	assert.ok(GOOD.includes(from), from);
	return lintPage(GOOD.replace(from, to));
};

test("page lint: a page that follows EDITORIAL.md passes clean", () => {
	assert.deepEqual(lintPage(GOOD), []);
	// "above" in a description ("above the river") is not a page-order reference
	assert.ok(GOOD.includes("above the river"));
});

test("page lint: frontmatter (verdict subtitle, share-card summary)", () => {
	assert.match(breakIt('subtitle: "Take two days if you can and sleep in Flåm."\n', "").join("\n"), /No subtitle/);
	const long = breakIt('summary: "Oslo to Bergen by train, fjord boat and bus. Five legs in about 12 hours."', `summary: "${"x".repeat(170)}"`);
	assert.match(long.join("\n"), /Summary is 170 characters; keep it under 160/);
	assert.match(breakIt("Five legs in about 12 hours.", "See below for the five legs.").join("\n"), /Summary says "See below"/);
	assert.match(breakIt("Five legs in about 12 hours.", "This page covers five legs.").join("\n"), /Summary says "This page"/);
});

test("page lint: lead first, no photo, stats or table above it", () => {
	const moved = GOOD.replace("Self-guided. Fjord Tours bundles trains, boat and bus into one ticket.\n\n", "").replace("## Route\n", "## Route\n\nSelf-guided. Fjord Tours bundles trains, boat and bus.\n");
	assert.match(lintPage(moved).join("\n"), /<StatGrid>, <Figure> before the lead paragraph/);
	// A Callout's own text is not the lead
	const callout = `<Callout type="warn" title="Typical fares">\nTypical ranges, not quotes.\n</Callout>\n\n`;
	const behindCallout = moved.replace('import { StatGrid, Stat, Figure, Carousel, Sources, Table, Callout } from "@components/mdx";\n\n', `import { StatGrid, Stat, Figure, Carousel, Sources, Table, Callout } from "@components/mdx";\n\n${callout}`);
	assert.match(lintPage(behindCallout).join("\n"), /<StatGrid>, <Figure> before the lead/);
});

test("page lint: captions stand alone, carousel captions under 100, credits with links", () => {
	const longCap = breakIt("Kjosfossen, the Flåm Railway's photo stop.", `Kjosfossen ${"x".repeat(100)}.`);
	assert.match(longCap.join("\n"), /Carousel caption for img\/c\.jpg is 112 characters; one sentence under 100/);
	for (const phrase of ["the boat in the next photo", "leg 3 cruises it", "slide 2 shows it", "see the map below", "photo above"]) {
		const out = breakIt("Kjosfossen, the Flåm Railway's photo stop.", `Kjosfossen, ${phrase}.`).join("\n");
		assert.match(out, /Captions show alone in the viewer/, phrase);
	}
	assert.match(breakIt(' credit="B / Wikimedia Commons, CC BY 2.5" href="https://x/c"', "").join("\n"), /img\/c\.jpg has no credit/);
	assert.match(breakIt(' href="https://x/c"', "").join("\n"), /img\/c\.jpg credit has no href/);
	// Every caption, standalone too, stays under 100
	assert.match(breakIt("Nærøyfjord from Bakkanosi, farms for scale.", `Nærøyfjord ${"x".repeat(88)}.`).join("\n"), /^Caption for img\/a\.jpg is 100 characters; one sentence under 100\.$/m);
	assert.deepEqual(breakIt("Nærøyfjord from Bakkanosi, farms for scale.", `Nærøyfjord ${"x".repeat(87)}.`), []);
	// One priority image
	assert.match(breakIt('<Figure src="img/b.jpg"', '<Figure priority src="img/b.jpg"').join("\n"), /2 Figures have priority; only the opening photo/);
});

test("page lint: stats, callouts, tables", () => {
	assert.match(breakIt(' note="Oslo to Bergen, Seabound leg times"', "").join("\n"), /Stat "In one day" has no note/);
	// A note that only re-says the value adds no scope; one with a source or basis does
	assert.match(breakIt('note="Oslo to Bergen, Seabound leg times"', 'note="about 12 hours"').join("\n"), /Stat "In one day" note "about 12 hours" repeats its value/);
	assert.match(breakIt('label="In one day" value="~12 hours" note="Oslo to Bergen, Seabound leg times"', 'label="Sunset" value="~20:00" note="Sunset about 20:00"').join("\n"), /Stat "Sunset" note "Sunset about 20:00" repeats its value/);
	assert.deepEqual(breakIt('label="In one day" value="~12 hours" note="Oslo to Bergen, Seabound leg times"', 'label="Sunset" value="~20:00" note="Sunset about 20:00 on 1 Apr, per Weather-Atlas"'), []);
	const many = GOOD.replace("</StatGrid>", `${'  <Stat label="x" value="1" note="n" />\n'.repeat(3)}</StatGrid>`);
	assert.match(lintPage(many).join("\n"), /StatGrid has 5 stats; keep 4 or fewer/);
	const callouts = GOOD.replace("## Route", `${'<Callout type="note">Caveat.</Callout>\n\n'.repeat(4)}## Route`);
	assert.match(lintPage(callouts).join("\n"), /4 Callouts; keep 3 or fewer/);
	assert.match(breakIt("| Leg | Mode | Time | Notes |", "| Leg | Mode | Typical duration | Notes |").join("\n"), /heading "Typical duration" over 14 characters/);
	assert.match(breakIt("| Leg | Mode | Time | Notes |", "| Rank | Mode | Time | Notes |").join("\n"), /starts with a rank column/);
	const plain = GOOD.replace("<Table compact>\n\n", "").replace("\n\n</Table>", "");
	assert.match(lintPage(plain).join("\n"), /Table "Leg" has 4 columns of short cells\. Wrap it in <Table compact>/);
	const prose = plain.replace("| Plateau |", `| ${"Long prose about the view ".repeat(3)}|`);
	assert.doesNotMatch(lintPage(prose).join("\n"), /Wrap it in <Table compact>/);
});

test("page lint: Sources link only the title; checked is the latest check on the page", () => {
	const swallowed = breakIt("[The Bergen Line, Vy](https://www.vy.no/x). 471.25 km; about 6.5 to 7.5 hours.", "[The Bergen Line, Vy (471.25 km; about 6.5 to 7.5 hours Oslo–Bergen, day or night train)](https://www.vy.no/x)");
	assert.match(swallowed.join("\n"), /Sources: 1 of 2 link texts run over 70 characters \(#2\)/);
	assert.match(breakIt('<Sources checked="2026-11-26">', '<Sources checked="2026-11-25">').join("\n"), /Sources checked="2026-11-25" is older than "26 Nov 2026"/);
	// A page-wide checked date that an item contradicts with its own, earlier, check
	assert.match(breakIt("Route, season, luggage.", "Route, season, luggage; bundle checked on 2 November 2026.").join("\n"), /Sources checked="2026-11-26" says every link was opened then, but the page says "checked on 2 November 2026"/);
	// Travel dates and publication dates are not check dates
	assert.deepEqual(breakIt("Route, season, luggage.", "Route, Feb 3–10, 2027 fares (Nov 13, 2026)."), []);
	assert.match(breakIt(/<Sources[\s\S]*<\/Sources>\n/.exec(GOOD)![0], "").join("\n"), /No <Sources> block/);
	assert.equal(isoDate("26 Nov 2026"), "2026-11-26");
	assert.equal(isoDate("Nov 24, 2026"), "2026-11-24");
	assert.equal(isoDate("2026-11-24"), "2026-11-24");
	assert.equal(isoDate("Smarch 3, 2026"), null);
});

test("grug-page review: fresh reviewer gets EDITORIAL.md and a read-only copy; never edits; skips on timeout", () => {
	const root = mkdtempSync(join(tmpdir(), "grug-review-test-"));
	try {
		const bin = new URL("../sites/grug-pages/bin/grug-page.mjs", import.meta.url).pathname;
		const skillsDir = new URL("../bots/grug/skills", import.meta.url).pathname;
		const pageDir = join(root, "work", "pages", "norway");
		mkdirSync(pageDir, { recursive: true });
		const page = GOOD.replace('subtitle: "Take two days if you can and sleep in Flåm."\n', "");
		writeFileSync(join(pageDir, "index.mdx"), page);
		const log = join(root, "prompt.txt");
		const fake = join(root, "fake-muse.mjs");
		writeFileSync(
			fake,
			`#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8");
writeFileSync(process.env.PROMPT_LOG, prompt + "\\nCWD=" + process.cwd() + "\\nMODEL=" + args[args.indexOf("--model") + 1]);
if (process.env.FAKE_MODE === "hang") setTimeout(() => {}, 60_000);
else {
  try { writeFileSync("page.mdx", "vandalised"); } catch {}
  console.log("MUST FIX\\n1. subtitle: missing. Fix: state the verdict.\\nNICE TO FIX\\n(none)\\nSPOT CHECKS\\n- 3,131 NOK | https://x | supported");
}
`,
		);
		chmodSync(fake, 0o755);
		const run = (env: Record<string, string>) =>
			spawnSync(process.execPath, [bin, "review", "norway"], {
				encoding: "utf8",
				env: { ...process.env, GRUG_PAGES_WORK_DIR: join(root, "work"), GRUG_MUSE_BIN: fake, GRUG_SKILLS_DIR: skillsDir, PROMPT_LOG: log, ...env },
			});

		const noBrief = run({});
		assert.match(noBrief.stderr, /WARN norway: no brief \(save it as .*\.brief\.md\); reviewing without it\./);
		assert.match(readFileSync(log, "utf8"), /--- NO BRIEF SAVED: infer what the reader asked for from the title and subtitle ---/);
		writeFileSync(join(pageDir, ".brief.md"), "Research Norway in a Nutshell from Oslo and build a page.\n");
		const ok = run({});
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /^REVIEW norway \(\d+s\)\nMUST FIX\n1\. subtitle: missing/);
		assert.match(ok.stdout, /SPOT CHECKS/);
		assert.equal(readFileSync(join(pageDir, "index.mdx"), "utf8"), page, "the page is never edited");
		const prompt = readFileSync(log, "utf8");
		assert.match(prompt, /--- BEGIN ORIGINAL BRIEF \(what the reader asked for\) ---\nResearch Norway in a Nutshell from Oslo and build a page\.\n--- END ORIGINAL BRIEF ---/);
		assert.match(prompt, /--- BEGIN EDITORIAL\.md \(the rubric\) ---\n# Grug page editorial rules/);
		// Decisions before copy: verify what the reader will act on, the current lineup, routes and thresholds
		assert.match(prompt, /1\. Decisions first\. Read the original brief\. Identify the two decisions the reader is most likely to act on\. Verify them end to end\./);
		assert.match(prompt, /open the maker's current lineup and confirm the exact generation, market, configuration, availability, and complete price/);
		assert.match(prompt, /trace each day in order, including the evening stop, and flag backtracking, transfers, and dates the plan depends on/);
		assert.match(prompt, /Recalculate every threshold or total that supports a recommendation against each applicable rate and the reader's likely use\./);
		assert.match(prompt, /Check that the subtitle, summary, and table give the same answer as the body; that each cited comparative verdict covers the models or generations the source actually tested; that deals name the qualifying configuration and deadlines a time zone and inclusive end; and that every explicit ask in the brief is met or plainly marked unmet/);
		assert.match(prompt, /Mark a material omission or contradiction MUST FIX\./);
		assert.ok(prompt.indexOf("1. Decisions first") < prompt.indexOf("3. Then the copy"));
		assert.match(prompt, /^DECISIONS$/m);
		assert.match(prompt, /Review only; do not edit, create or delete any file\./);
		assert.match(prompt, /Spot-check the riskiest remaining claims/);
		assert.match(prompt, /Never invent a fact: a fix uses facts already on the page or quoted from a source you opened \(name the URL\)\./);
		// --brief-file overrides the saved brief
		const other = join(root, "brief.txt");
		writeFileSync(other, "Compare e-ink tablets.\n");
		const flagged = spawnSync(process.execPath, [bin, "review", "--brief-file", other, "norway"], {
			encoding: "utf8",
			env: { ...process.env, GRUG_PAGES_WORK_DIR: join(root, "work"), GRUG_MUSE_BIN: fake, GRUG_SKILLS_DIR: skillsDir, PROMPT_LOG: log },
		});
		assert.equal(flagged.status, 0, flagged.stderr);
		assert.match(readFileSync(log, "utf8"), /--- BEGIN ORIGINAL BRIEF[^\n]*\nCompare e-ink tablets\./);
		// The lint's findings go along, so the reviewer spends its time on judgment
		assert.match(prompt, /Lint already flags these[^\n]*\n\s+- No subtitle\./);
		assert.match(prompt, /^MUST FIX$/m);
		assert.match(prompt, /CWD=.*grug-review-/);
		assert.doesNotMatch(prompt, /CWD=.*pages\/norway/);

		const hung = run({ FAKE_MODE: "hang", GRUG_REVIEW_TIMEOUT_MS: "300" });
		assert.equal(hung.status, 0);
		assert.match(hung.stdout, /^REVIEW SKIPPED norway: timed out after 0s\. Self-check against EDITORIAL\.md, then lint and build\./);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("grug-page skill: EDITORIAL.md is the one source of editorial rules; workflow runs review after polish", () => {
	const skill = readFileSync(new URL("../bots/grug/skills/grug-page/SKILL.md", import.meta.url), "utf8");
	const editorial = readFileSync(new URL("../bots/grug/skills/grug-page/EDITORIAL.md", import.meta.url), "utf8");
	assert.match(skill, /## Editorial rules: read EDITORIAL\.md first/);
	assert.match(skill, /~\/\.config\/muse\/skills\/grug-page\/EDITORIAL\.md/);
	const steps = ["grug-page polish <slug>", "grug-page review <slug>", "Fix every MUST FIX yourself", "grug-page lint <slug>", "grug-page build <slug>", "grug-page preview <slug> --daemon"];
	const workflow = skill.slice(skill.indexOf("## Required workflow"));
	const at = steps.map((step) => workflow.indexOf(step));
	assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!)), `workflow order: ${at.join(", ")}`);
	assert.match(skill, /never invent a fact, number, date or URL to satisfy a finding/);
	assert.match(skill, /`review`, `lint`, `unslop`/);
	// Rules moved out of SKILL.md, not copied
	assert.doesNotMatch(skill, /## Screen one|Never use a standalone `Rank`|Keep column headings short/);
	for (const heading of ["## Page anatomy, in order", "## Each block adds something new", "## Claim precision", "## Images", "## Components", "## Voice", "## Self-check before build"]) {
		assert.ok(editorial.includes(heading), heading);
	}
	assert.equal((editorial.match(/^\d+\. /gm) ?? []).length, 12, "self-check questions");
	assert.match(editorial, /## Decision structure by page type/);
	assert.match(editorial, /Put the qualifying configuration, the actionable total, and any sale expiry together/);
	assert.match(editorial, /Each day gets one default route and one default evening stop/);
	assert.match(editorial, /Opening stats: keep one only if it changes what the reader does, and only with a source or date in its note\./);
	assert.match(skill, /Save the request you were given, word for word, as `~\/work\/pages\/<slug>\/\.brief\.md`/);
	assert.match(skill, /reread the final page against `\.brief\.md`\. For each requested decision, write down the one action the reader should take and its source, and confirm the subtitle, lead, share summary \(`summary`\), decision table, and action section all give that same answer\./);
	assert.match(skill, /open the purchase or booking link and confirm the exact date with time zone, the configuration, and the cutoff/);
	assert.match(editorial, /A cited comparative verdict covers only the models or generations the source tested\./);
	assert.match(editorial, /Deadlines carry a time zone and say whether the end is inclusive/);
	assert.match(editorial, /The summary never claims a partly met ask\./);
	assert.match(editorial, /Official spellings with diacritics for places and names: Belém, São Vicente, Nærøyfjord\./);
	assert.match(skill, /At `320` wide, check the first screen and the widest table/);
	assert.match(editorial, /Fjord Tours' "From 2,698 NOK" was the cheapest of 32 routes; Oslo → Bergen one way was 3,131 NOK\./);
	// Remote workers get the same order in their prompt
	assert.match(REMOTE_PAGES_GUIDANCE, /save the request you were given, word for word, as `~\/work\/pages\/<slug>\/\.brief\.md`, then write/);
	assert.match(REMOTE_PAGES_GUIDANCE, /EDITORIAL\.md` rules -> `grug-page polish <slug>` -> `grug-page review <slug>`, then fix every MUST FIX yourself \(never inventing facts\) and reread the final page against `\.brief\.md`: for each requested decision, the subtitle, lead, share summary, decision table, and action section give the same one action, and any sale, booking, or cutoff date is confirmed at its link with time zone and configuration -> `grug-page build <slug>` \(fix its WARN lines\)/);
});
