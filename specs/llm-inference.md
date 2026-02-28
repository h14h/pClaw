# LLM Inference

## Overview

Inference is handled by `Agent.runInferenceWithModel()` and `Agent.runInferenceStreamWithModel()`
via an OpenAI-compatible chat completions endpoint:

- Method: `POST`
- Path: `/chat/completions`
- Base URL: configured per provider via `base_url` in `[providers.<name>]`

The request always includes conversation history and may include tool definitions.
Before each request, runtime prepends one generated `role=system` message.

Three models are configured per provider:

1. Primary chat model (`primary_model`): used for the main agent loop
2. Delegated reasoning model (`reasoning_model`): called only via `delegate_reasoning` tool
3. Summarization model (`summarization_model`): used for memory recall summarization and conversation compaction

## Request Model

`ChatCompletionRequest` fields:

| Field | Type | Notes |
|-------|------|-------|
| `model` | string | Set from active provider config (`primary_model`, `reasoning_model`, or `summarization_model`) |
| `messages` | `[]ChatMessage` | Full conversation history |
| `max_tokens` | int | `4096` for primary model, `1024` for reasoning model |
| `stream` | bool | Set to `true` for primary CLI inference calls |
| `tools` | `[]ChatTool` | Populated from registered agent tools |
| `tool_choice` | string | Set to `"auto"` when tools are present |

Authentication and content headers:

1. `Authorization: Bearer <api_key>` (omitted when the provider has no `api_key_env` or the env var is empty)
2. `Content-Type: application/json`

When a provider defines `thinking_toggle_keypath`, the request body is augmented with a nested field controlling per-request thinking. Standard agent loop turns inject the off value; `delegate_reasoning` calls inject the on value. See `specs/configuration.md` § `[providers.<name>]` for details.

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

CLI wait-state behavior for primary streaming inference:

1. A delayed single-line status indicator (`waiting for model...`) is shown while waiting for first model output
2. Indicator delay is `150ms` to avoid flicker on fast responses
3. Indicator clears immediately when first content delta arrives, request completes, or request errors

For delegated reasoning calls, output can be returned as any of:

1. `message.content` string
2. `message.reasoning_content` string (used by some models like GLM)
3. `message.reasoning` string (fallback when both content and reasoning_content are empty)

The same priority applies during streaming: both `reasoning` and `reasoning_content` deltas are accumulated.

CLI wait-state behavior for delegated reasoning:

1. `delegate_reasoning` shows a delayed status indicator (`delegating reasoning...`) during the reasoning-model call
2. Indicator delay is `150ms`
3. Indicator clears on success or error before tool completion/failure event output

## System Prompt Injection

System prompt assembly is handled by the prompt builder (`prompting.go`) and prepended before every request.

1. Primary model calls use `full` prompt mode (identity, behavior, tooling, safety, runtime sections)
2. Delegated reasoning calls use `minimal` prompt mode (behavior, safety, runtime sections)
3. Injection ensures a single leading `system` message for each API request

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
        ├─ has text      -> print assistant text (CLI) or emit response part callback (Discord progressive mode)
        └─ has tool_calls -> execute each tool and append tool result messages
                                │
                                └─ call runInference() again with expanded conversation
```

Discord adapter post-processing for emitted text parts:

1. Honor explicit split markers (`<<MSG_SPLIT>>`) when present
2. Enforce Discord hard per-message limits
3. Use balanced boundary-aware fallback splitting when no markers are available

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

## Known Issues

1. **Intermittent `delta` array in stream chunks**: Some Vultr API responses return `choices[].delta` as `[]` (empty array) instead of `{}` (object) in certain SSE chunks. This causes `json.Unmarshal` to fail in `processStreamEvent`, which aborts the stream and surfaces an error to the user. The fix is to skip malformed chunks (log a warning, continue parsing) rather than treating them as fatal. Observed intermittently during delegation-heavy prompts.

## Operational Notes

1. No retry/backoff is implemented in the inference client
2. Primary model output is streamed to CLI; delegated reasoning remains non-streaming
3. Delayed status indicators are used for model wait states to provide visible progress feedback
4. Conversation grows unbounded for the process lifetime
