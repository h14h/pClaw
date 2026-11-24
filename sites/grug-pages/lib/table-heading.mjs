/**
 * Table heading layout plan, shared by the page script (inlined into
 * BaseLayout.astro) and the tests. Pure string work, linear in the heading
 * length, so imported pages with long headings can never stall the page.
 *
 * - Headings of HEADING_ONE_LINE_MAX characters or fewer stay on one line.
 * - Headings up to HEADING_TWO_LINE_MAX characters become two word groups
 *   (one linear scan for the most even cut), so they wrap to at most 2 lines.
 * - Longer headings only keep hyphenated words whole; CSS `text-wrap: balance`
 *   balances the lines.
 */

export const HEADING_ONE_LINE_MAX = 14;
export const HEADING_TWO_LINE_MAX = 32;

const punctTokenRe = /^[/&+|:–—-]+$/;
const hyphenatedRe = /[^\s-]-[^\s-]/;

/** @typedef {{ text: string, nowrap: boolean }} HeadingRun */

/**
 * Split text into runs, marking each hyphenated word as `nowrap` so it never
 * breaks at its hyphen. Whitespace and other words stay in plain runs.
 * @param {string} value
 * @returns {HeadingRun[]}
 */
export function splitKeepingHyphenated(value) {
  /** @type {HeadingRun[]} */
  const runs = [];
  let plain = "";
  for (const piece of value.split(/(\s+)/)) {
    if (piece && hyphenatedRe.test(piece)) {
      if (plain) runs.push({ text: plain, nowrap: false });
      plain = "";
      runs.push({ text: piece, nowrap: true });
    } else {
      plain += piece;
    }
  }
  if (plain) runs.push({ text: plain, nowrap: false });
  return runs;
}

/**
 * Plan how a plain-text heading may wrap.
 * @param {string} rawText
 * @returns {{ oneLine: boolean, runs: HeadingRun[] }}
 */
export function planTableHeading(rawText) {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (text.length <= HEADING_ONE_LINE_MAX) {
    return { oneLine: true, runs: text ? [{ text, nowrap: true }] : [] };
  }
  if (text.length > HEADING_TWO_LINE_MAX) {
    return { oneLine: false, runs: splitKeepingHyphenated(text) };
  }
  // Words, with a lone "/", "&", ":" etc. kept on the end of the word before it
  /** @type {string[]} */
  const tokens = [];
  for (const word of text.split(" ")) {
    if (tokens.length > 0 && punctTokenRe.test(word)) tokens[tokens.length - 1] += ` ${word}`;
    else tokens.push(word);
  }
  if (tokens.length < 2) return { oneLine: false, runs: [{ text, nowrap: true }] };
  // One pass for the cut that makes the longer of the two lines shortest
  let bestCut = 1;
  let bestCost = Infinity;
  let left = -1;
  for (let cut = 1; cut < tokens.length; cut++) {
    left += tokens[cut - 1].length + 1;
    const cost = Math.max(left, text.length - left - 1);
    if (cost < bestCost) {
      bestCost = cost;
      bestCut = cut;
    }
  }
  return {
    oneLine: false,
    runs: [
      { text: tokens.slice(0, bestCut).join(" "), nowrap: true },
      { text: " ", nowrap: false },
      { text: tokens.slice(bestCut).join(" "), nowrap: true },
    ],
  };
}
