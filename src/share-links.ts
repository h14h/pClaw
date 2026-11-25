/**
 * Share links for published pages: `/p/<token>/` serves one page without revealing whose shelf it sits on.
 * Each page gets a random token that survives republishing; rotating it kills the old link at once.
 * Tokens live per user in `<pagesDir>/.share-links/<userCode>.json` as `{ "pages": { "<slug>": "<token>" } }`,
 * next to the published sites but outside them, so publishing (which swaps a user's whole folder) never loses them.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PAGES_CODE } from "./config.ts";
import { SLUG } from "./pages.ts";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const SHARE_TOKEN_LENGTH = 12;
/** 12 base62 characters: about 71 bits. */
export const SHARE_TOKEN = /^[0-9A-Za-z]{12}$/;
/** Folders in a user's built site that aren't pages. */
const NOT_PAGES = new Set(["home", "og", "_astro"]);

/** A fresh unguessable token, drawn without modulo bias. */
export function newShareToken(): string {
	let out = "";
	while (out.length < SHARE_TOKEN_LENGTH) {
		for (const byte of randomBytes(16)) {
			// 248 = 62 * 4, so bytes below it map evenly onto the alphabet.
			if (byte < 248 && out.length < SHARE_TOKEN_LENGTH) out += BASE62[byte % 62];
		}
	}
	return out;
}

/** The share address for a token under the public pages URL. */
export function shareUrl(pagesUrl: string, token: string): string {
	return `${pagesUrl.trim().replace(/\/+$/, "")}/p/${token}/`;
}

type UserFile = { pages: Record<string, string> };
type Cached = { key: string; pages: Record<string, string> };

export class ShareLinks {
	readonly dir: string;
	readonly #pagesDir: string;
	#cache = new Map<string, Cached>();

	constructor(pagesDir: string) {
		this.#pagesDir = pagesDir;
		this.dir = join(pagesDir, ".share-links");
	}

	#file(code: string): string {
		if (!PAGES_CODE.test(code)) throw new Error(`Invalid pages code "${code}".`);
		return join(this.dir, `${code}.json`);
	}

	/** One user's slug → token map, re-read whenever the file changes (another process may have rotated a token). */
	#read(code: string): Record<string, string> {
		const file = this.#file(code);
		let key: string;
		try {
			const stat = statSync(file);
			key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
		} catch {
			this.#cache.delete(code);
			return {};
		}
		const cached = this.#cache.get(code);
		if (cached?.key === key) return cached.pages;
		const pages: Record<string, string> = {};
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<UserFile>;
			for (const [slug, token] of Object.entries(parsed.pages ?? {})) {
				if (SLUG.test(slug) && typeof token === "string" && SHARE_TOKEN.test(token)) pages[slug] = token;
			}
		} catch {
			// A broken file reads as empty rather than taking every link down with an exception.
		}
		this.#cache.set(code, { key, pages });
		return pages;
	}

	#write(code: string, pages: Record<string, string>): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const file = this.#file(code);
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		const sorted = Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b)));
		writeFileSync(tmp, `${JSON.stringify({ pages: sorted } satisfies UserFile, null, "\t")}\n`, { mode: 0o600 });
		renameSync(tmp, file);
		this.#cache.delete(code);
	}

	#taken(token: string): boolean {
		return this.lookup(token) !== undefined;
	}

	#fresh(): string {
		for (;;) {
			const token = newShareToken();
			if (!this.#taken(token)) return token;
		}
	}

	/** Whether `<pagesDir>/<code>/<slug>/index.html` is published. */
	isPublished(code: string, slug: string): boolean {
		return PAGES_CODE.test(code) && SLUG.test(slug) && !NOT_PAGES.has(slug) && existsSync(join(this.#pagesDir, code, slug, "index.html"));
	}

	/** The page's token, or undefined when it has none yet. */
	get(code: string, slug: string): string | undefined {
		return this.#read(code)[slug];
	}

	/** The page's token, minting one the first time. Republishing keeps it. */
	tokenFor(code: string, slug: string): string {
		if (!SLUG.test(slug)) throw new Error(`Invalid page slug "${slug}".`);
		const pages = this.#read(code);
		const existing = pages[slug];
		if (existing !== undefined) return existing;
		const token = this.#fresh();
		this.#write(code, { ...pages, [slug]: token });
		return token;
	}

	/** Replace the page's token; the old link stops working immediately. */
	rotate(code: string, slug: string): string {
		if (!SLUG.test(slug)) throw new Error(`Invalid page slug "${slug}".`);
		const token = this.#fresh();
		this.#write(code, { ...this.#read(code), [slug]: token });
		return token;
	}

	/** Published page slugs for one user, by folder. */
	slugs(code: string): string[] {
		if (!PAGES_CODE.test(code)) return [];
		try {
			return readdirSync(join(this.#pagesDir, code), { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && this.isPublished(code, entry.name))
				.map((entry) => entry.name)
				.sort();
		} catch {
			return [];
		}
	}

	/** Give every published page (one user's, or everyone's) a token. Returns how many were minted. */
	backfill(code?: string): number {
		const codes = code !== undefined ? [code] : this.#codes();
		let minted = 0;
		for (const user of codes) {
			const pages = { ...this.#read(user) };
			let changed = false;
			for (const slug of this.slugs(user)) {
				if (pages[slug] !== undefined) continue;
				pages[slug] = this.#fresh();
				changed = true;
				minted++;
			}
			if (changed) this.#write(user, pages);
		}
		return minted;
	}

	#codes(): string[] {
		try {
			return readdirSync(this.#pagesDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && PAGES_CODE.test(entry.name))
				.map((entry) => entry.name);
		} catch {
			return [];
		}
	}

	#storedCodes(): string[] {
		try {
			return readdirSync(this.dir)
				.filter((name) => name.endsWith(".json"))
				.map((name) => name.slice(0, -".json".length))
				.filter((code) => PAGES_CODE.test(code));
		} catch {
			return [];
		}
	}

	/** Which page a token opens, if it's live. */
	lookup(token: string): { code: string; slug: string } | undefined {
		if (!SHARE_TOKEN.test(token)) return undefined;
		for (const code of this.#storedCodes()) {
			for (const [slug, candidate] of Object.entries(this.#read(code))) {
				if (candidate === token) return { code, slug };
			}
		}
		return undefined;
	}
}
