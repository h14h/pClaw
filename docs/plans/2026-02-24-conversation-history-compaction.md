# Conversation History Compaction

## Context

Conversation history (`[]ChatMessage`) grows unboundedly. This adds rolling summarization: when byte-size exceeds a threshold, older messages are LLM-summarized and the conversation is truncated to recent messages only. Agent context becomes: system prompt + `[Conversation Summary]` + recent messages.

Design: recent messages > summary; new content being summarized > prior summary. Degradation is acceptable.

## Specs

- `specs/architecture.md` — Agent struct, conversation flow, memory subsystem, `HandleUserMessageProgressive`
- `specs/tool-system.md` — Tool definitions, turn structure (assistant→tool_call→tool_result)
- `specs/llm-inference.md` — Inference request/response, `ChatCompletionRequest`/`ChatCompletionResponse`
- `specs/prompting.md` — System prompt composition, `formatSection`, `prependSystemPrompt`
- `specs/configuration.md` — Env vars, defaults
- `specs/testing.md` — Test patterns, httptest mocking

## Key references

- `summarizeMemories` (`memory.go:375-437`) — pattern to follow for direct HTTP POST summarization
- `streamContentToString` (`main.go:1123`) — extracts string from `interface{}` Content field
- `withSystemPrompt` (`main.go:696`) — where summary injection goes
- `Agent.Run` (`main.go:616-682`) — CLI conversation loop
- `HandleUserMessageProgressive` (`main.go:1334-1399`) — Discord/external conversation loop
- `discordSessionState` (`discord.go:24-28`) — per-session state struct
- `runDiscordPromptProgressive` (`discord.go:411-496`) — Discord caller of HandleUserMessageProgressive

---

## Phase 1: Core types and pure helpers

All items in new file `compaction.go`. No existing code changes. Each item can be done independently.

- [x] **1a.** `ConversationState` struct (`Messages []ChatMessage`, `Summary string`, `SizeBytes int`) + `NewConversationState()` constructor
- [x] **1b.** Constants: `compactionSizeThreshold = 12000`, `compactionKeepMessages = 10`, `compactionTimeout = 20s`, `compactionMaxTokens = 512`
- [x] **1c.** `messageContentSize(msg ChatMessage) int` — returns `len(streamContentToString(msg.Content))`
- [x] **1d.** `(*ConversationState).Append(msg ChatMessage)` — appends + adds size
- [x] **1e.** `(*ConversationState).NeedsCompaction() bool` — `SizeBytes > threshold`
- [x] **1f.** `findCompactionSplitIndex(messages []ChatMessage, keepCount int) int` — walks backward from `len-keepCount` to nearest `user`-role message to avoid orphaning tool_call/tool_result pairs. Returns 0 if no safe split exists.
- [x] **1g.** `serializeMessagesForSummary(messages []ChatMessage) string` — `"role: content\n"` format. Tool-call-only assistants show `"(called tools: name1, name2)"`. Empty tool results show `"(tool result)"`. Skips empty messages.
- [x] **1h.** Context helpers in `compaction.go`: `withConversationSummary(ctx, summary) context.Context` and `conversationSummaryFromContext(ctx) string` using a private key type

**Verify:** `go build ./...`

## Phase 2: Compaction logic

All in `compaction.go`. Depends on Phase 1. No existing code changes.

- [x] **2a.** `(*Agent).summarizeConversation(ctx, priorSummary, newContent string) (string, error)` — direct HTTP POST to `/chat/completions` (see `summarizeMemories` in `memory.go:375-437` for exact pattern). Uses `a.summarizationModel`, `compactionTimeout`, `compactionMaxTokens`. System prompt: capture decisions/facts/task state, merge prior+new preferring new, let stale details fade. When `priorSummary != ""`, user message is `"PRIOR SUMMARY:\n<prior>\n\nNEW CONVERSATION CONTENT:\n<new>"`.
- [x] **2b.** `(*Agent).compactConversation(ctx, cs *ConversationState) error` — orchestrator: check `NeedsCompaction`, find split index (return if 0), serialize prefix, call `summarizeConversation`, update state. On summarization failure: `emitServerEvent` warning + return nil (non-fatal). On success: emit `compaction.completed` event with stats.

**Verify:** `go build ./...`

## Phase 3: Summary injection

Modifies `main.go:withSystemPrompt`. Small, isolated change.

- [x] **3a.** In `withSystemPrompt` (`main.go:696`), after the `[Memory]` injection (line ~722), add: `if summary := conversationSummaryFromContext(ctx); summary != "" { prompt += "\n\n" + formatSection("Conversation Summary", summary) }`. Uses `formatSection` from `prompting.go:191`.

**Verify:** `go build ./...` + `go test ./...` (existing tests should still pass — no context value set means no summary injected)

## Phase 4: Integration

Modifies `main.go`, `discord.go`. Depends on Phases 1-3.

- [x] **4a.** `Agent.Run()` (`main.go:616-682`): replace `conversation := []ChatMessage{}` with `cs := NewConversationState()`. Replace appends with `cs.Append()`. Before inference: `inferCtx := withConversationSummary(ctx, cs.Summary)`, pass `inferCtx` + `cs.Messages`. After turn completes (`len(toolCalls)==0`): call `a.compactConversation(ctx, cs)`.
- [x] **4b.** `HandleUserMessageProgressive` (`main.go:1334`): change signature from `conversation []ChatMessage` → `cs *ConversationState`, return `*ConversationState` instead of `[]ChatMessage`. Internally: `cs.Append()`, `withConversationSummary(ctx, cs.Summary)` before `runInference`, `compactConversation` after tool loop. Update `HandleUserMessage` wrapper (`main.go:1330`) similarly.
- [x] **4c.** `discordSessionState` (`discord.go:24-28`): replace `conversation []ChatMessage` with `cs *ConversationState`.
- [x] **4d.** `runDiscordPromptProgressive` (`discord.go:411-496`): update all `state.conversation` → `state.cs` references. `len(state.cs.Messages)` for logging. Pass `state.cs` to `HandleUserMessageProgressive`.
- [x] **4e.** Session init (`discord.go:52`): `cs: NewConversationState()` in new session state.
- [x] **4f.** `runDiscordPrompt` (`discord.go:407-409`): update if signature changed.

**Verify:** `go build ./...`

## Phase 5: Tests

New file `compaction_test.go` + updates to `main_test.go`. See `specs/testing.md` for patterns. Use `httptest.NewServer` for mocking (see `memory_test.go:46-78` for examples).

- [x] **5a.** `TestMessageContentSize` — string, `[]interface{}`, nil
- [x] **5b.** `TestConversationStateAppend` — cumulative `SizeBytes` tracking
- [x] **5c.** `TestNeedsCompaction` — below/above/at threshold
- [x] **5d.** `TestFindCompactionSplitIndex` — simple split, turn-boundary adjustment (tool pairs), single-turn edge case, keepCount >= len
- [x] **5e.** `TestSerializeMessagesForSummary` — format, tool calls, tool results, empty skipping
- [x] **5f.** `TestSummarizeConversation_Success` — mock HTTP, verify request body structure, verify result
- [x] **5g.** `TestSummarizeConversation_WithPriorSummary` — user message contains `PRIOR SUMMARY:` and `NEW CONVERSATION CONTENT:`
- [x] **5h.** `TestSummarizeConversation_Error` — HTTP 500 returns error
- [x] **5i.** `TestCompactConversation_Performs` — above threshold: summary updated, messages truncated, size recalculated
- [x] **5j.** `TestCompactConversation_BelowThreshold` — no-op
- [x] **5k.** `TestCompactConversation_FailureNonFatal` — HTTP error → returns nil, conversation unchanged
- [x] **5l.** `TestCompactConversation_TurnBoundary` — tool pairs not orphaned
- [x] **5m.** `TestConversationSummaryContext` — round-trip context value; verify `withSystemPrompt` includes `[Conversation Summary]`
- [x] **5n.** Update `TestHandleUserMessage_ToolLoopAndFinalText` (`main_test.go:692`) — `[]ChatMessage` → `NewConversationState()`
- [x] **5o.** Update `TestHandleUserMessageProgressive_EmitsPartsInOrder` (`main_test.go:748`) — same

**Verify:** `go test ./...`

## Phase 6: Spec updates

- [x] **6a.** `specs/architecture.md` — add Compaction Subsystem section: ConversationState, trigger conditions, rolling summary, turn-boundary safety, non-fatal failure, summary injection
- [x] **6b.** `specs/prompting.md` — document `[Conversation Summary]` section and ordering (after `[Memory]`, before conversation messages)

**Verify:** Review specs for accuracy against implementation.

---

## Completion

When all phases are checked off, rename this file to `COMPLETED_PLAN.md`.
