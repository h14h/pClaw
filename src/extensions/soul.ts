import { defineExtension, section } from "@earendil-works/pi-durable";
import { readFormatting, readPrompt } from "../prompts.ts";
import { channelOf } from "../routes.ts";

/**
 * The front model's system prompt: src/prompts/front.md, the time zone, and the formatting guide for the app the
 * conversation is on. Rendered before every request, so edits
 * apply right away; Pi Durable only resends a section when it changes, which keeps the prompt cache warm otherwise.
 */
export function soulExtension(timeZone: string) {
	return defineExtension({
		name: "pclaw.soul",
		sections: [
			section("front", () => readPrompt("front").trim(), { tag: false }),
			section("time-zone", () => `They live in the ${timeZone} time zone unless they say otherwise.`),
			section("formatting", async (input, context) => {
				const channel = await channelOf(input.read, input.conversationId, context);
				return channel === undefined ? undefined : readFormatting(channel);
			}),
		],
	});
}
