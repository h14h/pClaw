/**
 * Dedicated static-only HTTP server for published grug-pages.
 *
 * Reuses `sites/grug-pages/lib/static-handler.mjs` directly so production pages
 * serve the exact same CSP, security headers, MIME types, dotfile blocking, and
 * realpath confinement as `grug-page preview`.
 */
import { realpathSync, mkdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { createStaticHandler, SECURITY_HEADERS } from "../sites/grug-pages/lib/static-handler.mjs";
import { PAGES_CODE } from "./config.ts";

const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const USER_CODE_ROUTE = /^\/([a-z0-9]{6,24})(\/.*)?$/;

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
 * Create the static-only HTTP handler rooted at `pagesDir` (`<pagesDir>/<userCode>/...`).
 * Unknown routes, root `/`, and non-existent `<userCode>` paths all return `404` with security headers.
 */
export function createPagesHandler(pagesDir: string): (req: IncomingMessage, res: ServerResponse) => void {
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

		const handler = createStaticHandler({ rootDir: userDir, basePath: `/${userCode}` });
		handler(req, res);
	};
}

export type PagesServerHandle = {
	server: Server;
	port: number;
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
	const server = createServer(createPagesHandler(options.pagesDir));

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
		stop: () =>
			new Promise<void>((resolveClose) => {
				server.close(() => resolveClose());
				server.closeIdleConnections?.();
			}),
	};
}
