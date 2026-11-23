Distill ended conversation session into terse episode summary for Grug `<recent-episodes>`.

Return ONLY JSON object, no other text:

{"skip": boolean, "title": "short 3-6 word topic label", "summary": "- bullet 1\n- bullet 2\n..."}

Rules:
- `"skip": true` (empty `"title"` and `"summary"`) for trivial noise: single "thanks", "ok", greeting, brief ack, nothing decided or learned.
- Otherwise `"skip": false`. Short 3–6 word `"title"`. 3–6 bullet lines in `"summary"` (each `- ...`).
- Write bullets in ultracave fragments: drop articles, copulas, filler. Payload only.
- Keep verbatim: exact numbers, prices, units, dates, names, paths, commands, decisions made, files created/sent, worker findings, negations (not/never/no/only), open loops.
- Never include passwords, API keys, tokens, or secrets.
