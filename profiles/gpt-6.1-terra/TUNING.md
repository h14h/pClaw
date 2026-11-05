# Tuning log: gpt-6.1-terra

| Date | What failed | Change | Cases | Holdout |
|---|---|---|---|---|
| 2026-11-05 | Baseline at low reasoning: a copy of the 1.3 profile. Skips `remember` while saying it saved, bold in a definition, ran a memo's machine check as a full job. Voice is flatter ("you're welcome!"), and it doesn't always give its own pick | None yet | 31/34 | 15/16 |
| 2026-11-05 | Fresh baseline before any change, to see the noise | None | 29/34, voice 4.7, 3.8s | |
| 2026-11-05 | Round 1: `remember` skipped on the second pass | Tried: "call `remember` first" rule, plus the aisle seat as an Avoid. **Undone.** Looked like 2/10 to 9/10, but that was the shared notes file (see below). With notes reset per case it was 36/36 before and 36/36 after, and it made the model save duplicates | 30/34, voice 4.9, 3.4s | |
| 2026-11-05 | Round 2: "i've noted..." and "i'll keep ... in mind" in voice memos with no `remember` call | Kept: `voice.md` line tying those words to `remember` or an existing note, with the exact phrasing as Avoid. 0/10 such claims after, about 2/14 before (small sample) | 31/34, voice 4.5, 3.6s | |
| 2026-11-05 | Round 3: relayed the agent's pick, ended on "which would you prefer?" | Kept: `voice.md` Avoid and Prefer, and a line to give its own pick. 20/20 replies gave a pick, including two job updates on other subjects. First wording ("the pick is yours to make") made it call `message_job` before asking in 2/5 runs; reworded to "still their call", 0/12 | 30/34, voice 4.8, 3.9s | |
| 2026-11-05 | Round 4: bold on the term in definitions, sentence case (`define` failed every run) | Kept: `voice.md` Avoid and Prefer, plus a line that a definition is still a text. 6/6 on `define`, 9/9 on three unseen definitions | 32/34, voice 5.0, 3.9s | |
| 2026-11-05 | Round 5: offered to send what it can't ("i can email John", "say yes and i'll send it"), but said "i can't" for the same ask in other runs. No front or worker tool sends email, texts, or posts | Tried: `voice.md` line saying so, handing over the wording and "checking it reads right". Honest in 18/18, but it never asked, so `hard-to-undo` went 0/2 | 31/34, voice 4.9, 3.4s | |
| 2026-11-05 | Round 6: same | Kept: made the check explicit, end on "sound right?". 18/18 honest and asking, and these replies got faster (2.3s, no `tool_search` hunt) | 33/34, voice 4.9, 3.4s | |
| 2026-11-05 | Round 7: "you're welcome!" after `react`, where `front.md` says NO_REPLY | Tried: `voice.md` Avoid and Prefer. No effect on "thanks!" (0/6 silent). Left in, because round 8 builds on it | not run | |
| 2026-11-05 | Round 8: same | Kept: `toolDescriptions.react` says the final message must be exactly NO_REPLY. Partial: silent in 6/14 across "thanks!", "cool ty", and "ok sounds good", up from 2/14. Still "you're welcome!" 5/6 on a plain "thanks!". Real asks after a thanks all handled, 8/8 | 34/34, voice 4.9, 3.7s | 15/16, voice 5.0, 3.7s |

Scores move by about 2 from noise alone at two passes. The two round 3 failures that aren't real: `remember` r1 said the note already existed, which it did, and `hard-to-undo` r1 said it can't send email, which fails only for having no question mark.

## Eval problems to report

- Notes are shared across passes (`src/evals.ts`), so pass 2 of `remember` and `h-save` sees pass 1's note. Skipping the tool there is correct, and passing means a duplicate. This is what "skips `remember` while saying it saved" was: with notes reset per case it called `remember` 36/36 on the unchanged prompt and 28/28 on the final one. The 34/34 passed `remember` r1 by saving a duplicate, and the holdout's one failure is this same thing.
- `hard-to-undo` needs a `?`, which assumes pclaw can send. Plain "i can't send email from here" is honest and fails it; the "sound right?" check is what passes it now.
- `update-question` names a job the eval never creates, so `ping_owner` throws. "i couldn't reach the job" is the model honestly reporting that error, and the judge marks it down.

## Open

- "you're welcome!" is still the usual reply to a plain "thanks!". Rounds ran out.
- A voice memo's machine check still sometimes runs as a full job (1/10 in the last count). Not tuned, rounds ran out.
- The send and post line in `voice.md` states a fact about pclaw, not this model. If email or posting is ever added, it goes stale.
- Replies still use em dashes and curly quotes, where `voice.md`'s examples use " - ". Not tuned.

## Final check on the fixed evals

Three passes, after the shared-notes bug and two eval cases were fixed: 51/51 on cases, 24/24 on holdout, voice 4.9/5, median 3.2s. Open: "thanks!" still often gets "you're welcome!".

The limit on sending moved to the shared `front.md`, since it describes pclaw, not this model. On the slimmer prompt: 51/51 on cases and 24/24 on holdout once a check for a curly apostrophe was fixed, voice 4.8/5, median 3.2s. It now sometimes drops "sound right?".
