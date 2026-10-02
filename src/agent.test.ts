import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import { type Config, defaults } from "./config.ts";
import { deliver } from "./delivery.ts";
import { Notes } from "./extensions/notes.ts";
import type { WorkerOptions } from "./extensions/workers.ts";

const context = BACKGROUND_CONTEXT;
const config: Config = { ...defaults, provider: "faux", model: "faux-1", thinkingLevel: "off", timeZone: "America/Los_Angeles" };

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-test-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A stand-in for pi: logs its session id and message, and answers with a fixed report. */
async function fakeWorkers(): Promise<WorkerOptions> {
	const command = join(dir, "fake-pi.sh");
	await writeFile(
		command,
		`#!/bin/sh
session=""
while [ $# -gt 1 ]; do
  if [ "$1" = "--session-id" ]; then session="$2"; fi
  shift
done
printf 'session=%s message=%s\\n' "$session" "$1" | tr '\\n' ' ' >> "${join(dir, "worker-calls.log")}"
echo >> "${join(dir, "worker-calls.log")}"
echo "walnut case is \\$135, ships free"
`,
	);
	await chmod(command, 0o755);
	return {
		command,
		provider: "xai",
		model: "grok-4.7",
		thinkingLevel: "high",
		timeoutMs: 10_000,
		cwd: join(dir, "work"),
		sessionDir: join(dir, "worker-sessions"),
		promptFile: join(dir, "worker.md"),
	};
}

function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

function inbox() {
	const sent: string[] = [];
	let waiting: (() => void) | undefined;
	return {
		sent,
		outbox: {
			async send(text: string) {
				sent.push(text);
				waiting?.();
			},
			working() {},
		},
		/** Resolve once `count` messages have been sent, or fail after `ms`. */
		until(count: number, ms = 10_000) {
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`only got ${JSON.stringify(sent)}`)), ms);
				const check = () => {
					if (sent.length >= count) {
						clearTimeout(timer);
						resolve();
					}
				};
				waiting = check;
				check();
			});
		},
	};
}

/** Every request's system prompt and messages, so tests can see what the model saw. */
function lastRequestText(requests: ModelContext[]): string {
	return JSON.stringify(requests.at(-1));
}

test("a reply reaches the outbox and remember writes the notes file", async () => {
	const { faux, models } = setup();
	const requests: ModelContext[] = [];
	const notes = new Notes(join(dir, "notes-1.md"));
	faux.setResponses([
		(request) => {
			requests.push(request);
			return fauxAssistantMessage(fauxToolCall("remember", { note: "Sister Maya has surgery Tuesday" }), {
				stopReason: "toolUse",
			});
		},
		(request) => {
			requests.push(request);
			return fauxAssistantMessage("got it. hope it goes smoothly");
		},
	]);
	const storage = await openNodeSqliteStorage(join(dir, "reply.sqlite"));
	const agent = await openAgent(storage, { config, models, notes, workers: await fakeWorkers() }, context);
	const conversation = await agent.conversationFor("test:dm", context);
	const { sent, outbox, until } = inbox();
	const delivery = await deliver(agent.harness, conversation.id, outbox, context);

	await conversation.submit({ type: "input", content: "my sister maya has surgery tuesday" }, context);
	await until(1);

	assert.deepEqual(sent, ["got it. hope it goes smoothly"]);
	assert.match(notes.read(), /- Sister Maya has surgery Tuesday/);
	assert.match(lastRequestText(requests), /These instructions govern your user-facing voice/);
	assert.match(lastRequestText(requests), /You.re pclaw/);
	await delivery.stop();
	await agent.harness.close(context);
});

test("NO_REPLY is not delivered", async () => {
	const { faux, models } = setup();
	faux.setResponses([fauxAssistantMessage("NO_REPLY"), fauxAssistantMessage("still here")]);
	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "silent.sqlite")),
		{ config, models, notes: new Notes(join(dir, "notes-2.md")), workers: await fakeWorkers() },
		context,
	);
	const conversation = await agent.conversationFor("test:dm", context);
	const { sent, outbox, until } = inbox();
	const delivery = await deliver(agent.harness, conversation.id, outbox, context);
	await (await conversation.submit({ type: "input", content: "<follow-up>stale</follow-up>" }, context)).wait(context);
	await conversation.submit({ type: "input", content: "you there?" }, context);
	await until(1);
	assert.deepEqual(sent, ["still here"]);
	await delivery.stop();
	await agent.harness.close(context);
});

test("a follow-up fires after a restart and its reply is delivered", async () => {
	const file = join(dir, "follow-up.sqlite");
	const notes = new Notes(join(dir, "notes-3.md"));
	const due = new Date(Date.now() + 2_000).toISOString();

	// First process: schedule the follow-up, then shut down before it is due.
	{
		const { faux, models } = setup();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("follow_up", { at: due, note: "ask how the interview went" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("good luck today"),
		]);
		const agent = await openAgent(await openNodeSqliteStorage(file), { config, models, notes, workers: await fakeWorkers() }, context);
		const conversation = await agent.conversationFor("test:dm", context);
		const { outbox, until } = inbox();
		const delivery = await deliver(agent.harness, conversation.id, outbox, context);
		await conversation.submit({ type: "input", content: "interview at 2, wish me luck" }, context);
		await until(1);
		await delivery.stop();
		await agent.harness.close(context);
	}

	// Second process: the sleeping follow-up resumes, comes due, and its answer goes out.
	{
		const { faux, models } = setup();
		let wake = "";
		faux.setResponses([
			(request) => {
				wake = JSON.stringify(request.messages.at(-1));
				return fauxAssistantMessage([fauxText("how'd the interview go?")]);
			},
		]);
		const agent = await openAgent(await openNodeSqliteStorage(file), { config, models, notes, workers: await fakeWorkers() }, context);
		const conversation = await agent.conversationFor("test:dm", context);
		const { sent, outbox, until } = inbox();
		const delivery = await deliver(agent.harness, conversation.id, outbox, context);
		await until(1);
		assert.deepEqual(sent, ["how'd the interview go?"]);
		assert.match(wake, /<follow-up>ask how the interview went<\/follow-up>/);
		await delivery.stop();
		await agent.harness.close(context);
	}
});

test("delegate runs a worker, its report comes back, and message_worker reuses its session", async () => {
	const { faux, models } = setup();
	const reports: string[] = [];
	const lastMessage = (request: ModelContext) => JSON.stringify(request.messages.at(-1));
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("delegate", { name: "nas", brief: "find a walnut NAS case under $200" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("on it"),
		(request) => {
			reports.push(lastMessage(request));
			return fauxAssistantMessage("walnut case is $135 and ships free");
		},
		fauxAssistantMessage(fauxToolCall("message_worker", { name: "nas", message: "check it fits 4 drives" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("asking"),
		(request) => {
			reports.push(lastMessage(request));
			return fauxAssistantMessage("yep, it fits");
		},
	]);
	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "workers.sqlite")),
		{ config, models, notes: new Notes(join(dir, "notes-4.md")), workers: await fakeWorkers() },
		context,
	);
	const conversation = await agent.conversationFor("test:dm", context);
	const { sent, outbox, until } = inbox();
	const delivery = await deliver(agent.harness, conversation.id, outbox, context);

	await conversation.submit({ type: "input", content: "find me a nice NAS case" }, context);
	await until(2);
	await conversation.submit({ type: "input", content: "does it fit 4 drives?" }, context);
	await until(4);

	assert.deepEqual(sent, ["on it", "walnut case is $135 and ships free", "asking", "yep, it fits"]);
	assert.match(reports[0]!, /<worker-report worker=\\"nas\\" status=\\"done\\">/);
	assert.match(reports[0]!, /walnut case is \$135/);
	const calls = (await readFile(join(dir, "worker-calls.log"), "utf8")).trim().split("\n");
	assert.equal(calls.length, 2);
	assert.match(calls[0]!, /find a walnut NAS case under \$200/);
	assert.match(calls[1]!, /check it fits 4 drives/);
	const session = (line: string) => /session=(\S+)/.exec(line)?.[1];
	assert.equal(session(calls[0]!), session(calls[1]!));
	await delivery.stop();
	await agent.harness.close(context);
});
