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
| `TestNewAgentDefaults` | Confirms fixed default models and reasoning tool registration |
| `TestRunInferenceUsesPrimaryModel` | Verifies primary inference uses provider-compatible `kimi-k2-instruct` |
| `TestDelegateReasoningUsesReasoningModel` | Verifies delegated call uses `gpt-oss-120b` with no tools |
| `TestDelegateReasoningLimit` | Enforces per-turn delegation limit |

## Integration Tests (E2E)

Integration tests require `VULTR_API_KEY` and call real API endpoints.

| Test | Focus |
|------|-------|
| `TestRunInference_E2E_TextResponse` | Basic text completion path |
| `TestRunInference_E2E_ToolCall` | Model emits tool call, tool executes, model continues |
| `TestAgentRun_E2E_ReadFileTool` | Full agent loop invokes `read_file` |
| `TestAgentRun_E2E_ListFilesTool` | Full agent loop invokes `list_files` |
| `TestAgentRun_E2E_EditFileTool` | Full agent loop invokes `edit_file` and writes expected output |
| `TestDelegateReasoning_E2E` | Live delegated reasoning call to `gpt-oss-120b` |
| `TestDelegationPolicyHarness_E2E` | Prompt-suite harness that checks delegation-rate thresholds for opinion vs simple prompts |

## How to Run

Run unit tests:

```bash
go test ./...
```

Run only integration tests:

```bash
VULTR_API_KEY="..." go test -run E2E ./...
```

Run delegation harness (opt-in, live API):

```bash
VULTR_API_KEY="..." \
RUN_DELEGATION_HARNESS=1 \
go test -run TestDelegationPolicyHarness_E2E ./...
```

Optional harness tuning env vars:

1. `DELEGATION_HARNESS_RUNS` (default `2`)
2. `DELEGATION_HARNESS_MIN_OPINION_RATE` (default `0.80`)
3. `DELEGATION_HARNESS_MIN_OPINION_PROMPT_RATE` (default `0.50`)
4. `DELEGATION_HARNESS_MAX_SIMPLE_RATE` (default `0.20`)

## Current Coverage Shape

Well covered:

1. Core tool happy-path and basic invalid input behavior
2. Basic agent tool dispatch behavior
3. Real API compatibility for text + tool-call flows
4. Model routing and delegated reasoning guardrails

Not yet covered:

1. Error-path assertions in `runInference()` (non-2xx, bad JSON, empty choices)
2. Deterministic tests around output printing / user prompt loop formatting
3. Edge cases for large files and path traversal
4. Cancellation/timeout behavior in `Agent.Run()` and inference HTTP calls
