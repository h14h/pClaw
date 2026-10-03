# Page style guide

You are making a page for one person who asked for it. It should read like a good internal doc: calm, dense, correct, and done. Start from `template/` (copy the whole folder, including `fonts/`), keep `style.css` as it is, and build the page in `index.html` out of the pieces below.

## Look and tone

- Plain text on a plain background, one column, lots of it readable at a glance. This is the same tone as pclaw's dashboard.
- No hero banners, gradients, background images, stock photos, icons, emoji, decorative dividers, cards in a grid, or anything animated.
- No marketing copy. Don't write "Discover", "Ultimate guide", "Your journey", "Explore". Write "Three cases that fit" and say which one.
- Lead with the answer. If the person asked for a recommendation, the first section is the pick and the reason. Comparison and details come after.
- Short sentences, concrete nouns, numbers with units. Don't pad.
- One page per request. Don't add a site nav, a home link, a footer with your name, or a "back to top" button.

## Files

```
<slug>/
  index.html     the page; edit this
  style.css      design tokens and components; don't edit, don't add inline styles
  fonts/         Geist and Geist Mono; leave alone
```

- Everything self-contained. No external stylesheets, scripts, fonts, images, iframes, or analytics. The page is on a private network and must work with the internet off.
- Inline `<script>` is allowed for small interactions (sorting a table, a unit toggle). Keep it under ~40 lines, no libraries, and the page must still read correctly with JavaScript off.
- Images only if they carry information (a map, a chart you made, a photo the person sent). Store them next to `index.html`, add `alt` text, keep them under 300 KB.

## Layout

- Wrap everything in `<main class="page">`. The width is fixed at a comfortable reading measure; don't widen it.
- Order: `<header>` (title, lede, meta, optional contents), then `<section>`s each with an `<h2>`, then `<footer class="sources">`.
- Add `<ul class="contents">` to the header only when there are five or more sections. Each item links to a section `id`.
- Use `<h3>` sparingly inside a section. Never go deeper than `h3`.
- Don't make the page longer than it needs to be. A three-option comparison is one screen on a laptop.

## Header

```html
<header>
  <h1>Quiet NAS cases for the living room</h1>
  <p class="lede">Three cases with 4 to 6 bays that stay quiet next to a TV, with prices and the catch on each.</p>
  <p class="meta">Last updated <time datetime="2026-10-02">2 Oct 2026</time> · prices checked the same day · made by pclaw</p>
</header>
```

- `h1`: a specific title, sentence case, under ~60 characters. "Quiet NAS cases for the living room", not "NAS Case Research Report".
- `.lede`: one sentence saying what the page answers. Optional on a tiny page.
- `.meta`: always. The date the page was last updated (both the `datetime` attribute and the text), what was checked when, and "made by pclaw".

## Building blocks

Use these and nothing else. Class names are exact.

**Facts** (`<dl class="facts">`): label and value pairs for an at-a-glance summary. Up to ~8 rows.

```html
<dl class="facts">
  <dt>Price</dt><dd>$149.99 at Amazon, in stock</dd>
  <dt>Bays</dt><dd>8 × 3.5"</dd>
</dl>
```

**Table** (`<div class="table-wrap"><table>`): comparing several things across the same attributes.

```html
<div class="table-wrap">
  <table>
    <thead><tr><th scope="col">Case</th><th scope="col" class="num">Price</th><th scope="col" class="wrap">Catch</th></tr></thead>
    <tbody>
      <tr class="pick"><td>Jonsbo N3</td><td class="num">$150</td><td class="wrap">SFX PSU only; cage runs warm when full</td></tr>
      <tr><td>Fractal Node 304</td><td class="num">$110</td><td class="wrap">Cramped build</td></tr>
    </tbody>
  </table>
</div>
```

- Always inside `.table-wrap` so it scrolls sideways on a phone instead of breaking the layout.
- `class="num"` on every numeric column, header and cells, so figures right-align.
- Cells don't wrap, so a wide table scrolls sideways on a phone. For one column of short phrases (a "Catch" or "Notes" column), add `class="wrap"` to its header and cells. At most one such column.
- `class="pick"` on at most one row: the one you'd choose.
- Six columns at most. More than that, split into two tables or use items.
- Keep cells short. Long explanations go in a paragraph under the table.

**Items** (`<ul class="items">`): a list of things that each have a link, a price and a one-line note. Use for shopping lists, venues, flights, tools.

```html
<ul class="items">
  <li>
    <div class="row">
      <span><a href="https://…">Jonsbo N3</a> <span class="tag accent">pick</span></span>
      <span class="price">$149.99</span>
    </div>
    <p class="note">Amazon, in stock. Two 100 mm fans; swap for Noctuas if the hum bothers you.</p>
  </li>
</ul>
```

**Callout** (`<aside class="callout">`): one short paragraph the reader must not miss. Add `caution` for anything unverified or that could go wrong. At most two per page.

```html
<aside class="callout caution">
  <p><strong>Not verified:</strong> the lead time is from the product page, not a confirmed order.</p>
</aside>
```

**Tag** (`<span class="tag">`): one word next to a name: `pick`, `cheapest`, `sold out`, `tentative`. Add `accent` only for the pick. Never more than one tag per item.

**Details** (`<details><summary>`): for method notes and long asides that most readers will skip. The summary is a plain sentence, not "Click to expand".

**Sources** (`<footer class="sources">`): see below. Always present.

Plain `<p>`, `<ul>`, `<ol>`, `<blockquote>` (for a quoted passage only), `<code>` (for commands, file names, model numbers) and `<pre>` (for a block of commands or config) are fine anywhere.

## Tables or lists?

- Same attributes for several things, and the reader will compare across: table.
- Each thing has its own story, or there's a link and a price per thing: items.
- Steps in order: `<ol>`.
- Facts about one thing: `.facts`.
- Don't put prose in table cells and don't put a comparison in prose.

## Prices, dates, numbers, links

- Prices: currency symbol, no trailing zeros unless cents matter (`$150`, `$149.99` when the cents are real), and where it was seen: "$150 at Amazon". Say "in stock", "ships in 2–3 weeks", or "sold out" when you know.
- Dates: `2 Oct 2026` in text, ISO in `datetime`. Times with a zone when the zone matters: `9:00 PT`. Relative words ("tomorrow", "next week") only next to an absolute date.
- Numbers: units always (`30 dBA`, `8 TB`, `2.4 km`). Ranges with an en dash (`30–31 dBA`). Thousands with commas. Don't give more precision than the source had.
- Links: link the name of the thing, not "here" or the bare URL. Link to the page you actually read. One link per thing; the sources footer holds the rest.
- Measurements the person uses: if they said miles, use miles.

## Uncertainty and sources

- Say what you don't know, right where it matters: "not measured", "price not shown", "unclear whether…". Don't fill gaps with guesses or round numbers that look exact.
- Anything you couldn't verify, or that the reader could be burned by, goes in a `callout caution` with a plain label: "Not verified:", "Changes often:", "Assumes:".
- Distinguish measured from claimed: "30 dBA in ServeTheHome's test" vs "Jonsbo says 'silent'".
- `<footer class="sources">`: an `<ol>` of what you read, each a link with the site name and the page's title, and the date you read it. Also list where prices came from. Only sources you actually opened.

```html
<footer class="sources" id="sources">
  <h2>Sources</h2>
  <ol>
    <li><a href="https://www.servethehome.com/jonsbo-n3-review/">ServeTheHome: Jonsbo N3 review</a>, read 2 Oct 2026</li>
    <li>Prices: Amazon and Newegg product pages, 2 Oct 2026</li>
  </ol>
</footer>
```

## Accessibility

- Semantic elements: `main`, `header`, `section`, `footer`, real headings in order, `th scope="col"`, `time datetime`, `dl` for pairs.
- One `<h1>`. Every `<section>` has an `<h2>` and an `id`.
- Link text makes sense on its own. `alt` on every image; empty `alt=""` only for an image that says nothing.
- Don't convey meaning with colour alone; the `.pick` row also gets the word "pick" somewhere on the page.
- Don't set `font-size` or colours inline. Don't override `style.css`.
- Everything must work with a keyboard and at 200% zoom; the template already does, so just don't add fixed widths or hidden overflow.

## Never

- External requests of any kind (fonts, scripts, styles, images, embeds, analytics, tracking pixels).
- Secrets, tokens, internal hostnames, or anything from the person's private messages that the page doesn't need.
- Invented facts, prices, quotes or links. If you didn't see it, don't write it.
- Forms that submit anywhere, buttons that buy or book, or anything that acts on the person's behalf.
- Emoji, icons, exclamation marks, "Pro tip", "TL;DR", bold whole sentences, ALL CAPS, headings as questions.
- A navbar, logo, hero, sidebar, cookie notice, dark-mode toggle, share buttons, comments.

## Before you publish

- Open `index.html` and read it top to bottom as the person. Does the first screen answer the question?
- Every number has a unit and a source. Every price has a place and a date. Every link was opened.
- `.meta` has today's date. Sources footer is present and only lists what you read.
- Delete any section that says nothing. Delete the contents list if the page is short.
- No `style=""`, no `<script src>`, no `http` references other than links the reader may follow.
