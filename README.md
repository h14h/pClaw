# Agent

> [!CAUTION]
> This is an experimental coding agent. Behavior, tool contracts, and model defaults may change without notice.
>
> Use in a sandboxed workspace and review file edits before applying in production environments.

## Overview

This project is a lightweight AI coding agent in Go with a terminal REPL loop and function-calling tools.

It is designed around three practical goals:

1. Simple local workflow: run one binary, chat in terminal.
2. Tool-capable agent: model can call filesystem tools (`read_file`, `list_files`, `edit_file`).
3. Provider-backed inference: chat completions are sent to Vultr Inference.

## Architecture

```text
agent/
├── main.go                    # Agent loop, Vultr chat completion client, tool dispatch
├── main_test.go               # Unit tests for tools and dispatch behavior
├── main_integration_test.go   # Real API integration tests (requires credentials)
└── specs/
    └── README.md              # Specs index
```

### Key Components

| Component | Description |
|-----------|-------------|
| Agent loop | Reads user input, sends conversation to model, executes requested tools, continues until completion |
| Inference client | Calls `POST /chat/completions` on Vultr Inference using `kimi-k2-instruct` (+ delegated `gpt-oss-120b` reasoning tool) |
| Tool system | Defines tool metadata + JSON schema and executes tool calls from model responses |
| File tools | `read_file`, `list_files`, `edit_file` for workspace interaction |

## Requirements

- Go 1.24+
- A Vultr Inference API key

## Configuration

Environment variables:

- `VULTR_API_KEY` (required): API token for Vultr Inference
- `VULTR_BASE_URL` (optional): API base URL (default: `https://api.vultrinference.com/v1`)
- `DISCORD_BOT_TOKEN` (optional): enables Discord mode when set
- `DISCORD_APPLICATION_ID` (optional): Discord application ID for slash command registration
- `DISCORD_GUILD_ID` (optional): registers slash command to one guild for faster propagation
- `DISCORD_ALLOWED_CHANNEL_IDS` (optional): comma-separated channel allowlist
- `DISCORD_ALLOWED_USER_IDS` (optional): comma-separated user allowlist

Model behavior is fixed:

- Primary model: `kimi-k2-instruct`
- Delegated reasoning model: `gpt-oss-120b` via `delegate_reasoning` tool

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
- Splits long responses into multiple Discord messages under platform size limits
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

Current status: the index references additional spec files that are not yet present in `specs/`.
