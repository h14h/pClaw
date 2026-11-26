# Grug page editorial rules

The one source of truth for how a page reads. SKILL.md has the commands. `grug-page lint` checks the mechanical parts; `grug-page review` checks the rest against this file.

## Page anatomy, in order

Each block one job. Each block says something no other block says.

| Block | Job | Must NOT |
| --- | --- | --- |
| `title` | Name the topic and the place or thing. | Hold the verdict, a date, or a question. |
| `subtitle` | The verdict: what to do, and the main tradeoff. | Describe the page ("A guide to…"). Repeat the title. |
| Lead paragraph | What it is and how it works, in 2–4 sentences. First thing in the body. | Restate the subtitle. Sit below a photo, stats or table. |
| `<StatGrid>` (optional) | 2–4 numbers that decide it, each with a scope note. | Repeat the lead, the title, or a table column. Hold a number with no scope. |
| Opening `<Figure priority>` (optional) | The one photo that shows the thing, high on screen one. | Come before the lead. Be decoration. |
| Contents | Automatic. Nothing to write. | |
| `##` sections | Detail, one topic each, the photo next to what it shows. | Re-say a fact that already lives in the stats, table or another section. |
| Practical / decision section | Choices and what each one costs the reader. | Repeat advice already given in a section. |
| `<Sources>` | Where each fact came from, checked on one date. | List photo credits. Hide notes inside the link. |
| `summary` (frontmatter) | Share card text: route or subject, size, answer. Under 160 chars. | Say "this page", "see below". Need the page to make sense. |

## Each block adds something new

Before publishing, read subtitle, lead, summary, stats, table and section prose in order. Same fact twice: keep the best home, cut the other.

Norway examples:

- One-day bullet repeated leg 5's evening advice.
  - Before: "One day: time short, Bergen next. Keep the evening free in Bergen." (Leg 5 already said "Stay that night in Bergen.")
  - After: "One day: time short, Bergen next. Saves a hotel night, but Flåm shrinks to a connection." It now says what one day costs.
- Lead repeated the practical tips.
  - Before: "…Oslo to Bergen via Myrdal, Flåm, Gudvangen, Voss. Reverse, round trip also sold."
  - After: the lead ends at "Voss." Reverse and round trip live in "One day or overnight?".
- Table did two jobs.
  - Before: Leg / Mode / Time / What you see. Scenery crammed in cells, sideways scroll on phones.
  - After: `<Table compact>` with Leg / Mode / Time. Scenery moved into each leg's prose.
- Stats repeated the lead.
  - Before: Route "Oslo → Bergen", Legs "5", In one day, From price.
  - After: only the two numbers the lead and table don't give: time and price.

## Decision structure by page type

The reader acts on one or two decisions. Shape the page so each one is easy to check and act on.

- Buying comparison:
  - Put the qualifying configuration, the actionable total, and any sale expiry together, in the table row.
  - Give each criterion the reader asked about its own heading or consistently labeled entry, with the models in the same order every time.
  - Name the basis of any comparative judgment ("closest to paper, per Android Authority's review"). No basis: cut the judgment.
  - "Current" or "buy now": the maker's current lineup and generation, the reader's market, and the complete price.
- Itinerary:
  - Each day gets one default route and one default evening stop. No backtracking across town without saying why.
  - Name the dates the plan depends on (closures, timed slots, opening days).
  - Booking links and slot order go at the point of action, in the day that needs them.
- Any threshold that drives advice ("4+ rides: buy the day pass") holds at every rate the page lists, or the page says which rate it assumes.
- Use complete sentences whenever a fragment leaves the actor, action, or condition unclear.

## Claim precision

Most deductions came from here.

- Say what the source says, at the scope it says it. A "from" price across all routes is not this route's price. Fjord Tours' "From 2,698 NOK" was the cheapest of 32 routes; Oslo → Bergen one way was 3,131 NOK.
- Never upgrade hedged wording.
  - "Busiest season" is not "can sell out".
  - "One of the steepest with regular passenger service" is not "steepest standard-gauge".
  - "Older guides describe" is not "buses still stop there".
- Every number carries its scope and date: what it covers, which source, when checked. Put it in the stat's `note`, the table's caption sentence, or the same sentence.
- Durations and ranges: use the source's range ("about 6.5 to 7.5 hours, per Vy"), not a midpoint or a tighter range.
- A fact with no source you read today: cut it or mark it `<Callout type="warn" title="Not verified">`.
- Source notes list only what that source actually supports. Re-open the link before writing the note.
- `checked` on `<Sources>` is the day you last opened every link. Any "checked …" date on the page matches it.

## Images

- Each image sits right next to the section it shows.
- Captions stand alone; the viewer shows them without the page. No "next photo", no leg or slide numbers, no "above" or "below". Name the place or thing.
- One sentence, under 100 characters, one job: what to notice, or the fact it proves.
- Credit = creator, then source and license ("Vincent / Wikimedia Commons, CC BY-SA 4.0"), plus `href` to the original page. Never repeat photo credits in Sources.
- Carousel only when 3–6 views explain something one photo can't. At most 3 per page. A panorama or tall shot gets its own `<Figure>`.
- Transparent diagrams, maps and logos: `background="paper"`.
- The opening photo high on screen one gets `priority`. Only one.

## Components

- Table: one job, short cells, headings of 1–2 words (under 14 characters). The name goes in column 1 ("1. Oslo S → Myrdal"); no standalone Rank column. Summary tables go in `<Table compact>`.
- StatGrid: 2–4 stats, each with a `note` giving its scope.
- Opening stats: keep one only if it changes what the reader does, and only with a source or date in its note.
- Callout: at most 2–3, for real caveats (unverified, changed, risky). Never a copy of the prose.
- Details: secondary material (methodology, raw IDs, add-ons).
- Template components only. No page-local carousels, galleries, tabs or accordions.

## Voice

Terse, ultracave. Short sentences, no filler, no hype. Keep grammar wherever dropping it blurs meaning: "One of world's steepest" was marked down, "One of the world's steepest" was not. A fragment that can be read two ways gets its full sentence back.

## Self-check before build

Answer each yes or no. Any "no": fix it first.

1. Does the subtitle give the verdict, not describe the page?
2. Is the lead the first thing in the body, and does it say something the subtitle doesn't?
3. Does the summary stand alone as share card text, under 160 characters?
4. Does every stat have a scope note, and is each one a number the lead and table don't already give?
5. Does every number say what it covers, at the source's own scope (route, date, "from", range)?
6. Is every fact said once, in its best home?
7. Does each table do one job, with short cells and short headings?
8. Does every caption stand alone in under 100 characters, with creator, license and link in the credit?
9. Does each image sit next to the section it shows?
10. Does each Sources entry link only "Title, Publisher", with a plain note of what it supports, and does `checked` match the latest check on the page?
11. Does each decision follow its page type: comparison rows with configuration, total and expiry together; itinerary days with one route and one evening stop?
12. Read aloud: is any fragment unclear without its grammar?
