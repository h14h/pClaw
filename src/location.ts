import { existsSync, readFileSync } from "node:fs";
import { writePrivate } from "./config.ts";

/**
 * Locations people share in chat (a Telegram pin, a place, or a live location): what the model is told, the
 * reverse geocoding that turns coordinates into a place, and the per-person "current location" with an expiry.
 *
 * Privacy: precise coordinates go to the front model for the turn that needs them, to the geocoder, and to tools the
 * model calls for that request. They never go into notes, episodes, the recall index, the decision model, or info logs;
 * `redactCoordinates` and `STRIP_LOCATION` are what keep them out.
 */

/** A one-off pin (or place) counts as where they are for this long. */
export const PIN_FRESH_MS = 12 * 60 * 60_000;
/** A live location stays current this long after it stops updating or its live period ends. */
export const LIVE_GRACE_MS = 60 * 60_000;
/** Telegram's `live_period` for "until I turn it off". */
const LIVE_FOREVER = 0x7fffffff;

export type GeoPlace = {
	/** "Waterside Dr, Glenwood Springs, CO, US". */
	label: string;
	/** Town or city level only, the most that may go into long-term notes. */
	town?: string;
};

export type Geocoder = (lat: number, lon: number) => Promise<GeoPlace | undefined>;

export type SharedLocation = {
	kind: "pin" | "place" | "live";
	lat: number;
	lon: number;
	/** What the geocoder (or the venue) says this is. Missing when geocoding failed. */
	place?: string;
	town?: string;
	/** For a place (Telegram venue): its name and address. */
	title?: string;
	address?: string;
	/** Telegram message id, so live-location edits find the share they belong to. */
	messageId: number;
	sharedAt: number;
	updatedAt: number;
	/** When a live location stops (or stopped) updating; undefined for "until I turn it off". */
	liveUntil?: number;
	expiresAt: number;
	/** Coordinates the place label was looked up for, so a live location re-geocodes only once it has moved. */
	placeLat?: number;
	placeLon?: number;
};

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
export const coords = (lat: number, lon: number) => `${round4(lat).toFixed(4)}, ${round4(lon).toFixed(4)}`;

/** Lat/lon pairs with at least three decimals, the precision that pins down a street. */
const COORDINATE_PAIR = /\s*(?:\(\s*)?-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}(?:\s*\))?/g;

/** Remove precise coordinates from text bound for notes, episodes, recall, logs, or the decision model. */
export function redactCoordinates(text: string): string {
	return text.replace(COORDINATE_PAIR, "");
}

/** The per-turn current-location hint; it's for this turn only, so long-term memory strips it. */
export const STRIP_LOCATION = /<location>[\s\S]*?<\/location>\s*/g;

/** Great-circle distance in meters. */
export function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const rad = Math.PI / 180;
	const dLat = (bLat - aLat) * rad;
	const dLon = (bLon - aLon) * rad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
	return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

type NominatimAddress = Record<string, string | undefined>;

/** Turn a Nominatim `address` block into "street or neighbourhood, town, region, country". No house numbers. */
export function placeFromNominatim(result: { address?: NominatimAddress; display_name?: string; error?: string }): GeoPlace | undefined {
	if (result.error !== undefined) return undefined;
	const a = result.address ?? {};
	const street = a.road ?? a.pedestrian ?? a.footway ?? a.path ?? a.square ?? a.cycleway;
	const area = a.neighbourhood ?? a.suburb ?? a.quarter ?? a.city_district ?? a.hamlet;
	const town = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.county;
	const isUs = a.country_code?.toLowerCase() === "us";
	const usState = isUs ? a["ISO3166-2-lvl4"]?.split("-")[1] : undefined;
	const region = usState ?? a.state ?? a.region ?? a.province;
	const country = isUs ? "US" : a.country;
	const parts: string[] = [];
	for (const part of [street ?? area, town, region, country]) {
		if (part !== undefined && part.trim() !== "" && !parts.includes(part.trim())) parts.push(part.trim());
	}
	if (parts.length === 0) {
		const fallback = result.display_name?.split(",").slice(-4).map((part) => part.trim()).filter(Boolean).join(", ");
		return fallback === undefined || fallback === "" ? undefined : { label: fallback };
	}
	const townLevel = [town, region].filter((part): part is string => part !== undefined && part !== "").join(", ");
	return { label: parts.join(", "), ...(townLevel === "" ? {} : { town: townLevel }) };
}

/**
 * Reverse geocoding through OpenStreetMap Nominatim. Follows its usage policy: an honest, generic User-Agent (nothing
 * that identifies the person), at most one request a second, and answers cached per coordinate rounded to 4 decimals
 * (~11 m). Each lookup gives up after `timeoutMs` and resolves undefined, so a slow or failing geocoder never holds up
 * a message for long.
 */
export function nominatimGeocoder(options: {
	fetchFn?: typeof fetch;
	baseUrl?: string;
	timeoutMs?: number;
	minIntervalMs?: number;
	/** Give up instead of queueing longer than this behind other lookups. */
	maxWaitMs?: number;
	userAgent?: string;
	cacheSize?: number;
} = {}): Geocoder {
	const fetchFn = options.fetchFn ?? fetch;
	const base = (options.baseUrl ?? "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
	const timeoutMs = options.timeoutMs ?? 2_000;
	const minIntervalMs = options.minIntervalMs ?? 1_000;
	const maxWaitMs = options.maxWaitMs ?? 2_000;
	const userAgent = options.userAgent ?? "pclaw/1.0 (personal assistant)";
	const cacheSize = options.cacheSize ?? 500;
	const cache = new Map<string, { place: GeoPlace | undefined; until: number }>();
	let nextSlot = 0;

	return async (lat, lon) => {
		const key = coords(lat, lon);
		const hit = cache.get(key);
		if (hit !== undefined && hit.until > Date.now()) {
			cache.delete(key);
			cache.set(key, hit);
			return hit.place;
		}
		const now = Date.now();
		const slot = Math.max(now, nextSlot);
		if (slot - now > maxWaitMs) return undefined;
		nextSlot = slot + minIntervalMs;
		if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
		const url = `${base}/reverse?format=jsonv2&zoom=16&addressdetails=1&accept-language=en&lat=${round4(lat).toFixed(4)}&lon=${round4(lon).toFixed(4)}`;
		let place: GeoPlace | undefined;
		let ok = false;
		try {
			const response = await fetchFn(url, { headers: { "user-agent": userAgent, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			place = placeFromNominatim((await response.json()) as Parameters<typeof placeFromNominatim>[0]);
			ok = true;
		} catch (error) {
			// No coordinates in the log line.
			console.warn(`[pclaw] reverse geocoding failed, using coordinates only: ${error instanceof Error ? error.message : String(error)}`);
		}
		// Failures are cached briefly so a flapping geocoder isn't hammered; answers for a day.
		cache.set(key, { place, until: Date.now() + (ok ? 24 * 60 * 60_000 : 60_000) });
		while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
		return place;
	};
}

/** Look a point up without ever throwing. */
export async function lookUp(geocoder: Geocoder | undefined, lat: number, lon: number): Promise<GeoPlace | undefined> {
	if (geocoder === undefined) return undefined;
	try {
		return await geocoder(lat, lon);
	} catch (error) {
		console.warn(`[pclaw] reverse geocoding failed, using coordinates only: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/** When a share stops counting as where they are. */
export function expiryFor(kind: SharedLocation["kind"], updatedAt: number, liveUntil: number | undefined): number {
	if (kind !== "live") return updatedAt + PIN_FRESH_MS;
	// "Until I turn it off" may go quiet while they sit still, so it's trusted like a pin from its last update.
	if (liveUntil === undefined) return updatedAt + PIN_FRESH_MS;
	return Math.max(liveUntil, updatedAt) + LIVE_GRACE_MS;
}

/** A Telegram `live_period` (seconds after `date`) as a time, or undefined for "until I turn it off". */
export function liveUntilFrom(dateMs: number, livePeriod: number): number | undefined {
	return livePeriod >= LIVE_FOREVER ? undefined : dateMs + livePeriod * 1000;
}

const hhmm = (at: number, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

function ago(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}

/** What the place is called, for notes the model reads: the label, a venue's name and address, or nothing. */
export function placeText(location: Pick<SharedLocation, "kind" | "place" | "title" | "address" | "town">): string | undefined {
	if (location.kind === "place" && location.title !== undefined) {
		const address = location.address?.trim();
		const town = location.town !== undefined && (address === undefined || !address.includes(location.town.split(",")[0]!)) ? location.town : undefined;
		return [location.title, address, town].filter((part) => part !== undefined && part !== "").join(", ");
	}
	return location.place;
}

/** The note for the message that shared it: `[shared location: Waterside Dr, Town, CO, US (39.5505, -107.3248)]`. */
export function sharedLocationNote(location: SharedLocation, timeZone: string): string {
	const where = placeText(location);
	const point = `(${coords(location.lat, location.lon)})`;
	const body = where === undefined ? point : `${where} ${point}`;
	if (location.kind === "place") return `[shared place: ${body}]`;
	if (location.kind === "live") {
		const until = location.liveUntil === undefined ? "until they turn it off" : `until ${hhmm(location.liveUntil, timeZone)}`;
		return `[sharing live location ${until}: ${body}]`;
	}
	return `[shared location: ${body}]`;
}

/** The per-turn hint on later messages while a shared location is fresh. */
export function currentLocationLine(location: SharedLocation, now: number, timeZone: string): string {
	const where = placeText(location);
	const point = coords(location.lat, location.lon);
	const live = location.kind === "live" && (location.liveUntil === undefined || location.liveUntil > now);
	const when = live
		? `live, updated ${hhmm(location.updatedAt, timeZone)}, ${ago(now - location.updatedAt)}`
		: `shared ${hhmm(location.updatedAt, timeZone)}, ${ago(now - location.updatedAt)}`;
	return `<location>Current location (${when}): ${where === undefined ? point : `${where} (${point})`}</location>`;
}

type StoreFile = Record<string, SharedLocation>;

/**
 * Each person's last shared location, in a small private JSON file (per user under `users/<id>/location.json`, or
 * `location.json` for a single-owner pclaw). Keyed by who shared it, e.g. `telegram:<userId>`.
 */
export class LocationStore {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	#read(): StoreFile {
		if (!existsSync(this.file)) return {};
		try {
			return JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
		} catch {
			return {};
		}
	}

	/** The stored share whether or not it's still fresh. */
	raw(key: string): SharedLocation | undefined {
		return this.#read()[key];
	}

	/** Their current location, if one is still fresh at `now`. */
	current(key: string, now: number): SharedLocation | undefined {
		const location = this.raw(key);
		return location !== undefined && location.expiresAt > now ? location : undefined;
	}

	set(key: string, location: SharedLocation): void {
		const all = this.#read();
		all[key] = location;
		writePrivate(this.file, `${JSON.stringify(all, null, "\t")}\n`);
	}
}
