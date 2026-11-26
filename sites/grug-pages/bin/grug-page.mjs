#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { figureTags, lintCarousels } from "../lib/carousel.mjs";
import { fetchImage } from "../lib/fetch-image.mjs";
import { createStaticHandler } from "../lib/static-handler.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_ROOT = resolve(__dirname, "..");

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_DIST_BYTES = 25 * 1024 * 1024;
const DEFAULT_SITE_URL = "https://grug.h14h.com";
const DEFAULT_POLISH_MODEL = "muse-wonder-full-1.0";
const DEFAULT_POLISH_TIMEOUT_MS = 180_000;
const DEFAULT_PREVIEW_STATE = "/tmp/grug-page-preview.json";

const EXTERNAL_HTML_PATTERNS = [
  /<script\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//gi,
  /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\//gi,
  /<link\b[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\/[^>]*\brel\s*=\s*["']?stylesheet["']?/gi,
  /<(img|iframe|source|video|audio|embed|object|track)\b[^>]*\b(src|srcset|data)\s*=\s*["']?\s*(https?:)?\/\//gi,
];
const EXTERNAL_CSS_PATTERNS = [
  /url\(\s*["']?\s*(https?:)?\/\//gi,
  /@import\s+(?:url\(\s*)?["']?\s*(https?:)?\/\//gi,
];

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function loadConfig() {
  const configPath = expandHome(
    process.env.GRUG_PAGES_CONFIG || join(homedir(), ".config", "grug-pages.json"),
  );
  let fileCfg = {};
  if (existsSync(configPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      fail(`Failed to parse ${configPath}: ${err.message}`);
    }
  }

  const userCode = String(
    process.env.GRUG_PAGES_CODE || fileCfg.userCode || fileCfg.code || "local",
  )
    .trim()
    .replace(/^\/+|\/+$/g, "");

  const siteUrl = String(
    process.env.GRUG_PAGES_SITE_URL ||
      process.env.GRUG_PAGES_SITE ||
      fileCfg.siteUrl ||
      DEFAULT_SITE_URL,
  )
    .trim()
    .replace(/\/+$/, "");

  const rawWorkDir = expandHome(
    process.env.GRUG_PAGES_WORK_DIR || fileCfg.workDir || join(homedir(), "work"),
  );
  const pagesDir =
    basename(rawWorkDir) === "pages" ? resolve(rawWorkDir) : resolve(rawWorkDir, "pages");

  const siteDir = resolve(
    expandHome(process.env.GRUG_PAGES_SITE_DIR || fileCfg.siteDir || join(homedir(), "site")),
  );

  const museBin = expandHome(
    process.env.GRUG_MUSE_BIN ||
      fileCfg.museBin ||
      (existsSync(join(homedir(), ".local", "bin", "muse"))
        ? join(homedir(), ".local", "bin", "muse")
        : "muse"),
  );

  const polishModel = String(
    process.env.GRUG_POLISH_MODEL || fileCfg.polishModel || DEFAULT_POLISH_MODEL,
  ).trim();

  const rawPolishTimeout = Number(
    process.env.GRUG_POLISH_TIMEOUT_MS || fileCfg.polishTimeoutMs || DEFAULT_POLISH_TIMEOUT_MS,
  );
  const polishTimeoutMs =
    Number.isFinite(rawPolishTimeout) && rawPolishTimeout > 0
      ? rawPolishTimeout
      : DEFAULT_POLISH_TIMEOUT_MS;

  const skillsDir = expandHome(
    process.env.GRUG_SKILLS_DIR || fileCfg.skillsDir || join(homedir(), ".config", "muse", "skills"),
  );

  return {
    configPath,
    userCode,
    siteUrl,
    pagesDir,
    siteDir,
    museBin,
    polishModel,
    polishTimeoutMs,
    skillsDir,
  };
}

function fail(message, code = 1) {
  process.stderr.write(`grug-page: ${message}\n`);
  process.exit(code);
}

function validateSlug(slug) {
  if (!slug || !SLUG_RE.test(slug)) {
    fail(
      `Invalid slug "${slug ?? ""}". Use 1-63 lowercase letters, digits, or hyphens (e.g. "nas-cases").`,
    );
  }
}

function slugToTitle(slug) {
  const words = slug.split("-").filter(Boolean);
  if (words.length === 0) return slug;
  return words[0][0].toUpperCase() + words[0].slice(1) + (words.length > 1 ? ` ${words.slice(1).join(" ")}` : "");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const raw = match[1];
  const data = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val === "") {
      // Check for YAML block list on subsequent lines
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        i += 1;
        items.push(unquoteYaml(lines[i].replace(/^\s*-\s+/, "").trim()));
      }
      data[key] = items.length > 0 ? items : "";
    } else if (val.startsWith("[") && val.endsWith("]")) {
      const inner = val.slice(1, -1).trim();
      data[key] = inner
        ? inner
            .split(",")
            .map((s) => unquoteYaml(s.trim()))
            .filter(Boolean)
        : [];
    } else {
      data[key] = unquoteYaml(val);
    }
  }
  return { raw, data, body: text.slice(match[0].length) };
}

function unquoteYaml(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function validateMdxDocument(text, originalText = null) {
  const errors = [];
  const fm = parseFrontmatter(text);
  if (!fm) {
    errors.push("Missing or malformed YAML frontmatter (must start and end with ---).");
    return { ok: false, errors, fm: null };
  }
  if (!fm.data.title || typeof fm.data.title !== "string" || !fm.data.title.trim()) {
    errors.push('Frontmatter missing required "title".');
  }
  if (!fm.data.date || typeof fm.data.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fm.data.date)) {
    errors.push('Frontmatter missing valid ISO "date" (YYYY-MM-DD).');
  }
  if (!fm.data.summary || typeof fm.data.summary !== "string" || !fm.data.summary.trim()) {
    errors.push('Frontmatter missing required "summary".');
  }

  // Check balanced fenced code blocks
  const fences = fm.body.match(/^(?:```|~~~)/gm) ?? [];
  if (fences.length % 2 !== 0) {
    errors.push("Unclosed fenced code block in MDX body.");
  }

  // Extract top-level import lines outside code blocks
  const stripCodeBlocks = (body) => body.replace(/(^|\n)(```|~~~)[\s\S]*?\n\2[^\n]*/g, "");
  const extractImports = (body) =>
    stripCodeBlocks(body)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^import\s+.+\s+from\s+["'][^"']+["'];?$/.test(l));

  if (originalText) {
    const origFm = parseFrontmatter(originalText);
    if (origFm) {
      const origImports = extractImports(origFm.body);
      const nextImports = extractImports(fm.body);
      for (const imp of origImports) {
        const fromMatch = /from\s+["']([^"']+)["']/.exec(imp);
        if (fromMatch && !nextImports.some((line) => line.includes(fromMatch[1]))) {
          errors.push(`MDX import dropped during edit: ${imp}`);
        }
      }
    }
  }

  // Check JSX opening/closing tag balance for custom components (<Capitalized ...>)
  const cleanBody = stripCodeBlocks(fm.body).replace(/`[^`]*`/g, "");
  const openStack = [];
  const tagRe = /<(\/)?([A-Z][A-Za-z0-9._]*)\b([^>]*?)(\/)?>/g;
  let m;
  while ((m = tagRe.exec(cleanBody)) !== null) {
    const isClose = Boolean(m[1]);
    const name = m[2];
    const isSelfClose = Boolean(m[4]);
    if (isSelfClose) continue;
    if (!isClose) {
      openStack.push(name);
    } else {
      const last = openStack.pop();
      if (last !== name) {
        errors.push(`Mismatched JSX component tag: closed </${name}> expected ${last ? `</${last}>` : "none"}.`);
        break;
      }
    }
  }
  if (openStack.length > 0 && errors.length === 0) {
    errors.push(`Unclosed JSX component tag(s): ${openStack.map((n) => `<${n}>`).join(", ")}.`);
  }

  return { ok: errors.length === 0, errors, fm };
}

function countStats(text) {
  const bytes = Buffer.byteLength(text, "utf8");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { bytes, words };
}

function resolveSkillFile(cfg, name) {
  const candidates = [
    join(cfg.skillsDir, name, "SKILL.md"),
    join(homedir(), ".config", "muse", "skills", name, "SKILL.md"),
    join(homedir(), ".local", "share", "muse", "skills", name, "SKILL.md"),
    resolve(TEMPLATE_ROOT, "..", "..", "bots", "grug", "skills", name, "SKILL.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  fail(
    `Could not find ${name}/SKILL.md. Checked:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
}

function runMusePolishStage({ cfg, stageName, skillPath, targetFile, instructions }) {
  const skillText = readFileSync(skillPath, "utf8").trim();
  const prompt = [
    `You are running automated editorial pass "${stageName}" on a single MDX page file.`,
    `Target file: ${targetFile}`,
    "",
    "Follow the skill instructions below faithfully (except where the stricter overrides below take precedence):",
    "--- BEGIN SKILL ---",
    skillText,
    "--- END SKILL ---",
    "",
    "STRICT STRUCTURAL GUARDRAILS (non-negotiable):",
    instructions,
    "- Read the target file, rewrite it directly in place, and do not create extra files.",
    "- Preserve YAML frontmatter keys (`title`, `subtitle`, `date`, `updated`, `summary`, `tags`) and keep `date`/`updated` in ISO `YYYY-MM-DD` format.",
    "- NEVER invent facts, numbers, units, dates, URLs, or sources, and NEVER drop unique verdicts, numbers, units, dates, verified URLs, or sources (deleting duplicate prose restatements of figures already in StatGrid or a table is required).",
    "- NEVER remove, rename, or alter MDX `import` lines, code blocks, table numbers, or JSX/Svelte component tags and props (including `client:load` directives).",
    "- Keep Markdown headings, links, and tables valid MDX.",
    "- Output a one-line confirmation when done.",
  ].join("\n");

  const tmpDir = mkdtempSync(join(tmpdir(), `grug-polish-${stageName}-`));
  const promptFile = join(tmpDir, "prompt.md");
  try {
    writeFileSync(promptFile, prompt, "utf8");
    const args = [
      "exec",
      "--disable-sandbox",
      "--disable-approval",
      "--disable-request-user-input",
      "--model",
      cfg.polishModel,
      "--reasoning-effort",
      "medium",
      "--prompt-file",
      promptFile,
    ];
    const result = spawnSync(cfg.museBin, args, {
      cwd: dirname(targetFile),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: cfg.polishTimeoutMs,
    });
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        throw new Error(`Stage "${stageName}" timed out after ${cfg.polishTimeoutMs}ms.`);
      }
      throw new Error(`Stage "${stageName}" failed to launch ${cfg.museBin}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().slice(0, 800);
      const reason = result.signal ? `terminated by signal ${result.signal}` : `exited with code ${result.status}`;
      throw new Error(`Stage "${stageName}" ${reason}${detail ? `:\n${detail}` : ""}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function cmdInit(cfg, args) {
  let slug = null;
  let title = null;
  let force = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--title" && i + 1 < args.length) {
      title = args[++i];
    } else if (arg.startsWith("--title=")) {
      title = arg.slice("--title=".length);
    } else if (arg === "--force") {
      force = true;
    } else if (!arg.startsWith("-") && !slug) {
      slug = arg;
    } else {
      fail(`Unknown argument for init: ${arg}`);
    }
  }

  validateSlug(slug);
  const pageDir = join(cfg.pagesDir, slug);
  const indexPath = join(pageDir, "index.mdx");
  if (existsSync(indexPath) && !force) {
    fail(`Page already exists: ${indexPath} (pass --force to overwrite).`);
  }

  const pageTitle = (title && title.trim()) || slugToTitle(slug);
  const today = todayIso();
  mkdirSync(pageDir, { recursive: true });

  const starter = `---
title: "${pageTitle.replace(/"/g, '\\"')}"
subtitle: ""
date: "${today}"
summary: "Short one-sentence summary of what this page answers."
tags: []
---

import { Callout, StatGrid, Stat, Details, Sources, Figure } from "@components/mdx";

## Summary

Lead with the answer.

<Sources checked="${today}">
1. [Source title](https://example.com) — checked ${today}
</Sources>
`;

  writeFileSync(indexPath, starter, "utf8");
  process.stdout.write(`INIT ${slug} -> ${indexPath}\n`);
}

function cmdPolish(cfg, args) {
  const slug = args.find((a) => !a.startsWith("-"));
  validateSlug(slug);

  const pageDir = join(cfg.pagesDir, slug);
  const indexPath = join(pageDir, "index.mdx");
  if (!existsSync(indexPath)) {
    fail(`Page not found: ${indexPath}`);
  }

  const draftText = readFileSync(indexPath, "utf8");
  const draftCheck = validateMdxDocument(draftText);
  if (!draftCheck.ok) {
    fail(`Draft MDX is invalid before polish:\n- ${draftCheck.errors.join("\n- ")}`);
  }

  const draftBackup = join(pageDir, ".draft.mdx");
  const unslopSnapshot = join(pageDir, ".unslop.mdx");
  const stagePath = join(pageDir, ".polish-stage.mdx");

  const unslopSkill = resolveSkillFile(cfg, "unslop");
  const ultracaveSkill = resolveSkillFile(cfg, "ultracave");

  let unslopText = "";
  let finalText = "";
  let polishError = null;

  try {
    // Stage both passes on .polish-stage.mdx (dotfile ignored by `grug-page build`)
    // so a timeout, crash, or validation failure leaves index.mdx and any existing .draft.mdx untouched.
    writeFileSync(stagePath, draftText, "utf8");

    // Stage 1: unslop (with anti-bloat & deduplication overrides)
    runMusePolishStage({
      cfg,
      stageName: "unslop",
      skillPath: unslopSkill,
      targetFile: stagePath,
      instructions: [
        '- Keep all unslop anti-slop rules: cut AI vocabulary, filler, vague attributions, em-dashes, promotional fluff, hedging, and meta-narration (e.g. "I ran it twice...", "I have decent confidence...").',
        '- CRITICAL OVERRIDE — NEVER expand compact bullet lists or tables into narrative paragraphs (this overrides unslop\'s "convert lists to prose" rule). Keep bullet lists tight and scannable.',
        "- DEDUPLICATE REPEATED FACTS ACROSS SECTIONS: if a number, price, or spec already appears in StatGrid or a table, DELETE the repetitive prose restatement below it — keep prose only for verdicts, caveats, and tradeoffs not already in the table.",
        "- WORD-COUNT CAP: Stage 1 must shrink or hold total word count, NEVER inflate it.",
      ].join("\n"),
    });

    if (!existsSync(stagePath)) {
      throw new Error("Stage unslop deleted .polish-stage.mdx; original index.mdx left untouched.");
    }
    unslopText = readFileSync(stagePath, "utf8");
    const unslopCheck = validateMdxDocument(unslopText, draftText);
    if (!unslopCheck.ok) {
      throw new Error(
        `Stage unslop produced invalid MDX (original index.mdx left untouched):\n- ${unslopCheck.errors.join("\n- ")}`,
      );
    }

    // Stage 2: ultracave (true compression + punchy voice)
    runMusePolishStage({
      cfg,
      stageName: "ultracave",
      skillPath: ultracaveSkill,
      targetFile: stagePath,
      instructions: [
        "- True compression + ultracave voice pass: target ~30-50% tighter prose with crisp grugbrain.dev-style punchy rhythm.",
        "- Cut remaining filler, throat-clearing, and repetition ruthlessly. Keep bullet lists and tables compact; do not expand them into paragraphs.",
        "- Keep unslop's no-em-dash rule: do not reintroduce em-dashes (—) or double hyphens (--); use periods, commas, or colons.",
        "- Keep verdicts, key numbers, units, dates, verified URLs, sources, YAML frontmatter, MDX imports, table numbers, code blocks, and JSX/Svelte component tags/props 100% intact. Use full sentences wherever a fragment could have two readings.",
      ].join("\n"),
    });

    if (!existsSync(stagePath)) {
      throw new Error("Stage ultracave deleted .polish-stage.mdx; original index.mdx left untouched.");
    }
    finalText = readFileSync(stagePath, "utf8");
    const finalCheck = validateMdxDocument(finalText, draftText);
    if (!finalCheck.ok) {
      throw new Error(
        `Stage ultracave produced invalid MDX (original index.mdx left untouched):\n- ${finalCheck.errors.join("\n- ")}`,
      );
    }

    // Both stages succeeded and validated: preserve original .draft.mdx (never overwrite an existing backup),
    // record Stage 1 snapshot, and atomically swap staged output into index.mdx.
    if (!existsSync(draftBackup)) {
      writeFileSync(draftBackup, draftText, "utf8");
    }
    writeFileSync(unslopSnapshot, unslopText, "utf8");
    renameSync(stagePath, indexPath);
  } catch (err) {
    polishError = err;
  } finally {
    rmSync(stagePath, { force: true });
  }

  if (polishError) {
    fail(polishError instanceof Error ? polishError.message : String(polishError));
  }

  const sDraft = countStats(draftText);
  const sUnslop = countStats(unslopText);
  const sFinal = countStats(finalText);
  process.stdout.write(
    `POLISHED ${slug}: ${sDraft.words}w (${sDraft.bytes}B) -> ${sUnslop.words}w (${sUnslop.bytes}B) -> ${sFinal.words}w (${sFinal.bytes}B)\n`,
  );
}

function copyFilteredDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyFilteredDir(srcPath, destPath);
    } else if (entry.isFile()) {
      cpSync(srcPath, destPath);
    }
  }
}

function syncPagesToSite(pagesDir, siteContentPagesDir) {
  mkdirSync(siteContentPagesDir, { recursive: true });
  const validSlugs = [];

  if (existsSync(pagesDir)) {
    for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SLUG_RE.test(entry.name)) {
        const indexMdx = join(pagesDir, entry.name, "index.mdx");
        const indexMd = join(pagesDir, entry.name, "index.md");
        if (existsSync(indexMdx) || existsSync(indexMd)) {
          validSlugs.push(entry.name);
        }
      } else if (entry.isFile() && /\.(mdx|md)$/.test(entry.name)) {
        const slug = entry.name.replace(/\.(mdx|md)$/, "");
        if (SLUG_RE.test(slug)) {
          validSlugs.push(slug);
        }
      }
    }
  }

  validSlugs.sort();
  const validSet = new Set(validSlugs);

  // Remove stale pages from site content dir (keep .gitkeep)
  for (const existing of readdirSync(siteContentPagesDir, { withFileTypes: true })) {
    if (existing.name === ".gitkeep") continue;
    const existingSlug = existing.name.replace(/\.(mdx|md)$/, "");
    if (!validSet.has(existingSlug)) {
      rmSync(join(siteContentPagesDir, existing.name), { recursive: true, force: true });
    }
  }

  // Sync current valid pages cleanly (replace each slug dir so deleted assets vanish too)
  for (const slug of validSlugs) {
    const srcFolder = join(pagesDir, slug);
    if (existsSync(srcFolder) && statSync(srcFolder).isDirectory()) {
      const destFolder = join(siteContentPagesDir, slug);
      rmSync(destFolder, { recursive: true, force: true });
      copyFilteredDir(srcFolder, destFolder);
    } else {
      const ext = existsSync(join(pagesDir, `${slug}.mdx`)) ? ".mdx" : ".md";
      copyFileSync(join(pagesDir, `${slug}${ext}`), join(siteContentPagesDir, `${slug}${ext}`));
    }
  }

  return validSlugs;
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function verifyDist(distDir, targetSlug) {
  const indexHtml = join(distDir, "index.html");
  if (!existsSync(indexHtml)) {
    fail(`Build verification failed: missing ${indexHtml}`);
  }
  if (targetSlug) {
    const slugHtml = join(distDir, targetSlug, "index.html");
    if (!existsSync(slugHtml)) {
      fail(`Build verification failed: missing ${slugHtml}`);
    }
  }

  let totalBytes = 0;
  const problems = [];

  for (const file of walkFiles(distDir)) {
    if (basename(file) === ".build-meta.json") continue;
    const size = statSync(file).size;
    totalBytes += size;
    const ext = extname(file).toLowerCase();
    if (ext !== ".html" && ext !== ".css") continue;
    const text = readFileSync(file, "utf8");
    const rel = file.slice(distDir.length + 1);
    const patterns = ext === ".html" ? EXTERNAL_HTML_PATTERNS : EXTERNAL_CSS_PATTERNS;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        problems.push(`${rel} loads external asset: ${match[0].slice(0, 100)}`);
      }
    }
  }

  if (problems.length > 0) {
    fail(`Build blocked by external resource check:\n- ${problems.join("\n- ")}`);
  }
  if (totalBytes >= MAX_DIST_BYTES) {
    fail(
      `Build size ${(totalBytes / (1024 * 1024)).toFixed(2)} MB exceeds the 25 MB limit.`,
    );
  }

  return { totalBytes };
}

const SIZES_FILE = ".sizes.json";

function readSizes(imgDir) {
  try {
    return JSON.parse(readFileSync(join(imgDir, SIZES_FILE), "utf8"));
  } catch {
    return {};
  }
}

/** Remember an image's pixel size in img/.sizes.json (a dotfile, so builds skip it) for the carousel lint. */
function writeSize(imgDir, file, width, height) {
  const sizes = readSizes(imgDir);
  sizes[file] = [width, height];
  const sorted = Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(imgDir, SIZES_FILE), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/**
 * Pixel sizes of the images a page uses, from img/.sizes.json. Images saved before the sidecar existed are measured
 * once (sharp, already installed for Astro's image pipeline) and added to it.
 */
async function pageImageSizes(pageDir, body) {
  const imgDir = join(pageDir, "img");
  const sizes = readSizes(imgDir);
  const wanted = [
    ...new Set(
      figureTags(body)
        .map((attrs) => /^(?:\.\/)?img\/([^/]+)$/.exec(attrs.src ?? "")?.[1])
        .filter(Boolean),
    ),
  ];
  const missing = wanted.filter((file) => !sizes[file] && existsSync(join(imgDir, file)));
  const sharp = missing.length > 0 ? loadSharp() : null;
  for (const file of missing) {
    if (!sharp) break;
    try {
      const meta = await sharp(join(imgDir, file), { animated: file.endsWith(".gif") }).metadata();
      const height = meta.pageHeight ?? meta.height;
      if (meta.width && height) {
        sizes[file] = [meta.width, height];
        writeSize(imgDir, file, meta.width, height);
      }
    } catch {
      // Unreadable image: the build will say so.
    }
  }
  return (src) => (src.startsWith("img/") ? sizes[src.slice(4)] : undefined);
}

/**
 * Non-blocking advice: carousel slide counts, carousels per page, and photos that fill too little of the frame.
 * Returns the warning count and the carousels whose photo fit it checked ("<slug>\n<label>"), which the build
 * passes on so <Carousel> repeats nothing the lint already said, and still speaks up about anything it couldn't check.
 */
async function warnPageLint(pagesDir, slugs) {
  let count = 0;
  const covered = [];
  for (const slug of slugs) {
    const file = [join(pagesDir, slug, "index.mdx"), join(pagesDir, `${slug}.mdx`)].find((f) => existsSync(f));
    if (!file) continue;
    const body = readFileSync(file, "utf8");
    const sizeOf = await pageImageSizes(dirname(file) === pagesDir ? join(pagesDir, slug) : dirname(file), body);
    const labels = [];
    for (const warning of lintCarousels(body, { sizeOf, covered: labels })) {
      process.stderr.write(`WARN ${slug}: ${warning}\n`);
      count += 1;
    }
    covered.push(...labels.map((label) => `${slug}\n${label}`));
  }
  return { count, covered };
}

async function cmdLint(cfg, args) {
  const slug = args.find((a) => !a.startsWith("-"));
  if (slug) validateSlug(slug);
  const slugs = slug ? [slug] : syncablePageSlugs(cfg.pagesDir);
  const { count } = await warnPageLint(cfg.pagesDir, slugs);
  process.stdout.write(count ? `LINT ${count} warning${count === 1 ? "" : "s"}\n` : "LINT ok\n");
}

function syncablePageSlugs(pagesDir) {
  if (!existsSync(pagesDir)) return [];
  return readdirSync(pagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SLUG_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function cmdBuild(cfg, args) {
  const slug = args.find((a) => !a.startsWith("-")) ?? null;
  if (slug) {
    validateSlug(slug);
    const hasDir =
      existsSync(join(cfg.pagesDir, slug, "index.mdx")) ||
      existsSync(join(cfg.pagesDir, slug, "index.md"));
    const hasFile =
      existsSync(join(cfg.pagesDir, `${slug}.mdx`)) ||
      existsSync(join(cfg.pagesDir, `${slug}.md`));
    if (!hasDir && !hasFile) {
      fail(`Page "${slug}" not found under ${cfg.pagesDir}`);
    }
  }

  if (!existsSync(join(cfg.siteDir, "astro.config.mjs"))) {
    fail(`Astro site not found at ${cfg.siteDir} (set GRUG_PAGES_SITE_DIR or ~/.config/grug-pages.json).`);
  }

  const contentPagesDir = join(cfg.siteDir, "src", "content", "pages");
  const slugs = syncPagesToSite(cfg.pagesDir, contentPagesDir);
  const { covered } = await warnPageLint(cfg.pagesDir, slug ? [slug] : slugs);

  const astroBin = join(cfg.siteDir, "node_modules", ".bin", "astro");
  if (!existsSync(astroBin)) {
    fail(`Astro binary not found at ${astroBin}. Run npm install in ${cfg.siteDir}.`);
  }

  const basePath = `/${cfg.userCode}`;
  const result = spawnSync(astroBin, ["build"], {
    cwd: cfg.siteDir,
    stdio: "inherit",
    env: {
      ...process.env,
      GRUG_PAGES_BASE: basePath,
      GRUG_PAGES_SITE: cfg.siteUrl,
      // Carousels the lint above fully checked; <Carousel> stays quiet about those so each warning prints once.
      GRUG_PAGE_LINTED: JSON.stringify(covered),
      ASTRO_TELEMETRY_DISABLED: "1",
    },
  });

  if (result.error) {
    fail(`Failed to run astro build: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const reason = result.signal ? `terminated by signal ${result.signal}` : `exited with code ${result.status}`;
    fail(`astro build ${reason}`);
  }

  const distDir = join(cfg.siteDir, "dist");
  const { totalBytes } = verifyDist(distDir, slug);

  const meta = {
    builtAt: new Date().toISOString(),
    userCode: cfg.userCode,
    siteUrl: cfg.siteUrl,
    slugs,
    totalBytes,
  };
  writeFileSync(join(distDir, ".build-meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  if (slug) {
    process.stdout.write(`BUILT ${slug} -> ${cfg.siteUrl}/${cfg.userCode}/${slug}/\n`);
  } else {
    process.stdout.write(`BUILT index (${slugs.length} pages) -> ${cfg.siteUrl}/${cfg.userCode}/\n`);
  }
}

function stopExistingPreview(stateFile) {
  if (!existsSync(stateFile)) return false;
  let stopped = false;
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (state && typeof state.pid === "number") {
      try {
        process.kill(state.pid, "SIGTERM");
        stopped = true;
      } catch {}
    }
  } catch {}
  try {
    unlinkSync(stateFile);
  } catch {}
  return stopped;
}

function cmdServeInternal(args) {
  let distDir = null;
  let userCode = "local";
  let port = 0;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dist") distDir = args[++i];
    else if (arg === "--code") userCode = args[++i];
    else if (arg === "--port") port = Number(args[++i] ?? 0);
  }

  if (!distDir || !existsSync(distDir)) {
    fail(`Dist directory missing: ${distDir}`);
  }

  const handler = createStaticHandler({ rootDir: distDir, basePath: `/${userCode}` });
  const server = createServer(handler);

  server.on("error", (err) => {
    fail(`Preview server error: ${err.message}`);
  });

  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    process.stdout.write(`READY ${boundPort}\n`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function cmdPreview(cfg, args) {
  let slug = null;
  let port = 0;
  let daemon = false;
  let stateFile = DEFAULT_PREVIEW_STATE;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--port" && i + 1 < args.length) {
      port = Number(args[++i]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--daemon") {
      daemon = true;
    } else if (arg === "--state-file" && i + 1 < args.length) {
      stateFile = args[++i];
    } else if (!arg.startsWith("-") && !slug) {
      slug = arg;
    } else {
      fail(`Unknown argument for preview: ${arg}`);
    }
  }

  if (slug) validateSlug(slug);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`Invalid port: ${port}`);
  }

  const distDir = join(cfg.siteDir, "dist");
  if (!existsSync(join(distDir, "index.html"))) {
    fail(`Built site not found at ${distDir}. Run "grug-page build" first.`);
  }

  if (daemon) {
    stopExistingPreview(stateFile);
    const child = spawn(
      process.execPath,
      [__filename, "__serve", "--dist", distDir, "--code", cfg.userCode, "--port", String(port)],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const boundPort = await new Promise((resolvePort, rejectPort) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      const timer = setTimeout(() => {
        rejectPort(new Error(`Timed out waiting for preview server to start. ${stderrBuf.trim()}`));
      }, 10_000);

      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString("utf8");
        const match = /^READY\s+(\d+)\r?\n/m.exec(stdoutBuf);
        if (match) {
          clearTimeout(timer);
          resolvePort(Number(match[1]));
        }
      });
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        rejectPort(new Error(`Preview server exited early (code ${code}): ${stderrBuf.trim()}`));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        rejectPort(err);
      });
    });

    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();

    const state = {
      pid: child.pid,
      port: boundPort,
      userCode: cfg.userCode,
      distDir,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const homeUrl = `http://127.0.0.1:${boundPort}/${cfg.userCode}/`;
    const previewUrl = slug ? `${homeUrl}${slug}/` : homeUrl;
    process.stdout.write(`PREVIEW_URL=${previewUrl}\nHOME_URL=${homeUrl}\n`);
    return;
  }

  // Foreground preview
  const handler = createStaticHandler({ rootDir: distDir, basePath: `/${cfg.userCode}` });
  const server = createServer(handler);
  server.on("error", (err) => fail(`Preview server error: ${err.message}`));
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    const homeUrl = `http://127.0.0.1:${boundPort}/${cfg.userCode}/`;
    const previewUrl = slug ? `${homeUrl}${slug}/` : homeUrl;
    process.stdout.write(`PREVIEW_URL=${previewUrl}\nHOME_URL=${homeUrl}\n`);
  });
}

function cmdPreviewStop(args) {
  let stateFile = DEFAULT_PREVIEW_STATE;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--state-file" && i + 1 < args.length) {
      stateFile = args[++i];
    }
  }
  const stopped = stopExistingPreview(stateFile);
  process.stdout.write(stopped ? "Preview server stopped.\n" : "No preview server running.\n");
}

function cmdList(cfg) {
  if (!existsSync(cfg.pagesDir)) {
    process.stdout.write("No pages found.\n");
    return;
  }

  const rows = [];
  for (const entry of readdirSync(cfg.pagesDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    let slug = null;
    let filePath = null;
    if (entry.isDirectory() && SLUG_RE.test(entry.name)) {
      const mdx = join(cfg.pagesDir, entry.name, "index.mdx");
      const md = join(cfg.pagesDir, entry.name, "index.md");
      if (existsSync(mdx)) {
        slug = entry.name;
        filePath = mdx;
      } else if (existsSync(md)) {
        slug = entry.name;
        filePath = md;
      }
    } else if (entry.isFile() && /\.(mdx|md)$/.test(entry.name)) {
      const s = entry.name.replace(/\.(mdx|md)$/, "");
      if (SLUG_RE.test(s)) {
        slug = s;
        filePath = join(cfg.pagesDir, entry.name);
      }
    }
    if (!slug || !filePath) continue;
    const fm = parseFrontmatter(readFileSync(filePath, "utf8"));
    rows.push({
      slug,
      date: String(fm?.data?.updated || fm?.data?.date || ""),
      title: String(fm?.data?.title || slug),
    });
  }

  rows.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  if (rows.length === 0) {
    process.stdout.write("No pages found.\n");
    return;
  }
  for (const row of rows) {
    process.stdout.write(`${row.date || "----------"}  ${row.slug}  ${row.title}\n`);
  }
}

const IMAGE_MAX_EDGE = 2000;
const IMAGE_CHECK =
  "Check before use: open actual image. Confirm place, season, product version, or data period. Use only if it helps reader decide. " +
  "Alt: what reader needs to see. Chart or map: put takeaway in nearby text if labels too small on phone. " +
  "Caption: one short useful fact; skip if text already says it. Credit creator, link original source page, add license where required. " +
  'Transparent image with dark labels? Re-run with --background paper.';

/** A JSX string attribute value: no double quotes (MDX can't escape them) and no line breaks. */
function jsxAttr(value) {
  return String(value).replace(/\s+/g, " ").trim().replace(/"([^"]*)"/g, "\u201c$1\u201d").replace(/"/g, "\u2019");
}

function loadSharp() {
  try {
    return createRequire(join(TEMPLATE_ROOT, "package.json"))("sharp");
  } catch {
    return null;
  }
}

async function cmdImage(cfg, args) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const m = /^--(alt|caption|credit|href|background)(?:=(.*))?$/.exec(arg);
    if (m) {
      opts[m[1]] = m[2] !== undefined ? m[2] : args[++i];
      if (opts[m[1]] === undefined) fail(`--${m[1]} needs a value`);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      fail(`Unknown argument for image: ${arg}`);
    }
  }
  const [slug, url] = positional;
  if (!slug || !url || positional.length > 2) {
    fail('Usage: grug-page image <slug> <direct-image-url> --alt "what it shows" [--credit "Source"] [--href <source page>] [--caption "..."] [--background paper]');
  }
  validateSlug(slug);
  const pageDir = join(cfg.pagesDir, slug);
  if (!existsSync(join(pageDir, "index.mdx")) && !existsSync(join(pageDir, "index.md"))) {
    fail(`No page "${slug}" yet. Run grug-page init ${slug} first.`);
  }
  if (opts.background !== undefined && opts.background !== "paper") {
    fail('--background only takes "paper" (a light surface for transparent graphics with dark ink)');
  }
  if (!opts.alt || !opts.alt.trim()) fail('--alt is required: say what the image shows, e.g. --alt "Hanging Lake under snow"');

  let fetched;
  try {
    fetched = await fetchImage(url);
  } catch (err) {
    const reason = err?.message || String(err);
    const hint = /cap/.test(reason) ? " Try a smaller copy of the same image (e.g. Wikimedia's /thumb/.../1920px-<file> URL)." : "";
    fail(`could not fetch image: ${reason}${hint}`);
  }
  let { bytes, type } = fetched;
  let width = null;
  let height = null;
  let note = "";
  const sharp = loadSharp();
  if (sharp) {
    try {
      const meta = await sharp(bytes, { animated: type.ext === "gif" }).metadata();
      width = meta.width ?? null;
      height = meta.pageHeight ?? meta.height ?? null;
      // Re-encode every still image: caps the long edge, applies EXIF rotation, and strips metadata (GPS, camera)
      // so what lands on the page (and its copy in dist/) is small and clean. GIFs stay as they are to keep animation.
      if (type.ext !== "gif") {
        const before = `${width}×${height}`;
        let pipeline = sharp(bytes).rotate().resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true });
        if (type.ext === "jpg") pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
        else if (type.ext === "png") pipeline = pipeline.png({ compressionLevel: 9 });
        else if (type.ext === "webp") pipeline = pipeline.webp({ quality: 85 });
        else if (type.ext === "avif") pipeline = pipeline.avif({ quality: 60 });
        const out = await pipeline.toBuffer({ resolveWithObject: true });
        bytes = out.data;
        width = out.info.width;
        height = out.info.height;
        note = `${width}×${height}` === before ? " (re-encoded, metadata stripped)" : ` (downscaled from ${before}, metadata stripped)`;
      }
    } catch (err) {
      fail(`the file isn't a readable image: ${err?.message || String(err)}`);
    }
  }

  const imgDir = join(pageDir, "img");
  mkdirSync(imgDir, { recursive: true });
  const file = `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.${type.ext}`;
  const target = join(imgDir, file);
  if (!existsSync(target)) writeFileSync(target, bytes);
  if (width && height) writeSize(imgDir, file, width, height);

  const href = opts.href || fetched.finalUrl;
  let credit = opts.credit;
  if (!credit) {
    try {
      credit = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      credit = "Source";
    }
  }
  const attrs = [
    `src="img/${file}"`,
    `alt="${jsxAttr(opts.alt)}"`,
    ...(opts.caption ? [`caption="${jsxAttr(opts.caption)}"`] : []),
    `credit="${jsxAttr(credit)}"`,
    `href="${jsxAttr(href)}"`,
    ...(opts.background ? [`background="${opts.background}"`] : []),
  ];
  const dims = width && height ? `${width}×${height}, ` : "";
  process.stdout.write(
    `SAVED ${slug}/img/${file} (${dims}${(bytes.length / 1024).toFixed(0)} KB ${type.ext})${note}\n` +
      `Add Figure to the page's import line (import { ..., Figure } from "@components/mdx";), then place:\n` +
      `<Figure ${attrs.join(" ")} />\n` +
      `${IMAGE_CHECK}\n`,
  );
}

function printHelp() {
  process.stdout.write(`Usage: grug-page <command> [options]

Commands:
  init <slug> [--title "..."]         Scaffold ~/work/pages/<slug>/index.mdx
  polish <slug>                       Two-stage unslop -> ultracave editing pass
  build [slug]                        Sync pages into ~/site and run astro build (runs lint first)
  lint [slug]                         Check carousels: slide counts, carousels per page, photo fit
  preview [slug] [--port 0] [--daemon] Serve dist/ locally with production CSP
  preview-stop                        Stop daemon preview server
  list                                List pages in ~/work/pages/
  image <slug> <url> --alt "..." [--credit "..."] [--href <page>] [--caption "..."] [--background paper]
                                      Save a direct web image into the page and print its <Figure>
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }
  if (cmd === "__serve") {
    cmdServeInternal(rest);
    return;
  }
  const cfg = loadConfig();
  switch (cmd) {
    case "init":
      cmdInit(cfg, rest);
      break;
    case "polish":
      cmdPolish(cfg, rest);
      break;
    case "build":
      await cmdBuild(cfg, rest);
      break;
    case "lint":
      await cmdLint(cfg, rest);
      break;
    case "preview":
      await cmdPreview(cfg, rest);
      break;
    case "preview-stop":
      cmdPreviewStop(rest);
      break;
    case "list":
      cmdList(cfg);
      break;
    case "image":
      await cmdImage(cfg, rest);
      break;
    default:
      fail(`Unknown command "${cmd}". Run "grug-page --help" for usage.`);
  }
}

main().catch((err) => fail(err?.message || String(err)));
