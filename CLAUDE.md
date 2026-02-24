# Agent Project Conventions

## Plan Tracking

Implementation plans follow this lifecycle:

1. Draft the plan in `IMPLEMENTATION_PLAN.md` (gitignored) and collaborate with user to finalize
2. User writes (or collaborates with agent to write) a loop prompt in `PROMPT.md` (gitignored) and execute via `ralph.fish`
3. On completion, `IMPLEMENTATION_PLAN.md` is renamed (usually to `COMPLETED_PLAN.md`) per instructions in `PROMPT.md` to terminate loop
4. Before committing, the completed plan `.md` file is to be moved to `docs/plans/YYYY-MM-DD-<slug>.md`
5. Commit the plan file alongside the code changes it produced

If changes are needed after initial implementation (between steps 3 & 4), collaborate with user to add phases to the completed plan, rename it back to `IMPLEMENTATION_PLAN.md`, and repeat from step 2.

Naming convention: `docs/plans/2026-02-24-durable-memory-mvp.md` (date of commit, lowercase slug from plan title).
