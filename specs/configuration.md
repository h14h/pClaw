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
| `DISCORD_BOT_TOKEN` | No | none | Enables Discord mode and authenticates bot session |
| `DISCORD_APPLICATION_ID` | No | inferred from bot user when possible | Application ID for slash command registration |
| `DISCORD_GUILD_ID` | No | empty (global registration) | Guild scope for slash command registration |
| `DISCORD_ALLOWED_CHANNEL_IDS` | No | empty | Comma-separated channel allowlist |
| `DISCORD_ALLOWED_USER_IDS` | No | empty | Comma-separated user allowlist |

Model selection is not environment-configurable.

1. Primary chat model is fixed to `kimi-k2-instruct`
2. Reasoning delegation model is fixed to `gpt-oss-120b`

`main.go` defines these via a named type:

1. `type Model string`
2. `const Instruct Model = "kimi-k2-instruct"`
3. `const Reasoning Model = "gpt-oss-120b"`

## Startup Resolution

Initialization sequence:

1. If `DISCORD_BOT_TOKEN` is set, start Discord runtime path
2. Read `VULTR_API_KEY`; exit with status 1 when missing
3. Read `VULTR_BASE_URL`; fallback to `defaultVultrBaseURL`
4. Trim trailing slash from base URL with `strings.TrimRight(baseURL, "/")`
5. Build runtime (`Agent` for CLI, session-scoped `Agent`s for Discord)
6. Configure tool event logging from `TOOL_EVENT_LOG` (CLI mode)

CLI initialization sequence:

1. Read `VULTR_API_KEY`; exit with status 1 when missing
2. Read `VULTR_BASE_URL`; fallback to `defaultVultrBaseURL`
3. Trim trailing slash from base URL with `strings.TrimRight(baseURL, "/")`
4. Create `Agent` via `NewAgent(...)`
5. Configure tool event logging from `TOOL_EVENT_LOG`

## Behavioral Notes

1. `VULTR_API_KEY` is mandatory for both runtime and integration tests
2. Base URL normalization avoids `//chat/completions` construction issues
3. Tool registry includes built-ins and `delegate_reasoning`
4. HTTP client defaults to `http.DefaultClient` unless explicitly injected
5. `TOOL_EVENT_LOG=off` keeps tool-event output silent while preserving spinner-based wait feedback
6. `TOOL_EVENT_LOG=debug` emits structured `tool_event` lines to stderr
7. Discord mode disables spinner output and routes responses through `/agent` interactions

## Integration Test Configuration

`main_integration_test.go` uses the same variable contract:

1. Missing `VULTR_API_KEY` causes tests to `t.Skip(...)`
2. `VULTR_BASE_URL` falls back to the same default
3. Base URL is normalized by trimming trailing slash

This keeps test behavior aligned with production startup behavior.
