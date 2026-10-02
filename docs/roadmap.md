# Roadmap

pclaw is for one person first. Once it's something I rely on every day and it feels about as good as Instinct, the focus moves to making it easy for other people to install.

Each step should be usable on its own before the next one starts.

## 1. Text it on Discord (done)

DMs with one owner, the voice prompt, notes, self-scheduled follow-ups, images in. A fast front model (Grok 4.5, medium) talks; pi workers (Grok 4.7, high) do the work and report back. Runs on Pi Durable with SQLite, signed in through a SuperGrok subscription.

## 1.5. Better workers

- Claude Code and Codex as workers, chosen per job.
- Progress from long jobs, so the front model can answer "how's it going?" without guessing. pi's JSON mode has the events.
- Approval as a real gate instead of an instruction. Today the workers' brief says to stop before outward-facing actions, but a worker with a shell could ignore it. The browser and vault tools below should enforce it in code.
- Replay turns from the exported Instinct thread against the front model, to catch voice regressions when the prompt or model changes.

## 2. A real browser

This is the big one. Most of what makes Instinct useful (checking an account, comparing prices, filling out a form) comes down to driving a browser.

- One Chromium profile on the host, kept between runs, so sites you log into stay logged in.
- These are worker tools. The front model stays fast and tool-light.
- Tools that read the page as an accessibility snapshot and act on it (click, type, select, scroll), plus screenshots when the snapshot isn't enough.
- An approval step for anything that submits, sends, or pays. The tool pauses, pclaw describes exactly what it's about to do in Discord, and it continues only on a yes. Discord buttons would be nicer than typing "yes".

## 3. Gmail and Google Sheets

Inbox triage (summarize, label, archive, draft replies) and invoices generated into a Sheets template. Reading and drafting run freely. Sending needs a yes.

## 4. Budgeting with Monarch

Monarch has no official API. Start with the browser, then decide whether its unofficial API is worth depending on.

## 5. Passwords and payments

The goal is letting pclaw log in and buy things without the model ever seeing a secret.

- A vault (1Password service account or Bitwarden) limited to a folder of items pclaw is allowed to use. Tools fill credentials straight into the browser, so passwords never enter the model's context.
- Payments through single-use or merchant-locked virtual cards with spending limits, so the worst case is capped by the card, not by the model's judgment.
- Every purchase needs an explicit yes, showing the merchant, item, and total.

## 6. Group chats and separate contexts

Conversations are already keyed by address (`discord:dm:<user>`), so a server channel or thread can get its own conversation and history. Needs mention-gating in shared channels, the Message Content intent, and a decision about which notes are shared across contexts.

## Later

- Proactive check-ins that aren't tied to a specific follow-up, if they can be done without becoming noise.
- Voice notes in and out.
- A one-line install for people who aren't me.
