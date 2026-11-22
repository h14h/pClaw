import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import { type Config, defaults } from "./config.ts";
import { deliver } from "./delivery.ts";
import { Notes } from "./extensions/notes.ts";
import { type WorkerOptions, Workers } from "./extensions/workers.ts";
import { MUSE, museTranscript, parseMuseSession } from "./muse.ts";
import { isUuidv7, type LiveWorkerHandle, runMuseMsp, toMuseSessionId, uuidv7 } from "./muse-msp.ts";
import { createSshSandbox } from "./sandbox.ts";
import { formatWorkerProgress } from "./worker-progress.ts";

const context = BACKGROUND_CONTEXT;

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-muse-msp-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<Config> = {}): Config {
	return {
		...defaults,
		provider: "faux",
		model: "faux-1",
		thinkingLevel: "off",
		allowT3: false,
		...overrides,
	};
}

function setupFaux() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

function inbox() {
	const sent: string[] = [];
	let wake: (() => void) | undefined;
	return {
		sent,
		outbox: {
			async send(text: string) {
				sent.push(text);
				wake?.();
			},
			working() {},
		},
		until(count: number, ms = 10_000) {
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`only got ${JSON.stringify(sent)}`)), ms);
				const check = () => {
					if (sent.length >= count) {
						clearTimeout(timer);
						resolve();
					}
				};
				wake = check;
				check();
			});
		},
	};
}

/**
 * Reusable mock `muse serve` script implementing MSP v1 JSON-RPC over stdio:
 * - initialize + initialized
 * - session/start (enforces UUIDv7 & conflict check) & session/resume (enforces sessionNotFound)
 * - approval/request -> approval/decide roundtrip when `REQUIRE_APPROVAL=1`
 * - turn/start (immediate or queued when busy)
 * - turn/steer (with expectedTurnId check; rejects stale id)
 * - turn/interrupt (cancels active turn cleanly)
 * - session/leave
 * - Optional gate file (`GATE_FILE`) to hold turn 1 open until released so tests can send live steer/queue/interrupt!
 */
async function createMockMspServer(name: string, opts: { logFile: string; stateFile: string; gateFile?: string; requireApproval?: boolean; rejectSteerOnce?: boolean }): Promise<string> {
	const script = join(dir, `${name}.mjs`);
	await writeFile(
		script,
		`#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logFile = ${JSON.stringify(opts.logFile)};
const stateFile = ${JSON.stringify(opts.stateFile)};
const gateFile = ${JSON.stringify(opts.gateFile ?? "")};
const requireApproval = ${JSON.stringify(opts.requireApproval === true)};
let rejectSteerOnce = ${JSON.stringify(opts.rejectSteerOnce === true)};

const log = (entry) => appendFileSync(logFile, JSON.stringify(entry) + "\\n");
const loadSessions = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {});
const saveSessions = (s) => writeFileSync(stateFile, JSON.stringify(s));
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
const isV7 = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || "");

let sessionId = "";
let activeTurn = null;
const queue = [];
let approvalApproved = false;
let waitTimer = null;

function completeTurn(turn, terminal = "completed") {
	if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
	activeTurn = null;
	if (terminal === "completed") {
		const steeredPart = turn.steers.length > 0 ? " | STEERED: " + turn.steers.join("; ") : "";
		const reply = "DONE[" + turn.prompt.trim().slice(-40) + "]" + steeredPart + (approvalApproved ? " [APPROVED]" : "");
		send({
			method: "item/completed",
			params: {
				sessionId,
				item: {
					itemId: "tc-" + turn.turnId,
					kind: "toolCall",
					status: "completed",
					tool: "bash",
					args: JSON.stringify({ command: "echo hi" }),
					visibleOutput: "hi",
					turnId: turn.turnId,
				},
			},
		});
		send({
			method: "item/completed",
			params: {
				sessionId,
				item: {
					itemId: "am-" + turn.turnId,
					kind: "agentMessage",
					messagePhase: "finalAnswer",
					status: "completed",
					text: reply,
					turnId: turn.turnId,
				},
			},
		});
	}
	send({ method: "turn/completed", params: { sessionId, turnId: turn.turnId, terminal } });
	if (queue.length > 0 && terminal !== "cancelled") {
		startTurn(queue.shift());
	}
}

function startTurn(turn) {
	activeTurn = turn;
	send({ method: "turn/started", params: { sessionId, turnId: turn.turnId, commandId: turn.commandId } });
	send({ method: "item/completed", params: { sessionId, item: { itemId: "um-" + turn.turnId, kind: "userMessage", status: "completed", text: turn.prompt, turnId: turn.turnId } } });
	send({
		method: "item/started",
		params: {
			sessionId,
			item: {
				itemId: "tc-" + turn.turnId,
				kind: "toolCall",
				status: "inProgress",
				tool: "bash",
				args: JSON.stringify({ command: "echo hi" }),
				turnId: turn.turnId,
			},
		},
	});

	if (requireApproval && !approvalApproved) {
		send({
			id: 9001,
			method: "approval/request",
			params: {
				sessionId,
				approvalId: "appr-1",
				currentRequirementId: "req-1",
				availableChoices: [
					{ choiceId: "deny-1", decision: "denied", label: "Deny" },
					{ choiceId: "allow-session", decision: "approvedForSession", label: "Allow" },
				],
			},
		});
		return;
	}

	if (gateFile && !existsSync(gateFile)) {
		waitTimer = setInterval(() => {
			if (existsSync(gateFile)) completeTurn(turn, "completed");
		}, 30);
	} else {
		setTimeout(() => {
			if (activeTurn === turn) completeTurn(turn, "completed");
		}, 20);
	}
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method) log({ method: msg.method, params: msg.params });

	if (msg.method === "initialize") {
		send({ id: msg.id, result: { serverInfo: { name: "mock-msp", version: "1.0.0" } } });
	} else if (msg.method === "initialized") {
		// handshake complete
	} else if (msg.method === "session/start") {
		if (!isV7(msg.params.sessionId)) {
			send({ id: msg.id, error: { code: -32602, message: "invalid session/start sessionId: expected UUIDv7", data: { kind: "invalidParams" } } });
			return;
		}
		const sessions = loadSessions();
		if (sessions[msg.params.sessionId]) {
			send({ id: msg.id, error: { code: -32030, message: "session id conflict", data: { kind: "commandRejected", reason: "session_id_conflict" } } });
			return;
		}
		sessionId = msg.params.sessionId;
		sessions[sessionId] = { workspaceRoot: msg.params.workspaceRoot ?? null };
		saveSessions(sessions);
		send({ id: msg.id, result: { session: { sessionId, approvalMode: { mode: msg.params.approvalMode ?? "allowAll" } } } });
	} else if (msg.method === "session/resume") {
		const sessions = loadSessions();
		if (!sessions[msg.params.sessionId]) {
			send({ id: msg.id, error: { code: -32020, message: "session not found", data: { kind: "sessionNotFound" } } });
			return;
		}
		sessionId = msg.params.sessionId;
		send({ id: msg.id, result: { session: { sessionId, approvalMode: { mode: "promptUnmatched" } } } });
	} else if (msg.method === "session/setApprovalMode") {
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted" } });
	} else if (msg.method === "approval/decide") {
		approvalApproved = msg.params.choiceId === "allow-session";
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted" } });
		if (activeTurn) {
			const t = activeTurn;
			if (gateFile && !existsSync(gateFile)) {
				waitTimer = setInterval(() => {
					if (existsSync(gateFile)) completeTurn(t, "completed");
				}, 30);
			} else {
				completeTurn(t, "completed");
			}
		}
	} else if (msg.method === "turn/start") {
		const turnId = msg.params.commandId;
		const prompt = msg.params.input.map((p) => p.text ?? "").join("\\n");
		const turn = { turnId, commandId: msg.params.commandId, prompt, steers: [] };
		if (activeTurn) {
			queue.push(turn);
			send({ id: msg.id, result: { commandId: turn.commandId, disposition: "queued", startedNewTurn: false, status: "accepted", turnId } });
		} else {
			send({ id: msg.id, result: { commandId: turn.commandId, disposition: "started", startedNewTurn: true, status: "accepted", turnId } });
			startTurn(turn);
		}
	} else if (msg.method === "turn/steer") {
		if (rejectSteerOnce) {
			rejectSteerOnce = false;
			send({ id: msg.id, error: { code: -32030, message: "expected turn not active", data: { kind: "commandRejected", reason: "turn_not_active" } } });
			return;
		}
		if (!activeTurn || activeTurn.turnId !== msg.params.expectedTurnId) {
			send({ id: msg.id, error: { code: -32030, message: "expected turn mismatch", data: { kind: "commandRejected" } } });
			return;
		}
		const steerText = msg.params.input.map((p) => p.text ?? "").join("\\n");
		activeTurn.steers.push(steerText);
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted", turnId: activeTurn.turnId } });
		send({ method: "item/completed", params: { sessionId, item: { itemId: "us-" + msg.params.commandId, kind: "userMessage", steered: true, status: "completed", text: steerText, turnId: activeTurn.turnId } } });
	} else if (msg.method === "turn/interrupt") {
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted", turnId: activeTurn?.turnId ?? msg.params.turnId ?? "" } });
		if (activeTurn) completeTurn(activeTurn, "cancelled");
	} else if (msg.method === "session/leave") {
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted" } });
		process.exit(0);
	}
});
`,
	);
	await chmod(script, 0o755);
	return script;
}

test("uuidv7 & toMuseSessionId produce valid RFC 9562 UUIDv7s and preserve existing v7 IDs", () => {
	const v7 = uuidv7();
	assert.equal(isUuidv7(v7), true);
	assert.equal(toMuseSessionId(v7), v7);

	const v4 = "11111111-2222-4333-8444-555555555555";
	assert.equal(isUuidv7(v4), false);
	const converted = toMuseSessionId(v4);
	assert.equal(isUuidv7(converted), true);
	assert.equal(toMuseSessionId(v4), converted, "conversion must be deterministic");
});

test("parseMuseSession supports BOTH legacy muse exec JSONL and MSP v1 JSONL with live toolCall upsert deduplication", () => {
	const now = 1_700_000_000_000;
	const mixed = [
		// Legacy muse exec entries
		JSON.stringify({ received_at: now - 5000, payload: { kind: "turn_input_user", prompt: "Message from pclaw:\n\nlegacy ask" } }),
		JSON.stringify({ received_at: now - 4000, payload: { kind: "tool_call", call_id: "c1", arguments: { query: "old query" } } }),
		JSON.stringify({ received_at: now - 3500, payload: { kind: "tool_result", call_id: "c1", text: "ok", correlation_facts: { tool_name: "web_search", outcome: "success" } } }),
		JSON.stringify({ received_at: now - 3000, payload: { kind: "run_terminal", terminal: "completed", text: "legacy answer" } }),
		// MSP v1 entries (including in-progress toolCall updated to completed on same itemId)
		JSON.stringify({ received_at: now - 2000, method: "item/completed", params: { item: { itemId: "u1", kind: "userMessage", status: "completed", text: "Message from pclaw:\n\nmsp ask" } } }),
		JSON.stringify({ received_at: now - 1500, method: "item/started", params: { item: { itemId: "t1", kind: "toolCall", status: "inProgress", tool: "edit_file", args: JSON.stringify({ path: "schema.sql" }) } } }),
		JSON.stringify({ received_at: now - 1000, method: "item/completed", params: { item: { itemId: "t1", kind: "toolCall", status: "completed", tool: "edit_file", args: JSON.stringify({ path: "schema.sql" }), visibleOutput: "updated 4 lines" } } }),
		JSON.stringify({ received_at: now - 500, method: "item/completed", params: { item: { itemId: "a1", kind: "agentMessage", status: "completed", text: "msp answer" } } }),
	].join("\n");

	const items = parseMuseSession(mixed);
	assert.deepEqual(
		items.map((item) => item.kind),
		["from-pclaw", "tool", "text", "from-pclaw", "tool", "text"],
	);
	assert.equal((items[0] as { text: string }).text, "legacy ask");
	assert.equal((items[3] as { text: string }).text, "msp ask");
	const mspTool = items[4] as Extract<(typeof items)[number], { kind: "tool" }>;
	assert.equal(mspTool.name, "edit_file");
	assert.deepEqual(mspTool.args, { path: "schema.sql" });
	assert.equal(mspTool.result, "updated 4 lines");
	assert.equal(mspTool.isError, undefined);
	assert.equal((items[5] as { text: string }).text, "msp answer");

	const summary = formatWorkerProgress(items, now - 65_000, now);
	assert.equal(summary, '1m 5s, 2 tool calls — latest: web_search "old query", edit_file schema.sql');
});

test("runMuseMsp handles approval/request auto-approve, steer fallback on stale turnId, queue, and resume", async () => {
	const logFile = join(dir, "msp-unit-log.jsonl");
	const stateFile = join(dir, "msp-unit-state.json");
	const gateFile = join(dir, "msp-unit-gate.txt");
	const transcript = join(dir, "muse_unit.jsonl");
	const server = await createMockMspServer("mock-msp-unit", {
		logFile,
		stateFile,
		gateFile,
		requireApproval: true,
		rejectSteerOnce: true,
	});

	const sid = uuidv7();
	let liveHandle: LiveWorkerHandle | undefined;
	const run1Promise = runMuseMsp({
		spawnProcess: () => spawn(server, ["serve"], { stdio: ["pipe", "pipe", "pipe"] }),
		sessionId: sid,
		workspaceRoot: dir,
		model: "muse-wonder-full-1.0",
		effort: "medium",
		prompt: "initial work",
		transcript,
		resume: false,
		timeoutMs: 15_000,
		onHandle: (h) => {
			liveHandle = h;
		},
	});

	// Wait for handle to register
	const deadline = Date.now() + 5_000;
	while (liveHandle === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	assert.ok(liveHandle !== undefined, "onHandle must fire once initial turn starts");

	// First steer hits rejectSteerOnce -> falls back automatically to turn/start(ifBusy:"queue")!
	const fallbackRes = await liveHandle.steer("queued via fallback");
	assert.equal(fallbackRes.disposition, "queued");

	// Second steer succeeds natively on active turn!
	const steerRes = await liveHandle.steer("STEER_DIRECT_OK");
	assert.equal(steerRes.disposition, "steered");

	// Release gate so turn 1 (steered) + queued turn 2 both complete!
	writeFileSync(gateFile, "go\n");
	const res1 = await run1Promise;
	assert.equal(res1.ok, true);
	assert.match(res1.output, /STEERED: Message from pclaw:\n\nSTEER_DIRECT_OK/);
	assert.match(res1.output, /\[APPROVED\]/);
	assert.match(res1.output, /queued via fallback/);

	// Run 2 with resume: true calls session/resume + session/setApprovalMode(allowAll)
	const res2 = await runMuseMsp({
		spawnProcess: () => spawn(server, ["serve"], { stdio: ["pipe", "pipe", "pipe"] }),
		sessionId: sid,
		workspaceRoot: dir,
		model: "muse-wonder-full-1.0",
		effort: "high",
		prompt: "follow-up after idle",
		transcript,
		resume: true,
		timeoutMs: 15_000,
	});
	assert.equal(res2.ok, true);
	assert.match(res2.output, /follow-up after idle/);

	const loggedMethods = readFileSync(logFile, "utf8")
		.trim()
		.split("\n")
		.map((l) => (JSON.parse(l) as { method: string }).method);
	assert.ok(loggedMethods.includes("initialize"));
	assert.ok(loggedMethods.includes("initialized"));
	assert.ok(loggedMethods.includes("session/start"));
	assert.ok(loggedMethods.includes("approval/decide"));
	assert.ok(loggedMethods.includes("turn/steer"));
	assert.ok(loggedMethods.includes("session/resume"));
	assert.ok(loggedMethods.includes("session/setApprovalMode"));
});

test("workersExtension supports live message_worker steer, queue, and clean stop_worker turn/interrupt end-to-end", async () => {
	const logFile = join(dir, "ext-log.jsonl");
	const stateFile = join(dir, "ext-state.json");
	const gateFile = join(dir, "ext-gate.txt");
	const server = await createMockMspServer("mock-msp-ext", { logFile, stateFile, gateFile });

	const homeDir = join(dir, "ext-home");
	const workers: WorkerOptions = {
		command: "pi",
		museCommand: server,
		provider: MUSE,
		model: "muse-wonder-full-1.0",
		piFallback: { provider: "faux", model: "faux-1" },
		thinkingLevel: "high",
		quickThinkingLevel: "medium",
		timeoutMs: 20_000,
		cwd: join(homeDir, "work"),
		sessionDir: join(homeDir, "worker-sessions"),
		promptFile: join(process.cwd(), "src/prompts/worker.md"),
		toolsFile: join(process.cwd(), "src/worker-tools.ts"),
		cliFile: join(process.cwd(), "src/worker-cli.ts"),
		skills: [],
		allowPages: false,
	};

	const { faux, models } = setupFaux();
	const reports: string[] = [];
	faux.setResponses([
		// 1. Delegate starts gated worker
		fauxAssistantMessage([fauxText("On it."), fauxToolCall("delegate", { name: "sql", brief: "build schema", depth: "quick" })], {
			stopReason: "toolUse",
		}),
		// 2. User redirects while running -> front calls message_worker(mode="steer")
		fauxAssistantMessage([fauxText("Steered."), fauxToolCall("message_worker", { name: "sql", message: "include STEER_LIVE_42", mode: "steer" })], {
			stopReason: "toolUse",
		}),
		// 3. User queues a follow-up while running -> front calls message_worker(mode="queue")
		fauxAssistantMessage([fauxText("Queued."), fauxToolCall("message_worker", { name: "sql", message: "also add indexes", mode: "queue" })], {
			stopReason: "toolUse",
		}),
		// 4. Worker report comes back with both steered turn and queued turn!
		(req) => {
			reports.push(JSON.stringify(req.messages.at(-1)));
			return fauxAssistantMessage("Done with STEER_LIVE_42 and indexes.");
		},
		// 5. Start a second worker to test clean stop_worker -> turn/interrupt
		fauxAssistantMessage([fauxText("Starting."), fauxToolCall("delegate", { name: "cancelme", brief: "long task", depth: "quick" })], {
			stopReason: "toolUse",
		}),
		// 6. Stop it mid-run
		fauxAssistantMessage(fauxToolCall("stop_worker", { name: "cancelme" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Stopped cancelme."),
	]);

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "ext.sqlite")),
		{
			config: baseConfig(),
			models,
			notes: new Notes(join(homeDir, "notes.md")),
			workers,
			homeDir,
			memoryQuietMs: 24 * 60 * 60_000,
		},
		context,
	);
	const conv = await agent.conversationFor("telegram:dm:808", context);
	const { sent, outbox, until } = inbox();
	const delivery = await deliver(agent.harness, conv.id, outbox, context);

	try {
		await conv.submit({ type: "input", content: "build schema" }, context);
		await until(1);

		// Wait until mock MSP server has logged turn/start
		const waitLog = async (substr: string) => {
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				if (existsSync(logFile) && readFileSync(logFile, "utf8").includes(substr)) return;
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error(`timed out waiting for ${substr} in ${logFile}`);
		};
		await waitLog('"method":"turn/start"');

		// Live steer while worker is still running!
		await conv.submit({ type: "input", content: "actually include STEER_LIVE_42" }, context);
		await until(2);
		await waitLog('"method":"turn/steer"');

		// Live queue while worker is still running!
		await conv.submit({ type: "input", content: "after that, also add indexes" }, context);
		await until(3);

		// Release gate so steered turn 1 + queued turn 2 complete cleanly!
		writeFileSync(gateFile, "go\n");
		await until(4);
		assert.deepEqual(sent, ["On it.", "Steered.", "Queued.", "Done with STEER_LIVE_42 and indexes."]);
		assert.match(reports[0]!, /STEER_LIVE_42/);
		assert.match(reports[0]!, /also add indexes/);

		// Remove gate and launch `cancelme` so it blocks, then stop_worker -> verify turn/interrupt!
		await rm(gateFile, { force: true });
		await conv.submit({ type: "input", content: "start long task" }, context);
		await until(5);
		await new Promise((r) => setTimeout(r, 150));

		await conv.submit({ type: "input", content: "stop it" }, context);
		await until(6);
		await waitLog('"method":"turn/interrupt"');

		const cancelState = (await agent.harness.snapshot(Workers, conv.id, context))?.workers.cancelme;
		assert.equal(cancelState?.status, "stopped");
	} finally {
		await delivery.stop();
		await agent.harness.close(context);
	}
});

test("WorkerSandbox ssh supports live mid-turn steering over mocked SSH with resolved workspaceRoot", async () => {
	const root = join(dir, "ssh-steer");
	const vmHome = join(root, "vm-home");
	const sessionDir = join(root, "sessions");
	const logFile = join(root, "msp-log.jsonl");
	const stateFile = join(root, "msp-state.json");
	const gateFile = join(root, "gate.txt");
	mkdirSync(vmHome, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const server = await createMockMspServer("mock-msp-ssh", { logFile, stateFile, gateFile });
	const fakeSsh = join(root, "fake-ssh.sh");
	await writeFile(
		fakeSsh,
		`#!/usr/bin/env bash
set -euo pipefail
cmd="\${@: -1}"
HOME="${vmHome}" exec bash -c "$cmd"
`,
	);
	await chmod(fakeSsh, 0o755);

	const sandbox = createSshSandbox({
		host: "grug-henry.exe.xyz",
		workDir: "~/work",
		inboxDir: "~/inbox",
		museBin: server,
		sshCommand: fakeSsh,
	});

	const sid = uuidv7();
	let liveHandle: LiveWorkerHandle | undefined;
	const runPromise = sandbox.runWorker({
		sessionId: sid,
		sessionDir,
		message: "start ssh work",
		thinking: "medium",
		job: { provider: MUSE, model: "muse-wonder-full-1.0" },
		timeoutMs: 15_000,
		workerOptions: {
			command: "pi",
			museCommand: server,
			provider: MUSE,
			model: "muse-wonder-full-1.0",
			piFallback: { provider: "faux", model: "faux-1" },
			thinkingLevel: "high",
			quickThinkingLevel: "medium",
			timeoutMs: 15_000,
			cwd: root,
			sessionDir,
			promptFile: join(process.cwd(), "src/prompts/worker.md"),
			toolsFile: join(process.cwd(), "src/worker-tools.ts"),
			cliFile: join(process.cwd(), "src/worker-cli.ts"),
			skills: [],
			allowPages: false,
		},
		onHandle: (h) => {
			liveHandle = h;
		},
	});

	const deadline = Date.now() + 5_000;
	while (liveHandle === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	assert.ok(liveHandle !== undefined);

	const steer = await liveHandle.steer("SSH_STEER_99");
	assert.equal(steer.disposition, "steered");
	writeFileSync(gateFile, "go\n");

	const result = await runPromise;
	assert.equal(result.ok, true);
	assert.match(result.output, /SSH_STEER_99/);

	// Verify SSH prelude resolved `~/work` into the exact absolute remote workspaceRoot
	const saved = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, { workspaceRoot: string }>;
	assert.equal(saved[sid]?.workspaceRoot, join(vmHome, "work"));

	// Verify local MSP JSONL transcript was streamed and parses cleanly
	const parsed = parseMuseSession(readFileSync(museTranscript(sessionDir, sid), "utf8"));
	assert.ok(parsed.some((i) => i.kind === "tool" && i.name === "bash"));
	assert.ok(parsed.some((i) => i.kind === "text" && i.text.includes("SSH_STEER_99")));
});

test("runMuseMsp waits for a pure_followup successor turn after an unconsumed turn/steer instead of leaving early", async () => {
	const logFile = join(dir, "pure-followup-log.jsonl");
	const gateFile = join(dir, "pure-followup-gate.txt");
	const transcript = join(dir, "muse_pure_followup.jsonl");
	const server = join(dir, "mock-msp-pure-followup.mjs");

	// Models Muse's real late-steer behavior:
	// 1. turn/steer (commandId = X, expectedTurnId = T1) is accepted while T1 is in final generation.
	// 2. T1 emits agentMessage + turn/completed WITHOUT emitting a steered userMessage during T1.
	// 3. 35ms later, server emits turn/started with turnId = commandId = X, steered userMessage, T2 agentMessage, and T2 turn/completed.
	await writeFile(
		server,
		`#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const logFile = ${JSON.stringify(logFile)};
const gateFile = ${JSON.stringify(gateFile)};
const log = (entry) => appendFileSync(logFile, JSON.stringify(entry) + "\\n");
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");

let sessionId = "";
let t1Id = "";
let pendingFollowup = null;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method) log({ method: msg.method, at: Date.now() });

	if (msg.method === "initialize") {
		send({ id: msg.id, result: { serverInfo: { name: "mock-pure-followup", version: "1.0.0" } } });
	} else if (msg.method === "session/start") {
		sessionId = msg.params.sessionId;
		send({ id: msg.id, result: { session: { sessionId, approvalMode: { mode: "allowAll" } } } });
	} else if (msg.method === "turn/start") {
		t1Id = msg.params.commandId;
		send({ id: msg.id, result: { commandId: t1Id, disposition: "started", startedNewTurn: true, status: "accepted", turnId: t1Id } });
		send({ method: "turn/started", params: { sessionId, turnId: t1Id, commandId: t1Id } });
		const poll = setInterval(() => {
			if (!existsSync(gateFile)) return;
			clearInterval(poll);
			// T1 finishes WITHOUT emitting a steered userMessage
			send({ method: "item/completed", params: { sessionId, item: { itemId: "am-t1", kind: "agentMessage", messagePhase: "finalAnswer", status: "completed", text: "T1 initial draft (before steer).", turnId: t1Id } } });
			send({ method: "turn/completed", params: { sessionId, turnId: t1Id, terminal: "completed" } });
			// 35ms later, launch pure_followup successor turn with turnId === steer commandId
			if (pendingFollowup) {
				const f = pendingFollowup;
				pendingFollowup = null;
				setTimeout(() => {
					send({ method: "turn/started", params: { sessionId, turnId: f.commandId, commandId: f.commandId } });
					send({ method: "item/completed", params: { sessionId, item: { itemId: "um-t2", commandId: f.commandId, kind: "userMessage", steered: true, status: "completed", text: f.text, turnId: f.commandId } } });
					setTimeout(() => {
						send({ method: "item/completed", params: { sessionId, item: { itemId: "am-t2", kind: "agentMessage", messagePhase: "finalAnswer", status: "completed", text: "T2 steered pure_followup answer: TRUE_TAVERN_VERIFIED.", turnId: f.commandId } } });
						send({ method: "turn/completed", params: { sessionId, turnId: f.commandId, terminal: "completed" } });
					}, 25);
				}, 35);
			}
		}, 20);
	} else if (msg.method === "turn/steer") {
		pendingFollowup = { commandId: msg.params.commandId, text: msg.params.input.map((p) => p.text ?? "").join("\\n") };
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted", turnId: t1Id } });
	} else if (msg.method === "session/leave") {
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted" } });
		process.exit(0);
	}
});
`,
	);
	await chmod(server, 0o755);

	let liveHandle: LiveWorkerHandle | undefined;
	const runPromise = runMuseMsp({
		spawnProcess: () => spawn(server, ["serve"], { stdio: ["pipe", "pipe", "pipe"] }),
		sessionId: uuidv7(),
		workspaceRoot: dir,
		model: "muse-wonder-full-1.0",
		effort: "medium",
		prompt: "find Chicago pizza",
		transcript,
		resume: false,
		timeoutMs: 15_000,
		steerGraceMs: 2_000,
		onHandle: (h) => {
			liveHandle = h;
		},
	});

	const deadline = Date.now() + 5_000;
	while (liveHandle === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	assert.ok(liveHandle !== undefined);

	const steered = await liveHandle.steer("Only authentic steel-deck tavern style.");
	assert.equal(steered.disposition, "steered");

	// Let T1 complete without consuming the steer -> server spawns T2 35ms later
	writeFileSync(gateFile, "go\n");
	const res = await runPromise;

	assert.equal(res.ok, true);
	assert.match(res.output, /TRUE_TAVERN_VERIFIED/);

	// Verify session/leave was sent only ONCE (after T2 finished, never prematurely after T1)
	const events = readFileSync(logFile, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { method: string });
	assert.equal(events.filter((e) => e.method === "session/leave").length, 1);
	const transcriptLines = readFileSync(transcript, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { method: string });
	assert.equal(transcriptLines.filter((e) => e.method === "turn/completed").length, 2);
});

test("runMuseMsp closes cleanly after steerGraceMs and returns T1 result if no successor turn ever spawns", async () => {
	const gateFile = join(dir, "grace-fallback-gate.txt");
	const transcript = join(dir, "muse_grace_fallback.jsonl");
	const server = join(dir, "mock-msp-grace-fallback.mjs");

	// Accepts turn/steer on T1, completes T1 without emitting a steered userMessage, and NEVER starts T2.
	await writeFile(
		server,
		`#!${process.execPath}
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
const gateFile = ${JSON.stringify(gateFile)};
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
let sessionId = "";
let t1Id = "";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		send({ id: msg.id, result: { serverInfo: { name: "mock-grace", version: "1.0.0" } } });
	} else if (msg.method === "session/start") {
		sessionId = msg.params.sessionId;
		send({ id: msg.id, result: { session: { sessionId, approvalMode: { mode: "allowAll" } } } });
	} else if (msg.method === "turn/start") {
		t1Id = msg.params.commandId;
		send({ id: msg.id, result: { commandId: t1Id, disposition: "started", startedNewTurn: true, status: "accepted", turnId: t1Id } });
		send({ method: "turn/started", params: { sessionId, turnId: t1Id, commandId: t1Id } });
		const poll = setInterval(() => {
			if (!existsSync(gateFile)) return;
			clearInterval(poll);
			send({ method: "item/completed", params: { sessionId, item: { itemId: "am-t1", kind: "agentMessage", messagePhase: "finalAnswer", status: "completed", text: "T1 completed cleanly.", turnId: t1Id } } });
			send({ method: "turn/completed", params: { sessionId, turnId: t1Id, terminal: "completed" } });
		}, 20);
	} else if (msg.method === "turn/steer") {
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted", turnId: t1Id } });
	} else if (msg.method === "session/leave") {
		send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted" } });
		process.exit(0);
	}
});
`,
	);
	await chmod(server, 0o755);

	let liveHandle: LiveWorkerHandle | undefined;
	const startedAt = Date.now();
	const runPromise = runMuseMsp({
		spawnProcess: () => spawn(server, ["serve"], { stdio: ["pipe", "pipe", "pipe"] }),
		sessionId: uuidv7(),
		workspaceRoot: dir,
		model: "muse-wonder-full-1.0",
		effort: "low",
		prompt: "quick task",
		transcript,
		resume: false,
		timeoutMs: 10_000,
		steerGraceMs: 120,
		onHandle: (h) => {
			liveHandle = h;
		},
	});

	const deadline = Date.now() + 5_000;
	while (liveHandle === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	assert.ok(liveHandle !== undefined);

	await liveHandle.steer("late steer that never spawns T2");
	writeFileSync(gateFile, "go\n");

	const res = await runPromise;
	assert.equal(res.ok, true);
	assert.equal(res.output, "T1 completed cleanly.");
	assert.ok(Date.now() - startedAt < 5_000, "must close shortly after steerGraceMs instead of hanging");
});
