# Durable Memory MVP — Vultr Vector Store

The agent has zero persistence. Conversations vanish on restart. This plan adds durable semantic memory backed by Vultr's managed vector store API — same provider, same API key, zero new infrastructure. One shared collection, no metadata filtering, auto-recall on every turn, trust semantic similarity.

Replaces the previous Qdrant-based plan entirely.

## API Surface

All endpoints use the same `api.vultrinference.com` host and `Authorization: Bearer <VULTR_API_KEY>` header.

| Operation | Method | Path |
|-----------|--------|------|
| List collections | GET | `/vector_store` |
| Create collection | POST | `/vector_store` |
| Add item | POST | `/vector_store/{id}/items` |
| Search | POST | `/vector_store/{id}/search` |
| Delete item | DELETE | `/vector_store/{id}/items/{itemid}` |
| List items | GET | `/vector_store/{id}/items` |

---

## Phase 1: Memory Client

New file: `memory.go`

- [x] Define `MemoryClient` struct with `baseURL`, `apiKey`, `httpClient`, and `collectionID` fields
- [x] Implement `NewMemoryClient(baseURL, apiKey string, httpClient *http.Client) *MemoryClient`
- [x] Implement `EnsureCollection(ctx, name)` — GET `/vector_store`, find by name, POST to create if missing, cache ID
- [x] Implement `AddItem(ctx, content string)` — POST `/vector_store/{id}/items` with `{"content": content}`
- [x] Implement `Search(ctx, query string) ([]string, error)` — POST `/vector_store/{id}/search` with `{"input": query}`, return content strings
- [x] Implement `ListItems(ctx)` and `DeleteItem(ctx, itemID)` for diagnostics and future use
- [x] Verify the correct vector store base URL path (may differ from the `/v1` inference prefix) — confirmed: vector store uses `https://api.vultrinference.com` (no `/v1`); added `defaultMemoryBaseURL` constant to `main.go`

All methods follow the existing HTTP pattern: `NewRequestWithContext`, Bearer auth header, JSON marshal/unmarshal, status code check.

## Phase 2: `remember` Tool

Same file: `memory.go`

- [x] Define `RememberInput` struct with `Content string` field and generate its JSON schema via `GenerateSchema[RememberInput]()`
- [x] Implement `Agent.rememberToolDefinition()` returning a `ToolDefinition` (same pattern as `Agent.reasoningToolDefinition()`)
- [x] Implement `Agent.rememberFunction(input json.RawMessage) (string, error)` — unmarshal input, call `memoryClient.AddItem`, return confirmation string
- [x] Register `remember` in `buildTools()`, gated on `a.memoryClient != nil`

## Phase 3: Auto-Recall

`memory.go` for the recall helper, `main.go` for the injection point.

- [x] Implement `Agent.recallMemories(ctx, query string) string` — call `memoryClient.Search`, format results as a `[Memory]` section, return empty string on error or no results
- [x] Modify `withSystemPrompt()` (`main.go:692`) to accept `ctx` and extract the last user message from the conversation as the recall query
- [x] Append recalled memories to the system prompt string before calling `prependSystemPrompt`
- [x] Update all callers of `withSystemPrompt` to pass `ctx` (affects `runInferenceWithModel` and `runInferenceStreamWithModel`)

Both CLI (`Run`) and Discord (`HandleUserMessageProgressive`) get auto-recall for free since they flow through `runInference*` → `withSystemPrompt`.

## Phase 4: Agent Wiring and Configuration

`main.go` and `discord.go`.

- [x] Add `memoryClient *MemoryClient` field to `Agent` struct (`main.go:59`)
- [x] Add `MEMORY_COLLECTION_NAME` env var (default: `"agent-memory"`)
- [x] Add `MEMORY_ENABLED` env var (default: `"true"`)
- [x] Implement `configureMemory(ctx, agent)` — read env, create `MemoryClient`, call `EnsureCollection`, set `agent.memoryClient`; log warning and leave nil on failure
- [x] Call `configureMemory` in `main()` after `NewAgent` (`main.go:477`)
- [x] Call `configureMemory` in `runDiscordBot()` agent factory (`discord.go:80`); create the `MemoryClient` once outside the factory and share it across session agents
- [x] Rebuild tools after memory configuration so `remember` is included when memory is active

## Phase 5: Tests

New file: `memory_test.go`

- [x] `TestEnsureCollection_CreatesWhenMissing` — mock server returns empty list, verify POST to create
- [x] `TestEnsureCollection_FindsExisting` — mock server returns list with matching name, verify no POST
- [x] `TestAddItem_Success` — verify POST body and path
- [x] `TestSearch_ReturnsResults` — mock server returns results, verify content extraction
- [x] `TestSearch_EmptyResults` — mock server returns empty results, verify empty slice
- [x] `TestRememberTool_StoresContent` — call tool function, verify it hits AddItem
- [x] `TestAutoRecall_InjectsMemories` — verify system prompt contains `[Memory]` section when memories exist
- [x] `TestAutoRecall_GracefulOnError` — memory client errors, verify no crash and no memory section in prompt
- [x] `TestBuildTools_IncludesRememberWhenMemoryEnabled` — agent with memoryClient, verify `remember` in tool list
- [x] `TestBuildTools_ExcludesRememberWhenMemoryDisabled` — agent without memoryClient, verify `remember` absent
- [x] `TestMemoryRoundTrip_Integration` (opt-in, live API) — create collection, add item, search, verify match, delete collection; also added `DeleteCollection` method to `MemoryClient` to support cleanup; gated on `MEMORY_INTEGRATION_TEST=true` (in addition to `VULTR_API_KEY`) to avoid accidentally running against the live API during normal test runs

## Phase 6: Spec Updates

- [x] Add memory subsystem to `specs/architecture.md` — client lifecycle, auto-recall flow, collection bootstrap
- [x] Add `remember` tool to `specs/tool-system.md` — input schema, behavior, when the LLM should use it
- [x] Add `MEMORY_COLLECTION_NAME` and `MEMORY_ENABLED` to `specs/configuration.md`

---

## Verification

1. **Unit tests**: `go test ./... -run "TestMemory|TestRemember|TestAutoRecall|TestBuildTools"`
2. **Integration test**: `VULTR_API_KEY=<key> MEMORY_INTEGRATION_TEST=true go test ./... -run Integration`
3. **Manual CLI**: start agent → tell it a fact → restart → ask about it → confirm recall
4. **Manual Discord**: same flow via `/agent` command, confirm memory persists across sessions
5. **Kill switch**: `MEMORY_ENABLED=false` → agent starts with no `remember` tool and no recall injection
