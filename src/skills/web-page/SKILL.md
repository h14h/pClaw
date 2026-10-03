---
name: web-page
description: Build a simple web page from pclaw's standard template and publish it to the person's private address. Use when the job asks for a page, a site, something they can open, keep, or share on their own devices (an itinerary, a comparison, a report, a checklist, a small tool).
---

# Making a web page

Pages are static: one `index.html`, the template's `style.css`, its fonts, and at most a little inline JavaScript. No build step, no frameworks, no requests to anything outside the page's own folder. They're private to the person's devices.

## Steps

1. Pick a slug: short, lowercase, words joined with hyphens (`chicago-trip`, `nas-cases`). Reuse the existing slug when you're updating a page.
2. Copy the template into your working directory: `mkdir -p pages && cp -r <this skill's directory>/template pages/<slug>`. Skip this when updating; edit the page in place.
3. Read `STYLE.md` in this skill's directory before writing anything, and follow it. Build the page by editing `pages/<slug>/index.html` with the template's patterns. Leave `style.css` and `fonts/` as they are; if you truly need a page-specific rule, put a small `<style>` block in the page.
4. Remove whatever the page doesn't use from the template's example sections. Nothing from the template's placeholder text should survive.
5. Call `publish_page` with the slug. It checks the page and returns its address. If it reports a problem, fix it and call it again.
6. Put the address in your report, with one line on what the page shows.

## What's on the page has to be true

The same rules as your report apply to everything on a page, and they matter more here because a page gets kept and looked at later.

- Every fact, price, date, spec, and link comes from a source you read during this job.
- Each price and date says when you checked it.
- Anything you couldn't confirm is marked as unconfirmed on the page itself, using the template's caveat pattern. Don't leave a gap looking settled.
- List the sources at the bottom, as the template does.

## Don't

- Load anything from the internet: no CDNs, web fonts, scripts, images by URL, or analytics. `publish_page` refuses pages that do.
- Put anything private in a page that the person wouldn't want on a screen others might see (account numbers, addresses, health details) unless the job is explicitly about that.
- Add forms that send data anywhere, logins, or tracking.
