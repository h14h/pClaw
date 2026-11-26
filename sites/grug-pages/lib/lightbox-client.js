// Photo viewer for <Figure>s. Inlined once per page by BaseLayout.astro, right after lib/lightbox.mjs (whose
// functions it uses), as a classic script: no imports, no external files, CSP-safe.
//
// Every zoomable Figure is a link (a[data-zoom]) to its largest image, so without JS the browser's own viewer
// opens it. With JS the click opens a full-screen <dialog>: fit to screen (panoramas and tall shots open large,
// to drag), pinch / double-tap / ctrl+wheel / +- zoom, drag to pan within bounds, and, for a carousel's slides,
// swipe / arrows / buttons between them. Closing returns to the page where it was, with focus on the image.
(() => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ICON = {
    close: '<path d="M6 6l12 12M18 6L6 18" />',
    prev: '<path d="M15 5l-7 7 7 7" />',
    next: '<path d="M9 5l7 7-7 7" />',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;

  let ui = null;
  let items = [];
  let index = 0;
  let origin = null;
  let carousel = null;
  let scroll = [0, 0];
  let image = { w: 1, h: 1 };
  let stage = { w: 1, h: 1 };
  let opening = { mode: "fit", scale: 1, x: 0, y: 0 };
  let limits = { min: 1, max: 1 };
  let view = opening;
  let candidates = [];
  let shownWidth = 0;
  let loadToken = 0;
  let hinted = false;

  function build() {
    if (ui) return ui;
    const dialog = document.createElement("dialog");
    dialog.className = "lightbox";
    // The dialog itself takes focus on open (its label, the photo's alt, is read first); Tab then reaches Close.
    dialog.tabIndex = -1;
    dialog.innerHTML =
      '<div class="lightbox-stage" data-lb-stage><img class="lightbox-img" alt="" draggable="false" decoding="async" data-lb-img></div>' +
      '<div class="lightbox-top"><p class="lightbox-counter" aria-hidden="true" data-lb-counter></p>' +
      `<button type="button" class="lightbox-button lightbox-close" aria-label="Close" data-lb-close>${icon("close")}</button></div>` +
      `<button type="button" class="lightbox-button lightbox-prev" aria-label="Previous photo" data-lb-prev>${icon("prev")}</button>` +
      `<button type="button" class="lightbox-button lightbox-next" aria-label="Next photo" data-lb-next>${icon("next")}</button>` +
      '<p class="lightbox-hint" aria-hidden="true" data-lb-hint></p>' +
      '<div class="lightbox-caption" data-lb-caption></div>' +
      '<p class="sr-only" aria-live="polite" aria-atomic="true" data-lb-live></p>';
    document.body.append(dialog);
    const $ = (name) => dialog.querySelector(`[data-lb-${name}]`);
    ui = {
      dialog,
      stage: $("stage"),
      img: $("img"),
      counter: $("counter"),
      close: $("close"),
      prev: $("prev"),
      next: $("next"),
      hint: $("hint"),
      caption: $("caption"),
      live: $("live"),
    };
    wire(ui);
    return ui;
  }

  // ---- What is on screen

  function measure() {
    const rect = ui.stage.getBoundingClientRect();
    stage = { w: rect.width, h: rect.height };
  }

  function render(animate = false) {
    const motion = animate && !reducedMotion.matches;
    ui.img.style.transition = motion ? "transform 220ms cubic-bezier(0.2, 0, 0, 1)" : "none";
    ui.img.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
    ui.dialog.toggleAttribute("data-zoomed", view.scale > opening.scale * 1.01);
    ui.dialog.toggleAttribute("data-pannable", canPan(stage, image, view));
    upgrade();
  }

  // Swap in a sharper file once the view needs more pixels than the one showing.
  function upgrade() {
    if (candidates.length === 0) return;
    const needed = image.w * view.scale * (window.devicePixelRatio || 1);
    const pick = pickSource(candidates, needed);
    if (pick.w <= shownWidth) return;
    const token = ++loadToken;
    const pre = new Image();
    pre.src = pick.url;
    pre
      .decode()
      .then(() => {
        if (token !== loadToken || !ui.dialog.open) return;
        ui.img.src = pick.url;
        shownWidth = pick.w;
      })
      .catch(() => {});
  }

  function fill(link) {
    const figure = link.closest("figure");
    const thumb = link.querySelector("img");
    const alt = thumb?.getAttribute("alt") ?? "";
    image = { w: Number(link.dataset.zoomW) || thumb?.naturalWidth || 1, h: Number(link.dataset.zoomH) || thumb?.naturalHeight || 1 };
    candidates = (link.dataset.zoomSrcset || "")
      .split(",")
      .map((part) => part.trim().split(/\s+/))
      .filter(([url, size]) => url && /^\d+w$/.test(size ?? ""))
      .map(([url, size]) => ({ url, w: parseInt(size, 10) }))
      .sort((a, b) => a.w - b.w);
    // The page's own (already loaded) image shows at once; a sharper file replaces it when it has decoded.
    loadToken += 1;
    ui.img.src = thumb?.currentSrc || thumb?.src || link.href;
    shownWidth = 0;
    ui.img.alt = alt;
    // Transparent graphics with dark ink keep their light surface on the dark viewer.
    ui.img.classList.toggle("lightbox-paper", link.dataset.zoomSurface === "paper");
    ui.img.style.width = `${image.w}px`;
    ui.img.style.height = `${image.h}px`;
    ui.dialog.setAttribute("aria-label", alt || "Photo");

    ui.caption.replaceChildren();
    const caption = figure?.querySelector("[data-caption]")?.textContent?.trim();
    const credit = figure?.querySelector("[data-credit]");
    if (caption) {
      const text = document.createElement("span");
      text.textContent = caption;
      ui.caption.append(text);
    }
    if (credit) {
      const node = document.createElement(credit.tagName === "A" ? "a" : "span");
      node.textContent = credit.textContent.trim();
      if (credit.tagName === "A") {
        node.href = credit.getAttribute("href");
        node.rel = "noopener noreferrer";
      }
      node.className = "lightbox-credit";
      ui.caption.append(node);
    }
    ui.caption.hidden = !caption && !credit;
  }

  function layout() {
    measure();
    opening = openingView(stage, image);
    limits = scaleLimits(opening, window.devicePixelRatio || 1);
    view = { scale: opening.scale, x: opening.x, y: opening.y };
    render(false);
    if (opening.mode !== "fit" && !hinted) {
      hinted = true;
      ui.hint.textContent = opening.mode === "pan-x" ? "Drag to pan" : "Drag to scroll";
      ui.dialog.setAttribute("data-hint", "");
      setTimeout(() => ui.dialog.removeAttribute("data-hint"), 2600);
    }
  }

  function show(i, announce) {
    index = i;
    fill(items[i]);
    const many = items.length > 1;
    ui.counter.textContent = many ? `${i + 1} / ${items.length}` : "";
    ui.prev.hidden = !many;
    ui.next.hidden = !many;
    ui.prev.setAttribute("aria-disabled", String(i === 0));
    ui.next.setAttribute("aria-disabled", String(i === items.length - 1));
    layout();
    if (announce) ui.live.textContent = `Photo ${i + 1} of ${items.length}`;
  }

  function step(delta) {
    const next = index + delta;
    if (next < 0 || next >= items.length) {
      view = clampView(stage, image, view);
      render(true);
      return;
    }
    show(next, true);
  }

  // ---- Opening and closing

  function open(link) {
    build();
    origin = link;
    carousel = link.closest("grug-carousel");
    items = carousel ? Array.from(carousel.querySelectorAll("a[data-zoom]")) : [link];
    index = Math.max(0, items.indexOf(link));
    scroll = [window.scrollX, window.scrollY];
    ui.live.textContent = "";
    ui.dialog.showModal();
    ui.dialog.focus();
    show(index, false);
  }

  function onClosed() {
    loadToken += 1;
    const target = items[index] ?? origin;
    if (carousel && target !== origin && typeof carousel.goTo === "function") carousel.goTo(items.indexOf(target));
    target?.focus({ preventScroll: true });
    window.scrollTo(scroll[0], scroll[1]);
    ui.img.removeAttribute("src");
    items = [];
    carousel = null;
  }

  // ---- Input

  function wire({ dialog, stage: stageEl, close, prev, next }) {
    close.addEventListener("click", () => dialog.close());
    prev.addEventListener("click", () => prev.getAttribute("aria-disabled") !== "true" && step(-1));
    next.addEventListener("click", () => next.getAttribute("aria-disabled") !== "true" && step(1));
    dialog.addEventListener("close", onClosed);
    window.addEventListener("resize", () => dialog.open && layout());

    dialog.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const zoomBy = (factor) => {
        view = zoomAt(stage, image, view, view.scale * factor, stage.w / 2, stage.h / 2, limits);
        render(true);
      };
      const overflowX = image.w * view.scale > stage.w + 0.5;
      const overflowY = image.h * view.scale > stage.h + 0.5;
      const move = (dx, dy) => {
        view = panBy(stage, image, view, dx, dy);
        render(true);
      };
      const key = event.key;
      if (key === "+" || key === "=") zoomBy(1.5);
      else if (key === "-" || key === "_") zoomBy(1 / 1.5);
      else if (key === "0") {
        view = { scale: opening.scale, x: opening.x, y: opening.y };
        render(true);
      } else if (key === "ArrowLeft") overflowX ? move(stage.w * 0.2, 0) : step(-1);
      else if (key === "ArrowRight") overflowX ? move(-stage.w * 0.2, 0) : step(1);
      else if (key === "ArrowUp" && overflowY) move(0, stage.h * 0.2);
      else if (key === "ArrowDown" && overflowY) move(0, -stage.h * 0.2);
      else return;
      event.preventDefault();
    });

    // Nothing behind the viewer scrolls; the wheel zooms (ctrl/pinch) or pans.
    dialog.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = stageEl.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        if (event.ctrlKey) {
          view = zoomAt(stage, image, view, view.scale * Math.exp(-event.deltaY * 0.01), px, py, limits);
        } else if (canPan(stage, image, view)) {
          view = panBy(stage, image, view, -event.deltaX, -event.deltaY);
        } else return;
        render(false);
      },
      { passive: false },
    );

    // Safari: stop page zoom; desktop Safari's trackpad pinch arrives only as gesture events.
    let gestureView = null;
    dialog.addEventListener("gesturestart", (event) => {
      event.preventDefault();
      gestureView = pointers.size === 0 ? view : null;
    });
    dialog.addEventListener("gesturechange", (event) => {
      event.preventDefault();
      if (!gestureView) return;
      view = zoomAt(stage, image, gestureView, gestureView.scale * event.scale, stage.w / 2, stage.h / 2, limits);
      render(false);
    });
    dialog.addEventListener("gestureend", (event) => event.preventDefault());

    // Touch, pen and mouse on the stage: one pointer pans (or swipes when the image fits), two pinch.
    const pointers = new Map();
    let gesture = null;
    let lastTap = null;
    const at = (event) => {
      const rect = stageEl.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const begin = () => {
      const points = [...pointers.values()];
      if (points.length >= 2) {
        const [a, b] = points;
        gesture = { kind: "pinch", start: view, distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      } else if (points.length === 1) {
        const [p] = points;
        gesture = { kind: "pending", start: view, origin: { x: p.x, y: p.y }, time: performance.now(), moved: false, type: p.type };
      } else gesture = null;
      ui.img.style.willChange = gesture ? "transform" : "";
    };
    stageEl.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      stageEl.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { ...at(event), type: event.pointerType });
      begin();
    });
    stageEl.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId) || !gesture) return;
      pointers.set(event.pointerId, { ...at(event), type: event.pointerType });
      const points = [...pointers.values()];
      if (gesture.kind === "pinch" && points.length >= 2) {
        const [a, b] = points;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const zoomed = zoomAt(stage, image, gesture.start, (gesture.start.scale * distance) / gesture.distance, gesture.mid.x, gesture.mid.y, limits);
        view = panBy(stage, image, zoomed, mid.x - gesture.mid.x, mid.y - gesture.mid.y);
        render(false);
        return;
      }
      const p = points[0];
      const dx = p.x - gesture.origin.x;
      const dy = p.y - gesture.origin.y;
      if (!gesture.moved && Math.hypot(dx, dy) > 8) {
        gesture.moved = true;
        // Decide once, from the first movement: a mostly-downward touch drag on an image that fits the height (a
        // fitted photo or an unzoomed panorama) is a swipe to close; otherwise drag pans if it can, or swipes.
        const fitsHeight = image.h * view.scale <= stage.h + 0.5;
        const atOpening = view.scale <= opening.scale * 1.01;
        const downward = gesture.type === "touch" && dy > 0 && Math.abs(dy) > Math.abs(dx);
        gesture.kind = !canPan(stage, image, view) || (downward && fitsHeight && atOpening) ? "swipe" : "pan";
      }
      if (gesture.kind === "pan") {
        view = panBy(stage, image, gesture.start, dx, dy);
        render(false);
      } else if (gesture.moved) {
        // Fitted image: follow the finger sideways (next/previous) or down (close), without committing yet.
        const down = gesture.type === "touch" && dy > 0 && Math.abs(dy) > Math.abs(dx);
        const ox = down ? 0 : dx;
        const oy = down ? dy : 0;
        ui.img.style.transition = "none";
        ui.img.style.transform = `translate3d(${view.x + ox}px, ${view.y + oy}px, 0) scale(${view.scale})`;
        ui.dialog.style.setProperty("--lightbox-fade", down ? String(Math.max(0.35, 1 - dy / 400)) : "1");
      }
    });
    const end = (event) => {
      if (!pointers.has(event.pointerId)) return;
      const point = pointers.get(event.pointerId);
      pointers.delete(event.pointerId);
      const finished = gesture;
      if (pointers.size > 0) {
        begin();
        return;
      }
      gesture = null;
      ui.img.style.willChange = "";
      ui.dialog.style.removeProperty("--lightbox-fade");
      if (!finished || event.type === "pointercancel") {
        render(true);
        return;
      }
      if (finished.kind === "pinch") return render(false);
      const dx = point.x - finished.origin.x;
      const dy = point.y - finished.origin.y;
      if (!finished.moved && performance.now() - finished.time < 350) return tap(point);
      if (finished.kind === "swipe") {
        const action = classifySwipe(dx, dy);
        if (action === "close" && finished.type === "touch") return ui.dialog.close();
        if (action === "next" && index < items.length - 1) return show(index + 1, true);
        if (action === "prev" && index > 0) return show(index - 1, true);
        render(true);
      }
    };
    stageEl.addEventListener("pointerup", end);
    stageEl.addEventListener("pointercancel", end);

    // A tap outside the photo closes (at the opening view); two quick taps toggle zoom at that point.
    function tap(point) {
      const now = performance.now();
      if (lastTap && now - lastTap.time < 320 && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < 40) {
        lastTap = null;
        view = toggleZoom(stage, image, view, opening, point.x, point.y, limits);
        render(true);
        return;
      }
      lastTap = { ...point, time: now };
      const inside =
        point.x >= view.x && point.x <= view.x + image.w * view.scale && point.y >= view.y && point.y <= view.y + image.h * view.scale;
      if (!inside && view.scale <= opening.scale * 1.01) {
        // Close on the tap's own click (still aimed at the stage), so no follow-up mouse event reaches the page.
        closePending = true;
        setTimeout(closeIfPending, 400);
      }
    }
    let closePending = false;
    function closeIfPending() {
      if (!closePending) return;
      closePending = false;
      ui.dialog.close();
    }
    stageEl.addEventListener("click", closeIfPending);
  }

  // ---- Page hooks: click (Enter) and Space on any zoomable Figure

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[data-zoom]") : null;
    if (!link || typeof HTMLDialogElement !== "function") return;
    event.preventDefault();
    open(link);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== " " || !(event.target instanceof Element) || !event.target.matches("a[data-zoom]")) return;
    event.preventDefault();
    open(event.target);
  });
})();
