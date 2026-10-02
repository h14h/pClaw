/**
 * Tools pclaw gives its pi workers, loaded with `pi -e`. Replaces the search extensions in the owner's own pi setup,
 * which run every search through a Grok request and send one question to several search tools at once.
 */
import { Type } from "@earendil-works/pi-ai";
import { formatSearch, readPage, search } from "./search.ts";

type Text = { content: { type: "text"; text: string }[]; details: Record<string, never> };
const text = (value: string): Text => ({ content: [{ type: "text", text: value }], details: {} });

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
			"Search the web. Fast (about 2 seconds). Returns sources with snippets. Search one question at a time and read " +
			"the results before searching again; run several searches together only when they're about different things.",
		parameters: Type.Object({
			query: Type.String({ description: "What to find, as a specific query." }),
			max_results: Type.Optional(Type.Number({ description: "Sources to return, 1-10. Default 5." })),
		}),
		async execute(_id, params: { query: string; max_results?: number }, signal) {
			const maxResults = Math.min(Math.max(Math.round(params.max_results ?? 5), 1), 10);
			return text(formatSearch(params.query, await search(params.query, { maxResults, ...(signal ? { signal } : {}) })));
		},
	});
	pi.registerTool({
		name: "read_page",
		label: "Read page",
		description:
			"Read a web page as text (clipped to 8,000 characters). Use it to confirm a fact, price, or date at its source. " +
			"For pages that need a login or a lot of JavaScript, try bash with curl.",
		parameters: Type.Object({ url: Type.String() }),
		async execute(_id, params: { url: string }, signal) {
			return text(await readPage(params.url, signal));
		},
	});
}
