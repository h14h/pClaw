import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { stamp, utcOffset } from "../time.ts";

export type Repeat = "daily" | "weekly";
type FollowUpItem = { note: string; dueAt: number; repeat?: Repeat };

/** Scheduled follow-ups of one conversation, keyed by the id of the task that will deliver each one. */
export const FollowUps = defineDoc<{ items: Record<string, FollowUpItem> }>({
	kind: "pclaw.follow-ups",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
});

type FollowUpState = { phase: "wait" } | { phase: "fire" };

const DAY = 24 * 60 * 60 * 1000;

function offsetMinutes(at: number, timeZone: string): number {
	const match = /UTC([+-])(\d{2}):(\d{2})/.exec(utcOffset(at, timeZone));
	if (match === null) return 0;
	const minutes = Number(match[2]) * 60 + Number(match[3]);
	return match[1] === "-" ? -minutes : minutes;
}

/** The next occurrence at the same wall-clock time, across daylight saving changes. */
export function nextOccurrence(dueAt: number, repeat: Repeat, timeZone: string): number {
	const next = dueAt + (repeat === "daily" ? 1 : 7) * DAY;
	return next + (offsetMinutes(dueAt, timeZone) - offsetMinutes(next, timeZone)) * 60_000;
}

export function wakeMessage(note: string, at: number, timeZone: string): string {
	return `[${stamp(at, timeZone)}]\n<follow-up>${note}</follow-up>`;
}

/**
 * Sleeps until a follow-up is due, then hands it to the conversation as a new input. The sleep survives restarts: the
 * phase runs again on reopen and sleeps until the same time. Cancelling removes the item from the document, and the
 * task ends quietly when it wakes and finds it gone.
 */
export function followUpTask(timeZone: string) {
	return defineTask<null, FollowUpState, null>({
		name: "pclaw.follow-up",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				const item = (await runtime.snapshot(FollowUps, runtime.conversationId, context))?.items[task.id];
				if (item !== undefined) await runtime.sleep(item.dueAt, context);
				await runtime.commit(
					() =>
						item === undefined
							? { status: "terminal", outcome: { status: "completed", result: null } }
							: { status: "running", checkpoint: { phase: "fire" } },
					context,
				);
			},
			fire: async (task, runtime, context) => {
				const item = (await runtime.snapshot(FollowUps, runtime.conversationId, context))?.items[task.id];
				if (item !== undefined) {
					const conversation = await runtime.conversation(runtime.conversationId, context);
					await conversation?.submit(
						{
							type: "input",
							content: wakeMessage(item.note, item.dueAt, timeZone),
							whenBusy: "followUp",
							// A restart between submitting and committing must not deliver it twice.
							requestId: `follow-up:${task.id}:${item.dueAt}`,
						},
						context,
					);
				}
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(FollowUps, runtime.conversationId);
					const current = doc.items[task.id];
					if (current?.repeat !== undefined) {
						current.dueAt = nextOccurrence(current.dueAt, current.repeat, timeZone);
						return { status: "running", checkpoint: { phase: "wait" } };
					}
					delete doc.items[task.id];
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				delete (await tx.doc(FollowUps, runtime.conversationId)).items[task.id];
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function followUpsExtension(timeZone: string, now: () => number = Date.now) {
	const FollowUp = followUpTask(timeZone);
	return defineExtension({
		name: "pclaw.follow-ups",
		tasks: [FollowUp],
		tools: [
			defineTool({
				name: "follow_up",
				description:
					"Schedule a message to yourself that arrives at a set time, so you can check in, remind them, or " +
					"pick a thread back up. Use it for reminders they ask for and for natural follow-ups (how did the " +
					"interview go, did the package arrive). When it's due you'll get the note back and decide what to send.",
				parameters: Type.Object({
					at: Type.String({
						description: "When, as ISO 8601 with a UTC offset, e.g. 2026-10-03T09:00:00-07:00.",
					}),
					note: Type.String({
						description: "What to follow up on, with enough context that it makes sense days from now.",
					}),
					repeat: Type.Optional(Type.Union([Type.Literal("daily"), Type.Literal("weekly")])),
				}),
				execute: async (args, api, context) => {
					const dueAt = Date.parse(args.at);
					if (Number.isNaN(dueAt)) throw new Error(`Couldn't read "${args.at}" as a time. Use ISO 8601 with an offset.`);
					if (dueAt < now() - 60_000) throw new Error(`${args.at} is in the past.`);
					const id = await api.commit(async (tx) => {
						const taskId = await tx.createTask(FollowUp, null, { ownership: { kind: "conversation" }, background: true });
						const item: FollowUpItem = { note: args.note, dueAt };
						if (args.repeat !== undefined) item.repeat = args.repeat;
						(await tx.doc(FollowUps, api.conversationId)).items[taskId] = item;
						return taskId;
					}, context);
					const repeat = args.repeat === undefined ? "" : `, repeating ${args.repeat}`;
					return text(`Scheduled for ${stamp(dueAt, timeZone)}${repeat}. id: ${id}`);
				},
			}),
			defineTool({
				name: "list_follow_ups",
				description: "List the follow-ups you have scheduled, soonest first.",
				parameters: Type.Object({}),
				execute: async (_args, api, context) => {
					const items = Object.entries((await api.snapshot(FollowUps, api.conversationId, context))?.items ?? {});
					if (items.length === 0) return text("Nothing scheduled.");
					items.sort(([, a], [, b]) => a.dueAt - b.dueAt);
					return text(
						items
							.map(([id, item]) => {
								const repeat = item.repeat === undefined ? "" : ` (${item.repeat})`;
								return `${id}: ${stamp(item.dueAt, timeZone)}${repeat}: ${item.note}`;
							})
							.join("\n"),
					);
				},
			}),
			defineTool({
				name: "cancel_follow_up",
				description: "Cancel a scheduled follow-up by its id (from list_follow_ups).",
				parameters: Type.Object({ id: Type.String() }),
				execute: async (args, api, context) => {
					const found = await api.commit(async (tx) => {
						const doc = await tx.doc(FollowUps, api.conversationId);
						if (doc.items[args.id] === undefined) return false;
						delete doc.items[args.id];
						return true;
					}, context);
					return text(found ? "Cancelled." : `No follow-up with id ${args.id}.`);
				},
			}),
		],
	});
}
