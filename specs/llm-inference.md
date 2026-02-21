# LLM Inference

## Overview

Inference is handled by `Agent.runInferenceWithModel()` and `Agent.runInferenceStreamWithModel()`
via Vultr's chat completions endpoint:

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
| `stream` | bool | Set to `true` for primary CLI inference calls |
| `tools` | `[]ChatTool` | Populated from registered agent tools |
| `tool_choice` | string | Set to `"auto"` when tools are present |

Authentication and content headers:

1. `Authorization: Bearer <VULTR_API_KEY>`
2. `Content-Type: application/json`

## Response Handling

`runInferenceWithModel()` (non-streaming path) enforces:

1. HTTP status must be 2xx
2. JSON must decode into `ChatCompletionResponse`
3. `error.message` in body triggers error return
4. At least one `choice` must exist

On success, it returns `choices[0].message`.

`runInferenceStreamWithModel()` (streaming path used by `Agent.Run()` for primary model calls):

1. Sends `stream=true` and consumes `text/event-stream` `data:` events
2. Emits content deltas to CLI as they arrive
3. Reconstructs final `ChatMessage` content and tool calls from streamed deltas
4. Returns API-level `error.message` when present in stream chunks

For `gpt-oss-120b` reasoning calls, output can be returned as either:

1. `message.content` string
2. `message.reasoning` string (fallback when content is empty)

## Message/Tool Loop

```text
conversation + tools
        │
        ▼
runInferenceStreamWithModel() (primary)
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

`runInferenceWithModel()` and `runInferenceStreamWithModel()` return errors for:

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
2. Primary model output is streamed to CLI; delegated reasoning remains non-streaming
3. Conversation grows unbounded for the process lifetime
