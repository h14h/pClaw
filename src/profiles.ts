import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ModelThinkingLevel, Api } from "@earendil-works/pi-ai";
import type { MutableModels, Provider } from "@earendil-works/pi-ai/models";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Everything about the front model that should change with the model: which one it is, how hard it thinks, which tools
 * it's offered, how they're described, and how it's prompted. One folder per model under profiles/, so adding a model
 * is adding files, and tuning one is editing them (docs/tuning-profiles.md).
 *
 * A profile's .md files override the shared ones in src/prompts/ by name; anything it doesn't have falls through.
 */

export type Profile = {
	name: string;
	dir: string;
	provider: string;
	model: string;
	thinkingLevel: ModelThinkingLevel;
	/** For a model pi's catalog doesn't list yet: a model on the same provider to copy its settings from. */
	catalogBase?: string;
	/** Tools the model isn't offered until it finds them with tool_search. A trailing * matches a prefix. */
	deferredTools: string[];
	/** Replacement descriptions, by tool name. */
	toolDescriptions: Record<string, string>;
};

export const PROFILES_DIR = fileURLToPath(new URL("../profiles", import.meta.url));

export function listProfiles(dir = PROFILES_DIR): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).filter((each) => each.isDirectory() && existsSync(join(dir, each.name, "profile.json"))).map((each) => each.name).sort();
}

export function loadProfile(name: string, root = PROFILES_DIR): Profile {
	const dir = join(root, name);
	const file = join(dir, "profile.json");
	if (!existsSync(file)) throw new Error(`No profile ${name}. Profiles: ${listProfiles(root).join(", ") || "none"}.`);
	const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<Profile>;
	if (stored.provider === undefined || stored.model === undefined) throw new Error(`${file} needs a provider and a model.`);
	return { deferredTools: [], toolDescriptions: {}, thinkingLevel: "medium", ...stored, provider: stored.provider, model: stored.model, name, dir };
}

export function profileFor(provider: string, model: string, root = PROFILES_DIR): Profile | undefined {
	return listProfiles(root).map((name) => loadProfile(name, root)).find((each) => each.provider === provider && each.model === model);
}

/** A new profile, starting as a copy of another. */
export function createProfile(name: string, from: string, changes: Partial<Pick<Profile, "provider" | "model" | "thinkingLevel" | "catalogBase">>, root = PROFILES_DIR): Profile {
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error(`"${name}" isn't a usable profile name.`);
	const dir = join(root, name);
	if (existsSync(dir)) throw new Error(`Profile ${name} already exists.`);
	const source = loadProfile(from, root);
	cpSync(source.dir, dir, { recursive: true, filter: (file) => !file.endsWith("TUNING.md") });
	const { name: _name, dir: _dir, ...stored } = source;
	writeProfile(dir, { ...stored, ...changes });
	return loadProfile(name, root);
}

export function writeProfile(dir: string, profile: Omit<Profile, "name" | "dir">): void {
	writeFileSync(join(dir, "profile.json"), `${JSON.stringify(profile, null, "\t")}\n`);
}

const matches = (pattern: string, name: string) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name);

/** An extension as this profile offers it. */
export function applyProfile<Tool extends ToolRegistration>(extension: Extension<Tool>, profile: Pick<Profile, "deferredTools" | "toolDescriptions">): Extension<Tool> {
	if (extension.tools === undefined) return extension;
	return {
		...extension,
		tools: extension.tools.map((tool) => ({
			...tool,
			...(profile.toolDescriptions[tool.name] === undefined ? {} : { description: profile.toolDescriptions[tool.name]! }),
			...(profile.deferredTools.some((pattern) => matches(pattern, tool.name)) ? { deferred: true } : {}),
		})),
	};
}

/**
 * Register the providers profiles use. pi-ai names every provider module the same way, so a profile on a new provider
 * needs no code here. A `catalogBase` adds the profile's model to the provider's catalog, copied from that base.
 */
export async function registerProfiles(models: MutableModels, profiles: Profile[]): Promise<void> {
	for (const id of new Set(profiles.map((profile) => profile.provider))) {
		const module = (await import(`@earendil-works/pi-ai/providers/${id}`)) as Record<string, unknown>;
		const make = Object.entries(module).find(([name, value]) => name.endsWith("Provider") && typeof value === "function")?.[1] as (() => Provider) | undefined;
		if (make === undefined) throw new Error(`No provider ${id} in pi-ai.`);
		const provider = make();
		const added = profiles
			.filter((profile) => profile.provider === id && profile.catalogBase !== undefined)
			.flatMap((profile): Model<Api>[] => {
				const base = provider.getModels().find((model) => model.id === profile.catalogBase);
				return base === undefined ? [] : [{ ...base, id: profile.model, name: profile.model }];
			});
		if (added.length === 0) {
			models.setProvider(provider);
			continue;
		}
		const extended = Object.create(provider) as Provider;
		extended.getModels = () => [...provider.getModels(), ...added];
		models.setProvider(extended);
	}
}
