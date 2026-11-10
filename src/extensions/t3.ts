import { bool, lit, map, num, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import { defineDoc, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import {
	attentionEvents,
	CANONICAL_TOOLS,
	completePairing,
	loadT3Store,
	pairedClient,
	parseThreads,
	startPairing,
	threadSignature,
	type T3Project,
	type T3Thread,
	type T3ToolKey,
} from "../t3-client.ts";
import { stamp } from "../time.ts";

/**
 * T3 Code through T3's official MCP endpoint, opened to the full toolset with the owner's explicit approval:
 * every MCP tool T3 offers is reachable here without a per-operation gate, matching the full-access T3 threads
 * it talks to. The one remaining gate is the original one — sending into an existing thread stays off until
 * `t3AllowSend` is turned on in config. The typed tools below cover threads, queue, pending requests, projects,
 * scheduled tasks, delegation, PRs, environment, worktrees, preview tabs, and devices; `t3_call` reaches any
 * other (or future) MCP tool by its exact name with verbatim arguments. A few T3 tools state they need an agent
 * running inside a T3 thread (delegate_task, create_threads, worktree handoff, request_secret): they are wired
 * anyway and T3's own error comes back when that requirement bites.
 *
 * Watched threads are polled by a durable task (follow-ups only repeat daily/weekly, which is far too slow for
 * a coding thread), and a transition to waiting/finished/failed arrives here as a `<t3-thread>` input — the
 * same way a due follow-up arrives — so the front model can ping the owner in this conversation.
 */

export type T3Options = {
	t3Url: string;
	storeFile: string;
	redirectUri: string;
	allowSend: boolean;
	pollMs: number;
	timeZone: string;
};

type Watch = { title?: string; signature?: string; projectId?: string };

export const T3Watches = defineDoc<{ watches: Record<string, Watch>; poller?: string }>({
	kind: "pclaw.t3-watches",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ watches: {} }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

type PollState = { phase: "wait" } | { phase: "poll" };

const text = (value: string, isError = false) => ({ output: [{ type: "text" as const, text: value }], ...(isError ? { isError } : {}) });
const clip = (value: string, limit = 8_000) => (value.length <= limit ? value : `${value.slice(0, limit)}\n…(truncated)`);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function formatProjects(projects: T3Project[]): string {
	if (projects.length === 0) return "No T3 projects found.";
	return projects.map((project) => `- ${project.id}: ${project.title ?? "(untitled)"}${project.workspaceRoot === undefined ? "" : ` (${project.workspaceRoot})`}`).join("\n");
}

function formatThreads(threads: T3Thread[]): string {
	if (threads.length === 0) return "No T3 threads found.";
	return threads
		.map((thread) => `- ${thread.id}: ${thread.title ?? "(untitled)"} [${thread.status}]${thread.updatedAt === undefined ? "" : ` updated ${thread.updatedAt}`}`)
		.join("\n");
}

export function t3PollTask(options: T3Options) {
	return defineTask<null, PollState, null>({
		name: "pclaw.t3-poll",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				const watches = (await runtime.snapshot(T3Watches, runtime.conversationId, context))?.watches ?? {};
				await runtime.commit(async (tx) => {
					if (Object.keys(watches).length === 0) {
						const doc = await tx.doc(T3Watches, runtime.conversationId);
						if (doc.poller === String(task.id)) delete doc.poller;
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}
					return { status: "sleeping", until: Date.now() + options.pollMs, checkpoint: { phase: "poll" } };
				}, context);
			},
			poll: async (task, runtime, context) => {
				const watches = { ...((await runtime.snapshot(T3Watches, runtime.conversationId, context))?.watches ?? {}) };
				if (Object.keys(watches).length > 0) {
					try {
						const client = await pairedClient(options.t3Url, options.storeFile);
						// T3 needs a projectId to list threads; use watches' projects, else enumerate all projects.
						const known = [...new Set(Object.values(watches).flatMap((watch) => (watch.projectId === undefined ? [] : [watch.projectId])))];
						const projectIds = known.length > 0 ? known : (await client.listProjects()).map((project) => project.id);
						const threads = (await Promise.all(projectIds.map(async (projectId) => client.listThreads({ projectId }).catch(() => [] as T3Thread[]))))
							.flat()
							.filter((thread) => watches[thread.id] !== undefined);
						const previous = new Map(Object.entries(watches).flatMap(([id, watch]) => (watch.signature === undefined ? [] : [[id, watch.signature] as const])));
						const conversation = await runtime.conversation(runtime.conversationId, context);
						for (const event of attentionEvents(previous, threads)) {
							const label = event.kind === "waiting" ? "is waiting for an answer" : event.kind === "failed" ? "failed" : "finished";
							await conversation?.submit(
								{
									type: "input",
									content:
										`[${stamp(Date.now(), options.timeZone)}]\n` +
										`<t3-thread id="${event.thread.id}" status="${event.thread.status}">T3 thread "${event.thread.title ?? event.thread.id}" ${label}. ` +
										`Read it with t3_get_thread, then tell them what it needs (or that it's done), briefly.</t3-thread>`,
									whenBusy: "followUp",
									// A restart between submitting and committing must not ping twice for one transition.
									requestId: `t3:${event.thread.id}:${event.signature}`,
								},
								context,
							);
						}
						for (const thread of threads) watches[thread.id] = { ...watches[thread.id], ...(thread.title === undefined ? {} : { title: thread.title }), signature: threadSignature(thread) };
					} catch {
						// T3 down or pairing expired: stay quiet and try again next poll. t3_status reports the error on demand.
					}
				}
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(T3Watches, runtime.conversationId);
					// Keep watches added while polling; refresh signatures for the ones just seen.
					for (const [id, watch] of Object.entries(watches)) if (doc.watches[id] !== undefined) doc.watches[id] = watch;
					if (Object.keys(doc.watches).length === 0) {
						if (doc.poller === String(task.id)) delete doc.poller;
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}
					return { status: "running", checkpoint: { phase: "wait" } };
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(T3Watches, runtime.conversationId);
				if (doc.poller === String(task.id)) delete doc.poller;
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});
}

export function t3Extension(options: T3Options) {
	const Poll = t3PollTask(options);
	const client = () => pairedClient(options.t3Url, options.storeFile);
	// Shared plumbing for the full-toolset tools: explicit arguments in, T3's result (or its error) out.
	const run = async (label: string, call: (paired: Awaited<ReturnType<typeof client>>) => Promise<unknown>) => {
		try {
			const result = await call(await client());
			return text(clip(typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? "Done.")));
		} catch (error) {
			return text(`${label}: ${messageOf(error)}`, true);
		}
	};
	const mapped = (label: string, key: T3ToolKey, args: Record<string, unknown>) => run(label, (paired) => paired.callMapped(key, args));
	const literals = (...values: string[]) => union(values.map((value) => lit(value)));
	const objectArgs = map(unknown(), { description: "Exact fields for this T3 tool, passed verbatim (see t3_status for tool names; nested objects like modelSelection/workspaceStrategy/schedule go here in full)." });
	return defineExtension({
		name: "pclaw.t3",
		tasks: [Poll],
		tools: [
			defineTool({
				name: "t3_status",
				description:
					"Check the T3 Code connection: whether pclaw is paired, which MCP tools T3 offers, and whether sending is enabled. Use this first whenever they ask about T3 / coding threads and you haven't checked yet.",
				parameters: obj({}, { open: true }),
				replay: "safe",
				execute: async () => {
					const store = loadT3Store(options.storeFile);
					if (store.accessToken === undefined)
						return text(
							store.pending !== undefined
								? "T3 pairing was started but not approved yet. Use t3_start_pairing for a fresh approval link if they need one."
								: "Not paired with T3 yet. Use t3_start_pairing to get the approval link for them.",
						);
					try {
						const paired = await client();
						const tools = await paired.listTools();
						const map = await paired.toolMap();
						const mappedCount = Object.values(map).filter((value) => value !== undefined).length;
						const unmapped = tools.map((tool) => tool.name).filter((name) => !Object.values(map).includes(name));
						return text(
							`Paired with T3 at ${options.t3Url}${store.scope === undefined ? "" : ` (scope: ${store.scope})`}. ` +
								`Sending into threads is ${options.allowSend ? "enabled" : "disabled (t3AllowSend is off)"}; the rest of the full toolset is ungated.\n` +
								`Mapped ${mappedCount}/${Object.keys(CANONICAL_TOOLS).length} known tools; thread tools: list=${map.list ?? "?"}, get=${map.get ?? "?"}, send=${map.send ?? "?"}, projects=${map.projectList ?? "?"}.\n` +
								`All tools T3 offers (${tools.length}): ${tools.map((tool) => tool.name).join(", ")}` +
								(unmapped.length === 0 ? "" : `\nOffered but not mapped (still callable by exact name with t3_call): ${unmapped.join(", ")}`),
						);
					} catch (error) {
						return text(`Paired with T3, but the check failed: ${messageOf(error)}`, true);
					}
				},
			}),
			defineTool({
				name: "t3_start_pairing",
				description:
					"Start (or restart) pairing pclaw with T3 Code. Returns one approval link: give it to them verbatim and tell them to open it, sign in to T3 if asked, and approve pclaw. Read + operate scopes are requested; sending still stays off until enabled separately.",
				parameters: obj({}, { open: true }),
				execute: async () => {
					try {
						const url = await startPairing({ t3Url: options.t3Url, storeFile: options.storeFile, redirectUri: options.redirectUri });
						return text(
							`Approval link (give it to them exactly as-is):\n${url}\n` +
								`After they approve, their browser lands on pclaw's local callback and pairing finishes by itself. If that page can't load (e.g. they approved on their phone), ask them to paste the full address it tried to open, then use t3_complete_pairing with it.`,
						);
					} catch (error) {
						return text(`Couldn't start T3 pairing: ${messageOf(error)}`, true);
					}
				},
			}),
			defineTool({
				name: "t3_complete_pairing",
				description:
					"Finish T3 pairing from what they paste back: the full redirect address their browser tried to open after approving, or just its code. Only needed when the automatic callback didn't reach pclaw.",
				parameters: obj({ input: str({ description: "The pasted redirect URL or authorization code." }) }, { open: true }),
				execute: async ({ input }) => {
					try {
						let code = input.trim();
						let state: string | undefined;
						try {
							const url = new URL(code);
							code = url.searchParams.get("code") ?? code;
							state = url.searchParams.get("state") ?? undefined;
						} catch {
							// A bare code, not a URL.
						}
						const scope = await completePairing({ t3Url: options.t3Url, storeFile: options.storeFile, code, ...(state === undefined ? {} : { state }) });
						return text(`Paired with T3${scope === "" ? "" : ` (scope: ${scope})`}. Thread reading is ready; check with t3_status or t3_list_threads.`);
					} catch (error) {
						return text(`Couldn't finish T3 pairing: ${messageOf(error)}`, true);
					}
				},
			}),
			defineTool({
				name: "t3_list_projects",
				description: "List T3 Code projects with their ids and titles. Use this to find the projectId for a project they name (e.g. \"span\") before t3_list_threads.",
				parameters: obj({}, { open: true }),
				replay: "safe",
				execute: async () => {
					try {
						return text(clip(formatProjects(await (await client()).listProjects())));
					} catch (error) {
						return text(`Couldn't list T3 projects: ${messageOf(error)}`, true);
					}
				},
			}),
			defineTool({
				name: "t3_list_threads",
				description:
					"List T3 Code coding threads (recent first, as T3 returns them) with ids, titles, and statuses. Pass projectId (from t3_list_projects): T3 rejects a bare list with target_required.",
				parameters: obj({ projectId: opt(str({ description: "Project id from t3_list_projects." })) }, { open: true }),
				replay: "safe",
				execute: async ({ projectId }) => {
					try {
						return text(clip(formatThreads(await (await client()).listThreads(projectId === undefined ? {} : { projectId }))));
					} catch (error) {
						return text(`Couldn't list T3 threads: ${messageOf(error)}`, true);
					}
				},
			}),
			defineTool({
				name: "t3_get_thread",
				description: "Read one T3 thread by id (from t3_list_threads): status and recent messages, as T3 returns them. Pass projectId too when you know it.",
				parameters: obj({ threadId: str(), projectId: opt(str()) }, { open: true }),
				replay: "safe",
				execute: async ({ threadId, projectId }) => {
					try {
						const result = await (await client()).getThread(threadId, projectId);
						return text(clip(typeof result === "string" ? result : JSON.stringify(result, null, 2)));
					} catch (error) {
						return text(`Couldn't read T3 thread ${threadId}: ${messageOf(error)}`, true);
					}
				},
			}),
			defineTool({
				name: "t3_watch_thread",
				description:
					"Watch a T3 thread: pclaw polls it and you'll be woken here when it starts waiting for an answer, finishes, or fails, so you can tell them. Use when they ask to be kept posted on a thread.",
				parameters: obj({ threadId: str(), projectId: opt(str()) }, { open: true }),
				execute: async ({ threadId, projectId }, api, context) => {
					let baseline: Watch = { ...(projectId === undefined ? {} : { projectId }) };
					try {
						const seen =
							parseThreads(await (await client()).getThread(threadId, projectId))[0] ??
							(projectId === undefined ? undefined : (await (await client()).listThreads({ projectId })).find((thread) => thread.id === threadId));
						if (seen !== undefined) baseline = { ...baseline, ...(seen.title === undefined ? {} : { title: seen.title }), signature: threadSignature(seen) };
					} catch (error) {
						return text(`Couldn't watch T3 thread ${threadId}: ${messageOf(error)}`, true);
					}
					await api.commit(async (tx) => {
						const doc = await tx.doc(T3Watches, api.conversationId);
						doc.watches[threadId] = baseline;
						doc.poller ??= String(await tx.createTask(Poll, null, { ownership: { kind: "conversation" }, background: true }));
					}, context);
					return text(`Watching T3 thread ${baseline.title ?? threadId}. I'll be woken here when it needs an answer, finishes, or fails.`);
				},
			}),
			defineTool({
				name: "t3_unwatch_thread",
				description: "Stop watching a T3 thread.",
				parameters: obj({ threadId: str() }, { open: true }),
				execute: async ({ threadId }, api, context) => {
					const found = await api.commit(async (tx) => {
						const doc = await tx.doc(T3Watches, api.conversationId);
						if (doc.watches[threadId] === undefined) return false;
						delete doc.watches[threadId];
						return true;
					}, context);
					return text(found ? `Stopped watching T3 thread ${threadId}.` : `T3 thread ${threadId} wasn't being watched.`);
				},
			}),
			defineTool({
				name: "t3_list_watches",
				description: "List the T3 threads being watched in this conversation.",
				parameters: obj({}, { open: true }),
				replay: "safe",
				execute: async (_args, api, context) => {
					const watches = Object.entries((await api.snapshot(T3Watches, api.conversationId, context))?.watches ?? {});
					if (watches.length === 0) return text("No T3 threads are being watched.");
					return text(watches.map(([id, watch]) => `- ${id}: ${watch.title ?? "(untitled)"}`).join("\n"));
				},
			}),
			defineTool({
				name: "t3_send_message",
				description:
					"Send a message into a T3 thread on their behalf. Only when they have explicitly said to send this message to this thread. Never use it to start new work unasked.",
				parameters: obj({
					threadId: str(),
					message: str(),
					mode: opt(literals("auto", "queue", "steer", "restart")),
					clientRequestId: opt(str({ description: "Reuse when retrying a send that lost its result, so T3 doesn't deliver it twice." })),
				}, { open: true }),
				execute: async ({ threadId, message, mode, clientRequestId }) => {
					if (!options.allowSend)
						return text(
							"Sending into T3 threads is not enabled yet (t3AllowSend is off in pclaw's config), so nothing was sent. Tell them what you would send and let them decide.",
							true,
						);
					try {
						await (await client()).sendMessage(threadId, message, {
							...(mode === undefined ? {} : { mode: mode as "auto" | "queue" | "steer" | "restart" }),
							...(clientRequestId === undefined ? {} : { clientRequestId }),
						});
						return text(`Sent to T3 thread ${threadId}.`);
					} catch (error) {
						return text(`Couldn't send to T3 thread ${threadId}: ${messageOf(error)}`, true);
					}
				},
			}),
			defineTool({
				name: "t3_capabilities",
				description: "List T3's provider instances, models, and orchestration features (orchestrator_capabilities). Use it to pick a modelSelection/target before launching, configuring, or delegating.",
				parameters: obj({}, { open: true }),
				replay: "safe",
				execute: async () => mapped("Couldn't read T3 capabilities", "capabilities", {}),
			}),
			defineTool({
				name: "t3_launch_thread",
				description:
					"Start a new top-level T3 thread (t3_thread_launch) and optionally give it its first message. Pick the workspace explicitly: workspaceStrategy {type:\"worktree\",baseRef,branch?,startFromOrigin?} for a fresh checkout, {type:\"existing_worktree\",worktreePath,branch?}, or {type:\"root\",branch?} for the project checkout (the default when omitted). scratch=true starts project-less instead of projectId. modelSelection is {model, provider?, instanceId?, options?} from t3_capabilities. Returns the launch result including the new thread id.",
				parameters: obj({
					title: str(),
					projectId: opt(str()),
					scratch: opt(bool()),
					message: opt(str({ description: "First prompt; omit to create an idle thread." })),
					runtimeMode: opt(literals("approval-required", "auto-accept-edits", "auto", "full-access")),
					interactionMode: opt(literals("default", "plan")),
					workspaceStrategy: opt(unknown()),
					modelSelection: opt(unknown()),
					attachments: opt(unknown()),
				}, { open: true }),
				execute: async (args) => mapped("Couldn't launch T3 thread", "threadLaunch", { ...args }),
			}),
			defineTool({
				name: "t3_thread_update",
				description: "Update a thread's metadata (t3_thread_update): rename (with title), regenerate_title, link_pull_request (with pullRequest {repository,number,url}), or unlink_pull_request.",
				parameters: obj({
					threadId: str(),
					action: literals("rename", "regenerate_title", "link_pull_request", "unlink_pull_request"),
					title: opt(str()),
					pullRequest: opt(unknown()),
					clientRequestId: opt(str()),
				}, { open: true }),
				execute: async (args) => mapped("Couldn't update T3 thread", "threadUpdate", { ...args }),
			}),
			defineTool({
				name: "t3_thread_organize",
				description: "Organize a thread (t3_thread_organize): pin, unpin, snooze (requires snoozedUntil, an ISO time), unsnooze, settle, unsettle, archive, unarchive, or mark_unread.",
				parameters: obj({
					threadId: str(),
					action: literals("pin", "unpin", "snooze", "unsnooze", "settle", "unsettle", "archive", "unarchive", "mark_unread"),
					snoozedUntil: opt(str()),
				}, { open: true }),
				execute: async (args) => mapped("Couldn't organize T3 thread", "threadOrganize", { ...args }),
			}),
			defineTool({
				name: "t3_thread_wait",
				description: "Wait for a thread's run to reach a terminal state (t3_thread_wait). A timeout doesn't interrupt the work; call again or read the thread. Defaults to a 2-minute wait when timeoutMs is omitted.",
				parameters: obj({ threadId: str(), runId: opt(str()), timeoutMs: opt(num()) }, { open: true }),
				replay: "safe",
				execute: async ({ threadId, runId, timeoutMs }) => run("Couldn't wait on T3 thread", (paired) => paired.waitThread(threadId, { runId, timeoutMs: timeoutMs ?? 120_000 })),
			}),
			defineTool({
				name: "t3_thread_interrupt",
				description: "Interrupt a thread's running turn (t3_thread_interrupt).",
				parameters: obj({ threadId: str(), runId: opt(str()), reason: opt(str()), clientRequestId: opt(str()) }, { open: true }),
				execute: async ({ threadId, runId, reason, clientRequestId }) => run("Couldn't interrupt T3 thread", (paired) => paired.interruptThread(threadId, { runId, reason, clientRequestId })),
			}),
			defineTool({
				name: "t3_thread_search",
				description: "Search T3 threads by text (t3_thread_search), optionally within one project.",
				parameters: obj({ query: str(), limit: opt(num()), projectId: opt(str()) }, { open: true }),
				replay: "safe",
				execute: async (args) => mapped("Couldn't search T3 threads", "threadSearch", { ...args }),
			}),
			defineTool({
				name: "t3_thread_fork",
				description: "Fork a thread (t3_thread_fork). sourcePoint is {type:\"latest_stable\"}, {type:\"run\",runId}, or {type:\"checkpoint\",checkpointId}.",
				parameters: obj({ threadId: str(), sourcePoint: unknown(), title: opt(str()) }, { open: true }),
				execute: async (args) => mapped("Couldn't fork T3 thread", "threadFork", { ...args }),
			}),
			defineTool({
				name: "t3_thread_merge_back",
				description: "Merge one thread's context back into a related thread in the same project (t3_thread_merge_back). sourcePoint is {type:\"latest_stable\"}, {type:\"run\",runId}, or {type:\"checkpoint\",checkpointId}.",
				parameters: obj({ sourceThreadId: str(), targetThreadId: str(), sourcePoint: unknown() }, { open: true }),
				execute: async (args) => mapped("Couldn't merge T3 thread back", "threadMergeBack", { ...args }),
			}),
			defineTool({
				name: "t3_thread_configuration",
				description: "Read a thread's configuration (t3_thread_configuration), or with kind=transfers list its fork/merge transfers (t3_thread_transfers).",
				parameters: obj({ threadId: str(), kind: opt(literals("configuration", "transfers")) }, { open: true }),
				replay: "safe",
				execute: async ({ threadId, kind }) => mapped("Couldn't read T3 thread configuration", kind === "transfers" ? "threadTransfers" : "threadConfiguration", { threadId }),
			}),
			defineTool({
				name: "t3_thread_configure",
				description: "Set a thread's provider/model (t3_thread_configure). modelSelection is {model, provider?, instanceId?, options?} from t3_capabilities. Does not change permission modes.",
				parameters: obj({ threadId: str(), modelSelection: unknown() }, { open: true }),
				execute: async (args) => mapped("Couldn't configure T3 thread", "threadConfigure", { ...args }),
			}),
			defineTool({
				name: "t3_queue",
				description:
					"Work a thread's queued runs: list (t3_queue_list), read (t3_queue_read, queuedRunId), edit (t3_queue_edit, queuedRunId+text), cancel (t3_queue_cancel, queuedRunId), reorder (t3_queue_reorder, queuedRunId+beforeRunId, or toEnd=true to move it last), promote (t3_queue_promote_to_steer, queuedRunId+targetRunId: deliver it as steering to the active run).",
				parameters: obj({
					action: literals("list", "read", "edit", "cancel", "reorder", "promote"),
					threadId: str(),
					queuedRunId: opt(str()),
					text: opt(str()),
					beforeRunId: opt(str()),
					toEnd: opt(bool()),
					targetRunId: opt(str()),
					cursor: opt(num()),
					limit: opt(num()),
				}, { open: true }),
				execute: async ({ action, threadId, queuedRunId, text: newText, beforeRunId, toEnd, targetRunId, cursor, limit }) => {
					const key = { list: "queueList", read: "queueRead", edit: "queueEdit", cancel: "queueCancel", reorder: "queueReorder", promote: "queuePromote" }[action] as T3ToolKey;
					const args: Record<string, unknown> = { threadId, queuedRunId, text: newText, targetRunId, cursor, limit };
					// Reorder explicitly names the end position with beforeRunId:null; compactArgs keeps null, drops undefined.
					if (action === "reorder") args.beforeRunId = toEnd === true ? null : beforeRunId;
					return mapped("Couldn't work the T3 queue", key, args);
				},
			}),
			defineTool({
				name: "t3_pending_requests",
				description:
					"A thread's pending user-input requests: list (t3_pending_request_list), read (t3_pending_request_read, requestId), respond (t3_pending_request_respond, requestId+answers as the exact answers object the request asks for). Responding answers questions; it cannot approve a permission request.",
				parameters: obj({
					action: literals("list", "read", "respond"),
					threadId: str(),
					requestId: opt(str()),
					answers: opt(unknown()),
				}, { open: true }),
				execute: async ({ action, threadId, requestId, answers }) => {
					const key = { list: "pendingList", read: "pendingRead", respond: "pendingRespond" }[action] as T3ToolKey;
					return mapped("Couldn't work T3 pending requests", key, { threadId, requestId, answers });
				},
			}),
			defineTool({
				name: "t3_project",
				description:
					"Project operations beyond listing: read (t3_project_read, projectId), create (t3_project_create, title + optional workspaceRoot; omit workspaceRoot to get a fresh repo in T3's projects folder), update (t3_project_update, projectId + changed fields only), delete (t3_project_delete, projectId, force only when they insist), clone (t3_project_clone, destinationPath + remoteUrl or repository; register the result with create afterwards). Extra exact update fields (projectIcon, faviconPath, scripts, defaultThreadEnvMode…) go in `fields`, passed verbatim.",
				parameters: obj({
					action: literals("read", "create", "update", "delete", "clone"),
					projectId: opt(str()),
					title: opt(str()),
					workspaceRoot: opt(str()),
					createWorkspaceRootIfMissing: opt(bool()),
					defaultModelSelection: opt(unknown()),
					scripts: opt(unknown()),
					autoPull: opt(bool()),
					force: opt(bool()),
					destinationPath: opt(str()),
					remoteUrl: opt(str()),
					repository: opt(str()),
					provider: opt(str()),
					protocol: opt(literals("auto", "ssh", "https")),
					fields: opt(objectArgs),
				}, { open: true }),
				execute: async ({ action, fields, ...rest }) => {
					const key = { read: "projectRead", create: "projectCreate", update: "projectUpdate", delete: "projectDelete", clone: "projectClone" }[action] as T3ToolKey;
					return mapped("Couldn't work the T3 project", key, { ...rest, ...(fields ?? {}) });
				},
			}),
			defineTool({
				name: "t3_scheduled_tasks",
				description:
					"T3's persistent scheduler: create (schedule_task: prompt + schedule as a structured object — {type:\"interval\",everyMs} (min 60000), {type:\"fixed_time\",timeOfDay:\"09:00\",weekdays?} with 0=Sunday, or {type:\"webhook\",signature?,maxDeliveryAgeMinutes?}), list (list_scheduled_tasks), update (update_scheduled_task: scheduledTaskId + changed fields; enabled=false pauses), delete (delete_scheduled_task), run_now (run_scheduled_task_now: pass the id as scheduledTaskId). Webhook runs see the request only through {{body…}}/{{headers…}}/{{query…}} placeholders in the prompt.",
				parameters: obj({
					action: literals("create", "list", "update", "delete", "run_now"),
					scheduledTaskId: opt(str()),
					projectId: opt(str()),
					prompt: opt(str()),
					title: opt(str()),
					schedule: opt(unknown()),
					enabled: opt(bool()),
					bindToCurrentThread: opt(bool()),
					clientRequestId: opt(str()),
				}, { open: true }),
				execute: async ({ action, scheduledTaskId, ...rest }) => {
					if (action === "run_now") return mapped("Couldn't run the T3 scheduled task", "scheduledRunNow", { taskId: scheduledTaskId });
					const key = { create: "scheduleTask", list: "scheduledList", update: "scheduledUpdate", delete: "scheduledDelete" }[action] as T3ToolKey;
					return mapped("Couldn't work T3 scheduled tasks", key, { scheduledTaskId, ...rest });
				},
			}),
			defineTool({
				name: "t3_delegate_task",
				description:
					"Delegate one task to a T3-owned child agent (delegate_task). target is {providerInstanceId?, driverKind?, model?, options?} from t3_capabilities; mode=wait blocks for the child's result. T3 says this needs an agent running inside a T3 thread — from pclaw it may come back with T3's error saying so; t3_launch_thread is the reliable way to start independent top-level work.",
				parameters: obj({
					task: str(),
					target: opt(unknown()),
					title: opt(str()),
					role: opt(literals("implementation", "research", "review", "design", "test", "general")),
					isolation: opt(literals("shared", "worktree")),
					mode: opt(literals("async", "wait")),
					timeoutMs: opt(num()),
					runtimeMode: opt(literals("inherit", "approval-required", "auto-accept-edits", "auto", "full-access")),
					interactionMode: opt(literals("inherit", "default", "plan")),
					clientRequestId: opt(str()),
				}, { open: true }),
				execute: async (args) => mapped("Couldn't delegate the T3 task", "delegateTask", { ...args }),
			}),
			defineTool({
				name: "t3_task",
				description: "Check or stop delegated/scheduled work: status (task_status, taskId), cancel (task_cancel, taskId, optional reason), workflow_stop (t3_workflow_stop: stop a subagent inside a thread, threadId+subagentId).",
				parameters: obj({
					action: literals("status", "cancel", "workflow_stop"),
					taskId: opt(str()),
					threadId: opt(str()),
					subagentId: opt(str()),
					reason: opt(str()),
					clientRequestId: opt(str()),
				}, { open: true }),
				execute: async ({ action, taskId, threadId, subagentId, reason, clientRequestId }) => {
					if (action === "workflow_stop") return mapped("Couldn't stop the T3 subagent", "workflowStop", { threadId, subagentId });
					return mapped("Couldn't work the T3 task", action === "status" ? "taskStatus" : "taskCancel", { taskId, reason, clientRequestId });
				},
			}),
			defineTool({
				name: "t3_create_threads",
				description:
					"Create a batch of ordinary top-level threads sharing one checkout (create_threads, 1–20). threads is an array of {prompt?, title?, target? {providerInstanceId?,driverKind?,model?,options?}, runtimeMode?, interactionMode?}. T3 says this needs an agent inside a T3 thread; for a single thread prefer t3_launch_thread.",
				parameters: obj({ threads: unknown(), clientRequestId: opt(str()) }, { open: true }),
				execute: async (args) => mapped("Couldn't create T3 threads", "createThreads", { ...args }),
			}),
			defineTool({
				name: "t3_pull_requests",
				description:
					"Pull requests tied to threads: link (link_pull_request), unlink (unlink_pull_request), list a thread's PRs (list_thread_pull_requests, threadId), watch (watch_pull_request), unwatch (unwatch_pull_request), read_guide (read_pull_request_guide), write_guides (write_pull_request_guides: pass the full pullRequests array in `fields` under that name, each entry as T3's schema asks). Identify a PR by url, or repository+number (+host when not github.com).",
				parameters: obj({
					action: literals("link", "unlink", "list", "watch", "unwatch", "read_guide", "write_guides"),
					threadId: opt(str()),
					url: opt(str()),
					repository: opt(str()),
					number: opt(num()),
					host: opt(str()),
					fields: opt(objectArgs),
				}, { open: true }),
				execute: async ({ action, fields, ...rest }) => {
					const key = { link: "linkPullRequest", unlink: "unlinkPullRequest", list: "listThreadPullRequests", watch: "watchPullRequest", unwatch: "unwatchPullRequest", read_guide: "readPullRequestGuide", write_guides: "writePullRequestGuides" }[action] as T3ToolKey;
					return mapped("Couldn't work T3 pull requests", key, { ...rest, ...(fields ?? {}) });
				},
			}),
			defineTool({
				name: "t3_environment",
				description:
					"T3 environment settings: read (t3_environment_read) or update preferences (t3_environment_preferences_update: defaultThreadEnvMode local|worktree, newWorktreesStartFromOrigin, enableProviderUpdateChecks, backgroundActivity {profile: balanced|performance|battery-saver}, sourceControlWritingStyle {mode: repo_conventions|conventional_commits|custom, customInstructions?, followChangeRequestTemplates?}). Omitted fields stay as they are. T3 may require a live full-access calling thread for updates.",
				parameters: obj({
					action: literals("read", "update"),
					defaultThreadEnvMode: opt(literals("local", "worktree")),
					newWorktreesStartFromOrigin: opt(bool()),
					enableProviderUpdateChecks: opt(bool()),
					backgroundActivity: opt(unknown()),
					sourceControlWritingStyle: opt(unknown()),
				}, { open: true }),
				execute: async ({ action, ...rest }) => mapped("Couldn't work the T3 environment", action === "read" ? "environmentRead" : "environmentPreferencesUpdate", action === "read" ? {} : { ...rest }),
			}),
			defineTool({
				name: "t3_worktrees",
				description:
					"Git worktrees: status (t3_worktree_status), list (t3_worktree_list: threadId?/query?/refKind? in fields, cursor/limit), handoff (t3_worktree_handoff: move the calling agent thread into a new worktree on branch, optional baseRef/startFromOrigin/runSetupScript/continuationPrompt — needs an agent inside a T3 thread, so from pclaw it may return T3's error; launch with workspaceStrategy worktree instead for new work).",
				parameters: obj({
					action: literals("status", "list", "handoff"),
					threadId: opt(str()),
					query: opt(str()),
					branch: opt(str()),
					baseRef: opt(str()),
					startFromOrigin: opt(bool()),
					runSetupScript: opt(bool()),
					continuationPrompt: opt(str()),
					cursor: opt(num()),
					limit: opt(num()),
					fields: opt(objectArgs),
				}, { open: true }),
				execute: async ({ action, fields, ...rest }) => {
					const key = { status: "worktreeStatus", list: "worktreeList", handoff: "worktreeHandoff" }[action] as T3ToolKey;
					return mapped("Couldn't work T3 worktrees", key, { ...rest, ...(fields ?? {}) });
				},
			}),
			defineTool({
				name: "t3_request_secret",
				description:
					"Ask them for a secret through T3's private card (request_secret). The value never comes back to you or into the transcript; the result carries a one-use secretRef to pass where T3 accepts one (e.g. a webhook schedule's signature.secretRef via t3_scheduled_tasks/t3_call). Never ask for secrets in chat instead.",
				parameters: obj({
					label: str(),
					reason: str(),
					placeholder: opt(str()),
					timeoutMs: opt(num()),
					clientRequestId: opt(str()),
				}, { open: true }),
				execute: async (args) => mapped("Couldn't request the secret through T3", "requestSecret", { ...args }),
			}),
			defineTool({
				name: "t3_preview",
				description:
					"T3's collaborative browser preview (the preview_* tools plus t3_preview_list/close). action: list, close (tabId), status, open, navigate, resize (mode + preset/width/height… in fields), set_appearance (colorScheme in fields), click, type (text), hover, select (values in fields), drag (source/target in fields), upload (paths in fields), press (key, modifiers in fields), scroll, evaluate (expression), wait_for, recording_start, recording_stop, snapshot, dialog (accept in fields, promptText?). Common fields: tabId, url, selector, locator (aria-ref=<ref> from a snapshot), text, key, expression, x, y, timeoutMs. Anything else for the chosen action goes in `fields`, verbatim. Snapshot first to see the page and get element refs.",
				parameters: obj({
					action: literals("list", "close", "status", "open", "navigate", "resize", "set_appearance", "click", "type", "hover", "select", "drag", "upload", "press", "scroll", "evaluate", "wait_for", "recording_start", "recording_stop", "snapshot", "dialog"),
					tabId: opt(str()),
					url: opt(str()),
					selector: opt(str()),
					locator: opt(str()),
					text: opt(str()),
					key: opt(str()),
					expression: opt(str()),
					x: opt(num()),
					y: opt(num()),
					timeoutMs: opt(num()),
					fields: opt(objectArgs),
				}, { open: true }),
				execute: async ({ action, fields, ...rest }) => {
					const key = {
						list: "previewList", close: "previewClose", status: "previewStatus", open: "previewOpen", navigate: "previewNavigate",
						resize: "previewResize", set_appearance: "previewSetAppearance", click: "previewClick", type: "previewType",
						hover: "previewHover", select: "previewSelect", drag: "previewDrag", upload: "previewUpload", press: "previewPress",
						scroll: "previewScroll", evaluate: "previewEvaluate", wait_for: "previewWaitFor",
						recording_start: "previewRecordingStart", recording_stop: "previewRecordingStop", snapshot: "previewSnapshot", dialog: "previewDialog",
					}[action] as T3ToolKey;
					return mapped("Couldn't work the T3 preview", key, { ...rest, ...(fields ?? {}) });
				},
			}),
			defineTool({
				name: "t3_device",
				description: "Devices/simulators T3 can drive: list (device_list, optional hostId), open (device_open: deviceId or platform, hostId?), close (device_close: deviceId?, hostId?, shutdown?), screenshot (device_screenshot: deviceId?, hostId?).",
				parameters: obj({
					action: literals("list", "open", "close", "screenshot"),
					deviceId: opt(str()),
					platform: opt(str()),
					hostId: opt(str()),
					shutdown: opt(bool()),
				}, { open: true }),
				execute: async ({ action, ...rest }) => {
					const key = { list: "deviceList", open: "deviceOpen", close: "deviceClose", screenshot: "deviceScreenshot" }[action] as T3ToolKey;
					return mapped("Couldn't work the T3 device", key, { ...rest });
				},
			}),
			defineTool({
				name: "t3_attachments",
				description:
					"Thread attachments: prepare (t3_attachment_prepare_upload: upload {type:\"image\"|\"file\",name,mimeType,sizeBytes} → a signed upload URL; the bytes must still be POSTed to that URL by a worker with a shell before sending), discard (t3_attachment_discard, attachmentId), send (t3_thread_send_attachments: threadId, optional message, attachments [{type,id,name,mimeType,sizeBytes}] from uploads that completed).",
				parameters: obj({
					action: literals("prepare", "discard", "send"),
					upload: opt(unknown()),
					attachmentId: opt(str()),
					threadId: opt(str()),
					message: opt(str()),
					attachments: opt(unknown()),
				}, { open: true }),
				execute: async ({ action, ...rest }) => {
					const key = { prepare: "attachmentPrepare", discard: "attachmentDiscard", send: "sendAttachments" }[action] as T3ToolKey;
					return mapped("Couldn't work T3 attachments", key, { ...rest });
				},
			}),
			defineTool({
				name: "t3_html",
				description: "Render HTML inline in T3: render (html_render: html, title, height) puts a titled block in a thread; preview (html_preview: html, optional width/appearance) returns a rendered preview.",
				parameters: obj({
					action: literals("render", "preview"),
					html: str(),
					title: opt(str()),
					height: opt(num()),
					width: opt(num()),
					appearance: opt(str()),
				}, { open: true }),
				execute: async ({ action, ...rest }) => mapped("Couldn't render HTML through T3", action === "render" ? "htmlRender" : "htmlPreview", { ...rest }),
			}),
			defineTool({
				name: "t3_call",
				description:
					"Call any T3 MCP tool by its exact name (from t3_status) with arguments passed verbatim. Use it for tools or fields the typed t3_* tools don't surface, or when T3 adds something new. Ungated, like the rest of the opened-up toolset — pass exactly what the tool's schema asks for; nothing is renamed or guessed.",
				parameters: obj({ tool: str({ description: "Exact MCP tool name, e.g. t3_thread_launch." }), arguments: opt(objectArgs) }, { open: true }),
				execute: async ({ tool, arguments: args }) => run(`Couldn't call T3 tool ${tool}`, (paired) => paired.callTool(tool, args ?? {})),
			}),
		],
	});
}
