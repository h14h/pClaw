/**
 * Web pages workers build (src/skills/web-page). A page is a folder under <work>/pages/<slug>/; publishing checks it
 * and marks it with a `.published` file, and pclaw serves published pages at /pages/<slug>/ on the dashboard's address.
 * Getting a page anywhere else (a subdomain, a public host) is a publisher: an external command set in config,
 * called as `<command> <slug> <dir>`, which prints the page's URL.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const PUBLISHED = ".published";
const MAX_BYTES = 10 * 1024 * 1024;

/** Markup and CSS that would load something from outside the page. Plain links out (<a href>) are fine. */
const EXTERNAL_MARKUP = [
	/<(script|link|img|iframe|source|video|audio|embed|object|track)\b[^>]*\b(src|href|srcset|data)\s*=\s*["']?\s*(https?:)?\/\//gi,
	/url\(\s*["']?\s*(https?:)?\/\//gi,
	/@import\s+(url\()?\s*["']?\s*(https?:)?\/\//gi,
];
/** Script that would talk to the network. Checked only in scripts, so prose like "fetch your gear" is fine. */
const NETWORK_SCRIPT = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(?/g;

const scriptsIn = (html: string) => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? "").join("\n");

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
	);
}

/** Problems that keep a page from being published; empty when it's fine. */
/** What every page keeps from the template's <head>, so it's styled and readable on a phone. */
const REQUIRED_HEAD: [RegExp, string][] = [
	[/^\s*<!doctype html>/i, "it doesn't start with <!doctype html>"],
	[/<meta[^>]+name=["']viewport["']/i, "it's missing the viewport <meta> (the page won't fit a phone)"],
	[/<title>[^<]+<\/title>/i, "it has no <title>"],
	[/<link[^>]+rel=["']stylesheet["'][^>]*href=["']style\.css["']|<link[^>]+href=["']style\.css["'][^>]*rel=["']stylesheet["']/i, 'it doesn\'t link style.css (<link rel="stylesheet" href="style.css">)'],
];

export function checkPage(dir: string): string[] {
	if (!existsSync(join(dir, "index.html"))) return [`${dir} has no index.html.`];
	const problems: string[] = [];
	const index = readFileSync(join(dir, "index.html"), "utf8");
	for (const [pattern, problem] of REQUIRED_HEAD) {
		if (!pattern.test(index)) problems.push(`index.html: ${problem}. Keep the template's <head> and change only the <title>.`);
	}
	if (!existsSync(join(dir, "style.css"))) problems.push("style.css is missing; copy the whole template folder.");
	let bytes = 0;
	for (const file of files(dir)) {
		bytes += statSync(file).size;
		if (![".html", ".css", ".js", ".svg"].includes(extname(file))) continue;
		const text = readFileSync(file, "utf8");
		const name = file.slice(dir.length + 1);
		for (const pattern of EXTERNAL_MARKUP) {
			const match = text.match(pattern);
			if (match) problems.push(`${name} loads from outside the page: ${match[0].slice(0, 80)}`);
		}
		const script = extname(file) === ".js" ? text : extname(file) === ".html" ? scriptsIn(text) : "";
		const network = script.match(NETWORK_SCRIPT);
		if (network) problems.push(`${name} has script that uses the network: ${network[0]}`);
	}
	if (bytes > MAX_BYTES) problems.push(`The page is ${Math.round(bytes / 1024 / 1024)} MB; keep it under 10 MB.`);
	return problems;
}

/** Check a page, mark it published, and return its address. */
export async function publishPage(
	workDir: string,
	slug: string,
	options: { pagesUrl?: string; publisher?: string },
): Promise<string> {
	if (!SLUG.test(slug)) throw new Error(`"${slug}" isn't a valid slug: lowercase letters, digits, and hyphens.`);
	const dir = join(workDir, "pages", slug);
	const problems = checkPage(dir);
	if (problems.length > 0) throw new Error(`Not published:\n- ${problems.join("\n- ")}`);
	writeFileSync(join(dir, PUBLISHED), `${new Date().toISOString()}\n`);
	if (options.publisher) {
		const stdout = await new Promise<string>((resolve, reject) =>
			execFile(options.publisher!, [slug, dir], { timeout: 5 * 60_000 }, (error, out, err) =>
				error ? reject(new Error(`Publisher failed: ${err.trim() || error.message}`)) : resolve(out),
			),
		);
		const url = stdout.trim().split("\n").at(-1)?.trim();
		if (!url?.startsWith("http")) throw new Error(`Publisher didn't print a URL (got "${stdout.trim().slice(0, 120)}").`);
		return url;
	}
	return `${(options.pagesUrl ?? "/pages").replace(/\/$/, "")}/${slug}/`;
}
