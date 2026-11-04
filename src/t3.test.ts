import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { attentionEvents, authorizeUrl, codeChallenge, lastAssistantText, launchedThreadId, parseProjects, parseThreads, pickTools, runT3Turn, T3Client } from "./t3-client.ts";

/** A minimal fake of T3's Streamable-HTTP MCP endpoint: initialize, tools/list, tools/call. */
async function fakeT3(threads: unknown) {
	const calls: { name: string; args: unknown }[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			const rpc = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
			const reply = (result: unknown) => {
				response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "fake-session" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
			};
			if (request.headers.authorization !== ["Bearer", "test-token"].join(" ")) {
				response.writeHead(401, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: "invalid_mcp_credential" }));
				return;
			}
			if (rpc.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-t3" } });
			if (rpc.method === "notifications/initialized") return void response.writeHead(202).end();
			if (rpc.method === "tools/list")
				return reply({
					tools: [
						{ name: "t3_thread_list", description: "List threads", inputSchema: { type: "object", properties: { projectId: { type: "string" } } } },
						{ name: "t3_thread_read", description: "Read one thread", inputSchema: { type: "object", properties: { threadId: { type: "string" }, projectId: { type: "string" } } } },
						{ name: "t3_thread_send", description: "Send a prompt", inputSchema: { type: "object", properties: { threadId: { type: "string" }, message: { type: "string" } } } },
						{ name: "t3_project_list", description: "List projects", inputSchema: { type: "object", properties: {} } },
						{ name: "t3_thread_launch", inputSchema: { type: "object", properties: { title: { type: "string" }, projectId: { type: "string" }, workspaceStrategy: { type: "object" }, message: { type: "string" } } } },
						{ name: "t3_thread_wait", inputSchema: { type: "object", properties: { threadId: { type: "string" }, timeoutMs: { type: "number" } } } },
						{ name: "t3_thread_interrupt", inputSchema: { type: "object", properties: { threadId: { type: "string" } } } },
						{ name: "t3_thread_organize", inputSchema: { type: "object", properties: { threadId: { type: "string" }, action: { type: "string" } } } },
					{ name: "t3_thread_update", inputSchema: { type: "object", properties: { threadId: { type: "string" }, action: { type: "string" }, title: { type: "string" } } } },
					{ name: "t3_thread_search", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, projectId: { type: "string" } } } },
					{ name: "t3_queue_edit", inputSchema: { type: "object", properties: { threadId: { type: "string" }, queuedRunId: { type: "string" }, text: { type: "string" } } } },
					{ name: "t3_queue_cancel", inputSchema: { type: "object", properties: { threadId: { type: "string" }, queuedRunId: { type: "string" } } } },
					{ name: "t3_project_read", inputSchema: { type: "object", properties: { projectId: { type: "string" } } } },
						{ name: "t3_project_create", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
						{ name: "orchestrator_capabilities", inputSchema: { type: "object", properties: {} } },
						{ name: "schedule_task", inputSchema: { type: "object", properties: { prompt: { type: "string" }, schedule: { type: "object" } } } },
					],
				});
			if (rpc.method === "tools/call") {
				calls.push({ name: rpc.params?.name ?? "", args: rpc.params?.arguments });
				if (rpc.params?.name === "t3_project_list")
					return reply({ content: [{ type: "text", text: JSON.stringify({ projects: [{ id: "proj-span", title: "span", workspaceRoot: "/code/span" }] }) }] });
				if (rpc.params?.name === "t3_thread_launch") return reply({ structuredContent: { thread: { id: "th-new" } } });
				if (rpc.params?.name === "t3_thread_wait") return reply({ structuredContent: { status: "completed", timedOut: false } });
				if (rpc.params?.name === "t3_thread_interrupt") return reply({ structuredContent: { ok: true } });
			if (rpc.params?.name === "t3_project_read") return reply({ structuredContent: { id: "proj-span", title: "span" } });
			if (rpc.params?.name === "t3_thread_search") return reply({ structuredContent: { threads: [{ id: "th-1" }] } });
			if (["t3_thread_update", "t3_queue_edit", "t3_queue_cancel"].includes(rpc.params?.name ?? "")) return reply({ structuredContent: { ok: true } });
				if (rpc.params?.name === "t3_thread_read")
					return reply({
						structuredContent: {
							items: [
								{ role: "user", text: "do it" },
								{ role: "assistant", text: "done: the result" },
							],
						},
					});
				return reply({ content: [{ type: "text", text: JSON.stringify(threads) }] });
			}
			response.writeHead(404).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return { url: `http://127.0.0.1:${address.port}`, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("T3 MCP client lists and reads threads through the discovered tools", async () => {
	const fake = await fakeT3({ threads: [{ id: "th-1", title: "Fix the parser", status: "running" }] });
	try {
		const client = new T3Client(fake.url, "test-token");
		const projects = await client.listProjects();
		assert.deepEqual(projects, [{ id: "proj-span", title: "span", workspaceRoot: "/code/span", raw: { id: "proj-span", title: "span", workspaceRoot: "/code/span" } }]);
		const threads = await client.listThreads({ projectId: "proj-span" });
		assert.deepEqual(threads, [{ id: "th-1", title: "Fix the parser", status: "running", raw: { id: "th-1", title: "Fix the parser", status: "running" } }]);
		assert.equal(fake.calls[0]?.name, "t3_project_list");
		assert.equal(fake.calls[1]?.name, "t3_thread_list");
		assert.deepEqual(fake.calls[1]?.args, { projectId: "proj-span" });
		await client.getThread("th-1", "proj-span");
		assert.deepEqual(fake.calls[2]?.args, { threadId: "th-1", projectId: "proj-span" });
		await assert.rejects(new T3Client(fake.url, "wrong-token").listThreads(), /invalid_mcp_credential|401/);
	} finally {
		await fake.close();
	}
});

test("tool mapping and thread parsing tolerate naming drift", () => {
	assert.deepEqual(
		pickTools([{ name: "t3_list_threads" }, { name: "thread_get" }, { name: "thread_send_message" }, { name: "t3_project_list" }]),
		{ list: "t3_list_threads", get: "thread_get", send: "thread_send_message", projectList: "t3_project_list" },
	);
	assert.equal(parseProjects({ projects: [{ id: "p1", title: "span" }] })[0]?.id, "p1");
	assert.equal(parseThreads([{ threadId: "a", state: "completed" }])[0]?.id, "a");
	assert.deepEqual(parseThreads({ nope: true }), []);
});

test("pickTools maps the full canonical T3 toolset by exact name", () => {
	const names = [
		"t3_thread_list", "t3_thread_read", "t3_thread_send", "t3_thread_update", "t3_thread_organize", "t3_thread_launch",
		"t3_thread_wait", "t3_thread_interrupt", "t3_thread_search", "t3_thread_fork", "t3_thread_merge_back",
		"t3_thread_transfers", "t3_thread_configuration", "t3_thread_configure", "t3_thread_send_attachments",
		"t3_queue_list", "t3_queue_read", "t3_queue_edit", "t3_queue_cancel", "t3_queue_reorder", "t3_queue_promote_to_steer",
		"t3_pending_request_list", "t3_pending_request_read", "t3_pending_request_respond",
		"t3_project_list", "t3_project_read", "t3_project_create", "t3_project_update", "t3_project_delete", "t3_project_clone",
		"schedule_task", "list_scheduled_tasks", "update_scheduled_task", "delete_scheduled_task", "run_scheduled_task_now",
		"delegate_task", "task_status", "task_cancel", "t3_workflow_stop", "create_threads",
		"orchestrator_capabilities", "request_secret",
		"t3_attachment_prepare_upload", "t3_attachment_discard",
		"t3_environment_read", "t3_environment_preferences_update",
		"t3_preview_list", "t3_preview_close",
		"t3_worktree_handoff", "t3_worktree_status", "t3_worktree_list",
		"link_pull_request", "unlink_pull_request", "list_thread_pull_requests", "watch_pull_request", "unwatch_pull_request",
		"write_pull_request_guides", "read_pull_request_guide",
		"device_list", "device_open", "device_close", "device_screenshot",
		"html_render", "html_preview",
		"preview_dialog", "preview_status", "preview_open", "preview_navigate", "preview_resize", "preview_set_appearance",
		"preview_click", "preview_type", "preview_hover", "preview_select", "preview_drag", "preview_upload", "preview_press",
		"preview_scroll", "preview_evaluate", "preview_wait_for", "preview_recording_start", "preview_recording_stop", "preview_snapshot",
	];
	const map = pickTools(names.map((name) => ({ name })));
	assert.equal(Object.values(map).filter((value) => value !== undefined).length, names.length, `missing: ${names.filter((n) => !Object.values(map).includes(n)).join(",")}`);
	assert.equal(map.threadLaunch, "t3_thread_launch");
	assert.equal(map.capabilities, "orchestrator_capabilities");
	assert.equal(map.previewSnapshot, "preview_snapshot");
});

test("callMapped forwards explicit arguments verbatim; launch + wait + read drives a T3 worker turn", async () => {
	const fake = await fakeT3({ threads: [] });
	try {
		const client = new T3Client(fake.url, "test-token");
		await client.callMapped("threadOrganize", { threadId: "th-1", action: "pin" });
		assert.deepEqual(fake.calls.at(-1), { name: "t3_thread_organize", args: { threadId: "th-1", action: "pin" } });
		await assert.rejects(client.callMapped("projectDelete", { projectId: "p1" }), /no .*tool|t3_status/i);
		assert.equal(launchedThreadId({ thread: { id: "x" } }), "x");
		assert.equal(launchedThreadId({ threadId: "y" }), "y");
		assert.equal(lastAssistantText({ items: [{ role: "user", text: "q" }, { role: "assistant", text: "a" }] }), "a");

		const seen: string[] = [];
		const result = await runT3Turn(client, {
			title: "job",
			message: "do it",
			projectId: "proj-span",
			workspaceStrategy: { type: "worktree", baseRef: "main", branch: "pclaw/test" },
			runtimeMode: "full-access",
			timeoutMs: 5_000,
			onThreadId: (id) => seen.push(id),
		});
		assert.deepEqual(seen, ["th-new"]);
		assert.equal(result.threadId, "th-new");
		assert.equal(result.ok, true);
		assert.match(result.output, /done: the result/);
		const launch = fake.calls.find((call) => call.name === "t3_thread_launch");
		assert.deepEqual(launch?.args, {
			title: "job",
			projectId: "proj-span",
			workspaceStrategy: { type: "worktree", baseRef: "main", branch: "pclaw/test" },
			runtimeMode: "full-access",
			message: "do it",
		});

		// Follow-up on the same thread sends instead of launching again.
		const before = fake.calls.filter((call) => call.name === "t3_thread_launch").length;
		await runT3Turn(client, { threadId: "th-new", title: "job", message: "more", timeoutMs: 5_000 });
		assert.equal(fake.calls.filter((call) => call.name === "t3_thread_launch").length, before);
		assert.deepEqual(fake.calls.find((call) => call.name === "t3_thread_send")?.args, { threadId: "th-new", message: "more" });
	} finally {
		await fake.close();
	}
});

test("thin chunk-1 methods forward explicit args to their mapped tools", async () => {
	const fake = await fakeT3({ threads: [] });
	try {
		const client = new T3Client(fake.url, "test-token");
		const last = () => fake.calls.at(-1);
		assert.deepEqual(await client.updateThread("th-1", { action: "rename", title: "New" }), { ok: true });
		assert.deepEqual(last(), { name: "t3_thread_update", args: { threadId: "th-1", action: "rename", title: "New" } });
		await client.organizeThread("th-1", { action: "snooze", snoozedUntil: "2026-11-03T09:00:00Z" });
		assert.deepEqual(last(), { name: "t3_thread_organize", args: { threadId: "th-1", action: "snooze", snoozedUntil: "2026-11-03T09:00:00Z" } });
		assert.deepEqual(await client.searchThreads({ query: "parser", limit: 5, projectId: "proj-span" }), { threads: [{ id: "th-1" }] });
		assert.deepEqual(last(), { name: "t3_thread_search", args: { query: "parser", limit: 5, projectId: "proj-span" } });
		await client.searchThreads({ query: "parser" }); // undefined optionals are dropped, not sent
		assert.deepEqual(last(), { name: "t3_thread_search", args: { query: "parser" } });
		await client.editQueuedRun("th-1", "q-1", "revised");
		assert.deepEqual(last(), { name: "t3_queue_edit", args: { threadId: "th-1", queuedRunId: "q-1", text: "revised" } });
		await client.cancelQueuedRun("th-1", "q-1");
		assert.deepEqual(last(), { name: "t3_queue_cancel", args: { threadId: "th-1", queuedRunId: "q-1" } });
		assert.deepEqual(await client.getProject("proj-span"), { id: "proj-span", title: "span" });
		assert.deepEqual(last(), { name: "t3_project_read", args: { projectId: "proj-span" } });
		const map = await client.toolMap();
		assert.equal(map.projectRead, "t3_project_read");
		assert.equal(map.queueEdit, "t3_queue_edit");
	} finally {
		await fake.close();
	}
});

test("attention fires only on a transition into waiting/finished/failed", () => {
	const before = new Map([["th-1", "running"]]);
	assert.deepEqual(attentionEvents(before, [{ id: "th-1", title: "x", status: "running", raw: {} }]), []);
	const events = attentionEvents(before, [{ id: "th-1", title: "x", status: "waiting_for_input", raw: {} }]);
	assert.equal(events.length, 1);
	assert.match(events[0]?.kind ?? "", /waiting/);
	const done = attentionEvents(new Map([["th-1", "waiting_for_input"]]), [{ id: "th-1", title: "x", status: "failed", raw: {} }]);
	assert.equal(done[0]?.kind, "failed");
});

test("PKCE challenge is the S256 of the verifier and the authorize URL carries it", () => {
	// RFC 7636 appendix B test vector.
	assert.equal(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	const url = new URL(
		authorizeUrl({
			authorizationEndpoint: "http://127.0.0.1:3773/oauth/mcp/authorize",
			clientId: "client-1",
			redirectUri: "http://127.0.0.1:7421/t3/callback",
			state: "state-1",
			challenge: "challenge-1",
			scope: "orchestration:read orchestration:operate",
			resource: "http://127.0.0.1:3773/mcp",
		}),
	);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("response_type"), "code");
});
