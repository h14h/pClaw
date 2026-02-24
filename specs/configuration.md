# Configuration

## Overview

Runtime configuration is environment-driven and resolved at process startup in `main()`.
There is no config file layer and no CLI argument parsing.

Precedence is:

1. Environment variables
2. Hardcoded defaults (for optional values)

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `VULTR_API_KEY` | Yes | none | Bearer token for Vultr Inference |
| `VULTR_BASE_URL` | No | `https://api.vultrinference.com/v1` | API base URL |
| `TOOL_EVENT_LOG` | No | `off` | CLI tool event logging mode (`off` or `debug`) |
| `SERVER_EVENT_LOG` | No | `off` | Server event logging mode (`off`, `line`, or `verbose`) |
| `DISCORD_BOT_TOKEN` | No | none | Enables Discord mode and authenticates bot session |
| `DISCORD_APPLICATION_ID` | No | inferred from bot user when possible | Application ID for slash command registration |
| `DISCORD_GUILD_ID` | No | empty (global registration) | Guild scope for slash command registration |
| `DISCORD_ALLOWED_CHANNEL_IDS` | No | empty | Comma-separated channel allowlist |
| `DISCORD_ALLOWED_USER_IDS` | No | empty | Comma-separated user allowlist |
| `AGENT_NAME` | No | `Codex` | Prompt identity name used in system prompt `Identity` section |
| `AGENT_ROLE_SUMMARY` | No | built-in default | Prompt role summary used in system prompt `Identity` section |
| `AGENT_PERSONA` | No | built-in default | Inline persona text for system prompt composition |
| `AGENT_PERSONA_FILE` | No | empty | Path to persona text file; when readable and non-empty, overrides `AGENT_PERSONA` |
| `AGENT_PROMPT_MAX_PERSONA_CHARS` | No | `600` | Character cap applied to persona text embedded in system prompt |
| `MEMORY_ENABLED` | No | `true` (enabled) | Set to `false`, `0`, or `no` to disable durable memory (no `remember`/`recall` tools, no auto-recall) |
| `MEMORY_COLLECTION_NAME` | No | `agent-memory` | Vultr vector store collection name used for semantic memory |

Model selection is not environment-configurable.

1. Primary chat model is fixed to `kimi-k2-instruct`
2. Reasoning delegation model is fixed to `gpt-oss-120b`
3. Memory recall summarization model is fixed to `gpt-oss-120b`

`main.go` defines these via a named type:

1. `type Model string`
2. `const Instruct Model = "kimi-k2-instruct"`
3. `const Reasoning Model = "gpt-oss-120b"`
4. `const Summarization Model = "gpt-oss-120b"`

## Startup Resolution

Initialization sequence:

1. If `DISCORD_BOT_TOKEN` is set, start Discord runtime path
2. Read `VULTR_API_KEY`; exit with status 1 when missing
3. Read `VULTR_BASE_URL`; fallback to `defaultVultrBaseURL`
4. Trim trailing slash from base URL with `strings.TrimRight(baseURL, "/")`
5. Build runtime (`Agent` for CLI, session-scoped `Agent`s for Discord)
6. Configure tool event logging from `TOOL_EVENT_LOG` (CLI mode)
7. Configure server event logging from `SERVER_EVENT_LOG`

CLI initialization sequence:

1. Read `VULTR_API_KEY`; exit with status 1 when missing
2. Read `VULTR_BASE_URL`; fallback to `defaultVultrBaseURL`
3. Trim trailing slash from base URL with `strings.TrimRight(baseURL, "/")`
4. Create `Agent` via `NewAgent(...)`
5. Configure tool event logging from `TOOL_EVENT_LOG`
6. Configure server event logging from `SERVER_EVENT_LOG`
7. Call `configureMemory(ctx, agent)` — reads `MEMORY_ENABLED` and `MEMORY_COLLECTION_NAME`, creates `MemoryClient`, bootstraps the vector store collection, and sets `agent.memoryClient`; on failure logs a warning and continues without memory

## Behavioral Notes

1. `VULTR_API_KEY` is mandatory for both runtime and integration tests
2. Base URL normalization avoids `//chat/completions` construction issues
3. Tool registry includes built-ins and `delegate_reasoning`
4. HTTP client defaults to `http.DefaultClient` unless explicitly injected
5. `TOOL_EVENT_LOG=off` keeps tool-event output silent while preserving spinner-based wait feedback
6. `TOOL_EVENT_LOG=debug` emits structured `tool_event` lines to stderr
7. `SERVER_EVENT_LOG=line` emits single-line `key=value` server events to stdout for Discord request, session, turn, inference, tool, and response lifecycle tracking
8. `SERVER_EVENT_LOG=verbose` includes full response content fields (per-part, per-chunk, and final response) for deep troubleshooting
8. Discord mode disables spinner output, routes responses through slash commands (`/agent`) and mention-based chat, emits assistant text progressively as it is produced, and refreshes typing indicators while work is ongoing

## Integration Test Configuration

`main_integration_test.go` uses the same variable contract:

1. Missing `VULTR_API_KEY` causes tests to `t.Skip(...)`
2. `VULTR_BASE_URL` falls back to the same default
3. Base URL is normalized by trimming trailing slash

This keeps test behavior aligned with production startup behavior.

`memory_test.go` contains one live-API integration test (`TestMemoryRoundTrip_Integration`) that requires two opt-in env vars:

| Variable | Required for memory integration test | Purpose |
|----------|--------------------------------------|---------|
| `MEMORY_INTEGRATION_TEST` | Yes (must be `true`) | Explicit opt-in to run the live memory round-trip test; without this the test is always skipped, even if `VULTR_API_KEY` is set |
| `VULTR_API_KEY` | Yes | Bearer token for the Vultr vector store API |

Run with: `VULTR_API_KEY=<key> MEMORY_INTEGRATION_TEST=true go test ./... -run Integration`
