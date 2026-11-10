import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { chosenService, formatSearch, search } from "../search.ts";

/**
 * One fast search for the front model, for questions a single lookup settles (hours, a time, a price, a quick fact).
 * A second or two, so the reply stays quick; anything needing comparison or judgment still goes to a worker.
 */
const result = (text: string, details: Record<string, string | number>, isError = false) => ({
	output: [{ type: "text" as const, text }],
	details,
	...(isError ? { isError } : {}),
});

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
				parameters: obj({ query: str({ description: "A specific query." }) }, { open: true }),
				replay: "safe",
				execute: async ({ query }, _api, context) => {
					// `details` stays in the transcript, not the model's context: which service answered, and how fast.
					const service = chosenService("search");
					const started = performance.now();
					const ms = () => Math.round(performance.now() - started);
					try {
						const found = await search(query, { maxResults: 4, service, ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
						return result(formatSearch(query, found, 400), { service, ms: ms(), results: found.results.length });
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						const message = error instanceof Error ? error.message : String(error);
						return result(message, { service, ms: ms(), error: message.slice(0, 300) }, true);
					}
				},
			}),
		],
	});
}
