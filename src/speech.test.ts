import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { buildTelegramUserInput, type TelegramMessage } from "./channels/telegram.ts";
import { HostCircuitBreaker, hostOf } from "./circuit-breaker.ts";
import { loadConfig } from "./config.ts";
import { decisionClient, type Questions } from "./decisions.ts";
import { normalizeAudioFilename, speechFallbackFromConfig, transcribe } from "./speech.ts";

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-speech-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

function fauxModels(replies: string[]) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(replies.map((text) => () => fauxAssistantMessage(text)));
	return models;
}

const sampleQuestions: Questions = {
	fresh_check: { type: "noul", instructions: "Needs a fresh check?" },
};

test("HostCircuitBreaker keys by hostname across ports, suppresses duplicate open transitions, and recovers after cooldown", () => {
	let now = 1_000;
	const breaker = new HostCircuitBreaker({ cooldownMs: 60_000, now: () => now });

	const decisionUrl = "https://mm1.tilapia-tawny.ts.net:8085";
	const speechUrl = "https://mm1.tilapia-tawny.ts.net:8086";
	const otherUrl = "https://other.example.com:8086";

	assert.equal(hostOf(decisionUrl), "mm1.tilapia-tawny.ts.net");
	assert.equal(hostOf(speechUrl), "mm1.tilapia-tawny.ts.net");
	assert.equal(breaker.isOpen(decisionUrl), false);
	assert.equal(breaker.isOpen(speechUrl), false);
	assert.equal(breaker.recordSuccess(decisionUrl), false, "already closed -> no recovery transition");

	// First failure opens the host for both ports and returns true once.
	assert.equal(breaker.recordFailure(decisionUrl, "connect ETIMEDOUT"), true);
	assert.equal(breaker.isOpen(decisionUrl), true);
	assert.equal(breaker.isOpen(speechUrl), true);
	assert.equal(breaker.isOpen(otherUrl), false);

	// Subsequent failure while still open returns false (no log spam).
	now += 5_000;
	assert.equal(breaker.recordFailure(speechUrl, "still down"), false);
	assert.equal(breaker.isOpen(decisionUrl), true);

	// Just before cooldown expiry: still open.
	now += 59_999;
	assert.equal(breaker.isOpen(speechUrl), true);

	// At cooldown expiry: probe allowed.
	now += 1;
	assert.equal(breaker.isOpen(speechUrl), false);
	assert.equal(breaker.isOpen(decisionUrl), false);

	// Probe succeeds: returns true once for recovery, then false on subsequent successes.
	assert.equal(breaker.recordSuccess(speechUrl), true);
	assert.equal(breaker.recordSuccess(decisionUrl), false);
	assert.equal(breaker.isOpen(decisionUrl), false);
});

test("transcribe: primary success reports backend=primary and clears a tripped breaker after cooldown", async () => {
	let now = 10_000;
	const breaker = new HostCircuitBreaker({ cooldownMs: 60_000, now: () => now });
	breaker.recordFailure("https://mm1.test:8085", "prior blip");
	now += 60_000; // cooldown elapsed

	const calls: string[] = [];
	const backends: Array<{ backend: string; fallbackReason?: string }> = [];
	const fetchFn = (async (url: string) => {
		calls.push(url);
		return new Response(JSON.stringify({ text: "hello from parakeet", seconds: 4.2, ms: 85 }), { status: 200 });
	}) as unknown as typeof fetch;

	const heard = await transcribe("https://mm1.test:8086", new Uint8Array([1, 2, 3]), {
		fetchFn,
		breaker,
		fallback: { url: "https://llm.int.exe.xyz/v1/audio/transcriptions", model: "gpt-transcribe" },
		onBackend: (info) => backends.push(info),
	});

	assert.equal(heard.text, "hello from parakeet");
	assert.equal(heard.seconds, 4.2);
	assert.equal(heard.ms, 85);
	assert.equal(heard.backend, "primary");
	assert.deepEqual(calls, ["https://mm1.test:8086/v1/transcribe"]);
	assert.deepEqual(backends, [{ backend: "primary" }]);
	// Recovery cleared tripped state; another recordSuccess returns false.
	assert.equal(breaker.recordSuccess("https://mm1.test:8085"), false);
});

test("transcribe: primary failure/timeout falls back to cloud STT with .oga->.ogg normalization, gpt-transcribe, whisper-1 verbose_json, and optional Bearer auth", async () => {
	assert.equal(normalizeAudioFilename("voice.oga"), "voice.ogg");
	assert.equal(normalizeAudioFilename("MEMO.OGA"), "MEMO.ogg");
	assert.equal(normalizeAudioFilename("clip.mp3"), "clip.mp3");
	assert.equal(normalizeAudioFilename(undefined), "audio.ogg");

	// 1) Primary 502 -> gpt-transcribe keyless fallback, .oga -> .ogg
	const captured1: Array<{ url: string; init?: RequestInit }> = [];
	const fetch1 = (async (url: string, init?: RequestInit) => {
		captured1.push({ url, ...(init === undefined ? {} : { init }) });
		if (url.includes("/v1/transcribe")) return new Response("bad gateway", { status: 502 });
		return new Response(JSON.stringify({ text: "  cloud transcript here  " }), { status: 200 });
	}) as unknown as typeof fetch;

	const backendEvents: Array<{ backend: string; fallbackReason?: string }> = [];
	const heard1 = await transcribe("https://mm1.test:8086", new Uint8Array([79, 103, 103, 83]), {
		filename: "file_42.oga",
		durationSeconds: 7,
		fallback: { url: "https://llm.int.exe.xyz/v1/audio/transcriptions" },
		fetchFn: fetch1,
		onBackend: (info) => backendEvents.push(info),
	});

	assert.equal(heard1.text, "cloud transcript here");
	assert.equal(heard1.seconds, 7);
	assert.equal(heard1.backend, "fallback");
	assert.equal(captured1.length, 2);
	assert.equal(captured1[0]?.url, "https://mm1.test:8086/v1/transcribe");
	assert.equal(captured1[1]?.url, "https://llm.int.exe.xyz/v1/audio/transcriptions");
	const headers1 = captured1[1]?.init?.headers as Record<string, string> | undefined;
	assert.equal(headers1?.Authorization, undefined, "no Authorization header when apiKey omitted");
	const form1 = captured1[1]?.init?.body as FormData;
	assert.ok(form1 instanceof FormData);
	assert.equal(form1.get("model"), "gpt-transcribe");
	assert.equal(form1.get("response_format"), null);
	const file1 = form1.get("file") as File;
	assert.equal(file1.name, "file_42.ogg");
	assert.equal(file1.type, "audio/ogg");
	assert.equal(backendEvents.length, 1);
	assert.equal(backendEvents[0]?.backend, "fallback");
	assert.match(backendEvents[0]?.fallbackReason ?? "", /502/);

	// 2) Primary timeout -> whisper-1 with Bearer token and response_format=verbose_json
	const captured2: Array<{ url: string; init?: RequestInit }> = [];
	const fetch2 = (async (url: string, init?: RequestInit) => {
		captured2.push({ url, ...(init === undefined ? {} : { init }) });
		if (url.includes("/v1/transcribe")) {
			return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out"))));
		}
		return new Response(JSON.stringify({ text: "whisper words", duration: 11.5 }), { status: 200 });
	}) as unknown as typeof fetch;

	const started = Date.now();
	const heard2 = await transcribe("https://mm1.test:8086", new Uint8Array([1, 2, 3]), {
		filename: "memo.oga",
		primaryTimeoutMs: 40,
		fallback: { url: "https://api.example.test/v1/audio/transcriptions", model: "openai/whisper-1", apiKey: "test-key" },
		fetchFn: fetch2,
	});

	assert.ok(Date.now() - started < 2_000);
	assert.equal(heard2.text, "whisper words");
	assert.equal(heard2.seconds, 11.5);
	assert.equal(heard2.backend, "fallback");
	const headers2 = captured2[1]?.init?.headers as Record<string, string> | undefined;
	assert.equal(headers2?.Authorization, "Bearer test-key");
	const form2 = captured2[1]?.init?.body as FormData;
	assert.equal(form2.get("model"), "openai/whisper-1");
	assert.equal(form2.get("response_format"), "verbose_json");
	assert.equal((form2.get("file") as File).name, "memo.ogg");
});

test("shared HostCircuitBreaker: decisionUrl failure trips breaker so speechUrl on same host skips primary (0ms wait) and vice versa", async () => {
	let now = 50_000;
	const breaker = new HostCircuitBreaker({ cooldownMs: 60_000, now: () => now });
	const logFile = join(dir, "shared-breaker.jsonl");
	const models = fauxModels(['{"fresh_check": 0.8}', '{"fresh_check": 0.2}', '{"fresh_check": 0.4}']);

	const d1Url = "https://mm1.tilapia-tawny.ts.net:8085";
	const speechUrl = "https://mm1.tilapia-tawny.ts.net:8086";

	let d1Calls = 0;
	let speechPrimaryCalls = 0;
	let speechFallbackCalls = 0;

	const decisions = decisionClient({
		url: d1Url,
		logFile,
		holdout: 0,
		breaker,
		fetchFn: (async () => {
			d1Calls++;
			throw new Error("connect EHOSTUNREACH");
		}) as unknown as typeof fetch,
		fallback: { models, provider: "faux", model: "faux-1" },
	});

	// Step 1: decisionUrl fails -> trips breaker for mm1.
	const dec1 = await decisions.ask({ id: "m1", site: "message", state: "hi", questions: sampleQuestions });
	assert.equal(dec1?.backend, "fallback");
	assert.equal(d1Calls, 1);
	assert.equal(breaker.isOpen(speechUrl), true);

	// Step 2: speechUrl on same host skips primary completely (0 primary fetches!) and goes straight to cloud fallback.
	const speechFetch = (async (url: string) => {
		if (url.includes("/v1/transcribe")) {
			speechPrimaryCalls++;
			return new Response(JSON.stringify({ text: "primary", seconds: 1, ms: 10 }), { status: 200 });
		}
		speechFallbackCalls++;
		return new Response(JSON.stringify({ text: "instant fallback" }), { status: 200 });
	}) as unknown as typeof fetch;

	const speech1 = await transcribe(speechUrl, new Uint8Array([1, 2]), {
		filename: "a.oga",
		breaker,
		fallback: { url: "https://llm.int.exe.xyz/v1/audio/transcriptions" },
		fetchFn: speechFetch,
	});
	assert.equal(speech1.text, "instant fallback");
	assert.equal(speech1.backend, "fallback");
	assert.equal(speechPrimaryCalls, 0, "primary speech must not be called while breaker is open");
	assert.equal(speechFallbackCalls, 1);

	// Step 3: Next decision also skips d1 immediately and logs skippedPrimary: true.
	const dec2 = await decisions.ask({ id: "m2", site: "message", state: "hi2", questions: sampleQuestions });
	assert.equal(dec2?.backend, "fallback");
	assert.equal(d1Calls, 1, "d1 must not be called while breaker is open");

	const entries = readFileSync(logFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { backend?: string; ok?: boolean; skippedPrimary?: boolean });
	assert.deepEqual(
		entries.map((e) => [e.backend, e.ok, e.skippedPrimary ?? false]),
		[
			["d1", false, false],
			["fallback", true, false],
			["fallback", true, true],
		],
	);

	// Step 4: Cooldown expires -> speechUrl probes primary and fails -> trips breaker again -> decisionUrl skips d1!
	now += 60_000;
	assert.equal(breaker.isOpen(d1Url), false);
	const speechFailFetch = (async (url: string) => {
		if (url.includes("/v1/transcribe")) {
			speechPrimaryCalls++;
			return new Response("down", { status: 503 });
		}
		speechFallbackCalls++;
		return new Response(JSON.stringify({ text: "fallback after speech probe" }), { status: 200 });
	}) as unknown as typeof fetch;
	const speech2 = await transcribe(speechUrl, new Uint8Array([1, 2]), {
		breaker,
		fallback: { url: "https://llm.int.exe.xyz/v1/audio/transcriptions" },
		fetchFn: speechFailFetch,
	});
	assert.equal(speech2.text, "fallback after speech probe");
	assert.equal(speechPrimaryCalls, 1);
	assert.equal(breaker.isOpen(d1Url), true);

	const dec3 = await decisions.ask({ id: "m3", site: "message", state: "hi3", questions: sampleQuestions });
	assert.equal(dec3?.backend, "fallback");
	assert.equal(d1Calls, 1, "d1 skipped again because speech tripped shared breaker");

	// Step 5: Cooldown expires again -> speech succeeds -> breaker recovers.
	now += 60_000;
	const speech3 = await transcribe(speechUrl, new Uint8Array([1, 2]), {
		breaker,
		fallback: { url: "https://llm.int.exe.xyz/v1/audio/transcriptions" },
		fetchFn: speechFetch,
	});
	assert.equal(speech3.text, "primary");
	assert.equal(speech3.backend, "primary");
	assert.equal(speechPrimaryCalls, 2);
	assert.equal(breaker.isOpen(d1Url), false);
});

test("circuit breaker never short-circuits when no fallback is configured", async () => {
	const breaker = new HostCircuitBreaker({ cooldownMs: 60_000, now: () => 1_000 });
	breaker.recordFailure("https://mm1.test:8085", "down");
	assert.equal(breaker.isOpen("https://mm1.test:8085"), true);

	// decisionClient without fallback still tries d1 (and recovers breaker when d1 answers).
	let d1Attempts = 0;
	const decisions = decisionClient({
		url: "https://mm1.test:8085",
		logFile: join(dir, "no-fallback.jsonl"),
		holdout: 0,
		breaker,
		fetchFn: (async () => {
			d1Attempts++;
			return new Response(JSON.stringify({ answers: { fresh_check: { noul: 0.1 } } }), { status: 200 });
		}) as unknown as typeof fetch,
	});
	const decided = await decisions.ask({ id: "nf1", site: "message", state: "hi", questions: sampleQuestions });
	assert.equal(d1Attempts, 1);
	assert.equal(decided?.backend, "d1");
	assert.equal(breaker.isOpen("https://mm1.test:8086"), false);

	// transcribe without fallback still tries primary even if breaker is open.
	breaker.recordFailure("https://mm1.test:8085", "down again");
	let speechAttempts = 0;
	const heard = await transcribe("https://mm1.test:8086", new Uint8Array([1]), {
		breaker,
		fetchFn: (async () => {
			speechAttempts++;
			return new Response(JSON.stringify({ text: "still works", seconds: 2, ms: 20 }), { status: 200 });
		}) as unknown as typeof fetch,
	});
	assert.equal(speechAttempts, 1);
	assert.equal(heard.text, "still works");
	assert.equal(breaker.isOpen("https://mm1.test:8085"), false);
});

test("config env vars and Telegram voice path wire speechFallback, shared breaker, and backend reporting", async () => {
	const prevUrl = process.env.PCLAW_SPEECH_FALLBACK_URL;
	const prevModel = process.env.PCLAW_SPEECH_FALLBACK_MODEL;
	const prevKey = process.env.PCLAW_SPEECH_FALLBACK_API_KEY;
	try {
		process.env.PCLAW_SPEECH_FALLBACK_URL = "https://llm.int.exe.xyz/v1/audio/transcriptions";
		delete process.env.PCLAW_SPEECH_FALLBACK_MODEL;
		delete process.env.PCLAW_SPEECH_FALLBACK_API_KEY;
		const cfg = loadConfig();
		assert.equal(cfg.speechFallbackUrl, "https://llm.int.exe.xyz/v1/audio/transcriptions");
		assert.deepEqual(speechFallbackFromConfig(cfg), {
			url: "https://llm.int.exe.xyz/v1/audio/transcriptions",
			model: "gpt-transcribe",
		});

		process.env.PCLAW_SPEECH_FALLBACK_MODEL = "whisper-1";
		process.env.PCLAW_SPEECH_FALLBACK_API_KEY = "sk-test";
		assert.deepEqual(speechFallbackFromConfig(loadConfig()), {
			url: "https://llm.int.exe.xyz/v1/audio/transcriptions",
			model: "whisper-1",
			apiKey: "sk-test",
		});
	} finally {
		if (prevUrl === undefined) delete process.env.PCLAW_SPEECH_FALLBACK_URL;
		else process.env.PCLAW_SPEECH_FALLBACK_URL = prevUrl;
		if (prevModel === undefined) delete process.env.PCLAW_SPEECH_FALLBACK_MODEL;
		else process.env.PCLAW_SPEECH_FALLBACK_MODEL = prevModel;
		if (prevKey === undefined) delete process.env.PCLAW_SPEECH_FALLBACK_API_KEY;
		else process.env.PCLAW_SPEECH_FALLBACK_API_KEY = prevKey;
	}

	// Telegram buildTelegramUserInput forwards .oga filename, fallback, breaker, and reports backend in onVoiceResult.
	const breaker = new HostCircuitBreaker({ cooldownMs: 60_000, now: () => 5_000 });
	breaker.recordFailure("https://mm1.test:8085", "d1 down");
	const voiceResults: unknown[] = [];
	const message: TelegramMessage = {
		message_id: 88,
		date: 1_700_000_000,
		chat: { id: 101, type: "private" },
		from: { id: 101, first_name: "Henry" },
		voice: { file_id: "f1", duration: 6, mime_type: "audio/ogg", file_size: 120 },
	};
	let fallbackFileName = "";
	const built = await buildTelegramUserInput([message], {
		api: {
			async getFile() {
				return { file_id: "f1", file_path: "voice/file_88.oga" };
			},
			async downloadFile() {
				return new Uint8Array([79, 103, 103, 83]);
			},
			async sendChatAction() {
				return true;
			},
		},
		timeZone: "UTC",
		voiceDir: join(dir, "tg-voice"),
		speechUrl: "https://mm1.test:8086",
		speechFallback: { url: "https://llm.int.exe.xyz/v1/audio/transcriptions", model: "gpt-transcribe" },
		breaker,
		transcribeFn: (url, audio, opts) =>
			transcribe(url, audio, {
				...(typeof opts === "function" ? { fetchFn: opts } : opts),
				fetchFn: (async (targetUrl: string, init?: RequestInit) => {
					assert.equal(targetUrl, "https://llm.int.exe.xyz/v1/audio/transcriptions", "breaker should skip primary");
					const form = init?.body as FormData;
					fallbackFileName = (form.get("file") as File).name;
					return new Response(JSON.stringify({ text: "grug heard via cloud" }), { status: 200 });
				}) as unknown as typeof fetch,
			}),
		onVoiceResult: (result) => voiceResults.push(result),
	});

	assert.equal(built.hasVoice, true);
	assert.equal(fallbackFileName, "file_88.ogg");
	assert.match(String(built.content), /grug heard via cloud/);
	assert.equal(voiceResults.length, 1);
	assert.deepEqual(
		{ ...(voiceResults[0] as Record<string, unknown>), ms: 0 },
		{ id: "telegram:88", ok: true, backend: "fallback", seconds: 6, ms: 0, words: 4 },
	);
});
