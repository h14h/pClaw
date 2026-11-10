#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the background notes pass (src/prompts/memory.md, through `reviewNotes`) on synthetic stretches of conversation
 * from evals/memory-cases.json and checks what it would add and remove. Nothing is written to real notes.
 *
 *   pnpm evals:memory muse-spark-1.3              every case, three times
 *   pnpm evals:memory muse-spark-1.3 --runs 5 --only router-password,server-setup
 *
 * Results go to ~/.pclaw/evals/memory-runs/<profile>/.
 */

type Expect = { addMatch?: string[]; addAvoid?: string[]; removeMatch?: string[]; maxAdds?: number };
type Case = { id: string; tags: string[]; notes?: string; lines: string[]; expect: Expect };
type Run = { id: string; run: number; ok: boolean; failures: string[]; add: string[]; remove: string[] };

const home = join(homedir(), ".pclaw");
const repo = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const name = args[0];
if (name === undefined || name.startsWith("--")) {
	console.error("usage: pnpm evals:memory <profile> [--runs N] [--only a,b]");
	process.exit(1);
}
const runs = Number(option("--runs") ?? 3);
const only = option("--only")?.split(",");

// config.ts reads these on import, so they're set first: nothing here touches the live pclaw's data.
const scratch = mkdtempSync(join(tmpdir(), "pclaw-memory-evals-"));
process.env.PCLAW_HOME = scratch;
process.env.PCLAW_PROFILE = name;

const { createModels } = await import("@earendil-works/pi-ai/models");
const { metaProvider } = await import("@earendil-works/pi-ai/providers/meta");
const { loadConfig } = await import("./config.ts");
const { FileCredentialStore } = await import("./credentials.ts");
const { reviewNotes } = await import("./extensions/memory.ts");
const { listProfiles, loadProfile, registerProfiles } = await import("./profiles.ts");
const { useProfile } = await import("./prompts.ts");

const config = loadConfig();
useProfile(loadProfile(name).dir);
const models = createModels({ credentials: new FileCredentialStore(config.authFile) });
models.setProvider(metaProvider());
await registerProfiles(models, listProfiles().map((each) => loadProfile(each)));

function grade(expect: Expect, add: string[], remove: string[]): string[] {
	const failures: string[] = [];
	const added = add.join("\n");
	const removed = remove.join("\n");
	for (const pattern of expect.addMatch ?? []) if (!new RegExp(pattern, "i").test(added)) failures.push(`should add a note matching ${pattern}`);
	for (const pattern of expect.addAvoid ?? []) if (new RegExp(pattern, "i").test(added)) failures.push(`added a note matching ${pattern}`);
	for (const pattern of expect.removeMatch ?? []) if (!new RegExp(pattern, "i").test(removed)) failures.push(`should remove a note matching ${pattern}`);
	if (expect.maxAdds !== undefined && add.length > expect.maxAdds) failures.push(`added ${add.length} notes, at most ${expect.maxAdds} expected`);
	return failures;
}

const startingNotes = readFileSync(join(repo, "evals/notes.md"), "utf8");
const cases = (JSON.parse(readFileSync(join(repo, "evals/memory-cases.json"), "utf8")) as Case[]).filter(
	(each) => only === undefined || only.includes(each.id),
);
const results: Run[] = [];
for (let run = 0; run < runs; run++) {
	for (const each of cases) {
		let add: string[] = [];
		let remove: string[] = [];
		let failures: string[];
		try {
			({ add, remove } = await reviewNotes(models, config, each.notes ?? startingNotes, each.lines, AbortSignal.timeout(120_000)));
			failures = grade(each.expect, add, remove);
		} catch (error) {
			failures = [`error: ${String(error).slice(0, 160)}`];
		}
		results.push({ id: each.id, run, ok: failures.length === 0, failures, add, remove });
		console.log(`${failures.length === 0 ? "pass" : "FAIL"} ${each.id} r${run}${failures.length === 0 ? "" : ` | ${failures.join("; ")}`}`);
		for (const note of add) console.log(`    + ${note}`);
		for (const note of remove) console.log(`    - ${note}`);
	}
}

const passed = results.filter((each) => each.ok).length;
const summary = { profile: name, model: config.model, passed, total: results.length };
const dir = join(home, "evals", "memory-runs", name);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`);
writeFileSync(file, `${JSON.stringify({ summary, results }, null, "\t")}\n`, { mode: 0o600 });
console.log(`\n${name}: ${passed}/${results.length} passed\n${file}`);
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
