import { extname } from "node:path";
import { type HostCircuitBreaker, hostOf } from "./circuit-breaker.ts";
import type { Config } from "./config.ts";

/** Speech to text: primary local server (`POST /v1/transcribe`, deploy/speech-server.py) with optional cloud fallback. */

export type SpeechBackend = "primary" | "fallback";

export type Heard = { text: string; seconds: number; ms: number; backend?: SpeechBackend };

export type SpeechFallback = {
	url: string;
	model?: string;
	apiKey?: string;
};

export type TranscribeOptions = {
	filename?: string;
	/** Optional known clip duration in seconds (used when cloud STT response omits duration). */
	durationSeconds?: number;
	primaryTimeoutMs?: number;
	fallbackTimeoutMs?: number;
	fallback?: SpeechFallback;
	breaker?: HostCircuitBreaker;
	onBackend?: (info: { backend: SpeechBackend; fallbackReason?: string }) => void;
	fetchFn?: typeof fetch;
};

export const DEFAULT_SPEECH_FALLBACK_MODEL = "gpt-transcribe";

/** Long memos take seconds, not minutes, so this covers a stuck local server when no cloud fallback exists. */
const PRIMARY_TIMEOUT_NO_FALLBACK_MS = 120_000;
/** Tighter timeout when cloud fallback is configured so a home ISP outage fails over quickly. */
const PRIMARY_TIMEOUT_WITH_FALLBACK_MS = 15_000;
const FALLBACK_TIMEOUT_MS = 60_000;

/** Build `SpeechFallback` from config when `speechFallbackUrl` is set. */
export function speechFallbackFromConfig(
	config: Pick<Config, "speechFallbackUrl" | "speechFallbackModel" | "speechFallbackApiKey">,
): SpeechFallback | undefined {
	const url = config.speechFallbackUrl?.trim();
	if (url === undefined || url === "") return undefined;
	const model = config.speechFallbackModel?.trim();
	const apiKey = config.speechFallbackApiKey?.trim();
	return {
		url,
		model: model !== undefined && model !== "" ? model : DEFAULT_SPEECH_FALLBACK_MODEL,
		...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
	};
}

/** Normalize audio filenames for cloud STT (`gpt-transcribe` rejects `.oga` with 400 but accepts the same Ogg/Opus bytes as `.ogg`). */
export function normalizeAudioFilename(filename: string | undefined): string {
	const trimmed = filename?.trim();
	if (trimmed === undefined || trimmed === "") return "audio.ogg";
	return trimmed.replace(/\.oga$/i, ".ogg");
}

function mimeForAudioFilename(filename: string): string {
	switch (extname(filename).toLowerCase()) {
		case ".ogg":
		case ".oga":
			return "audio/ogg";
		case ".mp3":
			return "audio/mpeg";
		case ".m4a":
		case ".mp4":
			return "audio/mp4";
		case ".wav":
			return "audio/wav";
		case ".webm":
			return "audio/webm";
		case ".flac":
			return "audio/flac";
		default:
			return "application/octet-stream";
	}
}

async function transcribeFallback(
	fallback: SpeechFallback,
	audio: Uint8Array<ArrayBuffer>,
	options: {
		filename: string;
		durationSeconds?: number;
		timeoutMs: number;
		fetchFn: typeof fetch;
	},
): Promise<Heard> {
	const started = performance.now();
	const filename = normalizeAudioFilename(options.filename);
	const model = fallback.model ?? DEFAULT_SPEECH_FALLBACK_MODEL;
	const form = new FormData();
	form.append("file", new Blob([audio], { type: mimeForAudioFilename(filename) }), filename);
	form.append("model", model);
	if (model === "whisper-1" || model === "openai/whisper-1") {
		form.append("response_format", "verbose_json");
	}
	const headers: Record<string, string> = {};
	if (fallback.apiKey !== undefined && fallback.apiKey !== "") {
		headers.Authorization = `Bearer ${fallback.apiKey}`;
	}
	const response = await options.fetchFn(fallback.url, {
		method: "POST",
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		body: form,
		signal: AbortSignal.timeout(options.timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`speech fallback returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
	}
	const payload = (await response.json()) as {
		text?: unknown;
		duration?: unknown;
		seconds?: unknown;
		usage?: { seconds?: unknown };
	};
	if (typeof payload.text !== "string") {
		throw new Error("speech fallback returned no text");
	}
	const ms = Math.round(performance.now() - started);
	const seconds =
		typeof payload.duration === "number" && Number.isFinite(payload.duration)
			? payload.duration
			: typeof payload.seconds === "number" && Number.isFinite(payload.seconds)
				? payload.seconds
				: typeof payload.usage?.seconds === "number" && Number.isFinite(payload.usage.seconds)
					? payload.usage.seconds
					: (options.durationSeconds ?? 0);
	return { text: payload.text.trim(), seconds, ms, backend: "fallback" };
}

export async function transcribe(
	url: string | undefined,
	audio: Uint8Array<ArrayBuffer>,
	optionsOrFetch?: TranscribeOptions | typeof fetch,
): Promise<Heard> {
	const options: TranscribeOptions = typeof optionsOrFetch === "function" ? { fetchFn: optionsOrFetch } : (optionsOrFetch ?? {});
	const fetchFn = options.fetchFn ?? fetch;
	const fallback = options.fallback;
	const breaker = options.breaker;
	const primaryUrl = url?.trim();
	const filename = options.filename ?? "audio.ogg";
	const primaryTimeoutMs =
		options.primaryTimeoutMs ?? (fallback !== undefined ? PRIMARY_TIMEOUT_WITH_FALLBACK_MS : PRIMARY_TIMEOUT_NO_FALLBACK_MS);
	const fallbackTimeoutMs = options.fallbackTimeoutMs ?? FALLBACK_TIMEOUT_MS;

	const runFallback = async (fallbackReason: string): Promise<Heard> => {
		const heard = await transcribeFallback(fallback!, audio, {
			filename,
			...(options.durationSeconds === undefined ? {} : { durationSeconds: options.durationSeconds }),
			timeoutMs: fallbackTimeoutMs,
			fetchFn,
		});
		options.onBackend?.({ backend: "fallback", fallbackReason });
		return heard;
	};

	if (primaryUrl === undefined || primaryUrl === "") {
		if (fallback !== undefined) return runFallback("no primary speechUrl");
		throw new Error("No speech server configured");
	}

	if (fallback !== undefined && breaker?.isOpen(primaryUrl) === true) {
		return runFallback("circuit-breaker open");
	}

	try {
		const response = await fetchFn(`${primaryUrl.replace(/\/$/, "")}/v1/transcribe`, {
			method: "POST",
			body: audio,
			signal: AbortSignal.timeout(primaryTimeoutMs),
		});
		if (!response.ok) {
			throw new Error(`speech server returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
		}
		const heard = (await response.json()) as Heard;
		if (breaker?.recordSuccess(primaryUrl)) {
			console.log(`[pclaw] primary host ${hostOf(primaryUrl)} recovered`);
		}
		options.onBackend?.({ backend: "primary" });
		return { ...heard, backend: "primary" };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (breaker?.recordFailure(primaryUrl, reason)) {
			console.warn(
				`[pclaw] primary host ${hostOf(primaryUrl)} unreachable; using cloud fallback for ${Math.round(breaker.cooldownMs / 1000)}s`,
			);
		}
		if (fallback !== undefined) {
			console.warn(`[pclaw] primary speech failed (${reason}); falling back to cloud STT`);
			return runFallback(reason);
		}
		throw error;
	}
}

/** "[voice memo, 1m 23s ...]": what the front model sees in front of a transcript. */
export function memoLabel(seconds: number): string {
	const whole = Math.round(seconds);
	const length = whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
	return `[voice memo, ${length}, transcribed by a local speech model, so some words may be wrong]`;
}
