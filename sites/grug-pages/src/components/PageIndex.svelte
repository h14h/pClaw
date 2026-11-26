<script lang="ts">
  export interface PageListItem {
    slug: string;
    title: string;
    subtitle?: string;
    date: string;
    formattedDate: string;
    updated?: string;
    summary: string;
    tags: string[];
    href: string;
  }

  let { pages = [] }: { pages: PageListItem[] } = $props();

  // Share links the pages server filled in on the owner's address (slug → /p/<token>/). Empty when built or
  // previewed, which keeps each row's copy button hidden.
  const shareUrls: Record<string, string> = (() => {
    if (typeof document === "undefined") return {};
    try {
      return JSON.parse(document.querySelector("script[data-share-links]")?.textContent || "{}");
    } catch {
      return {};
    }
  })();

  let query = $state("");
  let activeTag = $state<string | null>(null);
  let mobileTagsOpen = $state(false);

  let allTags = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const page of pages) {
      for (const tag of page.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.keys()].sort((a, b) => a.localeCompare(b));
  });

  let filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return pages.filter((page) => {
      if (activeTag && !page.tags.includes(activeTag)) return false;
      if (!q) return true;
      return (
        page.title.toLowerCase().includes(q) ||
        page.summary.toLowerCase().includes(q) ||
        (page.subtitle?.toLowerCase().includes(q) ?? false) ||
        page.tags.some((t) => t.toLowerCase().includes(q)) ||
        page.slug.toLowerCase().includes(q)
      );
    });
  });

  function clearFilters() {
    query = "";
    activeTag = null;
  }
</script>

<header>
  <div class="flex items-baseline justify-between gap-4">
    <h1 class="text-2xl font-semibold tracking-tight text-pretty text-stone-900 sm:text-3xl dark:text-stone-100">
      Pages
    </h1>
    {#if pages.length > 0}
      <p class="shrink-0 text-base/6 tabular-nums text-stone-500 sm:text-sm/5 dark:text-stone-400">
        {#if query.trim() || activeTag}
          {filtered.length} of {pages.length} {pages.length === 1 ? "page" : "pages"}
        {:else}
          {pages.length} {pages.length === 1 ? "page" : "pages"}
        {/if}
      </p>
    {/if}
  </div>
  <p class="mt-2 text-base/7 text-pretty text-stone-600 dark:text-stone-400">
    Research reports, comparisons, guides, and interactive tools.
  </p>
</header>

{#if pages.length === 0}
  <div class="mt-8 border-t border-stone-950/8 pt-8 dark:border-white/8">
    <p class="text-base/7 text-pretty text-stone-600 dark:text-stone-400">
      No pages yet. Ask Grug for a report, comparison, guide, or interactive tool and it will appear here.
    </p>
  </div>
{:else}
  <div class="mt-6 flex flex-col gap-3">
    <div class="relative min-w-0 sm:max-w-xs">
      <input
        type="search"
        name="page-search"
        aria-label="Filter pages"
        placeholder="Filter pages..."
        bind:value={query}
        class="min-h-12 w-full rounded-lg bg-white px-3 py-2.5 text-base/6 text-stone-900 ring-1 ring-stone-950/10 shadow-2xs placeholder:text-stone-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent sm:min-h-0 sm:py-1.5 sm:text-sm/6 dark:bg-obsidian-raised dark:text-stone-100 dark:ring-white/10 dark:shadow-none dark:placeholder:text-stone-500 dark:focus-visible:outline-accent-dark"
      />
    </div>

    {#if allTags.length > 0}
      <!-- Mobile: compact disclosure button + cleanly wrapped tag panel (zero clipping) -->
      <div class="sm:hidden">
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={() => (mobileTagsOpen = !mobileTagsOpen)}
            aria-expanded={mobileTagsOpen}
            aria-controls="mobile-tag-panel"
            class="flex min-h-12 flex-1 items-center justify-between gap-2 rounded-lg bg-white px-3 py-2.5 text-base/6 text-stone-700 ring-1 ring-stone-950/10 shadow-2xs hover:text-stone-900 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent dark:bg-obsidian-raised dark:text-stone-200 dark:ring-white/10 dark:shadow-none dark:hover:text-stone-100 dark:focus-visible:outline-accent-dark"
          >
            <span class="flex min-w-0 items-center gap-2 truncate">
              {#if activeTag}
                <span class="text-stone-500 dark:text-stone-400">Tag:</span>
                <span class="truncate font-medium text-stone-900 dark:text-stone-100">{activeTag}</span>
              {:else}
                <span class="font-medium text-stone-800 dark:text-stone-200">Tags</span>
                <span class="tabular-nums text-stone-500 dark:text-stone-400">({allTags.length})</span>
              {/if}
            </span>
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              class={`size-4 shrink-0 fill-stone-500 motion-safe:transition-transform motion-safe:duration-150 dark:fill-stone-400 ${mobileTagsOpen ? "rotate-180" : ""}`}
            >
              <path
                fill-rule="evenodd"
                d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
                clip-rule="evenodd"
              />
            </svg>
          </button>

          {#if activeTag}
            <button
              type="button"
              onclick={() => (activeTag = null)}
              aria-label={`Clear tag filter ${activeTag}`}
              class="inline-flex min-h-12 shrink-0 items-center justify-center rounded-lg bg-stone-950/6 px-3.5 text-base/6 font-medium text-stone-700 hover:bg-stone-950/10 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:bg-white/8 dark:text-stone-200 dark:hover:bg-white/12 dark:hover:text-stone-100 dark:focus-visible:outline-accent-dark"
            >
              Clear
            </button>
          {/if}
        </div>

        {#if mobileTagsOpen}
          <div
            id="mobile-tag-panel"
            role="group"
            aria-label="Filter by tag"
            class="mt-2.5 flex flex-wrap gap-2 rounded-lg bg-paper-subtle/70 p-2.5 ring-1 ring-stone-950/8 dark:bg-obsidian-raised/70 dark:ring-white/8"
          >
            <button
              type="button"
              onclick={() => (activeTag = null)}
              aria-pressed={activeTag === null}
              class={activeTag === null
                ? "inline-flex min-h-12 items-center rounded-md bg-stone-950/12 px-3.5 py-2 text-base/6 font-medium text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:bg-white/15 dark:text-stone-100 dark:focus-visible:outline-accent-dark"
                : "inline-flex min-h-12 items-center rounded-md bg-white/85 px-3.5 py-2 text-base/6 text-stone-700 ring-1 ring-stone-950/8 hover:bg-stone-950/5 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:bg-obsidian dark:text-stone-300 dark:ring-white/10 dark:hover:bg-white/8 dark:hover:text-stone-100 dark:focus-visible:outline-accent-dark"}
            >
              All
            </button>
            {#each allTags as tag}
              <button
                type="button"
                onclick={() => (activeTag = activeTag === tag ? null : tag)}
                aria-pressed={activeTag === tag}
                class={activeTag === tag
                  ? "inline-flex min-h-12 items-center rounded-md bg-stone-950/12 px-3.5 py-2 text-base/6 font-medium text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:bg-white/15 dark:text-stone-100 dark:focus-visible:outline-accent-dark"
                  : "inline-flex min-h-12 items-center rounded-md bg-white/85 px-3.5 py-2 text-base/6 text-stone-700 ring-1 ring-stone-950/8 hover:bg-stone-950/5 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:bg-obsidian dark:text-stone-300 dark:ring-white/10 dark:hover:bg-white/8 dark:hover:text-stone-100 dark:focus-visible:outline-accent-dark"}
              >
                {tag}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Desktop: full wrapped tag bar -->
      <div
        role="group"
        aria-label="Filter by tag"
        class="hidden items-center gap-1.5 text-sm/5 sm:flex sm:flex-wrap"
      >
        <button
          type="button"
          onclick={() => (activeTag = null)}
          aria-pressed={activeTag === null}
          class={activeTag === null
            ? "shrink-0 rounded-md bg-stone-950/10 px-2.5 py-1 text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:bg-white/12 dark:text-stone-100 dark:focus-visible:outline-accent-dark"
            : "shrink-0 rounded-md px-2.5 py-1 text-stone-600 hover:bg-stone-950/5 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:text-stone-400 dark:hover:bg-white/6 dark:hover:text-stone-200 dark:focus-visible:outline-accent-dark"}
        >
          All
        </button>
        {#each allTags as tag}
          <button
            type="button"
            onclick={() => (activeTag = activeTag === tag ? null : tag)}
            aria-pressed={activeTag === tag}
            class={activeTag === tag
              ? "shrink-0 rounded-md bg-stone-950/10 px-2.5 py-1 text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:bg-white/12 dark:text-stone-100 dark:focus-visible:outline-accent-dark"
              : "shrink-0 rounded-md px-2.5 py-1 text-stone-600 hover:bg-stone-950/5 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:text-stone-400 dark:hover:bg-white/6 dark:hover:text-stone-200 dark:focus-visible:outline-accent-dark"}
          >
            {tag}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if filtered.length === 0}
    <div class="mt-6 border-t border-stone-950/8 pt-8 dark:border-white/8">
      <p class="text-base/7 text-stone-600 dark:text-stone-400">
        No pages match your filter.
      </p>
      <button
        type="button"
        onclick={clearFilters}
        class="mt-3 rounded-md bg-stone-950/6 px-3 py-1.5 text-base/6 text-stone-800 hover:bg-stone-950/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:text-sm/5 dark:bg-white/8 dark:text-stone-200 dark:hover:bg-white/12 dark:focus-visible:outline-accent-dark"
      >
        Clear filter
      </button>
    </div>
  {:else}
    <ul role="list" class="mt-6 divide-y divide-stone-950/8 border-t border-stone-950/8 dark:divide-white/8 dark:border-white/8">
      {#each filtered as page (page.slug)}
        <li class="py-5">
          <div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
            <h2 class="min-w-0 text-lg/7 font-medium text-pretty text-stone-900 sm:text-base/6 dark:text-stone-100">
              <a
                href={page.href}
                class="hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:hover:text-accent-dark dark:focus-visible:outline-accent-dark"
              >
                {page.title}
              </a>
            </h2>
            <time
              datetime={page.date}
              class="shrink-0 text-base/6 tabular-nums text-stone-500 sm:text-sm/5 dark:text-stone-400"
            >
              {page.formattedDate}
            </time>
          </div>
          <p class="mt-1.5 text-base/7 text-pretty text-stone-600 sm:text-sm/6 dark:text-stone-400">
            {page.summary}
          </p>
          <div class="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            {#if page.tags.length > 0}
              <p class="min-w-0 text-base/6 [overflow-wrap:anywhere] text-stone-500 sm:text-sm/5 dark:text-stone-400">
                {#each page.tags as tag, index}
                  {#if index > 0}<span aria-hidden="true" class="mx-1.5 text-stone-300 dark:text-stone-700">&middot;</span>{/if}<span>{tag}</span>
                {/each}
              </p>
            {/if}
            <a
              href={shareUrls[page.slug] ?? "#share-link"}
              hidden={!shareUrls[page.slug]}
              data-share-copy={page.slug}
              aria-label={`Copy share link for ${page.title}`}
              class="share-copy ml-auto inline-flex items-center gap-1.5 rounded-md py-1 text-sm/5 text-stone-500 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-12 dark:text-stone-400 dark:hover:text-stone-100 dark:focus-visible:outline-accent-dark"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" class="share-copy-icon size-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.6.6M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.6-.6" />
              </svg>
              <svg viewBox="0 0 16 16" aria-hidden="true" class="share-copy-done size-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
              <span class="share-copy-label" aria-hidden="true">
                <span class="share-copy-idle">Copy link</span>
                <span class="share-copy-copied">Copied</span>
              </span>
            </a>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
