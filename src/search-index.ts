import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	type EntryId,
	type EntryRecord,
	type Harness,
	UserEntry,
} from "@earendil-works/pi-durable";
import { STRIP_GUIDANCE } from "./decisions.ts";
import { redactCoordinates, STRIP_LOCATION } from "./location.ts";
import { Routes } from "./routes.ts";
import type { UserRegistry } from "./users.ts";

export const STRIP_CROSS_CLIENT = /<cross-client>[\s\S]*?<\/cross-client>\s*/g;

const WORKER_REPORT_RE = /^<worker-report\s+worker="([^"]+)"\s+status="([^"]+)">\s*([\s\S]*?)\s*<\/worker-report>/;
const INTERNAL_SKIP_RE = /^<(follow-up|job-update)[\s>]/;
const JOB_RESULT_RE = /^<job-result\b([^>]*)>\s*([\s\S]*?)\s*<\/job-result>/;

const STOP_WORDS = new Set(
	"a an the and or but for nor so yet at by from in into of on onto to up with as is are was were be been being have has had do does did will would shall should can could may might must this that these those it its i me my we our you your he him his she her they them their what when where which who whom how not no yes just like about than then there here also very too".split(
		" ",
	),
);

export type SearchDocKind = "episode" | "message" | "worker_report";

export type EpisodeRecord = {
	id: number;
	userId: string;
	conversationId: string;
	channel: string;
	startedAt: number;
	endedAt: number;
	firstEntryId: number;
	lastEntryId: number;
	title: string;
	summary: string;
	createdAt: number;
};

export type NewEpisode = {
	userId: string;
	conversationId: string;
	channel: string;
	startedAt: number;
	endedAt: number;
	firstEntryId: number;
	lastEntryId: number;
	title: string;
	summary: string;
	createdAt?: number;
};

export type SearchHit = {
	id: number;
	kind: SearchDocKind;
	userId: string;
	conversationId: string;
	channel: string;
	who: string;
	timestamp: number;
	title: string;
	snippet: string;
	entryId?: number;
	episodeId?: number;
	rank: number;
};

export type IndexStats = {
	episodes: number;
	messages: number;
	workerReports: number;
	totalDocs: number;
	byUser: Record<string, number>;
};

/**
 * Canonical isolation scope for episodes and FTS5 recall rows.
 * - Multi-user mode: canonical `"user:<userId>"` for private DMs; `"conv:<conversationId>"` for groups/unmapped.
 * - Single-owner mode: `"conv:<conversationId>"` for Telegram groups; `"owner"` for all owner channels/DMs.
 */
export function scopeForAddress(
	address: string | undefined,
	conversationId: string | ConversationId,
	users?: UserRegistry,
): string {
	if (users?.enabled) {
		const user = users.resolveAddress(address);
		return user === undefined ? `conv:${conversationId}` : `user:${user.id}`;
	}
	if (address?.startsWith("telegram:group:")) return `conv:${conversationId}`;
	return "owner";
}

function messageText(message: Message): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Extract an indexable search document from a transcript entry, or undefined if non-indexable. */
export function extractSearchDoc(entry: EntryRecord): {
	kind: "message" | "worker_report";
	who: string;
	title: string;
	body: string;
	timestamp: number;
} | undefined {
	const message = entry.model?.[0];
	if (message === undefined || message.role === "system" || message.role === "toolResult") return undefined;
	const raw = redactCoordinates(
		messageText(message)
			.replace(STRIP_GUIDANCE, "")
			.replace(STRIP_CROSS_CLIENT, "")
			.replace(STRIP_LOCATION, "")
			.replace(/^\[[^\]\n]*\]\n?/, ""),
	).trim();
	if (raw === "" || raw.startsWith("NO_REPLY")) return undefined;

	if (UserEntry.is(entry) && message.role === "user") {
		const workerMatch = WORKER_REPORT_RE.exec(raw);
		if (workerMatch !== null) {
			const name = workerMatch[1]!.trim();
			const body = workerMatch[3]!.trim();
			if (body === "") return undefined;
			return {
				kind: "worker_report",
				who: `worker:${name}`,
				title: name,
				body,
				timestamp: message.timestamp,
			};
		}
		const jobMatch = JOB_RESULT_RE.exec(raw);
		if (jobMatch !== null) {
			const body = jobMatch[2]!.trim();
			if (body === "") return undefined;
			return {
				kind: "worker_report",
				who: "job",
				title: "job-result",
				body,
				timestamp: message.timestamp,
			};
		}
		if (INTERNAL_SKIP_RE.test(raw)) return undefined;
		return {
			kind: "message",
			who: "them",
			title: "",
			body: raw,
			timestamp: message.timestamp,
		};
	}

	if (AssistantEntry.is(entry) && message.role === "assistant") {
		if ((message as AssistantMessage).stopReason === "error") return undefined;
		return {
			kind: "message",
			who: "pclaw",
			title: "",
			body: raw,
			timestamp: message.timestamp,
		};
	}

	return undefined;
}

/** Tokenize a free-text query into safe quoted FTS5 match strings (AND primary + OR fallback). */
export function buildFtsQuery(raw: string): { andQuery: string; orQuery?: string; terms: string[] } | undefined {
	const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length >= 2);
	const unique = [...new Set(tokens)];
	if (unique.length === 0) return undefined;
	const filtered = unique.filter((token) => !STOP_WORDS.has(token));
	const terms = filtered.length > 0 ? filtered : unique;
	const quoted = terms.map((term) => `"${term.replace(/"/g, '""')}"`);
	return {
		andQuery: quoted.join(" "),
		...(quoted.length > 1 ? { orQuery: quoted.join(" OR ") } : {}),
		terms,
	};
}

/** Parse a relative duration ("7d", "24h", "2w", "30m", "3mo") or ISO date string into epoch ms. */
export function parseSince(since: string | undefined, nowMs = Date.now()): number | undefined {
	if (since === undefined) return undefined;
	const trimmed = since.trim();
	if (trimmed === "") return undefined;
	const rel = /^(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days|w|wk|wks|mo|month|months|y|yr|yrs)$/i.exec(trimmed);
	if (rel !== null) {
		const count = Number(rel[1]);
		const unit = rel[2]!.toLowerCase();
		const minute = 60_000;
		const hour = 60 * minute;
		const day = 24 * hour;
		if (unit.startsWith("mo")) return nowMs - count * 30 * day;
		if (unit.startsWith("m")) return nowMs - count * minute;
		if (unit.startsWith("h")) return nowMs - count * hour;
		if (unit.startsWith("d")) return nowMs - count * day;
		if (unit.startsWith("w")) return nowMs - count * 7 * day;
		if (unit.startsWith("y")) return nowMs - count * 365 * day;
	}
	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? undefined : parsed;
}

const SNIPPET_CHARS = 550;

function makeSnippet(text: string, terms: readonly string[]): string {
	if (text.length <= SNIPPET_CHARS) return text;
	const lower = text.toLowerCase();
	const positions = terms.map((term) => lower.indexOf(term)).filter((idx) => idx >= 0);
	const first = positions.length === 0 ? 0 : Math.min(...positions);
	const start = Math.max(0, first - Math.floor(SNIPPET_CHARS / 3));
	const slice = text.slice(start, start + SNIPPET_CHARS).trim();
	return `${start > 0 ? "…" : ""}${slice}${start + SNIPPET_CHARS < text.length ? "…" : ""}`;
}

function tightenPermissions(file: string): void {
	if (file === ":memory:") return;
	for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
		if (existsSync(candidate)) {
			try {
				chmodSync(candidate, 0o600);
			} catch {
				// Best-effort permission tightening.
			}
		}
	}
}

type EpisodeRow = {
	id: number;
	user_id: string;
	conversation_id: string;
	channel: string;
	started_at: number;
	ended_at: number;
	first_entry_id: number;
	last_entry_id: number;
	title: string;
	summary: string;
	created_at: number;
};

type SearchHitRow = {
	id: number;
	kind: SearchDocKind;
	user_id: string;
	conversation_id: string;
	channel: string;
	who: string;
	timestamp: number;
	title: string;
	body: string;
	entry_id: number | null;
	episode_id: number | null;
	rank: number;
};

function rowToEpisode(row: EpisodeRow): EpisodeRecord {
	return {
		id: row.id,
		userId: row.user_id,
		conversationId: row.conversation_id,
		channel: row.channel,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		firstEntryId: row.first_entry_id,
		lastEntryId: row.last_entry_id,
		title: row.title,
		summary: row.summary,
		createdAt: row.created_at,
	};
}

/**
 * Unified SQLite index (`pclaw-index.sqlite`) holding:
 *   1. Distilled session episodes (`episodes`)
 *   2. FTS5 full-text search index (`search_docs` + `search_fts` with `porter unicode61`) across episodes,
 *      raw messages, and worker reports, strictly partitioned by `user_id`.
 *   3. Per-conversation incremental watermarks (`index_watermarks`).
 */
export class SearchIndex {
	readonly path: string;
	readonly #db: DatabaseSync;
	#closed = false;

	constructor(dbPath: string) {
		this.path = dbPath;
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
		}
		this.#db = new DatabaseSync(dbPath);
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA temp_store = MEMORY;

			CREATE TABLE IF NOT EXISTS episodes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id TEXT NOT NULL,
				conversation_id TEXT NOT NULL,
				channel TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER NOT NULL,
				first_entry_id INTEGER NOT NULL,
				last_entry_id INTEGER NOT NULL,
				title TEXT NOT NULL,
				summary TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_episodes_user_ended ON episodes (user_id, ended_at DESC);
			CREATE INDEX IF NOT EXISTS idx_episodes_conv_ended ON episodes (conversation_id, ended_at DESC);

			CREATE TABLE IF NOT EXISTS search_docs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				doc_key TEXT NOT NULL UNIQUE,
				user_id TEXT NOT NULL,
				conversation_id TEXT NOT NULL,
				channel TEXT NOT NULL,
				kind TEXT NOT NULL,
				entry_id INTEGER,
				episode_id INTEGER,
				who TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				title TEXT NOT NULL DEFAULT '',
				body TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_search_docs_user_time ON search_docs (user_id, timestamp DESC);
			CREATE INDEX IF NOT EXISTS idx_search_docs_conv_entry ON search_docs (conversation_id, entry_id);

			CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
				title,
				body,
				content='search_docs',
				content_rowid='id',
				tokenize='porter unicode61'
			);

			CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
				INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
			END;
			CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
				INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
			END;
			CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
				INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
				INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
			END;

			CREATE TABLE IF NOT EXISTS index_watermarks (
				conversation_id TEXT PRIMARY KEY,
				last_indexed_entry_id INTEGER NOT NULL,
				user_id TEXT NOT NULL,
				channel TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
		tightenPermissions(dbPath);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}

	/** Atomically persist an episode and index it in FTS5. */
	saveEpisode(input: NewEpisode): EpisodeRecord {
		const createdAt = input.createdAt ?? Date.now();
		this.#db.exec("BEGIN");
		try {
			const insertEpisode = this.#db.prepare(`
				INSERT INTO episodes (
					user_id, conversation_id, channel, started_at, ended_at,
					first_entry_id, last_entry_id, title, summary, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
			const result = insertEpisode.run(
				input.userId,
				input.conversationId,
				input.channel,
				input.startedAt,
				input.endedAt,
				input.firstEntryId,
				input.lastEntryId,
				input.title,
				input.summary,
				createdAt,
			);
			const id = Number(result.lastInsertRowid);
			const insertDoc = this.#db.prepare(`
				INSERT OR REPLACE INTO search_docs (
					doc_key, user_id, conversation_id, channel, kind,
					entry_id, episode_id, who, timestamp, title, body
				) VALUES (?, ?, ?, ?, 'episode', NULL, ?, 'episode', ?, ?, ?)
			`);
			insertDoc.run(
				`ep:${id}`,
				input.userId,
				input.conversationId,
				input.channel,
				id,
				input.endedAt,
				input.title,
				input.summary,
			);
			this.#db.exec("COMMIT");
			tightenPermissions(this.path);
			return {
				id,
				userId: input.userId,
				conversationId: input.conversationId,
				channel: input.channel,
				startedAt: input.startedAt,
				endedAt: input.endedAt,
				firstEntryId: input.firstEntryId,
				lastEntryId: input.lastEntryId,
				title: input.title,
				summary: input.summary,
				createdAt,
			};
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Return the most recent episodes for `userId` (strictly scoped), newest first. */
	recentEpisodes(userId: string, options: { limit?: number; sinceMs?: number } = {}): EpisodeRecord[] {
		const limit = Math.max(1, options.limit ?? 6);
		if (options.sinceMs !== undefined) {
			const rows = this.#db
				.prepare(
					`SELECT * FROM episodes WHERE user_id = ? AND ended_at >= ? ORDER BY ended_at DESC, id DESC LIMIT ?`,
				)
				.all(userId, options.sinceMs, limit) as unknown as EpisodeRow[];
			return rows.map(rowToEpisode);
		}
		const rows = this.#db
			.prepare(`SELECT * FROM episodes WHERE user_id = ? ORDER BY ended_at DESC, id DESC LIMIT ?`)
			.all(userId, limit) as unknown as EpisodeRow[];
		return rows.map(rowToEpisode);
	}

	/** Incrementally sync new transcript entries for one conversation into `search_docs` / `search_fts`. */
	async syncConversation(
		harness: Harness,
		conversationId: ConversationId,
		address: string,
		context: Context,
		users?: UserRegistry,
	): Promise<{ indexed: number; watermark: number }> {
		const convKey = String(conversationId);
		const userId = scopeForAddress(address, conversationId, users);
		const channel = address.split(":")[0] ?? "unknown";
		const existing = this.#db
			.prepare(`SELECT last_indexed_entry_id, user_id FROM index_watermarks WHERE conversation_id = ?`)
			.get(convKey) as { last_indexed_entry_id: number; user_id: string } | undefined;

		// If user ownership scope changed (e.g. migrating into multi-user config), keep existing rows aligned.
		if (existing !== undefined && existing.user_id !== userId) {
			this.#db.exec("BEGIN");
			try {
				this.#db.prepare(`UPDATE search_docs SET user_id = ? WHERE conversation_id = ?`).run(userId, convKey);
				this.#db.prepare(`UPDATE episodes SET user_id = ? WHERE conversation_id = ?`).run(userId, convKey);
				this.#db.prepare(`UPDATE index_watermarks SET user_id = ?, updated_at = ? WHERE conversation_id = ?`).run(userId, Date.now(), convKey);
				this.#db.exec("COMMIT");
			} catch (error) {
				this.#db.exec("ROLLBACK");
				throw error;
			}
		}

		const conversation = await harness.conversation(conversationId, context);
		if (conversation === undefined) {
			return { indexed: 0, watermark: existing?.last_indexed_entry_id ?? 0 };
		}

		let watermark = existing?.last_indexed_entry_id ?? 0;
		let indexed = 0;
		const insertDoc = this.#db.prepare(`
			INSERT OR IGNORE INTO search_docs (
				doc_key, user_id, conversation_id, channel, kind,
				entry_id, episode_id, who, timestamp, title, body
			) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
		`);
		const upsertWatermark = this.#db.prepare(`
			INSERT INTO index_watermarks (conversation_id, last_indexed_entry_id, user_id, channel, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(conversation_id) DO UPDATE SET
				last_indexed_entry_id = excluded.last_indexed_entry_id,
				user_id = excluded.user_id,
				channel = excluded.channel,
				updated_at = excluded.updated_at
		`);

		let cursor: Cursor | undefined;
		const sharedScope = !userId.startsWith("conv:");
		do {
			const query =
				watermark > 0
					? { minEntryId: (watermark + 1) as EntryId, order: "ascending" as const }
					: { order: "ascending" as const };
			const page = await conversation.entries(query, 200, cursor, context);
			if (page.items.length > 0) {
				this.#db.exec("BEGIN");
				try {
					for (const entry of page.items) {
						const entryNum = Number(entry.id);
						if (entryNum > watermark) watermark = entryNum;
						// For shared scopes (same user across forks), skip inherited parent entries so they aren't indexed twice.
						if (sharedScope && entry.conversationId !== conversationId) continue;
						const extracted = extractSearchDoc(entry);
						if (extracted === undefined) continue;
						const res = insertDoc.run(
							`entry:${convKey}:${entryNum}`,
							userId,
							convKey,
							channel,
							extracted.kind,
							entryNum,
							extracted.who,
							extracted.timestamp,
							extracted.title,
							extracted.body,
						);
						if (Number(res.changes) > 0) indexed++;
					}
					upsertWatermark.run(convKey, watermark, userId, channel, Date.now());
					this.#db.exec("COMMIT");
				} catch (error) {
					this.#db.exec("ROLLBACK");
					throw error;
				}
			}
			cursor = page.next;
		} while (cursor !== undefined);

		if (indexed > 0) tightenPermissions(this.path);
		return { indexed, watermark };
	}

	/** Sync every routed conversation in the harness into the FTS5 index. */
	async backfillAll(
		harness: Harness,
		context: Context,
		users?: UserRegistry,
	): Promise<{ conversations: number; indexed: number }> {
		const routes = (await harness.snapshot(Routes, context))?.conversations ?? {};
		let conversations = 0;
		let indexed = 0;
		for (const [address, id] of Object.entries(routes)) {
			conversations++;
			const res = await this.syncConversation(harness, id, address, context, users);
			indexed += res.indexed;
		}
		return { conversations, indexed };
	}

	/** Full-text BM25 search strictly scoped to `userId`, boosting episodes over raw messages. */
	search(params: {
		userId: string;
		query: string;
		kind?: "all" | "episodes" | "messages";
		sinceMs?: number;
		limit?: number;
		excludeConversationId?: string;
		excludeEntryIds?: ReadonlySet<number>;
	}): SearchHit[] {
		const parsed = buildFtsQuery(params.query);
		if (parsed === undefined) return [];
		const limit = Math.max(1, Math.min(20, params.limit ?? 8));
		const fetchLimit = limit * 4;

		const kindClause =
			params.kind === "episodes"
				? "AND d.kind = 'episode'"
				: params.kind === "messages"
					? "AND d.kind IN ('message', 'worker_report')"
					: "";
		const sinceClause = params.sinceMs !== undefined ? "AND d.timestamp >= ?" : "";

		const sql = `
			SELECT
				d.id, d.kind, d.user_id, d.conversation_id, d.channel,
				d.who, d.timestamp, d.title, d.body, d.entry_id, d.episode_id,
				(bm25(search_fts, 2.0, 1.0) * CASE WHEN d.kind = 'episode' THEN 1.35 ELSE 1.0 END) AS rank
			FROM search_fts
			JOIN search_docs d ON d.id = search_fts.rowid
			WHERE search_fts MATCH ?
				AND d.user_id = ?
				${kindClause}
				${sinceClause}
			ORDER BY rank ASC, d.timestamp DESC
			LIMIT ?
		`;

		const runQuery = (matchExpr: string): SearchHitRow[] => {
			try {
				const stmt = this.#db.prepare(sql);
				const args: (string | number)[] = [matchExpr, params.userId];
				if (params.sinceMs !== undefined) args.push(params.sinceMs);
				args.push(fetchLimit);
				return stmt.all(...args) as unknown as SearchHitRow[];
			} catch {
				return [];
			}
		};

		const filterRow = (row: SearchHitRow): boolean => {
			if (
				params.excludeConversationId !== undefined &&
				params.excludeEntryIds !== undefined &&
				row.conversation_id === params.excludeConversationId &&
				row.entry_id !== null &&
				params.excludeEntryIds.has(row.entry_id)
			) {
				return false;
			}
			return true;
		};

		const seen = new Set<number>();
		const results: SearchHit[] = [];
		const collect = (rows: SearchHitRow[]) => {
			for (const row of rows) {
				if (seen.has(row.id) || !filterRow(row)) continue;
				seen.add(row.id);
				results.push({
					id: row.id,
					kind: row.kind,
					userId: row.user_id,
					conversationId: row.conversation_id,
					channel: row.channel,
					who: row.who,
					timestamp: row.timestamp,
					title: row.title,
					snippet: row.kind === "episode" ? row.body : makeSnippet(row.body, parsed.terms),
					...(row.entry_id === null ? {} : { entryId: row.entry_id }),
					...(row.episode_id === null ? {} : { episodeId: row.episode_id }),
					rank: row.rank,
				});
				if (results.length >= limit) break;
			}
		};

		collect(runQuery(parsed.andQuery));
		if (results.length === 0 && parsed.orQuery !== undefined) {
			collect(runQuery(parsed.orQuery));
		}
		return results;
	}

	/** Summary counts of indexed rows for diagnostics and startup logs. */
	stats(): IndexStats {
		const counts = this.#db
			.prepare(`SELECT kind, COUNT(*) AS n FROM search_docs GROUP BY kind`)
			.all() as { kind: string; n: number }[];
		const byKind = new Map(counts.map((row) => [row.kind, Number(row.n)]));
		const userRows = this.#db
			.prepare(`SELECT user_id, COUNT(*) AS n FROM search_docs GROUP BY user_id`)
			.all() as { user_id: string; n: number }[];
		const byUser: Record<string, number> = {};
		for (const row of userRows) byUser[row.user_id] = Number(row.n);
		const episodes = byKind.get("episode") ?? 0;
		const messages = byKind.get("message") ?? 0;
		const workerReports = byKind.get("worker_report") ?? 0;
		return {
			episodes,
			messages,
			workerReports,
			totalDocs: episodes + messages + workerReports,
			byUser,
		};
	}
}
