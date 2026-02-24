# Agent Architecture

## Overview

This project is an AI-powered coding agent implemented as a single Go binary with a terminal REPL.
It combines:

1. Interactive chat loop for user input/output
2. LLM inference requests to Vultr chat completions
3. Tool-calling for local filesystem actions
4. Optional Discord transport (slash commands and mention chat)

The architecture is intentionally compact: orchestration, inference client, message types, and tool
implementations are all in `main.go`.

## Code Structure

```text
agent/
├── main.go                    # Agent runtime, inference client, tool definitions
├── discord.go                 # Discord runtime, command/mention handlers, session manager
├── memory.go                  # MemoryClient, record tool, auto-recall, configureMemory
├── prompting.go               # System prompt builder (SectionedPromptBuilder)
├── main_test.go               # Unit tests for tools + dispatch
├── memory_test.go             # Unit tests for MemoryClient, record tool, and auto-recall
├── main_integration_test.go   # Live Vultr integration tests
├── main_delegation_harness_integration_test.go # Delegation policy harness (opt-in E2E)
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
| `HandleUserMessageProgressive` | `main.go` | Transport-agnostic loop variant that emits assistant text parts incrementally via callback |
| Discord runtime | `discord.go` | Registers `/agent`, handles interactions, and manages per-session conversations |
| Tool functions | `main.go` | Perform filesystem operations (`read_file`, `list_files`, `edit_file`) |
| Startup wiring (`main`) | `main.go` | Reads env config, builds `Agent`, starts interactive session |
| `MemoryClient` | `memory.go` | HTTP client for Vultr vector store; handles collection bootstrap, item add, search, list, delete item, delete collection |
| `configureMemory` | `memory.go` | Reads `MEMORY_ENABLED`/`MEMORY_COLLECTION_NAME`, creates `MemoryClient`, bootstraps collection, sets `agent.memoryClient` |
| `recallMemories` | `memory.go` | Performs semantic search, summarizes results via `summarizeMemories`, and formats as `[Memory]` system-prompt section |
| `summarizeMemories` | `memory.go` | Direct HTTP POST to chat completions (bypasses `runInferenceWithModel`) to produce compact summary of memory items |
| `recordFunction` | `memory.go` | Tool handler for `record`; stores user-provided content via `MemoryClient.AddItem` |
| `recallFunction` | `memory.go` | Tool handler for `recall`; searches memory and returns full verbatim results |

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

## Memory Subsystem

The durable memory subsystem adds cross-session persistence backed by Vultr's managed vector store API (`https://api.vultrinference.com/v1`).

### Client Lifecycle

```text
configureMemory(ctx, agent)
  │
  ├─ isMemoryDisabled() → return if MEMORY_ENABLED is falsy
  ├─ memoryCollectionName() → MEMORY_COLLECTION_NAME or "agent-memory"
  ├─ NewMemoryClient(agent.baseURL, apiKey, httpClient)
  ├─ client.EnsureCollection(ctx, name)
  │     GET /vector_store → find by name
  │     POST /vector_store if missing → cache returned ID
  ├─ agent.memoryClient = client
  └─ agent.tools = agent.buildTools(nil)  // adds "record" and "recall" tools
```

Failures at any step are logged to stderr and the agent starts without memory.

### Auto-Recall Flow

On every call to `withSystemPrompt` (which wraps every inference request):

```text
withSystemPrompt(ctx, conversation, tools, mode)
  │
  ├─ Build base prompt from PromptBuilder
  ├─ Extract last user message from conversation
  ├─ recallMemories(ctx, query)
  │     → MemoryClient.Search(ctx, query)
  │     → POST /vector_store/{id}/search {"input": query}
  │     → cap results to 10
  │     → summarizeMemories(ctx, items)
  │     │     → direct POST /chat/completions (Summarization model)
  │     │     → bypasses runInferenceWithModel to avoid recursion
  │     │     → on failure: fall back to truncation (80 chars per item)
  │     → format summary as [Memory] section with recall tool hint
  └─ Append [Memory] section to prompt (omitted on error or empty results)
```

### Discord Sharing

In Discord mode, a single `MemoryClient` is created once before the session manager factory. Each new session agent receives a reference to the same client, avoiding repeated `EnsureCollection` round-trips within the process lifetime.

### Kill Switch

Set `MEMORY_ENABLED=false` (or `0` / `no`) to disable the subsystem entirely:

1. `configureMemory` returns immediately without creating a client
2. `agent.memoryClient` remains nil
3. `record` and `recall` tools are not registered
4. Auto-recall injects no `[Memory]` section

## Design Constraints

1. Single-process runtime; CLI chat loop is single-threaded while auxiliary goroutines handle status rendering and Discord event handlers
2. No conversation persistence outside process memory
3. No workspace sandboxing; tools operate on provided paths
4. Tool and inference schemas are static per process start
5. Primary model is fixed to `kimi-k2-instruct`; reasoning model is fixed to `gpt-oss-120b`; summarization model is fixed to `gpt-oss-120b`

In Discord mode, each `(channel_id, user_id)` conversation key is isolated with a dedicated in-memory agent/session state and mutex.
Discord uses progressive part callbacks to emit multiple messages within one logical turn as assistant/tool iterations produce text.
Message splitting honors optional model-inserted `<<MSG_SPLIT>>` markers first, then falls back to balanced boundary-aware chunking under Discord size limits.

## Extension Points

1. Add tools by appending new `ToolDefinition` entries during startup
2. Add transport concerns (timeouts/retries) by configuring `http.Client`
3. Split monolithic `main.go` into packages once responsibilities grow
