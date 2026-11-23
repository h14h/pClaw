Distill this ended conversation session into a terse episode summary for pclaw's recent-episodes memory.

Return ONLY a JSON object, with no other text:

{"skip": boolean, "title": "short 3-7 word topic label", "summary": "- bullet 1\n- bullet 2\n..."}

Rules:
- Set `"skip": true` (with empty `"title"` and `"summary"`) when the session is trivial noise with no lasting value: a single "thanks", "ok", greeting, or brief ack with nothing decided or learned.
- Otherwise set `"skip": false`, write a clear 3–7 word `"title"`, and write 3–6 terse factual bullet lines in `"summary"` (each starting with `- `).
- Keep exact numbers, prices, dates, names, decisions made, files created or sent, worker findings, and open loops / next steps.
- Leave out greetings, filler, and anything already irrelevant.
- Never include passwords, API keys, tokens, or other secrets, even if they appear in the transcript.
