// Build-time table fixes for <Table>, so pages get them without JS: each body row's identity cell becomes a row
// header (<th scope="row">), and numbers stay on one line with their units ("4 h 40 min", "20.2 km", "NOK 2,698").
// A list number stays with its first word ("1. Oslo").
// The identity cell is the first one, or the second when the first column is a short rank/index column; the
// table script in BaseLayout.astro uses the same rules, so it never picks a different cell.

export const RANK_HEADER = /^(#|rank|no\.?|pos|step)$/i;
export const RANK_CELL = /^(?:#?\d{1,3}\.?|n\/a|—|–|-)$/i;

const CELL = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const ROW = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
const UNIT = "(?:h|hrs?|hours?|min|mins|minutes?|sec|secs|s|km|m|mi|ft|kg|kWh|NOK|kr|EUR|USD|GBP|%|°C|°F)";
const NUMBER_UNIT = new RegExp(`(\\d)[ \\t]+(?=${UNIT}(?![\\p{L}\\d]))`, "gu");
const HOURS_MINUTES = /(\d(?:&nbsp;| )(?:h|hrs?|hours?))[ \t]+(?=\d)/g;
const CURRENCY_NUMBER = /(^|[^\p{L}])(NOK|kr|EUR|USD|GBP|€|\$|£)[ \t]+(?=\d)/gu;
const LIST_NUMBER = /^(\s*\d{1,3}\.)[ \t]+(?=\p{L})/u;

const plain = (html) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** 1 when the first column is a short rank/index column (and the second holds the row's name), else 0. */
export function identityColumn(headerTexts, firstColumn, colCount) {
  const values = firstColumn.filter(Boolean);
  const rank =
    colCount >= 3 &&
    (RANK_HEADER.test(headerTexts[0] ?? "") ||
      (values.length > 0 && values.some((v) => /\d/.test(v)) && values.every((v) => v.length <= 4 && RANK_CELL.test(v))));
  return rank ? 1 : 0;
}

/** Joins a number to its unit (and "4 h" to "40 min") with no-break spaces, in text only, never inside tags. */
export function keepUnitsTogether(html) {
  return html.replace(/>([^<]+)</g, (_, text) => {
    const joined = text
      .replace(NUMBER_UNIT, "$1&nbsp;")
      .replace(HOURS_MINUTES, "$1&nbsp;")
      .replace(CURRENCY_NUMBER, "$1$2&nbsp;")
      .replace(LIST_NUMBER, "$1&nbsp;");
    return `>${joined}<`;
  });
}

/** The table's inner HTML with each body row's identity cell as <th scope="row">. */
export function withRowHeaders(html) {
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(html);
  if (!body) return html;
  const head = /<thead\b[^>]*>[\s\S]*?<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(html);
  const headerTexts = head ? [...head[1].matchAll(CELL)].map((m) => plain(m[3])) : [];
  const rows = [...body[1].matchAll(ROW)].map((row) => [...row[2].matchAll(CELL)]);
  const colCount = headerTexts.length || rows[0]?.length || 0;
  const entity = identityColumn(headerTexts, rows.map((cells) => (cells[0] ? plain(cells[0][3]) : "")), colCount);
  const rewritten = body[1].replace(ROW, (_, rowAttrs, inner) => {
    let i = -1;
    const cells = inner.replace(CELL, (cell, tag, attrs, content) => {
      i += 1;
      if (i !== entity) return cell;
      if (tag.toLowerCase() === "th" && /\bscope=/.test(attrs)) return cell;
      return `<th${attrs} scope="row">${content}</th>`;
    });
    return `<tr${rowAttrs}>${cells}</tr>`;
  });
  const start = body.index + body[0].indexOf(body[1]);
  return html.slice(0, start) + rewritten + html.slice(start + body[1].length);
}
