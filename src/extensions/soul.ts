import { defineExtension, section } from "@earendil-works/pi-durable";
import { readPrompt } from "../prompts.ts";

/**
 * The front model's system prompt: src/prompts/front.md, plus the time zone. Rendered before every request, so edits
 * apply right away; Pi Durable only resends a section when it changes, which keeps the prompt cache warm otherwise.
 */
export function soulExtension(timeZone: string) {
	return defineExtension({
		name: "pclaw.soul",
		sections: [
			section("front", () => readPrompt("front").trim(), { tag: false }),
			section("time-zone", () => `They live in the ${timeZone} time zone unless they say otherwise.`),
		],
	});
}
