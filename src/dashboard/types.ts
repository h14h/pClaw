/**
 * What the dashboard API returns. Shared by the server (src/dashboard/) and the web app (web/), which imports these
 * with `import type` only.
 *
 * Endpoints (all JSON unless noted):
 *   GET /api/overview                                  Overview
 *   GET /api/conversations/:id                         ConversationView
 *   GET /api/conversations/:id/workers/:name           WorkerDetail
 *   GET /api/events                                    text/event-stream of Change, one JSON object per `data:` line
 *   GET /api/settings                                  Settings
 *   PUT /api/settings/models   body ModelsUpdate       Settings (400 { error } when a model or level isn't valid)
 *   PUT /api/settings/prompts/:which   body { text }   Settings; :which is "front" or "worker"
 * Writes need `Content-Type: application/json`. Changes apply to the next model request; nothing restarts.
 */

export type Overview = {
	front: ModelInfo;
	worker: ModelInfo;
	conversations: ConversationSummary[];
	/** The notes file, verbatim. */
	notes: string;
	/** Workers' read_page calls across all jobs: how many, and the sites that failed (most failures first). */
	pageReads: { total: number; failing: PageReadFailure[] };
};

export type PageReadFailure = { host: string; failures: number; lastAt: number; lastError: string };

export type ModelInfo = { provider: string; model: string; thinkingLevel: string };

export type ConversationSummary = {
	id: string;
	/** "discord:dm:<user id>", "terminal". */
	address: string;
	/** Human label: "Discord DM", "#general", a thread's name, "Terminal". */
	label: string;
	/** For a thread: the conversation it forked from, at the message the thread started on. */
	parentId?: string;
	busy: boolean;
	workersRunning: number;
};

export type ConversationView = {
	id: string;
	address: string;
	label: string;
	parentId?: string;
	/** For a thread: id of the last timeline item it shares with its parent. Its own messages start after it. */
	forkedAt?: string;
	/** What the front model is doing right now. */
	live: LiveStatus;
	/** Oldest first. The active transcript; anything compacted away is gone from here. */
	timeline: TimelineItem[];
	/** Newest activity first. */
	workers: WorkerSummary[];
	/** Soonest first. */
	followUps: FollowUp[];
	usage: Usage;
};

export type LiveStatus =
	| { state: "idle" }
	/** A model request is streaming. `text` is the partial reply so far, if any. */
	| { state: "generating"; since?: number; text?: string }
	/** The front model's own tools are running (not workers; those are in `workers`). */
	| { state: "tools"; tools: string[] };

export type TimelineItem =
	/** Something the person sent. `reaction` is pclaw's current reaction on it (its status badge), if any. */
	| { kind: "message"; id: string; at: number; text: string; images: number; reaction?: string }
	/** Something that arrived from inside pclaw rather than from the person. */
	/**
	 * `notes`: the background memory pass changed the notes; `text` is one change per line, "+ " added or "- " removed.
	 * `reaction`: the person reacted `emoji` to one of pclaw's messages; `text` is that message (clipped).
	 */
	| {
			kind: "event";
			id: string;
			at: number;
			event: "follow-up" | "worker-report" | "notes" | "reaction";
			text: string;
			worker?: string;
			ok?: boolean;
			emoji?: string;
	  }
	/** Text the front model wrote. `delivered` is whether it reached the person. */
	| {
			kind: "reply";
			id: string;
			at: number;
			text: string;
			delivered: boolean;
			/** Why it wasn't delivered: a later reply in the same run replaced it, the model chose NO_REPLY, or it was empty. */
			held?: "superseded" | "silent";
			error?: string;
			model: string;
			usage: { input: number; output: number; cacheRead: number };
	  }
	/** A tool call by the front model and its result. `worker` is set for delegate / message_worker / stop_worker. */
	| {
			kind: "tool";
			id: string;
			at: number;
			name: string;
			args: unknown;
			/** Undefined while the call is still running. */
			result?: string;
			isError?: boolean;
			worker?: string;
	  };

export type WorkerStatus = "working" | "idle" | "stopped" | "failed";

export type WorkerSummary = {
	name: string;
	status: WorkerStatus;
	/** The brief pclaw wrote when it started the job. */
	brief: string;
	/** When the current or most recent run started. */
	startedAt?: number;
	updatedAt: number;
};

export type WorkerDetail = WorkerSummary & {
	model: ModelInfo;
	/** Every turn of the worker's pi session, oldest first. Grows while it works. */
	transcript: WorkerItem[];
};

export type WorkerItem =
	/** A message to the worker from pclaw (a brief, a follow-up, a go-ahead). */
	| { kind: "from-pclaw"; at: number; text: string }
	/** Text the worker wrote. The last one in a run is its report. */
	| { kind: "text"; at: number; text: string }
	| { kind: "thinking"; at: number; text: string }
	| { kind: "tool"; at: number; name: string; args: unknown; result?: string; isError?: boolean };

export type FollowUp = { id: string; at: number; note: string; repeat?: "daily" | "weekly" };

export type Usage = { input: number; output: number; cacheRead: number; cost: number };

export type Settings = {
	front: ModelInfo;
	worker: ModelInfo;
	/** Models that can be picked, with the reasoning levels each supports ("off" first, strongest last). */
	models: ModelOption[];
	prompts: { front: PromptFile; worker: PromptFile };
};

export type ModelOption = { provider: string; id: string; name: string; thinkingLevels: string[] };

export type PromptFile = {
	text: string;
	/** Where it lives, relative to the repo: src/prompts/front.md. Edits here are edits to that file. */
	path: string;
	/** One line on what it's for, to show next to the editor. */
	description: string;
};

export type ModelsUpdate = { front?: ModelInfo; worker?: ModelInfo };

export type Change =
	| { scope: "overview" }
	| { scope: "settings" }
	| { scope: "conversation"; id: string }
	| { scope: "worker"; conversationId: string; name: string };
