# Implementation Plan: Agent Memory via Qdrant + `remember` / `recall`

This plan is organized as implementation tickets.  
Each ticket includes file targets.

## Phase 0: Feasibility and Architecture Decision


- [ ] **T0.1 - Validate Qdrant embedded feasibility in Go runtime**  
  Files: `docs/memory/feasibility.md` (new), `go.mod`  
  Notes: Verify whether true in-process embedded mode exists for `qdrant/go-client`; document findings and constraints.


- [ ] **T0.2 - Build spike for local Qdrant process bootstrap + Go client connectivity**  
  Files: `cmd/memory_spike/main.go` (new), `scripts/start-qdrant-local.sh` (new)  
  Notes: Start local Qdrant (Docker or binary), create collection, upsert/search a sample point.


- [ ] **T0.3 - ADR: choose final memory deployment mode**  
  Files: `docs/adr/0001-memory-backend.md` (new)  
  Notes: Decide true embedded (if feasible) vs local sidecar model; define operational tradeoffs.

## Phase 1: Core Interfaces and Domain Model


- [ ] **T1.1 - Define memory domain schema for People/Interests/Facts**  
  Files: `memory/types.go` (new), `specs/architecture.md`, `specs/tool-system.md`  
  Notes: Add shared metadata (`id`, `kind`, `importance`, `confidence`, timestamps, ttl, tags, source, scope) and kind-specific fields.


- [ ] **T1.2 - Add `MemoryStore` interface and service wiring**  
  Files: `memory/store.go` (new), `main.go`  
  Notes: Add `Remember`, `Recall`, `DeleteExpired`, `HealthCheck`.


- [ ] **T1.3 - Add `Embedder` abstraction**  
  Files: `memory/embedder.go` (new)  
  Notes: Define provider-agnostic embedding API with timeout/error contract.

## Phase 2: Configuration and Startup


- [ ] **T2.1 - Add env config for memory backend and Qdrant settings**  
  Files: `main.go`, `specs/configuration.md`, `README.md`  
  Notes: Add envs like `MEMORY_ENABLED`, `MEMORY_BACKEND`, `QDRANT_URL`, `QDRANT_COLLECTION`, embedding provider vars.


- [ ] **T2.2 - Wire memory subsystem initialization at startup**  
  Files: `main.go`  
  Notes: Construct store/embedder, run health checks, fail-fast or disable via feature flag.


- [ ] **T2.3 - Add runtime kill switch and degraded-mode behavior**  
  Files: `main.go`, `specs/architecture.md`  
  Notes: If memory unavailable, disable memory tools with explicit logs.

## Phase 3: Qdrant Store Implementation


- [ ] **T3.1 - Implement Qdrant-backed memory store with collection bootstrap**  
  Files: `memory/qdrant_store.go` (new), `go.mod`, `go.sum`  
  Notes: Create/check collection, vector params, payload indexes.


- [ ] **T3.2 - Implement upsert + dedupe strategy**  
  Files: `memory/qdrant_store.go`, `memory/dedupe.go` (new)  
  Notes: Deterministic IDs and near-duplicate suppression.


- [ ] **T3.3 - Implement filtered semantic recall query path**  
  Files: `memory/qdrant_store.go`  
  Notes: Support filters for `kind`, `discord_user_id`, `person_handle`, tags, scope.


- [ ] **T3.4 - Implement TTL cleanup primitives**  
  Files: `memory/qdrant_store.go`, `memory/retention.go` (new)  
  Notes: Delete expired points and support scheduled cleanup.

## Phase 4: Embedding Implementation


- [ ] **T4.1 - Implement primary embedding provider**  
  Files: `memory/embedder_provider_*.go` (new), `main.go`  
  Notes: Provider depends on chosen model/API; include retries, batch support, truncation limits.


- [ ] **T4.2 - Add deterministic test embedder for unit tests**  
  Files: `memory/embedder_test_double.go` (new)  
  Notes: Stable vector outputs for reproducible tests.

## Phase 5: Tooling (`remember` / `recall`)


- [ ] **T5.1 - Define input structs + JSON schemas for `remember` and `recall`**  
  Files: `main.go`, `specs/tool-system.md`  
  Notes: Extend existing `GenerateSchema[T]` pattern.


- [ ] **T5.2 - Implement `remember` tool handler**  
  Files: `main.go`, `memory/service.go` (new)  
  Notes: Validate input, apply safety filter, embed, upsert, return ID + summary.


- [ ] **T5.3 - Implement `recall` tool handler**  
  Files: `main.go`, `memory/service.go`  
  Notes: Query + filters + ranking + compact response formatting.


- [ ] **T5.4 - Register memory tools in `buildTools` with feature gating**  
  Files: `main.go`  
  Notes: Include tools only when memory is enabled/healthy.

## Phase 6: Discord Identity Integration


- [ ] **T6.1 - Expose stable Discord identity metadata to memory service**  
  Files: `discord.go`, `main.go`  
  Notes: Pass `discord_user_id`, handle, channel/session context into tool execution path.


- [ ] **T6.2 - Normalize handle changes and preserve stable person keying**  
  Files: `memory/identity.go` (new), `discord.go`  
  Notes: Primary key by user ID; handle as mutable alias.


- [ ] **T6.3 - Enforce cross-user memory isolation**  
  Files: `memory/qdrant_store.go`, `memory/service.go`, `discord_test.go`  
  Notes: Mandatory filters to prevent leakage between users.

## Phase 7: Prompting and Policy


- [ ] **T7.1 - Add memory tool usage policy to prompt builder**  
  Files: `prompting.go`, `specs/prompting.md`  
  Notes: Define when to remember/recall and when not to.


- [ ] **T7.2 - Add explicit storage safety rules**  
  Files: `prompting.go`, `specs/prompting.md`  
  Notes: Do not persist secrets, credentials, highly sensitive raw data.


- [ ] **T7.3 - Add memory-kind-specific guidance**  
  Files: `prompting.go`  
  Notes: Person = user preferences; Interest = recurring agent topics; Fact = reusable stable info.

## Phase 8: Safety, Moderation, and Retention


- [ ] **T8.1 - Implement pre-write redaction/safety checks**  
  Files: `memory/safety.go` (new), `memory/service.go`, `main_test.go`  
  Notes: Detect credentials/tokens and block writes with explicit reason.


- [ ] **T8.2 - Implement memory quotas/caps per scope/user**  
  Files: `memory/retention.go`, `memory/service.go`  
  Notes: Bound growth and prevent runaway storage.


- [ ] **T8.3 - Implement ranking decay (recency + importance)**  
  Files: `memory/ranking.go` (new), `memory/service.go`  
  Notes: Improve recall quality over time.

## Phase 9: Observability


- [ ] **T9.1 - Add structured server events for memory lifecycle**  
  Files: `main.go`, `specs/architecture.md`  
  Notes: Emit events for memory init, remember/recall success/failure, cleanup.


- [ ] **T9.2 - Add memory stats in tool events**  
  Files: `main.go`  
  Notes: Include result counts, similarity scores, latency, payload sizes.


- [ ] **T9.3 - Add lightweight metrics summary for tests/debug**  
  Files: `memory/metrics.go` (new), `main_test.go`  
  Notes: Hit-rate, miss-rate, average score, write volume.

## Phase 10: Testing


- [ ] **T10.1 - Unit tests for memory domain validation**  
  Files: `memory/types_test.go` (new), `memory/service_test.go` (new)  
  Notes: Validate required fields and kind-specific constraints.


- [ ] **T10.2 - Unit tests for dedupe, ranking, and retention**  
  Files: `memory/dedupe_test.go` (new), `memory/ranking_test.go` (new), `memory/retention_test.go` (new)  
  Notes: Deterministic behavior with test embedder.


- [ ] **T10.3 - Integration tests for `remember`/`recall` tool loop**  
  Files: `main_test.go`, `main_integration_test.go`  
  Notes: End-to-end tool roundtrip with mocked and real backend paths.


- [ ] **T10.4 - Discord isolation tests for person memory**  
  Files: `discord_test.go`  
  Notes: Verify no cross-user recall leakage.


- [ ] **T10.5 - E2E harness scenario for People/Interests/Facts recall quality**  
  Files: `main_delegation_harness_integration_test.go` or `memory_harness_integration_test.go` (new), `scripts/run-memory-harness.sh` (new)  
  Notes: Evaluate recall precision under repeated interactions.

## Phase 11: Documentation and Specs


- [ ] **T11.1 - Update architecture spec with memory component and flow diagrams**  
  Files: `specs/architecture.md`  


- [ ] **T11.2 - Update tool-system spec with `remember`/`recall` contracts**  
  Files: `specs/tool-system.md`  


- [ ] **T11.3 - Update configuration spec with memory env vars**  
  Files: `specs/configuration.md`  


- [ ] **T11.4 - Update prompting spec with memory behavior rules**  
  Files: `specs/prompting.md`  


- [ ] **T11.5 - Update README with setup and operational instructions**  
  Files: `README.md`  

## Phase 12: Rollout and Operationalization


- [ ] **T12.1 - Add feature-flagged rollout stages**  
  Files: `main.go`, `README.md`  
  Notes: `MEMORY_ENABLED=false` default; staged enablement.


- [ ] **T12.2 - Add data reset and backfill utilities**  
  Files: `scripts/reset-memory.sh` (new), `scripts/backfill-memory.sh` (new)  


- [ ] **T12.3 - Define rollback runbook**  
  Files: `docs/runbooks/memory-rollback.md` (new)  

## Discovery / Experimentation Track (Parallel)


- [ ] **D1 - Compare vector-only vs hybrid retrieval quality**  
  Files: `docs/memory/experiments.md` (new), harness test files  


- [ ] **D2 - Tune default recall parameters (`top_k`, `min_score`) by memory kind**  
  Files: `memory/service.go`, harness configs  


- [ ] **D3 - Evaluate auto-remember aggressiveness levels**  
  Files: `prompting.go`, harness configs  


- [ ] **D4 - Validate retention defaults and decay coefficients in long-run simulation**  
  Files: `memory/ranking.go`, `memory/retention.go`, harness  

## Milestone Gates


- [ ] **M1 - Feasibility gate passed**  
  Criteria: backend mode chosen and documented (`T0.*` complete).


- [ ] **M2 - Functional memory tools gate passed**  
  Criteria: `remember`/`recall` tools operational in CLI + tests passing (`T1-T5`, `T10.1-T10.3`).


- [ ] **M3 - Discord identity and isolation gate passed**  
  Criteria: per-user memory routing and leakage tests passing (`T6`, `T10.4`).


- [ ] **M4 - Production-readiness gate passed**  
  Criteria: safety, observability, docs, rollout assets complete (`T7-T12`).

## Rough Total Estimate


- [ ] **Program estimate: ~18 to 24 engineering days**  
  Assumes one engineer, moderate unknowns around Qdrant runtime mode and embedding provider selection.
