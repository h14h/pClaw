# Project Specifications

Design documentation for this project, modeled after the Loom specs layout.

## Core Architecture

| Spec | Code | Purpose |
|------|------|---------|
| [architecture.md](./architecture.md) | [main.go](../main.go), [compaction.go](../compaction.go), [websearch.go](../websearch.go) | Agent loop, message flow, tool execution pipeline, compaction subsystem, web search subsystem |
| [tool-system.md](./tool-system.md) | [main.go](../main.go), [websearch.go](../websearch.go) | Tool definitions, schemas, and execution behavior |
| [llm-inference.md](./llm-inference.md) | [main.go](../main.go) | Vultr inference API request/response flow |
| [prompting.md](./prompting.md) | [prompting.go](../prompting.go) | System prompt composition, modes, and injection strategy |

## Configuration & Environment

| Spec | Code | Purpose |
|------|------|---------|
| [configuration.md](./configuration.md) | [main.go](../main.go) | Env vars, defaults, and runtime configuration |

## Testing

| Spec | Code | Purpose |
|------|------|---------|
| [testing.md](./testing.md) | [main_test.go](../main_test.go), [main_integration_test.go](../main_integration_test.go), [main_delegation_harness_integration_test.go](../main_delegation_harness_integration_test.go) | Unit and integration testing strategy |
