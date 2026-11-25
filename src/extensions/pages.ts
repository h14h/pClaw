import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { type ConversationId, defineExtension, defineTool, type DocumentReader } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { SLUG } from "../pages.ts";
import type { WorkerSandbox } from "../sandbox.ts";
import { ShareLinks, shareUrl } from "../share-links.ts";
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

/** Read by the front model right as it writes the reply that carries the link, where it can't be missed. */
export const PAGE_REPLY_RULE =
	"Reply now: a TL;DR of 1–2 short lines (headline verdict or number), then this url alone on the last line. " +
	"No label before the link, no recap, no lists: the page holds the detail.";

export type PublishPageResult = {
	slug: string;
	/** The page's share link: opens this page only, never the owner's shelf. The link to send. */
	url: string;
	/** The owner's shelf of all their pages. Only for the owner, only when they ask for it. */
	homeUrl: string;
	fileCount: number;
	totalBytes: number;
};

export type PageLinksResult =
	| { homeUrl: string; pages: { slug: string; url: string }[] }
	| { slug: string; url: string; rotated?: boolean };

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
	const links = new ShareLinks(options.pagesDir);
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
					"Syncs the user's built site from their workspace to the public pages server. Returns `url`, the page's private share link (the link to send), and `homeUrl`, the owner's all-pages link.",
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
					// The whole site was swapped in, so any other new pages get their links too.
					links.backfill(pagesCode);
					const url = shareUrl(pagesUrl, links.tokenFor(pagesCode, cleanSlug));
					const payload: PublishPageResult = {
						slug: cleanSlug,
						url,
						homeUrl,
						fileCount: synced.fileCount,
						totalBytes: synced.totalBytes,
					};
					return {
						output: [
							{ type: "text" as const, text: JSON.stringify(payload) },
							{ type: "text" as const, text: PAGE_REPLY_RULE },
						],
						details: payload,
					};
				},
			}),
			defineTool({
				name: "page_links",
				description:
					"Links to the user's published pages. With `slug`: that page's share link. With `slug` and `rotate: true`: " +
					"kill its current share link and mint a new one (old link stops working at once). Without `slug`: their " +
					"all-pages home link plus every page's share link.",
				parameters: obj(
					{
						slug: opt(str({ description: "Published page slug, e.g. 'nas-cases'. Leave out for all pages." })),
						rotate: opt(bool({ description: "true to replace this page's share link with a new one." })),
					},
					{ open: true },
				),
				execute: async ({ slug, rotate }, api, context) => {
					const pagesUrl = options.config.pagesUrl?.trim().replace(/\/+$/, "");
					if (!pagesUrl) throw new Error("Pages are disabled (pagesUrl is not configured).");
					const resolved = await options.resolveSandbox(api, api.conversationId, context);
					const pagesCode = resolved.user?.pagesCode?.trim();
					if (!resolved.allowPages || !pagesCode) throw new Error("Pages are not enabled for this conversation.");
					const cleanSlug = slug?.trim();
					let payload: PageLinksResult;
					if (cleanSlug === undefined || cleanSlug === "") {
						if (rotate === true) throw new Error("Say which page: rotate needs `slug`.");
						links.backfill(pagesCode);
						payload = {
							homeUrl: `${pagesUrl}/${pagesCode}/`,
							pages: links.slugs(pagesCode).map((page) => ({ slug: page, url: shareUrl(pagesUrl, links.tokenFor(pagesCode, page)) })),
						};
					} else {
						if (!links.isPublished(pagesCode, cleanSlug)) {
							const known = links.slugs(pagesCode);
							throw new Error(
								`No published page "${cleanSlug}".${known.length > 0 ? ` Published: ${known.join(", ")}.` : ""}`,
							);
						}
						const token = rotate === true ? links.rotate(pagesCode, cleanSlug) : links.tokenFor(pagesCode, cleanSlug);
						payload = { slug: cleanSlug, url: shareUrl(pagesUrl, token), ...(rotate === true ? { rotated: true } : {}) };
					}
					return { output: [{ type: "text" as const, text: JSON.stringify(payload) }], details: payload };
				},
			}),
		],
	});
}
