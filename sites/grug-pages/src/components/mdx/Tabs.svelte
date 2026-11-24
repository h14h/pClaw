<script lang="ts">
  import type { Snippet } from "svelte";

  export interface TabItem {
    id?: string;
    label: string;
    content?: string;
  }

  let {
    tabs = [],
    labels = [],
    defaultIndex = 0,
    children,
  }: {
    tabs?: TabItem[];
    labels?: string[];
    defaultIndex?: number;
    children?: Snippet;
  } = $props();

  let tabLabels = $derived(
    tabs.length > 0 ? tabs.map((t) => t.label) : labels
  );

  let active = $state(0);
  let initialized = $state(false);
  let panelsHost = $state<HTMLDivElement | null>(null);
  let buttonRefs = $state<Array<HTMLButtonElement | null>>([]);

  $effect(() => {
    if (!initialized && tabLabels.length > 0) {
      active = Math.max(0, Math.min(defaultIndex, tabLabels.length - 1));
      initialized = true;
    }
  });

  $effect(() => {
    if (!panelsHost || tabs.length > 0) return;
    // Astro wraps slotted children in an <astro-slot> element when hydrating islands.
    const container =
      panelsHost.children.length === 1 &&
      panelsHost.children[0].tagName.toLowerCase() === "astro-slot"
        ? panelsHost.children[0]
        : panelsHost;
    const panels = Array.from(container.children) as HTMLElement[];
    panels.forEach((panel, index) => {
      const isCurrent = index === active;
      panel.hidden = !isCurrent;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-hidden", String(!isCurrent));
    });
  });

  function onKeydown(event: KeyboardEvent, index: number) {
    const count = tabLabels.length;
    if (count === 0) return;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % count;
    else if (event.key === "ArrowLeft") next = (index - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;

    event.preventDefault();
    active = next;
    buttonRefs[next]?.focus();
  }
</script>

<div class="not-prose my-6">
  <div
    role="tablist"
    aria-label="Sections"
    class="flex items-center gap-1 overflow-x-auto border-b border-stone-950/10 pb-px text-base/6 sm:text-sm/5 dark:border-white/10"
  >
    {#each tabLabels as label, i}
      <button
        bind:this={buttonRefs[i]}
        type="button"
        role="tab"
        aria-selected={active === i}
        tabindex={active === i ? 0 : -1}
        onclick={() => (active = i)}
        onkeydown={(e) => onKeydown(e, i)}
        class={active === i
          ? "shrink-0 border-b-2 border-stone-900 px-3 py-2 text-stone-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:py-1.5 dark:border-stone-100 dark:text-stone-100 dark:focus-visible:outline-accent-dark"
          : "shrink-0 border-b-2 border-transparent px-3 py-2 text-stone-500 hover:text-stone-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:py-1.5 dark:text-stone-400 dark:hover:text-stone-200 dark:focus-visible:outline-accent-dark"}
      >
        {label}
      </button>
    {/each}
  </div>

  {#if tabs.length > 0}
    <div
      role="tabpanel"
      class="pt-4 text-base/7 text-pretty text-stone-800 dark:text-stone-300"
    >
      {#if tabs[active]?.content}
        <p class="whitespace-pre-line">{tabs[active].content}</p>
      {/if}
    </div>
  {:else if children}
    <div
      bind:this={panelsHost}
      class="prose pt-4"
    >
      {@render children()}
    </div>
  {/if}
</div>
