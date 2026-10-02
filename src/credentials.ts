import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

type AuthFile = Record<string, Credential>;

const STALE_MS = 30_000;

/**
 * Credentials in pi's auth.json. By default this is pi's own file, so one sign-in covers pclaw and the pi workers it
 * starts. Writes take the same lock pi takes (proper-lockfile on the file path), so a token refresh here and one in a
 * running pi process can't trample each other.
 */
export class FileCredentialStore implements CredentialStore {
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	private load(): AuthFile {
		if (!existsSync(this.file)) return {};
		const raw = readFileSync(this.file, "utf8").trim();
		return raw === "" ? {} : (JSON.parse(raw) as AuthFile);
	}

	private async locked<T>(work: (data: AuthFile) => Promise<{ result: T; next?: AuthFile }>): Promise<T> {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		if (!existsSync(this.file)) writeFileSync(this.file, "{}", { mode: 0o600 });
		const deadline = Date.now() + STALE_MS;
		let release: (() => Promise<void>) | undefined;
		for (let attempt = 0; release === undefined; attempt++) {
			try {
				release = await lockfile.lock(this.file, { realpath: false, retries: 0, stale: STALE_MS });
			} catch (error) {
				if ((error as { code?: string }).code !== "ELOCKED" || Date.now() > deadline) throw error;
				await sleep(Math.min(10 * 2 ** attempt, 1_000) * (1 + Math.random()));
			}
		}
		try {
			const { result, next } = await work(this.load());
			if (next !== undefined) writeFileSync(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
			return result;
		} finally {
			await release().catch(() => undefined);
		}
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.load()[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.locked(async (data) => {
			const next = await fn(data[providerId]);
			if (next === undefined) return { result: data[providerId] };
			return { result: next, next: { ...data, [providerId]: next } };
		});
	}

	delete(providerId: string): Promise<void> {
		return this.locked(async (data) => {
			const { [providerId]: _removed, ...rest } = data;
			return { result: undefined, next: rest };
		});
	}
}
