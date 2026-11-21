import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { home as defaultHome, type UserConfig } from "./config.ts";
import { Notes } from "./extensions/notes.ts";

export type ExternalChannel = "telegram" | "discord";

export interface ResolvedUser extends UserConfig {
	id: string;
}

export type UserPaths = {
	dir: string;
	notes: string;
	notesArchive: string;
	notesCleanup: string;
	work: string;
	workerSessions: string;
	inbox: string;
	voice: string;
};

const SAFE_USER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isGroupAddress(address: string): boolean {
	const [channel, kind] = address.split(":");
	if (channel === "telegram") return kind === "group";
	if (channel === "discord") return kind === "channel" || kind === "thread";
	return false;
}

/** Parse a DM conversation address into its channel and external user id. */
export function parseDmAddress(address: string): { channel: ExternalChannel; externalId: string } | undefined {
	const parts = address.split(":");
	if (parts.length !== 3) return undefined;
	const [channel, kind, externalId] = parts;
	if ((channel === "telegram" || channel === "discord") && kind === "dm" && externalId !== undefined && externalId !== "") {
		return { channel, externalId };
	}
	return undefined;
}

/**
 * Canonical multi-user registry.
 * Maps `(channel, externalId)` and DM conversation addresses onto a canonical `userId`,
 * isolates per-user files under `<home>/users/<userId>/`, and treats shared group chats
 * as unowned so no individual user's private state leaks into them.
 */
export class UserRegistry {
	readonly enabled: boolean;
	readonly homeDir: string;
	readonly #byId = new Map<string, ResolvedUser>();
	readonly #byExternal = new Map<string, ResolvedUser>();
	readonly #notes = new Map<string, Notes>();

	constructor(users: Record<string, UserConfig> | undefined, homeDir = defaultHome) {
		this.homeDir = homeDir;
		const entries = Object.entries(users ?? {});
		this.enabled = entries.length > 0;
		for (const [id, cfg] of entries) {
			if (!SAFE_USER_ID.test(id)) {
				throw new Error(`Invalid user id "${id}": use alphanumeric characters, dots, dashes, or underscores.`);
			}
			const resolved: ResolvedUser = { ...cfg, id };
			this.#byId.set(id, resolved);
			if (cfg.telegram !== undefined && cfg.telegram.trim() !== "") {
				const key = `telegram:${cfg.telegram.trim()}`;
				if (this.#byExternal.has(key)) throw new Error(`Duplicate telegram id ${cfg.telegram} in users config.`);
				this.#byExternal.set(key, resolved);
			}
			if (cfg.discord !== undefined && cfg.discord.trim() !== "") {
				const key = `discord:${cfg.discord.trim()}`;
				if (this.#byExternal.has(key)) throw new Error(`Duplicate discord id ${cfg.discord} in users config.`);
				this.#byExternal.set(key, resolved);
			}
		}
	}

	all(): ResolvedUser[] {
		return [...this.#byId.values()];
	}

	byId(userId: string): ResolvedUser | undefined {
		return this.#byId.get(userId);
	}

	resolveExternal(channel: ExternalChannel, externalId: string): ResolvedUser | undefined {
		return this.#byExternal.get(`${channel}:${externalId}`);
	}

	allowedExternalIds(channel: ExternalChannel): string[] {
		const ids: string[] = [];
		for (const user of this.#byId.values()) {
			const id = user[channel]?.trim();
			if (id !== undefined && id !== "") ids.push(id);
		}
		return ids;
	}

	/**
	 * Resolve a conversation address to its canonical user.
	 * Returns `undefined` for group/channel chats or unmapped addresses.
	 */
	resolveAddress(address: string | undefined): ResolvedUser | undefined {
		if (!this.enabled || address === undefined) return undefined;
		const dm = parseDmAddress(address);
		if (dm === undefined) return undefined;
		return this.resolveExternal(dm.channel, dm.externalId);
	}

	pathsFor(userId: string): UserPaths {
		if (!SAFE_USER_ID.test(userId)) throw new Error(`Invalid user id "${userId}".`);
		const dir = join(this.homeDir, "users", userId);
		return {
			dir,
			notes: join(dir, "notes.md"),
			notesArchive: join(dir, "notes-archive.md"),
			notesCleanup: join(dir, "notes-cleanup.json"),
			work: join(dir, "work"),
			workerSessions: join(dir, "worker-sessions"),
			inbox: join(dir, "inbox"),
			voice: join(dir, "voice"),
		};
	}

	ensureUserDir(userId: string): UserPaths {
		const p = this.pathsFor(userId);
		mkdirSync(p.dir, { recursive: true, mode: 0o700 });
		return p;
	}

	notesFor(userId: string): Notes {
		let notes = this.#notes.get(userId);
		if (notes === undefined) {
			const p = this.pathsFor(userId);
			notes = new Notes(p.notes);
			this.#notes.set(userId, notes);
		}
		return notes;
	}
}
