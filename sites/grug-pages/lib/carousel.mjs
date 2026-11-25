// Shared by <Carousel> (src/components/mdx/Carousel.astro), the grug-page CLI lint, and the tests.

/** Slides past this many stop being browsable on a phone; split the set or cut it. */
export const CAROUSEL_MAX_SLIDES = 8;
/** Carousels past this many per page turn a guide into a photo album. */
export const CAROUSEL_MAX_PER_PAGE = 3;
/** An image within this share of the frame's ratio fills the frame (crops at most ~5% a side); others show whole. */
export const CAROUSEL_FIT_TOLERANCE = 0.1;
/** How much of the next slide shows at the right edge, so the strip reads as swipeable. Matches the CSS. */
export const CAROUSEL_PEEK_REM = 3;

// The text column, as in Figure.astro: 44rem from 48rem up, 32px gutters from 40rem, 20px gutters below.
const COLUMN = [
  ["(min-width: 48rem) ", "44rem"],
  ["(min-width: 40rem) ", "100vw - 4rem"],
  ["", "100vw - 2.5rem"],
];

const FIGURE_RE = /<figure\b[^>]*>[\s\S]*?<\/figure>/g;

function round(n, digits = 4) {
  return Number(n.toFixed(digits));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One frame ratio for the whole strip, so slides never change its height: the median image shape, kept between
 * portrait 3:4 and 16:9 so a single panorama or tall shot can't flatten or stretch the rest.
 */
export function carouselFrame(ratios) {
  return round(Math.min(16 / 9, Math.max(3 / 4, median(ratios))));
}

/**
 * `sizes` for one slide: the slide is the column minus the peek, capped like a portrait Figure (65vh, 34rem tall),
 * and the image covers `scale` of the slide's width (under 1 when it sits inside the frame, over 1 when it fills it).
 */
export function slideSizes(frame, scale, { eager = false } = {}) {
  const k = round(scale);
  const cap = (n) => `${round(n * frame * k, 2)}`;
  const slots = COLUMN.map(([media, column]) => {
    const width = k === 1 ? `calc(${column} - ${CAROUSEL_PEEK_REM}rem)` : `calc((${column} - ${CAROUSEL_PEEK_REM}rem) * ${k})`;
    return `${media}min(${width}, ${cap(34)}rem, ${cap(65)}vh)`;
  });
  // `auto` is only valid on lazy images.
  return (eager ? slots : ["auto", ...slots]).join(", ");
}

/**
 * Turn the rendered children of a <Carousel> into slides. Children must be <Figure>s; anything else is an authoring
 * mistake and fails the build. One Figure comes back untouched, to render as a plain Figure.
 */
export function buildCarousel(html) {
  const figures = html.match(FIGURE_RE) ?? [];
  const stray = html.replace(FIGURE_RE, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (stray) {
    throw new Error(`<Carousel> takes only <Figure> children. Move this out of the carousel: ${stray.slice(0, 120)}`);
  }
  if (figures.length === 0) {
    throw new Error("<Carousel> needs at least one <Figure> inside it.");
  }
  if (figures.length === 1) return { kind: "single", html: figures[0] };

  const ratios = figures.map((figure) => {
    const img = /<img\b[^>]*>/.exec(figure)?.[0] ?? "";
    const width = Number(/\swidth="(\d+)"/.exec(img)?.[1]);
    const height = Number(/\sheight="(\d+)"/.exec(img)?.[1]);
    if (!width || !height) throw new Error("<Carousel> could not read an image size from one of its Figures.");
    return width / height;
  });
  const frame = carouselFrame(ratios);

  const slides = figures.map((figure, i) => {
    const relative = ratios[i] / frame;
    const fit = Math.abs(relative - 1) <= CAROUSEL_FIT_TOLERANCE ? "cover" : "contain";
    const scale = fit === "cover" ? Math.max(1, relative) : Math.min(1, relative);
    const eager = i === 0;
    const out = figure
      // The slide owns width and spacing; the Figure's own portrait width and margins don't apply in a strip.
      .replace(/^<figure\b[^>]*>/, '<figure class="not-prose">')
      .replace(/\ssizes="[^"]*"/g, ` sizes="${slideSizes(frame, scale, { eager })}"`)
      .replace(/\sloading="lazy"/g, eager ? ' loading="eager"' : ' loading="lazy"');
    return { html: out, fit };
  });

  return { kind: "carousel", id: `carousel-${hash(html)}`, frame, slides };
}

// Stable per carousel, so builds are reproducible and the buttons can name the strip they control.
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Advice for a page's MDX body: too many slides, too many carousels, or a carousel with one image. Returns
 * human-readable warnings; an empty list means nothing to fix.
 */
export function lintCarousels(body) {
  const warnings = [];
  const blocks = [...body.matchAll(/<Carousel\b[^>]*>([\s\S]*?)<\/Carousel>/g)];
  blocks.forEach((block, i) => {
    const label = /\blabel=["']([^"']*)["']/.exec(block[0])?.[1] ?? `#${i + 1}`;
    const slides = (block[1].match(/<Figure\b/g) ?? []).length;
    if (slides > CAROUSEL_MAX_SLIDES) {
      warnings.push(`Carousel "${label}" has ${slides} slides; keep it to ${CAROUSEL_MAX_SLIDES} or fewer (3–6 reads best).`);
    } else if (slides < 2) {
      warnings.push(`Carousel "${label}" has ${slides} slide${slides === 1 ? "" : "s"}; use a plain <Figure> instead.`);
    }
  });
  if (/^import\s+\w*Carousel\w*\s+from\s+["']\.\//m.test(body)) {
    warnings.push('Page imports its own carousel component; use <Carousel> from "@components/mdx" instead.');
  }
  if (blocks.length > CAROUSEL_MAX_PER_PAGE) {
    warnings.push(`${blocks.length} carousels on one page; keep it to ${CAROUSEL_MAX_PER_PAGE} or fewer.`);
  }
  return warnings;
}
