# Tool System

## Overview

The tool system lets the model invoke local filesystem actions through structured function calls.
Each tool is registered as a `ToolDefinition` with:

1. Name
2. Natural-language description
3. JSON Schema input contract
4. Execution function

## Core Types

| Type | Location | Purpose |
|------|----------|---------|
| `ToolDefinition` | `main.go` | Runtime tool registry entry and execution callback |
| `ChatTool` | `main.go` | Tool definition shape sent to Vultr API |
| `ChatToolCall` | `main.go` | Tool invocation emitted by model |
| `GenerateSchema[T]` | `main.go` | Generates JSON schema from Go structs |
| `ToolEvent` | `main.go` | Runtime event payload for tool lifecycle updates |
| `ToolEventSink` | `main.go` | Consumer interface for tool lifecycle events |

## Registration and Dispatch

### Registration

At startup, `Agent` registers up to seven built-ins:

1. `read_file`
2. `list_files`
3. `edit_file`
4. `delegate_reasoning`
5. `record` (only when `Agent.memoryClient != nil`)
6. `recall` (only when `Agent.memoryClient != nil`)
7. `web_search` (only when `Agent.webSearchClient != nil`)

These are stored in `Agent.tools`.

### Dispatch Flow

```text
Model returns tool call
        │
        ▼
Agent.executeTool(call)
        │
        ├─ emit tool_call.started event
        ├─ find tool by name
        ├─ parse JSON args (or "{}" when empty)
        ├─ execute Go function
        ├─ emit tool_call.succeeded or tool_call.failed event
        └─ return role="tool" message
```

If the tool name is unknown, the returned tool message content is `tool not found`.

### Tool Event Stream

`executeTool` emits a normalized event stream around each call:

1. `tool_call.started`
2. `tool_call.succeeded`
3. `tool_call.failed`

Tool events are emitted regardless of presentation mode.
CLI rendering is controlled by `TOOL_EVENT_LOG`:

1. `off` (default): no tool-event lines are printed
2. `debug`: `CLIToolEventSink` prints structured `tool_event ...` lines to stderr

This event layer decouples execution from presentation and is intended to support future streaming outputs.

CLI wait-state behavior during tool execution:

1. Non-`delegate_reasoning` tool calls show a delayed single-line status indicator (`running <tool_name>...`) while execution is in progress
2. Indicator delay is `200ms` to avoid flicker for short operations while improving responsiveness
3. Indicator is ephemeral and cleared before final `tool_call.succeeded` / `tool_call.failed` output
4. `delegate_reasoning` uses its dedicated reasoning indicator instead of the generic tool-running indicator

## Built-in Tools

## `delegate_reasoning`

Delegates deeper reasoning to `gpt-oss-120b`.

Input:

```json
{
  "question": "sub-problem to reason about",
  "context": "optional supporting context"
}
```

Behavior:

1. Enforces per-user-turn call limit (2)
2. Calls Vultr chat completions with model `gpt-oss-120b`
3. Sends no filesystem tools to the delegated model
4. Returns concise delegated output from `content` or fallback `reasoning`

Error conditions:

1. Missing/empty `question`
2. Delegation limit reached
3. Timeout/API errors from delegated inference call

## `read_file`

Reads entire file contents for a provided path.

Input:

```json
{
  "path": "relative/or/absolute/path"
}
```

Behavior:

1. JSON-decodes `path`
2. Calls `os.ReadFile`
3. Returns file content as string

Errors are returned directly (decode errors, path errors, permission errors).

## `list_files`

Lists a directory non-recursively.

Input:

```json
{
  "path": "optional-directory"
}
```

Behavior:

1. Defaults to `"."` when `path` is empty
2. Calls `os.ReadDir`
3. Emits JSON array of names
4. Appends `/` suffix to directory names

## `edit_file`

Applies string replacement or creates a new file.

Input:

```json
{
  "path": "file-path",
  "old_str": "text to replace",
  "new_str": "replacement text"
}
```

Behavior:

1. Rejects invalid input when `path == ""` or `old_str == new_str`
2. If file exists: replaces all matches of `old_str` with `new_str`
3. If file does not exist and `old_str == ""`: creates file (and parent dirs)
4. Returns `"OK"` for edits, success message for create path

Error conditions:

1. `old_str not found in file` when no replacement occurs and `old_str != ""`
2. Read/write filesystem errors
3. Directory creation errors during file creation path

## `record`

Stores an entity-associated fact in the long-term semantic memory collection via the Vultr vector store API.
Only registered when `Agent.memoryClient` is non-nil (i.e., when memory is enabled and the collection has been bootstrapped).

Input:

```json
{
  "subject": "@henry",
  "subject_type": "discord user",
  "descriptor": "is a Cubs fan"
}
```

Behavior:

1. Unmarshals the `subject`, `subject_type`, and `descriptor` fields
2. Rejects empty or whitespace-only values for any of the three fields with an error
3. Concatenates via `formatMemoryContent`: `"<subject_type> <subject> <descriptor>"` (e.g., `"discord user @henry is a Cubs fan"`)
4. Calls `MemoryClient.AddItem(ctx, content)` using `context.Background()`
5. Returns `"Memory stored."` on success

Error conditions:

1. Missing or whitespace-only `subject`, `subject_type`, or `descriptor`
2. Collection not initialized (EnsureCollection not called)
3. HTTP errors from the vector store API

## `recall`

Searches long-term semantic memory and returns full verbatim results.
Memories are stored as entity-associated facts in the form `<type> <name> <verb-phrase>` (e.g., `discord user @henry is a Cubs fan`). For best results, include the entity type and/or name in the query.
Only registered when `Agent.memoryClient` is non-nil (i.e., when memory is enabled and the collection has been bootstrapped).

Input:

```json
{
  "query": "targeted search query to find specific memories"
}
```

Behavior:

1. Unmarshals the `query` field
2. Rejects empty or whitespace-only query with an error
3. Calls `MemoryClient.Search(ctx, query)` using `context.Background()`
4. Returns full verbatim results separated by `\n\n---\n\n`, each annotated with a human-readable storage age suffix when a timestamp is available (e.g. `discord user @henry is a Cubs fan (stored 3 weeks ago)`)
5. Returns `"No matching memories found."` when no results match

Error conditions:

1. Missing or whitespace-only `query`
2. Collection not initialized (EnsureCollection not called)
3. HTTP errors from the vector store API

## `web_search`

Searches the web for current, factual information via the Tavily Search API.
Only registered when `Agent.webSearchClient` is non-nil (i.e., when `TAVILY_API_KEY` is set).

Input:

```json
{
  "query": "search query for web grounding",
  "topic": "general",
  "search_depth": "basic"
}
```

Behavior:

1. Unmarshals `query`, optional `topic`, and optional `search_depth` fields
2. Rejects empty or whitespace-only `query` with an error
3. Calls `WebSearchClient.Search(ctx, query, topic, searchDepth)` using `context.Background()`
4. Request is `POST /search` to Tavily API with `include_answer=true`
5. Returns formatted result with answer summary and numbered sources (title, URL, content snippet)
6. Returns `"No results found."` when no results or answer are available

Optional parameters:

- `topic`: `"general"` (default), `"news"`, or `"finance"`
- `search_depth`: `"basic"` (default, 1 credit) or `"advanced"` (2 credits, higher quality)

Error conditions:

1. Missing or whitespace-only `query`
2. HTTP errors from the Tavily API (401, 429, etc.)
3. Response parse failures

## Async Tools

Some tools are write-only side effects whose results the model never meaningfully branches on. These tools can be marked as fire-and-forget to avoid blocking the inference loop.

### `Async` Field

`ToolDefinition` has an `Async bool` field (not serialized to JSON — internal only). When `Async` is true:

1. The tool loop launches `executeTool` in a background goroutine
2. A synthetic `role="tool"` message with content `"Accepted."` is immediately appended to conversation state
3. The model continues without waiting for the actual tool execution to complete
4. Tool events (`tool_call.started`, `tool_call.succeeded`, `tool_call.failed`) are still emitted from the background goroutine
5. Errors in async tools are non-fatal — they are emitted via `ToolEventFailed` but do not affect the conversation

### Drain on Shutdown

`Agent.asyncWg` (a `sync.WaitGroup`) tracks in-flight async tool calls. `Agent.WaitForAsync()` blocks until all background work completes. This is called after `Agent.Run()` returns in `main()` to ensure async tools finish before process exit.

### Async-Enabled Tools

| Tool | Rationale |
|------|-----------|
| `record` | Write-only memory storage; model never branches on the result |

## Schema Generation

`GenerateSchema[T]` uses `github.com/invopop/jsonschema` with:

1. `AllowAdditionalProperties: false`
2. `DoNotReference: true`

If reflection or conversion fails, it falls back to a minimal `{ "type": "object" }` schema.

## Auto-Recall

When `Agent.memoryClient` is non-nil, every call to `withSystemPrompt` automatically performs a semantic search against the memory store and injects an LLM-generated summary of matching memories into the system prompt.


### Behavior

1. The last user message in the conversation is extracted as the recall query.
2. `Agent.recallMemories(ctx, query)` calls `MemoryClient.Search(ctx, query)`.
3. Search results are capped to 10 items and fed to `Agent.summarizeMemories(ctx, items)`.
4. `summarizeMemories` makes a direct HTTP POST to `/chat/completions` using the `Summarization` model (`gpt-oss-120b`), bypassing `runInferenceWithModel`/`withSystemPrompt` to avoid infinite recursion. Timeout is 15 seconds, max tokens is 256.
5. The summary is formatted as a `[Memory]` section appended to the base system prompt, with a hint to use the `recall` tool for full details.
6. On summarization failure, the system falls back to programmatic truncation (each item truncated to 80 characters).
7. On search error or empty results the section is omitted; no crash or propagated error occurs.

### Format

```
[Memory]
- summarized fact one
- summarized fact two
Use the recall tool with a targeted query to retrieve full details.
```

This section appears after the standard prompt sections (`[Identity]`, `[Behavior]`, `[Tooling]`, `[Safety]`, `[Runtime]`) so that recalled context is available to the model on every turn.

## Current Gaps

1. No path boundary checks (tools can access files outside workspace)
2. No file size limits for reads
3. `edit_file` performs global replace without match-count enforcement
4. No per-tool timeout or cancellation boundary for filesystem tools
