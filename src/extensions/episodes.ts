import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { formatRecentEpisodes } from "../episodes.ts";
import { addressOf } from "../routes.ts";
import { scopeForAddress, type SearchIndex } from "../search-index.ts";
import type { UserRegistry } from "../users.ts";

const DEFAULT_MAX_RECENT_EPISODES = 6;
const DEFAULT_RECENT_EPISODES_HOURS = 72;
const MAX_RECENT_EPISODES_CHARS = 4_000;

function unwrapSection(key: string, shown: string): string {
	const prefix = `<${key}>\n`;
	const suffix = `\n</${key}>`;
	if (shown.startsWith(prefix) && shown.endsWith(suffix)) {
		return shown.slice(prefix.length, shown.length - suffix.length);
	}
	return shown;
}

/**
 * Injects `<recent-episodes>` at session start (after `<notes>`, before `<formatting>`).
 * Frozen per session: once shown in the current session, returns the exact shown text unchanged
 * so `planSections()` never reorders or invalidates the KV cache mid-session.
 */
export function episodesExtension(options: {
	index: SearchIndex;
	config: Config;
	users?: UserRegistry;
	now?: () => number;
}) {
	const nowFn = options.now ?? Date.now;
	const maxEpisodes = options.config.sessionReset?.maxRecentEpisodes ?? DEFAULT_MAX_RECENT_EPISODES;
	const hours = options.config.sessionReset?.recentEpisodesHours ?? DEFAULT_RECENT_EPISODES_HOURS;

	return defineExtension({
		name: "pclaw.episodes",
		sections: [
			section("recent-episodes", async (input, context) => {
				if (input.shown["recent-episodes"] !== undefined) {
					return unwrapSection("recent-episodes", input.shown["recent-episodes"]);
				}
				const address = await addressOf(input.read, input.conversationId, context);
				const scope = scopeForAddress(address, input.conversationId, options.users);
				const user = options.users?.resolveAddress(address);
				const timeZone = user?.timeZone ?? options.config.timeZone;
				const sinceMs = nowFn() - hours * 60 * 60_000;
				const episodes = options.index.recentEpisodes(scope, { limit: maxEpisodes, sinceMs });
				return formatRecentEpisodes(episodes, timeZone, MAX_RECENT_EPISODES_CHARS);
			}),
		],
	});
}
