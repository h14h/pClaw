import { existsSync, readFileSync } from "node:fs";
import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { ensureHome, writePrivate } from "../config.ts";

/** Notes live in a plain markdown file, one "- " line per note, so the person can read and edit them. */
export class Notes {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	read(): string {
		return existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
	}

	add(note: string): void {
		const current = this.read();
		const line = `- ${note.replace(/\s*\n\s*/g, " ").trim()}\n`;
		ensureHome();
		writePrivate(this.file, current === "" || current.endsWith("\n") ? current + line : `${current}\n${line}`);
	}

	/** Remove the note that matches `note` exactly (with or without its "- "). Returns whether one was removed. */
	removeExact(note: string): boolean {
		const target = note.replace(/^-\s*/, "").trim();
		const lines = this.read().split("\n");
		const kept = lines.filter((line) => line.replace(/^-\s*/, "").trim() !== target);
		if (target === "" || kept.length === lines.length) return false;
		writePrivate(this.file, kept.join("\n"));
		return true;
	}

	/** Remove every line containing `text` (case-insensitive). Returns the removed lines. */
	remove(text: string): string[] {
		const needle = text.trim().toLowerCase();
		if (needle === "") return [];
		const lines = this.read().split("\n");
		const removed = lines.filter((line) => line.toLowerCase().includes(needle));
		if (removed.length > 0) {
			writePrivate(this.file, lines.filter((line) => !line.toLowerCase().includes(needle)).join("\n"));
		}
		return removed;
	}
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

export function notesExtension(notes: Notes) {
	return defineExtension({
		name: "pclaw.notes",
		tools: [
			defineTool({
				name: "remember",
				description:
					"Save a short note about the person for later: people in their life, preferences, plans, dates, " +
					"ongoing projects, how they like things done. Call this whenever you learn something you'd want to " +
					"know next week. One fact per call. Never a password, key, or token. For their setup, note what a " +
					"thing is for and where its details are written down, not ports, paths, or versions.",
				parameters: obj({ note: str({ description: "One short, specific fact." }) }, { open: true }),
				execute: async ({ note }) => {
					notes.add(note);
					return text("Saved.");
				},
			}),
			defineTool({
				name: "forget",
				description:
					"Remove notes that are wrong or out of date, or that they asked you to forget. Removes every note " +
					"line containing the given text.",
				parameters: obj({ text: str({ description: "Text that appears in the note(s) to remove." }) }, { open: true }),
				execute: async (args) => {
					const removed = notes.remove(args.text);
					return text(removed.length === 0 ? "No note matched." : `Removed:\n${removed.join("\n")}`);
				},
			}),
		],
		// Read on every request, so edits to the file show up in the next reply. See `notesView` for why changes go in
		// their own section.
		sections: [
			section("notes", (input) => notesView(notes.read(), input.shown.notes).notes),
			section("notes-changes", (input) => notesView(notes.read(), input.shown.notes).changes),
		],
	});
}

const EMPTY = "(nothing yet)";
/** Past this many changed lines, the full notes are sent again instead of a list of changes. */
const REFRESH_AFTER = 20;
const linesOf = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && line !== EMPTY);

/**
 * What the model is shown of the notes. Pi Durable keeps every version of a section in the transcript until the next
 * summary, so sending the whole file on each change piled up dozens of full copies in a long conversation, and a note
 * that was removed stayed visible in the older ones. Instead the copy already in view stays put, and changes since go
 * in a small `notes-changes` section. A summary clears the transcript, and the next request sends the notes in full.
 * `shown` is the notes section as it is in the transcript now (tags included), if at all.
 */
export function notesView(file: string, shown: string | undefined): { notes: string; changes?: string } {
	const current = file.trim() || EMPTY;
	if (shown === undefined) return { notes: current };
	const inView = shown.replace(/^<notes>\n?|\n?<\/notes>$/g, "").trim();
	const before = new Set(linesOf(inView));
	const now = new Set(linesOf(current));
	const added = [...now].filter((line) => !before.has(line));
	const removed = [...before].filter((line) => !now.has(line));
	if (added.length === 0 && removed.length === 0) return { notes: inView };
	if (before.size === 0 || added.length + removed.length > REFRESH_AFTER) return { notes: current };
	const parts = ["Changed since the notes above were loaded; this list wins where they disagree."];
	if (added.length > 0) parts.push(`Added:\n${added.join("\n")}`);
	if (removed.length > 0) parts.push(`Removed (out of date, or they asked to forget it; don't use or repeat it):\n${removed.join("\n")}`);
	return { notes: inView, changes: parts.join("\n\n") };
}
