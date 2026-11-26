// Editorial lint for a page's index.mdx: the mechanical half of bots/grug/skills/grug-page/EDITORIAL.md.
// Only things a regex can check reliably; every result is advice (a warning), never a build failure.
// `grug-page lint` and `grug-page build` print these next to the carousel warnings.

import { readAttrs } from "./carousel.mjs";

export const CAPTION_MAX = 100;
export const SUMMARY_MAX = 160;
export const SOURCE_LINK_MAX = 70;
export const TABLE_HEADING_MAX = 14;
export const STATS_MAX = 4;
export const CALLOUTS_MAX = 3;
/** A table whose every cell is at most this long reads fine compact on a phone. */
export const COMPACT_CELL_MAX = 24;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// A JSX opening tag, allowing ">" inside quoted or braced attribute values.
const tagPattern = (name) => new RegExp(`<${name}\\b(?:"[^"]*"|'[^']*'|\\{[^}]*\\}|[^'"{}>])*>`, "g");

/** Captions that lean on the page around them (the viewer shows a caption alone). */
const RELATIVE_CAPTION =
  /\b(?:next|previous|last|following|preceding) (?:photo|image|picture|slide|shot)\b|\b(?:photo|image|picture|map|chart|table|figure|section) (?:above|below)\b|\b(?:see|shown|pictured) (?:above|below)\b|\bleg \d+\b|\bslides?\b/i;
/** Summary wording that only makes sense on the page itself (the summary is the share card text). */
const SUMMARY_DEPENDENT = /\bthis (?:page|guide|report|article|post)\b|\bsee (?:below|above)\b|\bbelow\b/i;
/** Dates that say when something was checked, as opposed to travel dates or publication dates. */
const CHECKED_DATE =
  /\b(?:checked|verified|accessed|retrieved|as of|data effective)\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2} [A-Za-z]{3,9}\.? \d{4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})/gi;

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const data = {};
  if (!m) return { data, body: text };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    data[kv[1]] = value;
  }
  return { data, body: text.slice(m[0].length) };
}

/** A date in any of the forms pages use, as YYYY-MM-DD, or null. */
export function isoDate(raw) {
  const text = raw.trim().replace(/\./g, "");
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})$/.exec(text);
  let day;
  let month;
  let year;
  if (m) [day, month, year] = [m[1], m[2], m[3]];
  else {
    m = /^([A-Za-z]{3,9}) (\d{1,2}),? (\d{4})$/.exec(text);
    if (!m) return null;
    [month, day, year] = [m[1], m[2], m[3]];
  }
  const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  if (index < 0) return null;
  return `${year}-${String(index + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const plain = (cell) =>
  cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\\\*/g, "*")
    .trim();

/** Markdown tables in a body: header cells, body rows, and whether a <Table compact> wraps them. */
function tables(body) {
  const lines = body.split(/\r?\n/);
  const found = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
    const split = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map(plain);
    const header = split(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) rows.push(split(lines[j]));
    const before = lines.slice(0, i).join("\n");
    const lastOpen = before.lastIndexOf("<Table");
    const compact = lastOpen >= 0 && !before.slice(lastOpen).includes("</Table>") && /<Table\b[^>]*\bcompact\b/.test(before.slice(lastOpen));
    found.push({ header, rows, compact });
    i = j;
  }
  return found;
}

/**
 * Editorial warnings for one page (the whole index.mdx text). Empty means nothing to fix. Each warning says what
 * to change; EDITORIAL.md says why.
 */
export function lintPage(text) {
  const warnings = [];
  const { data, body: rawBody } = frontmatter(text);
  const body = rawBody.replace(/```[\s\S]*?```/g, "");

  // Frontmatter: the verdict and a share-card summary
  if (!data.subtitle) warnings.push("No subtitle. Put the verdict there: the reader's answer on screen one.");
  const summary = data.summary ?? "";
  if (summary.length > SUMMARY_MAX) {
    warnings.push(`Summary is ${summary.length} characters; keep it under ${SUMMARY_MAX} so the share card shows all of it.`);
  }
  if (SUMMARY_DEPENDENT.test(summary)) {
    warnings.push(`Summary says "${SUMMARY_DEPENDENT.exec(summary)[0]}". It becomes the share card text: make it stand alone.`);
  }

  // The lead comes first: no photo, stats or table above the first paragraph
  // Each component block counts as one line, so text inside a Callout or Details is never taken for the lead.
  const blocks = body
    .replace(/<(Callout|Details|StatGrid|Carousel|Table|Sources|Tabs)\b[\s\S]*?<\/\1>/g, "<$1 />")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^import\s/.test(line) && !/^export\s/.test(line));
  // The lead: the first plain paragraph (not a heading, list, table, quote or component). Bold openers count.
  const isParagraph = (line) => /^\*\*/.test(line) || /^[^<#|>\-*+\d!\[{}]/.test(line) || /^\d+[^.\d)]/.test(line);
  const lead = blocks.findIndex(isParagraph);
  const early = new Set();
  for (const line of lead < 0 ? blocks : blocks.slice(0, lead)) {
    const what = /^<(Figure|StatGrid|Carousel)\b/.exec(line)?.[1] ?? (/^\|/.test(line) ? "A table" : null);
    if (what) early.add(what === "A table" ? what : `<${what}>`);
  }
  if (early.size) warnings.push(`${[...early].join(", ")} before the lead paragraph. Lead first; photo, stats and tables after it.`);

  // Images: captions that stand alone; credits with a source link
  const carousels = [...body.matchAll(/<Carousel\b[\s\S]*?<\/Carousel>/g)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of body.matchAll(tagPattern("Figure"))) {
    const attrs = readAttrs(m[0]);
    const name = attrs.src ?? "a Figure";
    const caption = attrs.caption ?? "";
    const inCarousel = carousels.some(([a, b]) => m.index > a && m.index < b);
    if (inCarousel && caption.length > CAPTION_MAX) {
      warnings.push(`Carousel caption for ${name} is ${caption.length} characters; one sentence under ${CAPTION_MAX}.`);
    }
    const relative = RELATIVE_CAPTION.exec(caption);
    if (relative) {
      warnings.push(`Caption for ${name} says "${relative[0]}". Captions show alone in the viewer: name the place or thing instead.`);
    }
    if (!attrs.credit) warnings.push(`${name} has no credit. Name the creator (and license) on the image.`);
    else if (!attrs.href) warnings.push(`${name} credit has no href. Link the original source page.`);
  }

  // Stats: few, each with its scope
  for (const grid of body.matchAll(/<StatGrid\b[\s\S]*?<\/StatGrid>/g)) {
    const stats = (grid[0].match(tagPattern("Stat")) ?? []).map(readAttrs);
    if (stats.length > STATS_MAX) warnings.push(`StatGrid has ${stats.length} stats; keep ${STATS_MAX} or fewer, the ones that decide.`);
    const bare = stats.filter((s) => !s.note).map((s) => `"${s.label ?? s.value ?? "?"}"`);
    if (bare.length) warnings.push(`Stat ${bare.join(", ")} has no note. Give each number its scope: what it covers, source or date.`);
  }

  // Callouts: a few, for caveats
  const callouts = (body.match(/<Callout\b/g) ?? []).length;
  if (callouts > CALLOUTS_MAX) warnings.push(`${callouts} Callouts; keep ${CALLOUTS_MAX} or fewer, for real caveats.`);

  // Tables: short headings, the name first, compact when every cell is short
  for (const table of tables(body)) {
    const label = table.header[0] || "table";
    const long = table.header.filter((h) => h.length > TABLE_HEADING_MAX);
    if (long.length) {
      warnings.push(`Table "${label}": heading${long.length === 1 ? "" : "s"} ${long.map((h) => `"${h}"`).join(", ")} over ${TABLE_HEADING_MAX} characters. Short headings; units and bases go in a sentence.`);
    }
    if (/^(#|rank|no\.?)$/i.test(label) && table.header.length >= 3) {
      warnings.push(`Table "${label}" starts with a rank column. Put the name first ("1. Name").`);
    }
    const cells = table.rows.flat();
    if (!table.compact && table.header.length >= 4 && cells.length && cells.every((c) => c.length <= COMPACT_CELL_MAX)) {
      warnings.push(`Table "${label}" has ${table.header.length} columns of short cells. Wrap it in <Table compact> so it fits phones.`);
    }
  }

  // Sources: link only "Title, Publisher"; `checked` is the latest check on the page
  const sources = /<Sources\b([^>]*)>([\s\S]*?)<\/Sources>/.exec(body);
  if (sources) {
    const links = [...sources[2].matchAll(/^\s*\d+\.\s*\[([^\]]+)\]\(/gm)].map((m, i) => ({ n: i + 1, text: m[1] }));
    const long = links.filter((l) => l.text.length > SOURCE_LINK_MAX);
    if (long.length) {
      warnings.push(`Sources: ${long.length} of ${links.length} link texts run over ${SOURCE_LINK_MAX} characters (#${long.slice(0, 3).map((l) => l.n).join(", #")}). Link only "Title, Publisher"; put the note after the link as plain text.`);
    }
    const checked = isoDate(readAttrs(`<x ${sources[1]}>`).checked ?? "");
    if (checked) {
      const later = [...body.matchAll(CHECKED_DATE)].map((m) => ({ raw: m[1], iso: isoDate(m[1]) })).filter((d) => d.iso && d.iso > checked);
      if (later.length) {
        warnings.push(`Sources checked="${checked}" is older than "${later[0].raw}" on the page. Re-check the links and update checked, or fix the date.`);
      }
    }
  } else {
    warnings.push("No <Sources> block. Every page ends with its sources.");
  }

  return warnings;
}
