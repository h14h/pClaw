# Agent Project Conventions

## Project Context

Information about project structure and architecture is available in the "specs/" directory.

Treat "specs/README.md" as an index or "table of contents" for the rest of the specs.

Ensure you always have "specs/README.md" in your context to help you know when it's appropriate to consult additional spec files.

## Plan Tracking

Implementation plans follow this lifecycle:

1. Draft the plan in `IMPLEMENTATION_PLAN.md` (gitignored) and collaborate with user to finalize
2. User writes (or collaborates with agent to write) a loop prompt in `PROMPT.md` (gitignored) and execute via `ralph.fish`
3. On completion, `IMPLEMENTATION_PLAN.md` is renamed (usually to `COMPLETED_PLAN.md`) per instructions in `PROMPT.md` to terminate loop
4. Before committing, the completed plan `.md` file is to be moved to `docs/plans/YYYY-MM-DD-<slug>.md`
5. Commit the plan file alongside the code changes it produced

**IMPORTANT:** Do not forget step 4. The plan file must be relocated to `docs/plans/` before or in the same commit as the code. Never commit `COMPLETED_PLAN.md` at the repo root.

If changes are needed after initial implementation (between steps 3 & 4), collaborate with user to add phases to the completed plan, rename it back to `IMPLEMENTATION_PLAN.md`, and repeat from step 2.

Naming convention: `docs/plans/2026-02-24-durable-memory-mvp.md` (date of commit, lowercase slug from plan title).

### Writing Implementation Plans

Plans are executed by `ralph.fish`: a loop that spawns fresh, context-less agents (`claude -p`) repeatedly until `IMPLEMENTATION_PLAN.md` no longer exists. Each agent reads the plan, picks the next unchecked item, completes it, checks it off, and exits. Format plans accordingly:

- **Checklist-driven phases.** Every actionable item is a `- [ ]` checkbox. Agents scan for the first unchecked item. Group into phases with explicit dependency ordering (e.g., "Depends on Phase 1").
- **Reference specs, don't repeat them.** Include a brief "Specs" or "Key references" section at the top pointing to relevant `specs/*.md` files and key `file:line` locations. Agents will read those for context. Don't duplicate architecture or type definitions already documented in specs.
- **Self-contained items.** Each checklist item should be completable in a single agent session. Include the function name/signature, which file it goes in, and enough behavioral detail to implement without ambiguity. Keep it terse.
- **Verify gates between phases.** End each phase with a verification step (`go build`, `go test`, etc.) so agents confirm correctness before the next phase begins.
- **Completion sentinel.** End the plan with instructions to rename the file (e.g., to `COMPLETED_PLAN.md`) when all items are checked off. This terminates the ralph loop.
