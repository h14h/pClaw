#!/usr/bin/env node
import { saveConfig } from "./config.ts";
import { createProfile, listProfiles, loadProfile } from "./profiles.ts";

/**
 *   pnpm profiles list
 *   pnpm profiles new <name> --from <profile> --provider <id> --model <id> [--thinking low] [--catalog-base <model>]
 *   pnpm profiles use <name>      make it what Discord runs, from the next restart
 */

const [command, name, ...rest] = process.argv.slice(2);
const option = (flag: string) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined);

if (command === "list" || command === undefined) {
	for (const each of listProfiles()) {
		const profile = loadProfile(each);
		console.log(`${each}: ${profile.provider}/${profile.model}, ${profile.thinkingLevel}`);
	}
} else if (command === "new" && name !== undefined) {
	const provider = option("--provider");
	const model = option("--model");
	const thinking = option("--thinking");
	const base = option("--catalog-base");
	const profile = createProfile(name, option("--from") ?? "muse-spark-1.3", {
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinkingLevel: thinking as "low" }),
		...(base === undefined ? {} : { catalogBase: base }),
	});
	console.log(`Made ${profile.dir}. Try it with \`pnpm evals ${name}\`, then tune it: docs/tuning-profiles.md.`);
} else if (command === "use" && name !== undefined) {
	loadProfile(name);
	saveConfig({ profile: name });
	console.log(`Set ${name}. Restart pclaw to run it: systemctl --user restart pclaw`);
} else {
	console.log("usage: pnpm profiles list | new <name> --from <profile> --provider <id> --model <id> [--thinking low] [--catalog-base <model>] | use <name>");
	process.exit(1);
}
