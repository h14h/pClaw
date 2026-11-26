import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "./agent.ts";
import { type Config, defaults, isPagesEnabled, validatePagesCode } from "./config.ts";
import { Notes } from "./extensions/notes.ts";
import { PAGE_REPLY_RULE } from "./extensions/pages.ts";
import type { WorkerOptions } from "./extensions/workers.ts";
import { MUSE, musePreamble } from "./muse.ts";
import { startPagesServer } from "./pages-server.ts";
import { SHARE_TOKEN, ShareLinks } from "./share-links.ts";
import { createPromptResolver, filterWorkerPrompt } from "./prompts.ts";
import { createSshSandbox, SandboxManager, validateStagedPages } from "./sandbox.ts";
import { UserRegistry } from "./users.ts";
import { fetchImage, isPrivateAddress, sniffImageType } from "../sites/grug-pages/lib/fetch-image.mjs";
import { HEADING_ONE_LINE_MAX, planTableHeading, splitKeepingHyphenated } from "../sites/grug-pages/lib/table-heading.mjs";

const context = BACKGROUND_CONTEXT;

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pclaw-pages-"));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<Config> = {}): Config {
	return {
		...defaults,
		provider: "faux",
		model: "faux-1",
		thinkingLevel: "off",
		timeZone: "America/Los_Angeles",
		...overrides,
	};
}

function makeFakeWorkers(subDir: string, overrides: Partial<WorkerOptions> = {}): WorkerOptions {
	const root = join(dir, subDir);
	mkdirSync(root, { recursive: true });
	const promptFile = join(root, "worker.md");
	writeFileSync(promptFile, readFileSync(new URL("./prompts/worker.md", import.meta.url), "utf8"));
	return {
		command: "pi",
		museCommand: "muse",
		provider: MUSE,
		model: "muse-wonder-full-1.0",
		piFallback: { provider: "faux", model: "faux-1" },
		thinkingLevel: "high",
		quickThinkingLevel: "medium",
		timeoutMs: 15_000,
		cwd: join(root, "work"),
		sessionDir: join(root, "worker-sessions"),
		promptFile,
		toolsFile: join(root, "worker-tools.ts"),
		cliFile: join(root, "worker-cli.ts"),
		skills: [],
		allowPages: false,
		...overrides,
	};
}

test("isPagesEnabled and pagesCode validation for local vs SSH sandboxes", () => {
	// Valid & invalid pagesCode checks
	assert.equal(validatePagesCode("abc12345"), "abc12345");
	assert.equal(validatePagesCode("a0b1c2d3e4f5g6h7i8j9k0l1"), "a0b1c2d3e4f5g6h7i8j9k0l1");
	assert.throws(() => validatePagesCode("short"));
	assert.throws(() => validatePagesCode("Uppercase123"));
	assert.throws(() => validatePagesCode("has-dash1"));
	assert.throws(() => validatePagesCode("../escape"));
	assert.throws(() => validatePagesCode("a".repeat(25)));

	// UserRegistry rejects invalid and duplicate pagesCodes
	assert.throws(
		() => new UserRegistry({ bad: { name: "Bad", pagesCode: "BAD_CODE" } }, join(dir, "u1")),
		/Invalid pagesCode/,
	);
	assert.throws(
		() =>
			new UserRegistry(
				{
					a: { name: "A", pagesCode: "samecode" },
					b: { name: "B", pagesCode: "samecode" },
				},
				join(dir, "u2"),
			),
		/Duplicate pagesCode/,
	);

	// Local sandbox: unchanged behavior
	assert.equal(isPagesEnabled({ pagesUrl: undefined, pagePublisher: undefined }, "local"), false);
	assert.equal(isPagesEnabled({ pagesUrl: "https://pinchy.ts.net/pages" }, "local"), true);
	assert.equal(isPagesEnabled({ pagePublisher: "/usr/local/bin/pub" }, "local"), true);

	// SSH sandbox: requires pagesUrl + pagesCode
	const sshCfg: Pick<Config, "pagesUrl" | "pagePublisher" | "users"> = {
		pagesUrl: "https://grug.h14h.com",
		users: {
			henry: { name: "Henry", pagesCode: "ab12cd34", sandbox: { type: "ssh", host: "grug-henry.exe.xyz" } },
			guest: { name: "Guest", sandbox: { type: "ssh", host: "grug-guest.exe.xyz" } },
		},
	};
	assert.equal(isPagesEnabled(sshCfg, "ssh"), true);
	assert.equal(isPagesEnabled(sshCfg, "ssh", sshCfg.users!.henry), true);
	assert.equal(isPagesEnabled(sshCfg, "ssh", sshCfg.users!.guest), false);
	assert.equal(isPagesEnabled({ pagesUrl: undefined, users: sshCfg.users }, "ssh"), false);
	assert.equal(isPagesEnabled({ pagesUrl: "https://grug.h14h.com", users: { guest: { name: "Guest" } } }, "ssh"), false);
});

test("pages-server routing, security headers, non-existent code 404s, and path confinement", async () => {
	const pagesRoot = join(dir, "published-pages");
	const henryCode = "hen12345";
	const henryDir = join(pagesRoot, henryCode);
	mkdirSync(join(henryDir, "nas-cases"), { recursive: true });
	mkdirSync(join(henryDir, "_astro"), { recursive: true });
	writeFileSync(join(henryDir, "index.html"), "<!doctype html><html><body>Home shelf</body></html>");
	writeFileSync(join(henryDir, "nas-cases", "index.html"), "<!doctype html><html><body>NAS Cases</body></html>");
	writeFileSync(join(henryDir, "_astro", "island.js"), "console.log('ok');");
	writeFileSync(join(henryDir, ".build-meta.json"), '{"secret":true}');
	writeFileSync(join(pagesRoot, "outside.txt"), "do not serve");
	symlinkSync(join(pagesRoot, "outside.txt"), join(henryDir, "escape.txt"));

	const server = await startPagesServer({ pagesDir: pagesRoot, port: 0, host: "127.0.0.1" });
	const base = `http://127.0.0.1:${server.port}`;

	try {
		// GET /robots.txt
		const robots = await fetch(`${base}/robots.txt`, { redirect: "manual" });
		assert.equal(robots.status, 200);
		assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
		assert.equal(robots.headers.get("x-robots-tag"), "noindex, nofollow");
		assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");

		// GET / -> 404 + noindex
		const rootRes = await fetch(`${base}/`, { redirect: "manual" });
		assert.equal(rootRes.status, 404);
		assert.equal(rootRes.headers.get("x-robots-tag"), "noindex, nofollow");
		assert.match(rootRes.headers.get("content-security-policy") ?? "", /default-src 'self'/);

		// Dashboard / API / unknown / invalid codes -> 404 (never leak existence)
		for (const path of ["/api/status", "/dashboard", "/short", "/UPPER123", "/missing9", "/missing9/home", "/missing9/home/"]) {
			const res = await fetch(`${base}${path}`, { redirect: "manual" });
			assert.equal(res.status, 404, `expected 404 for ${path}, got ${res.status}`);
			assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
		}

		// GET /<userCode> -> 308 to /<userCode>/
		const bareCode = await fetch(`${base}/${henryCode}`, { redirect: "manual" });
		assert.equal(bareCode.status, 308);
		assert.equal(bareCode.headers.get("location"), `/${henryCode}/`);
		assert.equal(bareCode.headers.get("x-robots-tag"), "noindex, nofollow");

		// GET /<userCode>/home and /<userCode>/home/ -> 302 to /<userCode>/
		for (const homePath of [`/${henryCode}/home`, `/${henryCode}/home/`]) {
			const homeRedirect = await fetch(`${base}${homePath}`, { redirect: "manual" });
			assert.equal(homeRedirect.status, 302);
			assert.equal(homeRedirect.headers.get("location"), `/${henryCode}/`);
		}

		// GET /<userCode>/ -> 200 HTML with full security headers
		const homePage = await fetch(`${base}/${henryCode}/`, { redirect: "manual" });
		assert.equal(homePage.status, 200);
		assert.equal(homePage.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(homePage.headers.get("x-robots-tag"), "noindex, nofollow");
		assert.equal(homePage.headers.get("referrer-policy"), "no-referrer");
		assert.equal(homePage.headers.get("x-content-type-options"), "nosniff");
		assert.equal(homePage.headers.get("cache-control"), "no-cache");
		assert.match(homePage.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
		assert.match(await homePage.text(), /Home shelf/);

		// GET /<userCode>/nas-cases -> 308, /<userCode>/nas-cases/ -> 200
		const slugNoSlash = await fetch(`${base}/${henryCode}/nas-cases`, { redirect: "manual" });
		assert.equal(slugNoSlash.status, 308);
		assert.equal(slugNoSlash.headers.get("location"), `/${henryCode}/nas-cases/`);
		const slugPage = await fetch(`${base}/${henryCode}/nas-cases/`, { redirect: "manual" });
		assert.equal(slugPage.status, 200);
		assert.match(await slugPage.text(), /NAS Cases/);

		// Immutable _astro asset
		const asset = await fetch(`${base}/${henryCode}/_astro/island.js`, { redirect: "manual" });
		assert.equal(asset.status, 200);
		assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
		assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

		// Dotfile, traversal, and symlink escape blocked
		for (const badPath of [
			`/${henryCode}/.build-meta.json`,
			`/${henryCode}/../outside.txt`,
			`/${henryCode}/%2e%2e/outside.txt`,
			`/${henryCode}/escape.txt`,
		]) {
			const res = await fetch(`${base}${badPath}`, { redirect: "manual" });
			assert.equal(res.status, 404, `expected 404 for ${badPath}, got ${res.status}`);
		}

		// Non-GET/HEAD -> 405
		const postRes = await fetch(`${base}/${henryCode}/`, { method: "POST", redirect: "manual" });
		assert.equal(postRes.status, 405);
		assert.equal(postRes.headers.get("allow"), "GET, HEAD");

		// HEAD works
		const headRes = await fetch(`${base}/robots.txt`, { method: "HEAD", redirect: "manual" });
		assert.equal(headRes.status, 200);
		assert.equal(await headRes.text(), "");
	} finally {
		await server.stop();
	}
});

test("validateStagedPages and createSshSandbox.syncPages validate safety, block symlinks/external assets, and swap atomically", async () => {
	// 1. Direct validateStagedPages checks (including absolute canonical + OG/Twitter metadata + favicon links)
	const goodDir = join(dir, "stage-good");
	mkdirSync(join(goodDir, "trip-plan"), { recursive: true });
	mkdirSync(join(goodDir, "og"), { recursive: true });
	writeFileSync(
		join(goodDir, "index.html"),
		[
			"<!doctype html><html><head>",
			'<link rel="icon" href="/abc12345/favicon.svg" type="image/svg+xml">',
			'<link rel="icon" href="/abc12345/favicon-32x32.png" sizes="32x32" type="image/png">',
			'<link rel="apple-touch-icon" href="/abc12345/apple-touch-icon.png" sizes="180x180">',
			'<link rel="canonical" href="https://grug.h14h.com/abc12345/">',
			'<meta property="og:type" content="website">',
			'<meta property="og:url" content="https://grug.h14h.com/abc12345/">',
			'<meta property="og:image" content="https://grug.h14h.com/abc12345/og/index.png">',
			'<meta name="twitter:card" content="summary_large_image">',
			'<meta name="twitter:image" content="https://grug.h14h.com/abc12345/og/index.png">',
			'</head><body><a href="https://example.com">link</a></body></html>',
		].join(""),
	);
	writeFileSync(
		join(goodDir, "trip-plan", "index.html"),
		[
			"<!doctype html><html><head>",
			'<link rel="canonical" href="https://grug.h14h.com/abc12345/trip-plan/">',
			'<meta property="og:type" content="article">',
			'<meta property="og:url" content="https://grug.h14h.com/abc12345/trip-plan/">',
			'<meta property="og:image" content="https://grug.h14h.com/abc12345/og/trip-plan.png">',
			'<meta name="twitter:image" content="https://grug.h14h.com/abc12345/og/trip-plan.png">',
			'</head><body><a href="https://example.com">source</a></body></html>',
		].join(""),
	);
	writeFileSync(join(goodDir, "og", "index.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(goodDir, "og", "trip-plan.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	const okStats = validateStagedPages(goodDir, "trip-plan");
	assert.equal(okStats.fileCount, 4);
	assert.ok(okStats.totalBytes > 0);

	// Missing slug index.html
	assert.throws(() => validateStagedPages(goodDir, "missing-slug"), /missing required "missing-slug\/index\.html"/);

	// Symlink rejection
	const symDir = join(dir, "stage-symlink");
	mkdirSync(join(symDir, "p1"), { recursive: true });
	writeFileSync(join(symDir, "index.html"), "<html></html>");
	writeFileSync(join(symDir, "p1", "index.html"), "<html></html>");
	symlinkSync("/etc/hosts", join(symDir, "leak"));
	assert.throws(() => validateStagedPages(symDir, "p1"), /Symlink rejected/);

	// External asset rejection (<script src="http...">, <link rel="stylesheet" href="https://...">, <img src="//...">)
	for (const [name, badHtml] of [
		["ext-script", '<html><script src="https://cdn.evil.com/x.js"></script></html>'],
		["ext-css", '<html><link rel="stylesheet" href="https://fonts.googleapis.com/css2"></html>'],
		["ext-img", '<html><img src="//evil.com/pixel.png"></html>'],
		["ext-img-http", '<html><img src="http://evil.com/pixel.png"></html>'],
	] as const) {
		const badDir = join(dir, `stage-${name}`);
		mkdirSync(join(badDir, "demo"), { recursive: true });
		writeFileSync(join(badDir, "index.html"), "<html></html>");
		writeFileSync(join(badDir, "demo", "index.html"), badHtml);
		assert.throws(() => validateStagedPages(badDir, "demo"), /external asset/);
	}

	// 2. End-to-end createSshSandbox.syncPages with a fake SSH script streaming a real tar.gz
	const fakeHome = join(dir, "fake-vm-home");
	const distDir = join(fakeHome, "site", "dist");
	mkdirSync(join(distDir, "nas-cases"), { recursive: true });
	writeFileSync(join(distDir, "index.html"), "<!doctype html><html><body>v1 home</body></html>");
	writeFileSync(join(distDir, "nas-cases", "index.html"), "<!doctype html><html><body>v1 nas</body></html>");

	const failOnceFile = join(dir, "ssh-sync-fail-once");
	writeFileSync(failOnceFile, "1");
	const fakeSsh = join(dir, "fake-ssh-sync");
	await writeFile(
		fakeSsh,
		`#!/usr/bin/env bash
set -euo pipefail
if [ -f "${failOnceFile}" ]; then
  rm -f "${failOnceFile}"
  echo "ssh: connection reset" >&2
  exit 255
fi
cmd="\${@: -1}"
HOME="${fakeHome}" bash -c "$cmd"
`,
	);
	await chmod(fakeSsh, 0o755);

	const sandbox = createSshSandbox({
		host: "grug-henry.exe.xyz",
		sshCommand: fakeSsh,
		allowPages: true,
		retryDelayMs: 10,
	});
	const targetDir = join(dir, "live-pages", "hen12345");

	// First publish (also verifies retry on SSH 255)
	const r1 = await sandbox.syncPages!(targetDir, "nas-cases");
	assert.equal(r1.fileCount, 2);
	assert.ok(r1.totalBytes > 0);
	assert.match(readFileSync(join(targetDir, "nas-cases", "index.html"), "utf8"), /v1 nas/);

	// Second publish atomically replaces targetDir
	writeFileSync(join(distDir, "nas-cases", "index.html"), "<!doctype html><html><body>v2 nas</body></html>");
	const r2 = await sandbox.syncPages!(targetDir, "nas-cases");
	assert.equal(r2.fileCount, 2);
	assert.match(readFileSync(join(targetDir, "nas-cases", "index.html"), "utf8"), /v2 nas/);

	// Bad slug rejected before SSH
	await assert.rejects(() => sandbox.syncPages!(targetDir, "../evil"), /Invalid page slug/);

	// Tarball containing symlink is rejected and leaves existing v2 intact
	const poisonDist = join(fakeHome, "site", "dist");
	symlinkSync("/etc/passwd", join(poisonDist, "bad-link"));
	await assert.rejects(() => sandbox.syncPages!(targetDir, "nas-cases"), /Symlink rejected/);
	assert.match(readFileSync(join(targetDir, "nas-cases", "index.html"), "utf8"), /v2 nas/);
	assert.equal(existsSync(join(targetDir, "bad-link")), false);
	spawnSync("rm", ["-f", join(poisonDist, "bad-link")]);
});

test("prompt gating, per-user publish_page tool registration, and Pinchy local parity", async () => {
	const rawWorkerMd = readFileSync(new URL("./prompts/worker.md", import.meta.url), "utf8");

	// Worker prompt gating: remote + allowPages gets grug-page instructions; remote without allowPages & local do NOT.
	const remoteWithPages = filterWorkerPrompt(rawWorkerMd, { remote: true, allowPages: true });
	assert.match(remoteWithPages, /grug-page/);
	assert.match(remoteWithPages, /grug-page polish <slug>/);
	assert.match(remoteWithPages, /grug-page build <slug>/);
	assert.match(remoteWithPages, /grug-page preview/);

	const remoteNoPages = filterWorkerPrompt(rawWorkerMd, { remote: true, allowPages: false });
	assert.doesNotMatch(remoteNoPages, /grug-page/);

	const localWithPages = filterWorkerPrompt(rawWorkerMd, { remote: false, allowPages: true });
	assert.doesNotMatch(localWithPages, /grug-page/);
	assert.doesNotMatch(localWithPages, /agent-browser/);

	const fakeWorkerOpts = makeFakeWorkers("preamble-check");
	const preambleRemotePages = musePreamble({
		promptFile: fakeWorkerOpts.promptFile,
		cliFile: fakeWorkerOpts.cliFile,
		skills: [],
		remote: true,
		allowPages: true,
	});
	assert.match(preambleRemotePages, /grug-page/);
	assert.match(preambleRemotePages, /read_skill` for `grug-page`/);

	const preambleRemoteNoPages = musePreamble({
		promptFile: fakeWorkerOpts.promptFile,
		cliFile: fakeWorkerOpts.cliFile,
		skills: [],
		remote: true,
		allowPages: false,
	});
	assert.doesNotMatch(preambleRemoteNoPages, /grug-page/);
	assert.doesNotMatch(preambleRemoteNoPages, /publish_page/);

	// Grug persona prompt filtering (allowPages true vs false)
	const grugResolver = createPromptResolver({ personaDir: "bots/grug" });
	const grugFrontOn = grugResolver.frontPrompt({ allowT3: false, allowPages: true, channel: "telegram" });
	assert.match(grugFrontOn, /publish_page/);
	assert.match(grugFrontOn, /tell worker build page/);
	const grugFrontOff = grugResolver.frontPrompt({ allowT3: false, allowPages: false, channel: "telegram" });
	assert.doesNotMatch(grugFrontOff, /publish_page/);
	assert.doesNotMatch(grugFrontOff, /tell worker build page/);

	const grugTgOn = grugResolver.readFormatting("telegram", { allowT3: false, allowPages: true })!;
	assert.match(grugTgOn, /publish_page/);
	const grugTgOff = grugResolver.readFormatting("telegram", { allowT3: false, allowPages: false })!;
	assert.doesNotMatch(grugTgOff, /publish_page/);

	// Pinchy default prompts remain 100% untouched
	const pinchyResolver = createPromptResolver({ profileDir: "profiles/muse-ember" });
	assert.doesNotMatch(pinchyResolver.frontPrompt({ allowT3: true, allowPages: true }), /grug-page|ultracave|publish_page/);

	// Full agent test: multi-user SSH with henry (pagesCode) vs guest (no pagesCode) vs group chat
	const fakeHome = join(dir, "agent-vm-home");
	mkdirSync(join(fakeHome, "site", "dist", "coffee-guide"), { recursive: true });
	writeFileSync(join(fakeHome, "site", "dist", "index.html"), "<!doctype html><html><body>Shelf</body></html>");
	writeFileSync(join(fakeHome, "site", "dist", "coffee-guide", "index.html"), "<!doctype html><html><body>Coffee</body></html>");
	const fakeSsh = join(dir, "fake-ssh-agent");
	await writeFile(
		fakeSsh,
		`#!/usr/bin/env bash
set -euo pipefail
cmd="\${@: -1}"
HOME="${fakeHome}" bash -c "$cmd"
`,
	);
	await chmod(fakeSsh, 0o755);

	const pagesDir = join(dir, "agent-published-pages");
	const grugHome = join(dir, "agent-grug-home");
	const grugConfig = baseConfig({
		profile: "muse-ember",
		personaDir: "bots/grug",
		allowT3: false,
		pagesUrl: "https://grug.h14h.com",
		pagesDir,
		users: {
			henry: {
				name: "Henry",
				telegram: "1001",
				pagesCode: "hen12345",
				sandbox: { type: "ssh", host: "grug-henry.exe.xyz" },
			},
			guest: {
				name: "Guest",
				telegram: "1002",
				sandbox: { type: "ssh", host: "grug-guest.exe.xyz" },
			},
		},
	});

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const seenRequests: { who: string; req: ModelContext }[] = [];
	let currentWho = "";
	faux.setResponses([
		(req) => {
			seenRequests.push({ who: currentWho, req });
			return fauxAssistantMessage(fauxToolCall("publish_page", { slug: "coffee-guide" }), {
				stopReason: "toolUse",
			});
		},
		(req) => {
			seenRequests.push({ who: currentWho, req });
			return fauxAssistantMessage("live: https://grug.h14h.com/p/token/");
		},
		(req) => {
			seenRequests.push({ who: currentWho, req });
			return fauxAssistantMessage(fauxToolCall("page_links", { slug: "coffee-guide", rotate: true }), { stopReason: "toolUse" });
		},
		(req) => {
			seenRequests.push({ who: currentWho, req });
			return fauxAssistantMessage("killed");
		},
		(req) => {
			seenRequests.push({ who: currentWho, req });
			return fauxAssistantMessage(fauxToolCall("page_links", {}), { stopReason: "toolUse" });
		},
		(req) => {
			seenRequests.push({ who: currentWho, req });
			return fauxAssistantMessage("your pages");
		},
		(req) => {
			seenRequests.push({ who: currentWho, req });
			return fauxAssistantMessage("guest reply");
		},
		(req) => {
			seenRequests.push({ who: currentWho, req });
			return fauxAssistantMessage("group reply");
		},
	]);

	const agent = await openAgent(
		await openNodeSqliteStorage(join(dir, "agent-pages.sqlite")),
		{
			config: grugConfig,
			models,
			notes: new Notes(join(grugHome, "notes.md")),
			workers: makeFakeWorkers("agent-grug-workers"),
			homeDir: grugHome,
			sshCommand: fakeSsh,
		},
		context,
	);

	try {
		// SandboxManager per-user allowPages check
		const sm = new SandboxManager({
			config: grugConfig,
			users: agent.users,
			defaultWorkDir: join(grugHome, "work"),
			defaultInboxDir: join(grugHome, "inbox"),
			defaultSessionDir: join(grugHome, "sessions"),
			sshCommand: fakeSsh,
		});
		assert.equal(sm.forAddress("telegram:dm:1001").allowPages, true);
		assert.equal(sm.forAddress("telegram:dm:1002").allowPages, false);
		assert.equal(sm.forAddress("telegram:group:-500").allowPages, false);

		// 1. Henry DM: has publish_page tool and publishes coffee-guide cleanly
		currentWho = "henry";
		const henryConv = await agent.conversationFor("telegram:dm:1001", context);
		await (await henryConv.submit({ type: "input", content: "publish coffee-guide" }, context)).wait(context);

		assert.ok(existsSync(join(pagesDir, "hen12345", "coffee-guide", "index.html")));

		const henryReq1 = seenRequests.find((r) => r.who === "henry")!.req;
		const henrySystemMsg = henryReq1.messages[0] as { sections?: Record<string, string>; toolsAdded?: { name: string }[] };
		const henrySystem = JSON.stringify(henrySystemMsg.sections ?? henrySystemMsg);
		const henryToolNames = (henrySystemMsg.toolsAdded ?? henryReq1.tools ?? []).map((t) => t.name);
		assert.ok(henryToolNames.includes("publish_page"), `expected publish_page in ${henryToolNames.join(",")}`);
		assert.match(henrySystem, /publish_page/);

		// Verify tool result JSON returned to front model contains slug, url, homeUrl, fileCount, totalBytes
		const henryReq2 = seenRequests.filter((r) => r.who === "henry")[1]!.req;
		const toolResultMsg = henryReq2.messages.find((m) => m.role === "toolResult");
		assert.ok(toolResultMsg, "expected toolResult message");
		const toolTexts = toolResultMsg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text);
		// The reply rule rides along with the result, so the model reads it right as it writes the link reply
		assert.equal(toolTexts[1], PAGE_REPLY_RULE);
		const parsed = JSON.parse(toolTexts[0]!) as {
			slug: string;
			url: string;
			homeUrl: string;
			fileCount: number;
			totalBytes: number;
		};
		assert.equal(parsed.slug, "coffee-guide");
		// The link to send is the page's private share link, which never names the owner's code
		const links = new ShareLinks(pagesDir);
		const firstToken = links.get("hen12345", "coffee-guide")!;
		assert.match(firstToken, SHARE_TOKEN);
		assert.equal(parsed.url, `https://grug.h14h.com/p/${firstToken}/`);
		assert.ok(!parsed.url.includes("hen12345"));
		assert.equal(parsed.homeUrl, "https://grug.h14h.com/hen12345/");
		assert.equal(parsed.fileCount, 2);
		assert.ok(parsed.totalBytes > 0);
		assert.ok(henryToolNames.includes("page_links"));
		assert.match(henrySystem, /`\/p\/` share link/);

		// "Kill that link": page_links rotates the token; the old one no longer resolves
		await (await henryConv.submit({ type: "input", content: "kill that link" }, context)).wait(context);
		const rotateResult = seenRequests.filter((r) => r.who === "henry")[3]!.req.messages.findLast((m) => m.role === "toolResult")!;
		const rotated = JSON.parse((rotateResult.content[0] as { text: string }).text) as { slug: string; url: string; rotated: boolean };
		const secondToken = links.get("hen12345", "coffee-guide")!;
		assert.notEqual(secondToken, firstToken);
		assert.deepEqual(rotated, { slug: "coffee-guide", url: `https://grug.h14h.com/p/${secondToken}/`, rotated: true });
		assert.equal(links.lookup(firstToken), undefined);
		assert.deepEqual(links.lookup(secondToken), { code: "hen12345", slug: "coffee-guide" });

		// "My pages": the shelf plus every page's share link
		await (await henryConv.submit({ type: "input", content: "my pages?" }, context)).wait(context);
		const listResult = seenRequests.filter((r) => r.who === "henry")[5]!.req.messages.findLast((m) => m.role === "toolResult")!;
		assert.deepEqual(JSON.parse((listResult.content[0] as { text: string }).text), {
			homeUrl: "https://grug.h14h.com/hen12345/",
			pages: [{ slug: "coffee-guide", url: `https://grug.h14h.com/p/${secondToken}/` }],
		});

		// 2. Guest DM (SSH without pagesCode): no publish_page tool, allowPages: false in system prompt
		currentWho = "guest";
		const guestConv = await agent.conversationFor("telegram:dm:1002", context);
		await (await guestConv.submit({ type: "input", content: "hi" }, context)).wait(context);
		const guestReq = seenRequests.find((r) => r.who === "guest")!.req;
		const guestSystemMsg = guestReq.messages[0] as { sections?: Record<string, string>; toolsAdded?: { name: string }[] };
		const guestSystem = JSON.stringify(guestSystemMsg.sections ?? guestSystemMsg);
		const guestToolNames = (guestSystemMsg.toolsAdded ?? guestReq.tools ?? []).map((t) => t.name);
		assert.ok(!guestToolNames.includes("publish_page"));
		assert.ok(!guestToolNames.includes("page_links"));
		assert.doesNotMatch(guestSystem, /publish_page/);

		// 3. Telegram group chat: no publish_page tool, allowPages: false
		currentWho = "group";
		const groupConv = await agent.conversationFor("telegram:group:-500", context);
		await (await groupConv.submit({ type: "input", content: "hi group" }, context)).wait(context);
		const groupReq = seenRequests.find((r) => r.who === "group")!.req;
		const groupSystemMsg = groupReq.messages[0] as { sections?: Record<string, string>; toolsAdded?: { name: string }[] };
		const groupSystem = JSON.stringify(groupSystemMsg.sections ?? groupSystemMsg);
		const groupToolNames = (groupSystemMsg.toolsAdded ?? groupReq.tools ?? []).map((t) => t.name);
		assert.ok(!groupToolNames.includes("publish_page"));
		assert.ok(!groupToolNames.includes("page_links"));
		assert.doesNotMatch(groupSystem, /publish_page|page_links/);
		// The group still hears never to post anyone's shelf there
		assert.match(groupSystem, /Never post anyone's all-pages link in group chat/);
	} finally {
		await agent.harness.close(context);
		agent.searchIndex.close();
	}

	// 4. Local/Pinchy single-owner config: front agent does NOT get publish_page tool (local workers keep existing flow)
	const pinchyFaux = fauxProvider();
	const pinchyModels = createModels();
	pinchyModels.setProvider(pinchyFaux.provider);
	const pinchyReqs: ModelContext[] = [];
	pinchyFaux.setResponses([
		(req) => {
			pinchyReqs.push(req);
			return fauxAssistantMessage("pinchy ok");
		},
	]);
	const pinchyHome = join(dir, "agent-pinchy-home");
	const pinchyAgent = await openAgent(
		await openNodeSqliteStorage(join(dir, "agent-pinchy.sqlite")),
		{
			config: baseConfig({
				profile: "muse-ember",
				pagesUrl: "https://pinchy.tailnet/pages",
			}),
			models: pinchyModels,
			notes: new Notes(join(pinchyHome, "notes.md")),
			workers: makeFakeWorkers("agent-pinchy-workers", { allowPages: true }),
			homeDir: pinchyHome,
		},
		context,
	);
	try {
		const conv = await pinchyAgent.conversationFor("discord:dm:1", context);
		await (await conv.submit({ type: "input", content: "hi" }, context)).wait(context);
		assert.equal(pinchyReqs.length, 1);
		const pinchySystemMsg = pinchyReqs[0]!.messages[0] as { sections?: Record<string, string>; toolsAdded?: { name: string }[] };
		const pinchySystem = JSON.stringify(pinchySystemMsg.sections ?? pinchySystemMsg);
		const pinchyToolNames = (pinchySystemMsg.toolsAdded ?? pinchyReqs[0]!.tools ?? []).map((t) => t.name);
		assert.ok(!pinchyToolNames.includes("publish_page"));
		assert.match(pinchySystem, /private web pages/);
	} finally {
		await pinchyAgent.harness.close(context);
		pinchyAgent.searchIndex.close();
	}
});

test("two-layer dark-mode Grug icon assets, adaptive favicon.svg, and grug-page progress-leak guard", async () => {
	const markMod = (await import(new URL("../sites/grug-pages/src/lib/grug-mark.ts", import.meta.url).href)) as {
		GRUG_MARK_FILL_PATH: string;
		GRUG_MARK_PATH: string;
		GRUG_MARK_VIEWBOX: string;
		renderGrugBadgeSvg: (options?: {
			background?: string;
			foreground?: string;
			interiorFill?: string;
			stroke?: string;
			rounded?: boolean;
		}) => string;
	};

	assert.equal(markMod.GRUG_MARK_VIEWBOX, "69 51 886 886");
	assert.ok(markMod.GRUG_MARK_FILL_PATH.startsWith("M 391 139.0 "));
	assert.ok(markMod.GRUG_MARK_FILL_PATH.endsWith("832 680.8"));

	// Light-mode PNG badges keep warm paper + charcoal ink (rounded gets subtle stroke; apple-touch-icon has none)
	const lightFaviconSvg = markMod.renderGrugBadgeSvg({ rounded: true });
	assert.match(lightFaviconSvg, /fill="#faf9f7"/);
	assert.match(lightFaviconSvg, /stroke="rgba\(28, 25, 23, 0\.12\)"/);
	assert.match(lightFaviconSvg, /fill="#1c1917"/);
	assert.ok(!lightFaviconSvg.includes(markMod.GRUG_MARK_FILL_PATH));

	const appleIconSvg = markMod.renderGrugBadgeSvg({ rounded: false });
	assert.match(appleIconSvg, /rx="0"/);
	assert.doesNotMatch(appleIconSvg, /stroke=/);
	assert.match(appleIconSvg, /fill="#faf9f7"/);
	assert.match(appleIconSvg, /fill="#1c1917"/);

	// Dark-mode two-layer badge renders lit interior fill under obsidian ink
	const darkBadgeSvg = markMod.renderGrugBadgeSvg({
		background: "#1b1d20",
		stroke: "rgba(255, 255, 255, 0.14)",
		interiorFill: "#d6d3d1",
		foreground: "#131416",
	});
	assert.match(darkBadgeSvg, /fill="#1b1d20"/);
	assert.match(darkBadgeSvg, /stroke="rgba\(255, 255, 255, 0\.14\)"/);
	assert.ok(darkBadgeSvg.includes(`fill="#d6d3d1" fill-rule="evenodd" d="${markMod.GRUG_MARK_FILL_PATH}"`));
	assert.ok(darkBadgeSvg.includes(`fill="#131416" fill-rule="evenodd" d="${markMod.GRUG_MARK_PATH}"`));
	assert.ok(darkBadgeSvg.indexOf(markMod.GRUG_MARK_FILL_PATH) < darkBadgeSvg.indexOf(markMod.GRUG_MARK_PATH));

	// GrugMark.astro renders two layers in order: interior fill then ink linework
	const grugMarkAstro = readFileSync(new URL("../sites/grug-pages/src/components/GrugMark.astro", import.meta.url), "utf8");
	assert.match(grugMarkAstro, /<path d=\{GRUG_MARK_FILL_PATH\} fill-rule="evenodd" class="fill-transparent dark:fill-\[#d6d3d1\]" \/>/);
	assert.match(grugMarkAstro, /<path d=\{GRUG_MARK_PATH\} fill-rule="evenodd" class="fill-\[#1c1917\] dark:fill-\[#131416\]" \/>/);
	assert.ok(grugMarkAstro.indexOf("GRUG_MARK_FILL_PATH") < grugMarkAstro.indexOf("d={GRUG_MARK_PATH}"));

	// Adaptive public/favicon.svg supports light & dark two-layer styling with both paths
	const faviconSvg = readFileSync(new URL("../sites/grug-pages/public/favicon.svg", import.meta.url), "utf8");
	assert.match(faviconSvg, /#faf9f7/);
	assert.match(faviconSvg, /rgba\(28, 25, 23, 0\.12\)/);
	assert.match(faviconSvg, /#1c1917/);
	assert.match(faviconSvg, /@media \(prefers-color-scheme: dark\)/);
	assert.match(faviconSvg, /#1b1d20/);
	assert.match(faviconSvg, /rgba\(255, 255, 255, 0\.14\)/);
	assert.match(faviconSvg, /#d6d3d1/);
	assert.match(faviconSvg, /#131416/);
	assert.ok(faviconSvg.includes(markMod.GRUG_MARK_FILL_PATH));
	assert.ok(faviconSvg.includes(markMod.GRUG_MARK_PATH));
	assert.ok(faviconSvg.indexOf(markMod.GRUG_MARK_FILL_PATH) < faviconSvg.indexOf(markMod.GRUG_MARK_PATH));

	// grug-page SKILL.md forbids leaking internal pipeline/QA mechanics into progress updates
	const grugPageSkill = readFileSync(new URL("../bots/grug/skills/grug-page/SKILL.md", import.meta.url), "utf8");
	assert.match(grugPageSkill, /report_progress/);
	assert.match(grugPageSkill, /desktop\/mobile\/light\/dark/);
	assert.match(grugPageSkill, /Building a comparison page for you/);
	assert.match(grugPageSkill, /One fact, one home/);
	assert.match(grugPageSkill, /400–900 words/);
	assert.match(grugPageSkill, /1,200 words/);
	assert.match(grugPageSkill, /grug-page list/);
	assert.match(grugPageSkill, /agent-browser --session "\$S" close/);
});

test("grug-page polish stages atomically on .polish-stage.mdx, protects index.mdx/.draft.mdx on timeout or error, and enforces anti-bloat prompts", async () => {
	const grugPageBin = new URL("../sites/grug-pages/bin/grug-page.mjs", import.meta.url).pathname;
	const skillsDir = new URL("../bots/grug/skills", import.meta.url).pathname;
	const grugPageSrc = readFileSync(grugPageBin, "utf8");
	assert.match(grugPageSrc, /DEFAULT_POLISH_TIMEOUT_MS\s*=\s*180_000/);

	const workDir = join(dir, "polish-work");
	const slugDir = join(workDir, "pages", "test-guide");
	mkdirSync(slugDir, { recursive: true });

	const originalDraft = [
		"---",
		'title: "Test Guide"',
		'date: "2026-11-24"',
		'summary: "Compact comparison test."',
		"---",
		"",
		'import { StatGrid, Stat } from "@components/mdx";',
		"",
		"<StatGrid columns={2}>",
		'  <Stat label="Pick" value="Plan A" note="$50/mo" />',
		"</StatGrid>",
		"",
		"## Summary",
		"",
		"Plan A costs $50/mo and is fast.",
		"",
	].join("\n");

	const indexPath = join(slugDir, "index.mdx");
	const draftBackup = join(slugDir, ".draft.mdx");
	const unslopSnapshot = join(slugDir, ".unslop.mdx");
	const stagePath = join(slugDir, ".polish-stage.mdx");
	const promptLogDir = join(dir, "polish-prompts");
	mkdirSync(promptLogDir, { recursive: true });

	// Fake muse binary driven by FAKE_MUSE_MODE env var:
	// - "ok": records each stage's prompt, rewrites .polish-stage.mdx cleanly (shrinking words)
	// - "timeout-stage2": passes stage 1, hangs on stage 2 so GRUG_POLISH_TIMEOUT_MS triggers
	// - "invalid-stage1": drops MDX import in stage 1 to trigger validation failure
	const fakeMuse = join(dir, "fake-polish-muse.mjs");
	await writeFile(
		fakeMuse,
		`#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const pfIdx = args.indexOf("--prompt-file");
const promptText = readFileSync(args[pfIdx + 1], "utf8");
const stageMatch = /automated editorial pass "([^"]+)"/.exec(promptText);
const targetMatch = /Target file: ([^\\n]+)/.exec(promptText);
const stage = stageMatch ? stageMatch[1] : "unknown";
const target = targetMatch ? targetMatch[1].trim() : "";
writeFileSync(join(process.env.PROMPT_LOG_DIR, stage + ".txt"), promptText, "utf8");

const mode = process.env.FAKE_MUSE_MODE || "ok";
if (mode === "timeout-stage2" && stage === "ultracave") {
  setTimeout(() => {}, 60_000);
} else if (mode === "invalid-stage1" && stage === "unslop") {
  writeFileSync(target, "---\\ntitle: \\"Broken\\"\\ndate: \\"2026-11-24\\"\\nsummary: \\"Missing import\\"\\n---\\n\\nNo import here.\\n", "utf8");
} else if (stage === "unslop") {
  writeFileSync(target, [
    "---",
    'title: "Test Guide"',
    'date: "2026-11-24"',
    'summary: "Compact comparison test."',
    "---",
    "",
    'import { StatGrid, Stat } from "@components/mdx";',
    "",
    "<StatGrid columns={2}>",
    '  <Stat label="Pick" value="Plan A" note="$50/mo" />',
    "</StatGrid>",
    "",
    "## Summary",
    "",
    "Plan A wins on speed.",
    "",
  ].join("\\n"), "utf8");
} else if (stage === "ultracave") {
  writeFileSync(target, [
    "---",
    'title: "Test Guide"',
    'date: "2026-11-24"',
    'summary: "Compact comparison test."',
    "---",
    "",
    'import { StatGrid, Stat } from "@components/mdx";',
    "",
    "<StatGrid columns={2}>",
    '  <Stat label="Pick" value="Plan A" note="$50/mo" />',
    "</StatGrid>",
    "",
    "## Summary",
    "",
    "Plan A wins: faster.",
    "",
  ].join("\\n"), "utf8");
}
`,
	);
	await chmod(fakeMuse, 0o755);

	const runPolish = (extraEnv: Record<string, string>) =>
		spawnSync(process.execPath, [grugPageBin, "polish", "test-guide"], {
			encoding: "utf8",
			env: {
				...process.env,
				GRUG_PAGES_WORK_DIR: workDir,
				GRUG_MUSE_BIN: fakeMuse,
				GRUG_SKILLS_DIR: skillsDir,
				PROMPT_LOG_DIR: promptLogDir,
				...extraEnv,
			},
		});

	// 1. Timeout in Stage 2 leaves index.mdx AND existing .draft.mdx untouched and removes .polish-stage.mdx
	writeFileSync(indexPath, originalDraft, "utf8");
	writeFileSync(draftBackup, "ORIGINAL-PRIOR-BACKUP\n", "utf8");
	const timeoutRes = runPolish({ FAKE_MUSE_MODE: "timeout-stage2", GRUG_POLISH_TIMEOUT_MS: "250" });
	assert.notEqual(timeoutRes.status, 0);
	assert.match(timeoutRes.stderr, /timed out/i);
	assert.equal(readFileSync(indexPath, "utf8"), originalDraft);
	assert.equal(readFileSync(draftBackup, "utf8"), "ORIGINAL-PRIOR-BACKUP\n");
	assert.equal(existsSync(stagePath), false, ".polish-stage.mdx must be cleaned up after timeout");

	// 2. Invalid MDX in Stage 1 leaves index.mdx and .draft.mdx untouched and removes .polish-stage.mdx
	const invalidRes = runPolish({ FAKE_MUSE_MODE: "invalid-stage1" });
	assert.notEqual(invalidRes.status, 0);
	assert.match(invalidRes.stderr, /MDX import dropped/);
	assert.equal(readFileSync(indexPath, "utf8"), originalDraft);
	assert.equal(readFileSync(draftBackup, "utf8"), "ORIGINAL-PRIOR-BACKUP\n");
	assert.equal(existsSync(stagePath), false, ".polish-stage.mdx must be cleaned up after validation failure");

	// 3. Successful polish preserves existing .draft.mdx, writes .unslop.mdx, atomically swaps index.mdx, and removes .polish-stage.mdx
	const okWithExistingBackup = runPolish({ FAKE_MUSE_MODE: "ok" });
	assert.equal(okWithExistingBackup.status, 0, okWithExistingBackup.stderr);
	assert.match(okWithExistingBackup.stdout, /POLISHED test-guide:/);
	assert.equal(readFileSync(draftBackup, "utf8"), "ORIGINAL-PRIOR-BACKUP\n", "existing .draft.mdx must not be overwritten");
	assert.match(readFileSync(unslopSnapshot, "utf8"), /Plan A wins on speed\./);
	assert.match(readFileSync(indexPath, "utf8"), /Plan A wins: faster\./);
	assert.equal(existsSync(stagePath), false);

	// 4. First-time polish (no .draft.mdx yet) writes .draft.mdx from original input
	await rm(draftBackup, { force: true });
	writeFileSync(indexPath, originalDraft, "utf8");
	const okFresh = runPolish({ FAKE_MUSE_MODE: "ok" });
	assert.equal(okFresh.status, 0, okFresh.stderr);
	assert.equal(readFileSync(draftBackup, "utf8"), originalDraft);

	// 5. Verify prompts targeted .polish-stage.mdx and include anti-bloat / compression overrides
	const stage1Prompt = readFileSync(join(promptLogDir, "unslop.txt"), "utf8");
	const stage2Prompt = readFileSync(join(promptLogDir, "ultracave.txt"), "utf8");
	assert.match(stage1Prompt, /Target file: .*\.polish-stage\.mdx/);
	assert.match(stage1Prompt, /NEVER expand compact bullet lists or tables into narrative paragraphs/);
	assert.match(stage1Prompt, /DELETE the repetitive prose restatement/);
	assert.match(stage1Prompt, /shrink or hold total word count, NEVER inflate it/);
	assert.match(stage2Prompt, /Target file: .*\.polish-stage\.mdx/);
	assert.match(stage2Prompt, /30-50% tighter prose/);
	assert.match(stage2Prompt, /grugbrain\.dev/);

	// 6. Verify tightened page-vs-chat, one-page-per-topic, and TL;DR-only prompt rules (and clean allowPages=false stripping)
	const grugResolver = createPromptResolver({ personaDir: "bots/grug" });
	const grugFrontOn = grugResolver.frontPrompt({ allowT3: false, allowPages: true, channel: "telegram" });
	assert.match(grugFrontOn, /Direct chat \(no page\)/);
	assert.match(grugFrontOn, /3\+ option comparison/);
	assert.match(grugFrontOn, /One page per topic/);
	assert.match(grugFrontOn, /ONLY TL;DR of 1–2 short lines \(headline verdict\/number\), then live link alone on last line/);
	const grugFrontOff = grugResolver.frontPrompt({ allowT3: false, allowPages: false, channel: "telegram" });
	assert.doesNotMatch(grugFrontOff, /One page per topic|ONLY live link|publish_page|tell worker build page/);

	const grugTgOn = grugResolver.readFormatting("telegram", { allowT3: false, allowPages: true })!;
	assert.match(grugTgOn, /ONLY TL;DR of 1–2 short lines \+ live link alone on last line/);
	assert.match(grugTgOn, /Edit existing `slug` in place/);
	const grugTgOff = grugResolver.readFormatting("telegram", { allowT3: false, allowPages: false })!;
	assert.doesNotMatch(grugTgOff, /publish_page|ONLY live clickable link|Edit existing `slug`/);

	const rawWorkerMd = readFileSync(new URL("./prompts/worker.md", import.meta.url), "utf8");
	const remoteWithPages = filterWorkerPrompt(rawWorkerMd, { remote: true, allowPages: true });
	assert.match(remoteWithPages, /Do NOT build a page for quick single-fact lookups/);
	assert.match(remoteWithPages, /One page per topic: run `grug-page list`/);
	// Page jobs report only slug + one-line TL;DR, so there is nothing long for the front model to relay
	assert.match(remoteWithPages, /Your final response is only: `Built slug: <slug>`, then `TL;DR: /);
	assert.doesNotMatch(remoteWithPages, /ultracave|caveman/i);
});

test("grug-pages Iteration 3 table polish: smart sticky entity col, content-driven sizing, reserved cue, and unique aria-labels", () => {
	const baseLayout = readFileSync(new URL("../sites/grug-pages/src/layouts/BaseLayout.astro", import.meta.url), "utf8");
	const globalCss = readFileSync(new URL("../sites/grug-pages/src/styles/global.css", import.meta.url), "utf8");
	const grugPageSkill = readFileSync(new URL("../bots/grug/skills/grug-page/SKILL.md", import.meta.url), "utf8");

	// Smart rank-column detection & entity scope="row"
	assert.match(baseLayout, /data-sticky-entity/);
	assert.match(baseLayout, /--sticky-col1-w/);
	assert.match(baseLayout, /setAttribute\("scope", "row"\)/);
	assert.match(baseLayout, /data-wide-prose/);
	assert.match(baseLayout, /— scrollable table/);

	// Content-driven sizing: mobile-only min-widths, no blanket 3-col or desktop 50rem forced widths
	assert.match(globalCss, /table\[data-wide-prose="true"\]/);
	assert.match(baseLayout, /setAttribute\("data-compact", "true"\)/);
	assert.match(globalCss, /table:not\(\[data-compact="true"\]\)\):has\(tr > :nth-child\(5\)\)/);
	assert.match(globalCss, /min-width:\s*30rem/);
	assert.match(globalCss, /min-width:\s*28rem/);
	assert.match(globalCss, /min-width:\s*34rem/);
	assert.doesNotMatch(globalCss, /min-width:\s*50rem/);
	assert.doesNotMatch(globalCss, /min-width:\s*44rem/);
	assert.doesNotMatch(globalCss, /min-width:\s*32rem/);

	// Sticky col 2 pinned next to col 1, soft 26px fade, reserved cue hidden at end without display:none
	assert.match(globalCss, /left:\s*var\(--sticky-col1-w/);
	assert.match(globalCss, /max-width:\s*8\.5rem/);
	assert.match(globalCss, /width:\s*1\.625rem/);
	assert.match(
		globalCss,
		/\.table-block\[data-scrollable="true"\]\[data-scrolled-end="true"\] > \.table-scroll-hint\s*\{[\s\S]*opacity:\s*0;[\s\S]*visibility:\s*hidden;/,
	);

	// SKILL.md forbids standalone Rank/# column 1 in future tables
	assert.match(grugPageSkill, /Never use a standalone `Rank` or `#` column as Column 1/);
});

test("grug-pages Iteration 4 tables: real row headers, unbroken header labels, seam-free sticky pair, and short-heading rule", () => {
	const baseLayout = readFileSync(new URL("../sites/grug-pages/src/layouts/BaseLayout.astro", import.meta.url), "utf8");
	const globalCss = readFileSync(new URL("../sites/grug-pages/src/styles/global.css", import.meta.url), "utf8");
	const grugPageSkill = readFileSync(new URL("../bots/grug/skills/grug-page/SKILL.md", import.meta.url), "utf8");

	// Identity cells are swapped for <th scope="row"> (attributes + children kept), so a11y trees expose `rowheader`
	assert.match(baseLayout, /const toRowHeader = \(cell\) =>/);
	assert.match(baseLayout, /document\.createElement\("th"\)/);
	assert.match(baseLayout, /th\.setAttribute\(attr\.name, attr\.value\)/);
	assert.match(baseLayout, /cell\.replaceWith\(th\)/);
	assert.match(baseLayout, /toRowHeader\(row\.children\[entityColIndex\]\)/);

	// Body row headers keep body-cell styling; header-only styling is scoped to thead
	assert.match(globalCss, /\.prose :where\(td, tbody th\)/);
	assert.match(globalCss, /\.prose :where\(tbody td, tbody th\)/);
	assert.match(globalCss, /\.prose :where\(tbody th\)[^{]*\{\s*text-align: left;\s*font-weight: inherit;/);
	assert.match(globalCss, /\.prose :where\(thead th\)[^{]*\{[^}]*hyphens: manual;/);
	assert.doesNotMatch(globalCss, /hyphens: auto/);
	assert.match(globalCss, /tr\.pick > :nth-child\(2\)/);

	// Headers never break at a hyphen; short labels stay on one line (planner covered in the Iteration 5 test)
	assert.match(baseLayout, /node\.className = "th-nowrap"/);
	assert.match(globalCss, /thead th\[data-nowrap="true"\], thead th \.th-nowrap\)[^{]*\{\s*white-space: nowrap;/);

	// Sticky col 2 uses the fractional col-1 width and fills 1px back over the boundary
	assert.doesNotMatch(baseLayout, /Math\.floor\(col1\.getBoundingClientRect\(\)\.width\)/);
	assert.doesNotMatch(baseLayout, /offsetWidth/);
	assert.match(globalCss, /td:nth-child\(2\)\):not\(\.not-prose, \.not-prose \*\)::before \{[^}]*left: -1px;[^}]*background-color: inherit;/);

	assert.match(grugPageSkill, /Keep column headings short \(1–2 words\)/);
});

test("grug-pages table heading planner stays linear on long imported headings and keeps hyphenated words whole", () => {
	const baseLayout = readFileSync(new URL("../sites/grug-pages/src/layouts/BaseLayout.astro", import.meta.url), "utf8");
	const globalCss = readFileSync(new URL("../sites/grug-pages/src/styles/global.css", import.meta.url), "utf8");
	const render = (text: string) =>
		planTableHeading(text)
			.runs.map((run) => (run.nowrap ? `[${run.text}]` : run.text))
			.join("");

	// Short headings stay on one line; mid-length ones become two whole word groups
	assert.equal(HEADING_ONE_LINE_MAX, 14);
	assert.deepEqual(planTableHeading("Rate Field"), { oneLine: true, runs: [{ text: "Rate Field", nowrap: true }] });
	assert.equal(render("First-year cost"), "[First-year] [cost]");
	assert.equal(render("B: Rate Field lots"), "[B: Rate] [Field lots]");
	assert.equal(render("Combined all-districts"), "[Combined] [all-districts]");
	assert.equal(render("Provider / plan"), "[Provider /] [plan]");

	// Long headings: bounded work, hyphenated words kept whole, CSS balances the lines
	const words = ["district", "tax", "share", "year-one", "base-case", "net", "levy", "per-unit", "value", "fund"];
	const heading = (length: number) => {
		let text = "";
		for (let i = 0; text.length < length; i++) text += `${words[i % words.length]} `;
		return text.slice(0, length).trim();
	};
	const manyHyphens = Array.from({ length: 120 }, (_, i) => `a${i}-b${i}-c${i}`).join(" ");
	for (const text of [heading(150), heading(400), manyHyphens, "x".repeat(5000), "-".repeat(5000)]) {
		const started = performance.now();
		const plan = planTableHeading(text);
		const elapsed = performance.now() - started;
		assert.ok(elapsed < 50, `planning a ${text.length}-char heading took ${elapsed.toFixed(1)}ms`);
		assert.equal(plan.oneLine, false);
		assert.equal(plan.runs.map((run) => run.text).join(""), text.replace(/\s+/g, " ").trim());
		for (const run of plan.runs) {
			if (/[^\s-]-[^\s-]/.test(run.text)) assert.equal(run.nowrap, true, `hyphenated run must stay whole: ${run.text}`);
		}
	}
	assert.equal(planTableHeading(manyHyphens).runs.filter((run) => run.nowrap).length, 120);
	assert.deepEqual(splitKeepingHyphenated("City share (ex-stadium) only"), [
		{ text: "City share ", nowrap: false },
		{ text: "(ex-stadium)", nowrap: true },
		{ text: " only", nowrap: false },
	]);

	// The page inlines this same module; no partition search remains in the layout
	assert.match(baseLayout, /import tableHeadingSource from "\.\.\/\.\.\/lib\/table-heading\.mjs\?raw";/);
	assert.match(baseLayout, /<script is:inline set:html=\{tableHeadingScript\} \/>/);
	assert.doesNotMatch(baseLayout, /balanceTokens|const solve =/);
	assert.match(globalCss, /\.prose :where\(thead th\)[^{]*\{[^}]*text-wrap: balance;/);

	// Pinned edge: crisp divider and opaque padding gutter, no translucent shadow
	assert.doesNotMatch(globalCss, /--table-sticky-shadow|right: -13px/);
});

test("grug-pages theme button has a 48px hit area without moving the header", () => {
	const baseLayout = readFileSync(new URL("../sites/grug-pages/src/layouts/BaseLayout.astro", import.meta.url), "utf8");
	const button = baseLayout.match(/<button\s+id="theme-toggle"[\s\S]*?<\/button>/)?.[0] ?? "";
	assert.ok(button, "theme toggle button present");
	// The button itself is 48×48; -m-2 keeps its layout footprint at the 32×32 visual chip
	assert.match(button, /class="group -m-2 inline-flex size-12 /);
	// Square corners on the 48×48 box so its whole area hit-tests (the visible rounding lives on the chip)
	assert.match(button, /class="group -m-2 inline-flex size-12 items-center justify-center focus-visible:outline-none"/);
	// The hover/focus chip and icon stay the same visual size
	assert.match(button, /<span\s+class="inline-flex size-8 items-center justify-center rounded-md group-hover:/);
	assert.match(button, /group-focus-visible:outline-2/);
	assert.equal((button.match(/class="size-4 shrink-0/g) ?? []).length, 2);
	assert.doesNotMatch(button, /pointer-fine:hidden/);
});

test("grug-page image fetcher: public raster images only, sniffed from bytes, capped, and never private addresses", async () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "100.101.102.103", "169.254.169.254", "172.20.0.1", "192.168.1.1", "0.0.0.0", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:127.0.0.1"]) {
		assert.equal(isPrivateAddress(ip), true, ip);
	}
	for (const ip of ["161.210.92.234", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);

	const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	assert.deepEqual(sniffImageType(png), { ext: "png", mime: "image/png" });
	assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext, "jpg");
	assert.equal(sniffImageType(Buffer.from("GIF89a....", "latin1"))?.ext, "gif");
	assert.equal(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))?.ext, "webp");
	assert.equal(sniffImageType(Buffer.from("\0\0\0\x1cftypavif", "latin1"))?.ext, "avif");
	assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), undefined);
	assert.equal(sniffImageType(Buffer.from("<!doctype html><html>")), undefined);

	// URL and address checks, before any connection
	await assert.rejects(fetchImage("file:///etc/passwd"), /only http\(s\)/);
	await assert.rejects(fetchImage("ftp://example.com/a.png"), /only http\(s\)/);
	await assert.rejects(fetchImage("http://127.0.0.1:9/a.png"), /private address/);
	await assert.rejects(fetchImage("http://[::1]:9/a.png"), /private address/);
	await assert.rejects(fetchImage("http://localhost:9/a.png"), /private address/);
	await assert.rejects(fetchImage("http://169.254.169.254/latest/meta-data"), /private address/);

	// A local server stands in for the web (allowPrivate only in tests)
	const big = Buffer.alloc(64 * 1024, 1);
	const server = createServer((req, res) => {
		if (req.url === "/ok.png") return res.writeHead(200, { "content-type": "image/png" }).end(png);
		if (req.url === "/svg") return res.writeHead(200, { "content-type": "image/svg+xml" }).end("<svg xmlns='http://www.w3.org/2000/svg'/>");
		if (req.url === "/big.jpg") return res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), big]));
		if (req.url === "/hop") return res.writeHead(302, { location: "/ok.png" }).end();
		if (req.url === "/slow") return; // never answers
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	try {
		const ok = await fetchImage(`${base}/hop`, { allowPrivate: true });
		assert.equal(ok.type.ext, "png");
		assert.equal(ok.finalUrl, `${base}/ok.png`);
		await assert.rejects(fetchImage(`${base}/svg`, { allowPrivate: true }), /SVG and HTML pages are refused/);
		await assert.rejects(fetchImage(`${base}/big.jpg`, { allowPrivate: true, maxBytes: 16 * 1024 }), /cap/);
		await assert.rejects(fetchImage(`${base}/slow`, { allowPrivate: true, timeoutMs: 300 }), /timed out/);
		await assert.rejects(fetchImage(`${base}/missing.png`, { allowPrivate: true }), /HTTP 404/);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("grug-pages Figure: portraits fit on screen, credits are 48px touch targets, slot matches gutters, paper surface opt-in", () => {
	const figure = readFileSync(new URL("../sites/grug-pages/src/components/mdx/Figure.astro", import.meta.url), "utf8");
	const cli = readFileSync(new URL("../sites/grug-pages/bin/grug-page.mjs", import.meta.url), "utf8");
	const skill = readFileSync(new URL("../bots/grug/skills/grug-page/SKILL.md", import.meta.url), "utf8");

	// Portrait height cap, left-aligned, image stays width:100%/height:auto, sizes=auto with a responsive fallback
	assert.match(figure, /--figure-ratio: \$\{r\}; width: min\(100%, calc\(min\(65svh, 34rem\) \* var\(--figure-ratio\)\)\);/);
	assert.match(figure, /block h-auto w-full/);
	assert.match(figure, /\["auto", \.\.\.fallback\]\.join\(", "\)/);
	// Slot matches the 20px / 32px gutters and the 44rem column
	assert.match(figure, /"\(min-width: 48rem\) 44rem", "\(min-width: 40rem\) calc\(100vw - 4rem\)", "calc\(100vw - 2\.5rem\)"/);

	// Credit: own row and 48px target on coarse pointers, dot hidden there, inline for fine pointers, visible focus ring
	assert.match(figure, /<span class="pointer-coarse:block">/);
	assert.match(figure, /pointer-coarse:inline-flex pointer-coarse:min-h-12 pointer-coarse:min-w-12 pointer-coarse:items-center/);
	assert.match(figure, /pointer-coarse:hidden dark:text-stone-500">·/);
	assert.match(figure, /focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/);
	assert.match(figure, /dark:focus-visible:outline-accent-dark/);

	// Fluid radius, inset outline kept, opt-in paper surface in both themes
	assert.match(figure, /rounded-\[min\(1vw,12px\)\]/);
	assert.match(figure, /outline -outline-offset-1/);
	assert.match(figure, /background === "paper" \? "bg-stone-50" : "bg-stone-100 dark:bg-stone-900"/);
	assert.match(cli, /\(alt\|caption\|credit\|href\|background\)/);
	assert.match(cli, /--background only takes "paper"/);
	assert.match(cli, /background="\$\{opts\.background\}"/);

	// The worker checks the image itself, in the CLI output and the skill
	assert.match(cli, /Check before use: open actual image\. Confirm place, season, product version, or data period\./);
	assert.match(skill, /Open actual image\. Confirm place, season, product version, or data period\. Use only if it helps reader decide\./);
	assert.match(skill, /Chart or map: put takeaway in nearby text if labels too small on phone\./);
	assert.match(skill, /Add `--background paper`/);
});

test("grug-pages Carousel: stacked without JS, one settled slide with JS, lazy slot-true images, and build warnings", async () => {
	const { buildCarousel, carouselFrame, createSettler, lintCarousels, slideSizes, CAROUSEL_MAX_SLIDES, CAROUSEL_SMALL_FILL, CAROUSEL_TOO_MANY } =
		await import("../sites/grug-pages/lib/carousel.mjs");
	const figure = (width: number, height: number, alt: string) =>
		`<figure class="not-prose my-8" style="--figure-ratio: 0.6; width: min(100%, 1rem);" data-portrait="true"><picture>` +
		`<source srcset="a.avif 480w" type="image/avif" sizes="auto, (min-width: 48rem) 44rem, calc(100vw - 2.5rem)">` +
		`<img src="a.jpg" alt="${alt}" sizes="auto, (min-width: 48rem) 44rem, calc(100vw - 2.5rem)" loading="lazy" decoding="async" width="${width}" height="${height}" class="block h-auto w-full"></picture>` +
		`<figcaption>${alt} caption</figcaption></figure>`;

	// One Figure degrades to that Figure, untouched; nothing or stray content fails the build
	const single = buildCarousel(`\n${figure(1500, 1000, "One")}\n`);
	assert.equal(single.kind, "single");
	assert.equal(single.kind === "single" && single.html, figure(1500, 1000, "One"));
	assert.throws(() => buildCarousel(""), /needs at least one <Figure>/);
	assert.throws(() => buildCarousel(`<p>Hi</p>${figure(3, 2, "A")}${figure(3, 2, "B")}`), /takes only <Figure> children/);

	// Shared frame is the median ratio, clamped to 3:4..16:9
	assert.equal(carouselFrame([1.5, 1.33, 1.33, 4.32]), 1.415);
	assert.equal(carouselFrame([4, 5, 6]), 1.7778);
	assert.equal(carouselFrame([0.5, 0.4]), 0.75);

	const built = buildCarousel([figure(1500, 1000, "A"), figure(1600, 1000, "B"), figure(1800, 1000, "Wide")].join("\n"));
	assert.equal(built.kind, "carousel");
	if (built.kind !== "carousel") return;
	assert.equal(built.frame, 1.6);
	assert.match(built.id, /^carousel-[a-z0-9]+$/);
	// Near-frame shapes fill the frame; the wider one shows whole, and nothing here is small enough to warn about
	assert.deepEqual(built.slides.map((s) => s.fit), ["cover", "cover", "contain"]);
	assert.deepEqual(built.warnings, []);
	// The slide owns width and margins; landscapes lose the Figure's style, every slide stays lazy with sizes=auto
	for (const slide of built.slides) {
		assert.match(slide.html, /^<figure class="not-prose">/);
		assert.doesNotMatch(slide.html, /my-8|--figure-ratio|data-portrait|loading="eager"/);
		assert.match(slide.html, /loading="lazy"/);
		assert.match(slide.html, /sizes="auto, \(min-width: 48rem\) min\(calc\(/);
	}
	// sizes follow the slide (column minus peek), the portrait cap, and the share of the frame the image covers
	assert.equal(
		slideSizes(1.6, 1),
		"auto, (min-width: 48rem) min(calc(44rem - 3rem), 54.4rem, 104vh), (min-width: 40rem) min(calc(100vw - 4rem - 3rem), 54.4rem, 104vh), min(calc(100vw - 2.5rem - 3rem), 54.4rem, 104vh)",
	);
	assert.match(slideSizes(1.6, 0.5), /^auto, \(min-width: 48rem\) min\(calc\(\(44rem - 3rem\) \* 0\.5\), 27\.2rem, 52vh\)/);
	assert.ok(built.slides[2]!.html.includes(`sizes="${slideSizes(1.6, 1)}"`));

	// A portrait keeps its ratio for the no-JS stack's height cap; a photo filling under 70% of the frame warns
	const mixed = buildCarousel(
		[figure(1600, 1000, "A"), figure(1600, 1000, "B"), figure(800, 1000, "Tall"), figure(4300, 1000, "Bergen&#39;s pano")].join(""),
		"Leg 5",
	);
	assert.ok(mixed.kind === "carousel");
	if (mixed.kind !== "carousel") return;
	assert.match(mixed.slides[2]!.html, /^<figure class="not-prose" style="--figure-ratio: 0\.8;" data-portrait="true">/);
	assert.ok(mixed.slides[2]!.html.includes(`sizes="${slideSizes(1.6, 0.5)}"`));
	const fillLines = [`Carousel "Leg 5". Photo "Tall": ${CAROUSEL_SMALL_FILL}`, `Carousel "Leg 5". Photo "Bergen's pano": ${CAROUSEL_SMALL_FILL}`];
	assert.deepEqual(mixed.warnings, fillLines);
	// The CLI lint, given the saved image sizes, prints the very same lines from the MDX
	const mdx = [
		'<Carousel label="Leg 5">',
		'<Figure src="img/a.jpg" alt="A" />',
		'<Figure src="img/b.jpg" alt="B" />',
		'<Figure src="img/tall.jpg" alt="Tall" />',
		`<Figure src="img/pano.jpg" alt="Bergen's pano" />`,
		"</Carousel>",
	].join("\n");
	const sizes: Record<string, [number, number]> = { "img/a.jpg": [1600, 1000], "img/b.jpg": [1600, 1000], "img/tall.jpg": [800, 1000], "img/pano.jpg": [4300, 1000] };
	assert.deepEqual(lintCarousels(mdx, { sizeOf: (src: string) => sizes[src] }), fillLines);
	assert.deepEqual(lintCarousels(mdx), []);
	assert.equal(CAROUSEL_SMALL_FILL, "This photo fills less than 70% of the carousel frame. Use a standalone Figure if the full view matters.");

	// Lint: too many slides, too many carousels, one-slide carousels, and page-local carousel components
	const slides = (n: number) => Array.from({ length: n }, () => '<Figure src="img/a.jpg" alt="a" />').join("\n");
	assert.deepEqual(lintCarousels(`<Carousel label="Ok">\n${slides(4)}\n</Carousel>`), []);
	assert.match(lintCarousels(`<Carousel label="Big">\n${slides(CAROUSEL_MAX_SLIDES + 1)}\n</Carousel>`)[0]!, /"Big" has 9 slides/);
	assert.match(lintCarousels(`<Carousel label="Lonely">\n${slides(1)}\n</Carousel>`)[0]!, /use a plain <Figure>/);
	assert.equal(
		lintCarousels(Array.from({ length: 4 }, () => `<Carousel label="x">\n${slides(3)}\n</Carousel>`).join("\n"))[0],
		`4 carousels on one page. ${CAROUSEL_TOO_MANY}`,
	);
	assert.equal(
		CAROUSEL_TOO_MANY,
		"Use up to three carousels per report. Keep them where several views explain something a single photo cannot. For other sections, choose one representative photo or omit it.",
	);
	assert.match(lintCarousels('import PhotoCarousel from "./components/PhotoCarousel.svelte";\n')[0]!, /use <Carousel> from "@components\/mdx"/);

	// Settling: a paused drag never commits; release decides. Both with scrollend and on the timer fallback.
	for (const nativeScrollEnd of [true, false]) {
		let now = 0;
		let timers: { at: number; fn: () => void; id: number }[] = [];
		let nextId = 0;
		const tick = (ms: number) => {
			now += ms;
			for (const t of timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)) {
				timers = timers.filter((x) => x !== t);
				t.fn();
			}
		};
		let settled = 0;
		const settler = createSettler({
			nativeScrollEnd,
			settle: () => (settled += 1),
			setTimer: (fn: () => void, ms: number) => {
				const id = ++nextId;
				timers.push({ at: now + ms, fn, id });
				return id;
			},
			clearTimer: (id: unknown) => (timers = timers.filter((t) => t.id !== id)),
		});
		const path = nativeScrollEnd ? "scrollend" : "timer fallback";
		// (a) drag past halfway, hold 360ms, drag back, release onto the same slide
		settler.press();
		for (let i = 0; i < 10; i++) (settler.scroll(), tick(16));
		tick(360);
		assert.equal(settled, 0, `${path}: nothing settles while the finger is down`);
		for (let i = 0; i < 10; i++) (settler.scroll(), tick(16));
		settler.release();
		for (let i = 0; i < 5; i++) (settler.scroll(), tick(16));
		if (nativeScrollEnd) settler.scrollEnd();
		tick(400);
		assert.equal(settled, 1, `${path}: one settle after release (the page decides nothing changed)`);
		// (b) drag and release: settles once, after the snap
		settler.press();
		settler.scroll();
		settler.release();
		for (let i = 0; i < 15; i++) (settler.scroll(), tick(16));
		assert.equal(settled, 1, `${path}: not before the snap finishes`);
		if (nativeScrollEnd) settler.scrollEnd();
		tick(400);
		assert.equal(settled, 2, `${path}: exactly once after the snap`);
		// Buttons, keys and wheel: scroll events alone settle once (scrollend, or the quiet spell)
		for (let i = 0; i < 20; i++) (settler.scroll(), tick(16));
		if (nativeScrollEnd) {
			tick(1000);
			assert.equal(settled, 2, "scrollend path ignores bare scroll events");
			settler.scrollEnd();
		}
		tick(400);
		assert.equal(settled, 3, `${path}: one settle per programmatic move`);
	}

	const component = readFileSync(new URL("../sites/grug-pages/src/components/mdx/Carousel.astro", import.meta.url), "utf8");
	const css = readFileSync(new URL("../sites/grug-pages/src/styles/global.css", import.meta.url), "utf8");
	const index = readFileSync(new URL("../sites/grug-pages/src/components/mdx/index.ts", import.meta.url), "utf8");
	const cli = readFileSync(new URL("../sites/grug-pages/bin/grug-page.mjs", import.meta.url), "utf8");
	const skill = readFileSync(new URL("../bots/grug/skills/grug-page/SKILL.md", import.meta.url), "utf8");

	assert.match(index, /export \{ default as Carousel \} from "\.\/Carousel\.astro";/);
	// Region, slide groups "N of M", polite status, labelled buttons wired to the strip, 48px touch targets
	assert.match(component, /role="region" aria-roledescription="carousel" aria-label=\{label\.trim\(\)\}/);
	assert.match(component, /role="group"\s+aria-roledescription="slide"\s+aria-label=\{`\$\{i \+ 1\} of \$\{carousel\.slides\.length\}`\}/);
	assert.match(component, /aria-live="polite" aria-atomic="true"/);
	assert.match(component, /aria-label="Previous slide" aria-controls=\{carousel\.id\}/);
	assert.match(component, /aria-label="Next slide" aria-controls=\{carousel\.id\}/);
	assert.match(component, /pointer-coarse:size-12/);
	// The horizontal layout switches on during parsing; the strip only becomes a tab stop with JS
	assert.match(component, /<script is:inline>document\.currentScript\.parentElement\.setAttribute\("data-js", ""\);<\/script>/);
	assert.doesNotMatch(component, /tabindex="0"/);
	assert.match(component, /strip\.tabIndex = 0;/);
	// One settled index: inactive slides go inert, focus leaves a slide before it does, one announcement per slide
	assert.match(component, /slide\.inert = j !== i;/);
	assert.match(component, /slides\.some\(\(slide, j\) => j !== i && slide\.contains\(active\)\)\) strip\.focus\(\{ preventScroll: true \}\)/);
	assert.match(component, /if \(announce && i !== announced\)/);
	assert.match(component, /const nativeScrollEnd = "onscrollend" in window;/);
	assert.match(component, /if \(nativeScrollEnd\) strip\.addEventListener\("scrollend", \(\) => settler\.scrollEnd\(\)\);/);
	assert.match(component, /strip\.addEventListener\("touchstart", \(\) => settler\.press\(\), \{ passive: true \}\);/);
	assert.match(component, /if \(event\.pointerType === "touch"\) return;/);
	// Keys only on the strip and buttons; disabled buttons ignore Enter/Space; no autoplay; reduced motion
	assert.match(component, /for \(const control of \[strip, prev, next\]\) control\.addEventListener\("keydown", onKey\);/);
	assert.match(component, /if \(event\.target !== event\.currentTarget\) \{\n\s*if \(event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"\) event\.preventDefault\(\);\n\s*return;/);
	assert.match(component, /if \(button\.getAttribute\("aria-disabled"\) === "true"\) return;/);
	assert.doesNotMatch(component, /setInterval|autoplay/i);
	assert.match(component, /behavior: reducedMotion\.matches \? "auto" : "smooth"/);
	assert.match(component, /if \(announce\) warm\(i \+ 1\);/);
	assert.match(component, /warm\(0\);\n\s*warm\(1\);/);
	// Control row contrast and type
	assert.match(component, /text-sm\/5 tracking-normal text-stone-600 tabular-nums dark:text-stone-400/);
	assert.match(component, /border-stone-950\/20/);
	assert.match(component, /dark:border-white\/25/);
	assert.doesNotMatch(component, /Scroll &rarr;|carousel-hint/);

	// Stack by default; strip, snap, bleed and spacer only with JS; focus ring on the section
	assert.match(css, /\.carousel-strip \{\n {4}display: grid;\n {4}gap: --spacing\(6\);/);
	assert.match(css, /\.carousel\[data-js\] \{/);
	assert.match(css, /scroll-snap-type: x mandatory;/);
	assert.match(css, /scroll-snap-align: start;/);
	assert.match(css, /--slide-width: min\(100% - var\(--carousel-peek\), min\(65svh, 34rem\) \* var\(--frame\)\);/);
	assert.match(css, /width: max\(0px, 100% - var\(--slide-width\) - --spacing\(3\)\);/);
	assert.match(css, /aspect-ratio: var\(--frame\);/);
	// Strip focus: a double ring inside the current frame plus an accent counter, never a ring the peek can cover
	assert.match(css, /\.carousel-section:has\(\.carousel-strip:focus-visible\) \{\n {2}\.carousel-slide\[data-current\] picture::after \{\n {4}box-shadow:\n {6}inset 0 0 0 3px var\(--carousel-ring\),\n {6}inset 0 0 0 5px var\(--carousel-ring-gap\);/);
	assert.match(css, /--carousel-ring: var\(--color-accent-dark\);\n {6}--carousel-ring-gap: var\(--color-obsidian\);/);
	assert.match(css, /\.carousel-counter \{\n {4}color: var\(--color-accent\);\n {4}text-decoration: underline 2px;/);
	assert.doesNotMatch(css, /outline-offset: 4px/);
	// Button focus hugs the 36px circle, not the 48px touch target
	assert.match(component, /group-focus-visible\/btn:outline-2 group-focus-visible\/btn:outline-offset-2/);
	assert.doesNotMatch(component, /class="[^"]*\bfocus-visible:outline-2/);
	assert.match(css, /\.carousel \.carousel-slide figcaption a:focus-visible \{\n {2}outline-offset: -2px;/);
	assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\n {8}scroll-behavior: smooth;/);

	assert.match(cli, /await warnPageLint\(cfg\.pagesDir, slug \? \[slug\] : slugs\);/);
	assert.match(cli, /if \(width && height\) writeSize\(imgDir, file, width, height\);/);
	assert.match(cli, /const SIZES_FILE = "\.sizes\.json";/);
	assert.match(cli, /GRUG_PAGE_LINTED: "1"/);
	assert.match(component, /process\.env\.GRUG_PAGE_LINTED !== "1"/);
	assert.ok(skill.includes(CAROUSEL_TOO_MANY));
	assert.match(skill, /One sentence, up to 100 characters for carousel captions\. Put route advice in the section text\./);
	assert.match(skill, /Never write page-local components for UI the template owns/);
});
