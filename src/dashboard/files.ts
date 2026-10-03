import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { formattingDir, type PromptName, prompts } from "../prompts.ts";
import type { FileContent, FileSummary } from "./types.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

export class FileError extends Error {}

type Entry = Omit<FileSummary, "size" | "modifiedAt"> & { file: string };

/**
 * The markdown files that shape how pclaw behaves, editable from the dashboard: the prompts, the per-app formatting
 * files, and every markdown file in the workers' skills (pclaw's own and config.workerSkills). The list is read fresh
 * each time, so a new file shows up without a restart. Only files on the list can be read or written.
 */
export function editableFiles(skills: string[]) {
	function entries(): Entry[] {
		const list: Entry[] = [];
		for (const [id, prompt] of Object.entries(prompts) as [PromptName, (typeof prompts)[PromptName]][]) {
			list.push({ id: `prompts/${id}.md`, group: "prompts", name: prompt.name, path: display(prompt.file), description: prompt.description, file: prompt.file });
		}
		for (const name of markdownIn(formattingDir)) {
			const app = name.replace(/\.md$/, "");
			list.push({
				id: `formatting/${name}`,
				group: "formatting",
				name: app[0]!.toUpperCase() + app.slice(1),
				path: display(join(formattingDir, name)),
				description: `How to format messages in ${app[0]!.toUpperCase() + app.slice(1)}.`,
				file: join(formattingDir, name),
			});
		}
		const seen = new Set<string>();
		for (const dir of skills) {
			const skill = basename(dir);
			if (seen.has(skill) || !existsSync(join(dir, "SKILL.md"))) continue;
			seen.add(skill);
			const files = markdownIn(dir).sort((a, b) => Number(b === "SKILL.md") - Number(a === "SKILL.md") || a.localeCompare(b));
			for (const name of files) {
				const file = join(dir, name);
				list.push({
					id: `skills/${skill}/${name}`,
					group: "skills",
					skill,
					name,
					path: display(file),
					description: name === "SKILL.md" ? (skillDescription(file) ?? `The ${skill} skill.`) : `Part of the ${skill} skill.`,
					file,
				});
			}
		}
		return list;
	}

	function find(id: string): Entry {
		const entry = entries().find((each) => each.id === id);
		if (entry === undefined) throw new FileError(`No editable file ${id}.`);
		return entry;
	}

	function summary({ file: _file, ...entry }: Entry, text: string, file: string): FileSummary {
		return { ...entry, size: text.length, modifiedAt: statSync(file).mtimeMs };
	}

	function list(): FileSummary[] {
		return entries().map((entry) => summary(entry, readFileSync(entry.file, "utf8"), entry.file));
	}

	function read(id: string): FileContent {
		const entry = find(id);
		const text = readFileSync(entry.file, "utf8");
		return { ...summary(entry, text, entry.file), text };
	}

	/** Through a temp file, into the real file when the path is a symlink (shared skills often are). */
	function write(id: string, text: unknown): FileContent {
		if (typeof text !== "string" || text.trim() === "") throw new FileError("A file can't be empty.");
		const file = realpathSync(find(id).file);
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, text.endsWith("\n") ? text : `${text}\n`);
		renameSync(temp, file);
		return read(id);
	}

	return { list, read, write, paths: () => entries().map((entry) => ({ id: entry.id, file: entry.file })) };
}

/** Markdown files under `dir`, as paths relative to it. Skips dot folders and node_modules. */
function markdownIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
		.filter((path) => !path.split(sep).some((part) => part.startsWith(".") || part === "node_modules"))
		.sort();
}

function skillDescription(file: string): string | undefined {
	const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1];
	return front?.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/** Relative to the repo for pclaw's own files, ~/… for the rest. */
function display(file: string): string {
	if (file.startsWith(REPO)) return relative(REPO, file);
	const home = homedir();
	return file.startsWith(`${home}/`) ? `~/${relative(home, file)}` : file;
}
