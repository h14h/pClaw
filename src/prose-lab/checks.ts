/**
 * Mechanical checks on a reply as Discord would show it. They catch what a reader notices at a glance (a broken table,
 * a giant heading, a message split in two); whether the reply reads well is the judge's call.
 */

export type Check = { rule: string; detail: string };

const LIMIT = 2000;

export function discordChecks(text: string): Check[] {
	const failed: Check[] = [];
	const lines = text.split("\n");
	if (lines.some((line) => /^\s*\|?\s*:?-{3,}:?\s*\|/.test(line))) failed.push({ rule: "table", detail: "pipes and dashes show up raw" });
	const headings = lines.filter((line) => /^#{1,6}\s/.test(line));
	if (headings.length > 0) failed.push({ rule: "heading", detail: headings[0]!.trim() });
	if (lines.some((line) => /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line))) failed.push({ rule: "rule", detail: "--- shows as three dashes" });
	if (text.length > LIMIT) failed.push({ rule: "length", detail: `${text.length} characters, split into ${Math.ceil(text.length / LIMIT)} messages` });
	const bold = text.match(/\*\*[^*\n]+\*\*/g) ?? [];
	const boldLabel = lines.find((line) => /^\s*\*\*[^*\n]+\*\*\s*$/.test(line) || /^\s*\*\*[^*\n]+:\*\*\s+\S/.test(line));
	if (boldLabel !== undefined || bold.length > 6) failed.push({ rule: "bold", detail: boldLabel?.trim() ?? `${bold.length} bold spans` });
	const links = linksIn(text);
	const unfurling = links.filter((link) => !link.wrapped);
	if (links.length > 1 && unfurling.length > 0) failed.push({ rule: "links", detail: `${unfurling.length} of ${links.length} links would unfurl` });
	return failed;
}

/** Every URL, and whether it's wrapped in <> (bare or inside a masked link) so Discord doesn't add a preview card. */
export function linksIn(text: string): { url: string; wrapped: boolean }[] {
	const found: { url: string; wrapped: boolean }[] = [];
	for (const match of text.matchAll(/(<)?(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"])(>)?/g)) {
		found.push({ url: match[2]!, wrapped: match[1] === "<" && match[3] === ">" });
	}
	return found;
}

/** A rough size for the summary: words outside code. */
export function words(text: string): number {
	return text.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
}
