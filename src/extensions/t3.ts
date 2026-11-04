import { Type } from "@earendil-works/pi-ai";
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
	const literals = (...values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
	const objectArgs = Type.Record(Type.String(), Type.Unknown(), { description: "Exact fields for this T3 tool, passed verbatim (see t3_status for tool names; nested objects like modelSelection/workspaceStrategy/schedule go here in full)." });
	return defineExtension({
		name: "pclaw.t3",
		tasks: [Poll],
		tools: [
			defineTool({
				name: "t3_status",
				description:
					"Check the T3 Code connection: whether pclaw is paired, which MCP tools T3 offers, and whether sending is enabled. Use this first whenever they ask about T3 / coding threads and you haven't checked yet.",
				parameters: Type.Object({}),
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
				parameters: Type.Object({}),
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
				parameters: Type.Object({ input: Type.String({ description: "The pasted redirect URL or authorization code." }) }),
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
				parameters: Type.Object({}),
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
				parameters: Type.Object({ projectId: Type.Optional(Type.String({ description: "Project id from t3_list_projects." })) }),
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
				parameters: Type.Object({ threadId: Type.String(), projectId: Type.Optional(Type.String()) }),
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
				parameters: Type.Object({ threadId: Type.String(), projectId: Type.Optional(Type.String()) }),
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
				parameters: Type.Object({ threadId: Type.String() }),
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
				parameters: Type.Object({}),
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
				parameters: Type.Object({
					threadId: Type.String(),
					message: Type.String(),
					mode: Type.Optional(literals("auto", "queue", "steer", "restart")),
					clientRequestId: Type.Optional(Type.String({ description: "Reuse when retrying a send that lost its result, so T3 doesn't deliver it twice." })),
				}),
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
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => mapped("Couldn't read T3 capabilities", "capabilities", {}),
			}),
			defineTool({
				name: "t3_launch_thread",
				description:
					"Start a new top-level T3 thread (t3_thread_launch) and optionally give it its first message. Pick the workspace explicitly: workspaceStrategy {type:\"worktree\",baseRef,branch?,startFromOrigin?} for a fresh checkout, {type:\"existing_worktree\",worktreePath,branch?}, or {type:\"root\",branch?} for the project checkout (the default when omitted). scratch=true starts project-less instead of projectId. modelSelection is {model, provider?, instanceId?, options?} from t3_capabilities. Returns the launch result including the new thread id.",
				parameters: Type.Object({
					title: Type.String(),
					projectId: Type.Optional(Type.String()),
					scratch: Type.Optional(Type.Boolean()),
					message: Type.Optional(Type.String({ description: "First prompt; omit to create an idle thread." })),
					runtimeMode: Type.Optional(literals("approval-required", "auto-accept-edits", "auto", "full-access")),
					interactionMode: Type.Optional(literals("default", "plan")),
					workspaceStrategy: Type.Optional(Type.Any()),
					modelSelection: Type.Optional(Type.Any()),
					attachments: Type.Optional(Type.Any()),
				}),
				execute: async (args) => mapped("Couldn't launch T3 thread", "threadLaunch", { ...args }),
			}),
			defineTool({
				name: "t3_thread_update",
				description: "Update a thread's metadata (t3_thread_update): rename (with title), regenerate_title, link_pull_request (with pullRequest {repository,number,url}), or unlink_pull_request.",
				parameters: Type.Object({
					threadId: Type.String(),
					action: literals("rename", "regenerate_title", "link_pull_request", "unlink_pull_request"),
					title: Type.Optional(Type.String()),
					pullRequest: Type.Optional(Type.Any()),
					clientRequestId: Type.Optional(Type.String()),
				}),
				execute: async (args) => mapped("Couldn't update T3 thread", "threadUpdate", { ...args }),
			}),
			defineTool({
				name: "t3_thread_organize",
				description: "Organize a thread (t3_thread_organize): pin, unpin, snooze (requires snoozedUntil, an ISO time), unsnooze, settle, unsettle, archive, unarchive, or mark_unread.",
				parameters: Type.Object({
					threadId: Type.String(),
					action: literals("pin", "unpin", "snooze", "unsnooze", "settle", "unsettle", "archive", "unarchive", "mark_unread"),
					snoozedUntil: Type.Optional(Type.String()),
				}),
				execute: async (args) => mapped("Couldn't organize T3 thread", "threadOrganize", { ...args }),
			}),
			defineTool({
				name: "t3_thread_wait",
				description: "Wait for a thread's run to reach a terminal state (t3_thread_wait). A timeout doesn't interrupt the work; call again or read the thread. Defaults to a 2-minute wait when timeoutMs is omitted.",
				parameters: Type.Object({ threadId: Type.String(), runId: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Number()) }),
				replay: "safe",
				execute: async ({ threadId, runId, timeoutMs }) => run("Couldn't wait on T3 thread", (paired) => paired.waitThread(threadId, { runId, timeoutMs: timeoutMs ?? 120_000 })),
			}),
			defineTool({
				name: "t3_thread_interrupt",
				description: "Interrupt a thread's running turn (t3_thread_interrupt).",
				parameters: Type.Object({ threadId: Type.String(), runId: Type.Optional(Type.String()), reason: Type.Optional(Type.String()), clientRequestId: Type.Optional(Type.String()) }),
				execute: async ({ threadId, runId, reason, clientRequestId }) => run("Couldn't interrupt T3 thread", (paired) => paired.interruptThread(threadId, { runId, reason, clientRequestId })),
			}),
			defineTool({
				name: "t3_thread_search",
				description: "Search T3 threads by text (t3_thread_search), optionally within one project.",
				parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()), projectId: Type.Optional(Type.String()) }),
				replay: "safe",
				execute: async (args) => mapped("Couldn't search T3 threads", "threadSearch", { ...args }),
			}),
			defineTool({
				name: "t3_thread_fork",
				description: "Fork a thread (t3_thread_fork). sourcePoint is {type:\"latest_stable\"}, {type:\"run\",runId}, or {type:\"checkpoint\",checkpointId}.",
				parameters: Type.Object({ threadId: Type.String(), sourcePoint: Type.Any(), title: Type.Optional(Type.String()) }),
				execute: async (args) => mapped("Couldn't fork T3 thread", "threadFork", { ...args }),
			}),
			defineTool({
				name: "t3_thread_merge_back",
				description: "Merge one thread's context back into a related thread in the same project (t3_thread_merge_back). sourcePoint is {type:\"latest_stable\"}, {type:\"run\",runId}, or {type:\"checkpoint\",checkpointId}.",
				parameters: Type.Object({ sourceThreadId: Type.String(), targetThreadId: Type.String(), sourcePoint: Type.Any() }),
				execute: async (args) => mapped("Couldn't merge T3 thread back", "threadMergeBack", { ...args }),
			}),
			defineTool({
				name: "t3_thread_configuration",
				description: "Read a thread's configuration (t3_thread_configuration), or with kind=transfers list its fork/merge transfers (t3_thread_transfers).",
				parameters: Type.Object({ threadId: Type.String(), kind: Type.Optional(literals("configuration", "transfers")) }),
				replay: "safe",
				execute: async ({ threadId, kind }) => mapped("Couldn't read T3 thread configuration", kind === "transfers" ? "threadTransfers" : "threadConfiguration", { threadId }),
			}),
			defineTool({
				name: "t3_thread_configure",
				description: "Set a thread's provider/model (t3_thread_configure). modelSelection is {model, provider?, instanceId?, options?} from t3_capabilities. Does not change permission modes.",
				parameters: Type.Object({ threadId: Type.String(), modelSelection: Type.Any() }),
				execute: async (args) => mapped("Couldn't configure T3 thread", "threadConfigure", { ...args }),
			}),
			defineTool({
				name: "t3_queue",
				description:
					"Work a thread's queued runs: list (t3_queue_list), read (t3_queue_read, queuedRunId), edit (t3_queue_edit, queuedRunId+text), cancel (t3_queue_cancel, queuedRunId), reorder (t3_queue_reorder, queuedRunId+beforeRunId, or toEnd=true to move it last), promote (t3_queue_promote_to_steer, queuedRunId+targetRunId: deliver it as steering to the active run).",
				parameters: Type.Object({
					action: literals("list", "read", "edit", "cancel", "reorder", "promote"),
					threadId: Type.String(),
					queuedRunId: Type.Optional(Type.String()),
					text: Type.Optional(Type.String()),
					beforeRunId: Type.Optional(Type.String()),
					toEnd: Type.Optional(Type.Boolean()),
					targetRunId: Type.Optional(Type.String()),
					cursor: Type.Optional(Type.Number()),
					limit: Type.Optional(Type.Number()),
				}),
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
				parameters: Type.Object({
					action: literals("list", "read", "respond"),
					threadId: Type.String(),
					requestId: Type.Optional(Type.String()),
					answers: Type.Optional(Type.Any()),
				}),
				execute: async ({ action, threadId, requestId, answers }) => {
					const key = { list: "pendingList", read: "pendingRead", respond: "pendingRespond" }[action] as T3ToolKey;
					return mapped("Couldn't work T3 pending requests", key, { threadId, requestId, answers });
				},
			}),
			defineTool({
				name: "t3_project",
				description:
					"Project operations beyond listing: read (t3_project_read, projectId), create (t3_project_create, title + optional workspaceRoot; omit workspaceRoot to get a fresh repo in T3's projects folder), update (t3_project_update, projectId + changed fields only), delete (t3_project_delete, projectId, force only when they insist), clone (t3_project_clone, destinationPath + remoteUrl or repository; register the result with create afterwards). Extra exact update fields (projectIcon, faviconPath, scripts, defaultThreadEnvMode…) go in `fields`, passed verbatim.",
				parameters: Type.Object({
					action: literals("read", "create", "update", "delete", "clone"),
					projectId: Type.Optional(Type.String()),
					title: Type.Optional(Type.String()),
					workspaceRoot: Type.Optional(Type.String()),
					createWorkspaceRootIfMissing: Type.Optional(Type.Boolean()),
					defaultModelSelection: Type.Optional(Type.Any()),
					scripts: Type.Optional(Type.Any()),
					autoPull: Type.Optional(Type.Boolean()),
					force: Type.Optional(Type.Boolean()),
					destinationPath: Type.Optional(Type.String()),
					remoteUrl: Type.Optional(Type.String()),
					repository: Type.Optional(Type.String()),
					provider: Type.Optional(Type.String()),
					protocol: Type.Optional(literals("auto", "ssh", "https")),
					fields: Type.Optional(objectArgs),
				}),
				execute: async ({ action, fields, ...rest }) => {
					const key = { read: "projectRead", create: "projectCreate", update: "projectUpdate", delete: "projectDelete", clone: "projectClone" }[action] as T3ToolKey;
					return mapped("Couldn't work the T3 project", key, { ...rest, ...(fields ?? {}) });
				},
			}),
			defineTool({
				name: "t3_scheduled_tasks",
				description:
					"T3's persistent scheduler: create (schedule_task: prompt + schedule as a structured object — {type:\"interval\",everyMs} (min 60000), {type:\"fixed_time\",timeOfDay:\"09:00\",weekdays?} with 0=Sunday, or {type:\"webhook\",signature?,maxDeliveryAgeMinutes?}), list (list_scheduled_tasks), update (update_scheduled_task: scheduledTaskId + changed fields; enabled=false pauses), delete (delete_scheduled_task), run_now (run_scheduled_task_now: pass the id as scheduledTaskId). Webhook runs see the request only through {{body…}}/{{headers…}}/{{query…}} placeholders in the prompt.",
				parameters: Type.Object({
					action: literals("create", "list", "update", "delete", "run_now"),
					scheduledTaskId: Type.Optional(Type.String()),
					projectId: Type.Optional(Type.String()),
					prompt: Type.Optional(Type.String()),
					title: Type.Optional(Type.String()),
					schedule: Type.Optional(Type.Any()),
					enabled: Type.Optional(Type.Boolean()),
					bindToCurrentThread: Type.Optional(Type.Boolean()),
					clientRequestId: Type.Optional(Type.String()),
				}),
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
				parameters: Type.Object({
					task: Type.String(),
					target: Type.Optional(Type.Any()),
					title: Type.Optional(Type.String()),
					role: Type.Optional(literals("implementation", "research", "review", "design", "test", "general")),
					isolation: Type.Optional(literals("shared", "worktree")),
					mode: Type.Optional(literals("async", "wait")),
					timeoutMs: Type.Optional(Type.Number()),
					runtimeMode: Type.Optional(literals("inherit", "approval-required", "auto-accept-edits", "auto", "full-access")),
					interactionMode: Type.Optional(literals("inherit", "default", "plan")),
					clientRequestId: Type.Optional(Type.String()),
				}),
				execute: async (args) => mapped("Couldn't delegate the T3 task", "delegateTask", { ...args }),
			}),
			defineTool({
				name: "t3_task",
				description: "Check or stop delegated/scheduled work: status (task_status, taskId), cancel (task_cancel, taskId, optional reason), workflow_stop (t3_workflow_stop: stop a subagent inside a thread, threadId+subagentId).",
				parameters: Type.Object({
					action: literals("status", "cancel", "workflow_stop"),
					taskId: Type.Optional(Type.String()),
					threadId: Type.Optional(Type.String()),
					subagentId: Type.Optional(Type.String()),
					reason: Type.Optional(Type.String()),
					clientRequestId: Type.Optional(Type.String()),
				}),
				execute: async ({ action, taskId, threadId, subagentId, reason, clientRequestId }) => {
					if (action === "workflow_stop") return mapped("Couldn't stop the T3 subagent", "workflowStop", { threadId, subagentId });
					return mapped("Couldn't work the T3 task", action === "status" ? "taskStatus" : "taskCancel", { taskId, reason, clientRequestId });
				},
			}),
			defineTool({
				name: "t3_create_threads",
				description:
					"Create a batch of ordinary top-level threads sharing one checkout (create_threads, 1–20). threads is an array of {prompt?, title?, target? {providerInstanceId?,driverKind?,model?,options?}, runtimeMode?, interactionMode?}. T3 says this needs an agent inside a T3 thread; for a single thread prefer t3_launch_thread.",
				parameters: Type.Object({ threads: Type.Any(), clientRequestId: Type.Optional(Type.String()) }),
				execute: async (args) => mapped("Couldn't create T3 threads", "createThreads", { ...args }),
			}),
			defineTool({
				name: "t3_pull_requests",
				description:
					"Pull requests tied to threads: link (link_pull_request), unlink (unlink_pull_request), list a thread's PRs (list_thread_pull_requests, threadId), watch (watch_pull_request), unwatch (unwatch_pull_request), read_guide (read_pull_request_guide), write_guides (write_pull_request_guides: pass the full pullRequests array in `fields` under that name, each entry as T3's schema asks). Identify a PR by url, or repository+number (+host when not github.com).",
				parameters: Type.Object({
					action: literals("link", "unlink", "list", "watch", "unwatch", "read_guide", "write_guides"),
					threadId: Type.Optional(Type.String()),
					url: Type.Optional(Type.String()),
					repository: Type.Optional(Type.String()),
					number: Type.Optional(Type.Number()),
					host: Type.Optional(Type.String()),
					fields: Type.Optional(objectArgs),
				}),
				execute: async ({ action, fields, ...rest }) => {
					const key = { link: "linkPullRequest", unlink: "unlinkPullRequest", list: "listThreadPullRequests", watch: "watchPullRequest", unwatch: "unwatchPullRequest", read_guide: "readPullRequestGuide", write_guides: "writePullRequestGuides" }[action] as T3ToolKey;
					return mapped("Couldn't work T3 pull requests", key, { ...rest, ...(fields ?? {}) });
				},
			}),
			defineTool({
				name: "t3_environment",
				description:
					"T3 environment settings: read (t3_environment_read) or update preferences (t3_environment_preferences_update: defaultThreadEnvMode local|worktree, newWorktreesStartFromOrigin, enableProviderUpdateChecks, backgroundActivity {profile: balanced|performance|battery-saver}, sourceControlWritingStyle {mode: repo_conventions|conventional_commits|custom, customInstructions?, followChangeRequestTemplates?}). Omitted fields stay as they are. T3 may require a live full-access calling thread for updates.",
				parameters: Type.Object({
					action: literals("read", "update"),
					defaultThreadEnvMode: Type.Optional(literals("local", "worktree")),
					newWorktreesStartFromOrigin: Type.Optional(Type.Boolean()),
					enableProviderUpdateChecks: Type.Optional(Type.Boolean()),
					backgroundActivity: Type.Optional(Type.Any()),
					sourceControlWritingStyle: Type.Optional(Type.Any()),
				}),
				execute: async ({ action, ...rest }) => mapped("Couldn't work the T3 environment", action === "read" ? "environmentRead" : "environmentPreferencesUpdate", action === "read" ? {} : { ...rest }),
			}),
			defineTool({
				name: "t3_worktrees",
				description:
					"Git worktrees: status (t3_worktree_status), list (t3_worktree_list: threadId?/query?/refKind? in fields, cursor/limit), handoff (t3_worktree_handoff: move the calling agent thread into a new worktree on branch, optional baseRef/startFromOrigin/runSetupScript/continuationPrompt — needs an agent inside a T3 thread, so from pclaw it may return T3's error; launch with workspaceStrategy worktree instead for new work).",
				parameters: Type.Object({
					action: literals("status", "list", "handoff"),
					threadId: Type.Optional(Type.String()),
					query: Type.Optional(Type.String()),
					branch: Type.Optional(Type.String()),
					baseRef: Type.Optional(Type.String()),
					startFromOrigin: Type.Optional(Type.Boolean()),
					runSetupScript: Type.Optional(Type.Boolean()),
					continuationPrompt: Type.Optional(Type.String()),
					cursor: Type.Optional(Type.Number()),
					limit: Type.Optional(Type.Number()),
					fields: Type.Optional(objectArgs),
				}),
				execute: async ({ action, fields, ...rest }) => {
					const key = { status: "worktreeStatus", list: "worktreeList", handoff: "worktreeHandoff" }[action] as T3ToolKey;
					return mapped("Couldn't work T3 worktrees", key, { ...rest, ...(fields ?? {}) });
				},
			}),
			defineTool({
				name: "t3_request_secret",
				description:
					"Ask them for a secret through T3's private card (request_secret). The value never comes back to you or into the transcript; the result carries a one-use secretRef to pass where T3 accepts one (e.g. a webhook schedule's signature.secretRef via t3_scheduled_tasks/t3_call). Never ask for secrets in chat instead.",
				parameters: Type.Object({
					label: Type.String(),
					reason: Type.String(),
					placeholder: Type.Optional(Type.String()),
					timeoutMs: Type.Optional(Type.Number()),
					clientRequestId: Type.Optional(Type.String()),
				}),
				execute: async (args) => mapped("Couldn't request the secret through T3", "requestSecret", { ...args }),
			}),
			defineTool({
				name: "t3_preview",
				description:
					"T3's collaborative browser preview (the preview_* tools plus t3_preview_list/close). action: list, close (tabId), status, open, navigate, resize (mode + preset/width/height… in fields), set_appearance (colorScheme in fields), click, type (text), hover, select (values in fields), drag (source/target in fields), upload (paths in fields), press (key, modifiers in fields), scroll, evaluate (expression), wait_for, recording_start, recording_stop, snapshot, dialog (accept in fields, promptText?). Common fields: tabId, url, selector, locator (aria-ref=<ref> from a snapshot), text, key, expression, x, y, timeoutMs. Anything else for the chosen action goes in `fields`, verbatim. Snapshot first to see the page and get element refs.",
				parameters: Type.Object({
					action: literals("list", "close", "status", "open", "navigate", "resize", "set_appearance", "click", "type", "hover", "select", "drag", "upload", "press", "scroll", "evaluate", "wait_for", "recording_start", "recording_stop", "snapshot", "dialog"),
					tabId: Type.Optional(Type.String()),
					url: Type.Optional(Type.String()),
					selector: Type.Optional(Type.String()),
					locator: Type.Optional(Type.String()),
					text: Type.Optional(Type.String()),
					key: Type.Optional(Type.String()),
					expression: Type.Optional(Type.String()),
					x: Type.Optional(Type.Number()),
					y: Type.Optional(Type.Number()),
					timeoutMs: Type.Optional(Type.Number()),
					fields: Type.Optional(objectArgs),
				}),
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
				parameters: Type.Object({
					action: literals("list", "open", "close", "screenshot"),
					deviceId: Type.Optional(Type.String()),
					platform: Type.Optional(Type.String()),
					hostId: Type.Optional(Type.String()),
					shutdown: Type.Optional(Type.Boolean()),
				}),
				execute: async ({ action, ...rest }) => {
					const key = { list: "deviceList", open: "deviceOpen", close: "deviceClose", screenshot: "deviceScreenshot" }[action] as T3ToolKey;
					return mapped("Couldn't work the T3 device", key, { ...rest });
				},
			}),
			defineTool({
				name: "t3_attachments",
				description:
					"Thread attachments: prepare (t3_attachment_prepare_upload: upload {type:\"image\"|\"file\",name,mimeType,sizeBytes} → a signed upload URL; the bytes must still be POSTed to that URL by a worker with a shell before sending), discard (t3_attachment_discard, attachmentId), send (t3_thread_send_attachments: threadId, optional message, attachments [{type,id,name,mimeType,sizeBytes}] from uploads that completed).",
				parameters: Type.Object({
					action: literals("prepare", "discard", "send"),
					upload: Type.Optional(Type.Any()),
					attachmentId: Type.Optional(Type.String()),
					threadId: Type.Optional(Type.String()),
					message: Type.Optional(Type.String()),
					attachments: Type.Optional(Type.Any()),
				}),
				execute: async ({ action, ...rest }) => {
					const key = { prepare: "attachmentPrepare", discard: "attachmentDiscard", send: "sendAttachments" }[action] as T3ToolKey;
					return mapped("Couldn't work T3 attachments", key, { ...rest });
				},
			}),
			defineTool({
				name: "t3_html",
				description: "Render HTML inline in T3: render (html_render: html, title, height) puts a titled block in a thread; preview (html_preview: html, optional width/appearance) returns a rendered preview.",
				parameters: Type.Object({
					action: literals("render", "preview"),
					html: Type.String(),
					title: Type.Optional(Type.String()),
					height: Type.Optional(Type.Number()),
					width: Type.Optional(Type.Number()),
					appearance: Type.Optional(Type.String()),
				}),
				execute: async ({ action, ...rest }) => mapped("Couldn't render HTML through T3", action === "render" ? "htmlRender" : "htmlPreview", { ...rest }),
			}),
			defineTool({
				name: "t3_call",
				description:
					"Call any T3 MCP tool by its exact name (from t3_status) with arguments passed verbatim. Use it for tools or fields the typed t3_* tools don't surface, or when T3 adds something new. Ungated, like the rest of the opened-up toolset — pass exactly what the tool's schema asks for; nothing is renamed or guessed.",
				parameters: Type.Object({ tool: Type.String({ description: "Exact MCP tool name, e.g. t3_thread_launch." }), arguments: Type.Optional(objectArgs) }),
				execute: async ({ tool, arguments: args }) => run(`Couldn't call T3 tool ${tool}`, (paired) => paired.callTool(tool, args ?? {})),
			}),
		],
	});
}
