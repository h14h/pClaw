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

At startup, `Agent` registers four built-ins:

1. `read_file`
2. `list_files`
3. `edit_file`
4. `delegate_reasoning`

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

## Schema Generation

`GenerateSchema[T]` uses `github.com/invopop/jsonschema` with:

1. `AllowAdditionalProperties: false`
2. `DoNotReference: true`

If reflection or conversion fails, it falls back to a minimal `{ "type": "object" }` schema.

## Current Gaps

1. No path boundary checks (tools can access files outside workspace)
2. No file size limits for reads
3. `edit_file` performs global replace without match-count enforcement
4. No per-tool timeout or cancellation boundary for filesystem tools
