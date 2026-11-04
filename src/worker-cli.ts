#!/usr/bin/env node
/**
 * pclaw's worker tools as a command, for harnesses that take no extension (Muse Code, and later Claude Code or Codex).
 * The same search, page reader, and page publisher pi workers get from worker-tools.ts:
 *
 *   node src/worker-cli.ts search "<query>" [--max 5]
 *   node src/worker-cli.ts read <url> [--find "a few words"] [--offset 8000]
 *   node src/worker-cli.ts publish <slug>      (a page under ./pages/<slug>/; see the web-page skill)
 *
 * Keys and choices come from the environment pclaw starts the worker with.
 */
import { publishPage } from "./pages.ts";
import { chosenService, findInPage, formatSearch, pageWindow, readPage, search } from "./search.ts";

function option(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
}

const [command, target, ...rest] = process.argv.slice(2);

const started = performance.now();
/** Which service answered and how fast, on the last line, so the worker's transcript records it. */
const via = (service: string) => `\n(via ${service}, ${((performance.now() - started) / 1000).toFixed(1)}s)`;

async function main(): Promise<string> {
	if (command === "search" && target !== undefined) {
		const maxResults = Math.min(Math.max(Math.round(Number(option(rest, "--max") ?? 5)), 1), 10);
		const service = chosenService("search");
		return formatSearch(target, await search(target, { maxResults, service })) + via(service);
	}
	if (command === "read" && target !== undefined) {
		const service = chosenService("pages");
		const content = await readPage(target, { service });
		const find = option(rest, "--find");
		return (find === undefined ? pageWindow(content, Number(option(rest, "--offset") ?? 0)) : findInPage(content, find)) + via(service);
	}
	if (command === "publish" && target !== undefined) {
		const url = await publishPage(process.cwd(), target, {
			...(process.env.PCLAW_PAGES_URL ? { pagesUrl: process.env.PCLAW_PAGES_URL } : {}),
			...(process.env.PCLAW_PAGE_PUBLISHER ? { publisher: process.env.PCLAW_PAGE_PUBLISHER } : {}),
		});
		return `Published: ${url}`;
	}
	throw new Error('usage: worker-cli.ts search "<query>" [--max N] | read <url> [--find words] [--offset N] | publish <slug>');
}

main().then(
	(text) => console.log(text),
	(error: unknown) => {
		const use = command === "read" ? "pages" : "search";
		console.error((error instanceof Error ? error.message : String(error)) + (command === "publish" ? "" : via(chosenService(use))));
		process.exit(1);
	},
);
