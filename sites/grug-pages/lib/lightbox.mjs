// Zoom and pan math for the photo viewer. Pure functions, shared by the page script (inlined into BaseLayout.astro
// next to lib/lightbox-client.js) and the tests.
//
// A view is { scale, x, y }: the image's top-left corner sits at (x, y) in the stage, drawn at `scale` CSS pixels
// per image pixel. Stage and image sizes are { w, h }.

/** Zooming stops at this many device pixels per image pixel (or 2.5× the opening view, whichever is more). */
export const LIGHTBOX_MAX_DEVICE_SCALE = 4;
/** Double-tap and double-click toggle between the opening view and this multiple of it. */
export const LIGHTBOX_DOUBLE_TAP_ZOOM = 2.5;
/** An image this much wider (or taller) than the screen's shape opens as a strip to pan, not a thin fit. */
export const LIGHTBOX_PAN_SHAPE = 2;
/** ...as long as it is a true panorama (or tall shot) on its own: at least 2:1. */
export const LIGHTBOX_PAN_MIN_RATIO = 2;
/** A panorama opens at this share of the stage height (a tall image at this share of its width). */
export const LIGHTBOX_PAN_FILL = 0.8;
/** Fit never blows an image up past this many CSS pixels per image pixel. */
export const LIGHTBOX_MAX_FIT = 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * How an image opens: "fit" (whole image on screen), "pan-x" (a panorama at 80% of the stage height, centred, to
 * drag sideways), or "pan-y" (a tall image at 80% of the stage width, centred, to drag up and down).
 */
export function openingView(stage, image) {
  const imageRatio = image.w / image.h;
  const stageRatio = stage.w / stage.h;
  let mode = "fit";
  let scale = Math.min(stage.w / image.w, stage.h / image.h, LIGHTBOX_MAX_FIT);
  if (imageRatio >= LIGHTBOX_PAN_MIN_RATIO && imageRatio > LIGHTBOX_PAN_SHAPE * stageRatio) {
    mode = "pan-x";
    scale = (stage.h * LIGHTBOX_PAN_FILL) / image.h;
  } else if (1 / imageRatio >= LIGHTBOX_PAN_MIN_RATIO && 1 / imageRatio > LIGHTBOX_PAN_SHAPE / stageRatio) {
    mode = "pan-y";
    scale = (stage.w * LIGHTBOX_PAN_FILL) / image.w;
  }
  return { mode, ...clampView(stage, image, { scale, x: 0, y: 0 }, true) };
}

/** Zoom range for an image: from its opening view up to ~4 device pixels per image pixel. */
export function scaleLimits(opening, dpr = 1) {
  return {
    min: opening.scale,
    max: Math.max(opening.scale * LIGHTBOX_DOUBLE_TAP_ZOOM, LIGHTBOX_MAX_DEVICE_SCALE / Math.max(1, dpr)),
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

/** Double-tap: from the opening view zoom 2.5× at the tap; from anywhere else, go back to the opening view. */
export function toggleZoom(stage, image, view, opening, px, py, limits) {
  if (view.scale > opening.scale * 1.01) return { scale: opening.scale, x: opening.x, y: opening.y };
  return zoomAt(stage, image, view, opening.scale * LIGHTBOX_DOUBLE_TAP_ZOOM, px, py, limits);
}

/** Whether the image can be dragged (it overflows the stage on some axis). */
export function canPan(stage, image, view) {
  return image.w * view.scale > stage.w + 0.5 || image.h * view.scale > stage.h + 0.5;
}

/**
 * What a one-finger drag that ended at (dx, dy) means when the image can't pan: "next"/"prev" (a mostly
 * sideways swipe of 60px+), "close" (a mostly downward swipe of 90px+), or null (snap back).
 */
export function classifySwipe(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= 60 && ax > ay * 1.2) return dx < 0 ? "next" : "prev";
  if (dy >= 90 && ay > ax * 1.2) return "close";
  return null;
}

/** The smallest candidate at least `needed` pixels wide (or the largest there is). Candidates sorted by width. */
export function pickSource(candidates, needed) {
  return candidates.find((candidate) => candidate.w >= needed) ?? candidates[candidates.length - 1];
}
