import { readFileSync } from "node:fs";
import { defineExtension, section } from "@earendil-works/pi-durable";

const prompt = (name: string) => readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8").trim();
const voice = prompt("voice");
const operating = prompt("operating");

/**
 * The front model's prompt: the voice (how it talks, tuned against real Instinct conversations) and how pclaw works
 * (workers, memory, follow-ups). Static, so it stays in the provider's prompt cache.
 */
export function soulExtension(timeZone: string) {
	return defineExtension({
		name: "pclaw.soul",
		sections: [
			section("voice", () => voice, { tag: false }),
			section("operating", () => operating, { tag: false }),
			section("time-zone", () => `They live in the ${timeZone} time zone unless they say otherwise.`),
		],
	});
}
