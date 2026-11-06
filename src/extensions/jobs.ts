import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { type Conversation, type ConversationId, defineExtension, defineTool, type Harness } from "@earendil-works/pi-durable";
import { type Config, writePrivate } from "../config.ts";
import type { WorkerItem } from "../dashboard/types.ts";
import { type Decided, type Decisions, messageGuidance, messageQuestions, pick, progressGuidance, progressQuestions, projectQuestion, readTurn, TURN_TAIL, turnGuidance, turnQuestions, yes } from "../decisions.ts";
import { readPrompt } from "../prompts.ts";
import { Routes } from "../routes.ts";
import { pairedClient, T3Down } from "../t3-client.ts";
import { stamp } from "../time.ts";
import { currentAsk, isEmoji, setReaction, WORKING } from "./reactions.ts";
import { Workers } from "./workers.ts";

/**
 * Jobs: real work done in T3 Code threads, on any machine T3 can reach. The person can open a job's thread from any T3
 * client; in a Discord channel it also gets a thread under their message, with a status card that's edited in place.
 * Workers started in a channel get the same thread, and live in its conversation. A thread is a session: its updates,
 * result, and follow-ups stay in it, so no activity there means nothing is happening. DMs stay like texting, with typing
 * and then the answer.
 *
 * A keeper polls each job. While it runs, new activity refreshes the card, and a short update goes in the thread when
 * something's worth reading. When a T3 turn ends the keeper asks the decision model for a read and wakes the
 * conversation with a `<job-update>`. What happens next is the front model's call: replies in a job thread land
 * silently unless it calls `ping_owner` first.
 *
 * A job asked for while T3 is down isn't lost: it waits on the card and the keeper starts it once T3 answers again.
 */

export type JobState = "waiting" | "working" | "needs_you" | "idle" | "blocked" | "done" | "failed" | "stopped" | "closed";

/** What a job was asked to be. Where it runs is worked out from this, which needs T3 to be up. */
export type StartRequest = { title: string; brief?: string; project?: string; machine?: string; workspace?: "worktree" | "root"; base_ref?: string };

export type Job = {
	id: string;
	title: string;
	brief: string;
	/** Empty until a `waiting` job has started. */
	threadId: string;
	environmentId?: string;
	machine: string;
	project?: string;
	model?: string;
	link?: string;
	/** What a `waiting` job needs to start. */
	start?: StartRequest;
	/** A one-off with nothing to open later: its T3 thread settles itself. */
	background?: boolean;
	/** A pclaw worker rather than a T3 thread. `threadId` holds its session id. */
	worker?: { name: string; conversationId: ConversationId };
	/** The conversation the job started in, by address, and the message that asked for it. */
	origin: string;
	ask?: string;
	emoji?: string;
	discordThreadId?: string;
	cardMessageId?: string;
	state: JobState;
	/** One line on where things stand, shown on the card. */
	status: string;
	/** Which T3 turn was last reported, as `<run>|<status>|<pending>`. */
	handled?: string;
	/** Where reading the T3 thread picks up. */
	position?: number;
	itemCount?: number;
	/** The agent's last words so far: a mid-turn refresh can read them before the turn ends. */
	lastMessage?: string;
	cardRefreshedAt?: number;
	/** When an update last went in the thread. */
	lastNoteAt?: number;
	/** When the owner last spoke in the thread: if they're there, a finished job doesn't need to ping them. */
	ownerAt?: number;
	/** The channel it started in has been told how it ended. */
	closedOut?: boolean;
	/** A line written alongside starting it was moved into the thread. */
	ackMoved?: boolean;
	/** What the owner has actually been sent about this job. */
	told: string[];
	pingNext?: boolean;
	/** A reply to an update is expected in a place with no thread. */
	awaitingReply?: boolean;
	decision?: string;
	startedAt: number;
	updatedAt: number;
};

type StoreData = { jobs: Record<string, Job>; boardMessageId?: string };

/** Job state lives in a plain file, like the notes, so it can be read and fixed by hand. */
export class JobStore {
	readonly #file: string;
	#data: StoreData;
	/** Set whenever a job changes, so the board knows to redraw. */
	dirty = false;

	constructor(file: string) {
		this.#file = file;
		this.#data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as StoreData) : { jobs: {} };
	}

	get boardMessageId(): string | undefined {
		return this.#data.boardMessageId;
	}

	set boardMessageId(id: string | undefined) {
		if (id === undefined) delete this.#data.boardMessageId;
		else this.#data.boardMessageId = id;
		this.#save();
	}

	get(id: string): Job | undefined {
		return this.#data.jobs[id];
	}

	all(): Job[] {
		return Object.values(this.#data.jobs).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	active(): Job[] {
		return this.all().filter((job) => job.state !== "closed");
	}

	/** The job a Discord thread belongs to; the most recent one if it holds several. */
	forThread(discordThreadId: string): Job | undefined {
		return this.active().find((job) => job.discordThreadId === discordThreadId);
	}

	put(job: Job): void {
		job.updatedAt = Date.now();
		this.#data.jobs[job.id] = job;
		this.dirty = true;
		this.#save();
	}

	#save(): void {
		writePrivate(this.#file, `${JSON.stringify(this.#data, null, "\t")}\n`);
	}
}

export type ThreadView = {
	status: string;
	activeRunId: string | null;
	latestRunId: string | null;
	pendingRequestCount: number;
	runCount: number;
	itemCount: number;
	settled: boolean;
};
export type ThreadItem = { type: string; text?: string; creationSource?: string };
export type Project = { id: string; title: string; machine: string; environmentId?: string; hasRepo: boolean };
export type Machine = { machine: string; environmentId?: string };

/** What jobs need from T3. */
export type JobBackend = {
	launch(args: Record<string, unknown>): Promise<{ threadId: string }>;
	peek(threadId: string, environmentId?: string): Promise<ThreadView>;
	read(threadId: string, environmentId: string | undefined, from: number): Promise<{ items: ThreadItem[]; position: number }>;
	pending(threadId: string, environmentId?: string): Promise<string[]>;
	send(threadId: string, environmentId: string | undefined, message: string): Promise<void>;
	interrupt(threadId: string, environmentId?: string): Promise<void>;
	settle(threadId: string, environmentId?: string): Promise<void>;
	projects(): Promise<Project[]>;
	/** Every reachable machine, including ones with no projects yet. */
	machines(): Promise<Machine[]>;
	/** A public link that opens the thread: in the T3 app on a phone that has it, otherwise in T3's hosted web app. */
	linkFor(threadId: string, environmentId: string | undefined): Promise<string>;
};

/** Where a job shows up. Discord fills this in; without it, jobs still run and updates still reach the conversation. */
export type JobSurface = {
	/** Make the job's thread and card. Returns nothing when the origin can't have a thread (a DM). */
	open(job: Job): Promise<Pick<Job, "discordThreadId" | "cardMessageId"> | undefined>;
	card(job: Job): Promise<void>;
	/** A silent update in the job's thread. */
	note(job: Job, text: string): Promise<void>;
	board(jobs: Job[]): Promise<void>;
	/** The conversation updates go to: the job's thread if it has one. */
	conversation(job: Job): Promise<Conversation>;
	/** Tell the channel the job started in how it ended, without saying anything there. */
	remember(job: Job, text: string): Promise<void>;
};

/** Public, and registered as a universal link for /threads/*, so it reaches the app without the tailnet. */
const HOSTED_T3 = "https://app.t3.codes";
/** The first update comes sooner than the rest: that's when silence is most confusing. */
const FIRST_UPDATE_MS = 20_000;
/** A line written with the call that started a job arrives within moments of it. */
const ACK_MS = 8_000;
/** How long after a job ends its record might still read as running. */
const REOPEN_MS = 30_000;
/** They spoke in the thread this recently, so they're there. */
const OWNER_HERE_MS = 5 * 60_000;
/** A waiting job gives up after this: by then it's better to ask again than to start out of the blue. */
const WAIT_MS = 24 * 60 * 60_000;
const PROJECTS_MS = 10 * 60_000;
const CLIENT_MS = 10 * 60_000;
const READ_PAGE = 100;
const READ_PAGES = 5;
const ITEM_CHARS = 8_000;

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
const environmentArg = (environmentId: string | undefined) => (environmentId === undefined ? {} : { environmentId });

export function t3Backend(t3Url: string, storeFile: string): JobBackend {
	let client: { value: Awaited<ReturnType<typeof pairedClient>>; at: number } | undefined;
	let projects: { value: Project[]; at: number } | undefined;
	let fleet: { value: Machine[]; local: string; at: number } | undefined;
	const readFleet = async () => {
		if (fleet !== undefined && Date.now() - fleet.at < PROJECTS_MS) return fleet;
		const linked = await call("t3_environment_links", {});
		const links = ((linked.links ?? []) as Record<string, unknown>[]).filter((link) => link.status === "reachable");
		const value: Machine[] = [{ machine: hostname().replace(/\..*$/, "") }, ...links.map((link) => ({ machine: String(link.label), environmentId: String(link.environmentId) }))];
		fleet = { value, local: String(linked.environmentId), at: Date.now() };
		return fleet;
	};
	const machines = async () => (await readFleet()).value;
	const paired = async () => {
		if (client === undefined || Date.now() - client.at > CLIENT_MS) client = { value: await pairedClient(t3Url, storeFile), at: Date.now() };
		return client.value;
	};
	const call = async (tool: string, args: Record<string, unknown>) => {
		try {
			return asRecord(await (await paired()).callTool(tool, args));
		} catch (error) {
			client = undefined;
			throw error;
		}
	};
	const view = (read: Record<string, unknown>): ThreadView => {
		const thread = asRecord(read.thread);
		return {
			status: String(thread.status ?? "unknown"),
			activeRunId: typeof thread.activeRunId === "string" ? thread.activeRunId : null,
			latestRunId: typeof thread.latestRunId === "string" ? thread.latestRunId : null,
			pendingRequestCount: Number(thread.pendingRequestCount ?? 0),
			runCount: Number(thread.runCount ?? 0),
			itemCount: Number(thread.itemCount ?? 0),
			settled: thread.settled === true,
		};
	};
	return {
		launch: async (args) => {
			const result = await call("t3_thread_launch", args);
			if (typeof result.threadId !== "string") throw new Error(`T3 returned no thread id: ${JSON.stringify(result).slice(0, 300)}`);
			return { threadId: result.threadId };
		},
		peek: async (threadId, environmentId) => view(await call("t3_thread_read", { threadId, ...environmentArg(environmentId), limit: 1, maxCharsPerItem: 1, runLimit: 1 })),
		read: async (threadId, environmentId, from) => {
			const items: ThreadItem[] = [];
			let position = from;
			for (let page = 0; page < READ_PAGES; page++) {
				const read = await call("t3_thread_read", { threadId, ...environmentArg(environmentId), afterPosition: position, limit: READ_PAGE, maxCharsPerItem: ITEM_CHARS, runLimit: 1 });
				items.push(...((read.items as ThreadItem[] | undefined) ?? []));
				if (typeof read.nextPosition === "number") position = read.nextPosition;
				if (read.hasMore !== true) break;
			}
			return { items, position };
		},
		pending: async (threadId, environmentId) => {
			const listed = await call("t3_pending_request", { action: "list", threadId, ...environmentArg(environmentId) });
			const requests = (listed.requests ?? listed.pending ?? listed.items ?? []) as unknown[];
			const details: string[] = [];
			for (const request of requests.slice(0, 2)) {
				const requestId = typeof request === "string" ? request : asRecord(request).requestId ?? asRecord(request).id;
				if (typeof requestId !== "string") continue;
				details.push(JSON.stringify(await call("t3_pending_request", { action: "read", requestId, threadId, ...environmentArg(environmentId) })).slice(0, 1_500));
			}
			return details;
		},
		send: async (threadId, environmentId, message) => {
			await call("t3_thread_send", { threadId, ...environmentArg(environmentId), message, mode: "auto" });
		},
		interrupt: async (threadId, environmentId) => {
			await call("t3_thread_interrupt", { threadId, ...environmentArg(environmentId), reason: "Stopped from pclaw." });
		},
		settle: async (threadId, environmentId) => {
			await call("t3_thread_organize", { threadId, ...environmentArg(environmentId), action: "settle" });
		},
		projects: async () => {
			if (projects !== undefined && Date.now() - projects.at < PROJECTS_MS) return projects.value;
			const found = await Promise.all(
				(await machines()).map(async ({ machine, environmentId }) => {
					const listed = await call("t3_project_list", { ...environmentArg(environmentId), limit: 100 }).catch((error: unknown) => {
						if (error instanceof T3Down) throw error;
						return { projects: [] } as Record<string, unknown>;
					});
					return ((listed.projects ?? []) as Record<string, unknown>[])
						.filter((project) => project.title !== "No project" && project.archivedAt == null)
						.map((project): Project => ({ id: String(project.id), title: String(project.title), machine, ...(environmentId === undefined ? {} : { environmentId }), hasRepo: project.repositoryIdentity != null }));
				}),
			);
			projects = { value: found.flat(), at: Date.now() };
			return projects.value;
		},
		machines,
		linkFor: async (threadId, environmentId) => {
			const environment = environmentId ?? (await readFleet()).local;
			return `${HOSTED_T3}/threads/${encodeURIComponent(environment)}/${encodeURIComponent(threadId)}`;
		},
	};
}

/** Goes on the front of every job's brief, so a job's last message tells pclaw where things stand. */
export const JOB_NOTE =
	"You're running as a job from pclaw, the owner's assistant. They may be away and reading a summary on their phone. " +
	"Keep going without them while you can. When you stop, your last message should say plainly where the job stands: " +
	"done, blocked on what, or the exact question you need answered. Before anything outward-facing and hard to undo " +
	"(send, buy, book, pay, delete, post, or deploy for real), stop and ask.";

const startFields = ({ project, machine, workspace, base_ref }: Omit<StartRequest, "title" | "brief">) => ({
	...(project === undefined ? {} : { project }),
	...(machine === undefined ? {} : { machine }),
	...(workspace === undefined ? {} : { workspace }),
	...(base_ref === undefined ? {} : { base_ref }),
});

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "job";
const tail = (text: string, limit: number) => (text.length > limit ? `…${text.slice(-limit)}` : text);
const firstLine = (text: string) => (text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "").slice(0, 180);

/** The last thing the agent said, and whether a person, not pclaw, spoke to it most recently. */
export function readItems(items: ThreadItem[]): { lastMessage?: string; ownerDriving: boolean } {
	let lastMessage: string | undefined;
	let ownerDriving = false;
	for (const item of items) {
		if (item.type === "assistant_message" && item.text?.trim()) lastMessage = item.text;
		if (item.type === "user_message") ownerDriving = item.creationSource !== "mcp";
	}
	return { ...(lastMessage === undefined ? {} : { lastMessage }), ownerDriving };
}

/** T3's status says a turn ended, not why, so a finished thread and one asking a question look the same. */
export function turnEnded(view: ThreadView): boolean {
	if (view.pendingRequestCount > 0 || view.status === "waiting") return true;
	if (view.status === "idle") return view.runCount > 0;
	return !/^(preparing|queued|starting|running)$/.test(view.status);
}

export const turnKey = (view: ThreadView) => `${view.latestRunId}|${view.status}|${view.pendingRequestCount}`;

const STATES = ["needs_you", "idle", "blocked", "done"] as const;

function factualState(view: ThreadView): JobState | undefined {
	if (/^(failed|cancelled|rolled_back)$/.test(view.status)) return "failed";
	if (view.status === "interrupted") return "stopped";
	if (view.pendingRequestCount > 0 || view.status === "waiting") return "needs_you";
	return undefined;
}

const FROM_OUTCOME: Record<string, JobState> = { finished: "done", needs_owner: "needs_you", procedural: "idle", blocked: "blocked", still_going: "idle" };

const SUMMARY_PROMPT =
	"You read the last message from a coding agent working a job, and report where the job stands. Reply with JSON only: " +
	'{"state": "done" | "needs_you" | "blocked" | "idle", "line": "..."}. "needs_you" means it ends on a question or a ' +
	'decision for the owner. "blocked" means a failure or missing access stopped it. "idle" means it paused with nothing ' +
	'needed. "done" means the job it was given is complete. "line" is one plain sentence of at most 140 characters about ' +
	"where things stand, written for someone glancing at their phone. No preamble and no jargon.";

const PROGRESS_TASK = `Right now you're partway through a job for them, and this is their thread for it. You'll get the job and the newest things that happened. Reply with JSON only: {"status": "...", "message": "..." or null}.

"status" goes on the job's card: a few plain words on where it stands, at most 80 characters.

"message" is what you'd text them right now, or null. Write it in your voice, as the one doing the work: one or two short sentences on what you learned or what changed, and what it means or what's next. Something like "3154's plan holds up, so i'm posting the pickup next" or "the ledger's rejecting this one, looks like the scope is too wide. narrowing it." Never a log line like "Reviewed X", "Started Y", or "Looked up Z". Leave out commands, paths, and tool names.

Use null unless a person would actually want to read it: something found, a snag, a change of plan. More of the same is null. Never repeat what you've already said. Never include a password, token, or key.`;

/** Updates come from the same voice as everything else pclaw says. */
export function progressPrompt(): string {
	return `${readPrompt("voice").trim()}\n\n${PROGRESS_TASK}`;
}

const SECRETS = /^.*(password|passwd|token|secret|api[_-]?key|authorization).*$/gim;

/** What a worker did, as plain lines for the model that writes updates. */
export function describeActivity(items: WorkerItem[]): string {
	return items
		.flatMap((item) => {
			if (item.kind === "text") return [`said: ${item.text.slice(0, 600)}`];
			if (item.kind !== "tool") return [];
			const command = (item.args as { command?: unknown } | undefined)?.command;
			const result = (item.result ?? "").replace(SECRETS, "[hidden]").slice(0, 300);
			return [`${item.isError === true ? "failed" : "ran"} ${typeof command === "string" ? command.replace(SECRETS, "[hidden]").slice(0, 200) : item.name}\nresult: ${result}`];
		})
		.join("\n")
		.slice(-3_000);
}

export type JobsOptions = {
	store: JobStore;
	backend: JobBackend;
	decisions: Decisions;
	models: Models;
	config: Config;
	harness: { current?: Harness };
	/** A worker's transcript so far. */
	workerItems?: (sessionId: string) => WorkerItem[];
};

export type Jobs = ReturnType<typeof createJobs>;

export function createJobs(options: JobsOptions) {
	const { store, backend, decisions, models, config, harness, workerItems = () => [] } = options;
	const surface: { current?: JobSurface } = {};
	const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

	const mustGet = (id: string) => {
		const job = store.get(id);
		if (job === undefined) throw new Error(`No job ${id}. Use list_jobs.`);
		return job;
	};

	async function refreshCard(job: Job): Promise<void> {
		await surface.current?.card(job).catch((error: unknown) => console.error(`[pclaw] job card ${job.id}`, error));
	}

	/** One line on the card and a state, from the front model. A failure here only costs a plainer card. */
	async function summarize(job: Job, message: string): Promise<{ line: string; state?: JobState }> {
		try {
			const model = models.getModel(config.provider, config.model);
			if (model === undefined) throw new Error(`unknown model ${config.provider}/${config.model}`);
			const reply = await models.completeSimple(
				model,
				{ systemPrompt: SUMMARY_PROMPT, messages: [{ role: "user", content: `Job: ${job.title}\n\nLast message:\n\n${tail(message, 6_000)}`, timestamp: Date.now() }] },
				{ reasoning: "low", signal: AbortSignal.timeout(30_000) },
			);
			const raw = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			const parsed = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "{}") as { state?: string; line?: string };
			const state = STATES.find((each) => each === parsed.state);
			return { line: parsed.line?.trim().slice(0, 200) || firstLine(message), ...(state === undefined ? {} : { state }) };
		} catch (error) {
			console.error(`[pclaw] job summary ${job.id}: ${error instanceof Error ? error.message : error}`);
			return { line: firstLine(message) };
		}
	}

	async function setAskReaction(job: Job, emoji: string, context: Context): Promise<void> {
		if (job.ask === undefined || harness.current === undefined) return;
		const id = (await harness.current.snapshot(Routes, context))?.conversations[job.origin];
		const conversation = id === undefined ? undefined : await harness.current.conversation(id, context);
		await conversation?.commit((tx) => setReaction(tx, conversation.id, job.ask!, emoji), context);
	}

	const REACTION: Partial<Record<JobState, string>> = { needs_you: "🙋", idle: "💤", done: "✅", failed: "⚠️", blocked: "⚠️", stopped: "⏹️" };

	async function updateConversation(job: Job, context: Context): Promise<Conversation | undefined> {
		if (surface.current !== undefined) return surface.current.conversation(job);
		const id = (await harness.current?.snapshot(Routes, context))?.conversations[job.origin];
		return id === undefined ? undefined : harness.current?.conversation(id, context);
	}

	/** A T3 turn ended: read it, refresh the card, get a read from the decision model, and wake the conversation. */
	async function handleTurn(job: Job, view: ThreadView, context: Context): Promise<void> {
		const key = turnKey(view);
		const { items, position } = await backend.read(job.threadId, job.environmentId, job.position ?? 0);
		const { lastMessage, ownerDriving } = readItems(items);
		const message = lastMessage ?? job.lastMessage ?? "(the agent said nothing new)";
		const facts = { ownerDriving, repeat: lastMessage === undefined || tail(lastMessage, 6_000) === job.lastMessage };
		job.lastMessage = tail(message, 6_000);
		const pending = view.pendingRequestCount > 0 ? await backend.pending(job.threadId, job.environmentId).catch(() => []) : [];
		const id = `turn:${job.id}:${key}`;
		const decided: Decided | undefined = await decisions.ask({ id, site: "job-turn", job: job.id, timeoutMs: 5_000, state: { last_message: message.slice(-TURN_TAIL) }, questions: turnQuestions });
		const read = decided === undefined ? undefined : readTurn(decided.answers, facts);
		const summary = await summarize(job, message);
		job.state = factualState(view) ?? summary.state ?? (read === undefined ? undefined : FROM_OUTCOME[read.outcome]) ?? "idle";
		job.status = summary.line;
		job.handled = key;
		job.position = position;
		job.itemCount = view.itemCount;
		job.cardRefreshedAt = Date.now();
		const guidance = decided === undefined ? undefined : turnGuidance(decided.answers, facts);
		const shown = decided?.arm === "guided" ? guidance : undefined;
		if (decided !== undefined) {
			job.decision = decided.id;
			decisions.record({ type: "guidance", id, site: "job-turn", job: job.id, arm: decided.arm, guidance, shown: shown !== undefined, ...read, ...facts, summaryState: summary.state, cardState: job.state });
		}
		const conversation = await updateConversation(job, context);
		job.awaitingReply = job.discordThreadId === undefined;
		store.put(job);
		await refreshCard(job);
		const reaction = REACTION[job.state];
		if (reaction !== undefined) await setAskReaction(job, reaction, context);
		if (job.background === true && (job.state === "done" || job.state === "idle")) {
			await backend.settle(job.threadId, job.environmentId).catch((error: unknown) => console.error(`[pclaw] couldn't settle ${job.id}`, error));
		}
		console.log(`[pclaw] job ${job.id} turn ended: ${view.status}, card ${job.state}, ${shown === undefined ? "no hint shown" : "hint shown"}`);
		decisions.record({ type: "wake", job: job.id, decision: decided?.id, arm: decided?.arm ?? "none", state: job.state, pending: view.pendingRequestCount });
		const where = job.discordThreadId === undefined ? ' surface="none"' : "";
		await conversation?.submit(
			{
				type: "input",
				content: [
					`[${stamp(Date.now(), config.timeZone)}]`,
					`<job-update job="${job.id}" title="${job.title.replaceAll('"', "'")}" t3_status="${view.status}" turn="${view.runCount}" pending_requests="${view.pendingRequestCount}" card="${job.state}"${where}>`,
					`Card now says: ${job.status}`,
					...(pending.length === 0 ? [] : [`Pending in T3: ${pending.join("\n")}`]),
					`The agent's last message:\n${tail(message, 4_000)}`,
					"</job-update>",
					...(shown === undefined ? [] : [shown]),
				].join("\n"),
				whenBusy: "followUp",
				requestId: `job:${job.id}:${key}`,
			},
			context,
		);
	}

	/** Ask the front model what it would say about new activity, if anything. */
	async function progressUpdate(job: Job, activity: string, hint: string | undefined): Promise<{ status?: string; message?: string }> {
		try {
			const model = models.getModel(config.provider, config.model);
			if (model === undefined) throw new Error(`unknown model ${config.provider}/${config.model}`);
			const minutes = job.lastNoteAt === undefined ? undefined : Math.round((Date.now() - job.lastNoteAt) / 60_000);
			const quiet =
				minutes === undefined
					? "You haven't said anything in this thread yet, so tell them what you've picked up so far."
					: `Your last update was ${minutes} minutes ago.${minutes >= 3 ? " That's a while, so say where things stand if there's anything new." : ""}`;
			const content = [`The job: ${job.title}\n${job.brief.slice(0, 800)}`, `What you've said so far: ${job.told.join(" / ") || "nothing"}`, quiet, ...(hint === undefined ? [] : [hint]), `What just happened:\n${activity}`].join("\n\n");
			const reply = await models.completeSimple(model, { systemPrompt: progressPrompt(), messages: [{ role: "user", content, timestamp: Date.now() }] }, { reasoning: "low", signal: AbortSignal.timeout(30_000) });
			const raw = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			const parsed = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "{}") as { status?: string; message?: string | null };
			const status = parsed.status?.trim().slice(0, 120);
			const message = parsed.message?.trim().slice(0, 400);
			return { ...(status ? { status } : {}), ...(message ? { message } : {}) };
		} catch (error) {
			console.error(`[pclaw] job progress ${job.id}: ${error instanceof Error ? error.message : error}`);
			return {};
		}
	}

	/** New activity while it runs: always refresh the card, and post in the thread when it's worth reading. */
	async function noteProgress(job: Job, activity: string): Promise<void> {
		const id = `progress:${job.id}:${job.position}`;
		const decided = await decisions.ask({ id, site: "progress", job: job.id, timeoutMs: 3_000, state: { recent_activity: activity.slice(-1_500) }, questions: progressQuestions });
		const hint = decided?.arm === "guided" ? progressGuidance(decided.answers) : undefined;
		const { status, message } = await progressUpdate(job, activity, hint);
		job.cardRefreshedAt = Date.now();
		if (status !== undefined) job.status = status;
		const posted = message !== undefined && surface.current !== undefined && job.discordThreadId !== undefined;
		if (posted) {
			await surface.current!.note(job, message);
			job.lastNoteAt = Date.now();
			job.told = [...job.told, message].slice(-5);
		}
		store.put(job);
		await refreshCard(job);
		decisions.record({ type: "progress", id, job: job.id, arm: decided?.arm ?? "none", milestone: decided === undefined ? undefined : yes(decided.answers.milestone), posted });
	}

	/** Mid-turn in T3: keep the card honest, with no wakeup. */
	async function refreshRunning(job: Job): Promise<void> {
		const { items, position } = await backend.read(job.threadId, job.environmentId, job.position ?? 0);
		const { lastMessage } = readItems(items);
		job.position = position;
		job.cardRefreshedAt = Date.now();
		if (lastMessage === undefined) {
			store.put(job);
			return;
		}
		job.lastMessage = tail(lastMessage, 6_000);
		await noteProgress(job, tail(lastMessage, 3_000));
	}

	/** A worker in a channel. The worker's own record says whether it's running, so a restart can't strand this. */
	async function checkWorker(job: Job, refreshMs: number, context: Context): Promise<void> {
		const { name, conversationId } = job.worker!;
		const worker = (await harness.current?.snapshot(Workers, conversationId, context))?.workers[name];
		if (worker === undefined) return;
		if (worker.status !== "working") {
			if (job.state === "working") {
				// A normal ending is handled as its report goes in; this is a stop, or a run that ended some other way.
				job.state = worker.status === "failed" ? "failed" : worker.status === "stopped" ? "stopped" : "done";
				job.status = job.state === "done" ? "Done." : job.state === "failed" ? "It failed." : "Stopped.";
				store.put(job);
				await refreshCard(job);
				await setAskReaction(job, REACTION[job.state]!, context);
			} else if (Date.now() - job.updatedAt > 24 * 60 * 60_000) {
				job.state = "closed";
				store.put(job);
				await refreshCard(job);
			}
			return;
		}
		// Its record says working for a moment after the report goes in.
		if (job.state !== "working") {
			if (Date.now() - job.updatedAt < REOPEN_MS) return;
			job.state = "working";
			job.status = "Back at it.";
			delete job.closedOut;
			store.put(job);
			await refreshCard(job);
			await setAskReaction(job, job.emoji ?? WORKING, context);
		}
		if (Date.now() - (job.cardRefreshedAt ?? job.startedAt) < Math.min(refreshMs, job.lastNoteAt === undefined ? FIRST_UPDATE_MS : refreshMs)) return;
		const items = workerItems(job.threadId);
		const fresh = items.slice(job.position ?? 0);
		const activity = describeActivity(fresh);
		if (activity === "") return;
		job.position = items.length;
		await noteProgress(job, activity);
	}

	/**
	 * A worker started in a channel: open its thread and hand back that thread's conversation, which is where the worker
	 * then lives. In a DM there's no thread to open, and typing covers it.
	 */
	async function openSession(worker: { name: string; brief: string; sessionId: string; conversationId: ConversationId; ask?: string }, context: Context): Promise<Conversation | undefined> {
		const routes = (await harness.current?.snapshot(Routes, context))?.conversations ?? {};
		const origin = Object.keys(routes).find((address) => routes[address] === worker.conversationId);
		if (origin === undefined || !/^discord:(channel|thread):/.test(origin) || surface.current === undefined) return undefined;
		const now = Date.now();
		const job: Job = {
			id: `${slug(worker.name)}-${randomBytes(2).toString("hex")}`,
			title: worker.name.replace(/[-_]+/g, " "),
			brief: worker.brief,
			threadId: worker.sessionId,
			worker: { name: worker.name, conversationId: worker.conversationId },
			machine: hostname().replace(/\..*$/, ""),
			origin,
			...(worker.ask === undefined ? {} : { ask: worker.ask }),
			state: "working",
			status: "Starting up.",
			told: [],
			position: workerItems(worker.sessionId).length,
			startedAt: now,
			updatedAt: now,
		};
		const placed = await surface.current.open(job);
		if (placed === undefined) return undefined;
		Object.assign(job, placed);
		const conversation = await surface.current.conversation(job);
		job.worker = { name: worker.name, conversationId: conversation.id };
		store.put(job);
		decisions.record({ type: "job", event: "start", job: job.id, machine: job.machine, worker: true });
		console.log(`[pclaw] worker ${worker.name} has a session in ${job.discordThreadId}`);
		return conversation;
	}

	/** A worker's report is about to go in: the reply is the news, so it should reach them unless they're already here. */
	async function workerReporting(worker: { name: string; conversationId: ConversationId; ok: boolean }, context: Context): Promise<void> {
		const job = store.all().find((each) => each.worker?.name === worker.name && each.worker.conversationId === worker.conversationId);
		if (job === undefined || job.state === "closed") return;
		job.state = worker.ok ? "done" : "failed";
		job.status = worker.ok ? "Wrapping up." : "It failed.";
		job.pingNext = Date.now() - (job.ownerAt ?? 0) > OWNER_HERE_MS;
		store.put(job);
		await refreshCard(job);
		await setAskReaction(job, REACTION[job.state]!, context);
	}

	/** Find where a job runs: T3 knows the projects and machines. */
	async function place(request: StartRequest): Promise<{ machine: string; environmentId?: string; project?: Project }> {
		const wanted = request.machine?.toLowerCase();
		const named = (project: Project) => project.title.toLowerCase() === request.project!.toLowerCase() && (wanted === undefined || project.machine.toLowerCase() === wanted);
		const project = request.project === undefined ? undefined : (await backend.projects()).find(named);
		if (request.project !== undefined && project === undefined) {
			throw new Error(`No project ${request.project}${wanted === undefined ? "" : ` on ${wanted}`}. Use list_projects.`);
		}
		if (project !== undefined) return { machine: project.machine, ...environmentArg(project.environmentId), project };
		if (wanted === undefined) return { machine: hostname().replace(/\..*$/, "") };
		const found = (await backend.machines()).find((each) => each.machine.toLowerCase() === wanted);
		if (found === undefined) throw new Error(`Can't reach ${request.machine} through T3. Reachable: ${(await backend.machines()).map((each) => each.machine).join(", ")}.`);
		return found;
	}

	async function launch(request: StartRequest, where: Awaited<ReturnType<typeof place>>, model: string): Promise<string> {
		const { project, environmentId } = where;
		const workspace = request.workspace ?? (project?.hasRepo === true ? "worktree" : "root");
		const launched = await backend.launch({
			title: request.title,
			...environmentArg(environmentId),
			...(project === undefined ? { scratch: true } : { projectId: project.id, workspaceStrategy: workspace === "worktree" ? { type: "worktree", baseRef: request.base_ref ?? "main" } : { type: "root" } }),
			message: `${JOB_NOTE}\n\n${request.brief}`,
			modelSelection: modelSelection(model),
			runtimeMode: "full-access",
		});
		return launched.threadId;
	}

	/** T3 was down when this job was asked for. Start it if T3's back; if it can't start at all, say so. */
	async function startWaiting(job: Job, context: Context): Promise<void> {
		try {
			const where = await place(job.start!);
			const threadId = await launch(job.start!, where, job.model!);
			// Saved before anything else can fail, so the keeper can't launch it twice.
			store.put(Object.assign(job, { threadId, machine: where.machine, ...environmentArg(where.environmentId), ...(where.project === undefined ? {} : { project: where.project.title }), state: "working", status: "Starting up.", startedAt: Date.now(), start: undefined }));
			job.link = await backend.linkFor(threadId, where.environmentId).catch(() => undefined);
			store.put(job);
			await refreshCard(job);
			await setAskReaction(job, job.emoji ?? WORKING, context);
			decisions.record({ type: "job", event: "start", job: job.id, machine: job.machine, project: job.project, model: job.model, adopted: false, background: job.background === true, waited: true });
			console.log(`[pclaw] job ${job.id} started on ${job.machine} after waiting for T3`);
		} catch (error) {
			const down = error instanceof T3Down;
			if (down && Date.now() - job.startedAt < WAIT_MS) return;
			const reason = down ? "T3 stayed down for a day, so this never started." : `It couldn't start: ${error instanceof Error ? error.message : String(error)}`;
			store.put(Object.assign(job, { state: "failed", status: reason.slice(0, 200), start: undefined }));
			await refreshCard(job);
			await setAskReaction(job, REACTION.failed!, context);
			const conversation = await surface.current?.conversation(job);
			await conversation?.submit(
				{
					type: "input",
					content: [`[${stamp(Date.now(), config.timeZone)}]`, `<job-update job="${job.id}" title="${job.title.replaceAll('"', "'")}" card="failed">`, reason, "</job-update>"].join("\n"),
					whenBusy: "followUp",
					requestId: `job:${job.id}:never-started`,
				},
				context,
			);
		}
	}

	async function check(job: Job, refreshMs: number, context: Context): Promise<void> {
		if (job.worker !== undefined) return checkWorker(job, refreshMs, context);
		if (job.state === "waiting") return startWaiting(job, context);
		const view = await backend.peek(job.threadId, job.environmentId);
		if (view.settled && job.state !== "working") {
			job.state = "closed";
			store.put(job);
			await refreshCard(job);
			return;
		}
		if (turnEnded(view)) {
			if (turnKey(view) !== job.handled) await handleTurn(job, view, context);
			else if (Date.now() - job.updatedAt > 7 * 24 * 60 * 60_000) {
				job.state = "closed";
				store.put(job);
				await refreshCard(job);
			}
			return;
		}
		if (job.state !== "working") {
			job.state = "working";
			job.status = "Back at it.";
			store.put(job);
			await refreshCard(job);
			await setAskReaction(job, job.emoji ?? WORKING, context);
		}
		if (view.itemCount !== job.itemCount && Date.now() - (job.cardRefreshedAt ?? job.startedAt) >= Math.min(refreshMs, job.lastNoteAt === undefined ? FIRST_UPDATE_MS : refreshMs)) {
			job.itemCount = view.itemCount;
			await refreshRunning(job);
		}
	}

	function startKeeper(context: Context, everyMs: number, refreshMs: number): { stop(): void; tick(): Promise<void> } {
		let running = false;
		// Draw the board on the first check, so it's there before the first job.
		store.dirty = true;
		const tick = async () => {
			if (running) return;
			running = true;
			try {
				for (const job of store.active()) {
					await check(job, refreshMs, context).catch((error: unknown) => console.error(`[pclaw] job ${job.id}: ${error instanceof Error ? error.message : error}`));
				}
				if (store.dirty) {
					store.dirty = false;
					await surface.current?.board(store.all()).catch((error: unknown) => console.error("[pclaw] job board", error));
				}
			} finally {
				running = false;
			}
		};
		const timer = setInterval(() => void tick(), everyMs);
		return { stop: () => clearInterval(timer), tick };
	}

	/** A hint for the owner's message, or nothing. Runs before the message reaches the front model, so it's kept quick. */
	async function guideMessage(input: { id: string; text: string; channel: string; discordThreadId?: string; voice?: boolean }): Promise<string | undefined> {
		if (input.text.trim() === "") return undefined;
		decisions.record({ type: "message", id: `message:${input.id}`, modality: input.voice === true ? "voice" : "text", words: input.text.trim().split(/\s+/).length, channel: input.discordThreadId ?? input.channel });
		if (!decisions.configured) return undefined;
		const job = input.discordThreadId === undefined ? undefined : store.forThread(input.discordThreadId);
		const live = store.active().filter((each) => each.state === "working" || each.state === "needs_you");
		if (job !== undefined) {
			job.ownerAt = Date.now();
			store.put(job);
		}
		const decided = await decisions.ask({
			id: `message:${input.id}`,
			site: "message",
			timeoutMs: 1_500,
			...(job === undefined ? {} : { job: job.id }),
			state: { channel: input.channel, message: input.text.slice(-4_000), active_jobs: live.slice(0, 10).map((each) => each.title), ...(job === undefined ? {} : { this_job: job.title, card_says: job.status }) },
			questions: messageQuestions(job !== undefined),
		});
		if (decided === undefined) return undefined;
		let project: { project: string; machine: string } | undefined;
		if (pick(decided.answers.job_size).choice === "t3_job") {
			const projects = await backend.projects().catch(() => []);
			const chosen = projects.length === 0
				? undefined
				: await decisions.ask({ id: `project:${input.id}`, site: "project", timeoutMs: 1_500, state: { channel: input.channel, message: input.text.slice(0, 2_000) }, questions: projectQuestion(projects) });
			const found = projects[Number((pick(chosen?.answers.project).choice ?? "").slice(1))];
			if (found !== undefined && pick(chosen?.answers.project).choice !== "none") project = { project: found.title, machine: found.machine };
		}
		const names = (await backend.machines().catch(() => [])).map((each) => each.machine.toLowerCase());
		const words = input.text.toLowerCase().split(/\W+/);
		const guidance = messageGuidance(decided.answers, {
			liveJobs: live.length > 0,
			...(input.voice === true ? { voice: true } : {}),
			namesMachine: words.some((word) => names.includes(word)),
			...(project === undefined ? {} : { project }),
		});
		const shown = decided.arm === "guided" ? guidance : undefined;
		if (guidance !== undefined) decisions.record({ type: "guidance", id: decided.id, site: "message", arm: decided.arm, guidance, shown: shown !== undefined });
		return shown;
	}

	/**
	 * How a reply to `address` should go out: "ping" notifies, "silent" doesn't, undefined means it's not about a job.
	 * Replies in a job's thread are silent unless the front model asked otherwise.
	 */
	function delivery(address: string, reply: string): "ping" | "silent" | "plain" | "moved" | undefined {
		const [, kind, id] = address.split(":");
		// "on it" belongs in the thread that just opened, however the model was told. The channel stays clean.
		const opened = kind === "channel" ? store.active().find((each) => each.origin === address && each.discordThreadId !== undefined && each.ackMoved !== true && Date.now() - each.startedAt < ACK_MS) : undefined;
		if (opened !== undefined) {
			opened.ackMoved = true;
			store.put(opened);
			void surface.current?.note(opened, reply).catch((error: unknown) => console.error(`[pclaw] job note ${opened.id}`, error));
			return "moved";
		}
		const job = kind === "thread" ? store.forThread(id!) : store.active().find((each) => each.origin === address && each.awaitingReply === true);
		if (job === undefined) return undefined;
		const mode = kind !== "thread" ? "plain" : job.pingNext === true ? "ping" : "silent";
		delete job.pingNext;
		delete job.awaitingReply;
		job.told = [...job.told, reply.slice(0, 300)].slice(-5);
		const ended = job.state === "done" || job.state === "failed";
		if (ended && job.worker !== undefined) job.status = firstLine(reply);
		if (ended && job.closedOut !== true && job.origin.startsWith("discord:channel:")) {
			job.closedOut = true;
			void surface.current?.remember(job, reply).catch((error: unknown) => console.error(`[pclaw] couldn't close out ${job.id}`, error));
		}
		store.put(job);
		if (ended && job.worker !== undefined) void refreshCard(job);
		decisions.record({ type: "delivery", job: job.id, decision: job.decision, mode, chars: reply.length });
		return mode;
	}

	async function stop(id: string, context: Context): Promise<void> {
		const job = mustGet(id);
		if (job.worker !== undefined) {
			const run = (await harness.current?.snapshot(Workers, job.worker.conversationId, context))?.workers[job.worker.name]?.run;
			if (run !== undefined) await harness.current?.abortTask(run, context);
			return;
		}
		if (job.state !== "waiting") await backend.interrupt(job.threadId, job.environmentId);
		job.start = undefined;
		job.state = "stopped";
		job.status = "Stopped.";
		store.put(job);
		await refreshCard(job);
		await setAskReaction(job, REACTION.stopped!, context);
	}

	function modelSelection(model: string): Record<string, unknown> {
		return { ...(model.startsWith("claude") ? { instanceId: "claudeAgent" } : {}), model, ...(model.startsWith("claude") ? { options: [{ id: "effort", value: "high" }] } : {}) };
	}

	const extension = defineExtension({
		name: "pclaw.jobs",
		tools: [
			defineTool({
				name: "start_job",
				description:
					"Start work in a T3 Code thread, on any machine, with no time limit. For work they'd want to open and steer: changing code, building something, long runs. In a Discord channel it gets a thread under their message with a status card. For a one-off check on a machine, pass background: true, and the T3 thread settles itself. The agent can't see this conversation, so the brief must stand alone. Pass thread_id to keep an eye on a T3 thread that already exists.",
				parameters: Type.Object({
					title: Type.String({ description: "Short name, shown on the thread and the card." }),
					brief: Type.Optional(Type.String({ description: "Self-contained brief: the goal and why, relevant facts, constraints, and what done looks like. Required unless thread_id is given." })),
					project: Type.Optional(Type.String({ description: "Project name from list_projects. Omit for a scratch thread on `machine`." })),
					machine: Type.Optional(Type.String({ description: "Which machine: mp1, pc1, mm1. Defaults to the project's machine, else this one." })),
					model: Type.Optional(Type.String({ description: `T3 model id. Defaults to ${config.jobModel}.` })),
					workspace: Type.Optional(Type.Union([Type.Literal("worktree"), Type.Literal("root")], { description: "worktree (default for git projects): a fresh checkout. root: the project's own folder." })),
					base_ref: Type.Optional(Type.String({ description: 'Branch a worktree starts from. Defaults to "main".' })),
					thread_id: Type.Optional(Type.String({ description: "An existing T3 thread to track instead of launching one." })),
					background: Type.Optional(Type.Boolean({ description: "A one-off with nothing to open later, like reading a version or a disk's free space on a machine." })),
					emoji: Type.Optional(Type.String({ description: "A reaction for their message while the job runs: the literal emoji for the topic if there is one. Defaults to ⏳." })),
				}),
				execute: async (args, api, context) => {
					const ask = await currentAsk(harness.current, api, api.conversationId, context);
					const routes = (await api.snapshot(Routes, context))?.conversations ?? {};
					const origin = Object.keys(routes).find((address) => routes[address] === api.conversationId);
					if (origin === undefined) throw new Error("This conversation has no address, so a job here couldn't report back.");
					if (args.thread_id === undefined && args.brief === undefined) throw new Error("A new job needs a brief.");
					const model = args.model ?? config.jobModel;
					let where: Awaited<ReturnType<typeof place>> | undefined;
					let threadId = args.thread_id;
					try {
						where = await place(args);
						threadId ??= await launch(args, where, model);
					} catch (error) {
						// Watching an existing thread has nothing to hold on to, so only a new job can wait.
						if (!(error instanceof T3Down) || args.thread_id !== undefined) throw error;
						console.error(`[pclaw] ${error.message} Holding "${args.title}" until it's back.`);
					}
					const waiting = threadId === undefined;
					const machine = where?.machine ?? args.machine ?? hostname().replace(/\..*$/, "");
					const environmentId = where?.environmentId;
					const projectName = where?.project?.title ?? args.project;
					const emoji = args.emoji !== undefined && isEmoji(args.emoji.trim()) ? args.emoji.trim() : undefined;
					const now = Date.now();
					const job: Job = {
						id: `${slug(args.title)}-${randomBytes(2).toString("hex")}`,
						title: args.title,
						brief: args.brief ?? "(an existing T3 thread)",
						threadId: threadId ?? "",
						...environmentArg(environmentId),
						machine,
						...(projectName === undefined ? {} : { project: projectName }),
						model,
						origin,
						...(ask === undefined ? {} : { ask }),
						...(emoji === undefined ? {} : { emoji }),
						...(args.background === true ? { background: true } : {}),
						...(threadId === undefined ? {} : { link: await backend.linkFor(threadId, environmentId) }),
						...(waiting ? { start: { title: args.title, brief: args.brief!, ...startFields(args) } } : {}),
						state: waiting ? "waiting" : "working",
						status: waiting ? "Waiting for T3 to come back." : args.thread_id === undefined ? "Starting up." : "Watching.",
						told: [],
						startedAt: now,
						updatedAt: now,
					};
					if (args.thread_id !== undefined) {
						const view = await backend.peek(args.thread_id, environmentId);
						job.handled = turnKey(view);
						job.position = Math.max(0, view.itemCount - 1);
						job.state = turnEnded(view) ? "idle" : "working";
					}
					store.put(job);
					if (ask !== undefined) await api.commit((tx) => setReaction(tx, api.conversationId, ask, emoji ?? WORKING), context);
					const placed = await surface.current?.open(job).catch((error: unknown) => {
						console.error(`[pclaw] couldn't open a Discord thread for ${job.id}`, error);
						return undefined;
					});
					if (placed !== undefined) store.put(Object.assign(job, placed));
					// Still this turn's to explain: nothing's running, and "on it" alone would say otherwise.
					if (waiting) return text(`T3 isn't answering, so nothing has started. ${job.id} is saved and starts itself when T3 is back.`);
					decisions.record({ type: "job", event: "start", job: job.id, machine, project: projectName, model, adopted: args.thread_id !== undefined, background: args.background === true });
					console.log(`[pclaw] job ${job.id} started on ${machine}${projectName === undefined ? "" : ` in ${projectName}`}`);
					// End the turn here: what was written alongside this call is the reply.
					return { ...text(`Job ${job.id} is running in T3 on ${machine}. ${job.link ?? ""}`.trim()), control: { terminate: true } };
				},
			}),
			defineTool({
				name: "list_projects",
				description: "List the T3 projects start_job can use, and every reachable machine. A machine with no projects can still run scratch jobs.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => {
					try {
						const projects = await backend.projects();
						const lines = projects.map((project) => `${project.title} (${project.machine})${project.hasRepo ? "" : ", no git repo"}`);
						return text([`Machines: ${(await backend.machines()).map((each) => each.machine).join(", ")}`, ...lines].join("\n"));
					} catch (error) {
						if (!(error instanceof T3Down)) throw error;
						return text(`${error.message} That's T3 itself, on this machine, so it isn't about any one project or machine. It restarts on its own. start_job still works: a job waits and starts itself when T3 is back.`);
					}
				},
			}),
			defineTool({
				name: "list_jobs",
				description: "List jobs and where each stands. Use this before answering any question about how a job is going.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => {
					const jobs = store.active();
					return text(jobs.length === 0 ? "No active jobs." : jobs.map((job) => `${job.id} [${job.state}] on ${job.machine}: ${job.title}. ${job.status} ${job.link ?? ""}`.trim()).join("\n"));
				},
			}),
			defineTool({
				name: "message_job",
				description: "Send a message to a job's agent: an answer, a go-ahead, a correction. It joins the running turn, or starts a new one if the agent has stopped.",
				parameters: Type.Object({ job: Type.String(), message: Type.String() }),
				execute: async ({ job: id, message }, _api, context) => {
					if (!config.t3AllowSend) throw new Error("Sending into T3 threads is off (t3AllowSend).");
					const job = mustGet(id);
					if (job.worker !== undefined) throw new Error(`${job.title} is a worker. Use message_worker with "${job.worker.name}" from its thread once it's reported.`);
					if (job.start !== undefined) {
						job.start.brief = `${job.start.brief}\n\n${message}`;
						store.put(job);
						return text(`${job.title} hasn't started yet, so this is added to its brief.`);
					}
					await backend.send(job.threadId, job.environmentId, message);
					job.state = "working";
					job.status = "Picked up a new message.";
					store.put(job);
					await refreshCard(job);
					await setAskReaction(job, job.emoji ?? WORKING, context);
					return text(`Sent to ${job.title}.`);
				},
			}),
			defineTool({
				name: "stop_job",
				description: "Stop a job's agent mid-turn. The T3 thread stays, so it can be picked up again.",
				parameters: Type.Object({ job: Type.String() }),
				execute: async ({ job }, _api, context) => {
					await stop(job, context);
					return text(`Stopped ${job}.`);
				},
			}),
			defineTool({
				name: "ping_owner",
				description: "Make your next reply about this job a real notification. Without it, replies in a job's thread land silently. Call it before you write the message.",
				parameters: Type.Object({ job: Type.Optional(Type.String({ description: "The job's id. Optional in its own thread." })) }),
				execute: async ({ job: id }, api, context) => {
					const routes = (await api.snapshot(Routes, context))?.conversations ?? {};
					const address = Object.keys(routes).find((each) => routes[each] === api.conversationId);
					const here = address?.startsWith("discord:thread:") ? store.forThread(address.slice("discord:thread:".length)) : undefined;
					const job = id === undefined ? here : mustGet(id);
					if (job === undefined) throw new Error("Which job? Pass its id.");
					job.pingNext = true;
					store.put(job);
					return text("Your reply will notify them.");
				},
			}),
		],
	});

	return { extension, store, surface, decisions, guideMessage, delivery, stop, startKeeper, openSession, workerReporting, backend };
}
