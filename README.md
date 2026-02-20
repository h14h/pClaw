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
