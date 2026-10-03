import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { formatSearch, search } from "../search.ts";

/**
 * One fast search for the front model, for questions a single lookup settles (hours, a time, a price, a quick fact).
 * A second or two, so the reply stays quick; anything needing comparison or judgment still goes to a worker.
 */
export function quickSearchExtension() {
	return defineExtension({
		name: "pclaw.quick-search",
		tools: [
			defineTool({
				name: "quick_search",
				description:
					"One quick web search (a second or two) for a question a single lookup settles: opening hours, a time, a " +
					"price, a date, a quick fact. Answer from what the sources say. If they don't clearly settle it, say so or " +
					"delegate; never fill the gap with a guess. Comparisons, research, and anything needing several sources go " +
					"to delegate instead.",
				parameters: Type.Object({ query: Type.String({ description: "A specific query." }) }),
				replay: "safe",
				execute: async ({ query }, _api, context) => {
					const found = await search(query, { maxResults: 4, ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
					return { content: [{ type: "text" as const, text: formatSearch(query, found, 400) }] };
				},
			}),
		],
	});
}
