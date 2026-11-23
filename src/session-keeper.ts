import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { AssistantEntry, LiveDoc, UserEntry } from "@earendil-works/pi-durable";
import type { Agent } from "./agent.ts";
import { type Config, resolveSessionResetPolicy } from "./config.ts";
import { distillEpisode, extractSessionTranscript } from "./episodes.ts";
import type { JobStore } from "./extensions/jobs.ts";
import { Workers } from "./extensions/workers.ts";
import { scopeForAddress } from "./search-index.ts";

const CHECK_MS = 60_000;
const RETRY_BACKOFF_MS = 5 * 60_000;
const BLOCKING_JOB_STATES = new Set(["waiting", "working", "needs_you"]);

function localDateParts(at: number, timeZone: string): { year: number; month: number; day: number; hour: number } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(at)
			.map((part) => [part.type, part.value]),
	);
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
	};
}

/**
 * The "reset day" key for `at` relative to `dailyHour` in `timeZone`.
 * Timestamps before `dailyHour:00` belong to the previous calendar day's bucket, so
 * `resetDay(lastTurnAt) !== resetDay(now)` is true iff a local `dailyHour:00` boundary was crossed.
 */
function resetDayKey(at: number, dailyHour: number, timeZone: string): string {
	const { year, month, day, hour } = localDateParts(at, timeZone);
	const effective = hour >= dailyHour ? new Date(Date.UTC(year, month - 1, day)) : new Date(Date.UTC(year, month - 1, day - 1));
	return effective.toISOString().slice(0, 10);
}

/** Whether local time in `timeZone` crossed `dailyHour:00` between `lastTurnAt` and `now`. */
export function crossedDailyBoundary(lastTurnAt: number, now: number, dailyHour: number, timeZone: string): boolean {
	if (now <= lastTurnAt) return false;
	return resetDayKey(lastTurnAt, dailyHour, timeZone) !== resetDayKey(now, dailyHour, timeZone);
}

/** Whether any active T3 job is currently tied to `address`. */
export function hasActiveJobForAddress(store: JobStore, address: string): boolean {
	for (const job of store.active()) {
		if (!BLOCKING_JOB_STATES.has(job.state)) continue;
		if (job.origin === address) return true;
		if (job.discordThreadId !== undefined && address === `discord:thread:${job.discordThreadId}`) return true;
	}
	return false;
}

/** Pure policy evaluation for whether an idle session should reset now. */
export function evaluateSessionReset(params: {
	address: string;
	config: Config["sessionReset"];
	lastTurnAt: number;
	now: number;
	timeZone: string;
}): { shouldReset: boolean; reason?: string } {
	const policy = resolveSessionResetPolicy(params.config, params.address);
	const quietMs = params.now - params.lastTurnAt;
	if (quietMs < 0) return { shouldReset: false };

	if (policy.idleMinutes !== null && quietMs >= policy.idleMinutes * 60_000) {
		return {
			shouldReset: true,
			reason: `idle ${Math.round(quietMs / 60_000)}m >= ${policy.idleMinutes}m (${policy.clientKey})`,
		};
	}

	if (
		policy.dailyHour !== null &&
		quietMs >= policy.dailyMinQuietMinutes * 60_000 &&
		crossedDailyBoundary(params.lastTurnAt, params.now, policy.dailyHour, params.timeZone)
	) {
		return {
			shouldReset: true,
			reason: `daily ${policy.dailyHour}:00 rollover, quiet ${Math.round(quietMs / 60_000)}m (${policy.clientKey})`,
		};
	}

	return { shouldReset: false };
}

/**
 * Background session keeper: watches idle conversations, flushes unreviewed memory,
 * distills ended sessions into `<recent-episodes>` + FTS5, and commits `pi.reset` off the reply path.
 */
export function startSessionKeeper(
	agent: Agent,
	options: {
		models: Models;
		config: Config;
		everyMs?: number;
		now?: () => number;
	},
	context: Context,
): { stop(): void; tick(): Promise<void> } {
	const everyMs = options.everyMs ?? CHECK_MS;
	const nowFn = options.now ?? Date.now;
	const pending = new Set<string>();
	const retryAfter = new Map<string, number>();

	const tick = async () => {
		const now = nowFn();
		const routes = await agent.addresses(context);
		for (const [address, id] of Object.entries(routes)) {
			const convKey = String(id);
			if (pending.has(convKey)) continue;
			if ((retryAfter.get(convKey) ?? 0) > now) continue;

			const live = await agent.harness.snapshot(LiveDoc, id, context);
			if (live?.run !== undefined || (live?.compactions?.length ?? 0) > 0) continue;

			const workersDoc = await agent.harness.snapshot(Workers, id, context);
			const hasWorkingWorker = Object.values(workersDoc?.workers ?? {}).some((worker) => worker.status === "working");
			if (hasWorkingWorker) continue;

			if (hasActiveJobForAddress(agent.jobs.store, address)) continue;

			const conversation = await agent.harness.conversation(id, context);
			if (conversation === undefined) continue;

			const active = (await conversation.context(context)).entries;
			const transcript = extractSessionTranscript(active);
			if (transcript.humanTurns === 0 || transcript.endedAt === undefined || transcript.firstEntryId === undefined || transcript.lastEntryId === undefined) {
				continue;
			}

			const timeZone = agent.users.resolveAddress(address)?.timeZone ?? options.config.timeZone;
			const decision = evaluateSessionReset({
				address,
				config: options.config.sessionReset,
				lastTurnAt: transcript.endedAt,
				now,
				timeZone,
			});
			if (!decision.shouldReset) continue;

			pending.add(convKey);
			try {
				// 1. Flush any unreviewed conversation turns into notes.md before resetting.
				await agent.flushMemory(id, context);

				// 2. Distill episode summary from the ended session (skipping trivial noise).
				let savedTitle: string | undefined;
				if (transcript.lines.length > 0) {
					const distilled = await distillEpisode({
						models: options.models,
						config: options.config,
						transcript: transcript.lines.join("\n\n"),
						prompts: agent.prompts,
						...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
					});
					if (!distilled.skip) {
						const scope = scopeForAddress(address, id, agent.users);
						const channel = address.split(":")[0] ?? "unknown";
						const ep = agent.searchIndex.saveEpisode({
							userId: scope,
							conversationId: convKey,
							channel,
							startedAt: transcript.startedAt ?? transcript.endedAt,
							endedAt: transcript.endedAt,
							firstEntryId: transcript.firstEntryId,
							lastEntryId: transcript.lastEntryId,
							title: distilled.title,
							summary: distilled.summary,
							createdAt: nowFn(),
						});
						savedTitle = ep.title;
					}
				}

				// 3. Index raw messages & worker reports into FTS5 before resetting active context.
				await agent.searchIndex.syncConversation(agent.harness, id, address, context, agent.users);

				// 4. Guard against race: if a new user/assistant turn arrived while distillation ran, abort reset.
				// (Ignore our own `NotesUpdate` display entry appended by `flushMemory` above.)
				const latestLive = await agent.harness.snapshot(LiveDoc, id, context);
				const latestEntries = (await conversation.context(context)).entries;
				const hasNewTurn = latestEntries.some(
					(entry) => (UserEntry.is(entry) || AssistantEntry.is(entry)) && Number(entry.id) > transcript.lastEntryId!,
				);
				if (latestLive?.run !== undefined || (latestLive?.compactions?.length ?? 0) > 0 || hasNewTurn) {
					continue;
				}

				await conversation.reset(undefined, context);
				retryAfter.delete(convKey);
				console.log(
					`[pclaw] reset session ${address} (${decision.reason}${savedTitle === undefined ? ", skipped episode" : `, episode "${savedTitle}"`})`,
				);
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				retryAfter.set(convKey, nowFn() + RETRY_BACKOFF_MS);
				console.error(`[pclaw] session reset failed for ${address}`, error);
			} finally {
				pending.delete(convKey);
			}
		}
	};

	const timer = setInterval(
		() => void tick().catch((error: unknown) => console.error("[pclaw] session keeper check", error)),
		everyMs,
	);
	return {
		stop: () => clearInterval(timer),
		tick,
	};
}
