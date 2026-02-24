# Agent

> [!CAUTION]
> USE AT YOUR OWN RISK.
>
> This is an experimental coding agent. Behavior, tool contracts, and model defaults may change without notice.
>
> It is strongly recommended to only run in a sandboxed workspace, and extreme care should be exercised when managing access rules.

## Overview

This project is a lightweight AI coding agent in Go with a terminal REPL loop and function-calling tools.

It is designed around three practical goals:

1. Lightweight operation: runs comfortably on cheap hardware (e.g. VPS with 1 vCPU & 1 GB RAM)
2. Maximizing value: supports Vultr's inference product by default for $0.20/M tokens of Kimi K2 & GPT OSS 120B
3. Sensible defaults: one env var (VULTR_API_KEY) nets a fully functional CLI agent w/ tool calling & vector-based long-term memory w/ semantic lookup

## Architecture

```text
agent/
├── main.go                    # Agent runtime, inference client, tool definitions
├── discord.go                 # Discord runtime, command/mention handlers, session manager
├── memory.go                  # MemoryClient, record tool, auto-recall, configureMemory
├── prompting.go               # System prompt builder (SectionedPromptBuilder)
├── main_test.go               # Unit tests for tools + dispatch
├── discord_test.go            # Unit tests for Discord splitting, sessions, progressive send
├── memory_test.go             # Unit tests for MemoryClient, record tool, and auto-recall
├── prompting_test.go          # Unit tests for prompt builder modes and injection
├── main_integration_test.go   # Live Vultr integration tests
├── main_delegation_harness_integration_test.go # Delegation policy harness (opt-in E2E)
├── scripts/
│   └── run-delegation-harness.sh
└── specs/
    └── README.md              # Specs index
```

### Key Components

| Component | Description |
|-----------|-------------|
| Agent loop | Reads user input, sends conversation to model, executes requested tools, continues until completion |
| Inference client | Calls `POST /chat/completions` on Vultr Inference using, by default, `kimi-k2-instruct` (+ delegated `gpt-oss-120b` reasoning tool) |
| Tool system | Defines tool metadata + JSON schema and executes tool calls from model responses |
| File tools | `read_file`, `list_files`, `edit_file` for workspace interaction |
| Reasoning delegation | `delegate_reasoning` dispatches sub-problems to, e.g., `gpt-oss-120b` |
| Memory tools | `record` and `recall` for durable semantic memory via Vultr vector store (when enabled) |

## Requirements

- Go 1.24+
- A Vultr Inference API key

## Configuration

Environment variables:

- `VULTR_API_KEY` (required): API token for Vultr Inference
- `VULTR_BASE_URL` (optional): API base URL (default: `https://api.vultrinference.com/v1`)
- `TOOL_EVENT_LOG` (optional): CLI tool lifecycle logging (`off` or `debug`)
- `SERVER_EVENT_LOG` (optional): server lifecycle logging (`off`, `line`, or `verbose`; `verbose` includes full response/chunk content fields)
- `DISCORD_BOT_TOKEN` (optional): enables Discord mode when set
- `DISCORD_APPLICATION_ID` (optional): Discord application ID for slash command registration
- `DISCORD_GUILD_ID` (optional): registers slash command to one guild for faster propagation
- `DISCORD_ALLOWED_CHANNEL_IDS` (optional): comma-separated channel allowlist
- `DISCORD_ALLOWED_USER_IDS` (optional): comma-separated user allowlist
- `AGENT_NAME` (optional): overrides prompt identity name
- `AGENT_ROLE_SUMMARY` (optional): overrides prompt role summary sentence
- `AGENT_PERSONA` (optional): inline persona text for the system prompt
- `AGENT_PERSONA_FILE` (optional): file path for persona text (takes precedence over `AGENT_PERSONA`)
- `AGENT_PROMPT_MAX_PERSONA_CHARS` (optional): max persona characters included in prompt (default: `600`)
- `MEMORY_ENABLED` (optional): set to `false`, `0`, or `no` to disable durable memory (default: enabled)
- `MEMORY_COLLECTION_NAME` (optional): Vultr vector store collection name (default: `agent-memory`)

Model behavior is fixed (for now):

- Primary model: `kimi-k2-instruct` (max tokens: `4096`)
- Delegated reasoning model: `gpt-oss-120b` via `delegate_reasoning` tool (max tokens: `1024`)
- Memory summarization model: `gpt-oss-120b` (max tokens: `256`)

## Building

```bash
go build ./...
```

## Usage

Run the agent:

```bash
export VULTR_API_KEY="your-token"
go run .
```

Run in Discord mode:

```bash
export VULTR_API_KEY="your-token"
export DISCORD_BOT_TOKEN="your-bot-token"
# Optional but recommended for reliable command registration:
export DISCORD_APPLICATION_ID="your-application-id"
# Optional for fast guild-scoped command registration:
export DISCORD_GUILD_ID="your-guild-id"
go run .
```

Optional base URL override:

```bash
export VULTR_BASE_URL="https://api.vultrinference.com/v1"
go run .
```

Prompt config override example:

```bash
export AGENT_NAME="OpenClaw-Inspired Operator"
export AGENT_ROLE_SUMMARY="A decisive software engineering operator that prioritizes correctness and momentum."
export AGENT_PERSONA_FILE="./persona.txt"
export AGENT_PROMPT_MAX_PERSONA_CHARS="900"
go run .
```

### REPL behavior

- Prompt shows as `You:`
- Assistant responses print as `Assistant:`
- Tool execution now emits event-style, human-readable logs (`started`/`succeeded`/`failed`) per call
- Exit with `Ctrl+C` or EOF (`Ctrl+D`)

### Discord behavior

- When `DISCORD_BOT_TOKEN` is set, startup runs Discord mode instead of terminal REPL mode
- Registers `/agent` slash command with a required `prompt` argument
- Supports mention-based chat in channels: `@your-bot <prompt>`
- Maintains conversation context per `(channel_id, user_id)` session key
- Streams assistant turn text progressively to Discord as each assistant message is produced in the tool loop
- Keeps Discord typing indicators alive while progressive responses are still being generated
- Splits long responses into multiple Discord messages under platform size limits
- Honors optional `<<MSG_SPLIT>>` markers for logical boundaries and uses balanced fallback splitting to avoid tiny trailing messages
- Requires bot intents for message events; enable `Message Content Intent` in the Discord Developer Portal

## Testing

Run unit tests:

```bash
go test ./...
```

Run only integration tests against real Vultr API:

```bash
VULTR_API_KEY="your-token" go test -run E2E ./...
```

Run delegation policy harness (opt-in, live API):

```bash
VULTR_API_KEY="your-token" RUN_DELEGATION_HARNESS=1 go test -run TestDelegationPolicyHarness_E2E ./...
```

Or use the on-demand wrapper script with useful stdout reporting:

```bash
VULTR_API_KEY="your-token" ./scripts/run-delegation-harness.sh
```

## Specifications

Design docs are indexed in `specs/README.md`.

## Clear TODOs

 - [ ] Set up guides for supported inference providers & messaging platforms
 - [ ] Internet connectivity of some kind (e.g. a web search tool call)
 - [ ] Agent self-direction (e.g. a "Heartbeat" cron job that kicks of a scheduled agent loop)

## Potential Future Features

- [ ] Configuring inference providers beyond Vultr (e.g. OpenRouter)
- [ ] Supporting messaging platforms besides Discord (e.g. Matrix)
- [ ] A "Work Delegation" tool call that can kick off other agents (e.g. Claude Code) 
- [ ] Export pipelines (e.g. creating notes/todos in a third-party app)
- [ ] Import pipelines (e.g. receiving agent tasks through Raycast plugin or Siri or w/e)
- [ ] Agent "enrichment" activities for creating self-directed memories (e.g. an RSS feed)
