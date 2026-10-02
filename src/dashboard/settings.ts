import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import type { Agent } from "../agent.ts";
import { type Config, saveConfig } from "../config.ts";
import type { WorkerOptions } from "../extensions/workers.ts";
import { type PromptName, prompts, readPrompt, writePrompt } from "../prompts.ts";
import type { ModelInfo, ModelOption, ModelsUpdate, Settings } from "./types.ts";

export class SettingsError extends Error {}

/**
 * What the settings page reads and writes. Model changes go to config.json and take effect on the next request: the
 * front model by reconfiguring every conversation, the worker model by updating the options each pi run reads.
 */
export function settingsApi(options: { agent: Agent; config: Config; models: Models; workers: WorkerOptions }) {
	const { agent, config, models, workers } = options;

	function modelOptions(): ModelOption[] {
		const providers = new Set([config.provider, workers.provider]);
		return [...providers].flatMap((provider) =>
			models.getModels(provider).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				thinkingLevels: getSupportedThinkingLevels(model),
			})),
		);
	}

	function get(): Settings {
		const prompt = (name: PromptName) => ({ text: readPrompt(name), path: prompts[name].path, description: prompts[name].description });
		return {
			front: { provider: config.provider, model: config.model, thinkingLevel: config.thinkingLevel },
			worker: { provider: workers.provider, model: workers.model, thinkingLevel: workers.thinkingLevel },
			models: modelOptions(),
			prompts: { front: prompt("front"), worker: prompt("worker") },
		};
	}

	function validate(choice: ModelInfo): ModelThinkingLevel {
		const option = modelOptions().find((each) => each.provider === choice.provider && each.id === choice.model);
		if (option === undefined) throw new SettingsError(`Unknown model ${choice.provider}/${choice.model}.`);
		if (!option.thinkingLevels.includes(choice.thinkingLevel)) {
			throw new SettingsError(`${option.name} doesn't support reasoning level "${choice.thinkingLevel}".`);
		}
		return choice.thinkingLevel as ModelThinkingLevel;
	}

	async function updateModels(update: ModelsUpdate, context: Context): Promise<Settings> {
		// Validate both before applying either.
		const front = update.front === undefined ? undefined : { ...update.front, thinkingLevel: validate(update.front) };
		const worker = update.worker === undefined ? undefined : { ...update.worker, thinkingLevel: validate(update.worker) };
		if (front !== undefined) {
			await agent.setModel(front, context);
			Object.assign(config, { provider: front.provider, model: front.model, thinkingLevel: front.thinkingLevel });
			saveConfig({ provider: front.provider, model: front.model, thinkingLevel: front.thinkingLevel });
		}
		if (worker !== undefined) {
			Object.assign(workers, { provider: worker.provider, model: worker.model, thinkingLevel: worker.thinkingLevel });
			Object.assign(config, { workerProvider: worker.provider, workerModel: worker.model, workerThinkingLevel: worker.thinkingLevel });
			saveConfig({ workerProvider: worker.provider, workerModel: worker.model, workerThinkingLevel: worker.thinkingLevel });
		}
		return get();
	}

	function savePrompt(name: string, text: unknown): Settings {
		if (name !== "front" && name !== "worker") throw new SettingsError(`No prompt named ${name}.`);
		if (typeof text !== "string" || text.trim() === "") throw new SettingsError("A prompt can't be empty.");
		writePrompt(name, text);
		return get();
	}

	return { get, updateModels, savePrompt };
}
