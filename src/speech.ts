/** Speech to text: a server that takes raw audio at `POST /v1/transcribe` (deploy/speech-server.py). */

export type Heard = { text: string; seconds: number; ms: number };

/** Long memos take seconds, not minutes, so this mostly covers a server that's stuck. */
const TIMEOUT_MS = 120_000;

export async function transcribe(url: string, audio: Uint8Array<ArrayBuffer>, fetchFn: typeof fetch = fetch): Promise<Heard> {
	const response = await fetchFn(`${url.replace(/\/$/, "")}/v1/transcribe`, { method: "POST", body: audio, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!response.ok) throw new Error(`speech server returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
	return (await response.json()) as Heard;
}

/** "[voice memo, 1m 23s ...]": what the front model sees in front of a transcript. */
export function memoLabel(seconds: number): string {
	const whole = Math.round(seconds);
	const length = whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
	return `[voice memo, ${length}, transcribed by a local speech model, so some words may be wrong]`;
}
