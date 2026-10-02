/**
 * Web search and page reading through Tavily: about 2s per search, against ~10s for xAI's hosted search on Grok 4.5
 * and ~26s on Grok 4.7. Used by the front model's quick_search and by workers (through src/worker-tools.ts), so it
 * has no imports and reads its key from TAVILY_API_KEY.
 */

const API = "https://api.tavily.com";
const PAGE_LIMIT = 8_000;

export type SearchResult = { title: string; url: string; content: string };

function key(): string {
	const value = process.env.TAVILY_API_KEY;
	if (value === undefined || value === "") throw new Error("Search isn't set up: TAVILY_API_KEY is missing.");
	return value;
}

async function call<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
	const timeout = AbortSignal.timeout(30_000);
	const response = await fetch(`${API}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key()}` },
		body: JSON.stringify(body),
		signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
	});
	if (!response.ok) throw new Error(`Search failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
	return (await response.json()) as T;
}

export async function search(
	query: string,
	options: { maxResults?: number; signal?: AbortSignal } = {},
): Promise<{ answer?: string; results: SearchResult[] }> {
	const body = { query, max_results: options.maxResults ?? 5, include_answer: true, search_depth: "basic" };
	const result = await call<{ answer?: string | null; results?: SearchResult[] }>("/search", body, options.signal);
	return { ...(result.answer ? { answer: result.answer } : {}), results: result.results ?? [] };
}

/** Readable text of a page, clipped. */
export async function readPage(url: string, signal?: AbortSignal): Promise<string> {
	const result = await call<{ results?: { url: string; raw_content?: string }[]; failed_results?: { error?: string }[] }>(
		"/extract",
		{ urls: [url] },
		signal,
	);
	const text = result.results?.[0]?.raw_content?.trim();
	if (!text) throw new Error(`Couldn't read ${url}${result.failed_results?.[0]?.error ? `: ${result.failed_results[0].error}` : ""}.`);
	return text.length > PAGE_LIMIT ? `${text.slice(0, PAGE_LIMIT)}\n[cut off at ${PAGE_LIMIT} characters]` : text;
}

/** Search output as the model sees it. The summary is labelled as unverified so it isn't taken as a source. */
export function formatSearch(query: string, found: { answer?: string; results: SearchResult[] }, snippet = 500): string {
	if (found.results.length === 0) return `No results for "${query}".`;
	const sources = found.results
		.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.content.slice(0, snippet).trim()}`)
		.join("\n\n");
	const answer = found.answer === undefined ? "" : `Search engine's summary (unverified, check it against the sources): ${found.answer}\n\n`;
	return `${answer}Sources:\n\n${sources}`;
}
