import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import {
	buildTelegramUserInput,
	createCaptionlessFileBuffer,
	extractReplyContext,
	startTelegram,
	type TelegramMessage,
	type TelegramUpdate,
} from "./channels/telegram.ts";
import { type Config, defaults } from "./config.ts";
import { Notes } from "./extensions/notes.ts";
import {
	currentLocationLine,
	type Geocoder,
	LIVE_GRACE_MS,
	LocationStore,
	nominatimGeocoder,
	PIN_FRESH_MS,
	placeFromNominatim,
	redactCoordinates,
	type SharedLocation,
	STRIP_LOCATION,
} from "./location.ts";

// A made-up spot for tests, not anyone's real location.
const LAT = 39.550512;
const LON = -107.324817;
const POINT = "39.5505, -107.3248";
const PLACE = "Waterside Dr, Glenwood Springs, CO, US";
const PIN_DATE = 1_795_622_300; // Wed 2026-11-25 15:58:20 UTC

const fakeGeocoder = (calls: [number, number][] = []): Geocoder => async (lat, lon) => {
	calls.push([lat, lon]);
	if (lat > 40) return { label: "Main St, Carbondale, CO, US", town: "Carbondale, CO" };
	return { label: PLACE, town: "Glenwood Springs, CO" };
};
const noApi = {
	getFile: async () => {
		throw new Error("no files here");
	},
	downloadFile: async () => new Uint8Array(),
	sendChatAction: async () => true,
};
const msg = (id: number, extra: Partial<TelegramMessage>, date = PIN_DATE): TelegramMessage => ({
	message_id: id,
	date,
	chat: { id: 501, type: "private" },
	from: { id: 501, first_name: "Henry" },
	...extra,
});

test("a location, place, and live location become short notes with the place and 4-decimal coordinates", async () => {
	const pin = await buildTelegramUserInput([msg(1, { location: { latitude: LAT, longitude: LON } })], {
		api: noApi,
		timeZone: "UTC",
		geocoder: fakeGeocoder(),
	});
	assert.match(String(pin.content), new RegExp(`\\[shared location: ${PLACE} \\(${POINT}\\)\\]`));
	assert.equal(pin.sharedLocations[0]?.kind, "pin");
	assert.equal(pin.sharedLocations[0]?.town, "Glenwood Springs, CO");
	assert.equal(pin.sharedLocations[0]?.expiresAt, PIN_DATE * 1000 + PIN_FRESH_MS);
	// What the decision model and its log see carries no precise coordinates.
	assert.equal(pin.plainText, `[shared location: ${PLACE}]`);

	const venue = await buildTelegramUserInput(
		[msg(2, { location: { latitude: LAT, longitude: LON }, venue: { location: { latitude: LAT, longitude: LON }, title: "Riverside Cinema", address: "715 Grand Ave" } })],
		{ api: noApi, timeZone: "UTC", geocoder: fakeGeocoder() },
	);
	assert.match(String(venue.content), new RegExp(`\\[shared place: Riverside Cinema, 715 Grand Ave, Glenwood Springs, CO \\(${POINT}\\)\\]`));
	assert.equal(venue.sharedLocations[0]?.kind, "place");

	const live = await buildTelegramUserInput([msg(3, { location: { latitude: LAT, longitude: LON, live_period: 3600 } })], {
		api: noApi,
		timeZone: "UTC",
		geocoder: fakeGeocoder(),
	});
	assert.match(String(live.content), new RegExp(`\\[sharing live location until 16:58: ${PLACE} \\(${POINT}\\)\\]`));
	assert.equal(live.sharedLocations[0]?.liveUntil, (PIN_DATE + 3600) * 1000);
	assert.equal(live.sharedLocations[0]?.expiresAt, (PIN_DATE + 3600) * 1000 + LIVE_GRACE_MS);
});

test("a geocoder that fails or throws leaves the coordinates, and the message still goes through", async () => {
	for (const geocoder of [async () => undefined, async () => Promise.reject(new Error("boom"))] as Geocoder[]) {
		const built = await buildTelegramUserInput([msg(1, { location: { latitude: LAT, longitude: LON } })], { api: noApi, timeZone: "UTC", geocoder });
		assert.match(String(built.content), new RegExp(`\\[shared location: \\(${POINT}\\)\\]`));
		assert.equal(built.sharedLocations[0]?.place, undefined);
	}

	// Nominatim: an error status, a hang past the timeout, and bad JSON all resolve undefined, quickly.
	const slow: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError"))));
	for (const fetchFn of [async () => new Response("nope", { status: 503 }), slow, async () => new Response("not json")] as (typeof fetch)[]) {
		const geocoder = nominatimGeocoder({ fetchFn, timeoutMs: 50, minIntervalMs: 0 });
		const started = Date.now();
		assert.equal(await geocoder(LAT, LON), undefined);
		assert.ok(Date.now() - started < 1_000);
	}
});

test("Nominatim lookups send only the rounded point with a generic User-Agent, cache per point, and keep 1 request a second", async () => {
	const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
	const fetchFn: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), headers: init?.headers as Record<string, string>, at: Date.now() });
		return Response.json({
			display_name: "12, Waterside Drive, Glenwood Springs, Garfield County, Colorado, 81601, United States",
			address: { house_number: "12", road: "Waterside Drive", city: "Glenwood Springs", county: "Garfield County", state: "Colorado", "ISO3166-2-lvl4": "US-CO", country: "United States", country_code: "us" },
		});
	};
	const geocoder = nominatimGeocoder({ fetchFn, minIntervalMs: 200 });
	assert.deepEqual(await geocoder(LAT, LON), { label: "Waterside Drive, Glenwood Springs, CO, US", town: "Glenwood Springs, CO" });
	await geocoder(LAT + 0.000001, LON); // same rounded point: cached
	assert.equal(calls.length, 1);
	await geocoder(LAT + 0.01, LON);
	assert.equal(calls.length, 2);
	assert.ok(calls[1]!.at - calls[0]!.at >= 190, "second lookup waits out the rate limit");

	const url = new URL(calls[0]!.url);
	assert.equal(url.origin + url.pathname, "https://nominatim.openstreetmap.org/reverse");
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		format: "jsonv2",
		zoom: "16",
		addressdetails: "1",
		"accept-language": "en",
		lat: "39.5505",
		lon: "-107.3248",
	});
	assert.equal(calls[0]!.headers["user-agent"], "pclaw/1.0 (personal assistant)");

	// Outside the US: neighbourhood when there's no road, full region and country names.
	assert.deepEqual(placeFromNominatim({ address: { suburb: "Alfama", city: "Lisbon", state: "Lisbon", country: "Portugal", country_code: "pt" } }), {
		label: "Alfama, Lisbon, Portugal",
		town: "Lisbon, Lisbon",
	});
	assert.equal(placeFromNominatim({ error: "Unable to geocode" }), undefined);
});

test("a reply or quote that points at a shared location names the place", async () => {
	const reply = msg(9, {
		text: "what's good to eat around here?",
		reply_to_message: msg(8, { location: { latitude: LAT, longitude: LON } }, PIN_DATE - 60),
	});
	assert.match(extractReplyContext(reply, 999, "UTC")[0]!, new RegExp(`^\\[replying to their own shared location from .*: "\\(${POINT}\\)"\\]$`));
	const built = await buildTelegramUserInput([reply], { api: noApi, timeZone: "UTC", geocoder: fakeGeocoder() });
	assert.match(String(built.content), new RegExp(`\\[replying to their own shared location from .*: "${PLACE} \\(${POINT}\\)"\\]`));
	assert.deepEqual(built.sharedLocations, [], "a reply doesn't re-share the old pin");

	const venueReply = msg(10, { text: "book there?", reply_to_message: msg(7, { location: { latitude: LAT, longitude: LON }, venue: { location: { latitude: LAT, longitude: LON }, title: "Riverside Cinema", address: "715 Grand Ave" } }) });
	assert.match(extractReplyContext(venueReply, 999, "UTC")[0]!, /\[replying to their own shared place from .*: "Riverside Cinema, 715 Grand Ave \(39\.5505, -107\.3248\)"\]/);
});

test("a pin waits for the question that follows it, longer than a captionless file", async () => {
	const flushed: TelegramMessage[][] = [];
	const buffer = createCaptionlessFileBuffer({ delayMs: 20, locationDelayMs: 150, onFlush: (batch) => void flushed.push(batch) });
	buffer.enqueue([msg(1, { location: { latitude: LAT, longitude: LON } })]);
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(flushed.length, 0, "still holding the pin past the file delay");
	buffer.enqueue([msg(2, { text: "Movies near me today?" })]);
	await buffer.flushAll();
	assert.deepEqual(flushed.map((batch) => batch.map((each) => each.message_id)), [[1, 2]]);

	buffer.enqueue([msg(3, { location: { latitude: LAT, longitude: LON } })]);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.deepEqual(flushed.at(-1)?.map((each) => each.message_id), [3], "a lone pin goes on its own");
	buffer.stop();
});

test("current location: a fresh share shows as a one-line hint, then expires", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-location-"));
	try {
		const store = new LocationStore(join(dir, "users", "henry", "location.json"));
		const pinAt = PIN_DATE * 1000;
		const pin: SharedLocation = { kind: "pin", lat: LAT, lon: LON, place: PLACE, town: "Glenwood Springs, CO", messageId: 1, sharedAt: pinAt, updatedAt: pinAt, expiresAt: pinAt + PIN_FRESH_MS };
		store.set("telegram:501", pin);
		const twoHours = pinAt + 2 * 60 * 60_000;
		assert.equal(
			currentLocationLine(store.current("telegram:501", twoHours)!, twoHours, "America/Denver"),
			`<location>Current location (shared 08:58, 2h ago): ${PLACE} (${POINT})</location>`,
		);
		assert.equal(store.current("telegram:501", pinAt + PIN_FRESH_MS + 1), undefined);
		assert.equal(store.current("telegram:777", twoHours), undefined);

		const live: SharedLocation = { ...pin, kind: "live", liveUntil: pinAt + 15 * 60_000, expiresAt: pinAt + 15 * 60_000 + LIVE_GRACE_MS };
		assert.match(currentLocationLine(live, pinAt + 5 * 60_000, "UTC"), /^<location>Current location \(live, updated 15:58, 5m ago\)/);
		assert.match(currentLocationLine(live, pinAt + 30 * 60_000, "UTC"), /^<location>Current location \(shared 15:58, 30m ago\)/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("precise coordinates never reach the notes", () => {
	assert.equal(redactCoordinates(`[shared location: ${PLACE} (${POINT})]`), `[shared location: ${PLACE}]`);
	assert.equal(redactCoordinates("Pin at 39.550512,-107.324817 today"), "Pin at today");
	assert.equal(redactCoordinates("Paid $12.50, 3.5 hours"), "Paid $12.50, 3.5 hours");
	assert.equal(`a\n<location>Current location (shared 08:58, 2h ago): ${PLACE} (${POINT})</location>\nb`.replace(STRIP_LOCATION, ""), "a\nb");
});

type Harness = {
	requests: ModelContext[];
	sent: Record<string, unknown>[];
	push(updates: TelegramUpdate[]): void;
	waitFor(predicate: () => boolean, ms?: number): Promise<void>;
	settle(ms: number): Promise<void>;
};

/** A Telegram bot on a faux model and a fake Bot API, with a fake geocoder. */
async function withBot(
	options: { now: () => number; geocoderCalls?: [number, number][]; replies: string[] },
	run: (bot: Harness, agent: Awaited<ReturnType<typeof openAgent>>, dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pclaw-tg-location-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const requests: ModelContext[] = [];
	faux.setResponses(
		options.replies.map((reply) => (request: ModelContext) => {
			requests.push(request);
			return fauxAssistantMessage(reply);
		}),
	);
	const config: Config = {
		...defaults,
		provider: "faux",
		model: "faux-1",
		thinkingLevel: "off",
		timeZone: "UTC",
		telegramToken: "fake-token",
		telegramOwnerId: "501",
		telegramAllowedUsers: [],
		telegramAllowedGroups: [],
	};
	const agent = await openAgent(await openNodeSqliteStorage(join(dir, "pclaw.sqlite")), { config, models, notes: new Notes(join(dir, "notes.md")) }, BACKGROUND_CONTEXT);
	const queue: TelegramUpdate[][] = [];
	let wake: (() => void) | undefined;
	const sent: Record<string, unknown>[] = [];
	const fetchFn: typeof fetch = async (input, init) => {
		const method = String(input).split("/").pop()!;
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		if (method === "getMe") return Response.json({ ok: true, result: { id: 999, is_bot: true, username: "pclaw_test_bot" } });
		if (method === "getUpdates") {
			if (queue.length > 0) return Response.json({ ok: true, result: queue.shift()! });
			return new Promise<Response>((resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
				wake = () => resolve(Response.json({ ok: true, result: queue.shift() ?? [] }));
			});
		}
		if (method === "sendMessage") {
			sent.push(body);
			return Response.json({ ok: true, result: { message_id: 900 + sent.length, date: PIN_DATE, chat: { id: 501, type: "private" } } });
		}
		return Response.json({ ok: true, result: true });
	};
	const tg = await startTelegram(agent, config, BACKGROUND_CONTEXT, {
		apiBase: "https://tg.test",
		fetchFn,
		pollTimeoutSeconds: 1,
		captionlessDebounceMs: 20,
		locationDelayMs: 250,
		inboxDir: join(dir, "inbox"),
		voiceDir: join(dir, "voice"),
		geocoder: fakeGeocoder(options.geocoderCalls),
		locationFile: join(dir, "location.json"),
		now: options.now,
	});
	const bot: Harness = {
		requests,
		sent,
		push(updates) {
			queue.push(updates);
			const resume = wake;
			wake = undefined;
			resume?.();
		},
		waitFor: (predicate, ms = 5_000) =>
			new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + ms;
				const tick = () => {
					if (predicate()) resolve();
					else if (Date.now() > deadline) reject(new Error("timed out"));
					else setTimeout(tick, 15);
				};
				tick();
			}),
		settle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
	try {
		await run(bot, agent, dir);
	} finally {
		await tg.stop();
		await agent.harness.close(BACKGROUND_CONTEXT);
		agent.searchIndex.close();
		await rm(dir, { recursive: true, force: true });
	}
}

const lastUserText = (request: ModelContext | undefined) => JSON.stringify(request?.messages.at(-1)?.content ?? "");

test("a pin then 'movies near me?' is one turn; later turns carry the current location until it expires; notes never get coordinates", async () => {
	let clock = PIN_DATE * 1000 + 5_000;
	await withBot({ now: () => clock, replies: ["Riverside Cinema, 7:10.", "Tomorrow too.", '{"add": ["Henry travelling, at 39.5505, -107.3248 in Glenwood Springs, CO, 2026-11-25"], "remove": []}', "Where you at?"] }, async (bot, agent, dir) => {
		bot.push([{ update_id: 1, message: msg(300, { location: { latitude: LAT, longitude: LON } }) }]);
		await bot.settle(60);
		bot.push([{ update_id: 2, message: msg(301, { text: "Movies near me today?" }, PIN_DATE + 4) }]);
		await bot.waitFor(() => bot.sent.length >= 1);
		await bot.settle(300);
		assert.equal(bot.requests.length, 1, "the pin and the question are one turn");
		const turn = lastUserText(bot.requests[0]);
		assert.match(turn, /Movies near me today\?/);
		assert.match(turn, new RegExp(`\\[shared location: ${PLACE} \\(${POINT}\\)\\]`));
		assert.doesNotMatch(turn, /<location>/, "the turn that shares it doesn't also get the hint");
		assert.equal(JSON.parse(readFileSync(join(dir, "location.json"), "utf8"))["telegram:501"].place, PLACE);

		clock = PIN_DATE * 1000 + 2 * 60 * 60_000;
		bot.push([{ update_id: 3, message: msg(302, { text: "and tomorrow?" }, PIN_DATE + 7200) }]);
		await bot.waitFor(() => bot.requests.length >= 2);
		assert.match(lastUserText(bot.requests[1]), new RegExp(`<location>Current location \\(shared 15:58, 2h ago\\): ${PLACE} \\(${POINT}\\)</location>`));

		// The memory pass sees the town, not the coordinates, and a note that tries to keep them loses them.
		const conversationId = (await agent.addresses(BACKGROUND_CONTEXT))["telegram:dm:501"]!;
		await bot.waitFor(() => bot.sent.length >= 2);
		const flushed = await agent.flushMemory(conversationId, BACKGROUND_CONTEXT);
		const memoryInput = lastUserText(bot.requests[2]);
		assert.match(memoryInput, /Glenwood Springs/);
		assert.doesNotMatch(memoryInput, /39\.55|107\.32/);
		assert.doesNotMatch(memoryInput, /<location>/);
		assert.equal(flushed.added.length, 1);
		const notes = readFileSync(join(dir, "notes.md"), "utf8");
		assert.match(notes, /Glenwood Springs, CO/);
		assert.doesNotMatch(notes, /39\.55|107\.32/);

		clock = PIN_DATE * 1000 + PIN_FRESH_MS + 60_000;
		bot.push([{ update_id: 4, message: msg(303, { text: "movies near me tonight?" }, PIN_DATE + 13 * 3600) }]);
		await bot.waitFor(() => bot.requests.length >= 4);
		assert.doesNotMatch(lastUserText(bot.requests[3]), /<location>|Current location/, "an expired pin isn't shown");
	});
});

test("a lone pin gets one short turn of its own, and the prompt says to just acknowledge it", async () => {
	await withBot({ now: () => PIN_DATE * 1000 + 10_000, replies: ["Got pin. Glenwood Springs."] }, async (bot) => {
		bot.push([{ update_id: 1, message: msg(400, { location: { latitude: LAT, longitude: LON } }) }]);
		await bot.waitFor(() => bot.sent.length >= 1);
		assert.equal(bot.requests.length, 1);
		assert.match(lastUserText(bot.requests[0]), new RegExp(`\\[shared location: ${PLACE} \\(${POINT}\\)\\]`));
		assert.match(JSON.stringify(bot.requests[0]), /A pin on its own, with no question, gets a few-word acknowledgement/);
		assert.equal(bot.sent[0]?.text, "Got pin. Glenwood Springs.");
	});
});

test("live location: edits update where they are silently, re-geocode only after moving, and a stopped share lingers briefly", async () => {
	let clock = PIN_DATE * 1000 + 5_000;
	const calls: [number, number][] = [];
	await withBot({ now: () => clock, geocoderCalls: calls, replies: ["Watching.", "Carbondale now."] }, async (bot, _agent, dir) => {
		const stored = () => JSON.parse(readFileSync(join(dir, "location.json"), "utf8"))["telegram:501"] as SharedLocation;
		bot.push([{ update_id: 1, message: msg(500, { location: { latitude: LAT, longitude: LON, live_period: 3600 } }) }]);
		await bot.waitFor(() => bot.sent.length >= 1);
		assert.match(lastUserText(bot.requests[0]), /\[sharing live location until 16:58: /);
		assert.equal(calls.length, 1);

		// A tiny move: no new lookup. A big one: a new place.
		const edit = (id: number, lat: number, editDate: number, livePeriod: number | undefined): TelegramUpdate => ({
			update_id: id,
			edited_message: msg(500, { edit_date: editDate, location: { latitude: lat, longitude: LON, ...(livePeriod === undefined ? {} : { live_period: livePeriod }) } }),
		});
		bot.push([edit(2, LAT + 0.0005, PIN_DATE + 60, 3600)]);
		await bot.waitFor(() => existsSync(join(dir, "location.json")) && stored().updatedAt === (PIN_DATE + 60) * 1000);
		assert.equal(calls.length, 1);
		assert.equal(stored().place, PLACE);
		bot.push([edit(3, 40.4, PIN_DATE + 600, 3600)]);
		await bot.waitFor(() => stored().updatedAt === (PIN_DATE + 600) * 1000);
		assert.equal(calls.length, 2);
		assert.equal(stored().place, "Main St, Carbondale, CO, US");
		assert.equal(stored().lat, 40.4);
		assert.equal(stored().expiresAt, (PIN_DATE + 3600) * 1000 + LIVE_GRACE_MS);

		// They stop sharing: Telegram's last edit has no live_period. Current for a short grace, then gone.
		bot.push([edit(4, 40.4, PIN_DATE + 900, undefined)]);
		await bot.waitFor(() => stored().updatedAt === (PIN_DATE + 900) * 1000);
		assert.equal(stored().liveUntil, (PIN_DATE + 900) * 1000);
		assert.equal(stored().expiresAt, (PIN_DATE + 900) * 1000 + LIVE_GRACE_MS);
		await bot.settle(300);
		assert.equal(bot.requests.length, 1, "edits never start a turn");
		assert.equal(bot.sent.length, 1, "edits never send anything");

		clock = (PIN_DATE + 1200) * 1000;
		bot.push([{ update_id: 5, message: msg(501, { text: "food near me?" }, PIN_DATE + 1200) }]);
		await bot.waitFor(() => bot.requests.length >= 2);
		assert.match(lastUserText(bot.requests[1]), /<location>Current location \(shared 16:13, 5m ago\): Main St, Carbondale, CO, US \(40\.4000, -107\.3248\)<\/location>/);
	});
});
