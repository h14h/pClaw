// Zoom and pan math for the photo viewer. Pure functions, shared by the page script (inlined into BaseLayout.astro
// next to lib/lightbox-client.js) and the tests.
//
// A view is { scale, x, y }: the image's top-left corner sits at (x, y) in the stage, drawn at `scale` CSS pixels
// per image pixel. Stage and image sizes are { w, h }.

/** Zooming stops when the largest file is enlarged this many times on the device (2 = each file pixel 2×2). */
export const LIGHTBOX_MAX_ENLARGE = 2;
/** Double-tap zooms to this multiple of the opening view (when the file has the pixels for it). */
export const LIGHTBOX_DOUBLE_TAP_ZOOM = 2.5;
/** An image this much wider (or taller) than the screen's shape opens as a strip to pan, not a thin fit. */
export const LIGHTBOX_PAN_SHAPE = 2;
/** ...as long as it is a true panorama (or tall shot) on its own: at least 2:1. */
export const LIGHTBOX_PAN_MIN_RATIO = 2;
/** A panorama opens at this share of the stage height (a tall image at this share of its width). */
export const LIGHTBOX_PAN_FILL = 0.8;
/** Fit never blows an image up past this many CSS pixels per image pixel. */
export const LIGHTBOX_MAX_FIT = 2;
/** A panorama's short edge below this many pixels looks soft at its pan view (grug-page image warns). */
export const LIGHTBOX_PANORAMA_MIN_SHORT_EDGE = 700;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** The whole image on screen, centred (never blown up past LIGHTBOX_MAX_FIT). */
export function fitView(stage, image) {
  const scale = Math.min(stage.w / image.w, stage.h / image.h, LIGHTBOX_MAX_FIT);
  return clampView(stage, image, { scale, x: 0, y: 0 }, true);
}

/**
 * How an image opens: "fit" (whole image on screen), "pan-x" (a panorama at 80% of the stage height, centred, to
 * drag sideways), or "pan-y" (a tall image at 80% of the stage width, centred, to drag up and down).
 */
export function openingView(stage, image) {
  const imageRatio = image.w / image.h;
  const stageRatio = stage.w / stage.h;
  if (imageRatio >= LIGHTBOX_PAN_MIN_RATIO && imageRatio > LIGHTBOX_PAN_SHAPE * stageRatio) {
    const scale = (stage.h * LIGHTBOX_PAN_FILL) / image.h;
    return { mode: "pan-x", ...clampView(stage, image, { scale, x: 0, y: 0 }, true) };
  }
  if (1 / imageRatio >= LIGHTBOX_PAN_MIN_RATIO && 1 / imageRatio > LIGHTBOX_PAN_SHAPE / stageRatio) {
    const scale = (stage.w * LIGHTBOX_PAN_FILL) / image.w;
    return { mode: "pan-y", ...clampView(stage, image, { scale, x: 0, y: 0 }, true) };
  }
  return { mode: "fit", ...fitView(stage, image) };
}

/** "Fill": a panorama's or tall shot's opening strip; any other photo covering the whole screen. */
export function fillView(stage, image) {
  const opening = openingView(stage, image);
  if (opening.mode !== "fit") return { scale: opening.scale, x: opening.x, y: opening.y };
  const scale = Math.max(stage.w / image.w, stage.h / image.h);
  return clampView(stage, image, { scale, x: 0, y: 0 }, true);
}

/**
 * Zoom range: from the whole photo (fit) up to the largest file enlarged LIGHTBOX_MAX_ENLARGE× on this screen, but
 * never below the opening or fill views, so a small panorama still gets its big pan view (with no extra zoom
 * stacked on top). `largest` is the widest file's pixel width; `image` the photo's own size.
 */
export function scaleLimits(stage, image, { dpr = 1, largest = image.w } = {}) {
  const fit = fitView(stage, image).scale;
  const sharp = (LIGHTBOX_MAX_ENLARGE * largest) / (image.w * Math.max(1, dpr));
  return {
    min: Math.min(fit, openingView(stage, image).scale),
    max: Math.max(sharp, openingView(stage, image).scale, fillView(stage, image).scale),
  };
}

/**
 * Keep the image covering the stage: an axis the image overflows is clamped so no gap shows at either edge; an
 * axis it doesn't fill is centred. `centre` centres overflowing axes too (for the opening view).
 */
export function clampView(stage, image, view, centre = false) {
  const width = image.w * view.scale;
  const height = image.h * view.scale;
  const axis = (size, room, at) => {
    if (size <= room || centre) return (room - size) / 2;
    return clamp(at, room - size, 0);
  };
  return { scale: view.scale, x: axis(width, stage.w, view.x), y: axis(height, stage.h, view.y) };
}

/** Zoom to `nextScale` (kept within limits) around the stage point (px, py), which stays put under the finger. */
export function zoomAt(stage, image, view, nextScale, px, py, limits) {
  const scale = clamp(nextScale, limits.min, limits.max);
  const k = scale / view.scale;
  return clampView(stage, image, { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k });
}

/** Move the image by (dx, dy), within bounds. */
export function panBy(stage, image, view, dx, dy) {
  return clampView(stage, image, { scale: view.scale, x: view.x + dx, y: view.y + dy });
}

/**
 * Double-tap: from the opening view zoom 2.5× at the tap (as far as the file allows); if it can't zoom in at all,
 * show the whole photo instead; from anywhere else, go back to the opening view.
 */
export function toggleZoom(stage, image, view, opening, px, py, limits) {
  const atOpening = Math.abs(view.scale - opening.scale) <= opening.scale * 0.01;
  if (!atOpening) return { scale: opening.scale, x: opening.x, y: opening.y };
  if (limits.max > opening.scale * 1.1) return zoomAt(stage, image, view, opening.scale * LIGHTBOX_DOUBLE_TAP_ZOOM, px, py, limits);
  return fitView(stage, image);
}

/** Whether the image can be dragged (it overflows the stage on some axis). */
export function canPan(stage, image, view) {
  return image.w * view.scale > stage.w + 0.5 || image.h * view.scale > stage.h + 0.5;
}

/**
 * What a one-finger drag becomes, decided once when it first moves past the slop and never changed after:
 * - "pan" when the photo overflows the screen along the drag (or after a pinch, while a finger stays down);
 * - "dismiss" for a mostly downward touch drag on a photo at rest that fits the screen's height;
 * - "nav" for a mostly sideways drag at rest, when there are other slides to move to;
 * - otherwise "none" (nothing follows the finger).
 */
export function lockGesture({ dx, dy, overflowX, overflowY, touch, atRest, slides, afterPinch }) {
  const sideways = Math.abs(dx) > Math.abs(dy);
  if (afterPinch) return overflowX || overflowY ? "pan" : "none";
  if (!sideways && touch && dy > 0 && atRest && !overflowY) return "dismiss";
  if (sideways ? overflowX : overflowY) return "pan";
  if (overflowX || overflowY) return "pan";
  if (sideways && atRest && slides > 1) return "nav";
  return "none";
}

/** What a locked drag does when it ends: only its own axis counts (60px sideways for nav, 90px down to close). */
export function releaseGesture(kind, dx, dy) {
  if (kind === "nav" && Math.abs(dx) >= 60) return dx < 0 ? "next" : "prev";
  if (kind === "dismiss" && dy >= 90) return "close";
  return null;
}

/** The smallest candidate at least `needed` pixels wide (or the largest there is). Candidates sorted by width. */
export function pickSource(candidates, needed) {
  return candidates.find((candidate) => candidate.w >= needed) ?? candidates[candidates.length - 1];
}
