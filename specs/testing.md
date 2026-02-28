# Testing Strategy

## Overview

The test suite has three layers:

1. Unit tests (`main_test.go`, `config_test.go`, `discord_test.go`, `memory_test.go`, `prompting_test.go`, `compaction_test.go`) for tool behavior, dispatch logic, config loading, Discord transport, memory subsystem, prompt builder, and conversation compaction
2. Live integration tests (`main_integration_test.go`) for real Vultr inference flow
3. Opt-in delegation policy harness (`main_delegation_harness_integration_test.go`) for delegation-rate behavior

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
| `TestExecuteToolEmitsStartedAndSucceededEvents` | Verifies lifecycle events are emitted for successful tool calls |
| `TestExecuteToolEmitsFailedEventForMissingTool` | Verifies failure event emission for unknown tools |
| `TestCLIToolEventSinkDebugOutput` | Verifies structured `tool_event` debug rendering |
| `TestParseToolEventLogMode` | Verifies `TOOL_EVENT_LOG` parsing/validation |
| `TestNewAgentDefaultsToNoToolEventSink` | Confirms default runtime has no tool event sink |
| `TestNewAgentDefaults` | Confirms fixed default models and reasoning tool registration |
| `TestRunInferenceUsesPrimaryModel` | Verifies primary inference uses provider-compatible `kimi-k2-instruct` |
| `TestRunInferenceStream_UsesStreamAndEmitsText` | Verifies streaming request path and text delta emission |
| `TestRunInferenceStream_ReconstructsToolCalls` | Verifies tool-call reconstruction from streaming deltas |
| `TestDelegateReasoningUsesReasoningModel` | Verifies delegated call uses `gpt-oss-120b` with no tools |
| `TestDelegateReasoningLimit` | Enforces per-turn delegation limit |
| `TestHandleUserMessage_ToolLoopAndFinalText` | Verifies transport-agnostic model/tool loop aggregation |
| `TestHandleUserMessageProgressive_EmitsPartsInOrder` | Verifies progressive callback emits assistant text parts in order across tool loop iterations |
| `TestProgressiveDiscordSender_UsesFirstThenNext` | Verifies first progressive Discord part uses first-send path and later parts use follow-up path |
| `TestProgressiveDiscordSender_SplitsLongPart` | Verifies progressive sender applies Discord-safe chunking per emitted part |
| `TestSplitForDiscord_HonorsSplitMarker` | Verifies explicit `<<MSG_SPLIT>>` marker boundaries are preferred when splitting |
| `TestSplitForDiscord_BalancedAvoidsTinyTrailingChunk` | Verifies fallback chunking produces roughly even Discord message sizes |
| `TestStartTypingHeartbeat_EmitsUntilStopped` | Verifies typing heartbeat keeps emitting until explicitly stopped |
| `TestMessageContentSize` | Verifies byte-size calculation for string, `[]interface{}`, and nil content |
| `TestConversationStateAppend` | Verifies cumulative `SizeBytes` tracking as messages are appended |
| `TestNeedsCompaction` | Verifies threshold check (strictly greater than) |
| `TestFindCompactionSplitIndex` | Verifies safe split location: keepCount boundary, user-role walk-back, no-safe-split cases |
| `TestSerializeMessagesForSummary` | Verifies text serialization: user/assistant, tool-call annotations, tool result placeholder, empty skipping |
| `TestSummarizeConversation_Success` | Mocks HTTP, verifies request body structure and returned summary |
| `TestSummarizeConversation_WithPriorSummary` | Verifies `PRIOR SUMMARY:` / `NEW CONVERSATION CONTENT:` merged user message |
| `TestSummarizeConversation_Error` | HTTP 500 returns error |
| `TestCompactConversation_Performs` | Above threshold: summary set, messages truncated, size recalculated |
| `TestCompactConversation_BelowThreshold` | No HTTP requests, state unchanged |
| `TestCompactConversation_FailureNonFatal` | HTTP error → returns nil, conversation unchanged |
| `TestCompactConversation_TurnBoundary` | Walk-back ensures kept messages start at a user boundary (no orphaned tool pairs) |
| `TestConversationSummaryContext` | Round-trip context value; `withSystemPrompt` includes `[Conversation Summary]` when set; omits when not set |
| `TestExpandTilde*` | Tilde expansion edge cases (prefix, absolute, relative, empty, bare `~`) |
| `TestLoadConfig_ActiveModelResolvesToProviderFields` | Named model's `model_id` populates all three role fields + thinking toggle |
| `TestLoadConfig_ActiveModelNotFound` | Error lists available model names |
| `TestLoadConfig_ActiveModelEmptyModelID` | Error on empty `model_id` |
| `TestLoadConfig_ActiveModelNoModelsMap` | Error when `active_model` set but no `[models]` defined |
| `TestLoadConfig_NoActiveModelPreservesExistingFields` | Backward compat: flat fields preserved when no `active_model` |
| `TestLoadConfig_PCLAWModelEnvOverride` | `PCLAW_MODEL` env var overrides config `active_model` |
| `TestLoadConfig_ActiveModelNoThinkingToggleKeepsProvider` | Model without toggle preserves provider-level toggle |
| `TestLoadConfig_RealWorldMultiProvider` | Multi-provider config (Vultr flat + local named models) resolves correctly for each combination |

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

## Manual Smoke Tests

Manual smoke tests verify end-to-end behavior against live inference backends. Run these after making changes to inference, tool dispatch, memory, or provider configuration.

### Prerequisites

Build the binary:

```bash
go build -o pclaw .
```

### Test Matrix

Run each check against each provider you want to verify. Switch providers with `PCLAW_PROVIDER` and models with `PCLAW_MODEL`:

```bash
# Vultr (default)
PCLAW_PROVIDER=vultr ./pclaw

# Local (default active_model from config)
PCLAW_PROVIDER=local ./pclaw

# Local with specific named model
PCLAW_PROVIDER=local PCLAW_MODEL=qwen35 ./pclaw
```

#### 1. Basic text response

Send a simple prompt and confirm the model responds coherently.

```
> What is 2+2?
```

**Pass**: model returns a text answer (not an error or empty response).

#### 2. Tool call (read_file)

Ask the model to read a known file.

```
> Read the file config.default.toml
```

**Pass**: model calls `read_file`, displays the file contents, and summarizes or acknowledges them.

#### 3. Delegate reasoning

Ask a question that triggers the `delegate_reasoning` tool.

```
> Think step by step: what are the prime factors of 360?
```

**Pass**: model delegates to the reasoning model and returns a correct answer. Look for the reasoning delegation status indicator or server event log output.

#### 4. Web search (when configured)

```
> Search the web for the current weather in San Francisco.
```

**Pass**: model calls `web_search` and returns results with source URLs.

### Gaps

- **Memory**: No standardized smoke test for record/recall yet. Needs a strategy for isolated test collections to avoid polluting production vector stores.
- **Discord**: No agent-oriented manual test procedure yet. Rely on human testing.

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
