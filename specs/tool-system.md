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

## Registration and Dispatch

### Registration

At startup, `main()` registers three built-ins:

1. `read_file`
2. `list_files`
3. `edit_file`

These are stored in `Agent.tools`.

### Dispatch Flow

```text
Model returns tool call
        │
        ▼
Agent.executeTool(call)
        │
        ├─ find tool by name
        ├─ parse JSON args (or "{}" when empty)
        ├─ execute Go function
        └─ return role="tool" message
```

If the tool name is unknown, the returned tool message content is `tool not found`.

## Built-in Tools

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
4. No per-tool timeout or cancellation boundary
