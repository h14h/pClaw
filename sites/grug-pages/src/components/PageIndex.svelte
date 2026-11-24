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

  let query = $state("");
  let activeTag = $state<string | null>(null);

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

{#if pages.length === 0}
  <div class="mt-8 border-t border-stone-950/8 pt-8 dark:border-white/8">
    <p class="text-base/7 text-pretty text-stone-600 dark:text-zinc-400">
      No pages yet. Ask Grug for a report, comparison, guide, or interactive tool and it will appear here.
    </p>
  </div>
{:else}
  <div class="mt-6 flex flex-col gap-3">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="relative min-w-0 flex-1 sm:max-w-xs">
        <input
          type="search"
          name="page-search"
          aria-label="Filter pages"
          placeholder="Filter pages..."
          bind:value={query}
          class="w-full rounded-lg bg-white px-3 py-2 text-base/6 text-stone-900 ring-1 ring-stone-950/10 shadow-2xs placeholder:text-stone-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent sm:py-1.5 sm:text-sm/6 dark:bg-obsidian-raised dark:text-zinc-100 dark:ring-white/10 dark:shadow-none dark:placeholder:text-zinc-500 dark:focus-visible:outline-accent-dark"
        />
      </div>
      <p class="shrink-0 text-base/6 tabular-nums text-stone-500 sm:text-sm/5 dark:text-zinc-400">
        {#if query.trim() || activeTag}
          {filtered.length} of {pages.length} {pages.length === 1 ? "page" : "pages"}
        {:else}
          {pages.length} {pages.length === 1 ? "page" : "pages"}
        {/if}
      </p>
    </div>

    {#if allTags.length > 0}
      <div
        role="group"
        aria-label="Filter by tag"
        class="flex items-center gap-1.5 overflow-x-auto pb-1 text-base/6 sm:text-sm/5"
      >
        <button
          type="button"
          onclick={() => (activeTag = null)}
          aria-pressed={activeTag === null}
          class={activeTag === null
            ? "shrink-0 rounded-md bg-stone-950/10 px-2.5 py-1.5 text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:py-1 dark:bg-white/12 dark:text-zinc-100 dark:focus-visible:outline-accent-dark"
            : "shrink-0 rounded-md px-2.5 py-1.5 text-stone-600 hover:bg-stone-950/5 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:py-1 dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-zinc-200 dark:focus-visible:outline-accent-dark"}
        >
          All
        </button>
        {#each allTags as tag}
          <button
            type="button"
            onclick={() => (activeTag = activeTag === tag ? null : tag)}
            aria-pressed={activeTag === tag}
            class={activeTag === tag
              ? "shrink-0 rounded-md bg-stone-950/10 px-2.5 py-1.5 text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:py-1 dark:bg-white/12 dark:text-zinc-100 dark:focus-visible:outline-accent-dark"
              : "shrink-0 rounded-md px-2.5 py-1.5 text-stone-600 hover:bg-stone-950/5 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:py-1 dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-zinc-200 dark:focus-visible:outline-accent-dark"}
          >
            {tag}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if filtered.length === 0}
    <div class="mt-6 border-t border-stone-950/8 pt-8 dark:border-white/8">
      <p class="text-base/7 text-stone-600 dark:text-zinc-400">
        No pages match your filter.
      </p>
      <button
        type="button"
        onclick={clearFilters}
        class="mt-3 rounded-md bg-stone-950/6 px-3 py-1.5 text-sm/5 text-stone-800 hover:bg-stone-950/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:bg-white/8 dark:text-zinc-200 dark:hover:bg-white/12 dark:focus-visible:outline-accent-dark"
      >
        Clear filter
      </button>
    </div>
  {:else}
    <ul role="list" class="mt-6 divide-y divide-stone-950/8 border-t border-stone-950/8 dark:divide-white/8 dark:border-white/8">
      {#each filtered as page (page.slug)}
        <li class="py-5">
          <div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
            <h2 class="min-w-0 text-lg/7 font-medium text-pretty text-stone-900 sm:text-base/6 dark:text-zinc-100">
              <a
                href={page.href}
                class="hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:hover:text-accent-dark dark:focus-visible:outline-accent-dark"
              >
                {page.title}
              </a>
            </h2>
            <time
              datetime={page.date}
              class="shrink-0 text-sm/5 tabular-nums text-stone-500 dark:text-zinc-400"
            >
              {page.formattedDate}
            </time>
          </div>
          <p class="mt-1.5 text-base/7 text-pretty text-stone-600 sm:text-sm/6 dark:text-zinc-400">
            {page.summary}
          </p>
          {#if page.tags.length > 0}
            <ul role="list" class="mt-2.5 flex flex-wrap items-center gap-1.5 text-sm/5">
              {#each page.tags as tag}
                <li class="rounded-md bg-stone-950/5 px-2 py-0.5 text-stone-600 dark:bg-white/6 dark:text-zinc-400">
                  {tag}
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/if}
