import { createInterface } from "node:readline/promises";
import type { Context } from "@earendil-works/chord";
import type { Agent } from "../agent.ts";
import type { Config } from "../config.ts";
import { deliver } from "../delivery.ts";
import { stamp } from "../time.ts";

/** Talk to pclaw in the terminal. Uses its own storage, so it works while the Discord bot runs. */
export async function chatInTerminal(agent: Agent, config: Config, context: Context): Promise<void> {
	const conversation = await agent.conversationFor("terminal", context);
	const delivery = await deliver(
		agent.harness,
		conversation.id,
		{
			async send(text) {
				process.stdout.write(`\npclaw: ${text}\n\n> `);
			},
			working() {},
		},
		context,
	);
	const lines = createInterface({ input: process.stdin, output: process.stdout });
	console.log("Talking to pclaw. Ctrl-D to leave.\n");
	lines.setPrompt("> ");
	lines.prompt();
	for await (const line of lines) {
		if (line.trim() === "") {
			lines.prompt();
			continue;
		}
		const content = `[${stamp(Date.now(), config.timeZone)}]\n${line}`;
		await conversation.submit({ type: "input", content, whenBusy: "steer" }, context);
	}
	await delivery.stop();
}
