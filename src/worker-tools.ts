/**
 * Tools pclaw gives its pi workers, loaded with `pi -e`. Replaces the search extensions in the owner's own pi setup,
 * which run every search through a Grok request and send one question to several search tools at once.
 */
import { Type } from "@earendil-works/pi-ai";
import { publishPage } from "./pages.ts";
import { chosenService, findInPage, formatSearch, pageWindow, readPage, search } from "./search.ts";

/** `details` stays in the session file, not the model's context: which search service answered, for comparing them. */
type Text = { content: { type: "text"; text: string }[]; details: Record<string, string> };
const text = (value: string, details: Record<string, string> = {}): Text => ({ content: [{ type: "text", text: value }], details });

type ToolApi = {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(id: string, params: never, signal?: AbortSignal): Promise<Text>;
	}): void;
};

export default function (pi: ToolApi) {
	pi.registerTool({
		name: "search",
		label: "Search",
		description:
			"Search the web. Fast (a second or two). Returns sources with excerpts. Search one question at a time and read " +
			"the results before searching again; run several searches together only when they're about different things.",
		parameters: Type.Object({
			query: Type.String({ description: "What to find, as a specific query." }),
			max_results: Type.Optional(Type.Number({ description: "Sources to return, 1-10. Default 5." })),
		}),
		async execute(_id, params: { query: string; max_results?: number }, signal) {
			const maxResults = Math.min(Math.max(Math.round(params.max_results ?? 5), 1), 10);
			const service = chosenService("search");
			const found = await search(params.query, { maxResults, service, ...(signal ? { signal } : {}) });
			return text(formatSearch(params.query, found), { service });
		},
	});
	// Pages read in this job, so paging through one or searching it again doesn't refetch it.
	const pages = new Map<string, Promise<string>>();
	const service = chosenService("pages");
	pi.registerTool({
		name: "read_page",
		label: "Read page",
		description:
			"Read a web page as text, 8,000 characters at a time. Use it to confirm a fact, price, or date at its source. " +
			"For a long page, pass `find` with a few words to get just the passages that mention them, or `offset` to read " +
			"further on. Pages are cached for this job, so both are cheap. For pages that need a login or a lot of " +
			"JavaScript, try bash with curl.",
		parameters: Type.Object({
			url: Type.String(),
			find: Type.Optional(Type.String({ description: "A few words to look for; returns the matching passages." })),
			offset: Type.Optional(Type.Number({ description: "Character to start from, for reading further on." })),
		}),
		async execute(_id, params: { url: string; find?: string; offset?: number }, signal) {
			let page = pages.get(params.url);
			if (page === undefined) {
				page = readPage(params.url, { service, ...(signal ? { signal } : {}) });
				pages.set(params.url, page);
				page.catch(() => pages.delete(params.url));
			}
			const content = await page;
			return text(params.find ? findInPage(content, params.find) : pageWindow(content, params.offset), { service });
		},
	});
	pi.registerTool({
		name: "publish_page",
		label: "Publish page",
		description:
			"Publish a web page you built under pages/<slug>/ (see the web-page skill). Checks it, and returns its address " +
			"on the person's private network. Call it again after changing a page.",
		parameters: Type.Object({ slug: Type.String({ description: "The page's folder name under pages/." }) }),
		async execute(_id, params: { slug: string }) {
			const url = await publishPage(process.cwd(), params.slug, {
				...(process.env.PCLAW_PAGES_URL ? { pagesUrl: process.env.PCLAW_PAGES_URL } : {}),
				...(process.env.PCLAW_PAGE_PUBLISHER ? { publisher: process.env.PCLAW_PAGE_PUBLISHER } : {}),
			});
			return text(`Published: ${url}`);
		},
	});
}
