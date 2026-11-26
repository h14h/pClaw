---
name: grug-page
description: Build, polish, compile, and visually inspect a static Astro + Svelte 5 + MDX page under ~/work/pages/<slug>/ for publishing to the user's private grug.h14h.com shelf. Use for research reports, comparisons, explainers, itineraries, checklists, guides, or interactive calculators/tools instead of writing raw markdown files.
---

# Building a grug page

## When to make a page

Make a page only for substantive deliverables the user will read, revisit, compare, or interact with:
- 3+ option comparisons with tradeoffs
- Multi-claim fact-checks
- Deep explainers, guides, or trip itineraries
- Interactive calculators, planners, or small Svelte 5 tools

Do **not** build a page for single-fact lookups, quick price/availability checks, yes/no checks, short 1–3 item answers, or quick follow-up math — answer those directly in chat. Prefer building a page over writing or sending a `.md` file unless the user specifically asks for raw markdown, plain text, CSV, SQL, or another file format.

## At most one page per topic (in-place edits)

- Before creating a new slug, always run `grug-page list`.
- If a page on the same topic or target already exists (or the prompt names an existing `<slug>`), **edit that existing `~/work/pages/<slug>/index.mdx` in place** (set `updated: "YYYY-MM-DD"` in frontmatter), re-run `grug-page polish <slug>`, rebuild, and re-verify.
- **Never** create a duplicate slug for the same topic.

## Brevity and zero-repetition rules

- **One fact, one home (strict zero-repetition):** If a figure, price, or spec is in `<StatGrid>` or a comparison table, do **not** re-narrate it in prose paragraphs below. Use prose strictly for verdicts, tradeoffs, and non-obvious caveats.
- **Brevity target:** Aim for **~400–900 words** for comparisons and explainers (max **~1,200 words** for multi-claim fact-checks).
- **Hide secondary detail:** Push raw plan IDs, methodology notes, edge-case breakdowns, and supporting tables into `<Details summary="...">` accordions so the main flow stays crisp and scannable.

## Screen one: answer first

- Verdict or recommendation goes in `subtitle` and in first paragraph. Reader gets answer on first screen, no scrolling.
- Nothing before answer: no hero photo, no `<StatGrid>`, no table above lead. Photo or stats come after.
- `summary` stands alone. It becomes share card text: say what page is and its answer, no "this page", no "see below".
- Opening photo still on first screen? Give that one `<Figure>` `priority` so it loads first. Only one per page; never below fold.

## Directory layout

Pages live in `~/work/pages/<slug>/` (slug: lowercase letters, digits, hyphens; reuse the existing slug when updating a page):

```text
~/work/pages/<slug>/
  index.mdx                 Required page content + YAML frontmatter
  components/*.svelte       Optional per-page Svelte 5 interactive islands (calculators, planners; never UI the template owns)
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

Required fields: `title`, `date` (`YYYY-MM-DD`), `summary`. Optional: `subtitle`, `updated` (`YYYY-MM-DD`), `tags` (string array). Pages with 3 or more main sections (`##` headings plus `<Sources>`) or 6 or more `##`/`###` headings automatically get Contents, `###` nested under their `##`.

## Built-in MDX components

Import from `@components/mdx`:

```mdx
import { Callout, StatGrid, Stat, Details, Sources, Tabs, Figure, Carousel } from "@components/mdx";
```

- `<Callout type="note" | "tip" | "warn" title="Optional heading">...</Callout>` — key takeaway or caveat (max 2-3 per page; use `warn` for unverified facts or risks).
- `<StatGrid columns={3}><Stat label="Pick" value="Jonsbo N3" note="$150 at Amazon" />...</StatGrid>` — compact at-a-glance metrics (`columns`: `2`, `3`, or `4`).
- `<Tabs client:load labels={["Option A", "Option B"]}><div>...</div><div>...</div></Tabs>` — interactive tabbed views (also accepts `tabs={[{ label, content }]}`). Always include `client:load` on Svelte islands (`Tabs` and any custom `components/*.svelte`).
- `<Details summary="Methodology and assumptions" open={false}>...</Details>` — collapsible secondary detail.
- `<Figure src="img/3f9a1c2b7d4e.jpg" alt="..." caption="..." credit="..." href="..." [background="paper"] [zoom={false}] [priority] />` — a real image saved with `grug-page image` (see Images below). Never hand-write `src`; paste the line the command prints. Readers tap any Figure to open full screen: zoom, pan, panoramas big. `zoom={false}` only for logos and small marks. `priority` only for an opening photo on the first screen.
- `<Carousel label="Leg 2 photos: Myrdal to Flåm">` wrapping 3–6 `<Figure />` lines — swipeable photo strip (see Carousels below). No `client:load`.
- `<Sources checked="2026-11-24">` wrapping a numbered Markdown list — always include at the bottom. One line per source: `1. [Title, Publisher](url). What it supports.` Link only title and publisher; the note after the link is plain text, a few words (`Route, season, luggage, connections.`). `checked` is the date you last opened every link; re-check all, not one.
- Standard Markdown tables work out of the box (automatically wrapped for mobile horizontal scroll with `tabular-nums`).
- **One table, one job.** Route or summary table: short cells only (e.g. `Leg | Mode | Time`). What you see, tips, and why go in each section, not in a table cell. Wrap short summary tables in `<Table compact>` (blank lines around the Markdown table inside) so they fit phones; add `Table` to the import.
- **Never use a standalone `Rank` or `#` column as Column 1** — put the identifying name (Provider, Option, Site, Scenario) in Column 1 (e.g. `1. GFiber Webpass`) so future tables are naturally compact and self-identifying.
- **Keep column headings short (1–2 words)**, like `Rate Field`, `All districts`, `City share`, `First year`. Put site prefixes (`A:`/`B:`), units, and bases such as "21.5%" in a sentence right above or below the table, never in the heading. Long headings wrap and widen the table on phones.

## Images

Real images make pages much better when they show something words can't: the place, the product, the chart, the map, the logo. Use them; just never as filler.

- **When:** a photo of the actual place/product/thing, a source's chart or map, an official logo for options being compared. 1–4 per page (a carousel counts as one), each next to the section it illustrates. Skip stock photos, mood images, AI art, and anything decorative.
- **Find a direct image URL** (the file itself, ending in or serving `.jpg`/`.png`/`.webp`/`.gif`/`.avif`, not the page around it):
  - the `og:image` of a source article you read (`agent-browser open <url>` then `agent-browser eval "document.querySelector('meta[property=\"og:image\"]')?.content"`);
  - Wikimedia Commons: open the file page and use the "Original file" link (`upload.wikimedia.org/...`). Originals over 5 MB get refused; use a standard-size copy instead (1280 or 1920 wide): `https://upload.wikimedia.org/wikipedia/commons/thumb/<a>/<ab>/<File>/1920px-<File>`;
  - official press kits / media pages of the venue, company, or agency.
- **Save it into the page** (downloads to `~/work/pages/<slug>/img/`, served from this site so the CSP stays strict and readers aren't tracked):
  ```bash
  grug-page image <slug> "<direct-image-url>" --alt "What the image shows" --credit "Creator / source" --href "<original source page>" [--caption "One short useful fact"] [--background paper]
  ```
  It refuses non-images, SVG, files over 5 MB, and private addresses, downsizes huge files, and prints the `<Figure ... />` line to paste. Add `Figure` to the page's `@components/mdx` import.
- **Check the image itself before using it.** Open actual image. Confirm place, season, product version, or data period. Use only if it helps reader decide. Alt says what reader needs to see. Chart or map: put takeaway in nearby text if labels too small on phone. Caption adds one short useful fact; omit if surrounding text already does that job. Credit creator and link original source page, with license where required.
- Transparent image with dark labels or lines (maps, logos, diagrams)? Add `--background paper` so it sits on a light surface in dark mode too.
- Panorama (2:1 or wider)? Readers open it full screen to pan, so save a big copy: Wikimedia `/thumb/` at 3840px, or the original. `grug-page image` warns when its short edge is under 700px.
- If the command fails, try another source or leave the image out; never link remote images.

### Carousels

- Use up to three carousels per report. Keep them where several views explain something a single photo cannot. For other sections, choose one representative photo or omit it.
- 3–6 genuinely different views of one place or thing. Never filler. Same view twice: cut one.
- Every slide: verified, relevant photo saved with `grug-page image`, real alt, credit with link. Same checks as single images.
- Carousel caption: one sentence, under 100 characters. Put route advice in section text.
- Credit stays on image (`credit` + `href`). Do not list photo credits again in `<Sources>`; Sources is for facts.
- Only `<Figure />` lines inside. `label` says what slides show, for screen readers.
  ```mdx
  <Carousel label="Nærøyfjord from the boat">
  <Figure src="img/…" alt="…" caption="…" credit="…" href="…" />
  <Figure src="img/…" alt="…" caption="…" credit="…" href="…" />
  <Figure src="img/…" alt="…" caption="…" credit="…" href="…" />
  </Carousel>
  ```
- Similar shapes: slides share one frame. Panorama or tall shot among landscapes shows small; build warns. Give it own `<Figure>` if full view matters.
- Use template `<Carousel>`, `<Tabs>`, `<Figure>`. Never write page-local components for UI the template owns (carousels, galleries, tabs, accordions). `grug-page lint <slug>` (and `build`) warns on carousels over 8 slides, over 3 per page, photos filling under 70% of the frame, or a page-local carousel.

## Sourcing and content rules

- Every fact, price, spec, date, and URL must come from a source you actually read during this job.
- State check dates for prices, availability, and anything that changes.
- Mark anything unconfirmed explicitly with `<Callout type="warn" title="Not verified">`.
- Never load external scripts, stylesheets, fonts, iframes, or remote image URLs (`grug-page build` rejects them and production CSP blocks them). Save images with `grug-page image` instead.
- Never make network calls from Svelte islands (`connect-src 'none'` in production CSP).
- Never put secrets, tokens, or unrelated private details on a page.

## Required 4-step workflow

1. **Check existing pages and write/edit factual draft**: Run `grug-page list` first. If a page on the topic already exists (or the prompt specifies an existing slug), edit `~/work/pages/<slug>/index.mdx` in place (updating `updated: "YYYY-MM-DD"`). Otherwise scaffold with `grug-page init <slug> --title "..."`. Keep the draft tight (~400–900w; max ~1,200w for multi-claim fact-checks), zero-repetition across `StatGrid`/tables/prose, with `<Details>` for raw IDs/methodology, `<Sources>`, and any custom Svelte 5 island in `components/`.
2. **Run two-stage editorial polish**:
   ```bash
   grug-page polish <slug>
   ```
   This runs fresh subagent passes (`unslop` then `ultracave`) on a staged `.polish-stage.mdx` copy while preserving `.draft.mdx` and `.unslop.mdx` backups and verifying frontmatter/imports/MDX integrity (leaving `index.mdx` untouched on any error or timeout).
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
   - Interact with any `<Tabs>`, `<Carousel>`, or custom Svelte island and check `agent-browser console` / `agent-browser errors` for **zero** console or CSP errors.
   - Fix anything broken and re-run `grug-page build <slug>` if needed.
   - Always clean up before finishing (if you opened a named `--session "$S"`, close that exact session):
     ```bash
     agent-browser close
     # or, when using a named session:
     # agent-browser --session "$S" close
     grug-page preview-stop
     ```
5. **Report back**: Your final response is only `Built slug: <slug>`, `TL;DR: <headline verdict or number, under 20 words>`, and `Decision needed: <under 20 words>` if the user must act. No breakdown, lists, or sources: the page holds them, and the front agent shares just the link and TL;DR.

## Progress updates (keep internal steps invisible)

Never mention internal page-building or verification steps (`grug-page`, `polish`, `unslop`, `ultracave`, Astro, MDX, `preview`, `agent-browser`, or checking desktop/mobile/light/dark/console/CSP) in `report_progress` or any user-facing status updates. At most send one plain user-facing progress note when switching from research to building the page (e.g. `"Building a comparison page for you"`), then stay quiet through polish, build, and visual checks until returning the final slug.
