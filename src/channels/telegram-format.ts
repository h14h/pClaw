/**
 * Markdown -> Telegram Bot API HTML converter, HTML-tag-safe chunker, and reaction emoji normalizer.
 *
 * Telegram's HTML parse mode only requires escaping `&`, `<`, `>` (and `"` in attributes), making programmatic
 * Markdown -> HTML conversion strictly safer than raw MarkdownV2, where a single unescaped `.`, `-`, `!`, or `(`
 * anywhere in model prose fails with HTTP 400 `can't parse entities`.
 */

export const TELEGRAM_MAX_MESSAGE = 4096;
export const TELEGRAM_MAX_CAPTION = 1024;

const EXPANDABLE_QUOTE_LINES = 5;
const EXPANDABLE_QUOTE_CHARS = 350;

/** Exact standard reaction emojis accepted by Telegram Bot API `ReactionTypeEmoji`. */
export const TELEGRAM_REACTION_EMOJIS = [
	"❤",
	"👍",
	"👎",
	"🔥",
	"🥰",
	"👏",
	"😁",
	"🤔",
	"🤯",
	"😱",
	"🤬",
	"😢",
	"🎉",
	"🤩",
	"🤮",
	"💩",
	"🙏",
	"👌",
	"🕊",
	"🤡",
	"🥱",
	"🥴",
	"😍",
	"🐳",
	"❤‍🔥",
	"🌚",
	"🌭",
	"💯",
	"🤣",
	"⚡",
	"🍌",
	"🏆",
	"💔",
	"🤨",
	"😐",
	"🍓",
	"🍾",
	"💋",
	"🖕",
	"😈",
	"😴",
	"😭",
	"🤓",
	"👻",
	"👨‍💻",
	"👀",
	"🎃",
	"🙈",
	"😇",
	"😨",
	"🤝",
	"✍",
	"🤗",
	"🫡",
	"🎅",
	"🎄",
	"☃",
	"💅",
	"🤪",
	"🗿",
	"🆒",
	"💘",
	"🙉",
	"🦄",
	"😘",
	"💊",
	"🙊",
	"😎",
	"👾",
	"🤷‍♂️",
	"🤷",
	"🤷‍♀️",
	"😡",
] as const;

/** Strip variation selectors (FE0E/FE0F) and skin-tone modifiers so `❤️`, `⚡️`, `👍🏽` match Telegram's canonical strings. */
function stripEmojiModifiers(emoji: string): string {
	return emoji.replace(/[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, "");
}

const CANONICAL_REACTION_MAP = new Map<string, string>(
	TELEGRAM_REACTION_EMOJIS.map((emoji) => [stripEmojiModifiers(emoji), emoji]),
);

/**
 * Semantic mapping from common emojis not in Telegram's bot reaction whitelist (including pclaw's `⏳` and `⚠️`,
 * and common model picks like `✅`, `❌`, `🖥️`, `🚀`) to valid Telegram `ReactionTypeEmoji` values.
 */
const REACTION_FALLBACK_ENTRIES: readonly [string, string][] = [
	// Working / waiting / searching
	["⏳", "👀"],
	["⌛", "👀"],
	["🔄", "👀"],
	["🔁", "👀"],
	["🕒", "👀"],
	["🕓", "👀"],
	["⏱", "👀"],
	["⏲", "👀"],
	["🔍", "👀"],
	["🔎", "👀"],
	// Done / success / approval
	["✅", "👍"],
	["✔", "👍"],
	["☑", "👍"],
	["🟢", "👍"],
	["⭐", "🤩"],
	["🌟", "🤩"],
	["✨", "🔥"],
	["💫", "🔥"],
	// Warning / error / failure
	["⚠", "😢"],
	["❌", "😢"],
	["❎", "😢"],
	["❗", "😱"],
	["❕", "🤨"],
	["🚨", "😱"],
	["🔴", "😢"],
	["💥", "🤯"],
	// Stopped / paused
	["⏹", "😐"],
	["🛑", "😐"],
	["⏸", "😐"],
	["💤", "😴"],
	// Code / tech / tools
	["💻", "👨‍💻"],
	["🖥", "👨‍💻"],
	["⌨", "👨‍💻"],
	["🛠", "👨‍💻"],
	["🔧", "👨‍💻"],
	["⚙", "👨‍💻"],
	["🤖", "👾"],
	["🧪", "🤓"],
	// Thinking / questions
	["❓", "🤔"],
	["❔", "🤔"],
	["🧐", "🤔"],
	["💭", "🤔"],
	["🧠", "🤓"],
	// Celebration / momentum
	["🎊", "🎉"],
	["🥳", "🎉"],
	["🙌", "👏"],
	["🥂", "🍾"],
	["🚀", "🔥"],
	["🎯", "💯"],
	["🥇", "🏆"],
	// Ideas / energy
	["💡", "⚡"],
	// Notes / writing
	["📝", "✍"],
	["📋", "✍"],
	["📄", "✍"],
	["📚", "🤓"],
	["📖", "🤓"],
	["✏", "✍"],
	["🖊", "✍"],
	// Hearts / warmth
	["💛", "❤"],
	["💚", "❤"],
	["💙", "❤"],
	["💜", "❤"],
	["🧡", "❤"],
	["🤍", "❤"],
	["🩷", "❤"],
	["🫶", "🥰"],
	["💕", "❤"],
	["💖", "❤"],
	["💗", "❤"],
	["💓", "❤"],
	// Smiles / laughs
	["😂", "🤣"],
	["😄", "😁"],
	["😃", "😁"],
	["😀", "😁"],
	["😊", "🥰"],
	["🙂", "👍"],
	["😉", "😎"],
	// Emphasis / greetings
	["💪", "💯"],
	["✊", "💯"],
	["👊", "🤝"],
	["🤙", "👌"],
	["👋", "🫡"],
	["🙋", "🫡"],
	// Sad / surprised
	["😔", "😢"],
	["😞", "😢"],
	["😟", "😨"],
	["😕", "🤨"],
	["🙁", "😢"],
	["☹", "😢"],
	["😮", "🤯"],
	["😲", "🤯"],
	["😳", "😱"],
];

const SEMANTIC_REACTION_MAP = new Map<string, string>(
	REACTION_FALLBACK_ENTRIES.map(([source, target]) => [stripEmojiModifiers(source), target]),
);

/** True if `emoji` (modulo variation selectors or skin-tone modifiers) is natively accepted by Telegram. */
export function isTelegramReactionEmoji(emoji: string): boolean {
	return CANONICAL_REACTION_MAP.has(stripEmojiModifiers(emoji.trim()));
}

/**
 * Normalize any emoji string into an exact Telegram-accepted `ReactionTypeEmoji` string.
 * Returns `undefined` when `emoji` is blank (meaning clear the bot's reaction).
 * Never returns an emoji outside `TELEGRAM_REACTION_EMOJIS`.
 */
export function normalizeTelegramReaction(emoji: string, fallback = "👍"): string | undefined {
	const trimmed = emoji.trim();
	if (trimmed === "") return undefined;
	const key = stripEmojiModifiers(trimmed);
	const exact = CANONICAL_REACTION_MAP.get(key);
	if (exact !== undefined) return exact;
	const mapped = SEMANTIC_REACTION_MAP.get(key);
	if (mapped !== undefined) return mapped;
	return CANONICAL_REACTION_MAP.get(stripEmojiModifiers(fallback.trim())) ?? "👍";
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
	return escapeHtml(text).replace(/"/g, "&quot;");
}

export function unescapeHtml(text: string): string {
	return text
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** Strip Telegram HTML tags and decode entities, for plain-text fallback on Telegram 400 entity parse errors. */
export function stripTelegramHtml(html: string): string {
	return unescapeHtml(html.replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|tg-spoiler|span|tg-emoji|tg-time)(?:\s+[^>]*)?>/gi, ""));
}

type InlineState = {
	inBold: boolean;
	inItalic: boolean;
	inStrike: boolean;
	inSpoiler: boolean;
	inLink: boolean;
};

const ROOT_INLINE_STATE: InlineState = {
	inBold: false,
	inItalic: false,
	inStrike: false,
	inSpoiler: false,
	inLink: false,
};

function isWordChar(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function isAllowedHref(url: string): boolean {
	return /^(?:https?:\/\/|tg:\/\/|mailto:)/i.test(url);
}

/** Find matching closing delimiter outside backtick inline-code spans. */
function findClosingDelimiter(
	text: string,
	from: number,
	delimiter: string,
	options?: { requireNonSpaceBefore?: boolean; disallowWordAfter?: boolean; disallowRepeatChar?: boolean },
): number {
	let i = from;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === "\\" && i + 1 < text.length) {
			i += 2;
			continue;
		}
		if (ch === "`") {
			let ticks = 1;
			while (text[i + ticks] === "`") ticks++;
			const close = findClosingBackticks(text, i + ticks, ticks);
			i = close === -1 ? i + ticks : close + ticks;
			continue;
		}
		if (text.startsWith(delimiter, i)) {
			const before = i > from ? text[i - 1] : undefined;
			const after = text[i + delimiter.length];
			const okBefore = options?.requireNonSpaceBefore !== true || (before !== undefined && !/\s/.test(before));
			const okAfter = options?.disallowWordAfter !== true || !isWordChar(after);
			const okRepeat =
				options?.disallowRepeatChar !== true || (before !== delimiter[0] && after !== delimiter[0]);
			if (i > from && okBefore && okAfter && okRepeat) return i;
		}
		i++;
	}
	return -1;
}

function findClosingBackticks(text: string, from: number, count: number): number {
	let i = from;
	while (i < text.length) {
		if (text[i] === "`") {
			let run = 1;
			while (text[i + run] === "`") run++;
			if (run === count) return i;
			i += run;
			continue;
		}
		i++;
	}
	return -1;
}

/** Parse `[label](url)` starting at `[`. Handles nested brackets, code spans in label, and balanced `()` in URLs. */
function parseMarkdownLink(text: string, start: number): { label: string; url: string; end: number } | undefined {
	let i = start + 1;
	let bracketDepth = 1;
	while (i < text.length && bracketDepth > 0) {
		const ch = text[i]!;
		if (ch === "\\" && i + 1 < text.length) {
			i += 2;
			continue;
		}
		if (ch === "`") {
			let ticks = 1;
			while (text[i + ticks] === "`") ticks++;
			const close = findClosingBackticks(text, i + ticks, ticks);
			i = close === -1 ? i + ticks : close + ticks;
			continue;
		}
		if (ch === "[") bracketDepth++;
		else if (ch === "]") bracketDepth--;
		i++;
	}
	if (bracketDepth !== 0) return undefined;
	const labelEnd = i - 1;
	if (text[i] !== "(") return undefined;
	i++;
	const urlStart = i;
	let parenDepth = 1;
	while (i < text.length && parenDepth > 0) {
		const ch = text[i]!;
		if (ch === "\\" && i + 1 < text.length) {
			i += 2;
			continue;
		}
		if (ch === "(") parenDepth++;
		else if (ch === ")") parenDepth--;
		i++;
	}
	if (parenDepth !== 0) return undefined;
	const rawTarget = text.slice(urlStart, i - 1).trim();
	if (rawTarget === "") return undefined;
	// Support optional `<url>` or `url "title"`.
	let url = rawTarget;
	if (url.startsWith("<") && url.includes(">")) {
		url = url.slice(1, url.indexOf(">"));
	} else {
		const spaceIdx = url.search(/\s/);
		if (spaceIdx !== -1) url = url.slice(0, spaceIdx);
	}
	url = url.replace(/\\([()])/g, "$1");
	if (!isAllowedHref(url)) return undefined;
	return { label: text.slice(start + 1, labelEnd), url, end: i };
}

function renderInline(text: string, state: InlineState = ROOT_INLINE_STATE): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;

		// Backslash escape for markdown punctuation.
		if (ch === "\\" && i + 1 < text.length && /[\\*_~`[\]()<>|]/.test(text[i + 1]!)) {
			out += escapeHtml(text[i + 1]!);
			i += 2;
			continue;
		}

		// Inline code span: `...` or ``...``
		if (ch === "`") {
			let ticks = 1;
			while (text[i + ticks] === "`") ticks++;
			const close = findClosingBackticks(text, i + ticks, ticks);
			if (close !== -1) {
				let inner = text.slice(i + ticks, close);
				if (inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "") {
					inner = inner.slice(1, -1);
				}
				out += `<code>${escapeHtml(inner)}</code>`;
				i = close + ticks;
				continue;
			}
			out += "`".repeat(ticks);
			i += ticks;
			continue;
		}

		// Unwrap Discord-style <https://...> autolinks so they don't render with literal angle brackets.
		if (ch === "<") {
			const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(text.slice(i));
			if (auto !== null) {
				out += escapeHtml(auto[1]!);
				i += auto[0].length;
				continue;
			}
		}

		// Inline link: [label](url)
		if (ch === "[" && !state.inLink) {
			const link = parseMarkdownLink(text, i);
			if (link !== undefined) {
				const renderedLabel = link.label.trim() === "" ? escapeHtml(link.url) : renderInline(link.label, { ...state, inLink: true });
				out += `<a href="${escapeAttr(link.url)}">${renderedLabel}</a>`;
				i = link.end;
				continue;
			}
		}

		// Bold + Italic: ***text***
		if (text.startsWith("***", i) && text[i - 1] !== "*" && text[i + 3] !== undefined && !/\s/.test(text[i + 3]!)) {
			const close = findClosingDelimiter(text, i + 3, "***", { requireNonSpaceBefore: true });
			if (close !== -1) {
				const inner = renderInline(text.slice(i + 3, close), { ...state, inBold: true, inItalic: true });
				const withItalic = state.inItalic ? inner : `<i>${inner}</i>`;
				out += state.inBold ? withItalic : `<b>${withItalic}</b>`;
				i = close + 3;
				continue;
			}
		}

		// Bold: **text**
		if (text.startsWith("**", i) && text[i - 1] !== "*" && text[i + 2] !== "*" && text[i + 2] !== undefined && !/\s/.test(text[i + 2]!)) {
			const close = findClosingDelimiter(text, i + 2, "**", { requireNonSpaceBefore: true });
			if (close !== -1) {
				const inner = renderInline(text.slice(i + 2, close), { ...state, inBold: true });
				out += state.inBold ? inner : `<b>${inner}</b>`;
				i = close + 2;
				continue;
			}
		}

		// Bold: __text__ (word-boundary guarded so snake__case isn't mangled)
		if (text.startsWith("__", i) && text[i - 1] !== "_" && text[i + 2] !== "_" && !isWordChar(text[i - 1]) && text[i + 2] !== undefined && !/\s/.test(text[i + 2]!)) {
			const close = findClosingDelimiter(text, i + 2, "__", { requireNonSpaceBefore: true, disallowWordAfter: true });
			if (close !== -1) {
				const inner = renderInline(text.slice(i + 2, close), { ...state, inBold: true });
				out += state.inBold ? inner : `<b>${inner}</b>`;
				i = close + 2;
				continue;
			}
		}

		// Strikethrough: ~~text~~
		if (text.startsWith("~~", i) && text[i - 1] !== "~" && text[i + 2] !== undefined && !/\s/.test(text[i + 2]!)) {
			const close = findClosingDelimiter(text, i + 2, "~~", { requireNonSpaceBefore: true });
			if (close !== -1) {
				const inner = renderInline(text.slice(i + 2, close), { ...state, inStrike: true });
				out += state.inStrike ? inner : `<s>${inner}</s>`;
				i = close + 2;
				continue;
			}
		}

		// Spoiler: ||text||
		if (text.startsWith("||", i) && text[i - 1] !== "|" && text[i + 2] !== undefined && !/\s/.test(text[i + 2]!)) {
			const close = findClosingDelimiter(text, i + 2, "||", { requireNonSpaceBefore: true });
			if (close !== -1) {
				const inner = renderInline(text.slice(i + 2, close), { ...state, inSpoiler: true });
				out += state.inSpoiler ? inner : `<tg-spoiler>${inner}</tg-spoiler>`;
				i = close + 2;
				continue;
			}
		}

		// Italic: *text*
		if (ch === "*" && text[i - 1] !== "*" && text[i + 1] !== "*" && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!)) {
			const close = findClosingDelimiter(text, i + 1, "*", { requireNonSpaceBefore: true, disallowRepeatChar: true });
			if (close !== -1) {
				const inner = renderInline(text.slice(i + 1, close), { ...state, inItalic: true });
				out += state.inItalic ? inner : `<i>${inner}</i>`;
				i = close + 1;
				continue;
			}
		}

		// Italic: _text_ (word-boundary guarded so snake_case_identifiers and foo__bar__baz stay literal)
		if (ch === "_" && text[i - 1] !== "_" && text[i + 1] !== "_" && !isWordChar(text[i - 1]) && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!)) {
			const close = findClosingDelimiter(text, i + 1, "_", {
				requireNonSpaceBefore: true,
				disallowWordAfter: true,
				disallowRepeatChar: true,
			});
			if (close !== -1) {
				const inner = renderInline(text.slice(i + 1, close), { ...state, inItalic: true });
				out += state.inItalic ? inner : `<i>${inner}</i>`;
				i = close + 1;
				continue;
			}
		}

		out += escapeHtml(ch);
		i++;
	}
	return out;
}

const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const SINGLE_COL_TABLE_DIVIDER_RE = /^\s*\|\s*:?-{2,}:?\s*\|\s*$/;

function splitTableRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let current = "";
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
			current += "|";
			i++;
		} else if (trimmed[i] === "|") {
			cells.push(current.trim());
			current = "";
		} else {
			current += trimmed[i]!;
		}
	}
	cells.push(current.trim());
	return cells;
}

function isTableStart(lines: string[], index: number): boolean {
	const header = lines[index];
	const divider = lines[index + 1];
	if (header === undefined || divider === undefined) return false;
	if (!header.includes("|")) return false;
	return TABLE_DIVIDER_RE.test(divider) || SINGLE_COL_TABLE_DIVIDER_RE.test(divider);
}

function parseQuotePrefix(line: string): { expandable: boolean; rest: string } | undefined {
	const expandableBang = /^ {0,3}>!\s?(.*)$/.exec(line);
	if (expandableBang !== null) return { expandable: true, rest: expandableBang[1]! };
	const expandableStars = /^ {0,3}\*\*>\s?(.*)$/.exec(line);
	if (expandableStars !== null) return { expandable: true, rest: expandableStars[1]! };
	const plain = /^ {0,3}>\s?(.*)$/.exec(line);
	if (plain !== null) return { expandable: false, rest: plain[1]! };
	return undefined;
}

/**
 * Convert standard Markdown (plus Telegram expandable quote syntax `>! ...` / `**>...` and `||spoiler||`)
 * into valid Telegram Bot API HTML.
 */
export function markdownToTelegramHtml(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;

		// 1. Fenced code block: ```lang ... ``` or ~~~lang ... ~~~
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
		if (fenceMatch !== null) {
			const fenceChar = fenceMatch[1]![0]!;
			const fenceLen = fenceMatch[1]!.length;
			const rawLang = fenceMatch[2]!.trim().split(/\s+/)[0] ?? "";
			const lang = /^[A-Za-z0-9_+#.-]+$/.test(rawLang) ? rawLang : "";
			const codeLines: string[] = [];
			i++;
			while (i < lines.length) {
				const candidate = lines[i]!;
				const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}\\s*$`);
				if (closeRe.test(candidate)) {
					i++;
					break;
				}
				codeLines.push(candidate);
				i++;
			}
			const escapedCode = escapeHtml(codeLines.join("\n"));
			out.push(lang === "" ? `<pre>${escapedCode}</pre>` : `<pre><code class="language-${escapeAttr(lang)}">${escapedCode}</code></pre>`);
			continue;
		}

		// 2. Blockquote / expandable blockquote (flattened: Telegram forbids nested <blockquote> tags).
		const quoteStart = parseQuotePrefix(line);
		if (quoteStart !== undefined) {
			let expandable = quoteStart.expandable;
			const quoteLines: string[] = [quoteStart.rest];
			i++;
			while (i < lines.length) {
				const next = parseQuotePrefix(lines[i]!);
				if (next === undefined) break;
				if (next.expandable) expandable = true;
				quoteLines.push(next.rest);
				i++;
			}
			// Strip optional Telegram MarkdownV2 `||` trailer on the last line of an expandable quote.
			if (expandable && quoteLines.length > 0 && quoteLines[quoteLines.length - 1]!.endsWith("||")) {
				quoteLines[quoteLines.length - 1] = quoteLines[quoteLines.length - 1]!.slice(0, -2);
			}
			const rawInner = quoteLines.join("\n").trim();
			if (quoteLines.length >= EXPANDABLE_QUOTE_LINES || rawInner.length >= EXPANDABLE_QUOTE_CHARS) {
				expandable = true;
			}
			const renderedInner = quoteLines.map((qLine) => renderInline(qLine)).join("\n").trim();
			out.push(expandable ? `<blockquote expandable>${renderedInner}</blockquote>` : `<blockquote>${renderedInner}</blockquote>`);
			continue;
		}

		// 3. Markdown table -> compact mobile-friendly bullet lines.
		if (isTableStart(lines, i)) {
			const headers = splitTableRow(line);
			i += 2; // skip header + divider
			const rows: string[][] = [];
			while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
				rows.push(splitTableRow(lines[i]!));
				i++;
			}
			if (rows.length === 0) {
				out.push(headers.map((h) => `<b>${renderInline(h, { ...ROOT_INLINE_STATE, inBold: true })}</b>`).join(" · "));
			} else {
				for (const row of rows) {
					const pairs: string[] = [];
					for (let col = 0; col < Math.max(headers.length, row.length); col++) {
						const cell = row[col] ?? "";
						if (cell === "") continue;
						const header = headers[col];
						pairs.push(
							header !== undefined && header !== ""
								? `<b>${renderInline(header, { ...ROOT_INLINE_STATE, inBold: true })}</b>: ${renderInline(cell)}`
								: renderInline(cell),
						);
					}
					if (pairs.length > 0) out.push(`• ${pairs.join(" · ")}`);
				}
			}
			continue;
		}

		// 4. Horizontal rule -> blank separator (never raw `---`).
		if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
			if (out.length > 0 && out[out.length - 1] !== "") out.push("");
			i++;
			continue;
		}

		// 5. ATX Heading (# ... ######) -> bold line.
		const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading !== null) {
			out.push(`<b>${renderInline(heading[1]!, { ...ROOT_INLINE_STATE, inBold: true })}</b>`);
			i++;
			continue;
		}

		// 6. Unordered list item -> clean bullet.
		const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
		if (bullet !== null) {
			const indent = bullet[1]!;
			const marker = indent.length >= 2 ? "◦" : "•";
			out.push(`${indent}${marker} ${renderInline(bullet[2]!)}`);
			i++;
			continue;
		}

		// 7. Ordered list item.
		const ordered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
		if (ordered !== null) {
			out.push(`${ordered[1]!}${ordered[2]!} ${renderInline(ordered[3]!)}`);
			i++;
			continue;
		}

		// 8. Normal line (preserve blank lines cleanly).
		if (line.trim() === "") {
			out.push("");
		} else {
			out.push(renderInline(line));
		}
		i++;
	}

	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

type OpenTag = { name: string; openTag: string };

type HtmlToken =
	| { kind: "open"; name: string; raw: string }
	| { kind: "close"; name: string; raw: string }
	| { kind: "entity"; raw: string }
	| { kind: "text"; raw: string };

const TAG_OR_ENTITY_RE = /<(\/?)([a-z][a-z0-9-]*)(\s+[^>]*)?>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi;

function tokenizeTelegramHtml(html: string): HtmlToken[] {
	const tokens: HtmlToken[] = [];
	let lastIndex = 0;
	for (const match of html.matchAll(TAG_OR_ENTITY_RE)) {
		const index = match.index!;
		if (index > lastIndex) tokens.push({ kind: "text", raw: html.slice(lastIndex, index) });
		const raw = match[0];
		if (raw.startsWith("&")) {
			tokens.push({ kind: "entity", raw });
		} else if (match[1] === "/") {
			tokens.push({ kind: "close", name: match[2]!.toLowerCase(), raw });
		} else {
			tokens.push({ kind: "open", name: match[2]!.toLowerCase(), raw });
		}
		lastIndex = index + raw.length;
	}
	if (lastIndex < html.length) tokens.push({ kind: "text", raw: html.slice(lastIndex) });
	return tokens;
}

function closingTagsFor(stack: readonly OpenTag[]): string {
	let result = "";
	for (let i = stack.length - 1; i >= 0; i--) result += `</${stack[i]!.name}>`;
	return result;
}

function openingTagsFor(stack: readonly OpenTag[]): string {
	return stack.map((tag) => tag.openTag).join("");
}

/** Find a safe UTF-16 cut offset `<= maxLen` that never splits a surrogate pair. */
function safeSliceEnd(text: string, maxLen: number): number {
	if (maxLen <= 0) return 0;
	if (maxLen >= text.length) return text.length;
	const code = text.charCodeAt(maxLen - 1);
	if (code >= 0xd800 && code <= 0xdbff) return maxLen - 1;
	return maxLen;
}

/**
 * Split Telegram HTML into chunks of at most `limit` characters without ever breaking an open HTML tag,
 * HTML entity, or UTF-16 surrogate pair. Open tags (including `<pre><code class="language-...">`, `<a>`,
 * `<blockquote expandable>`) are closed at chunk boundaries and reopened in the next chunk.
 */
export function splitTelegramHtml(html: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
	const trimmed = html.trim();
	if (trimmed === "") return [];
	if (trimmed.length <= limit) return [trimmed];

	const tokens = tokenizeTelegramHtml(trimmed);
	const chunks: string[] = [];
	let openStack: OpenTag[] = [];
	let buf = "";

	type BreakPoint = {
		bufLen: number;
		tokenIdx: number;
		textOffset: number;
		stack: OpenTag[];
		priority: number; // 3 = \n\n, 2 = \n, 1 = space
	};
	let bestBreak: BreakPoint | undefined;

	const recordBreak = (priority: number, bufLen: number, tokenIdx: number, textOffset: number, stack: OpenTag[]) => {
		const outsideCode = !stack.some((t) => t.name === "pre" || t.name === "code");
		const score = priority + (outsideCode ? 10 : 0);
		if (bufLen < Math.floor(limit * 0.25)) return;
		if (bestBreak === undefined || score >= bestBreak.priority) {
			bestBreak = { bufLen, tokenIdx, textOffset, stack: [...stack], priority: score };
		}
	};

	const flushChunk = (content: string, stackAtEnd: OpenTag[]) => {
		const inPre = stackAtEnd.some((t) => t.name === "pre");
		const body = inPre ? content : content.trimEnd();
		const closed = `${body}${closingTagsFor(stackAtEnd)}`;
		if (closed.trim() !== "") chunks.push(closed);
		openStack = [...stackAtEnd];
		buf = openingTagsFor(openStack);
		bestBreak = undefined;
	};

	let tokenIdx = 0;
	let textOffset = 0;

	while (tokenIdx < tokens.length) {
		const token = tokens[tokenIdx]!;
		const closingLen = closingTagsFor(openStack).length;

		if (token.kind === "open") {
			const nextStack = [...openStack, { name: token.name, openTag: token.raw }];
			const needed = buf.length + token.raw.length + closingTagsFor(nextStack).length;
			if (needed > limit && buf.length > openingTagsFor(openStack).length) {
				if (bestBreak !== undefined) {
					const bp = bestBreak;
					flushChunk(buf.slice(0, bp.bufLen), bp.stack);
					tokenIdx = bp.tokenIdx;
					textOffset = bp.textOffset;
					continue;
				}
				flushChunk(buf, openStack);
				continue;
			}
			buf += token.raw;
			openStack = nextStack;
			tokenIdx++;
			textOffset = 0;
			continue;
		}

		if (token.kind === "close") {
			const nextStack = [...openStack];
			for (let s = nextStack.length - 1; s >= 0; s--) {
				if (nextStack[s]!.name === token.name) {
					nextStack.splice(s, 1);
					break;
				}
			}
			const needed = buf.length + token.raw.length + closingTagsFor(nextStack).length;
			if (needed > limit && buf.length > openingTagsFor(openStack).length) {
				flushChunk(buf, openStack);
				continue;
			}
			buf += token.raw;
			openStack = nextStack;
			tokenIdx++;
			textOffset = 0;
			continue;
		}

		if (token.kind === "entity") {
			if (buf.length + token.raw.length + closingLen > limit && buf.length > openingTagsFor(openStack).length) {
				if (bestBreak !== undefined) {
					const bp = bestBreak;
					flushChunk(buf.slice(0, bp.bufLen), bp.stack);
					tokenIdx = bp.tokenIdx;
					textOffset = bp.textOffset;
					continue;
				}
				flushChunk(buf, openStack);
				continue;
			}
			buf += token.raw;
			tokenIdx++;
			textOffset = 0;
			continue;
		}

		// Plain text token: consume as much as fits, recording natural break points.
		const remaining = token.raw.slice(textOffset);
		if (remaining === "") {
			tokenIdx++;
			textOffset = 0;
			continue;
		}

		// Skip leading whitespace at the very start of a new chunk (outside <pre>).
		if (buf === openingTagsFor(openStack) && chunks.length > 0 && !openStack.some((t) => t.name === "pre")) {
			const trimmedStart = remaining.replace(/^[ \t\n]+/, "");
			const skipped = remaining.length - trimmedStart.length;
			if (skipped > 0) {
				textOffset += skipped;
				if (textOffset >= token.raw.length) {
					tokenIdx++;
					textOffset = 0;
				}
				continue;
			}
		}

		const available = limit - buf.length - closingLen;
		if (available <= 0) {
			if (bestBreak !== undefined) {
				const bp = bestBreak;
				flushChunk(buf.slice(0, bp.bufLen), bp.stack);
				tokenIdx = bp.tokenIdx;
				textOffset = bp.textOffset;
				continue;
			}
			if (buf.length > openingTagsFor(openStack).length) {
				flushChunk(buf, openStack);
				continue;
			}
			// Degenerate limit smaller than tag overhead: force at least 1 code point so we always make progress.
			const step = safeSliceEnd(remaining, Math.min(2, remaining.length)) || 1;
			buf += remaining.slice(0, step);
			textOffset += step;
			flushChunk(buf, openStack);
			continue;
		}

		if (remaining.length <= available) {
			// Scan break points inside this text run as we append it.
			const baseBufLen = buf.length;
			for (let k = 0; k < remaining.length; k++) {
				if (remaining[k] === "\n" && remaining[k + 1] === "\n") {
					recordBreak(3, baseBufLen + k, tokenIdx, textOffset + k + 2, openStack);
				} else if (remaining[k] === "\n") {
					recordBreak(2, baseBufLen + k, tokenIdx, textOffset + k + 1, openStack);
				} else if (remaining[k] === " ") {
					recordBreak(1, baseBufLen + k, tokenIdx, textOffset + k + 1, openStack);
				}
			}
			buf += remaining;
			tokenIdx++;
			textOffset = 0;
			continue;
		}

		// Text overflows available space: pick best break inside the fitting slice or fall back to earlier bestBreak.
		const fitEnd = safeSliceEnd(remaining, available);
		const fit = remaining.slice(0, fitEnd);
		const baseBufLen = buf.length;
		for (let k = 0; k < fit.length; k++) {
			if (fit[k] === "\n" && remaining[k + 1] === "\n") {
				recordBreak(3, baseBufLen + k, tokenIdx, textOffset + k + 2, openStack);
			} else if (fit[k] === "\n") {
				recordBreak(2, baseBufLen + k, tokenIdx, textOffset + k + 1, openStack);
			} else if (fit[k] === " ") {
				recordBreak(1, baseBufLen + k, tokenIdx, textOffset + k + 1, openStack);
			}
		}

		if (bestBreak !== undefined) {
			const bp = bestBreak;
			flushChunk(buf.slice(0, bp.bufLen), bp.stack);
			tokenIdx = bp.tokenIdx;
			textOffset = bp.textOffset;
			continue;
		}

		// Hard split on character boundary inside fit.
		const take = Math.max(1, fitEnd);
		buf += remaining.slice(0, take);
		textOffset += take;
		if (textOffset >= token.raw.length) {
			tokenIdx++;
			textOffset = 0;
		}
		flushChunk(buf, openStack);
	}

	if (buf.length > openingTagsFor(openStack).length) {
		flushChunk(buf, openStack);
	}

	return chunks;
}

/** Split plain text into Telegram-sized messages, preferring paragraph, then line, then word breaks. */
export function splitPlainText(text: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const cut = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")].find(
			(index) => index > limit / 2,
		);
		const at = cut ?? safeSliceEnd(rest, limit);
		chunks.push(rest.slice(0, at).trimEnd());
		rest = rest.slice(at).trimStart();
	}
	if (rest !== "") chunks.push(rest);
	return chunks;
}
