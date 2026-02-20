# LLM Inference

## Overview

Inference is handled by `Agent.runInference()` via Vultr's chat completions endpoint:

- Method: `POST`
- Path: `/chat/completions`
- Base URL: `VULTR_BASE_URL` (default `https://api.vultrinference.com/v1`)

The request always includes conversation history and may include tool definitions.

Two models are used:

1. Primary chat model: `kimi-k2-instruct`
2. Delegated reasoning model: `gpt-oss-120b` (called only via `delegate_reasoning` tool)

## Request Model

`ChatCompletionRequest` fields:

| Field | Type | Notes |
|-------|------|-------|
| `model` | string | Fixed by runtime path (`kimi-k2-instruct` primary, `gpt-oss-120b` reasoning) |
| `messages` | `[]ChatMessage` | Full conversation history |
| `max_tokens` | int | Fixed to `1024` |
| `tools` | `[]ChatTool` | Populated from registered agent tools |
| `tool_choice` | string | Set to `"auto"` when tools are present |

Authentication and content headers:

1. `Authorization: Bearer <VULTR_API_KEY>`
2. `Content-Type: application/json`

## Response Handling

`runInference()` enforces:

1. HTTP status must be 2xx
2. JSON must decode into `ChatCompletionResponse`
3. `error.message` in body triggers error return
4. At least one `choice` must exist

On success, it returns `choices[0].message`.

For `gpt-oss-120b` reasoning calls, output can be returned as either:

1. `message.content` string
2. `message.reasoning` string (fallback when content is empty)

## Message/Tool Loop

```text
conversation + tools
        │
        ▼
runInference()
        │
        ▼
assistant ChatMessage
        │
        ├─ has text      -> print assistant text
        └─ has tool_calls -> execute each tool and append tool result messages
                                │
                                └─ call runInference() again with expanded conversation
```

## Error Surface

`runInference()` returns errors for:

1. Request creation or marshal failures
2. HTTP transport errors
3. Non-2xx responses (`vultr api error (<status>): <body>`)
4. Response decode failures
5. API-level error field (`vultr api error: <message>`)
6. Empty choices (`vultr api returned no choices`)

These bubble to `Agent.Run()` and terminate the session.

`delegate_reasoning` adds guardrails:

1. Per-turn delegation limit of 2 calls
2. Per-call timeout of 45 seconds
3. No tools exposed to the reasoning model

## Operational Notes

1. No retry/backoff is implemented in the inference client
2. No streaming support; completion is full-response only
3. Conversation grows unbounded for the process lifetime
