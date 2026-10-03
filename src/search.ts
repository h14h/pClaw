/**
 * Web search and page reading, through Tavily or Parallel. Each runs behind the same two calls so they can be swapped
 * and compared: PCLAW_SEARCH picks the service for searches and PCLAW_PAGE_READER the one for reading pages, Tavily
 * when unset. Used by the front model's quick_search and by workers (through src/worker-tools.ts, in the pi process),
 * so everything comes from the environment: those two and each service's API key.
 */

const PAGE_LIMIT = 8_000;
/** What Parallel returns per result. The model sees less (`formatSearch`), the same for both services. */
const EXCERPT_CHARS = 1_500;

export type SearchResult = { title: string; url: string; content: string };
export type Found = { answer?: string; results: SearchResult[] };
export type SearchOptions = { maxResults?: number; signal?: AbortSignal; service?: ServiceId };

type Service = {
	name: string;
	/** The environment variable holding its API key. */
	keyVariable: string;
	search(query: string, maxResults: number, signal?: AbortSignal): Promise<Found>;
	readPage(url: string, signal?: AbortSignal): Promise<string>;
};

function key(service: Service): string {
	const value = process.env[service.keyVariable];
	if (value === undefined || value === "") throw new Error(`Search isn't set up: ${service.keyVariable} is missing.`);
	return value;
}

async function post<T>(service: Service, url: string, headers: Record<string, string>, body: object, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
	});
	if (!response.ok) throw new Error(`${service.name} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
	return (await response.json()) as T;
}

/** About 2s per search. Its search returns a short answer, shown as unverified; its pages come back as full text. */
const tavily: Service = {
	name: "Tavily",
	keyVariable: "TAVILY_API_KEY",
	async search(query, maxResults, signal) {
		const body = { query, max_results: maxResults, include_answer: true, search_depth: "basic" };
		const result = await post<{ answer?: string | null; results?: SearchResult[] }>(
			this, "https://api.tavily.com/search", { Authorization: `Bearer ${key(this)}` }, body, 30_000, signal,
		);
		return { ...(result.answer ? { answer: result.answer } : {}), results: result.results ?? [] };
	},
	async readPage(url, signal) {
		const result = await post<{ results?: { raw_content?: string }[]; failed_results?: { error?: string }[] }>(
			this, "https://api.tavily.com/extract", { Authorization: `Bearer ${key(this)}` }, { urls: [url] }, 30_000, signal,
		);
		const text = result.results?.[0]?.raw_content?.trim();
		const error = result.failed_results?.[0]?.error;
		if (!text) throw new Error(`Couldn't read ${url}${error ? `: ${error}` : ""}.`);
		return text;
	},
};

/**
 * Search in "basic" mode (about 1s). No answer; instead each result has excerpts chosen for the query. A page it hasn't
 * cached can take a minute or more to read, so reads get a longer timeout.
 */
const parallel: Service = {
	name: "Parallel",
	keyVariable: "PARALLEL_API_KEY",
	async search(query, maxResults, signal) {
		const body = {
			objective: query,
			search_queries: [query],
			mode: "basic",
			advanced_settings: { max_results: maxResults, excerpt_settings: { max_chars_per_result: EXCERPT_CHARS } },
		};
		const result = await post<{ results?: { url: string; title?: string | null; publish_date?: string | null; excerpts?: string[] }[] }>(
			this, "https://api.parallel.ai/v1/search", { "x-api-key": key(this) }, body, 30_000, signal,
		);
		return {
			results: (result.results ?? []).map((each) => ({
				title: [each.title ?? each.url, each.publish_date ? `(${each.publish_date})` : ""].join(" ").trim(),
				url: each.url,
				content: (each.excerpts ?? []).join("\n\n"),
			})),
		};
	},
	async readPage(url, signal) {
		const body = { urls: [url], advanced_settings: { full_content: true } };
		const result = await post<{ results?: { full_content?: string | null }[]; errors?: { error_type?: string; http_status_code?: number | null }[] }>(
			this, "https://api.parallel.ai/v1/extract", { "x-api-key": key(this) }, body, 120_000, signal,
		);
		const text = result.results?.[0]?.full_content?.trim();
		const error = result.errors?.[0];
		const why = error === undefined ? "" : `: ${[error.error_type, error.http_status_code].filter((part) => part != null).join(", HTTP ")}`;
		if (!text) throw new Error(`Couldn't read ${url}${why}.`);
		return text;
	},
};

export const services = { tavily, parallel };
export type ServiceId = keyof typeof services;

export function isServiceId(value: unknown): value is ServiceId {
	return typeof value === "string" && Object.hasOwn(services, value);
}

const variables = { search: "PCLAW_SEARCH", pages: "PCLAW_PAGE_READER" } as const;

/** The service PCLAW_SEARCH or PCLAW_PAGE_READER names, Tavily when unset. */
export function chosenService(use: "search" | "pages"): ServiceId {
	const value = process.env[variables[use]];
	if (value === undefined || value === "") return "tavily";
	if (!isServiceId(value)) throw new Error(`Unknown search service "${value}".`);
	return value;
}

/** Use `id` from now on, in this process and in workers it starts after this. */
export function chooseService(use: "search" | "pages", id: ServiceId): void {
	process.env[variables[use]] = id;
}

/** Whether the service has its API key. */
export function serviceReady(id: ServiceId): boolean {
	return (process.env[services[id].keyVariable] ?? "") !== "";
}

export function search(query: string, options: SearchOptions = {}): Promise<Found> {
	return services[options.service ?? chosenService("search")].search(query, options.maxResults ?? 5, options.signal);
}

/** Full readable text of a page. Callers decide how much of it the model sees (see `pageWindow`, `findInPage`). */
export function readPage(url: string, options: { signal?: AbortSignal; service?: ServiceId } = {}): Promise<string> {
	return services[options.service ?? chosenService("pages")].readPage(url, options.signal);
}

/** Up to PAGE_LIMIT characters starting at `offset`, with a footer saying where it is in the page. */
export function pageWindow(text: string, offset = 0): string {
	const start = Math.min(Math.max(Math.floor(offset), 0), text.length);
	const end = Math.min(start + PAGE_LIMIT, text.length);
	const window = text.slice(start, end);
	if (start === 0 && end === text.length) return window;
	const more = end < text.length ? ` Next: offset=${end}, or use find to jump to what you need.` : "";
	return `${window}\n\n[characters ${start}–${end} of ${text.length}.${more}]`;
}

/**
 * The passages of a page that mention `find`'s words, best matches first, each with some surrounding text. Lets a
 * worker pull one section out of a long page without reading all of it.
 */
export function findInPage(text: string, find: string): string {
	const words = [...new Set(find.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) ?? [])].filter((word) => word.length > 1);
	if (words.length === 0) return pageWindow(text);
	const paragraphs = text.split(/\n\s*\n|\n(?=[-*#|])/).map((paragraph) => paragraph.trim()).filter(Boolean);
	const scored = paragraphs
		.map((paragraph, index) => {
			const lower = paragraph.toLowerCase();
			return { index, score: words.filter((word) => lower.includes(word)).length };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index);
	if (scored.length === 0) return `Nothing on the page mentions ${words.join(", ")}. The page is ${text.length} characters; read it with offset to look yourself.`;
	const picked: string[] = [];
	let used = 0;
	for (const { index } of scored) {
		const passage = paragraphs.slice(Math.max(0, index - 1), index + 2).join("\n\n");
		if (picked.some((existing) => existing.includes(paragraphs[index]!))) continue;
		if (used + passage.length > PAGE_LIMIT && picked.length > 0) break;
		picked.push(passage.length > PAGE_LIMIT ? passage.slice(0, PAGE_LIMIT) : passage);
		used += passage.length;
	}
	return `${picked.length} of ${scored.length} matching passages, best first:\n\n${picked.join("\n\n---\n\n")}`;
}

/** Search output as the model sees it. The summary is labelled as unverified so it isn't taken as a source. */
export function formatSearch(query: string, found: Found, snippet = 500): string {
	if (found.results.length === 0) return `No results for "${query}".`;
	const sources = found.results
		.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.content.slice(0, snippet).trim()}`)
		.join("\n\n");
	const answer = found.answer === undefined ? "" : `Search engine's summary (unverified, check it against the sources): ${found.answer}\n\n`;
	return `${answer}Sources:\n\n${sources}`;
}
