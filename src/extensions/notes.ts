import { existsSync, readFileSync } from "node:fs";
import type { Context } from "@earendil-works/chord/context";
import { obj, str } from "@earendil-works/pi-schema";
import { type ConversationId, defineExtension, defineTool, type DocumentReader, section } from "@earendil-works/pi-durable";
import { writePrivate } from "../config.ts";

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

	/**
	 * Replace the note that matches `note` exactly (with or without its "- ") in place, or remove it when `next` is
	 * undefined. Returns whether one matched.
	 */
	replace(note: string, next: string | undefined): boolean {
		const target = note.replace(/^-\s*/, "").trim();
		const lines = this.read().split("\n");
		const index = lines.findIndex((line) => line.replace(/^-\s*/, "").trim() === target);
		if (target === "" || index === -1) return false;
		if (next === undefined) lines.splice(index, 1);
		else lines[index] = `- ${next.replace(/\s*\n\s*/g, " ").trim()}`;
		writePrivate(this.file, lines.join("\n"));
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

export type NotesResolver = (
	read: DocumentReader,
	conversationId: ConversationId,
	context: Context,
) => Promise<Notes | undefined>;

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

export function notesExtension(notesOrResolver: Notes | NotesResolver) {
	const resolveNotes: NotesResolver =
		typeof notesOrResolver === "function" ? notesOrResolver : async () => notesOrResolver;

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
				execute: async ({ note }, api, context) => {
					const notes = await resolveNotes(api, api.conversationId, context);
					if (notes === undefined) return text("Private notes aren't used in shared group chats.");
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
				execute: async (args, api, context) => {
					const notes = await resolveNotes(api, api.conversationId, context);
					if (notes === undefined) return text("Private notes aren't used in shared group chats.");
					const removed = notes.remove(args.text);
					return text(removed.length === 0 ? "No note matched." : `Removed:\n${removed.join("\n")}`);
				},
			}),
		],
		// Frozen per session: loaded once into the baseline `pi.system` after conversation creation, compaction, or
		// `pi.reset`. Mid-session `remember`/`forget` calls write immediately to disk and remain visible in the
		// append-only tool-call tail without mutating `pi.system` or invalidating the prompt KV cache.
		sections: [
			section("notes", async (input, context) => {
				const notes = await resolveNotes(input.read, input.conversationId, context);
				if (notes === undefined) return undefined;
				return notesView(notes.read(), input.shown.notes).notes;
			}),
		],
	});
}

const EMPTY = "(nothing yet)";

function unwrapNotes(shown: string): string {
	const prefix = "<notes>\n";
	const suffix = "\n</notes>";
	if (shown.startsWith(prefix) && shown.endsWith(suffix)) {
		return shown.slice(prefix.length, shown.length - suffix.length);
	}
	return shown.replace(/^<notes>\n?|\n?<\/notes>$/g, "").trim();
}

/**
 * What the model is shown of the notes. Frozen for the lifetime of the active session: once `<notes>` has been
 * emitted into the transcript (`shown !== undefined`), it is returned verbatim so `planSections()` never emits
 * mid-session patches or remove-all/re-add-all rewrites. After compaction or `pi.reset`, `shown` is `undefined`
 * and the fresh `notes.md` snapshot loads into the new baseline `pi.system`.
 */
export function notesView(file: string, shown: string | undefined): { notes: string } {
	if (shown !== undefined) return { notes: unwrapNotes(shown) };
	return { notes: file.trim() || EMPTY };
}
