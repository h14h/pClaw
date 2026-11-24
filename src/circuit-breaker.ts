/**
 * Shared per-host circuit breaker for primary LAN/tailnet services (e.g. d1 on :8085 and Parakeet STT on :8086,
 * both running on mm1). When one service fails because the host or home ISP is unreachable, all callers targeting
 * that same host skip straight to their cloud fallback for the cooldown window instead of stalling every request.
 */

export const DEFAULT_COOLDOWN_MS = 60_000;

/** Key by hostname (ignoring port) so multiple services on the same host share one breaker. */
export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return url.trim().toLowerCase();
	}
}

export class HostCircuitBreaker {
	readonly cooldownMs: number;
	private readonly now: () => number;
	private readonly hosts = new Map<string, { openUntil: number; reason?: string }>();

	constructor(options?: { cooldownMs?: number; now?: () => number }) {
		this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.now = options?.now ?? Date.now;
	}

	/** True while the host is within its cooldown window. */
	isOpen(url: string): boolean {
		const key = hostOf(url);
		if (key === "") return false;
		const entry = this.hosts.get(key);
		if (entry === undefined) return false;
		return this.now() < entry.openUntil;
	}

	/**
	 * Record a primary failure for `url`'s host and open the circuit for `cooldownMs`.
	 * Returns `true` on a closed→open transition (or re-opening after cooldown expired) so callers log once without spam.
	 */
	recordFailure(url: string, reason?: string): boolean {
		const key = hostOf(url);
		if (key === "") return false;
		const now = this.now();
		const existing = this.hosts.get(key);
		const wasOpen = existing !== undefined && now < existing.openUntil;
		this.hosts.set(key, {
			openUntil: now + this.cooldownMs,
			...(reason === undefined ? {} : { reason }),
		});
		return !wasOpen;
	}

	/**
	 * Clear tripped state for `url`'s host after a primary success.
	 * Returns `true` on recovery (open/tripped→closed) so callers log recovery once.
	 */
	recordSuccess(url: string): boolean {
		const key = hostOf(url);
		if (key === "") return false;
		return this.hosts.delete(key);
	}
}
