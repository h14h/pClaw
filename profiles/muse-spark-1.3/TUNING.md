# Tuning log: muse-spark-1.3

| Date | What failed | Change | Cases | Holdout |
|---|---|---|---|---|
| 2026-11-05 | Reached for raw T3 tools instead of `start_job`, and dropped asks in long memos, with all tools offered: 29/34 | `deferredTools: ["t3_*"]` | 34/34 | 15/16 |

That holdout miss was an eval bug: notes carried over between passes. The cases were written after watching this model, so a clean score here says less than it would for another model.

On the fixed evals, three passes: 48/51 on cases (one was a connection error), 24/24 on holdout, voice 4.8/5, median 7.2s.

On the slimmer `front.md`, which says what pclaw can't do: 51/51 on cases, 24/24 on holdout, voice 5/5, median 7.1s. It stopped offering to send email.
