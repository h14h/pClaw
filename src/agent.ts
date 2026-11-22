import type { spawn } from "node:child_process";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	type EntryId,
	Harness,
	type Storage,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { type Config, isPagesEnabled, isT3Enabled, paths } from "./config.ts";
import { filesExtension, FileSenders } from "./extensions/files.ts";
import { followUpsExtension, type TimeZoneResolver } from "./extensions/follow-ups.ts";
import { memoryExtension } from "./extensions/memory.ts";
import { quickSearchExtension } from "./extensions/quick-search.ts";
import { askOfRequest, reactionsExtension } from "./extensions/reactions.ts";
import { recallExtension } from "./extensions/recall.ts";
import { type Notes, notesExtension, type NotesResolver } from "./extensions/notes.ts";
import { formattingExtension, soulExtension } from "./extensions/soul.ts";
import { createJobs, JobStore, type Jobs, t3Backend } from "./extensions/jobs.ts";
import { t3Extension } from "./extensions/t3.ts";
import {
	type Decisions,
	decisionClient,
	followUpGuidance,
	followUpQuestions,
	messageGuidance,
	messageQuestions,
} from "./decisions.ts";
import { applyProfile, loadProfile } from "./profiles.ts";
import { createPromptResolver, type PromptResolver } from "./prompts.ts";
import { addressOf, ConversationInfo, Routes } from "./routes.ts";
import { SandboxManager } from "./sandbox.ts";
import { stamp } from "./time.ts";
import type { WorkerItem } from "./dashboard/types.ts";
import { workerItems } from "./dashboard/views.ts";
import { prepareWorkspace, type WorkerOptions, workerOptions, Workers, workersExtension } from "./extensions/workers.ts";
import { UserRegistry } from "./users.ts";
import { ProgressSurfaces } from "./worker-progress.ts";

export type Agent = {
	harness: Harness;
	/** Real work in T3 threads, and the hints that guide it. */
	jobs: Jobs;
	/** Whether T3 / Jobs are enabled for this agent. */
	t3Enabled: boolean;
	/** Canonical multi-user registry (`users.enabled === false` in single-owner mode). */
	users: UserRegistry;
	/** Per-user worker sandbox & session-dir resolver. */
	sandboxes: SandboxManager;
	/** Per-channel outbound file sender hooks (`send_file`). */
	fileSenders: FileSenders;
	/** Per-channel live worker progress surfaces (e.g. Telegram ephemeral DM bubbles). */
	progressSurfaces: ProgressSurfaces;
	/** Read live transcript items for a worker session across all sandbox session dirs. */
	workerItems(sessionId: string): WorkerItem[];
	/** Per-agent prompt resolver (supports `voiceFile` / `personaDir` without global mutation). */
	prompts: PromptResolver;
	/** The conversation for `address`, created on first use. */
	conversationFor(address: string, context: Context): Promise<Conversation>;
	/** Addresses that have a conversation, for reattaching delivery after a restart. */
	addresses(context: Context): Promise<Record<string, ConversationId>>;
	/**
	 * A new conversation for `address` that starts as a copy of `parent` up to `at` and continues on its own: a Discord
	 * thread off a channel, for instance. Returns the existing one if `address` already has a conversation.
	 */
	forkFor(address: string, parent: Conversation, at: EntryId, info: { label: string }, context: Context): Promise<Conversation>;
	/** Record how a conversation is labelled in the dashboard. */
	describe(id: ConversationId, info: { label: string; parent?: ConversationId }, context: Context): Promise<void>;
	/** Switch every conversation to another front model, from the next request on. */
	setModel(choice: { provider: string; model: string; thinkingLevel: ModelThinkingLevel }, context: Context): Promise<void>;
	/**
	 * The person's message a user entry stands for ("telegram:<id>", "discord:<id>"): their own message, or, for a
	 * worker's report, the message that asked for the job. Read from durable submission records, so it doesn't depend
	 * on the run still being live. Undefined for follow-ups, job updates, reactions, and the like.
	 */
	askOf(conversationId: ConversationId, userEntry: EntryId, context: Context): Promise<string | undefined>;
	/** The asks of the conversation's workers that are working now, "" for one with no ask on record. */
	activeWorkerAsks(conversationId: ConversationId, context: Context): Promise<string[]>;
};

function disabledJobs(
	decisions: Decisions,
	storeFile: string,
	harness: { current?: Harness },
	context: Context,
): Jobs {
	const store = new JobStore(storeFile);
	const emptyExtension = { name: "pclaw.jobs.disabled" } as Jobs["extension"];
	const noopBackend = {} as Jobs["backend"];
	async function activeWorkerNames(): Promise<string[]> {
		const h = harness.current;
		if (h === undefined) return [];
		const routes = (await h.snapshot(Routes, context))?.conversations ?? {};
		const names: string[] = [];
		for (const id of Object.values(routes)) {
			const doc = await h.snapshot(Workers, id, context);
			for (const [name, worker] of Object.entries(doc?.workers ?? {})) {
				if (worker.status === "working") names.push(name);
			}
		}
		return names;
	}
	async function guideMessage(input: {
		id: string;
		text: string;
		channel: string;
		discordThreadId?: string;
		voice?: boolean;
	}): Promise<string | undefined> {
		if (input.text.trim() === "") return undefined;
		decisions.record({
			type: "message",
			id: `message:${input.id}`,
			modality: input.voice === true ? "voice" : "text",
			words: input.text.trim().split(/\s+/).length,
			channel: input.discordThreadId ?? input.channel,
		});
		if (!decisions.configured) return undefined;
		const active = await activeWorkerNames();
		const decided = await decisions.ask({
			id: `message:${input.id}`,
			site: "message",
			timeoutMs: 1_500,
			state: {
				channel: input.channel,
				message: input.text.slice(-4_000),
				active_jobs: active.slice(0, 10),
			},
			questions: messageQuestions(false),
		});
		if (decided === undefined) return undefined;
		const guidance = messageGuidance(decided.answers, {
			allowT3: false,
			liveJobs: active.length > 0,
			...(input.voice === true ? { voice: true } : {}),
		});
		const shown = decided.arm === "guided" ? guidance : undefined;
		if (guidance !== undefined) {
			decisions.record({
				type: "guidance",
				id: decided.id,
				site: "message",
				arm: decided.arm,
				guidance,
				shown: shown !== undefined,
			});
		}
		return shown;
	}
	return {
		extension: emptyExtension,
		store,
		surface: {},
		decisions,
		guideMessage,
		delivery: () => undefined,
		stop: async () => undefined,
		startKeeper: () => ({ stop() {}, tick: async () => undefined }),
		openSession: async () => undefined,
		workerReporting: async () => undefined,
		backend: noopBackend,
	};
}

export async function openAgent(
	storage: Storage,
	options: {
		config: Config;
		models: Models;
		notes: Notes;
		workers?: WorkerOptions;
		/** Stand-ins for tests. */
		jobBackend?: Jobs["backend"];
		decisions?: Decisions;
		jobStore?: JobStore;
		workerItems?: (sessionId: string) => WorkerItem[];
		/** Override home directory for per-user storage in tests. */
		homeDir?: string;
		users?: UserRegistry;
		sandboxes?: SandboxManager;
		sshCommand?: string;
		spawnFn?: typeof spawn;
		/** How long a conversation stays quiet before the memory pass reads it. */
		memoryQuietMs?: number;
		now?: () => number;
	},
	context: Context,
): Promise<Agent> {
	const { config, models, notes } = options;
	const profile = loadProfile(config.profile);
	const promptResolver = createPromptResolver({
		profileDir: profile.dir,
		...(config.personaDir === undefined ? {} : { personaDir: config.personaDir }),
		...(config.voiceFile === undefined ? {} : { voiceFile: config.voiceFile }),
	});
	const t3Enabled = isT3Enabled(config);
	const users = options.users ?? new UserRegistry(config.users, options.homeDir);
	const allowPages =
		isPagesEnabled(config, "local") &&
		(!users.enabled || users.all().some((user) => (user.sandbox?.type ?? "local") !== "ssh"));

	const workers = options.workers ?? workerOptions(config, paths, promptResolver);
	prepareWorkspace(workers);
	const sandboxes =
		options.sandboxes ??
		new SandboxManager({
			config,
			users,
			defaultWorkDir: workers.cwd,
			defaultInboxDir: options.homeDir === undefined ? paths.inbox : join(options.homeDir, "inbox"),
			defaultSessionDir: workers.sessionDir,
			...(options.sshCommand === undefined ? {} : { sshCommand: options.sshCommand }),
			...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
		});
	const fileSenders = new FileSenders();
	const progressSurfaces = new ProgressSurfaces();
	const findWorkerItems =
		options.workerItems ??
		((sessionId: string) => {
			for (const dir of sandboxes.allSessionDirs()) {
				const items = workerItems(dir, sessionId);
				if (items.length > 0) return items;
			}
			return [];
		});

	const notesResolver: NotesResolver = users.enabled
		? async (read, conversationId, ctx) => {
				const addr = await addressOf(read, conversationId, ctx);
				const user = users.resolveAddress(addr);
				return user === undefined ? undefined : users.notesFor(user.id);
			}
		: async () => notes;

	const timeZoneResolver: TimeZoneResolver = users.enabled
		? async (read, conversationId, ctx) => {
				const addr = await addressOf(read, conversationId, ctx);
				return users.resolveAddress(addr)?.timeZone ?? config.timeZone;
			}
		: async () => config.timeZone;

	const registry = createRegistry();
	let hasDeferredTools = false;
	const install = (extension: Parameters<typeof applyProfile>[0]) => {
		const applied = applyProfile(extension, profile);
		if (applied.tools?.some((tool) => tool.deferred === true)) hasDeferredTools = true;
		registry.install(applied);
	};

	const current: { current?: Harness } = {};
	const sessions: { current?: Jobs } = {};

	const promptFlags = { allowT3: t3Enabled, allowPages };
	registry.install(
		soulExtension({
			timeZone: config.timeZone,
			prompts: promptResolver,
			flags: promptFlags,
			users,
			harness: current,
			...(options.now === undefined ? {} : { now: options.now }),
		}),
	);
	install(notesExtension(notesResolver));
	const decisions = options.decisions ?? decisionClient({ url: config.decisionUrl, logFile: paths.decisions, holdout: config.decisionHoldout });
	install(
		followUpsExtension(timeZoneResolver, options.now, async (id, note, tz) => {
			const decided = await decisions.ask({
				id,
				site: "follow-up",
				state: { follow_up: note.slice(0, 2_000), local_time: stamp(Date.now(), tz ?? config.timeZone) },
				questions: followUpQuestions,
			});
			if (decided === undefined) return undefined;
			const guidance = followUpGuidance(decided.answers);
			if (guidance !== undefined) decisions.record({ type: "guidance", id, site: "follow-up", arm: decided.arm, guidance, shown: decided.arm === "guided" });
			return decided.arm === "guided" ? guidance : undefined;
		}),
	);
	install(
		workersExtension(workers, current, {
			log: decisions.record,
			workerItems: findWorkerItems,
			...(t3Enabled
				? {
						session: async (worker, ctx) => sessions.current?.openSession(worker, ctx),
					}
				: {}),
			reporting: async (worker, ctx) => {
				if (t3Enabled) await sessions.current?.workerReporting(worker, ctx);
				if (current.current !== undefined) {
					const addr = await addressOf(current.current, worker.conversationId, ctx);
					const channel = addr?.split(":")[0];
					const surface = channel === undefined ? undefined : progressSurfaces.get(channel);
					if (addr !== undefined && surface?.finish !== undefined) {
						await surface.finish({
							address: addr,
							workerName: worker.name,
							sessionId: worker.sessionId,
							ok: worker.ok,
						});
					}
				}
			},
			resolveSandbox: async (read, conversationId, ctx) => {
				const addr = await addressOf(read, conversationId, ctx);
				const resolved = sandboxes.forAddress(addr);
				return { sandbox: resolved.sandbox, sessionDir: resolved.sessionDir };
			},
		}),
	);
	install(
		filesExtension({
			fileSenders,
			harness: current,
			resolveSandbox: async (read, conversationId, ctx) => {
				const addr = await addressOf(read, conversationId, ctx);
				const resolved = sandboxes.forAddress(addr);
				return { address: addr, sandbox: resolved.sandbox };
			},
		}),
	);
	const memory = memoryExtension({
		notes: notesResolver,
		models,
		config,
		quietMs: options.memoryQuietMs ?? config.memoryQuietMinutes * 60_000,
		prompts: promptResolver,
	});
	registry.install(memory.extension);
	install(recallExtension(current, config.timeZone, { users }));
	install(reactionsExtension(current));
	install(quickSearchExtension());

	let jobs: Jobs;
	if (t3Enabled) {
		jobs = createJobs({
			store: options.jobStore ?? new JobStore(paths.jobs),
			backend: options.jobBackend ?? t3Backend(config.t3Url, paths.t3Auth),
			decisions,
			models,
			config,
			harness: current,
			prompts: promptResolver,
			workerItems: findWorkerItems,
		});
		sessions.current = jobs;
		install(jobs.extension);
		install(
			t3Extension({
				t3Url: config.t3Url,
				storeFile: paths.t3Auth,
				redirectUri: config.t3RedirectUri ?? `http://127.0.0.1:${config.dashboardPort}/t3/callback`,
				allowSend: config.t3AllowSend,
				pollMs: Math.max(15, config.t3PollSeconds) * 1000,
				timeZone: config.timeZone,
			}),
		);
	} else {
		jobs = disabledJobs(
			decisions,
			options.homeDir === undefined ? paths.jobs : join(options.homeDir, "jobs.json"),
			current,
			context,
		);
	}

	if (hasDeferredTools) registry.install(createToolSearchExtension());
	// Last, so the app's rules end the system prompt.
	registry.install(formattingExtension({ prompts: promptResolver, flags: promptFlags }));

	let agent = { model: { provider: config.provider, modelId: config.model }, thinkingLevel: config.thinkingLevel };
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: { retry: { maxRetries: 3 }, toolExecution: "parallel", compaction: { keepRecentTokens: config.keepRecentTokens } },
			onReport: (error) => console.error("[pclaw]", error),
			...(options.now === undefined ? {} : { now: options.now }),
		},
		context,
	);

	const configured = new Set<ConversationId>();

	current.current = harness;

	async function conversationFor(address: string, context: Context): Promise<Conversation> {
		const known = (await harness.snapshot(Routes, context))?.conversations[address];
		const existing = known === undefined ? undefined : await harness.conversation(known, context);
		if (existing !== undefined) {
			// Pick up model changes from config.json once per process.
			if (!configured.has(existing.id)) {
				await existing.configure(agent, context);
				await memory.ensureKeeper(harness, existing.id, context);
				configured.add(existing.id);
			}
			return existing;
		}
		const created = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
		await created.commit(async (tx) => {
			(await tx.doc(Routes)).conversations[address] = created.id;
		}, context);
		await memory.ensureKeeper(harness, created.id, context);
		configured.add(created.id);
		return created;
	}

	async function addresses(context: Context) {
		return (await harness.snapshot(Routes, context))?.conversations ?? {};
	}

	async function forkFor(address: string, parent: Conversation, at: EntryId, info: { label: string }, context: Context) {
		const known = (await harness.snapshot(Routes, context))?.conversations[address];
		const existing = known === undefined ? undefined : await harness.conversation(known, context);
		if (existing !== undefined) return existing;
		const fork = await parent.fork(at, { ownership: { kind: "ownerless" }, agent }, context);
		await fork.commit(async (tx) => {
			(await tx.doc(Routes)).conversations[address] = fork.id;
			(await tx.doc(ConversationInfo)).conversations[String(fork.id)] = { label: info.label, parent: parent.id, forkedAt: at };
		}, context);
		await memory.ensureKeeper(harness, fork.id, context);
		configured.add(fork.id);
		return fork;
	}

	async function describe(id: ConversationId, info: { label: string; parent?: ConversationId }, context: Context) {
		const currentInfo = (await harness.snapshot(ConversationInfo, context))?.conversations[String(id)];
		if (currentInfo?.label === info.label && currentInfo.parent === info.parent) return;
		const conversation = await harness.conversation(id, context);
		await conversation?.commit(async (tx) => {
			const doc = await tx.doc(ConversationInfo);
			// Keep the fork point; only the label and parent come from the channel.
			const forkedAt = doc.conversations[String(id)]?.forkedAt;
			doc.conversations[String(id)] = {
				label: info.label,
				...(info.parent === undefined ? {} : { parent: info.parent }),
				...(forkedAt === undefined ? {} : { forkedAt }),
			};
		}, context);
	}

	async function setModel(choice: { provider: string; model: string; thinkingLevel: ModelThinkingLevel }, context: Context) {
		agent = { model: { provider: choice.provider, modelId: choice.model }, thinkingLevel: choice.thinkingLevel };
		for (const id of Object.values(await addresses(context))) {
			await (await harness.conversation(id, context))?.configure(agent, context);
			configured.add(id);
		}
	}

	/** User entry -> ask, by conversation. A placed submission never changes its entry, so results are kept. */
	const asks = new Map<string, string | null>();
	const ASK_SCAN_LIMIT = 500;
	async function askOf(conversationId: ConversationId, userEntry: EntryId, context: Context): Promise<string | undefined> {
		const key = `${conversationId}:${userEntry}`;
		const known = asks.get(key);
		if (known !== undefined) return known ?? undefined;
		let requestId: string | undefined;
		let found = false;
		let scanned = 0;
		let cursor: Parameters<Storage["scanSubmissions"]>[2];
		do {
			const page = await storage.scanSubmissions({ conversationId, order: "descending" }, 100, cursor, context);
			const match = page.items.find((record) => record.entry === userEntry);
			if (match !== undefined) {
				found = true;
				requestId = match.requestId;
			}
			scanned += page.items.length;
			cursor = page.next;
		} while (!found && cursor !== undefined && scanned < ASK_SCAN_LIMIT);
		// Not found yet could mean an entry from another conversation (a fork's parent): don't remember a miss.
		if (!found) return undefined;
		const ask = requestId === undefined ? undefined : await askOfRequest(harness, conversationId, requestId, context);
		if (asks.size >= 2_000) asks.delete(asks.keys().next().value!);
		asks.set(key, ask ?? null);
		return ask;
	}

	async function activeWorkerAsks(conversationId: ConversationId, context: Context): Promise<string[]> {
		const doc = await harness.snapshot(Workers, conversationId, context);
		return Object.values(doc?.workers ?? {}).flatMap((worker) => (worker.status === "working" ? [worker.ask ?? ""] : []));
	}

	harness.resume();
	return {
		harness,
		jobs,
		t3Enabled,
		users,
		sandboxes,
		fileSenders,
		progressSurfaces,
		workerItems: findWorkerItems,
		prompts: promptResolver,
		conversationFor,
		addresses,
		forkFor,
		describe,
		setModel,
		askOf,
		activeWorkerAsks,
	};
}
