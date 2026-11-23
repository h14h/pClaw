# Guidance templates

Decision model picks from sections below. Runtime passes picks to front model inside `<guidance>`. Front model may ignore them. Edit section and next decision uses it. Keep `## name` headings verbatim: code looks them up by name.

## turn.finished
Agent reads as finished with requested work.

## turn.needs_owner
Agent reads as stopped on decision only user can make. State decision in one or two lines. Give your pick if you have one.

## turn.procedural
Reads as routine checkpoint, not real decision. Confident? Answer yourself with `message_job`. Do not bother user.

## turn.blocked
Agent reads as stuck on failure or missing access. Say what is stuck. Fix through `message_job` if you can.

## turn.still_going
Agent reads as mid-work with nothing to report yet.

## surface.ping
Worth interrupting user. Call `ping_owner`, then write message.

## surface.note
Worth one line user reads later, not an interruption. Write without `ping_owner` so it lands silently.

## surface.card
Status card already covers this. NO_REPLY likely right.

## no_news
Same message as last time. No news here.

## owner_driving
User talks to this agent directly, so user already saw this.

## message.t3_job
Looks like work user wants to open and steer: T3 job (`start_job`).

## message.quick_worker
Looks like research or lookup for `delegate`.

## message.fresh
Depends on state right now. Do not answer from memory or notes. Look up with `quick_search`, or `delegate` if deeper digging needed.

## message.machine_check
Depends on one of user's machines right now. Do not answer from memory or notes. Check with `start_job` and `background: true`.

## message.project
If this becomes a job, likely project is {project} on {machine}.

## message.voice
Arrived as voice memo, so it may ramble. Read for what user returns to and where user lands at end, more than single words. Long memo can mix thinking aloud with real asks. Pick out asks; treat rest as context.

## message.thinking_aloud
Reads as thinking aloud, not a request. Think through with user. Do not start work unless user asks.

## message.status
User seems to ask job status. Check with `list_jobs` before answering. Never guess.

## message.steer
User seems to redirect job's agent. Pass along with `message_job`.

## worker.steer
Reads as change to what {worker} already does. Steer live with `message_worker` (default steer mode), not new `delegate` and not queued follow-up. Write terse 3–5 word ack like "On it, widening scope."

## worker.status
User seems to ask how {worker} is going. Check `list_workers` before answering. Never guess. Answer as yourself in one or two lines.

## worker.side_chat
Reads as side topic while {worker} runs. Answer on its own. Leave running work alone.

## worker.new_work
Reads as separate new task, not change to {worker}. Start on its own. Leave running work alone.

## message.too_loud
Sounds like you told user too much. Save lesson with `remember` as note on what is worth a ping and what is not.

## message.too_quiet
Sounds like user wanted to hear sooner. Save lesson with `remember` as note on what is worth a ping.

## caution
May be hard to undo. Needs user's explicit yes, whatever else this says.

## progress.milestone
Looks like real step forward.

## progress.routine
Looks like more of same.

## follow_up.wait
May not be good moment for this follow-up. Decide if still worth sending now.
