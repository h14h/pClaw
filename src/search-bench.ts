/**
 * Runs the same searches or page reads through every search service that has a key, and prints how each did:
 *
 *   pnpm search-bench "quietest 4-bay NAS case" "jonsbo n4 noise test"
 *   pnpm search-bench --read https://baltany.com/products/x https://example.com/review
 *
 * Full results go to ~/.pclaw/bench/<time>.json for reading side by side.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home, loadConfig } from "./config.ts";
import { readPage, search, serviceReady, type ServiceId, services } from "./search.ts";

const args = process.argv.slice(2);
const reading = args[0] === "--read";
const inputs = reading ? args.slice(1) : args;
if (inputs.length === 0) {
	console.log('Usage: pnpm search-bench "query" ...   or   pnpm search-bench --read <url> ...');
	process.exit(1);
}

const config = loadConfig();
if (config.tavilyApiKey !== undefined) process.env.TAVILY_API_KEY = config.tavilyApiKey;
if (config.parallelApiKey !== undefined) process.env.PARALLEL_API_KEY = config.parallelApiKey;
const ready = (Object.keys(services) as ServiceId[]).filter(serviceReady);
for (const id of Object.keys(services) as ServiceId[]) if (!ready.includes(id)) console.log(`(skipping ${services[id].name}: no API key)`);

type Run = { input: string; service: ServiceId; ms: number; ok: boolean; output: unknown };
const runs: Run[] = [];

for (const input of inputs) {
	console.log(`\n${input}`);
	// One service at a time, so they don't compete for the same connection.
	for (const service of ready) {
		const started = performance.now();
		let output: unknown;
		let ok = true;
		let line: string;
		try {
			if (reading) {
				const text = await readPage(input, { service });
				output = text;
				line = `${text.length.toLocaleString()} chars: ${text.slice(0, 100).replace(/\s+/g, " ")}…`;
			} else {
				const found = await search(input, { service, maxResults: 5 });
				output = found;
				const chars = found.results.reduce((sum, result) => sum + result.content.length, 0);
				line = `${found.results.length} results, ${chars.toLocaleString()} chars of excerpts${found.answer ? ", an answer" : ""}`;
				line += found.results.map((result, index) => `\n             ${index + 1}. ${result.url}`).join("");
			}
		} catch (error) {
			ok = false;
			output = error instanceof Error ? error.message : String(error);
			line = `failed: ${output}`;
		}
		const ms = performance.now() - started;
		runs.push({ input, service, ms, ok, output });
		console.log(`  ${services[service].name.padEnd(9)}${(ms / 1000).toFixed(1).padStart(5)}s  ${line}`);
	}
}

const dir = join(home, "bench");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ kind: reading ? "read" : "search", runs }, null, "\t"));
console.log(`\nFull results: ${file}`);
