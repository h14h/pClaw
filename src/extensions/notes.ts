import { existsSync, readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
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

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function notesExtension(notes: Notes) {
	return defineExtension({
		name: "pclaw.notes",
		tools: [
			defineTool({
				name: "remember",
				description:
					"Save a short note about the person for later: people in their life, preferences, plans, dates, " +
					"ongoing projects, how they like things done. Call this whenever you learn something you'd want to " +
					"know next week. One fact per call.",
				parameters: Type.Object({ note: Type.String({ description: "One short, specific fact." }) }),
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
				parameters: Type.Object({ text: Type.String({ description: "Text that appears in the note(s) to remove." }) }),
				execute: async (args) => {
					const removed = notes.remove(args.text);
					return text(removed.length === 0 ? "No note matched." : `Removed:\n${removed.join("\n")}`);
				},
			}),
		],
		// Read on every request, so edits to the file show up in the next reply.
		sections: [section("notes", () => notes.read().trim() || "(nothing yet)")],
	});
}
