# Memory System Observations & Improvement Ideas

Captured 2026-02-27. Analysis of the current memory subsystem (`memory.go`) and its
suitability for the research interests described in the README (persistent personalization,
cultural intuition, worker-agent steering).

## What's Working Well

**Structured triples.** The `<subject_type> <subject> <descriptor>` format naturally clusters
facts per entity. `"discord user @henry is a Cubs fan"` will have high cosine similarity to
other queries about @henry, giving de-facto per-entity grouping without explicit metadata.

**Async record.** Fire-and-forget recording (`Async: true`) means memory writes never
interrupt conversational flow. Important for the organic feel — recording should be invisible.

**Auto-recall with summarization.** Injecting a condensed `[Memory]` section into every system
prompt means the bot passively benefits from accumulated knowledge. The summarization step
prevents context bloat. The per-turn cache avoids redundant vector searches during multi-step
tool loops.

**Shared memory across Discord sessions.** All users share one collection. This is a feature
for the research — the bot builds a *collective* model of the community, not siloed per-user
profiles. Closer to how cultural knowledge actually works in organizations.

## Known Weaknesses

### 1. No deduplication or contradiction resolution

The model will record `"@henry likes Go"` every time the topic comes up. Over weeks this
produces dozens of near-duplicates cluttering search results, and eventually contradictions
(`"@henry is frustrated with Go"`) with no mechanism to resolve them. The vector store doesn't
know that two items describe the same fact.

**Likely consequence:** Memory "feels" less intelligent over time because it surfaces
stale/conflicting information. This is a probable source of the degradation the research
interests mention.

### 2. Auto-recall query is just the raw user message

When @henry says `"yeah, me too"`, the search query is literally `"yeah, me too"`. That won't
surface anything useful. The recall system has no awareness of *who* is speaking or what the
broader conversation context is.

**Likely consequence:** The bot "forgets" about people during casual conversation — exactly the
moments where cultural memory matters most.

### 3. No distinction between fact types

`"@henry is a Cubs fan"` and `"@henry gets frustrated when things are over-explained"` are
stored and retrieved identically. But for the cultural intuition hypothesis, these are
fundamentally different. The first is trivia. The second is a behavioral pattern that should
influence how the agent communicates.

### 4. No memory consolidation or reflection

Humans don't remember individual interactions — they form impressions and mental models. The
bot accumulates atomic facts but never synthesizes them. After 1000 interactions with @henry,
it has 200 individual facts but no coherent "model of henry" that could inform nuanced
judgment.

## Improvement Ideas

### A. User-contextual auto-recall

Prepend the speaker's identity to the auto-recall search query. Instead of searching for
`"what's the best framework?"`, search for `"@henry: what's the best framework?"`. This biases
results toward @henry's stored preferences and patterns.

Implementation: small change in `main.go` around the query extraction in `withSystemPrompt` —
thread the Discord username through to where the query is built.

### B. Tiered memory categories

Extend `RecordInput` with a `category` field:

- **`fact`**: `"@henry is a Cubs fan"` — biographical trivia
- **`preference`**: `"@henry prefers terse explanations"` — communication style signals
- **`pattern`**: `"@henry asks for clarification before starting tasks"` — behavioral observations
- **`norm`**: `"the team values working code over perfect architecture"` — shared cultural beliefs

Auto-recall could weight these differently. Facts are nice-to-have; preferences shape tone;
patterns and norms shape *judgment*. For the worker-agent steering use case, `norm` and
`pattern` are the categories that encode cultural intuition.

### C. Periodic memory consolidation

A background job (or callable tool) that reviews all memories about a subject and produces a
synthesis:

> **@henry profile**: Backend developer, prefers Go, values correctness over speed, gets
> frustrated with verbose explanations, tends to ask clarifying questions before starting
> work. Communication style: direct, dislikes hand-holding. Active ~3 months.

Store as a special high-priority memory item. On auto-recall, surface the profile *before*
individual facts. Analogous to how humans maintain a "mental model" of colleagues.

This is probably the highest-impact change for the cultural intuition hypothesis. A
consolidated profile turns 200 atomic facts into something resembling understanding.

### D. Decision attribution / observability

When the bot makes a choice influenced by memory (e.g., giving @henry a terse answer because
it knows he dislikes verbosity), log which memory items were active alongside the response.
Over time, correlate memory-influenced responses with user satisfaction signals (Discord
reactions, continued engagement, etc.).

This provides actual data on whether cultural memory improves or degrades performance.

### E. Deduplication at write time

Before storing via `record`, search for existing items with high similarity to the candidate
fact. If a near-duplicate exists, skip the write (or update/replace the existing item). This
keeps the memory store clean as facts are re-observed over time.

### F. Reaction-based feedback signal

Map Discord reactions on bot messages to a quality signal. A thumbs-up on a response where
memory was active is evidence that memory helped; a thumbs-down is evidence it hurt. Over time
this becomes ground truth for evaluating the research hypotheses.

## The Worker-Agent Steering Architecture

If the research bears out, the path from "chatbot with memory" to "agent with judgment" would
look roughly like:

1. **Chatbot** accumulates `norm` and `pattern` memories through Discord interactions
2. A **consolidation pass** produces team/project-level cultural summaries
3. **Worker agents** receive these summaries as a `[Cultural Context]` prompt section
4. When a worker agent gets an ambiguous instruction, the cultural context informs its
   interpretation without the human needing to spell out every implicit expectation

The vector store already supports this — a second collection (or category-filtered queries)
could serve as the cultural knowledge base for worker agents.

## Suggested Priority Order

If picking these up later, in order of impact-to-effort ratio:

1. **User-contextual auto-recall** (idea A) — small change, big personalization impact
2. **Deduplication** (idea E) — prevents the most likely degradation path
3. **Memory categories** (idea B) — enables later analysis of which memory types matter
4. **Consolidation** (idea C) — the key unlock for cultural intuition
5. **Feedback signal** (idea F) — ground truth for evaluating the hypotheses
6. **Decision attribution** (idea D) — deeper observability, lower urgency
