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

Model selection is not environment-configurable.

1. Primary chat model is fixed to `kimi-k2-instruct`
2. Reasoning delegation model is fixed to `gpt-oss-120b`

`main.go` defines these via a named type:

1. `type Model string`
2. `const Instruct Model = "kimi-k2-instruct"`
3. `const Reasoning Model = "gpt-oss-120b"`

## Startup Resolution

Initialization sequence:

1. Read `VULTR_API_KEY`; exit with status 1 when missing
2. Read `VULTR_BASE_URL`; fallback to `defaultVultrBaseURL`
3. Trim trailing slash from base URL with `strings.TrimRight(baseURL, "/")`
4. Create `Agent` via `NewAgent(...)`

## Behavioral Notes

1. `VULTR_API_KEY` is mandatory for both runtime and integration tests
2. Base URL normalization avoids `//chat/completions` construction issues
3. Tool registry includes built-ins and `reason_with_gpt_oss`
4. HTTP client defaults to `http.DefaultClient` unless explicitly injected

## Integration Test Configuration

`main_integration_test.go` uses the same variable contract:

1. Missing `VULTR_API_KEY` causes tests to `t.Skip(...)`
2. `VULTR_BASE_URL` falls back to the same default
3. Base URL is normalized by trimming trailing slash

This keeps test behavior aligned with production startup behavior.
