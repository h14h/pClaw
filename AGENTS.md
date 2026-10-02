# Working on pclaw

- TypeScript on Node 24, run directly with Node's type stripping. No build step. Use only erasable syntax (no enums, namespaces, or parameter properties).
- pnpm. `pnpm test` and `pnpm typecheck` before calling something done.
- The agent harness is Pi Durable (`@earendil-works/pi-durable`). It's experimental and its API moves; check `node_modules/@earendil-works/pi-durable/README.md` and the `.d.ts` files instead of guessing. Upstream examples live in `packages/durable/test/examples` of github.com/earendil-works/pi.
- New capabilities go in `src/extensions/` as one Pi extension each, installed in `src/agent.ts`.
- Anything that acts for the owner in the outside world and is hard to undo (send, buy, book, pay, delete, post) must wait for an explicit yes. Secrets never go into the model's context.
- `src/prompts/voice.md` is the owner's voice prompt, tuned against real Instinct conversations. Don't edit it without being asked. `src/prompts/operating.md` covers how pclaw works; keep it short and plain.
- The front model (talks to the person) stays fast and tool-light. Real work goes through `delegate` to workers (pi subprocesses, `src/extensions/workers.ts`).
- Agent tests use pi-ai's faux provider and a fake pi script (`src/agent.test.ts`). Don't spend real model calls in tests.
- The dashboard UI is `web/` (Vite + React + Tailwind + TanStack Router + Query). Its API shapes live in `src/dashboard/types.ts`; the web app imports them with `import type`. Keep it quiet and dense: Henry asked for no extraneous UI. After UI changes, `pnpm --filter pclaw-web build` makes them live; no restart needed.
