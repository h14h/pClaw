# Agent Architecture

## Overview

This project is an AI-powered coding agent implemented as a single Go binary with a terminal REPL.
It combines:

1. Interactive chat loop for user input/output
2. LLM inference requests to Vultr chat completions
3. Tool-calling for local filesystem actions
4. Optional Discord slash-command transport

The architecture is intentionally compact: orchestration, inference client, message types, and tool
implementations are all in `main.go`.

## Code Structure

```text
agent/
├── main.go                    # Agent runtime, inference client, tool definitions
├── main_test.go               # Unit tests for tools + dispatch
├── main_integration_test.go   # Live Vultr integration tests
└── specs/
    ├── architecture.md
    ├── tool-system.md
    ├── llm-inference.md
    ├── configuration.md
    └── testing.md
```

## Runtime Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `Agent` | `main.go` | Maintains configuration and executes chat/tool loop |
| `runInferenceStreamWithModel` | `main.go` | Primary-model streaming inference for CLI token output |
| `runInferenceWithModel` | `main.go` | Non-streaming inference path and delegated reasoning calls |
| `StatusIndicator` | `main.go` | Delayed ephemeral CLI progress indicator for wait states |
| `executeTool` | `main.go` | Dispatches model tool calls to registered Go functions |
| `delegateReasoning` | `main.go` | Delegates hard reasoning sub-tasks to `gpt-oss-120b` |
| `HandleUserMessage` | `main.go` | Transport-agnostic single-turn model/tool loop for external adapters |
| Discord runtime | `discord.go` | Registers `/agent`, handles interactions, and manages per-session conversations |
| Tool functions | `main.go` | Perform filesystem operations (`read_file`, `list_files`, `edit_file`) |
| Startup wiring (`main`) | `main.go` | Reads env config, builds `Agent`, starts interactive session |

## End-to-End Flow

```text
┌──────────┐
│   User   │
└────┬─────┘
     │ terminal input
     ▼
┌──────────────┐
│ Agent.Run()  │
│ conversation │
└────┬─────────┘
     │ calls
     ▼
┌──────────────────────────┐
│ runInferenceStreamWith...│
│ POST /chat/completions   │
└────┬─────────────────────┘
     │ text deltas + ChatMessage
     ▼
┌──────────────────────────┐
│ Assistant output +       │
│ wait indicators          │
│ - streamed text and/or   │
│   final tool_calls       │
└────┬─────────────────────┘
     │ if tool_calls
     ▼
┌──────────────────────────┐
│ executeTool()            │
│ read/list/edit files     │
└────┬─────────────────────┘
     │ tool result message
     └───────────► appended to conversation, then sent back to inference
```

## Conversation Control

`Agent.Run()` toggles between two modes:

1. `readUserInput = true`: read one user line and append as `role=user`
2. `readUserInput = false`: continue model-tool-model loop without asking user again

This lets the model call tools, receive tool outputs, and produce a final response inside one turn.

Reasoning call count is reset for each new user turn to bound delegated reasoning usage.

`Agent.Run()` and tool execution paths include delayed ephemeral status indicators:

1. `waiting for model...` while awaiting first primary-model output
2. `delegating reasoning...` during delegated reasoning inference
3. `running <tool_name>...` for slow non-reasoning tool execution

Current indicator delay configuration:

1. General wait indicator delay: `150ms`
2. Tool-running indicator delay: `200ms`

Tool lifecycle events (`tool_call.started|succeeded|failed`) remain available internally and can be surfaced in CLI debug mode with `TOOL_EVENT_LOG=debug`.

## Design Constraints

1. Single-process, single-threaded control loop
2. No conversation persistence outside process memory
3. No workspace sandboxing; tools operate on provided paths
4. Tool and inference schemas are static per process start
5. Primary model is fixed to `kimi-k2-instruct`; reasoning model is fixed to `gpt-oss-120b`

In Discord mode, each `(channel_id, user_id)` conversation key is isolated with a dedicated in-memory agent/session state and mutex.

## Extension Points

1. Add tools by appending new `ToolDefinition` entries during startup
2. Add transport concerns (timeouts/retries) by configuring `http.Client`
3. Split monolithic `main.go` into packages once responsibilities grow
