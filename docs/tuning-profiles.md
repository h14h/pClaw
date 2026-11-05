# Model profiles and tuning

Everything about the front model that changes with the model lives in `profiles/<name>/`. pclaw's code doesn't know about any particular model.

## What's in a profile

- `profile.json`: `provider`, `model`, `thinkingLevel`, `deferredTools` (tools hidden until the model finds them with `tool_search`; a trailing `*` matches a prefix), and `toolDescriptions` (replacement descriptions, by tool name). For a model pi's catalog doesn't list yet, `catalogBase` names a model on the same provider to copy settings from.
- `voice.md`: how it sounds.
- Any other prompt to override, by the same name as the shared one in `src/prompts/`: `front.md`, `guidance.md`, `worker.md`, `memory.md`, `compaction.md`, `formatting/discord.md`. Anything a profile doesn't have falls through to the shared file.

What stays out of profiles is the contract: what good behavior is. That's the eval cases, the rules enforced in code, and the shared code itself.

## Adding a model

```sh
pnpm profiles new gpt-6.1-terra --from muse-spark-1.3 --provider openai-codex --model gpt-6.1-terra --thinking low --catalog-base gpt-5.6-terra
pnpm evals gpt-6.1-terra
```

That's a copy of the source profile with a different model, and no code changes. If the provider needs signing in: `PCLAW_PROFILE=<name> pnpm pclaw login`. To make it what Discord runs: `pnpm profiles use <name>`, then restart pclaw.

## Evals

`pnpm evals <profile>` runs the real harness with the real prompts and tools. Workers and T3 are fakes, so nothing launches. Cases are synthetic so profiles can run on any provider without real conversations or notes reaching it.

- `evals/cases.json`: what tuning works against.
- `evals/holdout.json`: never read these while tuning. They catch fixes that only work on the cases.

Results land in `~/.pclaw/evals/runs/<profile>/`. A run is two passes because a single reply proves little.

## The tuning loop

This is meant to be run by an agent. From Discord, ask pclaw to tune a profile, and it starts a T3 job on the pclaw project with this file as the brief.

1. Run `pnpm evals <profile>` for a baseline. Read every failure, including the reply and the tools called.
2. Group failures by cause and pick the one that fails most.
3. Make one change, using the table below.
4. Run the affected cases with `--only`, then the full set.
5. Keep the change if the score rises with nothing else regressing. Otherwise undo it.
6. Log it in `profiles/<name>/TUNING.md`: what failed, what you changed, and the score before and after. Log what didn't work too.
7. Stop after 8 rounds, or 3 in a row with no gain.
8. Finish with `pnpm evals <profile> --holdout`, and report both scores. If the holdout score trails the cases by more than 15 points, the changes are probably fitting the cases, so say so.

| What goes wrong | Try |
|---|---|
| Picks the wrong tool, or misses one | Rewrite that tool's entry in `toolDescriptions`: say when to use it and when not to. Then `deferredTools`, if a rival tool keeps winning. |
| Ignores a rule | Add a line to its own `front.md` near where the rule matters, then a short example. Models differ on whether they follow rules better early or late. |
| Sounds off | Take the actual bad reply, and add it to `voice.md` as an Avoid with a Prefer beside it. |
| Claims work it didn't do | Add its exact phrasing as an Avoid, plus a line tying "saved" and "done" to a tool call. |
| Slow, or overthinks small things | Lower `thinkingLevel`, then re-check the routing cases. |
| Rushes, or misses asks in long messages | Raise `thinkingLevel`. |
| Misreads hints | Override `guidance.md`. |

## Rules for the tuning agent

- Change only files in `profiles/<name>/`.
- Never edit `evals/`, or read the holdout before the last step. A case that seems wrong gets reported, not changed.
- A rule that has to hold for every model belongs in code, not in a prompt. If you find one, report it.
- The owner's voice is the target. Don't trade it for a higher score.
- Don't switch what Discord runs. That's the owner's call.
