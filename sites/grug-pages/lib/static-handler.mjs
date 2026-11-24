/**
 * Exact-parity static file handler for grug-pages.
 *
 * Pure Node.js built-ins only (zero external dependencies) so both
 * `grug-page preview` on user VMs and `pclaw`'s `src/pages-server.ts`
 * on `grug-host` serve identical CSP, security headers, MIME types,
 * and path-confinement rules.
 */
import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'none'";

export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

export const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
});

export function mimeTypeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function normalizeBasePath(basePath) {
  if (!basePath || basePath === "/") return "/";
  const trimmed = String(basePath).trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "/";
}

function isWithinRoot(targetReal, rootReal) {
  if (targetReal === rootReal) return true;
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  return targetReal.startsWith(prefix);
}

/**
 * Safely resolve a URL path relative to `rootDir`, enforcing strict path
 * confinement (rejects null bytes, `..` traversal, dotfiles, and symlinks
 * pointing outside `rootDir`).
 *
 * Returns `{ status: "file", filePath, stat, isImmutable }`
 *      or `{ status: "redirect", location }`
 *      or `{ status: "not_found" }`.
 */
export function resolveSafeFile(rootDir, rawRelativePath, originalPathname = "/") {
  let rootReal;
  try {
    rootReal = realpathSync(resolve(rootDir));
  } catch {
    return { status: "not_found" };
  }

  let decoded;
  try {
    decoded = decodeURIComponent(rawRelativePath);
  } catch {
    return { status: "not_found" };
  }

  if (decoded.includes("\0") || decoded.includes("\\")) {
    return { status: "not_found" };
  }

  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.startsWith(".")) {
      return { status: "not_found" };
    }
  }

  const candidate = resolve(rootReal, ...segments);
  if (!isWithinRoot(candidate, rootReal)) {
    return { status: "not_found" };
  }

  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    return { status: "not_found" };
  }

  let finalPath = candidate;
  let finalStat = stat;

  if (stat.isDirectory()) {
    if (!originalPathname.endsWith("/")) {
      return { status: "redirect", location: `${originalPathname}/` };
    }
    finalPath = join(candidate, "index.html");
    try {
      finalStat = statSync(finalPath);
    } catch {
      return { status: "not_found" };
    }
  }

  if (!finalStat.isFile()) {
    return { status: "not_found" };
  }

  let finalReal;
  try {
    finalReal = realpathSync(finalPath);
  } catch {
    return { status: "not_found" };
  }

  if (!isWithinRoot(finalReal, rootReal)) {
    return { status: "not_found" };
  }

  const isImmutable = segments[0] === "_astro";
  return { status: "file", filePath: finalReal, stat: finalStat, isImmutable };
}

function writeText(res, statusCode, body, extraHeaders = {}) {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(buf.byteLength),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(buf);
}

/**
 * Create an HTTP request handler serving static files from `rootDir` mounted
 * under `basePath` (e.g. `"/<userCode>"` or `"/"`).
 */
export function createStaticHandler({ rootDir, basePath = "/" }) {
  const normalizedBase = normalizeBasePath(basePath);

  return function handleRequest(req, res) {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      writeText(res, 405, "Method Not Allowed\n", { Allow: "GET, HEAD" });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      writeText(res, 400, "Bad Request\n");
      return;
    }

    let relPath;
    if (normalizedBase === "/") {
      relPath = pathname;
    } else if (pathname === normalizedBase) {
      res.writeHead(308, {
        ...SECURITY_HEADERS,
        Location: `${normalizedBase}/`,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    } else if (pathname.startsWith(`${normalizedBase}/`)) {
      relPath = pathname.slice(normalizedBase.length);
    } else {
      writeText(res, 404, "Not Found\n");
      return;
    }

    const resolved = resolveSafeFile(rootDir, relPath, pathname);
    if (resolved.status === "redirect") {
      res.writeHead(308, {
        ...SECURITY_HEADERS,
        Location: resolved.location,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    if (resolved.status !== "file") {
      writeText(res, 404, "Not Found\n");
      return;
    }

    const headers = {
      ...SECURITY_HEADERS,
      "Content-Type": mimeTypeFor(resolved.filePath),
      "Content-Length": String(resolved.stat.size),
      "Cache-Control": resolved.isImmutable
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };

    res.writeHead(200, headers);
    if (method === "HEAD") {
      res.end();
      return;
    }

    const stream = createReadStream(resolved.filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        writeText(res, 500, "Internal Server Error\n");
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  };
}
