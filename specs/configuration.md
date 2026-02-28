# Configuration

## Overview

Configuration is loaded from a TOML file at startup. On first run, a default config is created from the embedded `config.default.toml`.

### Config File Location

Checked in order:

1. `PCLAW_CONFIG` env var (explicit path)
2. `$XDG_CONFIG_HOME/pclaw/config.toml`
3. `~/.config/pclaw/config.toml`

### Environment Variable Overrides

| Variable | Purpose |
|----------|---------|
| `PCLAW_CONFIG` | Override config file path |
| `PCLAW_PROVIDER` | Override `active_provider` from config |
| `PCLAW_MODEL` | Override `active_model` for the active provider |
| `TOOL_EVENT_LOG` | CLI tool event logging: `off` (default) or `debug` |
| `SERVER_EVENT_LOG` | Server event logging: `off` (default), `line`, or `verbose` |

API keys and tokens are not set directly — instead, the config names an env var to read from (e.g. `api_key_env = "VULTR_API_KEY"`).

---

## Top-Level

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `active_provider` | string | Yes | — | Name of the provider to use (must match a key in `[providers]`). Overridden by `PCLAW_PROVIDER` env var. |

## `[providers.<name>]`

Named inference backends. Define one or more; `active_provider` selects which one is used.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `api_key_env` | string | No | — | Name of env var containing the API key. When empty, no Authorization header is sent (for local/keyless servers). |
| `base_url` | string | Yes | — | Base URL for the OpenAI-compatible API (e.g. `https://api.vultrinference.com/v1`). |
| `primary_model` | string | Yes* | — | Model ID for primary chat inference. |
| `reasoning_model` | string | Yes* | — | Model ID for `delegate_reasoning` tool calls. |
| `summarization_model` | string | Yes* | — | Model ID for memory recall summarization and conversation compaction. |

*\* Not required when `active_model` is set — the named model's `model_id` populates all three.*
| `thinking_toggle_keypath` | string[] | No | — | JSON keypath for injecting a thinking toggle into request bodies (e.g. `["chat_template_kwargs", "enable_thinking"]`). When empty, no toggle is injected. |
| `thinking_toggle_on_value` | any | No | `true` | Value injected at the keypath when thinking is enabled. |
| `thinking_toggle_off_value` | any | No | `false` | Value injected at the keypath when thinking is disabled. |
| `active_model` | string | No | — | Name of a model defined in `[providers.<name>.models]`. When set, the selected model's `model_id` populates all three role fields and its thinking toggle (if present) overrides the provider-level toggle. Overridden by `PCLAW_MODEL` env var. |
| `models` | table | No | — | Map of named model definitions (see below). |

### Named Models

When a provider serves multiple models (e.g. a local llama.cpp server switched via `llama-switch`), named models avoid editing three fields on every switch. Define models under `[providers.<name>.models.<model_name>]` and select one with `active_model`.

#### `[providers.<name>.models.<model_name>]`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `model_id` | string | Yes | — | Model identifier sent in API requests. Populates `primary_model`, `reasoning_model`, and `summarization_model`. |
| `thinking_toggle_keypath` | string[] | No | — | Overrides the provider-level thinking toggle keypath. When empty, the provider-level toggle is preserved. |
| `thinking_toggle_on_value` | any | No | `true` | Overrides the provider-level on value (only when `thinking_toggle_keypath` is set). |
| `thinking_toggle_off_value` | any | No | `false` | Overrides the provider-level off value (only when `thinking_toggle_keypath` is set). |

Resolution happens at config load time — downstream code sees only the flat `primary_model`, `reasoning_model`, `summarization_model`, and thinking toggle fields.

## `[discord]`

Discord bot settings. The bot starts in Discord mode when `bot_token_env` is set and the resolved token is non-empty.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `bot_token_env` | string | No | — | Name of env var containing the Discord bot token. When empty, Discord mode is disabled. |
| `application_id` | string | No | `""` | Discord application ID for slash command registration. When empty, slash commands are skipped and the bot runs in mention/DM-only mode. |
| `guild_id` | string | No | `""` | Scope slash command registration to this guild. When empty, the slash command is registered globally. Only relevant when `application_id` is set. |
| `allowed_channel_ids` | string or string[] | No | `"all"` | Channel access policy. `"all"`: respond in all guild channels. `"none"`: DM-only (reject all guild channels). `["id1", "id2"]`: whitelist specific channel IDs. DMs are always allowed regardless of this setting. |
| `allowed_user_ids` | string[] | No | `[]` | User ID allowlist. When non-empty, only listed users can interact with the bot (applies to both guild channels and DMs). Empty = no restriction. |

## `[agent]`

Agent identity and prompt configuration.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | No | `"Codex"` | Agent name used in system prompt identity section. |
| `role_summary` | string | No | built-in default | Role summary used in system prompt identity section. |
| `persona` | string | No | built-in default | Inline persona text for system prompt composition. |
| `persona_file` | string | No | `""` | Path to persona text file. When readable and non-empty, overrides `persona`. |
| `max_persona_chars` | int | No | `600` | Character cap applied to persona text in system prompt. |
| `working_directory` | string | No | `""` | Sandbox root for filesystem tools. When empty, defaults to `$XDG_DATA_HOME/pclaw/workspace` (fallback `~/.local/share/pclaw/workspace`). All `read_file`, `list_files`, and `edit_file` operations are constrained to this directory tree. |

## `[memory]`

Durable semantic memory subsystem.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | bool | No | `true` | Enable/disable the memory subsystem (`record`/`recall` tools and auto-recall). |
| `backend` | string | No | `"vultr"` | Memory storage backend. Currently only `"vultr"` (vector store API). When set to `"vultr"`, the memory client uses the Vultr provider's credentials regardless of the active inference provider. |
| `collection_name` | string | No | `"agent-memory"` | Vector store collection name. |

## `[web_search]`

Web search grounding via Tavily.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `api_key_env` | string | No | — | Name of env var containing the Tavily API key. When empty, web search is disabled. |
| `max_results` | int | No | `5` | Number of search results per `web_search` call (1-20). |

---

## Startup Resolution

1. Load and parse TOML config file (creating from defaults if needed)
2. Apply `PCLAW_PROVIDER` env var override to `active_provider`
3. Apply `PCLAW_MODEL` env var override to the active provider's `active_model`
4. If `active_model` is set, resolve named model: populate role fields and thinking toggle from the model definition
5. Resolve the active provider config and read its API key from the named env var
6. Resolve Discord config: read bot token, parse channel policy, build user allowlist
7. Resolve web search config: read Tavily API key
8. If Discord bot token is present, start Discord mode; otherwise start CLI REPL
9. Configure memory (using Vultr provider credentials when `backend = "vultr"`)
10. Configure web search (when Tavily key is present)
11. Configure logging from `TOOL_EVENT_LOG` and `SERVER_EVENT_LOG` env vars

## Integration Test Configuration

Tests use the same config resolution. `VULTR_API_KEY` must be set for integration tests; when missing, tests skip.

Memory integration test requires explicit opt-in:

```
VULTR_API_KEY=<key> MEMORY_INTEGRATION_TEST=true go test ./... -run Integration
```
