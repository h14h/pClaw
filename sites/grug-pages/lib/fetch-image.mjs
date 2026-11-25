/**
 * Download one web image for a page, safely: http(s) only, public addresses only (checked on every connection, so
 * redirects and DNS tricks can't reach the VM's own network), a size cap and timeout, and the real file type read
 * from its bytes. SVG and anything else that isn't a plain raster image is refused.
 */
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "grug-page/1.0 (+https://grug.h14h.com)";

const IPV4_BLOCKED = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const ipv4ToInt = (ip) => ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;

/** True for loopback, private, link-local, CGNAT (tailnet), documentation, multicast, and reserved addresses. */
export function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    return IPV4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (ip === "::" || ip === "::1") return true;
    const first = parseInt(ip.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (ip.startsWith("2001:db8:") || ip.startsWith("64:ff9b:")) return true;
    return false;
  }
  return true;
}

/** The image type from its first bytes, or undefined if it isn't a JPEG, PNG, WebP, GIF, or AVIF. */
export function sniffImageType(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", mime: "image/png" };
  }
  const ascii = (start, end) => b.subarray(start, end).toString("latin1");
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return { ext: "gif", mime: "image/gif" };
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) {
    return { ext: "avif", mime: "image/avif" };
  }
  return undefined;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      if (list.length === 0) return callback(new Error(`${hostname} has no address`));
      if (!allowPrivate) {
        const blocked = list.find((entry) => isPrivateAddress(entry.address));
        if (blocked) return callback(new Error(`refusing ${hostname}: it resolves to a private address (${blocked.address})`));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function checkUrl(raw, allowPrivate) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http(s) image URLs are allowed, not ${url.protocol}`);
  if (url.username || url.password) throw new Error("image URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateAddress(host)))) {
    throw new Error(`refusing private address ${host}`);
  }
  return url;
}

function getOnce(url, { allowPrivate, maxBytes, deadline }) {
  return new Promise((resolvePromise, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Error("timed out"));
    const req = client.get(
      url,
      {
        lookup: guardedLookup(allowPrivate),
        headers: { "user-agent": USER_AGENT, accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          return resolvePromise({ redirect: new URL(res.headers.location, url).toString() });
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${status} from ${url.host}`));
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          return reject(new Error(`image is ${(declared / 1048576).toFixed(1)} MB, over the ${(maxBytes / 1048576).toFixed(0)} MB cap`));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy(new Error(`image is over the ${(maxBytes / 1048576).toFixed(0)} MB cap`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolvePromise({ bytes: Buffer.concat(chunks), contentType: String(res.headers["content-type"] ?? "") }));
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("timed out")), remaining);
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.on("close", () => clearTimeout(timer));
  });
}

/**
 * Fetch an image URL, following up to 5 redirects (each re-checked). Resolves to the bytes, their sniffed type, and
 * the final URL; rejects with a plain reason otherwise.
 */
export async function fetchImage(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate === true;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const deadline = Date.now() + (options.timeoutMs ?? IMAGE_TIMEOUT_MS);
  let url = checkUrl(rawUrl, allowPrivate);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await getOnce(url, { allowPrivate, maxBytes, deadline });
    if (result.redirect) {
      url = checkUrl(result.redirect, allowPrivate);
      continue;
    }
    const type = sniffImageType(result.bytes);
    if (!type) {
      const said = result.contentType ? ` (server said ${result.contentType.split(";")[0]})` : "";
      throw new Error(`not a JPEG, PNG, WebP, GIF, or AVIF image${said}; SVG and HTML pages are refused. Use a direct image URL.`);
    }
    return { bytes: result.bytes, type, finalUrl: url.toString() };
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}
