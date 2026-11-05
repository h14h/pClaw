# pclaw

A small personal assistant you text on Discord. The name is short for pico claw, as in a much smaller [OpenClaw](https://github.com/openclaw/openclaw).

It's modeled on [Instinct](https://www.vellum.ai/blog/official-instinct-breakdown): one ongoing conversation with someone who pays attention to how you're doing, remembers what matters, and gets things done. Unlike Instinct, it runs on your machine, keeps its memory in a file you can read, and asks before doing anything on your behalf that's hard to undo.

It's early. Today it can talk, remember, follow up on its own, and hand real work to a smarter agent. See [docs/roadmap.md](docs/roadmap.md) for what comes next.

## What it does now

- Talks to you in Discord DMs, and in server channels you list in `discordChannels`. It answers only you; the first person to DM it becomes its owner.
- Threads in those channels branch the conversation: a thread starts from the channel's history up to the message it was started on, then goes its own way. Replying to an older message quotes it back into the conversation.
- Keeps context small: once a conversation's prompt passes 60K tokens, older messages are summarized and the last ~16K tokens stay word for word. A `recall` tool searches everything said before, summarized or not.
- Remembers things about you in `~/.pclaw/notes.md`. Once a conversation has been quiet for 20 minutes, a background pass reads what was said and updates the notes. You can edit the file and it sees the change on the next message.
- Schedules its own follow-ups ("how did the interview go?") and reminders you ask for. They survive restarts.
- Answers one-lookup questions (hours, a time, a price) itself with a quick web search, in a few seconds.
- Hands research, comparisons, and anything with files or many steps to a worker, then tells you what came back. Quick jobs run with less reasoning than deep ones.
- Shows what's running. In a DM that's a typing indicator until the answer lands. In a channel, delegated work gets a thread under your message, and that thread is the session: updates in pclaw's own voice, the result, and any follow-ups all live there.
- Uses reactions as status: your message gets a badge while a worker is on it (⏳ or a topical emoji) and a closing one when the report is back (✅, 🎉, or something that fits bad news; ⚠️ if the job failed). It can answer "thanks" with just a reaction, and your reactions on its messages reach it as input.
- Runs work you'd want to open later as jobs: `start_job` opens a T3 Code thread on any machine T3 can reach, with no time limit. In a channel the job also gets a Discord thread under your message, with a status card that updates itself. Replies there land silently unless pclaw decides you should be interrupted. One-off checks on a machine run as background jobs, and their T3 threads settle themselves.
- Takes hints from a small decision model when one's configured (`decisionUrl`). The hints are advice the front model can ignore, and they're logged so behavior can be measured. See [docs/decision-evals.md](docs/decision-evals.md).
- Builds simple web pages (an itinerary, a comparison, a checklist) from one standard template and publishes them privately at `<dashboard>/pages/<slug>/`.
- Sees images you send it, and hears voice memos, transcribed by a local speech model (`speechUrl`). Originals are kept in `~/.pclaw/voice`.

## Setup

You need Node 24+, pnpm, [pi](https://github.com/earendil-works/pi) (`npm install -g @earendil-works/pi-coding-agent`), Meta's Muse Code CLI signed in (`muse login`) on a Muse Code subscription, a [Tavily](https://app.tavily.com) API key for web search (the free tier is plenty), and a Discord account.

```sh
git clone https://github.com/h14h/pClaw pclaw && cd pclaw
pnpm install
pnpm setup
```

`pnpm setup` signs you in to Meta in the browser (or whichever `provider` you set), checks that Muse Code is signed in for the workers, and asks for a Discord bot token. The sign-in goes in pi's `~/.pi/agent/auth.json`, shared with any pi workers; if pi is already signed in, there's nothing to do. To get the token, go to the [Discord developer portal](https://discord.com/developers/applications), click New Application, open Bot, click Reset Token, and copy it. Turn off Public Bot on the same page so nobody else can add it.

Then start it:

```sh
pnpm start
```

A bot can only receive DMs from people it shares a server with. If it isn't in one yet, `pnpm start` prints an invite link. Add it to a server you're in, then DM it.

While it runs, pclaw serves a dashboard on `127.0.0.1:7421` (`dashboardPort`): the conversation including what Discord doesn't show (tool calls, held replies, worker reports), running workers, and each worker's full transcript, all updating live. Put it behind a private proxy to reach it from other devices; it has no login of its own.

To keep it running on a Linux box, `deploy/pclaw.service` is a systemd user service; the install steps are at the top of the file.

To try it without Discord, `pnpm chat` opens a conversation in the terminal. It keeps its own history, so it won't mix with your Discord thread.

## Models

Everything model-specific lives in a folder under `profiles/`, so adding one takes no code. See [docs/tuning-profiles.md](docs/tuning-profiles.md).

## Settings

`~/.pclaw/config.json` holds the settings. Environment variables override it.

| Setting | Env var | Default |
|---|---|---|
| `model` | `PCLAW_MODEL` | `muse-spark-1.3` |
| `provider` | `PCLAW_PROVIDER` | `meta` |
| `thinkingLevel` | `PCLAW_THINKING` | `medium` |
| `workerProvider` | | `muse` (Muse Code; any other provider runs workers in pi) |
| `workerModel` | `PCLAW_WORKER_MODEL` | `muse-wonder-full-1.0` |
| `workerThinkingLevel` | `PCLAW_WORKER_THINKING` | `high` (deep jobs) |
| `workerQuickThinkingLevel` | | `medium` (quick jobs) |
| `tavilyApiKey` | `TAVILY_API_KEY` | set by `pnpm setup` |
| `parallelApiKey` | `PARALLEL_API_KEY` | optional, set by `pnpm setup` |
| `searchService` | `PCLAW_SEARCH` | `tavily` (or `parallel`; the dashboard switches it) |
| `pageService` | `PCLAW_PAGE_READER` | `tavily` (or `parallel`; the dashboard switches it) |
| `workerSkills` | | `[]` (more skill folders for workers, e.g. `["~/scripts/skills/publish"]`) |
| `workerCommand` | | `pi` |
| `museCommand` | | `muse` |
| `workerTimeoutMinutes` | | `30` |
| `memoryQuietMinutes` | | `20` |
| `summarizeAtTokens` | | `60000` |
| `keepRecentTokens` | | `16000` |
| `discordChannels` | | `[]` (DMs only; text channels in a category named Projects count too) |
| `discordBoardChannel` | | unset (a channel for one always-current list of jobs; pclaw never answers or mentions anyone there) |
| `jobModel` | | `claude-opus-5-5` |
| `jobPollSeconds` | | `15` |
| `jobProgressSeconds` | | `45` |
| `decisionUrl` | | unset (no hints; the front model decides alone) |
| `speechUrl` | | unset (voice memos can't be heard) |
| `decisionHoldout` | | `0.2` (share of decisions logged but not shown) |
| `dashboardPort` | `PCLAW_DASHBOARD_PORT` | `7421` |
| `pagesUrl` | | the dashboard's `/pages` |
| `pagePublisher` | | unset (pclaw serves pages itself) |
| `authFile` | `PI_CODING_AGENT_DIR` moves it | `~/.pi/agent/auth.json` |
| `timeZone` | `PCLAW_TZ` | the machine's time zone |
| `discordToken` | `DISCORD_TOKEN` | set by `pnpm setup` |
| `discordOwnerId` | `PCLAW_DISCORD_OWNER_ID` | set when you first DM it |

`PCLAW_HOME` moves the whole `~/.pclaw` directory.

## How it's built

Two models, split the way [exe.dev's "run fewer agents"](https://blog.exe.dev/etoomanythings) suggests. The one you talk to is fast and conversational: Muse Spark 1.3 on medium, prompted for voice and judgment, with no shell or browser of its own. It answers in seconds and keeps the thread. Anything that takes real work goes to a worker in `~/.pclaw/work`: by default Meta's Muse Code CLI running Muse Wonder Full (`src/muse.ts`), or [pi](https://github.com/earendil-works/pi) with its default coding-agent prompt and tools when `workerProvider` is a pi provider. pi workers get pclaw's search, page reader, and page publisher as tools (`src/worker-tools.ts`); harnesses without extensions get the same as a command (`src/worker-cli.ts`) and pclaw's worker prompt and skills in front of the first message. Muse workers run headless with approval prompts and Muse's sandbox off, the same reach pi workers have, and without your personal Claude Code rules and skills; pi workers don't load your personal pi extensions, skills, or AGENTS.md files. The worker reports back into the conversation and the front model tells you what matters. Each job keeps its session in the harness it started in, so corrections continue where it left off. Claude Code or Codex can slot in as more harnesses the same way.

pclaw runs on [Pi Durable](https://earendil.com/posts/pi-durable/), a harness that writes every message, model turn, and tool call to SQLite before acting on it. If the process dies mid-reply, it picks up where it stopped. Follow-ups and worker runs are durable tasks; a worker cut off by a restart resumes its session.

- `src/prompts/front.md` is the front model's system prompt: how pclaw talks (built from real Instinct conversations) and how it works. `src/prompts/worker.md` is added to every worker's instructions. Both are read on every request, so edits apply right away. The dashboard's settings page edits every markdown file here and in the workers' skills. `src/prompts/formatting/<app>.md` holds each app's etiquette (what renders, how long a message can be) for Discord and the terminal. The front model gets the one for the app the conversation is on, as the very last part of its prompt, so the voice stays the same everywhere and only the etiquette changes.
- `src/extensions/` holds the tools, one extension each: notes, follow-ups, workers.
- `src/skills/web-page/` is the page skill workers load: `SKILL.md` (how to build and publish), `STYLE.md` (the style guide), and `template/`. Published pages are checked for anything loading from outside the page, then served by pclaw. To put pages somewhere else (a subdomain, a public host), set `pagePublisher` to a command that takes `<slug> <dir>` and prints the URL; that's where deployment specifics live, outside pclaw.
- `pnpm prose-lab` tunes how the front model writes. `pnpm prose-lab extract <entry id>...` saves moments from your own conversation as scenarios. `pnpm prose-lab run live my-try --runs 3` replays each one with every prompt variant you name and checks the reply the way Discord shows it (tables, headings, bold, length, links). A second model scores how natural, tight, and complete each reply is. Variants are folders of `front.md` plus `discord.md` in `~/.pclaw/prose-lab/variants/`. `live` is the current prompts and `none` is no prompt at all. Results land in `~/.pclaw/prose-lab/runs/`, with every reply side by side in `replies.md`. Everything stays under `~/.pclaw`, since it's your conversations.
- `pnpm prose-lab serve` does the same from a web page (port 7423, `deploy/prose-lab.service`): paste two system prompts, pick scenarios or type your own messages, and read both sets of replies side by side with their checks and judge scores. `pnpm --filter prose-lab-web build` rebuilds the page. Runs are saved in `~/.pclaw/prose-lab/web/`.
- `src/search.ts` runs searches and page reads through Tavily or [Parallel](https://parallel.ai), each behind the same two calls. `pnpm search-bench "a query"` (or `--read <url>`) runs the same thing through every service with a key and prints how each did.
- `src/channels/` connects conversations to Discord and the terminal.
- `src/delivery.ts` sends replies out in order and remembers what it has sent.
- `src/dashboard/` is the dashboard's API; `web/` is its UI (Vite, React, Tailwind, TanStack Router and Query). Build it with `pnpm --filter pclaw-web build`; pclaw serves `web/dist`. `PCLAW_FIXTURE=live pnpm --filter pclaw-web dev` runs the UI against a scripted conversation, no pclaw needed.

```sh
pnpm test        # unit tests, plus agent tests against a scripted model
pnpm typecheck
```

## License

MIT
