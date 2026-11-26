import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import { pickEncoding, shareHtml, startPagesServer } from "./pages-server.ts";
import { newShareToken, SHARE_TOKEN, ShareLinks, shareUrl } from "./share-links.ts";

const CODE = "own3r4bc";
const OTHER_CODE = "oth3r9yz";

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-share-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A built page the way BaseLayout/ReportLayout render it, owner links marked. */
function pageHtml(code: string, slug: string, extra = ""): string {
	return `<!doctype html><html lang="en" class="antialiased"><head>
<link rel="icon" href="/${code}/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/${code}/apple-touch-icon.png" sizes="180x180">
<link rel="canonical" href="https://grug.h14h.com/${code}/${slug}/">
<meta property="og:url" content="https://grug.h14h.com/${code}/${slug}/">
<meta property="og:image" content="https://grug.h14h.com/${code}/og/${slug}.png">
<meta name="twitter:image" content="https://grug.h14h.com/${code}/og/${slug}.png">
<link rel="stylesheet" href="/${code}/_astro/BaseLayout.abc123.css">
<link rel="preload" as="font" type="font/woff2" href="/${code}/_astro/geist.def456.woff2" crossorigin>
</head><body id="top">
<header><a href="/${code}/" data-owner-nav="home" aria-label="Homepage" class="inline-flex">grug pages</a>
<nav><a href="/${code}/" data-owner-nav="all" class="px-1 py-2">All pages</a><button id="theme-toggle">theme</button></nav></header>
<main><h1>${slug}</h1>
<picture><source srcset="/${code}/_astro/photo.h1_a.avif 640w, /${code}/_astro/photo.h1_b.avif 1280w" type="image/avif"><img src="/${code}/_astro/photo.h1_c.jpg" alt="x"></picture>
<astro-island component-url="/${code}/_astro/Tabs.x1.js" renderer-url="/${code}/_astro/client.x2.js" props="{&quot;base&quot;:[0,&quot;/${code}&quot;]}"></astro-island>
${extra}
<footer><a href="/${code}/" data-owner-nav="all" class="py-1">&larr; All pages</a><a href="#top" class="ml-auto py-1">Back to top</a></footer>
</main></body></html>`;
}

function buildSite(root: string, code: string, slugs: string[]): void {
	const site = join(root, code);
	mkdirSync(join(site, "_astro"), { recursive: true });
	mkdirSync(join(site, "og"), { recursive: true });
	mkdirSync(join(site, "home"), { recursive: true });
	writeFileSync(join(site, "index.html"), `<!doctype html><html><body>Shelf of ${code}: ${slugs.map((s) => `<a href="/${code}/${s}/">${s}</a>`).join("")}</body></html>`);
	writeFileSync(join(site, "home", "index.html"), `<meta http-equiv="refresh" content="0; url=/${code}/">`);
	writeFileSync(join(site, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
	writeFileSync(join(site, "apple-touch-icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(site, "_astro", "BaseLayout.abc123.css"), `@font-face{src:url(/${code}/_astro/geist.def456.woff2)}body{color:red}`);
	writeFileSync(join(site, "_astro", "geist.def456.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
	writeFileSync(join(site, "_astro", "Tabs.x1.js"), `import{a}from"./client.x2.js";export default a;`);
	writeFileSync(join(site, "_astro", "client.x2.js"), `export const a=1;const base="/${code}";`);
	writeFileSync(join(site, "_astro", "photo.h1_a.avif"), Buffer.from([1]));
	writeFileSync(join(site, "_astro", "photo.h1_b.avif"), Buffer.from([2]));
	writeFileSync(join(site, "_astro", "photo.h1_c.jpg"), Buffer.from([3]));
	writeFileSync(join(site, "_astro", "other-page.zz_q.jpg"), Buffer.from([4]));
	for (const slug of slugs) {
		mkdirSync(join(site, slug), { recursive: true });
		writeFileSync(join(site, slug, "index.html"), pageHtml(code, slug, slug === "sox" ? `<a href="/${code}/glenwood/">see Glenwood</a>` : ""));
		writeFileSync(join(site, "og", `${slug}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, slug.length]));
	}
}

test("share tokens are 12 base62 characters, unguessable, kept across republish, and replaced on rotate", () => {
	const tokens = new Set(Array.from({ length: 2000 }, () => newShareToken()));
	assert.equal(tokens.size, 2000);
	for (const token of tokens) assert.match(token, SHARE_TOKEN);
	// All 62 characters show up, so no bias toward a slice of the alphabet
	assert.equal(new Set([...tokens].join("")).size, 62);

	const root = join(dir, "store");
	buildSite(root, CODE, ["sox", "glenwood"]);
	buildSite(root, OTHER_CODE, ["mask"]);
	const links = new ShareLinks(root);
	assert.equal(links.backfill(), 3);
	assert.equal(links.backfill(), 0);
	assert.deepEqual(links.slugs(CODE), ["glenwood", "sox"]);

	const sox = links.get(CODE, "sox")!;
	assert.match(sox, SHARE_TOKEN);
	assert.equal(links.tokenFor(CODE, "sox"), sox);
	// Persisted per user next to the sites, readable by a fresh instance (a restart)
	const stored = JSON.parse(readFileSync(join(root, ".share-links", `${CODE}.json`), "utf8")) as { pages: Record<string, string> };
	assert.equal(stored.pages.sox, sox);
	assert.equal(new ShareLinks(root).tokenFor(CODE, "sox"), sox);
	assert.deepEqual(new ShareLinks(root).lookup(sox), { code: CODE, slug: "sox" });
	assert.deepEqual(links.lookup(links.get(OTHER_CODE, "mask")!), { code: OTHER_CODE, slug: "mask" });

	// Republish swaps the whole site in; the token stays
	buildSite(root, CODE, ["sox", "glenwood", "amtrak"]);
	assert.equal(links.backfill(CODE), 1);
	assert.equal(links.tokenFor(CODE, "sox"), sox);

	// Rotate: a new token, and the old one no longer resolves, even through another instance's cache
	const other = new ShareLinks(root);
	assert.deepEqual(other.lookup(sox), { code: CODE, slug: "sox" });
	const rotated = links.rotate(CODE, "sox");
	assert.notEqual(rotated, sox);
	assert.equal(other.lookup(sox), undefined);
	assert.deepEqual(other.lookup(rotated), { code: CODE, slug: "sox" });

	assert.equal(links.lookup("short"), undefined);
	assert.equal(links.lookup("../../etc/pw"), undefined);
	assert.equal(links.isPublished(CODE, "home"), false);
	assert.equal(links.isPublished(CODE, "nope"), false);
	assert.equal(shareUrl("https://grug.h14h.com/", "AbCdEfGh1234"), "https://grug.h14h.com/p/AbCdEfGh1234/");
});

test("a share link serves one page and what it needs, never the owner's code, shelf, or other pages", async () => {
	const root = join(dir, "served");
	buildSite(root, CODE, ["sox", "glenwood"]);
	buildSite(root, OTHER_CODE, ["mask"]);
	writeFileSync(join(root, "outside.txt"), "do not serve");
	symlinkSync(join(root, "outside.txt"), join(root, CODE, "_astro", "escape.css"));

	const server = await startPagesServer({ pagesDir: root, port: 0, host: "127.0.0.1" });
	assert.equal(server.backfilled, 3);
	const base = `http://127.0.0.1:${server.port}`;
	const links = new ShareLinks(root);
	const token = links.get(CODE, "sox")!;
	const prefix = `/p/${token}/`;
	const get = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init });

	try {
		// The page
		const page = await get(prefix);
		assert.equal(page.status, 200);
		assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(page.headers.get("cache-control"), "no-cache");
		assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
		assert.equal(page.headers.get("referrer-policy"), "no-referrer");
		assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self' 'unsafe-inline'/);
		const html = await page.text();
		assert.match(html, /<h1>sox<\/h1>/);
		assert.match(html, /<html data-grug-shared /);
		assert.match(html, new RegExp(`<link rel="canonical" href="https://grug.h14h.com/p/${token}/">`));
		assert.match(html, new RegExp(`<meta property="og:url" content="https://grug.h14h.com/p/${token}/">`));
		assert.match(html, new RegExp(`<meta property="og:image" content="https://grug.h14h.com/p/${token}/og.png">`));
		// Owner nav: "All pages" hidden and unlinked, header mark kept but unlinked
		assert.match(html, /<a hidden data-owner-nav="all" class="px-1 py-2">All pages<\/a>/);
		assert.match(html, /<a hidden data-owner-nav="all" class="py-1">&larr; All pages<\/a>/);
		assert.match(html, /<a data-owner-nav="home" aria-label="Homepage" class="inline-flex">grug pages<\/a>/);
		// No link on the page leads to the shelf (which is the page itself under the token)
		assert.doesNotMatch(html, new RegExp(`<a [^>]*href="(https://grug\\.h14h\\.com)?/p/${token}/"`));

		// HEAD and the bare token
		assert.equal((await get(prefix, { method: "HEAD" })).status, 200);
		const bare = await get(`/p/${token}`);
		assert.equal(bare.status, 308);
		assert.equal(bare.headers.get("location"), prefix);

		// Every asset the page names loads, and nothing served under the token names the owner's code
		const named = [...html.matchAll(new RegExp(`/p/${token}/([A-Za-z0-9._\\-/]+)`, "g"))].map((m) => m[1]!);
		const assets = new Set(named.filter((path) => !path.endsWith("/")));
		assert.ok(assets.has("og.png") && assets.has("_astro/BaseLayout.abc123.css") && assets.has("_astro/photo.h1_b.avif"));
		const bodies = [html];
		for (const asset of assets) {
			const res = await get(`${prefix}${asset}`);
			assert.equal(res.status, 200, `expected 200 for ${asset}`);
			assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
			bodies.push(Buffer.from(await res.arrayBuffer()).toString("latin1"));
		}
		const css = await get(`${prefix}_astro/BaseLayout.abc123.css`);
		assert.equal(css.headers.get("cache-control"), "public, max-age=31536000, immutable");
		assert.equal(await css.text(), `@font-face{src:url(/p/${token}/_astro/geist.def456.woff2)}body{color:red}`);
		// Chunks a script imports load too
		const chunk = await get(`${prefix}_astro/client.x2.js`);
		assert.equal(chunk.status, 200);
		bodies.push(await chunk.text());
		for (const body of bodies) {
			assert.ok(!body.includes(CODE), `owner code leaked in a shared response: ${body.slice(0, 200)}`);
			assert.ok(!body.includes(OTHER_CODE));
		}
		// The og card is the page's own
		assert.deepEqual([...new Uint8Array(await (await get(`${prefix}og.png`)).arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 3]);

		// Nothing else under the token: shelf, other pages, other images, dotfiles, traversal, symlinks
		for (const path of [
			`${prefix}index.html`,
			`${prefix}sox/`,
			`${prefix}glenwood/`,
			`${prefix}glenwood/index.html`,
			`${prefix}home/`,
			`${prefix}og/sox.png`,
			`${prefix}og/glenwood.png`,
			`${prefix}og/index.png`,
			`${prefix}_astro/other-page.zz_q.jpg`,
			`${prefix}_astro/escape.css`,
			`${prefix}_astro/`,
			`${prefix}_astro`,
			`${prefix}.build-meta.json`,
			`${prefix}../outside.txt`,
			`${prefix}%2e%2e/outside.txt`,
			`${prefix}_astro/%2e%2e/index.html`,
			`${prefix}_astro/..%2findex.css`,
			`${prefix}_astro/.hidden.css`,
			`/p/${token}/${CODE}/`,
		]) {
			const res = await get(path);
			assert.equal(res.status, 404, `expected 404 for ${path}, got ${res.status}`);
			assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
			assert.ok(!(await res.text()).includes(CODE));
		}

		// Unknown, malformed, and other-shape tokens
		const flipped = [...token].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
		const wrong = ["/p/", "/p", "/p/AAAAAAAAAAAA/", "/p/short/", `/p/${token}x/`, `/p/${CODE}/`];
		if (flipped !== token) wrong.push(`/p/${flipped}/`);
		for (const path of wrong) {
			const res = await get(path);
			assert.equal(res.status, 404, `expected 404 for ${path}, got ${res.status}`);
		}
		assert.equal((await get(prefix, { method: "POST" })).status, 405);

		// The link to another page in the body is defused (points under the token and 404s)
		assert.match(html, new RegExp(`href="/p/${token}/glenwood/">see Glenwood`));

		// Rotate: the old token 404s at once on the running server; the new one serves
		const fresh = links.rotate(CODE, "sox");
		assert.equal((await get(prefix)).status, 404);
		assert.equal((await get(`${prefix}og.png`)).status, 404);
		assert.equal((await get(`/p/${fresh}/`)).status, 200);

		// A page taken down stops its share link
		const glenwood = links.get(CODE, "glenwood")!;
		assert.equal((await get(`/p/${glenwood}/`)).status, 200);
		await rm(join(root, CODE, "glenwood"), { recursive: true });
		assert.equal((await get(`/p/${glenwood}/`)).status, 404);

		// Owner URLs still work
		assert.equal((await get(`/${CODE}/`)).status, 200);
		assert.equal((await get(`/${CODE}/sox/`)).status, 200);
		assert.match(await (await get(`/${CODE}/sox/`)).text(), new RegExp(`href="/${CODE}/" data-owner-nav="all"`));
	} finally {
		const stopped = server.stop();
		server.server.closeAllConnections();
		await stopped;
	}
});

test("shareHtml leaves pages without owner markers safe and unmarked links alone", () => {
	const html = `<html><body><a href="/${CODE}/">old All pages</a><a href="https://example.com/">src</a> ${CODE}</body></html>`;
	const out = shareHtml(html, { code: CODE, slug: "sox" }, "AbCdEfGh1234");
	assert.ok(!out.includes(CODE));
	assert.match(out, /<a href="\/p\/AbCdEfGh1234\/">old All pages<\/a>/);
	assert.match(out, /<a href="https:\/\/example.com\/">src<\/a>/);
});

test("owner pages offer each page's share link (minted on demand, fresh after rotation); share pages never do", async () => {
	const root = join(dir, "copy-link");
	const code = "c0py5har";
	const site = join(root, code);
	const copyLink = (slug: string, svelte = false) =>
		`<a href="#share-link" ${svelte ? 'hidden=""' : "hidden"} data-share-copy="${slug}" class="share-copy inline-flex"><svg aria-hidden="true"></svg><span>Copy share link</span></a>`;
	mkdirSync(join(site, "fjords"), { recursive: true });
	writeFileSync(
		join(site, "index.html"),
		`<!doctype html><html><body><script type="application/json" data-share-links>{}</script><ul>` +
			`<li><a href="/${code}/fjords/">Fjords</a>${copyLink("fjords", true)}</li>` +
			`<li><a href="/${code}/draft/">Draft</a>${copyLink("draft", true)}</li></ul></body></html>`,
	);
	writeFileSync(join(site, "fjords", "index.html"), pageHtml(code, "fjords", copyLink("fjords")));
	const links = new ShareLinks(root);
	const server = await startPagesServer({ pagesDir: root, port: 0, host: "127.0.0.1" });
	const base = `http://127.0.0.1:${server.port}`;
	try {
		// A page published after startup has no token yet: the owner page mints it, like publishing does
		mkdirSync(join(site, "late"), { recursive: true });
		writeFileSync(join(site, "late", "index.html"), pageHtml(code, "late", copyLink("late")));
		assert.equal(links.get(code, "late"), undefined);
		const late = await (await fetch(`${base}/${code}/late/`)).text();
		const lateToken = links.get(code, "late");
		assert.ok(lateToken && SHARE_TOKEN.test(lateToken));
		assert.ok(late.includes(`<a href="/p/${lateToken}/" data-share-copy="late" class="share-copy inline-flex">`), "a plain, visible link to the share address");

		// The report page: its own share link, visible
		const res = await fetch(`${base}/${code}/fjords/`);
		assert.equal(res.headers.get("cache-control"), "no-cache");
		assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
		const page = await res.text();
		const token = links.get(code, "fjords")!;
		assert.ok(page.includes(`<a href="/p/${token}/" data-share-copy="fjords"`));
		assert.doesNotMatch(page, /data-share-copy="fjords"[^>]*\shidden/);

		// The shelf: each published row gets its link, the JSON map matches, an unpublished slug stays hidden
		const shelf = await (await fetch(`${base}/${code}/`)).text();
		assert.ok(shelf.includes(`<a href="/p/${token}/" data-share-copy="fjords"`));
		assert.ok(shelf.includes(`<a href="#share-link" hidden="" data-share-copy="draft"`));
		const map = JSON.parse(/data-share-links>([^<]*)<\/script>/.exec(shelf)![1]!) as Record<string, string>;
		assert.deepEqual(map, { fjords: `/p/${token}/` });

		// Rotating the token shows the new link at once; the old one is dead
		const rotated = links.rotate(code, "fjords");
		const after = await (await fetch(`${base}/${code}/fjords/`)).text();
		assert.ok(after.includes(`<a href="/p/${rotated}/" data-share-copy="fjords"`));
		assert.ok(!after.includes(token));
		assert.equal((await fetch(`${base}/p/${token}/`)).status, 404);

		// The share page carries no copy link, no shelf map, and still no owner code
		const shared = await (await fetch(`${base}/p/${rotated}/`)).text();
		assert.doesNotMatch(shared, /data-share-copy|Copy share link/);
		assert.ok(!shared.includes(code));
		assert.equal(shareHtml(`<p>x</p>${copyLink("fjords")}<script type="application/json" data-share-links>{"a":"/p/x/"}</script>`, { code, slug: "fjords" }, rotated), `<p>x</p><script type="application/json" data-share-links>{}</script>`);
	} finally {
		await server.stop();
	}
});

test("templates render the copy-link placeholders and the copy script (clipboard, legacy copy, field)", () => {
	const read = (path: string) => readFileSync(new URL(`../sites/grug-pages/${path}`, import.meta.url), "utf8");
	const report = read("src/layouts/ReportLayout.astro");
	const shelf = read("src/pages/index.astro");
	const rows = read("src/components/PageIndex.svelte");
	const base = read("src/layouts/BaseLayout.astro");
	assert.match(report, /href="#share-link"\n\s*hidden\n\s*data-share-copy=\{slug\}/);
	assert.match(report, /pointer-coarse:min-h-12/);
	// A stable name while it shows "Copied" (the visible label is hidden from assistive tech)
	assert.match(report, /data-share-copy=\{slug\}\n\s*aria-label="Copy share link"/);
	assert.match(report, /<span class="share-copy-label" aria-hidden="true">/);
	assert.match(shelf, /<script type="application\/json" data-share-links is:inline set:html=\{"\{\}"\} \/>/);
	assert.match(rows, /href=\{shareUrls\[page\.slug\] \?\? "#share-link"\}\n\s*hidden=\{!shareUrls\[page\.slug\]\}/);
	// Shelf rows say what the button does, next to the tags (not squeezing the title)
	assert.match(rows, /<span class="share-copy-idle">Copy link<\/span>/);
	assert.doesNotMatch(rows, /<li class="flex/);
	// Its whole 48px touch target is its own: no negative margin reaching under the next row
	assert.doesNotMatch(rows, /pointer-coarse:-my-/);
	// The tags beside it shrink and wrap, so a long tag never widens the page
	assert.match(rows, /<p class="min-w-0 text-base\/6 \[overflow-wrap:anywhere\]/);
	assert.match(rows, /aria-label=\{`Copy share link for \$\{page\.title\}`\}/);
	assert.match(rows, /pointer-coarse:min-h-12/);
	assert.match(base, /navigator\.clipboard\.writeText\(url\)\.then\(copied, \(\) => \{/);
	assert.match(base, /document\.execCommand\("copy"\)/);
	assert.match(base, /input\.dataset\.shareField = "";/);
	assert.match(base, /text\.textContent = "Copy this link:";/);
	assert.match(base, /field\.setSelectionRange\(0, url\.length\);/);
	const css = read("src/styles/global.css");
	assert.match(css, /\.share-copy-field \{[\s\S]*?outline: 2px solid var\(--color-accent\);\n\s*outline-offset: -2px;/);
	assert.match(base, /if \(box_\.top < 0 \|\| box_\.bottom > window\.innerHeight\) box\.scrollIntoView\(\{ block: "nearest", behavior: "instant" \}\);/);
	// A successful legacy copy hands focus back to the button
	assert.match(base, /if \(before instanceof HTMLElement && before !== document\.body\) before\.focus\(\{ preventScroll: true \}\);/);
	assert.match(base, /<p id="share-copy-status" class="sr-only" aria-live="polite" aria-atomic="true"><\/p>/);
	assert.match(base, /if \(!href \|\| !href\.startsWith\("\/p\/"\)\) return;/);
});

/** A raw GET (no automatic decompression): status, headers and the bytes as sent. */
function rawGet(port: number, path: string, acceptEncoding?: string, method = "GET") {
	return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolveGet, rejectGet) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers: acceptEncoding === undefined ? {} : { "Accept-Encoding": acceptEncoding } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolveGet({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", rejectGet);
		req.end();
	});
}

test("owner and share text is compressed after the share rewrite; images, fonts and small bodies are not", async () => {
	assert.equal(pickEncoding("gzip, deflate, br"), "br");
	assert.equal(pickEncoding("gzip"), "gzip");
	assert.equal(pickEncoding("br;q=0, gzip;q=0.5"), "gzip");
	assert.equal(pickEncoding("identity"), undefined);
	assert.equal(pickEncoding(undefined), undefined);
	assert.equal(pickEncoding("*"), "br");

	const root = join(dir, "compressed");
	buildSite(root, CODE, ["sox"]);
	const pad = (n: number) => `/* ${"grug ".repeat(n)} */`;
	writeFileSync(join(root, CODE, "_astro", "BaseLayout.abc123.css"), `@font-face{src:url(/${CODE}/_astro/geist.def456.woff2)}body{color:red}${pad(400)}`);
	writeFileSync(join(root, CODE, "sox", "index.html"), pageHtml(CODE, "sox", `<p>${pad(400)}</p>`));
	const server = await startPagesServer({ pagesDir: root, port: 0, host: "127.0.0.1" });
	const token = new ShareLinks(root).get(CODE, "sox")!;
	try {
		// Share page: brotli, rewritten before compression (no owner code inside), Vary set
		const share = await rawGet(server.port, `/p/${token}/`, "gzip, br");
		assert.equal(share.status, 200);
		assert.equal(share.headers["content-encoding"], "br");
		assert.equal(share.headers.vary, "Accept-Encoding");
		assert.equal(Number(share.headers["content-length"]), share.body.byteLength);
		const shareText = brotliDecompressSync(share.body).toString("utf8");
		assert.ok(share.body.byteLength < shareText.length / 3);
		assert.match(shareText, /<html data-grug-shared /);
		assert.ok(!shareText.includes(CODE));
		// Share CSS: gzip when that's all the client takes; immutable caching kept; same bytes twice (cached copy)
		const css = await rawGet(server.port, `/p/${token}/_astro/BaseLayout.abc123.css`, "gzip");
		assert.equal(css.headers["content-encoding"], "gzip");
		assert.equal(css.headers["cache-control"], "public, max-age=31536000, immutable");
		assert.match(gunzipSync(css.body).toString("utf8"), new RegExp(`url\\(/p/${token}/_astro/geist\\.def456\\.woff2\\)`));
		assert.deepEqual((await rawGet(server.port, `/p/${token}/_astro/BaseLayout.abc123.css`, "gzip")).body, css.body);
		// Owner page and owner CSS: compressed too; security headers stay
		const owner = await rawGet(server.port, `/${CODE}/sox/`, "br");
		assert.equal(owner.headers["content-encoding"], "br");
		assert.match(String(owner.headers["content-security-policy"]), /script-src 'self'/);
		assert.match(brotliDecompressSync(owner.body).toString("utf8"), /<h1>sox<\/h1>/);
		const ownerCss = await rawGet(server.port, `/${CODE}/_astro/BaseLayout.abc123.css`, "br");
		assert.equal(ownerCss.headers["content-encoding"], "br");
		assert.equal(ownerCss.headers["cache-control"], "public, max-age=31536000, immutable");
		// HEAD reports the compressed length and sends nothing
		const head = await rawGet(server.port, `/${CODE}/sox/`, "br", "HEAD");
		assert.equal(head.headers["content-encoding"], "br");
		assert.equal(head.body.byteLength, 0);
		// No Accept-Encoding: plain. Fonts, images and small text never get an encoding
		const plain = await rawGet(server.port, `/p/${token}/`);
		assert.equal(plain.headers["content-encoding"], undefined);
		assert.match(plain.body.toString("utf8"), /<html data-grug-shared /);
		for (const path of [`/p/${token}/_astro/geist.def456.woff2`, `/${CODE}/_astro/photo.h1_b.avif`, `/${CODE}/_astro/client.x2.js`, `/${CODE}/favicon.svg`]) {
			const res = await rawGet(server.port, path, "br, gzip");
			assert.equal(res.status, 200, path);
			assert.equal(res.headers["content-encoding"], undefined, path);
		}
		// Redirects and 404s are unchanged
		assert.equal((await rawGet(server.port, `/${CODE}/sox`, "br")).status, 308);
		assert.equal((await rawGet(server.port, `/${CODE}/nope/`, "br")).status, 404);
	} finally {
		await server.stop();
	}
});

