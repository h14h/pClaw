import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import mdx from "@astrojs/mdx";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

function readGrugConfig() {
  const configPath = process.env.GRUG_PAGES_CONFIG || join(homedir(), ".config", "grug-pages.json");
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function normalizeBase(raw) {
  if (!raw || raw === "/") return "/";
  const trimmed = String(raw).trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "/";
}

const cfg = readGrugConfig();
const rawBase =
  process.env.GRUG_PAGES_BASE ||
  (process.env.GRUG_PAGES_CODE ? `/${process.env.GRUG_PAGES_CODE}` : undefined) ||
  (cfg.userCode || cfg.code ? `/${cfg.userCode || cfg.code}` : "/");

const base = normalizeBase(rawBase);
const site = (
  process.env.GRUG_PAGES_SITE ||
  process.env.GRUG_PAGES_SITE_URL ||
  cfg.siteUrl ||
  "https://grug.h14h.com"
).replace(/\/+$/, "");

export default defineConfig({
  output: "static",
  site,
  base,
  trailingSlash: "always",
  integrations: [mdx(), svelte()],
  markdown: {
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "github-dark-dimmed",
      },
      wrap: false,
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
