---
name: grug-page
description: Build, polish, compile, and visually inspect a static Astro + Svelte 5 + MDX page under ~/work/pages/<slug>/ for publishing to the user's private grug.h14h.com shelf. Use for research reports, comparisons, explainers, itineraries, checklists, guides, or interactive calculators/tools instead of writing raw markdown files.
---

# Building a grug page

## When to make a page

Make a page for any substantive deliverable the user will read, revisit, compare, or interact with:
- Research reports, product/vendor comparisons, technical explainers
- Trip itineraries, packing/prep checklists, reference guides
- Interactive calculators, planners, or small Svelte 5 tools

Prefer building a page over writing or sending a `.md` file unless the user specifically asks for raw markdown, plain text, CSV, SQL, or another file format.

## Directory layout

Pages live in `~/work/pages/<slug>/` (slug: lowercase letters, digits, hyphens; reuse the existing slug when updating a page):

```text
~/work/pages/<slug>/
  index.mdx                 Required page content + YAML frontmatter
  components/*.svelte       Optional per-page Svelte 5 interactive islands
  assets/*                  Optional local images (.png, .jpg, .webp, .svg)
```

Import local islands or images directly from `index.mdx`:
```mdx
import CostCalculator from "./components/CostCalculator.svelte";
import chartImg from "./assets/chart.png";
```

## Frontmatter

Every `index.mdx` starts with YAML frontmatter:

```yaml
---
title: "Quiet NAS cases for the living room"
subtitle: "Three 4-to-6 bay cases tested under 32 dBA, with verified prices."
date: "2026-11-24"
updated: "2026-11-24"
summary: "Side-by-side comparison of three quiet NAS enclosures, noise measurements, and buying caveats."
tags: ["hardware", "nas"]
---
```

Required fields: `title`, `date` (`YYYY-MM-DD`), `summary`. Optional: `subtitle`, `updated` (`YYYY-MM-DD`), `tags` (string array). Pages with 4 or more `##` headings automatically get a Table of Contents.

## Built-in MDX components

Import from `@components/mdx`:

```mdx
import { Callout, StatGrid, Stat, Details, Sources, Tabs } from "@components/mdx";
```

- `<Callout type="note" | "tip" | "warn" title="Optional heading">...</Callout>` — key takeaway or caveat (max 2-3 per page; use `warn` for unverified facts or risks).
- `<StatGrid columns={3}><Stat label="Pick" value="Jonsbo N3" note="$150 at Amazon" />...</StatGrid>` — compact at-a-glance metrics (`columns`: `2`, `3`, or `4`).
- `<Tabs client:load labels={["Option A", "Option B"]}><div>...</div><div>...</div></Tabs>` — interactive tabbed views (also accepts `tabs={[{ label, content }]}`). Always include `client:load` on Svelte islands (`Tabs` and any custom `components/*.svelte`).
- `<Details summary="Methodology and assumptions" open={false}>...</Details>` — collapsible secondary detail.
- `<Sources checked="2026-11-24">` wrapping a numbered Markdown list of links — always include at the bottom.
- Standard Markdown tables work out of the box (automatically wrapped for mobile horizontal scroll with `tabular-nums`).

## Sourcing and content rules

- Every fact, price, spec, date, and URL must come from a source you actually read during this job.
- State check dates for prices, availability, and anything that changes.
- Mark anything unconfirmed explicitly with `<Callout type="warn" title="Not verified">`.
- Never load external scripts, stylesheets, fonts, iframes, or remote image URLs (`grug-page build` rejects them and production CSP blocks them). Download any needed image locally into `assets/` and verify it is a real image first.
- Never make network calls from Svelte islands (`connect-src 'none'` in production CSP).
- Never put secrets, tokens, or unrelated private details on a page.

## Required 4-step workflow

1. **Write factual first draft** in `~/work/pages/<slug>/index.mdx` (you can scaffold with `grug-page init <slug> --title "..."`). Include all researched facts, numbers, units, dates, URLs, tables, `<Sources>`, and any custom Svelte 5 island in `components/`.
2. **Run two-stage editorial polish**:
   ```bash
   grug-page polish <slug>
   ```
   This runs fresh subagent passes (`unslop` then `ultracave`) while preserving `.draft.mdx` and `.unslop.mdx` backups and verifying frontmatter/imports/MDX integrity.
3. **Build and validate**:
   ```bash
   grug-page build <slug>
   ```
   Syncs `~/work/pages/` into `~/site`, runs `astro build` with the user's base path, checks for external asset leaks and size limits, and prints `BUILT <slug> -> ...`.
4. **Visually inspect with exact-parity local preview**:
   ```bash
   grug-page preview <slug> --daemon
   ```
   Open the printed `PREVIEW_URL` in `agent-browser`:
   - Check desktop (`1280x800`) and mobile (`390x844`) viewports for overflow, broken tables, or awkward layout.
   - Toggle dark mode (`#theme-toggle`) and verify contrast and custom islands look right in both light and dark themes.
   - Interact with any `<Tabs>` or custom Svelte island and check `agent-browser console` / `agent-browser errors` for **zero** console or CSP errors.
   - Fix anything broken and re-run `grug-page build <slug>` if needed.
   - Always clean up before finishing:
     ```bash
     agent-browser close
     grug-page preview-stop
     ```
5. **Report back**: Tell the front agent the built `<slug>` and a concise summary of what the page covers so it can call `publish_page` and deliver the live link to the user.

## Progress updates (keep internal steps invisible)

Never mention internal page-building or verification steps (`grug-page`, `polish`, `unslop`, `ultracave`, Astro, MDX, `preview`, `agent-browser`, or checking desktop/mobile/light/dark/console/CSP) in `report_progress` or any user-facing status updates. At most send one plain user-facing progress note when switching from research to building the page (e.g. `"Building a comparison page for you"`), then stay quiet through polish, build, and visual checks until returning the final slug.
