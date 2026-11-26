/**
 * Dedicated static-only HTTP server for published grug-pages.
 *
 * Reuses `sites/grug-pages/lib/static-handler.mjs` directly so production pages
 * serve the exact same CSP, security headers, MIME types, dotfile blocking, and
 * realpath confinement as `grug-page preview`.
 */
import { createReadStream, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { createStaticHandler, mimeTypeFor, resolveSafeFile, SECURITY_HEADERS } from "../sites/grug-pages/lib/static-handler.mjs";
import { PAGES_CODE } from "./config.ts";
import { ShareLinks } from "./share-links.ts";

const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const USER_CODE_ROUTE = /^\/([a-z0-9]{6,24})(\/.*)?$/;
const SHARE_ROUTE = /^\/p\/([^/]+)(\/.*)?$/;
/** Files rewritten on the way out of a share link, so the owner's code never leaves the server. */
const TEXT_TYPES = new Set([".html", ".htm", ".css", ".js", ".mjs", ".svg", ".json", ".txt", ".xml"]);
/** Template code and fonts every page shares; a shared page may load any of them. Images must be the page's own. */
const TEMPLATE_TYPES = new Set([".css", ".js", ".mjs", ".woff", ".woff2"]);
const ICONS = new Set(["favicon.svg", "favicon-32x32.png", "apple-touch-icon.png"]);
const ASTRO_ASSET = /^_astro\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

type Encoding = "br" | "gzip";
/** Text bodies smaller than this go out as they are. */
const COMPRESS_MIN_BYTES = 1024;
/** Compressed immutable assets (`_astro/…`, keyed by file, version and share token), so each is compressed once. */
const compressedCache = new Map<string, Buffer>();
const COMPRESSED_CACHE_MAX = 256;

/** The best encoding the client accepts: brotli, then gzip, else none. Honours `;q=0`. */
export function pickEncoding(acceptEncoding: string | string[] | undefined): Encoding | undefined {
	const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : (acceptEncoding ?? "");
	const accepted = new Map<string, number>();
	for (const part of header.split(",")) {
		const [name, ...params] = part.trim().toLowerCase().split(";");
		if (!name) continue;
		const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
		accepted.set(name, q === undefined ? 1 : Number(q));
	}
	const ok = (name: string) => (accepted.get(name) ?? (accepted.has("*") ? accepted.get("*")! : 0)) > 0;
	if (ok("br")) return "br";
	if (ok("gzip")) return "gzip";
	return undefined;
}

function compress(body: Buffer, encoding: Encoding, cacheKey: string | undefined): Buffer {
	const key = cacheKey === undefined ? undefined : `${encoding}:${cacheKey}`;
	const cached = key === undefined ? undefined : compressedCache.get(key);
	if (cached) return cached;
	const out =
		encoding === "br"
			? brotliCompressSync(body, {
					params: {
						[zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
						// Cached assets are compressed once, so harder; per-request HTML stays fast.
						[zlib.BROTLI_PARAM_QUALITY]: key === undefined ? 5 : 9,
						[zlib.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
					},
				})
			: gzipSync(body, { level: key === undefined ? 6 : 9 });
	if (key !== undefined) {
		if (compressedCache.size >= COMPRESSED_CACHE_MAX) compressedCache.delete(compressedCache.keys().next().value!);
		compressedCache.set(key, out);
	}
	return out;
}

function isWithinRoot(targetReal: string, rootReal: string): boolean {
	if (targetReal === rootReal) return true;
	const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
	return targetReal.startsWith(prefix);
}

function writeText(
	res: ServerResponse,
	method: string,
	statusCode: number,
	body: string,
	extraHeaders: Record<string, string> = {},
): void {
	const buf = Buffer.from(body, "utf8");
	res.writeHead(statusCode, {
		...SECURITY_HEADERS,
		"Content-Type": "text/plain; charset=utf-8",
		"Content-Length": String(buf.byteLength),
		"Cache-Control": "no-store",
		...extraHeaders,
	});
	if (method === "HEAD") {
		res.end();
		return;
	}
	res.end(buf);
}

function resolveUserDir(pagesDir: string, userCode: string): string | undefined {
	if (!PAGES_CODE.test(userCode)) return undefined;
	let rootReal: string;
	try {
		rootReal = realpathSync(resolve(pagesDir));
	} catch {
		return undefined;
	}
	const candidate = join(rootReal, userCode);
	let stat;
	try {
		stat = statSync(candidate);
	} catch {
		return undefined;
	}
	if (!stat.isDirectory()) return undefined;
	let userReal: string;
	try {
		userReal = realpathSync(candidate);
	} catch {
		return undefined;
	}
	if (!isWithinRoot(userReal, rootReal) || userReal === rootReal) return undefined;
	return userReal;
}

/**
 * Rewrite text served under a share link: the page's own address becomes `/p/<token>/`, its card `/p/<token>/og.png`,
 * and every other `/<code>/` reference moves under the token, so nothing names the owner's shelf.
 */
export function rewriteForShare(text: string, target: { code: string; slug: string }, token: string): string {
	const { code, slug } = target;
	const to = `/p/${token}`;
	return text
		.split(`/${code}/og/${slug}.png`)
		.join(`${to}/og.png`)
		.split(`/${code}/${slug}/`)
		.join(`${to}/`)
		.split(`/${code}/`)
		.join(`${to}/`)
		.split(`/${code}`)
		.join(to)
		.split(code)
		.join(token);
}

/** A "Copy share link" placeholder the templates render: `<a … data-share-copy="<slug>" … href="#share-link" … hidden>`. */
const SHARE_COPY_TAG = /<a\b[^>]*\bdata-share-copy="([a-z0-9][a-z0-9-]{0,62})"[^>]*>/g;
const SHARE_COPY_ELEMENT = /<a\b[^>]*\bdata-share-copy="[^"]*"[^>]*>[\s\S]*?<\/a>/g;
/** The shelf's map of slug → share link, which the shelf script reads when it re-renders rows. */
const SHARE_LINKS_MAP = /(<script\b[^>]*\bdata-share-links\b[^>]*>)[\s\S]*?(<\/script>)/g;

/**
 * Owner pages (the shelf and each report) offer "Copy share link": every placeholder becomes a plain link to that
 * page's `/p/<token>/` (minting a token the first time, like publishing does), so it works without JS too, and the
 * shelf's JSON map gets the same links. Only published pages get one; the rest stay hidden.
 */
export function ownerHtml(html: string, code: string, links: ShareLinks): string {
	if (!html.includes("data-share-")) return html;
	const urls: Record<string, string> = {};
	const urlFor = (slug: string): string | undefined => {
		if (!(slug in urls) && links.isPublished(code, slug)) urls[slug] = `/p/${links.tokenFor(code, slug)}/`;
		return urls[slug];
	};
	const out = html.replace(SHARE_COPY_TAG, (tag, slug: string) => {
		const url = urlFor(slug);
		if (url === undefined) return tag;
		return tag.replace(/\shref="#share-link"/, ` href="${url}"`).replace(/\shidden(?:="")?(?=[\s>])/, "");
	});
	return out.replace(SHARE_LINKS_MAP, (_, open: string, close: string) => `${open}${JSON.stringify(urls).replace(/</g, "\\u003c")}${close}`);
}

/**
 * The shared view of a page: rewritten like any text, marked `data-grug-shared`, and with the owner's navigation
 * (links the layouts mark `data-owner-nav`) defused. "All pages" links lose their href and hide; the header mark
 * stays but stops being a link. The page's own script puts them back for the owner (see BaseLayout.astro).
 */
export function shareHtml(html: string, target: { code: string; slug: string }, token: string): string {
	return rewriteForShare(html.replace(SHARE_COPY_ELEMENT, "").replace(SHARE_LINKS_MAP, "$1{}$2"), target, token)
		.replace(/<html\b/i, "<html data-grug-shared")
		.replace(/<a\b[^>]*\bdata-owner-nav\b[^>]*>/gi, (tag) => {
			const withoutHref = tag.replace(/\s+href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
			const isHome = /\bdata-owner-nav\s*=\s*["']?home\b/i.test(tag);
			return isHome || /\shidden\b/i.test(withoutHref) ? withoutHref : withoutHref.replace(/^<a\b/i, "<a hidden");
		});
}

/** Asset paths (relative to the share prefix) that a shared page's HTML names. */
function referencedAssets(html: string, token: string): Set<string> {
	const found = new Set<string>();
	for (const match of html.matchAll(new RegExp(`/p/${token}/([A-Za-z0-9._\\-/]+)`, "g"))) found.add(match[1]!);
	return found;
}

/**
 * Send a text body, compressed (brotli or gzip) when the client accepts it. This runs after any share rewrite, so
 * what is compressed is exactly what the client gets. `cacheKey` (immutable assets only) keeps the compressed copy.
 */
function sendBody(
	req: IncomingMessage,
	res: ServerResponse,
	method: string,
	body: Buffer,
	contentType: string,
	cacheControl: string,
	cacheKey?: string,
): void {
	const encoding = body.byteLength >= COMPRESS_MIN_BYTES ? pickEncoding(req.headers["accept-encoding"]) : undefined;
	const out = encoding === undefined ? body : compress(body, encoding, cacheKey);
	res.writeHead(200, {
		...SECURITY_HEADERS,
		"Content-Type": contentType,
		"Content-Length": String(out.byteLength),
		"Cache-Control": cacheControl,
		Vary: "Accept-Encoding",
		...(encoding === undefined ? {} : { "Content-Encoding": encoding }),
	});
	if (method === "HEAD") {
		res.end();
		return;
	}
	res.end(out);
}

/**
 * `/p/<token>/` serves one page and only the files it needs: template CSS/JS/fonts, its own images, its card, and the
 * icons. Everything else under a token, and any token that isn't live, is a 404.
 */
function serveShared(
	req: IncomingMessage,
	res: ServerResponse,
	method: string,
	pagesDir: string,
	links: ShareLinks,
	token: string,
	rest: string | undefined,
): void {
	const target = links.lookup(token);
	const userDir = target === undefined ? undefined : resolveUserDir(pagesDir, target.code);
	if (target === undefined || userDir === undefined) {
		writeText(res, method, 404, "Not Found\n");
		return;
	}
	const page = resolveSafeFile(userDir, `/${target.slug}/`, `/${target.slug}/`);
	if (page.status !== "file") {
		writeText(res, method, 404, "Not Found\n");
		return;
	}
	if (rest === undefined) {
		res.writeHead(308, { ...SECURITY_HEADERS, Location: `/p/${token}/`, "Cache-Control": "no-store" });
		res.end();
		return;
	}
	let html: string;
	try {
		html = shareHtml(readFileSync(page.filePath, "utf8"), target, token);
	} catch {
		writeText(res, method, 404, "Not Found\n");
		return;
	}
	if (rest === "/") {
		sendBody(req, res, method, Buffer.from(html, "utf8"), "text/html; charset=utf-8", "no-cache");
		return;
	}

	const asset = rest.slice(1);
	let relPath: string | undefined;
	if (asset === "og.png") relPath = `og/${target.slug}.png`;
	else if (ICONS.has(asset)) relPath = asset;
	else if (ASTRO_ASSET.test(asset) && (TEMPLATE_TYPES.has(extname(asset).toLowerCase()) || referencedAssets(html, token).has(asset))) {
		relPath = asset;
	}
	const file = relPath === undefined ? undefined : resolveSafeFile(userDir, `/${relPath}`, `/${relPath}`);
	if (file?.status !== "file") {
		writeText(res, method, 404, "Not Found\n");
		return;
	}
	const cacheControl = file.isImmutable ? "public, max-age=31536000, immutable" : "no-cache";
	const contentType = mimeTypeFor(file.filePath);
	if (TEXT_TYPES.has(extname(file.filePath).toLowerCase())) {
		let text: string;
		try {
			text = readFileSync(file.filePath, "utf8");
		} catch {
			writeText(res, method, 404, "Not Found\n");
			return;
		}
		const cacheKey = file.isImmutable ? `${file.filePath}:${file.stat.mtimeMs}:${file.stat.size}:${token}` : undefined;
		sendBody(req, res, method, Buffer.from(rewriteForShare(text, target, token), "utf8"), contentType, cacheControl, cacheKey);
		return;
	}
	res.writeHead(200, {
		...SECURITY_HEADERS,
		"Content-Type": contentType,
		"Content-Length": String(file.stat.size),
		"Cache-Control": cacheControl,
	});
	if (method === "HEAD") {
		res.end();
		return;
	}
	const stream = createReadStream(file.filePath);
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}

/**
 * Create the static-only HTTP handler rooted at `pagesDir` (`<pagesDir>/<userCode>/...`).
 * Unknown routes, root `/`, and non-existent `<userCode>` paths all return `404` with security headers.
 */
export function createPagesHandler(
	pagesDir: string,
	links = new ShareLinks(pagesDir),
): (req: IncomingMessage, res: ServerResponse) => void {
	return function handlePagesRequest(req: IncomingMessage, res: ServerResponse): void {
		const method = req.method ?? "GET";
		if (method !== "GET" && method !== "HEAD") {
			writeText(res, method, 405, "Method Not Allowed\n", { Allow: "GET, HEAD" });
			return;
		}

		let pathname: string;
		try {
			pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		} catch {
			writeText(res, method, 400, "Bad Request\n");
			return;
		}

		if (pathname === "/robots.txt") {
			writeText(res, method, 200, ROBOTS_TXT, { "Cache-Control": "no-cache" });
			return;
		}

		if (pathname === "/") {
			writeText(res, method, 404, "Not Found\n");
			return;
		}

		const share = SHARE_ROUTE.exec(pathname);
		if (share) {
			serveShared(req, res, method, pagesDir, links, share[1]!, share[2]);
			return;
		}

		const match = USER_CODE_ROUTE.exec(pathname);
		if (!match) {
			writeText(res, method, 404, "Not Found\n");
			return;
		}

		const userCode = match[1]!;
		const rest = match[2];
		const userDir = resolveUserDir(pagesDir, userCode);
		if (userDir === undefined) {
			writeText(res, method, 404, "Not Found\n");
			return;
		}

		if (rest === undefined) {
			res.writeHead(308, {
				...SECURITY_HEADERS,
				Location: `/${userCode}/`,
				"Cache-Control": "no-store",
			});
			res.end();
			return;
		}

		if (rest === "/home" || rest === "/home/") {
			res.writeHead(302, {
				...SECURITY_HEADERS,
				Location: `/${userCode}/`,
				"Cache-Control": "no-store",
			});
			res.end();
			return;
		}

		// Owner text files go out compressed. Owner HTML also carries the "Copy share link" links, filled in fresh on
		// every request (a rotated token shows at once). Images, fonts, redirects and 404s are the static handler's.
		const file = resolveSafeFile(userDir, rest, pathname);
		if (file.status === "file" && TEXT_TYPES.has(extname(file.filePath).toLowerCase())) {
			let text: string | undefined;
			try {
				text = readFileSync(file.filePath, "utf8");
			} catch {}
			if (text !== undefined) {
				const isHtml = /\.html?$/i.test(file.filePath);
				const body = isHtml ? ownerHtml(text, userCode, links) : text;
				const cacheControl = file.isImmutable ? "public, max-age=31536000, immutable" : "no-cache";
				const cacheKey = file.isImmutable ? `${file.filePath}:${file.stat.mtimeMs}:${file.stat.size}` : undefined;
				sendBody(req, res, method, Buffer.from(body, "utf8"), mimeTypeFor(file.filePath), cacheControl, cacheKey);
				return;
			}
		}

		const handler = createStaticHandler({ rootDir: userDir, basePath: `/${userCode}` });
		handler(req, res);
	};
}

export type PagesServerHandle = {
	server: Server;
	port: number;
	/** Share links minted at startup for pages that had none. */
	backfilled: number;
	stop(): Promise<void>;
};

/** Start the dedicated static-only pages server strictly bound to `127.0.0.1:<port>`. */
export async function startPagesServer(options: {
	pagesDir: string;
	port: number;
	host?: string;
}): Promise<PagesServerHandle> {
	const host = options.host ?? "127.0.0.1";
	mkdirSync(options.pagesDir, { recursive: true });
	const links = new ShareLinks(options.pagesDir);
	const backfilled = links.backfill();
	const server = createServer(createPagesHandler(options.pagesDir, links));

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(options.port, host, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});

	const addr = server.address();
	const boundPort = typeof addr === "object" && addr !== null ? addr.port : options.port;

	return {
		server,
		port: boundPort,
		backfilled,
		stop: () =>
			new Promise<void>((resolveClose) => {
				server.close(() => resolveClose());
				server.closeIdleConnections?.();
			}),
	};
}
