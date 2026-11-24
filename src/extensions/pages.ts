import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { obj, str } from "@earendil-works/pi-schema";
import { type ConversationId, defineExtension, defineTool, type DocumentReader } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { SLUG } from "../pages.ts";
import type { WorkerSandbox } from "../sandbox.ts";
import type { ResolvedUser } from "../users.ts";

export type RemotePagesContext = {
	address: string | undefined;
	user: ResolvedUser | undefined;
	sandbox: WorkerSandbox;
	allowPages: boolean;
};

export type RemotePagesResolver = (
	read: DocumentReader,
	conversationId: ConversationId,
	context: Context,
) => Promise<RemotePagesContext>;

export type PublishPageResult = {
	slug: string;
	url: string;
	homeUrl: string;
	fileCount: number;
	totalBytes: number;
};

/**
 * Front-agent `publish_page` tool for remote-sandbox users with `pagesCode` and `config.pagesUrl`.
 * Pulls the worker's built static Astro site (`~/site/dist/`) from the user's SSH VM, verifies it,
 * atomically swaps it into `<pagesDir>/<user.pagesCode>/`, and returns the live URLs.
 */
export function pagesExtension(options: {
	config: Pick<Config, "pagesUrl">;
	pagesDir: string;
	resolveSandbox: RemotePagesResolver;
}) {
	const inflightByCode = new Map<string, Promise<unknown>>();

	const serializeByCode = async <T>(code: string, fn: () => Promise<T>): Promise<T> => {
		const prev = inflightByCode.get(code) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		inflightByCode.set(code, settled);
		try {
			return await next;
		} finally {
			if (inflightByCode.get(code) === settled) inflightByCode.delete(code);
		}
	};

	return defineExtension({
		name: "pclaw.pages",
		tools: [
			defineTool({
				name: "publish_page",
				description:
					"Publish a static Astro page built by a worker under ~/work/pages/<slug>/ and built into ~/site/dist/. " +
					"Syncs the user's built site from their workspace to the public pages server and returns the live page URL and home shelf URL.",
				parameters: obj(
					{
						slug: str({
							description:
								"Built page slug (lowercase letters, digits, hyphens, e.g. 'nas-cases') reported by the worker.",
						}),
					},
					{ open: true },
				),
				execute: async ({ slug }, api, context) => {
					const cleanSlug = slug.trim();
					if (!SLUG.test(cleanSlug)) {
						throw new Error(
							`Invalid page slug "${slug}". Use 1-63 lowercase letters, digits, or hyphens (e.g. "nas-cases").`,
						);
					}
					const pagesUrl = options.config.pagesUrl?.trim().replace(/\/+$/, "");
					if (!pagesUrl) {
						throw new Error("Publishing pages is disabled (pagesUrl is not configured).");
					}
					const resolved = await options.resolveSandbox(api, api.conversationId, context);
					const pagesCode = resolved.user?.pagesCode?.trim();
					if (!resolved.allowPages || !pagesCode || resolved.sandbox.syncPages === undefined) {
						throw new Error("Publishing remote pages is not enabled for this conversation.");
					}

					const targetDir = join(options.pagesDir, pagesCode);
					const synced = await serializeByCode(pagesCode, () =>
						resolved.sandbox.syncPages!(targetDir, cleanSlug, context.abortSignal),
					);
					const homeUrl = `${pagesUrl}/${pagesCode}/`;
					const url = `${homeUrl}${cleanSlug}/`;
					const payload: PublishPageResult = {
						slug: cleanSlug,
						url,
						homeUrl,
						fileCount: synced.fileCount,
						totalBytes: synced.totalBytes,
					};
					return {
						output: [{ type: "text" as const, text: JSON.stringify(payload) }],
						details: payload,
					};
				},
			}),
		],
	});
}
