import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "../agent.ts";
import { type Config, defaults } from "../config.ts";
import { Notes } from "../extensions/notes.ts";
import type { WorkerOptions } from "../extensions/workers.ts";
import { startDashboard } from "./server.ts";
import type { ConversationView, Overview, Settings, WorkerDetail } from "./types.ts";
import { parseWorkerSession } from "./views.ts";

const context = BACKGROUND_CONTEXT;
const config: Config = { ...defaults, provider: "faux", model: "faux-1", thinkingLevel: "off", timeZone: "UTC" };

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-dashboard-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A stand-in for pi that writes a pi-style session file, then answers. */
async function fakeWorkers(): Promise<WorkerOptions> {
	const sessionDir = join(dir, "sessions");
	const command = join(dir, "fake-pi.sh");
	await writeFile(
		command,
		`#!/bin/sh
session=""
while [ $# -gt 1 ]; do
  if [ "$1" = "--session-id" ]; then session="$2"; fi
  shift
done
mkdir -p "${sessionDir}"
f="${sessionDir}/2026-10-02T00-00-00-000Z_$session.jsonl"
cat >> "$f" <<'JSONL'
{"type":"session","version":3,"id":"x","timestamp":"2026-10-02T00:00:00.000Z","cwd":"/w"}
{"type":"message","timestamp":"2026-10-02T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Message from pclaw:\\n\\nfind a quiet NAS case"}],"timestamp":1}}
{"type":"message","timestamp":"2026-10-02T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"search first"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"curl example.com"}}]}}
{"type":"message","timestamp":"2026-10-02T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false,"timestamp":3}}
{"type":"message","timestamp":"2026-10-02T00:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Jonsbo N4, $135"}]}}
JSONL
echo "Jonsbo N4, \\$135"
`,
	);
	await chmod(command, 0o755);
	return { command, provider: "xai", model: "grok-4.7", thinkingLevel: "high", timeoutMs: 10_000, cwd: join(dir, "work"), sessionDir, promptFile: join(dir, "worker.md") };
}

test("parseWorkerSession joins tool calls to results and strips the pclaw prefix", () => {
	const items = parseWorkerSession(
		[
			'{"type":"message","timestamp":"2026-10-02T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Message from pclaw:\\n\\ndo it"}]}}',
			'{"type":"message","timestamp":"2026-10-02T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"read","arguments":{"path":"x"}}]}}',
			'{"type":"message","timestamp":"2026-10-02T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"a","toolName":"read","content":[{"type":"text","text":"nope"}],"isError":true}}',
			'{"type":"message","timestamp":"2026-10-02T00:00:04.000Z","message":{"role":"assist', // half-written
		].join("\n"),
	);
	assert.deepEqual(items, [
		{ kind: "from-pclaw", at: Date.parse("2026-10-02T00:00:01.000Z"), text: "do it" },
		{ kind: "tool", at: Date.parse("2026-10-02T00:00:02.000Z"), name: "read", args: { path: "x" }, result: "nope", isError: true },
	]);
});

test("the dashboard API shows the timeline, held replies, workers, and their transcripts", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	// Registered for its model catalog only; nothing here calls xAI.
	models.setProvider(xaiProvider());
	faux.setResponses([
		fauxAssistantMessage([fauxText("I'll check."), fauxToolCall("delegate", { name: "nas", brief: "find a quiet NAS case" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("on it"),
		fauxAssistantMessage("Jonsbo N4 looks right, $135"),
	]);
	const workers = await fakeWorkers();
	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "dash.sqlite")),
		{ config, models, notes: new Notes(join(dir, "notes.md")), workers },
		context,
	);
	const conversation = await agent.conversationFor("discord:dm:1", context);
	const dashboard = await startDashboard({ agent, config, models, notes: new Notes(join(dir, "notes.md")), workers, port: 0 }, context);
	try {
		const { port } = dashboard;
		const get = async <T>(path: string): Promise<T> => (await fetch(`http://127.0.0.1:${port}${path}`)).json() as Promise<T>;

		await conversation.submit({ type: "input", content: "[stamp]\nfind me a NAS case" }, context);
		// Wait for the worker's report to be answered.
		for (let i = 0; i < 100; i++) {
			const view = await get<ConversationView>(`/api/conversations/${conversation.id}`);
			if (view.timeline.some((item) => item.kind === "reply" && item.text.startsWith("Jonsbo"))) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const overview = await get<Overview>("/api/overview");
		assert.equal(overview.conversations[0]?.label, "Discord DM");
		const view = await get<ConversationView>(`/api/conversations/${conversation.id}`);
		const kinds = view.timeline.map((item) => (item.kind === "reply" ? `reply:${item.text}:${item.delivered ? "sent" : item.held}` : item.kind === "event" ? `event:${item.event}` : item.kind === "tool" ? `tool:${item.name}:${item.worker}` : `message:${item.text}`));
		assert.deepEqual(kinds, [
			"message:find me a NAS case",
			"reply:I'll check.:superseded",
			"tool:delegate:nas",
			"reply:on it:sent",
			"event:worker-report",
			"reply:Jonsbo N4 looks right, $135:sent",
		]);
		assert.equal(view.workers[0]?.name, "nas");
		assert.equal(view.live.state, "idle");

		const detail = await get<WorkerDetail>(`/api/conversations/${conversation.id}/workers/nas`);
		assert.deepEqual(
			detail.transcript.map((item) => item.kind),
			["from-pclaw", "thinking", "tool", "text"],
		);

		// Settings: read, change the worker model, reject a bad level and a cross-origin write, save a prompt unchanged.
		const settings = await get<Settings>("/api/settings");
		assert.equal(settings.worker.model, "grok-4.7");
		assert.ok(settings.models.some((model) => model.id === "grok-4.5" && model.thinkingLevels.includes("medium")));
		assert.match(settings.prompts.front.text, /You're pclaw/);
		const put = (path: string, body: unknown, headers: Record<string, string> = {}) =>
			fetch(`http://127.0.0.1:${port}${path}`, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
		const changed = await put("/api/settings/models", { worker: { provider: "xai", model: "grok-4.5", thinkingLevel: "low" } });
		assert.equal(((await changed.json()) as Settings).worker.model, "grok-4.5");
		assert.equal(workers.model, "grok-4.5");
		const bad = await put("/api/settings/models", { worker: { provider: "xai", model: "grok-4.5", thinkingLevel: "ludicrous" } });
		assert.equal(bad.status, 400);
		const crossSite = await put("/api/settings/prompts/worker", { text: "x" }, { Origin: "https://evil.example" });
		assert.equal(crossSite.status, 400);
		const saved = await put("/api/settings/prompts/worker", { text: settings.prompts.worker.text });
		assert.equal(saved.status, 200);
	} finally {
		await dashboard.stop();
		await agent.harness.close(context);
	}
});
