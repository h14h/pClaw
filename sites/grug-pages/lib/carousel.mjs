// Shared by <Carousel> (src/components/mdx/Carousel.astro), the grug-page CLI lint, and the tests.

/** Slides past this many stop being browsable on a phone; split the set or cut it. */
export const CAROUSEL_MAX_SLIDES = 8;
/** Carousels past this many per page turn a guide into a photo album. */
export const CAROUSEL_MAX_PER_PAGE = 3;
/** A photo filling less than this share of the frame's width or height is better as a standalone Figure. */
export const CAROUSEL_MIN_FILL = 0.7;
export const CAROUSEL_TOO_MANY =
  "Use up to three carousels per report. Keep them where several views explain something a single photo cannot. For other sections, choose one representative photo or omit it.";
export const CAROUSEL_SMALL_FILL =
  "This photo fills less than 70% of the carousel frame. Use a standalone Figure if the full view matters.";
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

/** How much of the frame's width or height a photo of this shape fills (1 = all of it). */
export function frameFill(ratio, frame) {
  return Math.min(ratio / frame, frame / ratio);
}

/**
 * The photo-specific warnings for one carousel, shared by the build and the CLI lint so both print the same line.
 * `photos` are `{ alt, ratio }` in slide order.
 */
export function fillWarnings(label, photos) {
  const frame = carouselFrame(photos.map((photo) => photo.ratio));
  return photos
    .filter((photo) => frameFill(photo.ratio, frame) < CAROUSEL_MIN_FILL)
    .map((photo) => `Carousel "${label.trim()}". Photo "${photo.alt.slice(0, 60)}": ${CAROUSEL_SMALL_FILL}`);
}

/**
 * `sizes` for one slide: the slide is the column minus the peek, capped like a portrait Figure (65vh, 34rem tall),
 * and the image covers `scale` of the slide's width (under 1 when it sits inside the frame, over 1 when it fills it).
 */
export function slideSizes(frame, scale) {
  const k = round(scale);
  const cap = (n) => `${round(n * frame * k, 2)}`;
  const slots = COLUMN.map(([media, column]) => {
    const width = k === 1 ? `calc(${column} - ${CAROUSEL_PEEK_REM}rem)` : `calc((${column} - ${CAROUSEL_PEEK_REM}rem) * ${k})`;
    return `${media}min(${width}, ${cap(34)}rem, ${cap(65)}vh)`;
  });
  // Every slide is lazy, so supporting browsers can size by the rendered slide (`auto`); the rest is the fallback.
  return ["auto", ...slots].join(", ");
}

/**
 * Turn the rendered children of a <Carousel> into slides. Children must be <Figure>s; anything else is an authoring
 * mistake and fails the build. One Figure comes back untouched, to render as a plain Figure.
 */
export function buildCarousel(html, label = "") {
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

  const alts = figures.map((figure, i) => decodeEntities(/\salt="([^"]*)"/.exec(figure)?.[1] ?? `slide ${i + 1}`));
  const warnings = fillWarnings(label, ratios.map((ratio, i) => ({ alt: alts[i], ratio })));
  const slides = figures.map((figure, i) => {
    const ratio = ratios[i];
    const relative = ratio / frame;
    const fit = Math.abs(relative - 1) <= CAROUSEL_FIT_TOLERANCE ? "cover" : "contain";
    const scale = fit === "cover" ? Math.max(1, relative) : Math.min(1, relative);
    // The slide owns width and spacing. Portraits keep their ratio so the no-JS stack can cap them like a Figure.
    const portrait = ratio < 1 ? ` style="--figure-ratio: ${round(ratio)};" data-portrait="true"` : "";
    const out = figure
      .replace(/^<figure\b[^>]*>/, `<figure class="not-prose"${portrait}>`)
      .replace(/\ssizes="[^"]*"/g, ` sizes="${slideSizes(frame, scale)}"`);
    return { html: out, fit };
  });

  return { kind: "carousel", id: `carousel-${hash(html)}`, frame, slides, warnings };
}

// Stable per carousel, so builds are reproducible and the buttons can name the strip they control.
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Decode the HTML entities JSX allows in string attributes (named basics and numeric). */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt|nbsp);/gi, (whole, code) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: "\u00a0" }[lower] ?? whole;
  });
}

// A JSX opening tag, allowing ">" inside quoted or braced attribute values.
const tagPattern = (name) => new RegExp(`<${name}\\b(?:"[^"]*"|'[^']*'|\\{[^}]*\\}|[^'"{}>])*>`, "g");

/**
 * The string attributes of one MDX/JSX opening tag: either quote style, spaces around "=", entities decoded.
 * Expression attributes ({...}) are skipped. Shared by the carousel lint and the CLI's image-size lookup.
 */
export function readAttrs(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3]);
  }
  return attrs;
}

/** Attributes of every <Figure> in an MDX body, in order. */
export function figureTags(body) {
  return (body.match(tagPattern("Figure")) ?? []).map(readAttrs);
}

/**
 * Advice for a page's MDX body: too many slides, too many carousels, a carousel with one image, a page-local
 * carousel, and (given image sizes, from img/.sizes.json) photos that fill too little of the frame. Returns
 * human-readable warnings; an empty list means nothing to fix. Labels of carousels whose photo fit was fully
 * checked are added to `covered`, so the build can stay quiet about exactly those.
 */
export function lintCarousels(body, { sizeOf, covered } = {}) {
  const warnings = [];
  const blocks = [...body.matchAll(/(<Carousel\b(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^'"{}>])*>)([\s\S]*?)<\/Carousel>/g)];
  blocks.forEach((block, i) => {
    const label = (readAttrs(block[1]).label ?? `#${i + 1}`).trim();
    const figures = figureTags(block[2]);
    const slides = figures.length;
    const photos = figures.map((attrs) => {
      const size = sizeOf?.((attrs.src ?? "").replace(/^\.?\//, ""));
      return size ? { alt: attrs.alt ?? attrs.src ?? "", ratio: size[0] / size[1] } : null;
    });
    if (slides >= 2 && photos.every(Boolean)) {
      warnings.push(...fillWarnings(label, photos));
      covered?.push(label);
    }
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
    warnings.push(`${blocks.length} carousels on one page. ${CAROUSEL_TOO_MANY}`);
  }
  return warnings;
}

/**
 * Decides when a carousel strip has come to rest, so the slide is committed (counter, caption, focusable slide,
 * announcement) only once. Where the browser fires `scrollend`, that is the signal. Otherwise it is a quiet spell
 * after the last scroll event. Either way nothing settles while a finger or pointer is still down: a drag paused
 * past halfway must not commit a slide the reader may still drag back.
 *
 * Call `scroll()` on scroll events, `scrollEnd()` on scrollend, `press()` when a touch or pointer drag starts and
 * `release()` when it ends or is cancelled. `settle()` is called when the strip is at rest.
 */
export function createSettler({ nativeScrollEnd, settle, delay = 150, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let held = false;
  // After a release with scrollend available, a backstop in case the strip was already at rest (no scrollend comes).
  let afterRelease = false;
  let timer = null;
  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const arm = (ms) => {
    clear();
    timer = setTimer(() => {
      timer = null;
      afterRelease = false;
      if (!held) settle();
    }, ms);
  };
  const quiet = () => (nativeScrollEnd ? delay * 2 : delay);
  return {
    scroll() {
      if (held) return;
      if (!nativeScrollEnd || afterRelease) arm(quiet());
    },
    scrollEnd() {
      if (held) return;
      clear();
      afterRelease = false;
      settle();
    },
    press() {
      held = true;
      clear();
    },
    release() {
      if (!held) return;
      held = false;
      afterRelease = nativeScrollEnd;
      arm(quiet());
    },
    get held() {
      return held;
    },
  };
}

/**
 * Decides when a prev/next button press counts. iOS WebKit never fires `click` for a tap that starts while a
 * scroller on the page is still moving (a strip snapping after a swipe, or the slide animating from the previous
 * press), but it does deliver pointerdown/pointerup. So a touch or pen tap counts on pointerup (if the finger
 * stayed on the button), and a click that follows it within `window` ms is the same press, not another one. Mouse
 * clicks, Enter and Space arrive as plain clicks and count once.
 */
export function createPressGate({ now = () => performance.now(), slop = 10, window = 700 } = {}) {
  let down = null;
  let tappedAt = -Infinity;
  return {
    pointerDown(event) {
      down = event.pointerType === "mouse" ? null : { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    pointerCancel() {
      down = null;
    },
    /** True when this pointerup is a tap that should activate the button now. */
    pointerUp(event) {
      if (!down || event.pointerId !== down.id) return false;
      const stayed = Math.hypot(event.clientX - down.x, event.clientY - down.y) <= slop;
      down = null;
      if (stayed) tappedAt = now();
      return stayed;
    },
    /** True when this click is a press of its own (mouse, keyboard, assistive tech), not the echo of a tap. */
    click() {
      return now() - tappedAt > window;
    },
  };
}
