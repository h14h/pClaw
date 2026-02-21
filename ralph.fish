#!/usr/bin/env fish

set -l start_ts (date +%s%N)

while test -e IMPLEMENTATION_PLAN.md
    if not test -f PROMPT.md
        echo "PROMPT.md not found; exiting loop."
        break
    end

    set -l prompt_text (string collect < PROMPT.md)
    codex exec "$prompt_text"
end

set -l end_ts (date +%s%N)
set -l elapsed_seconds (math -s 3 "($end_ts - $start_ts) / 1000000000.0")
echo "Total elapsed time: $elapsed_seconds seconds"

echo "I'm Learnding!"
