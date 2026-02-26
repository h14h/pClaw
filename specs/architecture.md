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
├── websearch.go               # WebSearchClient, web_search tool, configureWebSearch
├── prompting.go               # System prompt builder (SectionedPromptBuilder)
├── compaction.go              # ConversationState, rolling summarization, compaction logic
├── main_test.go               # Unit tests for tools + dispatch
├── memory_test.go             # Unit tests for MemoryClient, record tool, and auto-recall
├── websearch_test.go          # Unit tests for WebSearchClient, web_search tool, and configureWebSearch
├── compaction_test.go         # Unit tests for compaction types, helpers, and HTTP logic
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
| `asyncWg` | `main.go` | `sync.WaitGroup` tracking in-flight async (fire-and-forget) tool calls |
| `WaitForAsync` | `main.go` | Drains `asyncWg`; called after `Run()` returns to ensure background tools complete before exit |
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
| `WebSearchClient` | `websearch.go` | HTTP client for Tavily Search API; handles search requests and response parsing |
| `configureWebSearch` | `websearch.go` | Reads `TAVILY_API_KEY`/`WEB_SEARCH_MAX_RESULTS`, creates `WebSearchClient`, sets `agent.webSearchClient` |
| `webSearchFunction` | `websearch.go` | Tool handler for `web_search`; performs Tavily search and formats results with sources |
| `ConversationState` | `compaction.go` | Tracks `[]ChatMessage`, rolling `Summary`, and cumulative `SizeBytes`; replaces raw slices throughout the agent loop |
| `compactConversation` | `compaction.go` | Checks threshold, finds safe split, summarizes prefix, truncates history; non-fatal on error |
| `summarizeConversation` | `compaction.go` | Direct HTTP POST to chat completions for conversation prefix summarization (bypasses `runInferenceWithModel`) |

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

Tools marked with `Async: true` are dispatched in a background goroutine via `asyncWg`. The tool loop appends a synthetic `"Accepted."` result immediately and continues inference without waiting. See `specs/tool-system.md` § Async Tools for details.

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

On `withSystemPrompt` calls in `full` mode (primary inference). Minimal mode (delegated reasoning) skips recall entirely since it operates on a standalone sub-prompt without memory context.

```text
withSystemPrompt(ctx, conversation, tools, mode)
  │
  ├─ Build base prompt from PromptBuilder
  ├─ (mode == full only):
  │   ├─ Extract last user message from conversation
  │   ├─ Check recallTurnCache → hit: use cached [Memory] section
  │   ├─ recallMemories(ctx, query)   (on cache miss)
  │   │     → MemoryClient.Search(ctx, query)
  │   │     → POST /vector_store/{id}/search {"input": query}
  │   │     → cap results to 10
  │   │     → summarizeMemories(ctx, items)
  │   │     │     → direct POST /chat/completions (Summarization model)
  │   │     │     → bypasses runInferenceWithModel to avoid recursion
  │   │     │     → on failure: fall back to truncation (80 chars per item)
  │   │     → format summary as [Memory] section with recall tool hint
  │   │     → store result in recallTurnCache
  │   └─ Append [Memory] section to prompt (omitted on error or empty results)
  └─ (mode == minimal): no recall
```

### Per-Turn Recall Cache

`recallTurnCache` (type `recallCache`) avoids redundant vector-store searches and summarization LLM calls during multi-step tool loops within a single user turn. The cache is:

1. **Invalidated** at the start of each user turn (`Agent.Run()` and `HandleUserMessageProgressive`)
2. **Invalidated** after a successful `record` tool call (so the next inference re-fetches including the new memory)
3. **Keyed by query** — a cache hit requires the same query string (the last user message)

### Discord Sharing

In Discord mode, a single `MemoryClient` is created once before the session manager factory. Each new session agent receives a reference to the same client, avoiding repeated `EnsureCollection` round-trips within the process lifetime.

### Kill Switch

Set `MEMORY_ENABLED=false` (or `0` / `no`) to disable the subsystem entirely:

1. `configureMemory` returns immediately without creating a client
2. `agent.memoryClient` remains nil
3. `record` and `recall` tools are not registered
4. Auto-recall injects no `[Memory]` section

## Web Search Subsystem

The web search subsystem provides web grounding via the Tavily Search API, enabling the agent to verify factual claims and retrieve current information.

### Client Lifecycle

```text
configureWebSearch(agent)
  │
  ├─ TAVILY_API_KEY empty → return (no web search)
  ├─ webSearchMaxResults() → WEB_SEARCH_MAX_RESULTS or 5
  ├─ NewWebSearchClient(defaultTavilyBaseURL, apiKey, httpClient, maxResults)
  ├─ agent.webSearchClient = client
  └─ agent.tools = agent.buildTools(nil)  // adds "web_search" tool
```

No collection bootstrapping or initialization round-trips are needed (unlike memory). The client is stateless.

### Prompt Grounding Rules

When `web_search` is in the tool list, `SectionedPromptBuilder.Build` dynamically appends grounding rules to the **Safety** section:

- Use `web_search` to verify factual claims before stating them
- Never present unverified information as fact

These rules are omitted when `web_search` is not available.

### Discord Sharing

In Discord mode, `configureWebSearch` is called for each session agent in the factory. Since the client is stateless (no collection bootstrap), there is no need for a shared instance.

### Kill Switch

When `TAVILY_API_KEY` is unset or empty:

1. `configureWebSearch` returns immediately without creating a client
2. `agent.webSearchClient` remains nil
3. `web_search` tool is not registered
4. Grounding prompt rules are not injected

## Compaction Subsystem

The compaction subsystem prevents unbounded growth of the in-memory conversation history by rolling-summarizing older messages when the history exceeds a size threshold.

### Types and Constants (`compaction.go`)

| Symbol | Value | Purpose |
|--------|-------|---------|
| `compactionSizeThreshold` | 12000 bytes | Trigger compaction when `SizeBytes` exceeds this |
| `compactionKeepMessages` | 10 | Number of recent messages to retain after compaction |
| `compactionTimeout` | 20s | HTTP timeout for summarization calls |
| `compactionMaxTokens` | 512 | Token budget for the summarization model |

`ConversationState` replaces the raw `[]ChatMessage` slice throughout the codebase:

```go
type ConversationState struct {
    Messages  []ChatMessage
    Summary   string   // Rolling summary of compacted history
    SizeBytes int      // Cumulative byte count of message text content
}
```

### Turn-Boundary Safety

`findCompactionSplitIndex` ensures tool call/tool result pairs are never orphaned by the split. Starting from `len(messages) - keepCount`, it walks backward until it finds a `user`-role message boundary. If no safe split exists (e.g., the whole conversation fits within `keepCount`), it returns 0 and compaction is skipped.

### Compaction Flow

```text
compactConversation(ctx, cs)
  │
  ├─ NeedsCompaction? (SizeBytes > threshold) → no: return
  ├─ findCompactionSplitIndex → 0: return (no safe split)
  ├─ serializeMessagesForSummary(cs.Messages[:splitIdx])
  ├─ summarizeConversation(ctx, cs.Summary, serialized)
  │     → direct POST /chat/completions (bypasses runInference to avoid recursion)
  │     → on HTTP error: emitServerEvent WARN + return nil (non-fatal)
  ├─ cs.Messages = cs.Messages[splitIdx:]
  ├─ cs.Summary = newSummary
  ├─ cs.SizeBytes = recalculated from kept messages
  └─ emitServerEvent compaction.completed with stats
```

### Summary Injection

Before each inference call, callers set the summary in context:

```go
inferCtx := withConversationSummary(ctx, cs.Summary)
runInference(inferCtx, cs.Messages)
```

`withSystemPrompt` reads the summary from context via `conversationSummaryFromContext(ctx)` and appends it as a `[Conversation Summary]` section after `[Memory]`.

### Integration Points

| Location | Change |
|----------|--------|
| `Agent.Run()` | Uses `ConversationState`; calls `compactConversation` after each user-turn completes |
| `HandleUserMessageProgressive` | Accepts/returns `*ConversationState`; passes `inferCtx` with summary; calls `compactConversation` after tool loop |
| `HandleUserMessage` | Wrapper — same signature change as `HandleUserMessageProgressive` |
| `discordSessionState` | `cs *ConversationState` replaces `conversation []ChatMessage` |

### Non-Fatal Failure

Compaction failure (e.g., network error during summarization) emits a `compaction.failed` warning event and returns `nil`. The full conversation history is retained and the agent continues normally.

## Design Constraints

1. Single-process runtime; CLI chat loop is single-threaded while auxiliary goroutines handle status rendering and Discord event handlers
2. No conversation persistence outside process memory
3. No workspace sandboxing; tools operate on provided paths
4. Tool and inference schemas are static per process start
5. Primary model is fixed to `kimi-k2-instruct`; reasoning model is fixed to `gpt-oss-120b`; summarization model is fixed to `qwen2.5-coder-32b-instruct`

In Discord mode, each `(channel_id, user_id)` conversation key is isolated with a dedicated in-memory agent/session state and mutex.
Discord uses progressive part callbacks to emit multiple messages within one logical turn as assistant/tool iterations produce text.
Message splitting honors optional model-inserted `<<MSG_SPLIT>>` markers first, then falls back to balanced boundary-aware chunking under Discord size limits.

## Extension Points

1. Add tools by appending new `ToolDefinition` entries during startup
2. Add transport concerns (timeouts/retries) by configuring `http.Client`
3. Split monolithic `main.go` into packages once responsibilities grow
