import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { WorkerOptions } from "./extensions/workers.ts";
import { MUSE, musePreamble } from "./muse.ts";
import { startPagesServer } from "./pages-server.ts";
import { createPromptResolver, filterWorkerPrompt } from "./prompts.ts";
import { createSshSandbox, SandboxManager, validateStagedPages } from "./sandbox.ts";
import { UserRegistry } from "./users.ts";

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
	// 1. Direct validateStagedPages checks
	const goodDir = join(dir, "stage-good");
	mkdirSync(join(goodDir, "trip-plan"), { recursive: true });
	writeFileSync(
		join(goodDir, "index.html"),
		'<!doctype html><html><head><link rel="canonical" href="https://grug.h14h.com/abc12345/"></head><body><a href="https://example.com">link</a></body></html>',
	);
	writeFileSync(
		join(goodDir, "trip-plan", "index.html"),
		'<!doctype html><html><body><a href="https://example.com">source</a></body></html>',
	);
	const okStats = validateStagedPages(goodDir, "trip-plan");
	assert.equal(okStats.fileCount, 2);
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
			return fauxAssistantMessage("live: https://grug.h14h.com/hen12345/coffee-guide/");
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
		const toolText = toolResultMsg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
		const parsed = JSON.parse(toolText) as {
			slug: string;
			url: string;
			homeUrl: string;
			fileCount: number;
			totalBytes: number;
		};
		assert.equal(parsed.slug, "coffee-guide");
		assert.equal(parsed.url, "https://grug.h14h.com/hen12345/coffee-guide/");
		assert.equal(parsed.homeUrl, "https://grug.h14h.com/hen12345/");
		assert.equal(parsed.fileCount, 2);
		assert.ok(parsed.totalBytes > 0);

		// 2. Guest DM (SSH without pagesCode): no publish_page tool, allowPages: false in system prompt
		currentWho = "guest";
		const guestConv = await agent.conversationFor("telegram:dm:1002", context);
		await (await guestConv.submit({ type: "input", content: "hi" }, context)).wait(context);
		const guestReq = seenRequests.find((r) => r.who === "guest")!.req;
		const guestSystemMsg = guestReq.messages[0] as { sections?: Record<string, string>; toolsAdded?: { name: string }[] };
		const guestSystem = JSON.stringify(guestSystemMsg.sections ?? guestSystemMsg);
		const guestToolNames = (guestSystemMsg.toolsAdded ?? guestReq.tools ?? []).map((t) => t.name);
		assert.ok(!guestToolNames.includes("publish_page"));
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
		assert.doesNotMatch(groupSystem, /publish_page/);
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
