# Guidance templates

The decision model picks between the sections below, and pclaw shows the picks to the front model as advice inside `<guidance>`. The front model is free to ignore them. Edit a section and the next decision uses it. Keep the `## name` headings: the code looks them up by name.

## turn.finished
The agent reads as finished with what it was asked to do.

## turn.needs_owner
The agent reads as stopped on something only they can decide. If so, say what the decision is in a line or two, and give your pick if you have one.

## turn.procedural
This reads as a routine checkpoint, not a real decision. If you're confident, answer it yourself with `message_job` and don't bother them.

## turn.blocked
The agent reads as stuck on a failure or missing access. Say what's stuck, and fix it through `message_job` if you can.

## turn.still_going
The agent reads as mid-work with nothing to report yet.

## surface.ping
This looks worth interrupting them for. Call `ping_owner`, then write the message.

## surface.note
This looks worth a line they'd read later, but not an interruption. Write it without `ping_owner`, and it lands silently.

## surface.card
The status card already covers this. NO_REPLY is probably right.

## no_news
This is the same message as last time, so there's no news here.

## owner_driving
They've been talking to this agent directly, so they've already seen this.

## message.t3_job
This looks like work they'd want to open and steer: a T3 job (`start_job`).

## message.quick_worker
This looks like research or a lookup for `delegate`.

## message.fresh
This depends on how things are right now, so don't answer from memory or your notes. Look it up with `quick_search`, or `delegate` if it takes more digging.

## message.machine_check
This depends on how one of their machines is right now, so don't answer from memory or your notes. Check it with `start_job` and `background: true`.

## message.project
If this becomes a job, the likely project is {project} on {machine}.

## message.voice
This came in as a voice memo, so it may ramble. Read for what they keep coming back to and where they land at the end, more than any one word. A long memo can mix thinking out loud with real asks: pick out the asks, and treat the rest as context.

## message.thinking_aloud
This reads as thinking out loud, not a request. Think it through with them, and don't start work unless they ask.

## message.status
They seem to be asking how a job is going. Check it with `list_jobs` before answering, and never guess.

## message.steer
They seem to be redirecting the job's agent. Pass it on with `message_job`.

## message.too_loud
This sounds like you've been telling them too much. Save what you learned with `remember`, as a note about what's worth a ping and what isn't.

## message.too_quiet
This sounds like they wanted to hear sooner. Save what you learned with `remember`, as a note about what's worth a ping.

## caution
This may be hard to undo. It needs their explicit yes, whatever else this says.

## progress.milestone
This looks like a real step forward.

## progress.routine
This looks like more of the same.

## follow_up.wait
This may not be a good moment for this follow-up. Decide whether it's still worth sending now.
