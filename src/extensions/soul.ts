import { defineExtension, section } from "@earendil-works/pi-durable";
import { readFormatting, readPrompt } from "../prompts.ts";
import { channelOf } from "../routes.ts";

/**
 * The front model's system prompt: src/prompts/front.md (how it sounds and how pclaw works, the same in every app) and
 * the time zone. Rendered before every request, so edits apply right away; Pi Durable only resends a section when it
 * changes, which keeps the prompt cache warm otherwise.
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

/**
 * The rules for the app the conversation is on (src/prompts/formatting/<app>.md): what renders, how long a message can
 * be. Install it last so it ends the system prompt: the model follows rules it read last far more reliably, which
 * `pnpm prose-lab` showed when the same rules sat before the notes.
 */
export function formattingExtension() {
	return defineExtension({
		name: "pclaw.formatting",
		sections: [
			section("formatting", async (input, context) => {
				const channel = await channelOf(input.read, input.conversationId, context);
				return channel === undefined ? undefined : readFormatting(channel);
			}),
		],
	});
}
