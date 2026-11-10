# Tuning log: muse-ember

Made from `muse-spark-1.3` with `muse-ember-1.0`, medium thinking. Ember is in pi-ai's catalog from 1.5.2.

The owner asked for fewer words and more natural, conversational prose. Every run below is three passes. "Probe" is a scratch set run with `pnpm evals --cases`: six long synthetic worker reports and four direct questions, since the evals have no case for relaying a report. The style columns count replies, across cases and probe together, that slip into sentence case, use a "catch:" or "caveat:" label, or end on an either/or offer.

| Round | Change | Relay words | Direct words | Sentence case | Labels | Either/or close | Cases | Voice |
|---|---|---|---|---|---|---|---|---|
| Baseline | Copy of Spark 1.3 | 107 | 89 | 11/66 | 4/66 | 5/66 | 57/57 | 5.0 |
| 1 | `voice.md`: Terra's wordiness changes. Lean short, two to four sentences under about 60 words, the Discord limits are a ceiling. A report is material, not a draft. One caveat at most, no closing hedge or recap. Two real long replies as Avoid and Prefer | 80 | 47 | 6/66 | 2/66 | 0/66 | 57/57 | 4.8 |
| 2 | Stay lowercase the whole reply. Work a catch into the sentence, no labels. Once you've given a pick, stop. An invented climbing-gym relay as Avoid and Prefer | 88 | 47 | 0/65 | 2/65 | 0/65 | 57/57 | 5.0 |
| 3 | Relay rule made concrete: pick the two or three facts that decide it, other options get a clause, about 40 to 70 words | 57 | 42 | 0/66 | 0/66 | 0/66 | 56/57 | 4.8 |
| 4 | Put back "reflective conversation can take a little more space", which round 1 dropped. A burnout reply had shrunk to a generic one-line question | 65 | 45 | 0/63 | 0/63 | 0/63 | 56/57 | 4.8 |

Holdout after round 4: 24/24, voice 5.0, median 2.3s.

The two failures in rounds 3 and 4 are noise. One reflective reply scored 3 with the judge before round 4. One `hours` pass got an ambiguous search and delegated, which `front.md` allows. `ask-coop-games` in the probe set sometimes delegates instead of answering, which is fine.

## Eval problems to report

- `remind` and `voice-ramble` stamp the message Thu 2026-11-05, but `follow_up` checks the real clock. Once that date has passed, "friday morning" is in the past, and Ember says the reminder didn't stick. The case still passes because it only checks that `follow_up` was called.

## Open

- Once in about 300 replies, Ember wrote a garbled aside ("googhaan?? no, just good") in the middle of a list. It's the model, not the prompt. Watch for it in real use.
- With the either/or close gone, the `musing` replies lean toward just asking what prompted the idea, rather than giving a view and then asking.
- The probe relays are one-shot. Real relays deep in a long thread run longer, so check real Discord replies after a few days.
