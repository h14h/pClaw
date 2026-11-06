# Working on pclaw

- TypeScript on Node 24, run directly with Node's type stripping. No build step. Use only erasable syntax (no enums, namespaces, or parameter properties).
- pnpm. `pnpm test` and `pnpm typecheck` before calling something done.
- The agent harness is Pi Durable (`@earendil-works/pi-durable`). It's experimental and its API moves; check `node_modules/@earendil-works/pi-durable/README.md` and the `.d.ts` files instead of guessing. Upstream examples live in `packages/durable/test/examples` of github.com/earendil-works/pi.
- New capabilities go in `src/extensions/` as one Pi extension each, installed in `src/agent.ts`.
- Anything that acts for the owner in the outside world and is hard to undo (send, buy, book, pay, delete, post) must wait for an explicit yes. Secrets never go into the model's context.
- The front model's prompt is its profile's `voice.md` then `src/prompts/front.md`. The voice guide is the owner's, tuned against real Instinct conversations; don't edit it without being asked, except when tuning a profile (docs/tuning-profiles.md). `front.md` covers how pclaw works; keep it short and plain. `src/prompts/worker.md` is appended to pi's default prompt for workers. The owner also edits both from the dashboard, so expect uncommitted changes to them. A new chat app gets a `src/prompts/formatting/<app>.md`, where `<app>` is the part of its conversation address before the first colon.
- Anything that changes with the model lives in `profiles/<name>/`, never in code. Adding a model is `pnpm profiles new`; judge changes with `pnpm evals`.
- The front model (talks to the person) stays fast and tool-light. Real work goes through `delegate` to workers (pi subprocesses, `src/extensions/workers.ts`).
- Real work on code or a named machine runs as a job: a T3 thread with a Discord thread and status card (`src/extensions/jobs.ts`). Job state is in `~/.pclaw/jobs.json`.
- T3 going down must never cost the owner a request or a debugging chore: a job asked for while it's down waits (`T3Down` in `src/t3-client.ts`) and the keeper starts it when T3 answers. T3 runs as `t3code.service` on mp1 and restarts itself.
- No activity should mean nothing is happening. In a channel, delegated work (a worker or a job) gets a thread that works like a session: a card, typing, updates, the result, and follow-ups all stay in it. A DM stays like texting: typing, then the answer.
- The board channel is for reading on purpose. Nothing may pull the owner's attention there: no mentions, no threads, no replies, no pins.
- Live tests of Discord behavior use a separate `PCLAW_HOME` with `discordQuiet: true`, so they can't ping the owner.
- The decision model only supplies hints (`src/decisions.ts`, `src/prompts/guidance.md`); it never decides what pclaw does. Before changing its questions, run the replay, and log what changed in `docs/decision-evals.md`.
- Agent tests use pi-ai's faux provider and a fake pi script (`src/agent.test.ts`). Don't spend real model calls in tests.
- The dashboard UI is `web/` (Vite + React + Tailwind + TanStack Router + Query). Its API shapes live in `src/dashboard/types.ts`; the web app imports them with `import type`. Keep it quiet and dense: Henry asked for no extraneous UI. After UI changes, `pnpm --filter pclaw-web build` makes them live; no restart needed.
