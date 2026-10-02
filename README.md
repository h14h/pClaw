# pclaw

A small personal assistant you text on Discord. The name is short for pico claw, as in a much smaller [OpenClaw](https://github.com/openclaw/openclaw).

It's modeled on [Instinct](https://www.vellum.ai/blog/official-instinct-breakdown): one ongoing conversation with someone who pays attention to how you're doing, remembers what matters, and gets things done. Unlike Instinct, it runs on your machine, keeps its memory in a file you can read, and asks before doing anything on your behalf that's hard to undo.

It's early. Today it can talk, remember, follow up on its own, and hand real work to a smarter agent. See [docs/roadmap.md](docs/roadmap.md) for what comes next.

## What it does now

- Talks to you in Discord DMs and answers only you. The first person to DM it becomes its owner.
- Remembers things about you in `~/.pclaw/notes.md`. You can edit that file and it sees the change on the next message.
- Schedules its own follow-ups ("how did the interview go?") and reminders you ask for. They survive restarts.
- Hands research, lookups, and anything with files or many steps to a worker, then tells you what came back.
- Sees images you send it.

## Setup

You need Node 24+, pnpm, [pi](https://github.com/earendil-works/pi) (`npm install -g @earendil-works/pi-coding-agent`), a SuperGrok or X Premium subscription, and a Discord account.

```sh
git clone https://github.com/h14h/pClaw pclaw && cd pclaw
pnpm install
pnpm setup
```

`pnpm setup` signs you in to xAI in the browser and asks for a Discord bot token. The sign-in goes in pi's `~/.pi/agent/auth.json`, so pclaw and its pi workers share it; if pi is already signed in to xAI, there's nothing to do. To get the token, go to the [Discord developer portal](https://discord.com/developers/applications), click New Application, open Bot, click Reset Token, and copy it. Turn off Public Bot on the same page so nobody else can add it.

Then start it:

```sh
pnpm start
```

A bot can only receive DMs from people it shares a server with. If it isn't in one yet, `pnpm start` prints an invite link. Add it to a server you're in, then DM it.

While it runs, pclaw serves a dashboard on `127.0.0.1:7421` (`dashboardPort`): the conversation including what Discord doesn't show (tool calls, held replies, worker reports), running workers, and each worker's full transcript, all updating live. Put it behind a private proxy to reach it from other devices; it has no login of its own.

To keep it running on a Linux box, `deploy/pclaw.service` is a systemd user service; the install steps are at the top of the file.

To try it without Discord, `pnpm chat` opens a conversation in the terminal. It keeps its own history, so it won't mix with your Discord thread.

## Settings

`~/.pclaw/config.json` holds the settings. Environment variables override it.

| Setting | Env var | Default |
|---|---|---|
| `model` | `PCLAW_MODEL` | `grok-4.5` |
| `provider` | `PCLAW_PROVIDER` | `xai` |
| `thinkingLevel` | `PCLAW_THINKING` | `medium` |
| `workerModel` | `PCLAW_WORKER_MODEL` | `grok-4.7` |
| `workerThinkingLevel` | `PCLAW_WORKER_THINKING` | `high` |
| `workerCommand` | | `pi` |
| `workerTimeoutMinutes` | | `30` |
| `dashboardPort` | `PCLAW_DASHBOARD_PORT` | `7421` |
| `authFile` | `PI_CODING_AGENT_DIR` moves it | `~/.pi/agent/auth.json` |
| `timeZone` | `PCLAW_TZ` | the machine's time zone |
| `discordToken` | `DISCORD_TOKEN` | set by `pnpm setup` |
| `discordOwnerId` | `PCLAW_DISCORD_OWNER_ID` | set when you first DM it |

`PCLAW_HOME` moves the whole `~/.pclaw` directory.

## How it's built

Two models, split the way [exe.dev's "run fewer agents"](https://blog.exe.dev/etoomanythings) suggests. The one you talk to is fast and conversational: Grok 4.5 on medium, prompted for voice and judgment, with no shell or browser of its own. It answers in seconds and keeps the thread. Anything that takes real work goes to a worker: [pi](https://github.com/earendil-works/pi) with its default coding-agent prompt and tools, running Grok 4.7 on high, in `~/.pclaw/work`. The worker reports back into the conversation and the front model tells you what matters. Each job keeps its pi session, so corrections continue where it left off. Claude Code or Codex can slot in as workers later.

pclaw runs on [Pi Durable](https://earendil.com/posts/pi-durable/), a harness that writes every message, model turn, and tool call to SQLite before acting on it. If the process dies mid-reply, it picks up where it stopped. Follow-ups and worker runs are durable tasks; a worker cut off by a restart resumes its pi session.

- `src/prompts/voice.md` is how pclaw talks, built from real Instinct conversations. `src/prompts/operating.md` is how it works: workers, memory, follow-ups.
- `src/extensions/` holds the tools, one extension each: notes, follow-ups, workers.
- `~/.pclaw/work/AGENTS.md` is the workers' standing brief. pclaw writes a default the first time and leaves your edits alone.
- `src/channels/` connects conversations to Discord and the terminal.
- `src/delivery.ts` sends replies out in order and remembers what it has sent.
- `src/dashboard/` is the dashboard's API; `web/` is its UI (Vite, React, Tailwind, TanStack Router and Query). Build it with `pnpm --filter pclaw-web build`; pclaw serves `web/dist`. `PCLAW_FIXTURE=live pnpm --filter pclaw-web dev` runs the UI against a scripted conversation, no pclaw needed.

```sh
pnpm test        # unit tests, plus agent tests against a scripted model
pnpm typecheck
```

## License

MIT
