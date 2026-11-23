import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { type Decisions, INTENT_THRESHOLD, inWorkerGuidance, inWorkerQuestions, readWorkerIntent, type WorkerIntent } from "./decisions.ts";
import { noteAside, touchWorker, Workers } from "./extensions/workers.ts";
import type { PromptResolver } from "./prompts.ts";

/**
 * A message that arrives while work runs in the same conversation (a DM as much as a job thread) is read for what it
 * is to that work: a steer, a status check, side chat, or a new task. The read becomes a hint for the front model, and
 * it's recorded on the workers, so their progress updates know which messages were really about something else.
 */

export type WorkerIntentRead = { intent: WorkerIntent; p: number; worker?: string; guidance?: string };

const preview = (text: string) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
};

export async function readForWorkers(options: {
	harness: Harness | undefined;
	decisions: Decisions;
	conversationId: ConversationId | undefined;
	id: string;
	text: string;
	/** What their message replies to, when it's a reply. */
	replyTo?: string;
	prompts?: PromptResolver;
	context: Context;
	now?: () => number;
}): Promise<WorkerIntentRead | undefined> {
	const { harness, decisions, conversationId, context } = options;
	const now = options.now ?? Date.now;
	if (harness === undefined || conversationId === undefined || !decisions.configured || options.text.trim() === "") return undefined;
	const doc = await harness.snapshot(Workers, conversationId, context);
	const working = Object.entries(doc?.workers ?? {}).filter(([, worker]) => worker.status === "working");
	if (working.length === 0) return undefined;
	const names = working.map(([name]) => name);
	const at = now();
	const decided = await decisions.ask({
		id: `in-worker:${options.id}`,
		site: "in-worker",
		state: {
			running_work: working.map(([name, worker]) => ({
				name,
				goal: worker.brief.slice(0, 400),
				...(worker.startedAt === undefined ? {} : { running_for_sec: Math.round((at - worker.startedAt) / 1000) }),
			})),
			message: options.text.slice(-2_000),
			...(options.replyTo === undefined ? {} : { replying_to: options.replyTo.slice(0, 400) }),
		},
		questions: inWorkerQuestions(working.map(([name, worker]) => ({ name, goal: worker.brief }))),
	});
	if (decided === undefined) return undefined;
	const read = readWorkerIntent(decided.answers, names);
	if (read === undefined) return undefined;

	// Recorded whatever the arm: it's what the message was, not a hint. Unsure reads are left out.
	if (read.p >= INTENT_THRESHOLD) {
		const conversation = await harness.conversation(conversationId, context);
		await conversation
			?.commit(async (tx) => {
				const workers = (await tx.doc(Workers, conversationId)).workers;
				for (const name of names) {
					const worker = workers[name];
					if (worker === undefined || worker.status !== "working") continue;
					if (read.intent === "steer" || read.intent === "status") {
						if (read.worker === undefined || read.worker === name) touchWorker(worker, at);
					} else noteAside(worker, { at, intent: read.intent, preview: preview(options.text) });
				}
			}, context)
			.catch((error: unknown) => console.error("[pclaw] couldn't record what a message was to running work", error));
	}
	decisions.record({ type: "in-worker", id: decided.id, arm: decided.arm, intent: read.intent, p: read.p, ...(read.worker === undefined ? {} : { worker: read.worker }) });

	const guidance = inWorkerGuidance(decided.answers, names, options.prompts);
	if (guidance !== undefined) decisions.record({ type: "guidance", id: decided.id, site: "in-worker", arm: decided.arm, guidance, shown: decided.arm === "guided" });
	return { ...read, ...(guidance !== undefined && decided.arm === "guided" ? { guidance } : {}) };
}

/**
 * One hint from the message read and the in-worker read. A confident steer or status check is about the running work,
 * so the message read's take (often "new research") would only pull the other way: the in-worker hint stands alone.
 */
export function combineGuidance(message: string | undefined, worker: WorkerIntentRead | undefined): string | undefined {
	if (worker?.guidance !== undefined && (worker.intent === "steer" || worker.intent === "status")) return worker.guidance;
	const parts = [message, worker?.guidance].filter((part): part is string => part !== undefined);
	return parts.length === 0 ? undefined : parts.join("\n");
}
