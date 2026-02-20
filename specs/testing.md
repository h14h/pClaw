# Testing Strategy

## Overview

The test suite has two layers:

1. Unit tests (`main_test.go`) for tool behavior and dispatch logic
2. Live integration tests (`main_integration_test.go`) for real Vultr inference flow

## Unit Tests

| Test | Focus |
|------|-------|
| `TestReadFile` | Reads existing file content correctly |
| `TestListFiles` | Lists files/dirs non-recursively; marks dirs with trailing slash |
| `TestEditFileReplace` | Replaces text and persists updated content |
| `TestEditFileCreate` | Creates missing file when `old_str` is empty |
| `TestEditFileInvalidInput` | Rejects empty path and identical old/new strings |
| `TestExecuteToolNotFound` | Returns tool role with `tool not found` content |
| `TestExecuteToolArgs` | Passes JSON tool args and returns tool output |

## Integration Tests (E2E)

Integration tests require `VULTR_API_KEY` and call real API endpoints.

| Test | Focus |
|------|-------|
| `TestRunInference_E2E_TextResponse` | Basic text completion path |
| `TestRunInference_E2E_ToolCall` | Model emits tool call, tool executes, model continues |
| `TestAgentRun_E2E_ReadFileTool` | Full agent loop invokes `read_file` |
| `TestAgentRun_E2E_ListFilesTool` | Full agent loop invokes `list_files` |
| `TestAgentRun_E2E_EditFileTool` | Full agent loop invokes `edit_file` and writes expected output |

## How to Run

Run unit tests:

```bash
go test ./...
```

Run only integration tests:

```bash
VULTR_API_KEY="..." go test -run E2E ./...
```

## Current Coverage Shape

Well covered:

1. Core tool happy-path and basic invalid input behavior
2. Basic agent tool dispatch behavior
3. Real API compatibility for text + tool-call flows

Not yet covered:

1. Error-path assertions in `runInference()` (non-2xx, bad JSON, empty choices)
2. Deterministic tests around output printing / user prompt loop formatting
3. Edge cases for large files and path traversal
4. Cancellation/timeout behavior in `Agent.Run()` and inference HTTP calls
