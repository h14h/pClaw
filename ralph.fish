#!/usr/bin/env fish

argparse 'codex' 'claude' -- $argv
or begin
    echo "Usage: ralph.fish [--codex | --claude]"
    exit 1
end

if set -q _flag_codex; and set -q _flag_claude
    echo "Error: --codex and --claude are mutually exclusive."
    exit 1
end

# Default to claude when no flag is provided
if set -q _flag_codex
    set backend codex
else
    set backend claude
end

echo "Using backend: $backend"

set -l start_ts (date +%s%N)

while test -e IMPLEMENTATION_PLAN.md
    if not test -f PROMPT.md
        echo "PROMPT.md not found; exiting loop."
        break
    end

    set -l prompt_text (string collect < PROMPT.md)

    switch $backend
        case codex
            codex exec -m gpt-5.3-codex "$prompt_text"
        case claude
            claude -p --model claude-sonnet-4-6 "$prompt_text"
    end
end

set -l end_ts (date +%s%N)
set -l elapsed_seconds (math -s 3 "($end_ts - $start_ts) / 1000000000.0")
echo "Total elapsed time: $elapsed_seconds seconds"

echo "I'm Learnding!"
