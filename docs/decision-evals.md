# Evaluating the decision model

What feels right here is subjective and changes case by case, so the goal isn't a perfect score. The goal is to change one thing at a time and be able to tell whether it helped.

## What's running

When a T3 turn ends, a message arrives, or a follow-up comes due, pclaw asks a decision model some questions. The answers pick sections of `src/prompts/guidance.md`, and the front model sees those as a `<guidance>` hint it can ignore. If the decision model is down, there's just no hint.

Every event goes to `~/.pclaw/decisions.jsonl`. `pnpm decisions` reads it. `journalctl --user -u pclaw | grep -E 'decide|job '` shows the same thing as it happens.

Any server that speaks `POST /v1/decisions` works as `decisionUrl`. Today that's d1-2B on mm1: a LaunchAgent (`com.h14h.pclaw.decide`) running agenda's `decide/server.py` on port 8083, separate from agenda's own on-demand copy, with `tailscale serve` putting it on the tailnet.

## The question

Do hints make pclaw feel better to use: interrupted less, and only for things that matter, without leaving the owner wondering what's going on?

## Hypotheses

Each one names the number that would change our minds. The targets are guesses to start from, and should move once there's real data.

| | Hypothesis | Measure | Starting target | Baseline |
|---|---|---|---|---|
| H1 | Interruptions fall | Pings per finished T3 turn | 0.3 or less | Nov 2: 17 updates in 38 minutes while the owner was already in those threads |
| H2 | Pings are worth it | Pings answered or liked within 2 hours | 80% or more | Not measured before |
| H3 | Quiet doesn't turn into anxiety | Status checks and "too quiet" messages per job | Under 0.2 | About 8 "status?" messages in five weeks |
| H4 | Hints change behavior | Quiet, note, and ping rates, hinted vs control | A visible gap | None |
| H5 | d1 reads turns correctly | Agreement with the front model on the job's state, and accuracy on labeled turns | 80% or more | Replay: 75% on state, tuned on the same cases |
| H6 | Background T3 jobs can replace workers | Runs, failures, minutes to a first answer, and how T3 feels with the extra settled threads | Failures and speed no worse than workers | 75 timed worker runs: median 3 minutes, five hit the 30-minute cap |
| H7 | No activity means nothing's happening | Status checks on running work in channels, and how often new activity becomes an update | Fewer status checks, with updates on about a third of checks or less | Nov 5: "on it" in a channel, then nothing for minutes |

H6 decides whether workers stay. Keep them until there's about a month of both, and until it's clear what T3 being down would cost. Claude usage isn't in the log, so check it by hand.

## The control

20% of events (`decisionHoldout`) are controls. The decision model is asked and its answer is logged, but the front model doesn't see the hint. The arm comes from a hash of the event's id, so a retry can't switch it.

This is the only way to separate "the hint helped" from "the front prompt helped" or "it was a quiet week". If hinted and control look the same in H4, the hints aren't doing anything, however good d1's answers look.

## Where the labels come from

Nobody should have to fill in forms. Most signal is already in how the owner behaves:

- A reply or 👍 soon after a ping means it was worth sending.
- 👎, 🔕, or "stop telling me" means too loud.
- "status?", "any updates?", or "you should have told me" means too quiet.
- Answering in the thread quickly means the timing was right.

`noise_feedback` and `asks_status` catch the spoken versions. Reactions on pclaw's messages in a job's thread are logged as they happen.

The front model also judges each turn's state while it writes the card. It's a stronger reader than d1, so disagreements between them are cheap places to look for d1's mistakes (H5).

## The loop

1. Use it for about a week, or ten jobs, whichever takes longer.
2. Run `pnpm decisions --since 7`, and read a few raw events behind anything surprising.
3. Pick the one measure that's worst. Write down what you think is causing it and what you'll change.
4. Change one thing: a template, a question's wording, or a note. `pnpm decisions:replay` first, if it's a question.
5. The log stamps each decision with a hash of the templates, so `pnpm decisions --templates <hash>` compares before and after.
6. Add a line to the experiment log below, including when a change did nothing.

Sample sizes are small, so don't trust a difference under about 20 turns per arm. A strong feeling that something was wrong counts as data. Note it and look at the events.

## Replay

Real turns with hand-checked labels live in `~/.pclaw/evals/`, outside the repo because they hold real conversations. `pnpm decisions:replay <file>` runs them through the current questions and reports accuracy, ping precision, and recall. Use it to catch a wording change that breaks something before living with it. Add a case whenever d1 gets something memorably wrong.

The first replay set is 36 cases from Nov 2: 19 real turns, plus 17 copies with the owner marked away. The labels are one reader's judgment, and the thresholds were tuned on the same cases, so its scores are optimistic. Treat it as a check against regressions, not as an estimate of live accuracy.

## What the first replay taught us

- On Nov 2 the owner was answering both threads directly from 11:05 on. pclaw's updates told them what they'd just read. Whether they're already there is a fact, so code supplies it, and it matters more than anything d1 judges.
- T3 said `completed` for every turn, even ones ending on a real question, and pclaw's replies said "nothing pending" for several. Only the agent's last message tells these apart.
- d1-2B judged poorly when asked the whole question ("how should this reach them?"). It did well on small factual questions about the end of a message, combined by a few lines of code.

## Experiment log

| Date | Change | Why | Result |
|---|---|---|---|
| 2026-11-04 | First questions: one-step judgments over the full state | Starting point | State 36%, surface 69%, pings caught 0 of 9 |
| 2026-11-04 | Small factual questions on the last 1,200 characters, combined in `readTurn` with whether the owner is driving and whether the message repeats | d1 is built for simple reads | State 75%, surface 92%, pings caught 6 of 9 with none wrong (same cases as tuning) |
| 2026-11-04 | Added `fresh_check`, and tightened `job_size` so one-off checks and research stop reading as jobs | pclaw answered a question about pc1 from its notes, then a version check became a whole T3 thread | 25 sample messages: `fresh_check` 22, with the 3 misses on build work where it's ignored; job size 22, with the 3 misses simple questions read as research, now behind a higher threshold |
| 2026-11-04 | Kept workers, and started logging their runs next to jobs | Whether background T3 jobs can replace them should come from usage, not reasoning | Waiting on data |
| 2026-11-05 | Everything running in a channel gets a thread, with updates written by the front model and d1 as a hint (`milestone`) | The owner couldn't tell "nothing is happening" from "something is happening out of sight" | d1 on 62 windows of real tool activity: high on publishing and ledger status, but noisy. Dropped a `problem` question that fired on harmless commands |
