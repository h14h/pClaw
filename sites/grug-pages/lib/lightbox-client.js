// Photo viewer for <Figure>s. Inlined once per report page by ReportLayout.astro, right after lib/lightbox.mjs
// (whose functions it uses), as a classic script: no imports, no external files, CSP-safe.
//
// Every zoomable Figure is a link (a[data-zoom]) to its largest image, so without JS the browser's own viewer
// opens it. With JS the click opens a full-screen <dialog>: the photo fit to screen (panoramas and tall shots open
// large, to drag), Fit/Fill, zoom in/out/reset buttons, pinch, double-tap, ctrl+wheel and +/- keys, drag to pan
// within bounds, and, for a carousel's slides, swipe / arrows / buttons between them. Closing returns to the page
// where it was, with focus on the photo.
(() => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ICON = {
    close: '<path d="M6 6l12 12M18 6L6 18" />',
    prev: '<path d="M15 5l-7 7 7 7" />',
    next: '<path d="M9 5l7 7-7 7" />',
    in: '<path d="M12 6v12M6 12h12" />',
    out: '<path d="M6 12h12" />',
    reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" />',
    fit: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />',
    fill: '<path d="M4 9l5-5M20 9l-5-5M4 15l5 5M20 15l-5 5" />',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
  const button = (name, label, extra = "") =>
    `<button type="button" class="lightbox-button ${extra}" aria-label="${label}" data-lb-${name}>${icon(name === "fitfill" ? "fit" : name)}</button>`;

  let ui = null;
  let items = [];
  let index = 0;
  let showing = -1;
  let showToken = 0;
  let origin = null;
  let carousel = null;
  let scroll = [0, 0];
  let image = { w: 1, h: 1 };
  let stage = { w: 1, h: 1 };
  let opening = { mode: "fit", scale: 1, x: 0, y: 0 };
  let fit = opening;
  let fill = opening;
  let limits = { min: 1, max: 1 };
  let view = opening;
  let candidates = [];
  let shownWidth = 0;
  let pendingWidth = 0;
  let loadToken = 0;
  let userPanned = false;
  let tapOpenedAt = -Infinity;
  // Which view the reader picked, so a resize (rotation, a browser toolbar collapsing) keeps it:
  // "opening" | "fit" | "fill" | "manual" (zoomed or panned by hand: the point at the centre stays put).
  let selected = "opening";
  let loadingTimer = 0;

  const dpr = () => window.devicePixelRatio || 1;
  const near = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.01;

  function build() {
    if (ui) return ui;
    const dialog = document.createElement("dialog");
    dialog.className = "lightbox";
    // The dialog itself takes focus on open (its label, the photo's alt, is read first); Tab then walks the controls.
    dialog.tabIndex = -1;
    dialog.innerHTML =
      '<div class="lightbox-stage" data-lb-stage><img class="lightbox-img" alt="" draggable="false" decoding="async" data-lb-img></div>' +
      '<div class="lightbox-top"><p class="lightbox-counter" aria-hidden="true" data-lb-counter></p><div class="lightbox-tools">' +
      button("out", "Zoom out") +
      button("in", "Zoom in") +
      button("reset", "Reset zoom") +
      '<button type="button" class="lightbox-button lightbox-text" aria-label="Fit whole photo" data-lb-fitfill><span data-lb-fitfill-text>Fit</span></button>' +
      button("close", "Close") +
      "</div></div>" +
      button("prev", "Previous photo", "lightbox-side lightbox-prev") +
      button("next", "Next photo", "lightbox-side lightbox-next") +
      '<p class="lightbox-hint" aria-hidden="true" data-lb-hint></p>' +
      '<p class="lightbox-loading" aria-hidden="true" data-lb-loading><span class="lightbox-spinner"></span>Loading</p>' +
      '<div class="lightbox-status" role="alert" hidden data-lb-status><span data-lb-status-text></span>' +
      '<button type="button" class="lightbox-retry" data-lb-retry>Retry</button></div>' +
      '<div class="lightbox-caption" data-lb-caption></div>' +
      '<p class="sr-only" aria-live="polite" aria-atomic="true" data-lb-live></p>';
    document.body.append(dialog);
    const $ = (name) => dialog.querySelector(`[data-lb-${name}]`);
    ui = {
      dialog,
      stage: $("stage"),
      img: $("img"),
      counter: $("counter"),
      zoomOut: $("out"),
      zoomIn: $("in"),
      reset: $("reset"),
      fitfill: $("fitfill"),
      fitfillText: $("fitfill-text"),
      status: $("status"),
      statusText: $("status-text"),
      retry: $("retry"),
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

  const zoomed = () => view.scale > Math.max(opening.scale, fit.scale) * 1.01;
  const atRest = () => !zoomed();
  const setDisabled = (el, off) => el.setAttribute("aria-disabled", String(off));

  function render(animate = false) {
    const motion = animate && !reducedMotion.matches;
    // Sized in layout (not a transform scale) and placed on whole device pixels: one resample, no tile seams.
    const ratio = dpr();
    const snap = (v) => Math.round(v * ratio) / ratio;
    ui.img.style.transition = motion ? "width 220ms cubic-bezier(0.2, 0, 0, 1), height 220ms cubic-bezier(0.2, 0, 0, 1), transform 220ms cubic-bezier(0.2, 0, 0, 1)" : "none";
    ui.img.style.width = `${snap(image.w * view.scale)}px`;
    ui.img.style.height = `${snap(image.h * view.scale)}px`;
    ui.img.style.transform = `translate3d(${snap(view.x)}px, ${snap(view.y)}px, 0)`;
    const isZoomed = zoomed();
    ui.dialog.toggleAttribute("data-zoomed", isZoomed);
    ui.dialog.toggleAttribute("data-pannable", canPan(stage, image, view));
    // At the ceiling or floor, the buttons say why they do nothing (name, and a tooltip on fine pointers).
    const atMax = view.scale >= limits.max * 0.995;
    const atMin = view.scale <= limits.min * 1.005;
    setDisabled(ui.zoomIn, atMax);
    setDisabled(ui.zoomOut, atMin);
    ui.zoomIn.setAttribute("aria-label", atMax ? "Zoom in (maximum zoom)" : "Zoom in");
    ui.zoomOut.setAttribute("aria-label", atMin ? "Zoom out (whole photo shown)" : "Zoom out");
    ui.zoomIn.title = atMax ? "Maximum zoom" : "Zoom in";
    ui.zoomOut.title = atMin ? "Whole photo shown" : "Zoom out";
    setDisabled(ui.reset, near(view.scale, opening.scale) && Math.abs(view.x - opening.x) < 1 && Math.abs(view.y - opening.y) < 1);
    const whole = near(view.scale, fit.scale);
    const same = near(fit.scale, fill.scale);
    ui.fitfill.hidden = same;
    ui.fitfill.setAttribute("aria-label", whole ? "Fill screen" : "Fit whole photo");
    ui.fitfillText.textContent = whole ? "Fill" : "Fit";
    ui.fitfill.title = whole ? "Fill screen" : "Fit whole photo";
    hint();
    // The caption steps aside while zoomed; anything focused in it moves to a control that stays visible.
    if (isZoomed && ui.caption.contains(document.activeElement)) ui.close.focus();
    upgrade();
  }

  function setView(next, animate, mode = "manual") {
    view = next;
    selected = mode;
    render(animate);
  }

  // A view's mode, for views that land exactly on one of the named ones (double-tap, keyboard 0).
  const modeOf = (v) =>
    near(v.scale, opening.scale) && Math.abs(v.x - opening.x) < 1 && Math.abs(v.y - opening.y) < 1
      ? "opening"
      : near(v.scale, fit.scale) && !canPan(stage, image, v)
        ? "fit"
        : "manual";

  // Swap in a sharper file once the view needs more pixels than the one showing. One decode in flight at a time;
  // the preview stays until the sharper file has decoded.
  function upgrade() {
    if (candidates.length === 0) return;
    const pick = pickSource(candidates, image.w * view.scale * dpr());
    if (pick.w <= shownWidth || pick.w <= pendingWidth) return;
    pendingWidth = pick.w;
    const token = loadToken;
    const pre = new Image();
    pre.src = pick.url;
    pre
      .decode()
      .then(() => {
        if (token !== loadToken || !ui.dialog.open) return;
        if (pick.w > shownWidth) {
          ui.img.src = pick.url;
          shownWidth = pick.w;
        }
      })
      .catch(() => {})
      .finally(() => {
        if (token === loadToken && pendingWidth === pick.w) pendingWidth = 0;
      });
  }

  function sourcesOf(link) {
    return (link.dataset.zoomSrcset || "")
      .split(",")
      .map((part) => part.trim().split(/\s+/))
      .filter(([url, size]) => url && /^\d+w$/.test(size ?? ""))
      .map(([url, size]) => ({ url, w: parseInt(size, 10) }))
      .sort((a, b) => a.w - b.w);
  }

  // A preview that is already on screen in the page (or the smallest file), so a slide never shows blank.
  function previewOf(link) {
    const thumb = link.querySelector("img");
    if (thumb && thumb.complete && thumb.naturalWidth > 0) return thumb.currentSrc || thumb.src;
    return sourcesOf(link)[0]?.url ?? link.href;
  }

  const altOf = (link) => link.querySelector("img")?.getAttribute("alt") ?? "";

  // Neighbouring slides fetch their previews while this one is viewed.
  function warm(i) {
    const link = items[i];
    if (!link) return;
    const thumb = link.querySelector("img");
    if (thumb) thumb.loading = "eager";
    const pre = new Image();
    pre.src = previewOf(link);
  }

  function present(link) {
    const figure = link.closest("figure");
    const thumb = link.querySelector("img");
    const alt = altOf(link);
    image = { w: Number(link.dataset.zoomW) || thumb?.naturalWidth || 1, h: Number(link.dataset.zoomH) || thumb?.naturalHeight || 1 };
    candidates = sourcesOf(link);
    loadToken += 1;
    shownWidth = 0;
    pendingWidth = 0;
    ui.img.src = previewOf(link);
    ui.img.alt = alt;
    // Transparent graphics with dark ink keep their light surface on the dark viewer.
    ui.img.classList.toggle("lightbox-paper", link.dataset.zoomSurface === "paper");
    ui.dialog.setAttribute("aria-label", alt || "Photo");

    ui.caption.replaceChildren();
    const caption = figure?.querySelector("[data-caption]")?.textContent?.trim();
    const credit = figure?.querySelector("[data-credit]");
    if (caption) {
      const text = document.createElement("span");
      text.className = "lightbox-caption-text";
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

  function views() {
    opening = openingView(stage, image);
    fit = fitView(stage, image);
    fill = fillView(stage, image);
    limits = scaleLimits(stage, image, { dpr: dpr(), largest: candidates.at(-1)?.w ?? image.w });
  }

  function layout() {
    measure();
    views();
    view = { scale: opening.scale, x: opening.x, y: opening.y };
    selected = "opening";
    render(false);
  }

  // The stage changed size (rotation, window resize, a browser toolbar collapsing or expanding): keep the view the
  // reader picked. Fit, Fill and the opening view are recomputed; a hand-picked zoom keeps the image point at the
  // centre of the screen where it is, within the new bounds.
  function relayout() {
    const before = stage;
    measure();
    if (Math.abs(stage.w - before.w) < 0.5 && Math.abs(stage.h - before.h) < 0.5) return;
    const old = view;
    views();
    if (selected === "fit") view = fit;
    else if (selected === "fill") view = fill;
    else if (selected === "opening") view = { scale: opening.scale, x: opening.x, y: opening.y };
    else {
      const ix = (before.w / 2 - old.x) / old.scale;
      const iy = (before.h / 2 - old.y) / old.scale;
      const scale = Math.min(limits.max, Math.max(limits.min, old.scale));
      view = clampView(stage, image, { scale, x: stage.w / 2 - ix * scale, y: stage.h / 2 - iy * scale });
    }
    render(false);
  }

  // How to move around a photo that can move: shown while the view can pan, until the reader has moved it once.
  function hint() {
    const show = !userPanned && canPan(stage, image, view);
    ui.hint.textContent = image.h * view.scale > stage.h + 0.5 && image.w * view.scale <= stage.w + 0.5 ? "Drag to scroll" : "Drag to pan";
    ui.dialog.toggleAttribute("data-hint", show);
  }

  // Called with the view before a pan: the hint goes once the photo has actually moved.
  function panned(before) {
    if (userPanned || (Math.abs(view.x - before.x) < 1 && Math.abs(view.y - before.y) < 1)) return;
    userPanned = true;
    hint();
  }

  function setLoading(on) {
    clearTimeout(loadingTimer);
    ui.dialog.removeAttribute("data-loading");
    if (on) loadingTimer = setTimeout(() => ui.dialog.setAttribute("data-loading", ""), 300);
  }

  function clearStatus() {
    ui.status.hidden = true;
  }

  // Show slide i. A slide whose preview isn't loaded yet is fetched first while the current photo, caption and
  // counter stay together on screen (a quiet "Loading" after 300ms); only a decoded preview replaces them, so the
  // photo never goes blank or mismatches its caption. If it fails, the current view stays and a Retry is offered.
  // Rapid presses ask for the latest slide; earlier pending loads are dropped.
  function show(i, announce) {
    const token = ++showToken;
    index = i;
    clearStatus();
    setDisabled(ui.prev, i === 0);
    setDisabled(ui.next, i === items.length - 1);
    if (i === showing) return setLoading(false);
    const link = items[i];
    const apply = () => {
      if (token !== showToken || !ui.dialog.open) return;
      setLoading(false);
      showing = i;
      present(link);
      const many = items.length > 1;
      ui.counter.textContent = many ? `${i + 1} / ${items.length}` : "";
      ui.counter.hidden = !many;
      ui.prev.hidden = !many;
      ui.next.hidden = !many;
      layout();
      if (announce) ui.live.textContent = `${i + 1} of ${items.length}: ${altOf(link)}`;
      warm(i + 1);
      warm(i - 1);
    };
    const thumb = link.querySelector("img");
    if (thumb && thumb.complete && thumb.naturalWidth > 0) return apply();
    setLoading(true);
    const pre = new Image();
    pre.src = previewOf(link);
    pre
      .decode()
      .then(apply)
      .catch(() => {
        if (token !== showToken || !ui.dialog.open) return;
        setLoading(false);
        ui.statusText.textContent = items.length > 1 ? `Couldn't load photo ${i + 1}.` : "Couldn't load this photo.";
        ui.status.hidden = false;
        ui.retry.onclick = () => {
          ui.retry.blur();
          show(i, announce);
          ui.dialog.focus();
        };
      });
  }

  function step(delta) {
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    show(next, true);
  }

  // ---- Opening and closing

  function open(link, { tap = false } = {}) {
    build();
    if (ui.dialog.open) return;
    if (tap) tapOpenedAt = performance.now();
    origin = link;
    carousel = link.closest("grug-carousel");
    items = carousel ? Array.from(carousel.querySelectorAll("a[data-zoom]")) : [link];
    index = Math.max(0, items.indexOf(link));
    scroll = [window.scrollX, window.scrollY];
    ui.live.textContent = "";
    // Labelled before it opens, so the first thing announced is the photo.
    ui.dialog.setAttribute("aria-label", altOf(link) || "Photo");
    ui.dialog.showModal();
    ui.dialog.focus();
    show(index, false);
  }

  function onClosed() {
    loadToken += 1;
    showToken += 1;
    setLoading(false);
    clearStatus();
    const target = items[showing] ?? origin;
    if (carousel && target !== origin && typeof carousel.goTo === "function") carousel.goTo(items.indexOf(target));
    target?.focus({ preventScroll: true });
    window.scrollTo(scroll[0], scroll[1]);
    ui.img.removeAttribute("src");
    items = [];
    showing = -1;
    carousel = null;
  }

  // ---- Input

  function wire({ dialog, stage: stageEl, close, prev, next, zoomIn, zoomOut, reset, fitfill }) {
    const centreZoom = (factor) => setView(zoomAt(stage, image, view, view.scale * factor, stage.w / 2, stage.h / 2, limits), true);
    const enabled = (el, run) => el.addEventListener("click", () => el.getAttribute("aria-disabled") !== "true" && run());
    close.addEventListener("click", () => dialog.close());
    enabled(prev, () => step(-1));
    enabled(next, () => step(1));
    enabled(zoomIn, () => centreZoom(1.5));
    enabled(zoomOut, () => centreZoom(1 / 1.5));
    enabled(reset, () => setView({ scale: opening.scale, x: opening.x, y: opening.y }, true, "opening"));
    fitfill.addEventListener("click", () => (near(view.scale, fit.scale) ? setView(fill, true, "fill") : setView(fit, true, "fit")));
    dialog.addEventListener("close", onClosed);
    // Any change to the stage's size, including iOS and in-app browser toolbars sliding in and out.
    new ResizeObserver(() => dialog.open && showing >= 0 && relayout()).observe(stageEl);

    // Tab and Shift+Tab cycle through the controls that are on screen.
    const focusables = () =>
      Array.from(dialog.querySelectorAll("button, a[href]")).filter(
        (el) => !el.closest("[hidden]") && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
      );

    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        const list = focusables();
        if (list.length === 0) return;
        const at = list.indexOf(document.activeElement);
        const to = event.shiftKey ? (at <= 0 ? list.length - 1 : at - 1) : at === -1 || at === list.length - 1 ? 0 : at + 1;
        event.preventDefault();
        list[to].focus();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const overflowX = image.w * view.scale > stage.w + 0.5;
      const overflowY = image.h * view.scale > stage.h + 0.5;
      const move = (dx, dy) => {
        const before = view;
        setView(panBy(stage, image, view, dx, dy), true);
        panned(before);
      };
      const key = event.key;
      if (key === "+" || key === "=") centreZoom(1.5);
      else if (key === "-" || key === "_") centreZoom(1 / 1.5);
      else if (key === "0") setView({ scale: opening.scale, x: opening.x, y: opening.y }, true, "opening");
      else if (key === "ArrowLeft") overflowX ? move(stage.w * 0.2, 0) : step(-1);
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
        if (event.ctrlKey) {
          setView(zoomAt(stage, image, view, view.scale * Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top, limits));
        } else if (canPan(stage, image, view)) {
          const before = view;
          setView(panBy(stage, image, view, -event.deltaX, -event.deltaY));
          panned(before);
        }
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
      if (gestureView) setView(zoomAt(stage, image, gestureView, gestureView.scale * event.scale, stage.w / 2, stage.h / 2, limits));
    });
    dialog.addEventListener("gestureend", (event) => event.preventDefault());

    // Touch, pen and mouse on the stage. A drag locks to pan, slide-nav or dismiss once it passes the slop and keeps
    // that meaning until release; two fingers pinch, and a finger left after a pinch only pans.
    const pointers = new Map();
    let gesture = null;
    let afterPinch = false;
    let lastTap = null;
    const at = (event) => {
      const rect = stageEl.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top, type: event.pointerType };
    };
    const startOne = (point, kind) => {
      gesture = { kind, start: view, origin: { x: point.x, y: point.y }, time: performance.now(), moved: kind !== "pending", type: point.type };
    };
    const feedback = (dx, dy) => {
      const ratio = dpr();
      ui.img.style.transition = "none";
      ui.img.style.transform = `translate3d(${Math.round((view.x + dx) * ratio) / ratio}px, ${Math.round((view.y + dy) * ratio) / ratio}px, 0)`;
      dialog.style.setProperty("--lightbox-fade", dy > 0 ? String(Math.max(0.35, 1 - dy / 400)) : "1");
    };
    stageEl.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      stageEl.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, at(event));
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        lastTap = null;
        afterPinch = true;
        gesture = { kind: "pinch", start: view, distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      } else {
        startOne(at(event), "pending");
      }
    });
    stageEl.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId) || !gesture) return;
      pointers.set(event.pointerId, at(event));
      const points = [...pointers.values()];
      if (gesture.kind === "pinch") {
        if (points.length < 2) return;
        const [a, b] = points;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const scale = (gesture.start.scale * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.distance;
        const zoomedView = zoomAt(stage, image, gesture.start, scale, gesture.mid.x, gesture.mid.y, limits);
        setView(panBy(stage, image, zoomedView, mid.x - gesture.mid.x, mid.y - gesture.mid.y));
        return;
      }
      const p = points[0];
      const dx = p.x - gesture.origin.x;
      const dy = p.y - gesture.origin.y;
      if (gesture.kind === "pending") {
        if (Math.hypot(dx, dy) <= 8) return;
        lastTap = null;
        gesture.moved = true;
        gesture.kind = lockGesture({
          dx,
          dy,
          overflowX: image.w * view.scale > stage.w + 0.5,
          overflowY: image.h * view.scale > stage.h + 0.5,
          touch: gesture.type === "touch",
          atRest: atRest(),
          slides: items.length,
          afterPinch,
        });
        ui.img.style.willChange = "transform";
      }
      if (gesture.kind === "pan") {
        const before = view;
        setView(panBy(stage, image, gesture.start, dx, dy));
        panned(before);
      } else if (gesture.kind === "nav") feedback(dx, 0);
      else if (gesture.kind === "dismiss") feedback(0, Math.max(0, dy));
    });
    const end = (event) => {
      if (!pointers.has(event.pointerId)) return;
      const point = pointers.get(event.pointerId);
      pointers.delete(event.pointerId);
      const finished = gesture;
      if (pointers.size > 0) {
        // A finger left after a pinch pans (if there is anywhere to pan) until it lifts too.
        startOne([...pointers.values()][0], afterPinch ? "pan" : "pending");
        return;
      }
      gesture = null;
      afterPinch = false;
      ui.img.style.willChange = "";
      dialog.style.removeProperty("--lightbox-fade");
      if (!finished || event.type === "pointercancel" || finished.kind === "pinch") return render(true);
      if (finished.kind === "pending") {
        if (performance.now() - finished.time < 350) tap(point);
        return;
      }
      const action = releaseGesture(finished.kind, point.x - finished.origin.x, point.y - finished.origin.y);
      if (action === "close") return dialog.close();
      if (action === "next" && index < items.length - 1) return show(index + 1, true);
      if (action === "prev" && index > 0) return show(index - 1, true);
      render(true);
    };
    stageEl.addEventListener("pointerup", end);
    stageEl.addEventListener("pointercancel", end);

    // A tap outside the photo closes (at rest); two quick taps toggle zoom at that point.
    let closePending = false;
    const closeIfPending = () => {
      if (!closePending) return;
      closePending = false;
      dialog.close();
    };
    // Close on the tap's own click (still aimed at the stage), so no follow-up mouse event reaches the page.
    stageEl.addEventListener("click", closeIfPending);
    function tap(point) {
      const now = performance.now();
      if (lastTap && now - lastTap.time < 320 && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < 40) {
        lastTap = null;
        closePending = false;
        const toggled = toggleZoom(stage, image, view, opening, point.x, point.y, limits);
        setView(toggled, true, modeOf(toggled));
        return;
      }
      lastTap = { ...point, time: now };
      const inside =
        point.x >= view.x && point.x <= view.x + image.w * view.scale && point.y >= view.y && point.y <= view.y + image.h * view.scale;
      if (!inside && atRest()) {
        closePending = true;
        setTimeout(closeIfPending, 400);
      }
    }
  }

  // ---- Page hooks: click (Enter) and Space on any zoomable Figure; carousels open it on a touch tap themselves

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[data-zoom]") : null;
    if (!link || typeof HTMLDialogElement !== "function") return;
    event.preventDefault();
    // The click that may follow a carousel's touch tap is the same press: the viewer is already open.
    if (performance.now() - tapOpenedAt < 700) return;
    open(link);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== " " || !(event.target instanceof Element) || !event.target.matches("a[data-zoom]")) return;
    event.preventDefault();
    open(event.target);
  });
  window.grugViewer = { open };
})();
