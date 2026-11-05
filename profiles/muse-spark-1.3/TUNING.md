# Tuning log: muse-spark-1.3

| Date | What failed | Change | Cases | Holdout |
|---|---|---|---|---|
| 2026-11-05 | Reached for raw T3 tools instead of `start_job`, and dropped asks in long memos, with all tools offered: 29/34 | `deferredTools: ["t3_*"]` | 34/34 | 15/16 |

Open: `remember` skipped once on the holdout. The cases were written after watching this model, so a clean score here says less than it would for another model.
