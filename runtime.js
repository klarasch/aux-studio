/* makeitbrand runtime.js — upstream-owned, replaced whole on update.
 *
 * Sheet view (boards at true size, scaled to fit, tabs, zoom), edit mode (plain-text editing,
 * ⌘B highlight, undo, data-bind propagation, data-note chips), overflow marking, export
 * (per-board PNG at 2x through SVG foreignObject; a PDF per medium built from those rasters),
 * print layout for headless vector PDF (?mib-print), Copy changes and Download HTML.
 * Diagram edges and charts are drawn by the renderers registered in `RENDER`.
 */
(() => {
  "use strict";

  // Host mode (window.makeitbrandHost = true, set before this script): another shell owns the page
  // (the studio editor) and mounts boards itself. Only the board kit runs: decorate, renderers,
  // overflow check, export. No sheet chrome, no keys. The detached <main> stands in for the sheet.
  const hosted = window.makeitbrandHost === true;
  const sheet = document.querySelector("main.sheet") || (hosted ? document.createElement("main") : null);
  if (!sheet || sheet.dataset.mibBooted || (hosted && window.makeitbrand)) return;
  sheet.dataset.mibBooted = "";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const h = (tag, attrs = {}, html = "") => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    if (html) el.innerHTML = html;
    return el;
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const slug = s => (s || "board").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-") || "board";
  const cssVar = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();
  // a board's px size from its profile, which resolves even while its frame is hidden (offsetWidth is 0 then)
  const boardSize = b => [parseFloat(cssVar(b, "--board-w")) || b.offsetWidth, parseFloat(cssVar(b, "--board-h")) || b.offsetHeight];
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  /* derived attributes: written by the runtime, never by authors (PRIMITIVES.md §13) */
  const STRIP_ATTRS = ["contenteditable", "spellcheck", "data-drop", "data-edited", "data-empty", "data-g", "data-ink", "data-va", "data-off", "data-num", "data-gen", "data-mib-scale", "data-mib-icon", "data-mib-illo", "data-mib-media"];
  const STYLE_OWNED = ".board, .node, .group, .note, .edge";
  const PROFILE_VARS = ["--safe-t", "--safe-r", "--safe-b", "--safe-l", "--k", "--floor", "--logo-h", "--ground-default", "--v-default", "--dpi"];
  const EDITABLE = [
    ".eyebrow", ".display", ".h1", ".h2", ".h3", ".lead", ".body", ".caption", ".chip",
    ".list > li", ".table th", ".table td", ".tile__value", ".tile__delta", ".edge",
  ].join(",");
  const BREAKABLE = ".display, .h1, .h2, .h3";

  const RENDER = {};           // name -> fn(board): phase 3 renderers register here
  let boards = [];
  let editing = false;
  let zoom = "fit";
  let activeTab = "all";

  /* ============================================================ board decoration */

  const probeCache = new Map();
  function profileOf(medium) {
    if (probeCache.has(medium)) return probeCache.get(medium);
    const probe = h("section", { class: "board", "data-medium": medium, "data-ui": "", style: "position:absolute;visibility:hidden;left:-99999px" });
    document.body.appendChild(probe);
    const vals = Object.fromEntries(PROFILE_VARS.map(v => [v, cssVar(probe, v)]));
    vals.known = !!vals["--k"];
    probe.remove();
    probeCache.set(medium, vals);
    return vals;
  }

  function invalid(el, reason) { el.setAttribute("data-invalid", reason); }

  function decorate(b) {
    b.removeAttribute("data-invalid");
    let medium = b.dataset.medium;
    if (medium === "custom") {
      const like = b.dataset.like, w = parseInt(b.dataset.w), hh = parseInt(b.dataset.h);
      if (!like || !profileOf(like).known) invalid(b, "custom board needs a known data-like");
      if (!(w > 0 && hh > 0)) invalid(b, "custom board needs data-w and data-h");
      const p = like ? profileOf(like) : {};
      for (const v of PROFILE_VARS) if (p[v]) b.style.setProperty(v, p[v]);
      if (w > 0) b.style.setProperty("--board-w", w + "px");
      if (hh > 0) b.style.setProperty("--board-h", hh + "px");
    } else if (!medium || !profileOf(medium).known) {
      invalid(b, `unknown data-medium "${medium || ""}"`);
    }

    const g = b.dataset.ground || cssVar(b, "--ground-default") || "bg";
    b.setAttribute("data-g", g);
    // data-ink: which token set a transparent or art ground uses, `bg` or `inverse`, decided by
    // whether that ground is dark and whether the brand's own --bg is dark
    const bgDark = cssVar(b, "--bg-tone") === "dark";
    if (g === "transparent") b.setAttribute("data-ink", (cssVar(b, "--inset-ground") === "dark") === bgDark ? "bg" : "inverse");
    else if (g === "art") b.setAttribute("data-ink", cssVar(b, "--art-ink") === "inverse" ? "inverse" : "bg");
    else b.removeAttribute("data-ink");
    b.setAttribute("data-va", b.dataset.v || cssVar(b, "--v-default") || "bottom");
    const off = [];
    if (parseFloat(cssVar(b, "--logo-h")) === 0) off.push("logo");
    off.length ? b.setAttribute("data-off", off.join(" ")) : b.removeAttribute("data-off");

    $$(".logo", b).forEach(l => fillLogo(l, b));
    $$(".lockup", b).forEach(l => {
      $$(":scope > .lockup__plus", l).forEach(n => n.remove());
      [...l.children].slice(1).forEach(c => c.before(h("i", { class: "lockup__plus", "data-gen": "", "aria-hidden": "true" }, "+")));
    });
    $$(".icon[data-icon]", b).forEach(fillIcon);
    $$("figure.illo", b).forEach(fillIllo);
    checkIlloContainment(b);
    $$(".table td", b).forEach(td => {
      if (/^[\s€$£¥+\-−~≈]*[\d][\d.,\s]*\s*(%|k|m|bn|x|×|h|min|s)?$/i.test(td.textContent.trim())) td.setAttribute("data-num", "");
      else td.removeAttribute("data-num");
    });
    $$("figure.media", b).forEach(decorateMedia);
    for (const fn of Object.values(RENDER)) {
      try { fn(b); } catch (e) { console.error("[makeitbrand] renderer failed", e); }
    }
  }

  // figure.media is a drop target and a button: click, Enter or Space opens a file picker, dropping
  // an image file fills or replaces it (see the media block under edit mode). The tabindex, role and
  // label are derived (data-mib-media marks them) and cleanBoard strips them again.
  function decorateMedia(m) {
    m.toggleAttribute("data-empty", !m.querySelector("img"));
    if (m.hasAttribute("data-mib-media") || m.hasAttribute("tabindex")) return;
    m.setAttribute("data-mib-media", "");
    m.setAttribute("tabindex", "0");
    if (!m.hasAttribute("role")) m.setAttribute("role", "button");
    if (!m.hasAttribute("aria-label")) m.setAttribute("aria-label", m.querySelector("img") ? "Replace image" : "Add image");
  }

  function logoVariant(logo, b) {
    const v = logo.dataset.variant;
    if (v && v !== "auto") return v;
    const g = b.getAttribute("data-g");
    if (g === "accent") return "mono";
    const bgDark = cssVar(b, "--bg-tone") === "dark";
    const inverted = g === "inverse" || ((g === "transparent" || g === "art") && b.getAttribute("data-ink") === "inverse");
    return bgDark !== inverted ? "light" : "dark";
  }

  // A relative url() inside a custom property resolves against the stylesheet that declares it,
  // which getComputedStyle can't tell us, so find the declaring sheet and resolve against its href.
  const tokenBase = new Map();
  function baseFor(name, raw) {
    const key = name + raw;
    if (tokenBase.has(key)) return tokenBase.get(key);
    let base = location.href;
    const walk = (rules, href) => {
      for (const r of rules) {
        if (r.style?.getPropertyValue(name).trim() === raw) { base = href; return true; }
        if (r.cssRules?.length && walk(r.cssRules, href)) return true;
      }
    };
    for (const s of document.styleSheets) {
      try { if (walk(s.cssRules, s.href || location.href)) break; } catch { /* cross-origin sheet */ }
    }
    tokenBase.set(key, base);
    return base;
  }

  function fillLogo(logo, b) {
    $$("[data-gen]", logo).forEach(n => n.remove());
    const name = `--logo-${logoVariant(logo, b)}`;
    const raw = cssVar(logo, name);
    const m = /^url\(\s*(['"]?)(.*?)\1\s*\)$/.exec(raw);
    if (!m) return;
    const src = m[2].startsWith("data:") ? m[2] : new URL(m[2], baseFor(name, raw)).href;
    logo.appendChild(h("img", { src, alt: "", "data-gen": "" }));
  }

  // Icon and illustration fills resolve a css url() token and load it. In an inlined sheet (what
  // sheet.py ships, and what export.py screenshots) that token is always a data: URI already, so
  // decode it synchronously — a real fetch(), even of a data: URI, is a macrotask, and headless
  // Chrome's --screenshot has no way to wait on one (export.py's own header comment). A dev-form
  // sheet (a relative asset path) still needs a real fetch; track those so the ready signal below
  // can wait for them, instead of racing a screenshot against a fetch that hasn't resolved.
  const pendingAssetFetches = new Set();
  function trackAsset(p) {
    pendingAssetFetches.add(p);
    p.finally(() => pendingAssetFetches.delete(p));
    return p;
  }
  async function assetsIdle() {
    for (let i = 0; i < 20 && pendingAssetFetches.size; i++) await Promise.all([...pendingAssetFetches]);
  }
  function decodeDataUri(url) {
    const m = /^data:[^,]*?(;base64)?,([\s\S]*)$/.exec(url);
    if (!m) return "";
    try {
      return m[1] ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), c => c.charCodeAt(0))) : decodeURIComponent(m[2]);
    } catch { return ""; }
  }
  // Runs `apply(src)` in the same tick when `url` is a data: URI (true for every inlined sheet —
  // sheet.py always converts these tokens to data: URIs), so there is no promise/microtask lag
  // between mountBoards() laying a board out and the icon/illustration content landing in it.
  // Chrome's headless --screenshot has no hook to await a later microtask (export.py's header
  // comment) and has been observed to rasterize a frame from just before such a late mutation even
  // though a --dump-dom taken moments later shows the DOM already correct — so for the case that
  // matters at export time (an inlined sheet), skip the promise entirely rather than resolve it
  // fast. A dev-form sheet (a relative asset path) still needs a real, tracked fetch.
  const remoteAssetCache = new Map();
  function loadAsset(url, apply) {
    if (url.startsWith("data:")) { apply(decodeDataUri(url)); return; }
    if (!remoteAssetCache.has(url)) remoteAssetCache.set(url, trackAsset(fetch(url).then(r => r.text()).catch(() => "")));
    remoteAssetCache.get(url).then(apply);
  }

  function fillIcon(el) {
    const name = el.dataset.icon, token = `--icon-${name}`;
    const raw = cssVar(el, token);
    const m = /^url\(\s*(['"]?)(.*?)\1\s*\)$/.exec(raw);
    if (!m) { $$("[data-gen]", el).forEach(n => n.remove()); return invalid(el, `unknown icon "${name}"`); }
    el.removeAttribute("data-invalid");
    const url = m[2].startsWith("data:") ? m[2] : new URL(m[2], baseFor(token, raw)).href;
    if (el.dataset.mibIcon === url && el.querySelector("svg")) return;
    loadAsset(url, src => {
      const doc = new DOMParser().parseFromString(src, "image/svg+xml").documentElement;
      if (!doc || doc.nodeName !== "svg") return invalid(el, `icon "${name}" is not an SVG`);
      doc.removeAttribute("width"); doc.removeAttribute("height");
      doc.setAttribute("data-gen", ""); doc.setAttribute("aria-hidden", "true");
      $$("[data-gen]", el).forEach(n => n.remove());
      el.appendChild(document.importNode(doc, true));
      el.dataset.mibIcon = url;
    });
  }

  /* ---------- illustrations: figure.illo, library or authored (PRIMITIVES.md §6b, BRANDING.md §1b)
   * Library mode resolves a brand token like an icon; authored mode validates the author's own
   * inline <svg> child. Either way the result is checked for containment (always) and, unless
   * data-free, for brand-only colours (fill/stroke/stop-color) and a var(--stroke)-scaled stroke
   * width. data-free never relaxes the structural rules: viewBox, no text/image/foreignObject, no
   * reference outside the board.
   *
   * COUPLING: sheet.py's `--promote-illo` runs this same rule set in Python (stdlib only, no DOM)
   * before promoting an authored illustration into the brand library, so a promoted svg can never
   * carry something the runtime would reject at render time. If you change ILLO_COLOR_TOKEN,
   * ILLO_STROKE_W or illoSvgReason() here, change illo_svg_reason() and its two regexes in
   * sheet.py to match, and vice versa. */
  const ILLO_COLOR_TOKEN = /^var\(\s*--(illo-[1-4]|chart-accent|accent|accent-2|fg|bg|muted|faint|surface)\s*(,[^)]*)?\)$/;
  const ILLO_STROKE_W = /^(var\(\s*--stroke\s*\)|calc\(\s*var\(\s*--stroke\s*\)\s*\*\s*[\d.]+\s*\))$/;
  function illoColorOk(v) {
    if (v == null) return true;
    v = v.trim();
    return v === "" || v === "none" || v === "currentColor" || ILLO_COLOR_TOKEN.test(v);
  }
  function illoSvgReason(svg, free) {
    if (!svg.getAttribute("viewBox")) return "illustration needs a viewBox";
    if (svg.querySelector("text, image, foreignObject")) return "illustration may not contain text, image or foreignObject";
    for (const el of [svg, ...svg.querySelectorAll("*")]) {
      for (const attr of ["href", "xlink:href"]) {
        const v = el.getAttribute(attr);
        if (v && !v.startsWith("#")) return "illustration may not reference anything outside the board";
      }
      if (free) continue;
      const swAttr = el.getAttribute("stroke-width");
      if (swAttr && !ILLO_STROKE_W.test(swAttr.trim())) return "stroke-width must be var(--stroke), scaled with calc()";
      const swStyle = el.style?.getPropertyValue("stroke-width");
      if (swStyle && !ILLO_STROKE_W.test(swStyle.trim())) return "stroke-width must be var(--stroke), scaled with calc()";
      for (const prop of ["fill", "stroke", "stop-color"]) {
        const av = el.getAttribute(prop);
        if (av && !illoColorOk(av)) return `illustration uses a hard-coded ${prop} colour`;
        const sv = el.style?.getPropertyValue(prop);
        if (sv && !illoColorOk(sv)) return `illustration uses a hard-coded ${prop} colour`;
      }
    }
    return null;
  }

  function fillIllo(fig) {
    const free = fig.hasAttribute("data-free");
    const name = fig.dataset.illo;
    if (!name) {
      // authored mode: the figure's own inline <svg> child
      $$("[data-gen]", fig).forEach(n => n.remove());
      const svg = $(":scope > svg", fig);
      if (!svg) return invalid(fig, "figure.illo needs data-illo or an inline svg");
      const reason = illoSvgReason(svg, free);
      return reason ? invalid(fig, reason) : fig.removeAttribute("data-invalid");
    }
    // library mode: resolve like an icon, then validate the fetched svg the same way
    const token = `--illo-${name}`;
    const raw = cssVar(fig, token);
    const m = /^url\(\s*(['"]?)(.*?)\1\s*\)$/.exec(raw);
    if (!m) { $$("[data-gen]", fig).forEach(n => n.remove()); return invalid(fig, `unknown illustration "${name}"`); }
    const url = m[2].startsWith("data:") ? m[2] : new URL(m[2], baseFor(token, raw)).href;
    const cacheKey = url + (free ? "|free" : "");
    if (fig.dataset.mibIllo === cacheKey && $(":scope > svg[data-gen]", fig)) return;
    loadAsset(url, src => {
      const doc = new DOMParser().parseFromString(src, "image/svg+xml").documentElement;
      $$(":scope > svg", fig).forEach(n => n.remove());
      if (!doc || doc.nodeName !== "svg") return invalid(fig, `illustration "${name}" is not an SVG`);
      const reason = illoSvgReason(doc, free);
      if (reason) return invalid(fig, reason);
      doc.removeAttribute("width"); doc.removeAttribute("height");
      doc.setAttribute("data-gen", ""); doc.setAttribute("aria-hidden", "true");
      fig.appendChild(document.importNode(doc, true));
      fig.dataset.mibIllo = cacheKey;
      fig.removeAttribute("data-invalid");
    });
  }

  // any inline <svg> anywhere in a board must be runtime-generated (data-gen: icons, charts, edges)
  // or live inside figure.illo (validated above) — PRIMITIVES.md §12, §6b
  function checkIlloContainment(b) {
    $$("svg", b).forEach(svg => {
      if (svg.hasAttribute("data-gen") || svg.closest(".illo")) return;
      invalid(svg, "inline svg is only allowed inside figure.illo");
    });
  }

  /* ---------- diagram placement (edges: RENDER.diagram in phase 3) */
  function cell(v, def = [1, 1]) {
    const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(v || "");
    return m ? [+m[1], +m[2]] : v ? null : def;
  }
  RENDER.place = b => {
    $$(".diagram", b).forEach(d => {
      const cols = +d.dataset.cols || 4, rows = +d.dataset.rows || 3;
      $$(":scope > .node, :scope > .group, :scope > .note", d).forEach(n => {
        const at = cell(n.dataset.at, null), span = cell(n.dataset.span);
        if (!at || !span) return invalid(n, "data-at / data-span must be col,row");
        if (at[0] + span[0] - 1 > cols || at[1] + span[1] - 1 > rows) invalid(n, "outside the diagram grid");
        else n.removeAttribute("data-invalid");
        n.style.gridColumn = `${at[0]} / span ${span[0]}`;
        n.style.gridRow = `${at[1]} / span ${span[1]}`;
      });
    });
    $$("figure.chart", b).forEach(f => {
      if (!$(":scope > .mib-plot", f)) f.prepend(h("div", { class: "mib-plot", "data-gen": "" }));
    });
  };

  /* ============================================================ chrome kit */

  // 16px stroke icons for the sheet chrome (never exported)
  const ICON = {
    edit: '<path d="M3 13h2.6L13 5.6a1.8 1.8 0 0 0-2.6-2.6L3 10.4z"/><path d="M9.5 4l2.5 2.5"/>',
    done: '<path d="M3.5 8.5l3 3 6-7"/>',
    undo: '<path d="M6 10L3 7l3-3"/><path d="M3 7h6.5a3.5 3.5 0 0 1 0 7H8"/>',
    note: '<path d="M3.5 3h9v7l-3 3h-6z"/><path d="M9.5 13v-3h3"/>',
    copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M10.5 3.5v-.5A1 1 0 0 0 9.5 2H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h.5"/>',
    download: '<path d="M8 2.5v7.5"/><path d="M5 7.5L8 10.5l3-3"/><path d="M3 12.5v.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-.5"/>',
    file: '<path d="M9 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5z"/><path d="M9 2v3.5h3.5"/>',
    warn: '<path d="M8 2.5l6 11H2z"/><path d="M8 7v3M8 12h.01"/>',
    prev: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
    next: '<path d="M6 3.5L10.5 8 6 12.5"/>',
    chevron: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.1"/><path d="M13.5 10.5l-3-3L4 13"/>',
    pages: '<path d="M6 2.5h4.5l3 3v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M10.5 2.5v3h3"/><path d="M2.5 5.5v8a1 1 0 0 0 1 1H9"/>',
    crop: '<path d="M4.5 1.5v10h10"/><path d="M1.5 4.5h10v10"/>',
  };
  const icon = name => `<svg class="mib-i" viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`;

  // a chrome button: icon, optional visible label, tooltip text and shortcut
  function cbtn({ id, name, label, tip, kbd, onclick, cls = "" }) {
    const b = h("button", { class: `mib-cbtn ${label ? "has-label" : ""} ${cls}`.trim(), type: "button", "aria-label": tip || label, onclick });
    if (id) b.id = id;
    if (tip) b.dataset.tip = tip;
    if (kbd) b.dataset.kbd = kbd;
    b.innerHTML = (name ? icon(name) : "") + (label ? `<span>${esc(label)}</span>` : "");
    return b;
  }

  const tipEl = h("div", { class: "mib-tip", "data-ui": "", role: "tooltip", hidden: "" });
  document.addEventListener("mouseover", e => {
    const t = e.target.closest?.("[data-tip]");
    if (!t || pop) { tipEl.hidden = true; return; }
    tipEl.innerHTML = esc(t.dataset.tip) + (t.dataset.kbd ? `<kbd>${esc(t.dataset.kbd)}</kbd>` : "");
    tipEl.hidden = false;
    const r = t.getBoundingClientRect(), w = tipEl.offsetWidth;
    const below = r.top < 80;
    tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    tipEl.style.top = (below ? r.bottom + 8 : r.top - tipEl.offsetHeight - 8) + "px";
  });

  // the chrome follows the surround: light chrome on a light --app-bg, dark on a dark one
  function chromeTone() {
    const c = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)?.map(Number) || [255, 255, 255];
    const lin = v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    const lum = .2126 * lin(c[0]) + .7152 * lin(c[1]) + .0722 * lin(c[2]);
    document.documentElement.dataset.mibChrome = lum < .35 ? "dark" : "light";
  }

  /* ============================================================ sheet view */

  const bar = h("div", { class: "mib-bar", "data-ui": "" });
  const toastEl = h("div", { class: "mib-toast", "data-ui": "", hidden: "" });

  function toast(msg, ms = 2600) {
    toastEl.innerHTML = icon("check") + `<span>${esc(msg)}</span>`;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (toastEl.hidden = true), ms);
  }

  function frameOf(b) { return b.closest(".mib-frame"); }

  function mountBoards() {
    boards = $$(":scope > .board, :scope > .mib-frame > .mib-stage > .board", sheet);
    const used = new Map();
    boards.forEach((b, i) => {
      let frame = frameOf(b);
      if (!frame) {
        frame = h("div", { class: "mib-frame", "data-ui": "" });
        const stage = h("div", { class: "mib-stage" });
        const barEl = h("div", { class: "mib-frame__bar" });
        b.before(frame);
        stage.appendChild(b);
        frame.append(barEl, stage);
      }
      decorate(b);
      const title = b.dataset.title || `Board ${i + 1}`;
      const n = (used.get(title) || 0) + 1;
      used.set(title, n);
      const barEl = $(".mib-frame__bar", frame);
      const w = b.offsetWidth, hh = b.offsetHeight;
      barEl.innerHTML = "";
      barEl.append(
        h("span", { class: "mib-frame__title" }, esc(title)),
        h("span", { class: "mib-frame__meta" }, `${esc(b.dataset.medium || "")}<i></i>${w} × ${hh}${b.hasAttribute("data-template") ? "<i></i>template" : ""}`),
        h("span", { class: "mib-frame__warn", "data-warn": "" }),
        cbtn({ name: "download", label: "PNG", tip: "Download this board at 2×", cls: "mib-frame__png", onclick: () => exportBoard(b) }),
      );
      if (n > 1) $("[data-warn]", barEl).textContent = "duplicate data-title";
      $(".mib-stage", frame).classList.toggle("is-transparent", b.getAttribute("data-g") === "transparent");
    });
    if (editing) setEditable(true);
    renderTabs();
    fit();
    renderNotes();
    checkAll();
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

  function fit() {
    if (document.documentElement.classList.contains("mib-solo")) return;
    const avail = Math.max(200, sheet.clientWidth - 48);
    const maxH = Math.max(240, window.innerHeight - 170);
    for (const b of boards) {
      const w = b.offsetWidth, hh = b.offsetHeight;
      const s = zoom === "fit" ? Math.min(1, avail / w, maxH / hh) : +zoom;
      const stage = b.parentElement;
      stage.style.width = w * s + "px";
      stage.style.height = hh * s + "px";
      b.style.transform = `scale(${s})`;
      b.dataset.mibScale = s;
    }
    renderNotes();
  }

  // A board's name in the chrome: a batch template shows as what it is, not as "Nametag {name}"
  const boardLabel = (b, i) => b.hasAttribute("data-template")
    ? (b.dataset.title || "Board").replace(/\s*\{[^}]*\}\s*/g, " ").trim() || "Template"
    : b.dataset.title || `Board ${i + 1}`;

  function renderTabs() {
    const nav = $(".mib-nav", bar);
    if (!nav || document.documentElement.classList.contains("mib-solo")) return applyTab();
    if (activeTab !== "all" && !boards[+activeTab]) activeTab = "all";
    nav.hidden = boards.length < 2;
    const focused = activeTab !== "all";
    const i = +activeTab;
    $(".mib-pick__label", nav).textContent = focused ? boardLabel(boards[i], i) : "All boards";
    $(".mib-pick__pos", nav).textContent = focused ? `${i + 1} / ${boards.length}` : String(boards.length);
    $("#mib-prev", nav).disabled = focused ? i === 0 : false;
    $("#mib-next", nav).disabled = focused ? i === boards.length - 1 : false;
    applyTab();
  }

  function showBoard(key) {
    activeTab = key;
    renderTabs();
    fit();
    window.scrollTo({ top: 0 });
  }

  function stepBoard(d) {
    if (boards.length < 2) return;
    const i = activeTab === "all" ? (d > 0 ? -1 : boards.length) : +activeTab;
    const n = Math.max(0, Math.min(boards.length - 1, i + d));
    showBoard(String(n));
  }

  /* ---------- board picker: a searchable list, for sheets with many boards */
  let pop = null;
  function closePicker() {
    pop?.remove(); pop = null;
    $$(".mib-pick, .mib-cbtn--export", bar).forEach(x => x.setAttribute("aria-expanded", "false"));
  }
  function openPicker() {
    if (pop) { const kind = pop.dataset.kind; closePicker(); if (kind === "boards") return; }
    const btn = $(".mib-pick", bar);
    btn.setAttribute("aria-expanded", "true");
    pop = h("div", { class: "mib-pop", "data-ui": "", "data-kind": "boards", role: "dialog", "aria-label": "Boards" });
    const search = boards.length > 7 ? h("input", { class: "mib-pop__search", type: "search", placeholder: `Find among ${boards.length} boards`, "aria-label": "Find a board" }) : null;
    const list = h("div", { class: "mib-pop__list", role: "listbox" });
    const items = [];
    const row = (key, label, meta, badge) => {
      const on = activeTab === key;
      const it = h("button", { type: "button", class: "mib-pop__item" + (on ? " is-on" : ""), role: "option", "aria-selected": String(on) },
        `<span class="mib-pop__n">${key === "all" ? "" : +key + 1}</span><span class="mib-pop__t">${esc(label)}</span>${badge ? `<span class="mib-badge">${badge}</span>` : ""}<span class="mib-pop__m">${meta}</span>`);
      it.addEventListener("click", () => { closePicker(); showBoard(key); });
      it.dataset.q = label.toLowerCase();
      items.push(it);
      list.appendChild(it);
    };
    row("all", "All boards", `${boards.length}`);
    boards.forEach((b, i) => {
      const invalidOrOver = b.hasAttribute("data-overflow") || b.hasAttribute("data-invalid");
      row(String(i), boardLabel(b, i), `${esc(b.dataset.medium || "")} <i></i> ${b.offsetWidth}×${b.offsetHeight}`,
        b.hasAttribute("data-template") ? "Template" : invalidOrOver ? "Check" : "");
    });
    let cursor = Math.max(0, items.findIndex(x => x.classList.contains("is-on")));
    const visible = () => items.filter(x => !x.hidden);
    const mark = () => { const v = visible(); items.forEach(x => x.classList.remove("is-cursor")); if (v[cursor]) { v[cursor].classList.add("is-cursor"); v[cursor].scrollIntoView({ block: "nearest" }); } };
    if (search) {
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        items.forEach((x, k) => { x.hidden = k === 0 ? !!q : !x.dataset.q.includes(q); });
        cursor = 0; mark();
      });
      pop.appendChild(search);
    }
    pop.appendChild(list);
    pop.addEventListener("keydown", e => {
      const v = visible();
      if (e.key === "ArrowDown") { e.preventDefault(); cursor = Math.min(v.length - 1, cursor + 1); mark(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cursor = Math.max(0, cursor - 1); mark(); }
      else if (e.key === "Enter") { e.preventDefault(); v[cursor]?.click(); }
      else if (e.key === "Escape") { e.preventDefault(); closePicker(); btn.focus(); }
    });
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = r.bottom + 6 + "px";
    pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left)) + "px";
    mark();
    (search || items[cursor] || items[0]).focus();
  }
  document.addEventListener("mousedown", e => { if (pop && !pop.contains(e.target) && !e.target.closest(".mib-pick, .mib-cbtn--export")) closePicker(); });

  /* ---------- export menu: PNG images, or one PDF per medium (a PDF's pages share a size) */
  function openExport() {
    if (pop) { const kind = pop.dataset.kind; closePicker(); if (kind === "export") return; }
    const list = boards.filter(b => !b.hasAttribute("data-template"));
    if (!list.length) return toast("Nothing to export");
    const btn = $(".mib-cbtn--export", bar);
    btn.setAttribute("aria-expanded", "true");
    tipEl.hidden = true;
    pop = h("div", { class: "mib-pop mib-pop--menu", "data-ui": "", "data-kind": "export", role: "menu", "aria-label": "Export" });
    const menu = h("div", { class: "mib-pop__list" });
    const items = [];
    const item = (name, label, meta, run) => {
      const it = h("button", { type: "button", class: "mib-pop__item", role: "menuitem" },
        `<span class="mib-pop__n">${icon(name)}</span><span class="mib-pop__t">${esc(label)}</span><span class="mib-pop__m">${meta}</span>`);
      it.addEventListener("click", () => { closePicker(); run(); });
      items.push(it);
      menu.appendChild(it);
    };
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    item("image", "PNG images", `${plural(list.length, "file", "files")}<i></i>one per board`, downloadAll);
    for (const g of pdfGroups()) {
      const meta = size => [esc(g.label), plural(g.list.length, "page", "pages"), size].filter(Boolean).join("<i></i>");
      if (g.print) {
        item("pages", "PDF, trim size", meta(g.size), () => exportPDF(g));
        item("crop", "PDF with bleed", meta(g.bleedSize), () => exportPDF(g, true));
      } else {
        item("pages", "PDF document", meta(g.size), () => exportPDF(g));
      }
    }
    pop.appendChild(menu);
    let cursor = 0;
    const mark = () => items.forEach((x, k) => x.classList.toggle("is-cursor", k === cursor));
    pop.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); cursor = (cursor + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; mark(); items[cursor].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); closePicker(); btn.focus(); }
    });
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = r.bottom + 6 + "px";
    pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + "px";
    items[0].focus();
  }
  function applyTab() {
    boards.forEach((b, i) => { frameOf(b).hidden = !(activeTab === "all" || +activeTab === i); });
  }

  function mountBar() {
    const title = document.title || "Sheet";
    const mod = isMac ? "⌘" : "Ctrl ";
    bar.innerHTML = "";
    const zoomSeg = h("div", { class: "mib-seg", role: "group", "aria-label": "Zoom" });
    for (const [v, l, tip] of [["fit", "Fit", "Fit boards to the window"], ["0.5", "50%", "Half size"], ["1", "100%", "Actual size"]]) {
      const b = h("button", { type: "button", class: "mib-seg__b", "data-zoom": v, "data-tip": tip, "aria-pressed": String(zoom === v) }, l);
      b.addEventListener("click", () => {
        zoom = v;
        $$(".mib-seg__b", zoomSeg).forEach(x => x.setAttribute("aria-pressed", String(x.dataset.zoom === v)));
        fit();
      });
      zoomSeg.appendChild(b);
    }
    const n = $$(":scope > .board, :scope > .mib-frame > .mib-stage > .board", sheet).length;
    const nav = h("div", { class: "mib-nav" });
    const arrows = h("div", { class: "mib-nav__arrows" });
    arrows.append(
      cbtn({ id: "mib-prev", name: "prev", tip: "Previous board", kbd: "←", onclick: () => stepBoard(-1) }),
      cbtn({ id: "mib-next", name: "next", tip: "Next board", kbd: "→", onclick: () => stepBoard(1) }),
    );
    nav.append(
      h("button", { type: "button", class: "mib-pick", "aria-haspopup": "dialog", "aria-expanded": "false", "data-tip": "Jump to a board", onclick: openPicker },
        `<span class="mib-pick__label">All boards</span><span class="mib-pick__pos"></span>${icon("chevron")}`),
      arrows,
    );
    bar.append(
      h("div", { class: "mib-bar__id" }, `<span class="mib-bar__title">${esc(title)}</span><span class="mib-bar__count">${n} ${n === 1 ? "board" : "boards"}</span>`),
      nav,
      h("div", { class: "mib-bar__tools" }),
    );
    $(".mib-bar__tools", bar).append(
      zoomSeg,
      h("span", { class: "mib-sep mib-sep--zoom" }),
      cbtn({ id: "mib-edit", name: "edit", label: "Edit", tip: "Edit text", kbd: "E", onclick: () => toggleEdit() }),
      cbtn({ id: "mib-undo", name: "undo", tip: "Undo", kbd: `${mod}Z`, onclick: undo }),
      cbtn({ id: "mib-note", name: "note", tip: "Note for Claude on the selected text", kbd: "N", onclick: () => noteDialog() }),
      h("span", { class: "mib-sep" }),
      cbtn({ name: "copy", label: "Copy changes", tip: "Copy the boards as markup to paste back into the chat", cls: "mib-cbtn--copy", onclick: copyChanges }),
      cbtn({ name: "file", tip: "Save this sheet with your edits", cls: "mib-cbtn--save", onclick: downloadHTML }),
      cbtn({ name: "download", label: "Export", tip: "Download the boards as PNG or PDF", cls: "is-primary mib-cbtn--export", onclick: openExport }),
    );
    const exp = $(".mib-cbtn--export", bar);
    exp.setAttribute("aria-haspopup", "menu");
    exp.setAttribute("aria-expanded", "false");
    exp.insertAdjacentHTML("beforeend", icon("chevron"));
    $("#mib-undo", bar).disabled = true;
    $("#mib-note", bar).hidden = !editing;
    document.body.append(bar, toastEl, tipEl);
    chromeTone();
    new ResizeObserver(() => { sheet.style.paddingTop = bar.offsetHeight + 36 + "px"; }).observe(bar);
  }

  /* ============================================================ overflow */

  function checkBoard(b) {
    $$("[data-overflow]", b).forEach(n => n.removeAttribute("data-overflow"));
    b.removeAttribute("data-overflow");
    const s = +b.dataset.mibScale || 1;
    const br = b.getBoundingClientRect(), cs = getComputedStyle(b);
    const top = br.top + parseFloat(cs.paddingTop) * s - 1, bottom = br.bottom - parseFloat(cs.paddingBottom) * s + 1;
    const left = br.left + parseFloat(cs.paddingLeft) * s - 1, right = br.right - parseFloat(cs.paddingRight) * s + 1;
    let over = false;
    for (const c of b.children) {
      if (c.matches(".logo[data-corner], footer.band, [data-gen], [data-ui]")) continue;
      const r = c.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.top < top || r.bottom > bottom || r.left < left || r.right > right) { over = true; c.setAttribute("data-overflow", ""); }
    }
    $$(".card, .tile, .node", b).forEach(c => {
      if (c.scrollHeight > c.clientHeight + 2 || c.scrollWidth > c.clientWidth + 2) { over = true; c.setAttribute("data-overflow", ""); }
    });
    // a single unbreakable run (a figure, a chip) only overflows sideways
    $$(".chip, .tile__value", b).forEach(c => {
      const box = c.parentElement.getBoundingClientRect(), r = c.getBoundingClientRect();
      if (r.right > box.right + 1 || r.left < box.left - 1) { over = true; c.setAttribute("data-overflow", ""); }
    });
    if (over) b.setAttribute("data-overflow", "");
    const frame = frameOf(b);
    const warn = frame && $("[data-warn]", frame);
    if (warn && warn.textContent !== "duplicate data-title") {
      const inv = b.getAttribute("data-invalid") || $("[data-invalid]", b)?.getAttribute("data-invalid");
      warn.textContent = over ? "overflows, cut words" : inv ? inv : "";
    }
  }
  // MEDIA.md carousel: cover and last page may take their own ground; the pages between share one.
  const CAROUSEL_REASON = "carousel pages between the cover and the last page must share one ground";
  function checkCarousels() {
    const pages = boards.filter(b => b.dataset.medium === "carousel");
    const mid = pages.slice(1, -1);
    mid.forEach(b => {
      if (b.getAttribute("data-invalid")?.startsWith(CAROUSEL_REASON)) b.removeAttribute("data-invalid");
    });
    if (mid.length < 2) return;
    const counts = new Map();
    mid.forEach(b => {
      const g = b.getAttribute("data-g");
      counts.set(g, (counts.get(g) || 0) + 1);
    });
    const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    mid.forEach(b => {
      const g = b.getAttribute("data-g");
      if (g !== majority && !b.hasAttribute("data-invalid")) {
        invalid(b, `${CAROUSEL_REASON}; this page is "${g}", the others are "${majority}"`);
      }
    });
  }
  const checkAll = () => { checkCarousels(); boards.forEach(checkBoard); };
  const checkSoon = debounce(checkAll, 250);

  /* ============================================================ edit mode */

  function setEditable(on) {
    for (const b of boards) {
      $$(EDITABLE, b).forEach(el => {
        if (el.closest("[data-gen]")) return;
        if (on) { el.setAttribute("contenteditable", "plaintext-only"); el.setAttribute("spellcheck", "false"); }
        else { el.removeAttribute("contenteditable"); el.removeAttribute("spellcheck"); }
      });
    }
  }

  function toggleEdit(force) {
    editing = force ?? !editing;
    sheet.classList.toggle("is-editing", editing);
    const eb = $("#mib-edit");
    if (eb) { eb.classList.toggle("is-on", editing); eb.innerHTML = icon(editing ? "done" : "edit") + `<span>${editing ? "Done" : "Edit"}</span>`; eb.dataset.tip = editing ? "Stop editing" : "Edit text"; }
    const nb = $("#mib-note");
    if (nb) nb.hidden = !editing;
    if (!editing) document.activeElement?.blur();
    setEditable(editing);
    renderNotes();
  }

  /* ---------- undo: snapshots of the clean board markup */
  const undoStack = [], redoStack = [];
  let preEdit = null;
  function snapshot() {
    undoStack.push(boardsMarkup());
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    updateUndo();
  }
  function restore(markup) {
    sheet.innerHTML = markup;
    mountBoards();
  }
  function undo() {
    commitText();
    if (!undoStack.length) return;
    redoStack.push(boardsMarkup());
    restore(undoStack.pop());
    preEdit = null;
    updateUndo();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(boardsMarkup());
    restore(redoStack.pop());
    updateUndo();
  }
  function updateUndo() { const u = $("#mib-undo"); if (u) u.disabled = !undoStack.length; }
  function commitText() {
    if (preEdit !== null) {
      const now = boardsMarkup();
      if (now !== preEdit) { undoStack.push(preEdit); redoStack.length = 0; updateUndo(); }
      preEdit = now;
    }
  }
  const idleCommit = debounce(commitText, 800);

  sheet.addEventListener("focusin", e => { if (e.target.isContentEditable && preEdit === null) preEdit = boardsMarkup(); lastFocus = e.target; });
  sheet.addEventListener("focusout", e => {
    if (!e.target.isContentEditable) return;
    tidyLeaf(e.target);
    commitText();
    preEdit = null;
  });
  sheet.addEventListener("input", e => {
    if (!editing || !e.target.isContentEditable) return;
    e.target.setAttribute("data-edited", "");
    propagate(e.target);
    idleCommit();
    checkSoon();
  });

  let lastFocus = null;

  function tidyLeaf(el) {
    $$("strong", el).forEach(s => { if (!s.textContent) s.remove(); });
    // a trailing <br> is caret padding, not content
    while (el.lastChild?.nodeName === "BR" && el.childNodes.length > 1) el.lastChild.remove();
    el.normalize();
  }

  /* ---------- media: click, Enter or drop an image on a figure.media */
  const MEDIA_MAX = 2000;          // longest side, px, after downscaling
  const MEDIA_KEEP = 600 * 1024;   // a raster this small and within MEDIA_MAX is stored as it came
  let mediaInput = null, mediaTarget = null;

  function readDataURL(file) {
    return new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = () => no(r.error);
      r.readAsDataURL(file);
    });
  }

  // a data: URI for the file, downscaled and re-encoded through a canvas when it is large, so the
  // saved sheet doesn't balloon. SVG and animated GIF are stored as they came.
  async function imageDataURL(file) {
    const raw = await readDataURL(file);
    if (/^image\/(svg|gif)/.test(file.type)) return raw;
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("unreadable image")); i.src = raw; });
    const k = Math.min(1, MEDIA_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    if (k === 1 && file.size <= MEDIA_KEEP) return raw;
    const cv = h("canvas");
    cv.width = Math.max(1, Math.round(img.naturalWidth * k));
    cv.height = Math.max(1, Math.round(img.naturalHeight * k));
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    const out = file.type === "image/jpeg" ? cv.toDataURL("image/jpeg", 0.88) : cv.toDataURL("image/png");
    return out.length < raw.length ? out : raw;
  }

  async function setMedia(m, file) {
    if (!file || !file.type.startsWith("image/")) { toast("That isn't an image file"); return; }
    let src;
    try { src = await imageDataURL(file); }
    catch (e) { toast("Couldn't read that image"); return; }
    snapshotNow();
    let img = m.querySelector("img");
    if (!img) img = m.appendChild(h("img", { alt: "" }));   // an existing img keeps its alt
    img.removeAttribute("srcset");
    img.setAttribute("src", src);
    m.removeAttribute("data-empty");
    m.setAttribute("aria-label", "Replace image");
    preEdit = null;
    checkSoon();
  }

  function pickMedia(m) {
    if (!mediaInput) {
      mediaInput = h("input", { type: "file", accept: "image/*", "data-ui": "", hidden: "", tabindex: "-1" });
      mediaInput.addEventListener("change", () => {
        const f = mediaInput.files[0], t = mediaTarget;
        mediaInput.value = ""; mediaTarget = null;
        if (f && t) setMedia(t, f);
      });
      document.body.appendChild(mediaInput);
    }
    mediaTarget = m;
    mediaInput.click();
  }

  const mediaOf = e => e.target.closest?.("figure.media[data-mib-media]");
  sheet.addEventListener("click", e => { const m = mediaOf(e); if (m) pickMedia(m); });
  sheet.addEventListener("keydown", e => {
    const m = mediaOf(e);
    if (m && e.target === m && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pickMedia(m); }
  });
  sheet.addEventListener("dragover", e => {
    const m = mediaOf(e);
    if (!m || ![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    m.setAttribute("data-drop", "");
  });
  sheet.addEventListener("dragleave", e => { mediaOf(e)?.removeAttribute("data-drop"); });
  sheet.addEventListener("drop", e => {
    const m = mediaOf(e);
    if (!m) return;
    e.preventDefault();
    m.removeAttribute("data-drop");
    setMedia(m, [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("image/")) || e.dataTransfer?.files?.[0]);
  });

  /* ---------- data-bind */
  function propagate(el) {
    const id = el.dataset.bind;
    if (!id) return;
    const html = el.innerHTML.replace(/<br\s*\/?>/gi, " ");
    for (const other of $$(`[data-bind="${CSS.escape(id)}"]`, sheet)) {
      if (other !== el && other.innerHTML !== html) other.innerHTML = html;
    }
  }

  /* ---------- keys inside a leaf */
  sheet.addEventListener("keydown", e => {
    const el = e.target;
    if (!editing || !el.isContentEditable) return;
    const meta = e.metaKey || e.ctrlKey;

    if (meta && !e.altKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleStrong(el);
      propagate(el);
      checkSoon();
      return;
    }
    if (e.key === "Escape") { el.blur(); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const b = el.closest(".board");
      const leaves = $$("[contenteditable]", b);
      const next = leaves[(leaves.indexOf(el) + (e.shiftKey ? -1 : 1) + leaves.length) % leaves.length];
      placeCaret(next, true);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (el.matches(".list > li")) {
        snapshotNow();
        const li = h("li", { contenteditable: "plaintext-only", spellcheck: "false" });
        el.after(li);
        placeCaret(li, false);
      } else if (el.matches(BREAKABLE) && !el.dataset.bind) {
        insertBreak();
      } else {
        el.blur();
      }
      checkSoon();
      return;
    }
    if (e.key === "Backspace" && el.matches(".list > li") && !el.textContent && el.parentElement.children.length > 1) {
      e.preventDefault();
      snapshotNow();
      const prev = el.previousElementSibling || el.nextElementSibling;
      el.remove();
      placeCaret(prev, true);
      checkSoon();
    }
  });

  function snapshotNow() { commitText(); if (preEdit === null) snapshot(); }

  function placeCaret(el, atEnd) {
    if (!el) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(!atEnd);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function insertBreak() {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement("br");
    range.insertNode(br);
    if (!br.nextSibling) br.after(document.createElement("br"));
    range.setStartAfter(br);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* ---------- ⌘B: toggle <strong> on the selection, one leaf, never nested (after slaydy) */
  function strongAncestor(node, leaf) {
    let n = node.nodeType === 1 ? node : node.parentElement;
    for (; n && n !== leaf; n = n.parentElement) if (n.tagName === "STRONG") return n;
    return null;
  }
  function toggleStrong(el) {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return;
    commitText();
    snapshot();
    preEdit = boardsMarkup();
    const s1 = strongAncestor(range.startContainer, el), s2 = strongAncestor(range.endContainer, el);
    let target = s1 && s1 === s2 ? s1 : null;
    if (!target) {
      const kids = [...range.cloneContents().childNodes].filter(n => !(n.nodeType === 3 && !n.textContent));
      if (kids.length === 1 && kids[0].nodeName === "STRONG") target = $$("strong", el).find(s => range.intersectsNode(s));
    }
    if (target) {
      // unwrap the selected part, keep the rest of the run highlighted
      const parent = target.parentNode;
      const before = document.createRange();
      before.setStart(target, 0);
      before.setEnd(range.startContainer, range.startOffset);
      const after = document.createRange();
      after.setStart(range.endContainer, range.endOffset);
      after.setEnd(target, target.childNodes.length);
      const bf = before.extractContents(), af = after.extractContents();
      if (bf.textContent) { const s = document.createElement("strong"); s.append(bf); parent.insertBefore(s, target); }
      const start = document.createTextNode(""), end = document.createTextNode("");
      parent.insertBefore(start, target);
      while (target.firstChild) parent.insertBefore(target.firstChild, target);
      parent.insertBefore(end, target);
      const anchor = target.nextSibling;
      target.remove();
      if (af.textContent) { const s = document.createElement("strong"); s.append(af); parent.insertBefore(s, anchor); }
      const nr = document.createRange();
      nr.setStartAfter(start);
      nr.setEndBefore(end);
      sel.removeAllRanges();
      sel.addRange(nr);
    } else {
      const frag = range.extractContents();
      $$("strong", frag).forEach(s => s.replaceWith(...s.childNodes));
      let strong = document.createElement("strong");
      strong.append(frag);
      range.insertNode(strong);
      for (const sib of [strong.previousSibling, strong.nextSibling]) {
        if (sib?.nodeName !== "STRONG") continue;
        if (sib === strong.previousSibling) { sib.append(...strong.childNodes); strong.remove(); strong = sib; }
        else { strong.append(...sib.childNodes); sib.remove(); }
      }
      const nr = document.createRange();
      nr.selectNodeContents(strong);
      sel.removeAllRanges();
      sel.addRange(nr);
    }
    $$("strong", el).forEach(s => { if (!s.textContent) s.remove(); });
    el.setAttribute("data-edited", "");
  }

  /* ---------- notes */
  function renderNotes() {
    $$(".mib-note", sheet).forEach(n => n.remove());
    if (!editing) return;
    for (const b of boards) {
      const frame = frameOf(b);
      if (!frame || frame.hidden) continue;
      const stage = b.parentElement, sr = stage.getBoundingClientRect();
      const targets = [b, ...$$("[data-note]", b)].filter(t => t.hasAttribute("data-note"));
      for (const t of targets) {
        const r = t.getBoundingClientRect();
        const chip = h("div", { class: "mib-note", "data-ui": "", title: "Click to edit or remove" });
        chip.textContent = t.getAttribute("data-note") || "(empty note)";
        chip.style.left = Math.max(0, r.left - sr.left) + "px";
        chip.style.top = Math.max(0, r.top - sr.top - 4) + "px";
        chip.style.transform = "translateY(-100%)";
        chip.addEventListener("click", () => noteDialog(t));
        stage.appendChild(chip);
      }
    }
  }

  function noteDialog(target) {
    target = target || (lastFocus && sheet.contains(lastFocus) ? lastFocus : null);
    if (!target) return toast("Click the text (or a board) the note is about, then press Note.");
    if (!target.closest(".board")) return;
    if (!editing) toggleEdit(true);
    const box = h("div", { class: "mib-modal", "data-ui": "" });
    const inner = h("div", { class: "mib-modal__box" });
    const ta = h("textarea", { placeholder: "What should change here?", style: "height:120px" });
    ta.value = target.getAttribute("data-note") || "";
    const close = () => box.remove();
    inner.append(
      h("strong", {}, "Note for Claude"),
      h("div", { class: "mib-frame__meta" }, "Saved on the element as data-note. Copy changes and paste into chat to have it applied."),
      ta,
      h("div", { class: "row", style: "display:flex;gap:8px;justify-content:flex-end" }),
    );
    const btns = inner.lastChild;
    if (target.hasAttribute("data-note")) btns.append(h("button", { class: "mib-btn", onclick: () => { snapshotNow(); target.removeAttribute("data-note"); close(); renderNotes(); } }, "Remove"));
    btns.append(
      h("button", { class: "mib-btn", onclick: close }, "Cancel"),
      h("button", { class: "mib-btn is-on", onclick: () => { snapshotNow(); target.setAttribute("data-note", ta.value.trim()); close(); renderNotes(); } }, "Save"),
    );
    box.addEventListener("click", e => { if (e.target === box) close(); });
    box.appendChild(inner);
    document.body.appendChild(box);
    ta.focus();
  }

  /* ============================================================ markup out */

  function cleanBoard(b) {
    const c = b.cloneNode(true);
    $$("[data-gen], [data-ui]", c).forEach(n => n.remove());
    for (const n of [c, ...$$("*", c)]) {
      if (n.hasAttribute("data-mib-media")) for (const a of ["tabindex", "role", "aria-label"]) n.removeAttribute(a);
      for (const a of STRIP_ATTRS) n.removeAttribute(a);
      if (n.matches(STYLE_OWNED)) n.removeAttribute("style");
    }
    return c;
  }

  function boardsMarkup() {
    // valueless data-* flags (data-fill, data-template) serialise back the way they were written
    return boards.map(b => "  " + cleanBoard(b).outerHTML
      .replace(/ (data-[\w-]+)=""/g, " $1")
      // JSON attributes go back to single quotes, as PRIMITIVES.md writes them
      .replace(/ (data-[\w-]+)="([[{][^"]*)"/g, (m, n, v) => v.includes("'") ? m : ` ${n}='${v.replace(/&quot;/g, '"')}'`)).join("\n\n");
  }

  function copyChanges() {
    commitText();
    const text = boardsMarkup();
    const done = () => toast("Copied. Paste it into the chat with Claude.");
    const manual = () => {
      const box = h("div", { class: "mib-modal", "data-ui": "" });
      const inner = h("div", { class: "mib-modal__box" });
      const ta = h("textarea", { readonly: "" });
      ta.value = text;
      inner.append(h("strong", {}, "Copy this and paste it into the chat"), ta,
        h("button", { class: "mib-btn", onclick: () => box.remove() }, "Close"));
      box.appendChild(inner);
      box.addEventListener("click", e => { if (e.target === box) box.remove(); });
      document.body.appendChild(box);
      ta.focus(); ta.select();
    };
    const legacy = () => {
      const ta = h("textarea", { style: "position:fixed;opacity:0" });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch {}
      ta.remove();
      ok ? done() : manual();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, legacy);
    else legacy();
  }

  function downloadHTML() {
    commitText();
    triggerDownload("data:text/html;charset=utf-8," + encodeURIComponent(sheetHTML()), slug(document.title) + ".html");
  }

  function sheetHTML() {
    const attrs = el => [...el.attributes].map(a => ` ${a.name}="${esc(a.value)}"`).join("");
    const main = sheet.cloneNode(false);
    main.removeAttribute("data-mib-booted");
    main.removeAttribute("style");
    main.classList.remove("is-editing");
    const sheetAttrs = attrs(main);
    let tail = "";
    let n = sheet.nextSibling;
    for (; n; n = n.nextSibling) {
      if (n.nodeType === 1 && n.hasAttribute("data-ui")) continue;
      tail += n.nodeType === 1 ? n.outerHTML : n.nodeType === 8 ? `<!--${n.data}-->` : n.nodeType === 3 ? n.data : "";
    }
    return `<!doctype html>\n<html${attrs(document.documentElement)}>\n${document.head.outerHTML}\n<body>\n<main${sheetAttrs}>\n\n${boardsMarkup()}\n\n</main>${tail.replace(/^\s*/, "\n")}</body>\n</html>\n`;
  }

  function triggerDownload(url, name) {
    const a = h("a", { href: url, download: name, "data-ui": "" });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ============================================================ export */

  const assetCache = new Map();
  async function toDataURL(url) {
    if (!url || url.startsWith("data:")) return url;
    if (assetCache.has(url)) return assetCache.get(url);
    const p = fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(blob => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); }))
      .catch(err => { console.warn("[makeitbrand] could not inline", url, err); return url; });
    assetCache.set(url, p);
    return p;
  }

  async function inlineCSSUrls(css, base) {
    const urls = new Set();
    css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (m, q, u) => { if (!u.startsWith("data:") && !u.startsWith("#")) urls.add(u); });
    const map = new Map();
    await Promise.all([...urls].map(async u => map.set(u, await toDataURL(new URL(u, base).href))));
    return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (m, q, u) => map.has(u) ? `url("${map.get(u)}")` : m);
  }

  let cssPromise = null;
  function exportCSS() {
    cssPromise ??= (async () => {
      const parts = [];
      for (const el of $$("style, link[rel=stylesheet]")) {
        if (el.hasAttribute("data-ui")) continue;
        if (el.tagName === "STYLE") parts.push(await inlineCSSUrls(el.textContent, location.href));
        else {
          try { parts.push(await inlineCSSUrls(await (await fetch(el.href)).text(), el.href)); }
          catch (e) { console.warn("[makeitbrand] could not read stylesheet", el.href, e); }
        }
      }
      return parts.join("\n").replace(/:root\b/g, ":root, .mib-x");
    })();
    return cssPromise;
  }

  async function boardSVG(b, bleedPx = 0) {
    const [bw, bh] = boardSize(b);
    const w = bw + 2 * bleedPx, hh = bh + 2 * bleedPx;
    const css = await exportCSS();
    const clone = b.cloneNode(true);
    if (bleedPx) growForBleed(clone, b, bleedPx);
    $$("[data-ui], .mib-note", clone).forEach(n => n.remove());
    for (const n of [clone, ...$$("[contenteditable]", clone)]) { n.removeAttribute("contenteditable"); n.removeAttribute("spellcheck"); }
    clone.removeAttribute("data-overflow");
    clone.style.transform = "none";
    clone.style.position = "relative";
    clone.style.boxShadow = "none";
    await Promise.all($$("img", clone).map(async img => img.setAttribute("src", await toDataURL(img.src))));
    const NS = "http://www.w3.org/1999/xhtml";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", w); svg.setAttribute("height", hh);
    svg.setAttribute("viewBox", `0 0 ${w} ${hh}`);
    const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    fo.setAttribute("width", w); fo.setAttribute("height", hh);
    const root = document.createElementNS(NS, "div");
    root.setAttribute("class", "mib-x");
    root.setAttribute("style", `width:${w}px;height:${hh}px;margin:0;`);
    const style = document.createElementNS(NS, "style");
    style.textContent = css;
    root.append(style, clone);
    fo.appendChild(root);
    svg.appendChild(fo);
    return { svg: new XMLSerializer().serializeToString(svg), w, h: hh };
  }

  // ground: a colour painted under the board first (PDF pages are JPEG, which has no alpha)
  async function boardCanvas(b, scale = 2, ground = null, bleedPx = 0) {
    await document.fonts.ready;
    const { svg, w, h: hh } = await boardSVG(b, bleedPx);
    const img = new Image();
    img.decoding = "sync";
    const loaded = new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("the board could not be drawn")); });
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await loaded;
    try { await img.decode(); } catch {}
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale); canvas.height = Math.round(hh * scale);
    const ctx = canvas.getContext("2d");
    if (ground) { ctx.fillStyle = ground; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return canvas;
  }

  async function boardPNG(b, scale = 2) {
    return (await boardCanvas(b, scale)).toDataURL("image/png");
  }

  async function exportBoard(b) {
    commitText();
    try {
      const url = await boardPNG(b);
      triggerDownload(url, `${slug(b.dataset.title)}@2x.png`);
    } catch (e) {
      console.error(e);
      toast("Export failed: " + e.message);
    }
  }

  async function downloadAll() {
    const list = boards.filter(b => !b.hasAttribute("data-template"));
    toast(`Exporting ${list.length} boards…`);
    for (const b of list) {
      await exportBoard(b);
      await new Promise(r => setTimeout(r, 350));
    }
    toast(`Downloaded ${list.length} PNGs.`);
  }

  /* ---------- PDF. A profile's --dpi (default 96) says what one board px is on paper: a 1080px
     carousel page is 810pt wide, a 1050px nametag at 300 dpi is 3.5in. In the browser the pages are
     the export rasters (2x, or 1x for print profiles already drawn at print resolution); export.py
     --pdf prints the live boards through Chrome instead, for vector text and imposition. */
  const dpiOf = b => parseFloat(cssVar(b, "--dpi")) || 96;
  const pt = v => +v.toFixed(2);
  const BLEED_IN = 0.125;          // 1/8 in, which also covers the 3 mm most print shops ask for

  function physicalSize(b, extraIn = 0) {
    const dpi = dpiOf(b);
    if (dpi < 150) return "";
    const inch = v => +(v / dpi + extraIn).toFixed(3);
    const [w, hh] = boardSize(b);
    return `${inch(w)} × ${inch(hh)} in`;
  }

  /* Bleed: the board grows by px on every side and its safe area grows with it, so the ground,
     art and full-width bands run past the trim while everything else keeps its place relative to
     the trim. Read from `src` (the live board), written to `el` (the board itself, or an export clone). */
  function growForBleed(el, src, px) {
    const [w, hh] = boardSize(src);
    const vals = { "--board-w": w + 2 * px, "--board-h": hh + 2 * px, "--mib-bleed": px };
    for (const s of ["--safe-t", "--safe-r", "--safe-b", "--safe-l"]) vals[s] = (parseFloat(cssVar(src, s)) || 0) + px;
    for (const [k, v] of Object.entries(vals)) el.style.setProperty(k, v + "px");
  }

  function pdfGroups() {
    const groups = new Map();
    for (const b of boards) {
      if (b.hasAttribute("data-template")) continue;
      const custom = b.dataset.medium === "custom", [w, hh] = boardSize(b);
      const key = custom ? `custom ${w}×${hh}` : b.dataset.medium || "board";
      if (!groups.has(key)) groups.set(key, {
        key, label: custom ? `${w} × ${hh}` : key, list: [],
        print: dpiOf(b) >= 150, size: physicalSize(b), bleedSize: physicalSize(b, 2 * BLEED_IN),
      });
      groups.get(key).list.push(b);
    }
    return [...groups.values()];
  }

  // A minimal PDF 1.4 writer: one full-page JPEG image per page.
  function pdfFile(pages, title) {
    const enc = new TextEncoder();
    const parts = [], offsets = [];
    let len = 0;
    const put = x => { const u = typeof x === "string" ? enc.encode(x) : x; parts.push(u); len += u.length; };
    const obj = (n, dict, stream) => {
      offsets[n] = len;
      put(`${n} 0 obj\n${dict}\n`);
      if (stream) { put("stream\n"); put(stream); put("\nendstream\n"); }
      put("endobj\n");
    };
    const text = s => "<FEFF" + [...String(s)].map(c => {
      const code = c.codePointAt(0);
      const units = code > 0xffff ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)] : [code];
      return units.map(u => u.toString(16).padStart(4, "0")).join("");
    }).join("") + ">";
    put("%PDF-1.4\n%âãÏÓ\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 3} 0 R`).join(" ")}] /Count ${pages.length} >>`);
    obj(3, `<< /Title ${text(title)} /Producer (makeitbrand) >>`);
    pages.forEach((p, i) => {
      const n = 4 + i * 3, draw = enc.encode(`q ${pt(p.pw)} 0 0 ${pt(p.ph)} 0 0 cm /Im Do Q`);
      const boxes = p.bleed ? ` /BleedBox [0 0 ${pt(p.pw)} ${pt(p.ph)}] /TrimBox [${pt(p.bleed)} ${pt(p.bleed)} ${pt(p.pw - p.bleed)} ${pt(p.ph - p.bleed)}]` : "";
      obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(p.pw)} ${pt(p.ph)}]${boxes} /Resources << /XObject << /Im ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
      obj(n + 1, `<< /Length ${draw.length} >>`, draw);
      obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.iw} /Height ${p.ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
    });
    const xref = len, size = 4 + pages.length * 3;
    put(`xref\n0 ${size}\n0000000000 65535 f \n` + offsets.slice(1).map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join(""));
    put(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: "application/pdf" });
  }

  async function exportPDF(group, bleed = false) {
    commitText();
    const { list } = group;
    toast(`Making a ${list.length}-page PDF…`, 120000);
    try {
      const pages = [];
      for (const b of list) {
        const dpi = dpiOf(b), bpx = bleed ? BLEED_IN * dpi : 0;
        const canvas = await boardCanvas(b, dpi >= 200 ? 1 : 2, "#fff", bpx);
        const blob = await new Promise((res, rej) => canvas.toBlob(x => x ? res(x) : rej(new Error("the page could not be encoded")), "image/jpeg", 0.92));
        pages.push({
          jpeg: new Uint8Array(await blob.arrayBuffer()), iw: canvas.width, ih: canvas.height,
          pw: (boardSize(b)[0] + 2 * bpx) * 72 / dpi, ph: (boardSize(b)[1] + 2 * bpx) * 72 / dpi, bleed: bleed ? BLEED_IN * 72 : 0,
        });
      }
      const several = pdfGroups().length > 1;
      const url = URL.createObjectURL(pdfFile(pages, document.title || "Sheet"));
      triggerDownload(url, slug(document.title) + (several ? "-" + slug(group.key) : "") + (bleed ? "-bleed" : "") + ".pdf");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(`Downloaded a ${list.length}-page PDF.`);
    } catch (e) {
      console.error(e);
      toast("PDF export failed: " + e.message);
    }
  }

  /* ---------- print layout (?mib-print): the boards laid out as pages for Chrome's print-to-PDF.
     ?mib-print or ?mib-print=1 → one page per board at its physical size (a named @page per size);
     ?mib-print=a4|letter → boards imposed on that paper in a centred grid with cut marks, a new
     sheet whenever the board size changes; a board bigger than the paper keeps a page of its own.
     ?mib-boards=0,3,4 (0-based sheet indices) picks boards; default every non-template board.
     export.py mirrors the page count arithmetic here; change both together. */
  const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
  const PAPER_MARGIN = 24, PAPER_GUTTER = 18, MARK_OFFSET = 3, MARK_LEN = 9;
  const BLEED_MARGIN = 18;         // with bleed, bleed boxes touch and the cut marks sit in the margin

  // ?mib-bleed=1: every board grows by BLEED_IN (growForBleed); w/h stay the trim size in pt
  function printLayout(paper, pick, bleed) {
    const want = pick ? new Set(pick.split(",").map(Number)) : null;
    const items = boards
      .filter((b, i) => want ? want.has(i) : !b.hasAttribute("data-template"))
      .map(b => { const dpi = dpiOf(b), [w, hh] = boardSize(b); return { b, dpi, w: w * 72 / dpi, h: hh * 72 / dpi, s: 96 / dpi }; });
    const B = bleed ? BLEED_IN * 72 : 0;
    if (bleed) items.forEach(it => growForBleed(it.b, it.b, BLEED_IN * it.dpi));
    const pagesEl = h("div", { class: "mib-pages", "data-ui": "" });
    const named = new Map();
    const page = (w, hh) => {
      const key = `${pt(w)}pt ${pt(hh)}pt`;
      if (!named.has(key)) named.set(key, `mib-p${named.size}`);
      const p = h("div", { class: "mib-page" });
      p.style.cssText = `page:${named.get(key)};width:${pt(w)}pt;height:${pt(hh)}pt`;
      pagesEl.appendChild(p);
      return p;
    };
    const place = (p, it, x, y) => {
      const slot = h("div", { class: "mib-slot" });
      slot.style.cssText = `left:${pt(x)}pt;top:${pt(y)}pt;width:${pt(it.w + 2 * B)}pt;height:${pt(it.h + 2 * B)}pt`;
      // zoom, not transform: print fragments by layout box, so a transformed 1500px board would be
      // cut at the page edge in its unscaled coordinates (and spill a blank page after the last one)
      it.b.style.transform = "none";
      it.b.style.zoom = it.s;
      slot.appendChild(it.b);
      p.appendChild(slot);
    };
    const line = (p, x, y, w, hh) => {
      const m = h("i", { class: "mib-mark" });
      m.style.cssText = `left:${pt(x)}pt;top:${pt(y)}pt;width:${pt(w)}pt;height:${pt(hh)}pt`;
      p.appendChild(m);
    };
    const marks = (p, x, y, w, hh) => {
      const t = 0.5, o = MARK_OFFSET, l = MARK_LEN;
      for (const yy of [y, y + hh]) { line(p, x - o - l, yy - t / 2, l, t); line(p, x + w + o, yy - t / 2, l, t); }
      for (const xx of [x, x + w]) { line(p, xx - t / 2, y - o - l, t, l); line(p, xx - t / 2, y + hh + o, t, l); }
    };
    // with bleed: one mark per cut line, outside the whole grid, clear of every board's bleed
    const outerMarks = (p, x0, y0, cols, rows, bw, bh) => {
      const t = 0.5, o = 2, l = MARK_LEN, right = x0 + cols * bw, bottom = y0 + rows * bh;
      const before = edge => [Math.max(0, edge - o - l), Math.min(l, edge - o)];
      for (let c = 0; c < cols; c++) for (const xx of [x0 + c * bw + B, x0 + (c + 1) * bw - B]) {
        const [y, len] = before(y0);
        if (len > 0) line(p, xx - t / 2, y, t, len);
        line(p, xx - t / 2, bottom + o, t, l);
      }
      for (let r = 0; r < rows; r++) for (const yy of [y0 + r * bh + B, y0 + (r + 1) * bh - B]) {
        const [x, len] = before(x0);
        if (len > 0) line(p, x, yy - t / 2, len, t);
        line(p, right + o, yy - t / 2, l, t);
      }
    };
    const sheetSize = PAPER[paper];
    const margin = B ? BLEED_MARGIN : PAPER_MARGIN, gutter = B ? 0 : PAPER_GUTTER;
    for (let i = 0; i < items.length;) {
      const { w, h: hh } = items[i];
      const bw = w + 2 * B, bh = hh + 2 * B;          // the box a board takes: trim plus bleed
      const cols = sheetSize ? Math.floor((sheetSize[0] - 2 * margin + gutter) / (bw + gutter)) : 0;
      const rows = sheetSize ? Math.floor((sheetSize[1] - 2 * margin + gutter) / (bh + gutter)) : 0;
      if (cols < 1 || rows < 1) { place(page(bw, bh), items[i++], 0, 0); continue; }
      const p = page(...sheetSize);
      const x0 = (sheetSize[0] - (cols * bw + (cols - 1) * gutter)) / 2;
      const y0 = (sheetSize[1] - (rows * bh + (rows - 1) * gutter)) / 2;
      let n = 0;
      for (; n < cols * rows && i < items.length && items[i].w === w && items[i].h === hh; n++, i++) {
        const x = x0 + (n % cols) * (bw + gutter), y = y0 + Math.floor(n / cols) * (bh + gutter);
        place(p, items[i], x, y);
        if (!B) marks(p, x, y, w, hh);
      }
      if (B) outerMarks(p, x0, y0, Math.min(n, cols), Math.ceil(n / cols), bw, bh);
    }
    const rules = h("style", { "data-ui": "" });
    rules.textContent = [...named].map(([size, name]) => `@page ${name}{size:${size};margin:0}`).join("\n");
    document.head.appendChild(rules);
    // boards were measured inside their frames; the frames are empty now or hold unpicked boards
    $$(":scope > .mib-frame", sheet).forEach(f => f.remove());
    sheet.appendChild(pagesEl);
    return pagesEl.children.length;
  }

  /* ============================================================ drawing helpers */

  const SVG = "http://www.w3.org/2000/svg";
  const sv = (tag, attrs = {}, parent) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  };
  const txt = (parent, x, y, s, attrs = {}) => { const t = sv("text", { x, y, ...attrs }, parent); t.textContent = s; return t; };

  function metrics(b) {
    const body = parseFloat(getComputedStyle(b).fontSize) || 16;
    const scale = parseFloat(cssVar(b, "--scale")) || 1.25;
    const k = parseFloat(cssVar(b, "--k")) || 1;
    const stroke = (parseFloat(cssVar(b, "--stroke")) || 1.5) * k;
    // chart and label text is set in the caption face, which falls back to mono
    const mono = cssVar(b, "--font-caption") || cssVar(b, "--font-mono") || "monospace";
    return { body, small: body / scale, k, stroke, mono };
  }

  const measureCtx = document.createElement("canvas").getContext("2d");
  function textW(s, size, family, weight = 400) {
    measureCtx.font = `${weight} ${size}px ${family}`;
    return measureCtx.measureText(String(s)).width;
  }

  function niceStep(range, count) {
    const raw = range / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw || 1)), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  function niceScale(min, max, count = 4) {
    if (min === max) { max = min + 1; }
    const step = niceStep(max - min, count);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { lo, hi, ticks, step };
  }

  function formatter(fig) {
    const d = +fig.dataset.decimals || 0, pre = fig.dataset.prefix || "", unit = fig.dataset.unit || "";
    const f = (v, dd) => pre + Number(v).toLocaleString("en-US", { minimumFractionDigits: dd, maximumFractionDigits: dd }) + unit;
    const out = v => f(v, d);
    // axis ticks carry only the precision their step needs: "4 h", not "4.0 h"
    out.tick = (v, step) => f(v, Math.min(d, step >= 1 ? 0 : Math.ceil(-Math.log10(step))));
    return out;
  }

  function json(el, attr) {
    const raw = el.getAttribute(attr);
    if (raw == null) return undefined;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /* ============================================================ charts */

  const NEUTRAL = "color-mix(in srgb, var(--g-fg) 16%, transparent)";

  RENDER.charts = b => {
    const m = metrics(b);
    $$("figure.chart", b).forEach(fig => {
      fig.removeAttribute("data-invalid");
      const plot = $(":scope > .mib-plot", fig);
      if (!plot) return;
      plot.innerHTML = "";
      const labels = json(fig, "data-labels") || [];
      let series = json(fig, "data-series");
      if (!Array.isArray(series) || !series.length) return invalid(fig, "data-series must be a JSON array");
      const type = fig.dataset.type;
      if (type === "range") {
        if (series.some(s => typeof s?.from !== "number" || typeof s?.to !== "number")) return invalid(fig, "range rows need numeric from and to");
        series = series.map(s => ({ ...s, values: [s.to] }));
      }
      if (typeof series[0] === "number") series = [{ name: "", values: series }];
      if (series.some(s => !Array.isArray(s?.values) || s.values.some(v => typeof v !== "number"))) return invalid(fig, "every series needs numeric values");
      const n = type === "range" ? 1 : Math.max(...series.map(s => s.values.length));
      const limits = { bar: [12, 3], line: [24, 4], donut: [5, 1], range: [1, 4], dots: [1, 1] }[type];
      if (!limits) return invalid(fig, `unknown data-type "${type || ""}"`);
      if (n > limits[0] || series.length > limits[1]) return invalid(fig, `${type} allows at most ${limits[0]} points and ${limits[1]} series`);
      const hl = fig.dataset.highlight;
      if (hl && series.length > 1 && !series.some(s => s.name === hl)) return invalid(fig, `data-highlight "${hl}" is not a series name`);
      if (hl && series.length === 1 && (type === "line" || type === "range" || !labels.includes(hl))) return invalid(fig, `data-highlight "${hl}" is not a label`);
      if (fig.dataset.gap && type === "range" && series.length !== 2) return invalid(fig, "data-gap needs exactly two range rows");
      const W = plot.clientWidth, H = plot.clientHeight;
      if (W < 20 || H < 20) return;
      const svg = sv("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, "data-gen": "" });
      const ctx = { fig, svg, W, H, m, labels, series, fmt: formatter(fig), hl,
        color: (si, li) => {
          if (hl && series.length > 1) return series[si].name === hl ? "var(--chart-accent, var(--chart-1))" : NEUTRAL;
          if (hl) return labels[li] === hl ? "var(--chart-accent, var(--chart-1))" : NEUTRAL;
          return `var(--chart-${(si % 6) + 1})`;
        } };
      ({ bar: fig.dataset.orient === "h" ? barH : barV, line, donut, range, dots })[type](ctx);
      plot.appendChild(svg);
    });
    $$(".tile__spark", b).forEach(el => spark(el, m));
  };

  function legend(ctx, y) {
    const { svg, series, m } = ctx;
    if (series.length < 2) return 0;
    let x = 0;
    const sw = m.small * .72, gap = m.small * 1.4;
    series.forEach((s, i) => {
      sv("rect", { x, y: y + (m.small * 1.1 - sw) / 2 - m.small * .1, width: sw, height: sw, rx: sw * .25, fill: ctx.color(i, -1) }, svg);
      txt(svg, x + sw + m.small * .5, y + m.small * .82, s.name, { class: "mib-t", "font-size": m.small });
      x += sw + m.small * .5 + textW(s.name, m.small, m.mono) + gap;
    });
    return y + m.small * 2.4;
  }

  const roundTop = (x, y, w, hh, r) => {
    r = Math.min(r, w / 2, hh);
    return `M${x},${y + hh}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh}Z`;
  };
  const roundRight = (x, y, w, hh, r) => {
    r = Math.min(r, hh / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh - r}Q${x + w},${y + hh} ${x + w - r},${y + hh}H${x}Z`;
  };

  function barV(ctx) {
    const { svg, W, H, m, labels, series, fmt } = ctx;
    const n = Math.max(...series.map(s => s.values.length)), s = series.length;
    const direct = n * s <= 8;
    const top = legend(ctx, m.small * .4) + (direct ? m.small * 1.7 : m.small * .6);
    const bottom = H - m.small * 2;
    const max = Math.max(0, ...series.flatMap(x => x.values));
    const scale = direct ? { lo: 0, hi: max || 1, ticks: [] } : niceScale(0, max || 1, 4);
    const left = direct ? 0 : Math.max(...scale.ticks.map(v => textW(fmt.tick(v, scale.step), m.small, m.mono))) + m.small * .8;
    const y = v => bottom - (v - scale.lo) / (scale.hi - scale.lo) * (bottom - top);
    for (const v of scale.ticks) {
      sv("line", { x1: left, x2: W, y1: y(v), y2: y(v), class: "mib-grid", "stroke-width": Math.max(1, m.stroke * .6) }, svg);
      txt(svg, left - m.small * .8, y(v) + m.small * .35, fmt.tick(v, scale.step), { class: "mib-t", "font-size": m.small, "text-anchor": "end" });
    }
    const gw = (W - left) / n, gap = Math.max(2, m.stroke * 1.3);
    const inner = Math.min(gw * (s === 1 ? .56 : .72), (m.small * 3.6 + gap) * s);
    const bw = (inner - gap * (s - 1)) / s;
    for (let li = 0; li < n; li++) {
      const gx = left + gw * li + (gw - inner) / 2;
      series.forEach((ser, si) => {
        const v = ser.values[li];
        if (v == null) return;
        const bx = gx + si * (bw + gap), by = y(v);
        sv("path", { d: roundTop(bx, by, bw, bottom - by, m.stroke * 2.4), fill: ctx.color(si, li) }, svg);
        if (direct) txt(svg, bx + bw / 2, by - m.small * .55, fmt(v), { class: "mib-t mib-t--value", "font-size": m.small, "text-anchor": "middle" });
      });
      txt(svg, left + gw * li + gw / 2, H - m.small * .35, labels[li] ?? "", { class: "mib-t", "font-size": m.small, "text-anchor": "middle" });
    }
    sv("line", { x1: left, x2: W, y1: bottom, y2: bottom, class: "mib-axis", "stroke-width": Math.max(1, m.stroke * .8) }, svg);
  }

  function barH(ctx) {
    const { svg, W, H, m, labels, series, fmt } = ctx;
    const n = Math.max(...series.map(s => s.values.length)), s = series.length;
    const direct = n * s <= 8;
    const top = legend(ctx, 0);
    const labelW = Math.max(0, ...labels.map(l => textW(l, m.small, m.mono))) + m.small;
    const max = Math.max(0, ...series.flatMap(x => x.values));
    const valueW = direct ? Math.max(...series.flatMap(x => x.values).map(v => textW(fmt(v), m.small, m.mono))) + m.small * .6 : 0;
    const scale = direct ? { lo: 0, hi: max || 1, ticks: [] } : niceScale(0, max || 1, 4);
    const bottom = direct ? H : H - m.small * 1.8;
    const x = v => labelW + (v / (scale.hi || 1)) * (W - labelW - valueW);
    for (const v of scale.ticks) {
      sv("line", { x1: x(v), x2: x(v), y1: top, y2: bottom, class: "mib-grid", "stroke-width": Math.max(1, m.stroke * .6) }, svg);
      txt(svg, x(v), H - m.small * .35, fmt.tick(v, scale.step), { class: "mib-t", "font-size": m.small, "text-anchor": "middle" });
    }
    const gh = (bottom - top) / n, gap = Math.max(2, m.stroke * 1.3);
    const inner = Math.min(gh * (s === 1 ? .6 : .76), (m.small * 2.2 + gap) * s);
    const bh = (inner - gap * (s - 1)) / s;
    for (let li = 0; li < n; li++) {
      const gy = top + gh * li + (gh - inner) / 2;
      txt(svg, 0, top + gh * li + gh / 2 + m.small * .35, labels[li] ?? "", { class: "mib-t", "font-size": m.small });
      series.forEach((ser, si) => {
        const v = ser.values[li];
        if (v == null) return;
        const by = gy + si * (bh + gap);
        sv("path", { d: roundRight(labelW, by, x(v) - labelW, bh, m.stroke * 2.4), fill: ctx.color(si, li) }, svg);
        if (direct) txt(svg, x(v) + m.small * .5, by + bh / 2 + m.small * .35, fmt(v), { class: "mib-t mib-t--value", "font-size": m.small });
      });
    }
    sv("line", { x1: labelW, x2: labelW, y1: top, y2: bottom, class: "mib-axis", "stroke-width": Math.max(1, m.stroke * .8) }, svg);
  }

  function line(ctx) {
    const { svg, W, H, m, labels, series, fmt } = ctx;
    const n = Math.max(...series.map(s => s.values.length));
    const all = series.flatMap(s => s.values);
    const scale = niceScale(Math.min(...all), Math.max(...all), 4);
    const top = m.small * .8, bottom = H - m.small * 2;
    const left = Math.max(...scale.ticks.map(v => textW(fmt.tick(v, scale.step), m.small, m.mono))) + m.small * .8;
    const endText = s => series.length > 1 ? s.name : fmt(s.values[s.values.length - 1]);
    const right = W - Math.max(...series.map(s => textW(endText(s), m.small, m.mono))) - m.small * 1.2;
    const x = i => left + (n === 1 ? 0 : i / (n - 1)) * (right - left);
    const y = v => bottom - (v - scale.lo) / (scale.hi - scale.lo) * (bottom - top);
    for (const v of scale.ticks) {
      sv("line", { x1: left, x2: right, y1: y(v), y2: y(v), class: "mib-grid", "stroke-width": Math.max(1, m.stroke * .6) }, svg);
      txt(svg, left - m.small * .8, y(v) + m.small * .35, fmt.tick(v, scale.step), { class: "mib-t", "font-size": m.small, "text-anchor": "end" });
    }
    const maxLabel = Math.max(...labels.map(l => textW(l, m.small, m.mono))) + m.small * 1.5;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((right - left) / maxLabel))));
    for (let i = 0; i < n; i++) {
      if (i % every && i !== n - 1) continue;
      if (i !== n - 1 && n - 1 - i < every) continue;
      txt(svg, x(i), H - m.small * .35, labels[i] ?? "", { class: "mib-t", "font-size": m.small, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" });
    }
    const lw = Math.max(2, m.stroke * 1.35), r = Math.max(4, m.stroke * 2.6);
    const ends = [];
    const order = series.map((s, i) => i).sort((a, b) => (series[a].name === ctx.hl) - (series[b].name === ctx.hl));
    for (const si of order) {
      const s = series[si], c = ctx.color(si, -1);
      const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      sv("polyline", { points: pts.join(" "), fill: "none", stroke: c, "stroke-width": lw, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      const li = s.values.length - 1;
      sv("circle", { cx: x(li), cy: y(s.values[li]), r, fill: c, class: "mib-dot", "stroke-width": r * .6 }, svg);
      ends.push({ y: y(s.values[li]), s, si });
    }
    ends.sort((a, b) => a.y - b.y);
    const minGap = m.small * 1.25;
    for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + minGap);
    for (const e of ends) txt(svg, right + m.small * .9, e.y + m.small * .35, endText(e.s), { class: "mib-t mib-t--value", "font-size": m.small });
  }

  function donut(ctx) {
    const { svg, W, H, m, labels, series, fmt } = ctx;
    const vals = series[0].values, total = vals.reduce((a, v) => a + Math.max(0, v), 0) || 1;
    const lab = (l, v) => `${l}  ${fmt(v)}`;
    const labelW = Math.max(...vals.map((v, i) => textW(lab(labels[i] ?? "", v), m.small, m.mono)));
    const R = Math.max(10, Math.min(H / 2 - m.small * 1.6, W / 2 - labelW - m.small * 2.2));
    const r0 = R * .62, cx = W / 2, cy = H / 2, gap = Math.max(2, m.stroke * 1.3) / R;
    let a = -Math.PI / 2;
    const pt = (rad, ang) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
    vals.forEach((v, i) => {
      const sweep = Math.max(0, v) / total * Math.PI * 2;
      const a0 = a + gap / 2, a1 = a + sweep - gap / 2;
      if (a1 > a0) {
        const big = a1 - a0 > Math.PI ? 1 : 0;
        const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
        sv("path", { d: `M${x0},${y0}A${R},${R} 0 ${big} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${big} 0 ${x3},${y3}Z`, fill: ctx.color(0, i) }, svg);
      }
      const mid = a + sweep / 2, [lx, ly] = pt(R + m.small * 1.1, mid);
      const right = Math.cos(mid) >= 0;
      const t = txt(svg, lx, ly + m.small * .35, "", { class: "mib-t", "font-size": m.small, "text-anchor": right ? "start" : "end" });
      sv("tspan", {}, t).textContent = (labels[i] ?? "") + "  ";
      const tv = sv("tspan", { class: "mib-t--value" }, t);
      tv.textContent = fmt(v);
      a += sweep;
    });
  }

  function range(ctx) {
    const { svg, W, H, m, series, fmt, fig } = ctx;
    const max = +fig.dataset.max || Math.max(...series.map(s => s.to));
    const name = m.body * 1.15, bar = Math.max(6, m.small * .6), lw = Math.max(1, m.stroke * .7);
    const x = v => Math.max(0, Math.min(1, v / max)) * W;
    const dash = `${lw * 3} ${lw * 3}`;
    const two = series.length === 2 && fig.dataset.gap;
    const rows = series.map((s, i) => {
      if (two) return i === 0 ? { head: name, barY: name * 1.55 } : { head: H - m.small * .2, barY: H - name * 1.35 - bar, below: true };
      const slot = H / series.length;
      return { head: slot * i + name, barY: slot * i + name * 1.55 };
    });
    series.forEach((s, i) => {
      // the first row is the subject (--chart-1); the rest are reference rows in ink
      const r = rows[i], c = ctx.hl ? ctx.color(i, -1) : i === 0 ? "var(--chart-1)" : "var(--g-fg)";
      txt(svg, 0, r.head, s.name || "", { class: "mib-t--name", "font-size": name, "font-weight": 600 });
      if (Array.isArray(s.steps) && s.steps.length) {
        let cx = W;
        const parts = [];
        for (let k = s.steps.length - 1; k >= 0; k--) {
          const w = textW(s.steps[k], m.small, m.mono);
          parts.push({ x: cx - w, s: s.steps[k] });
          cx -= w + m.small * 1.9;
        }
        parts.forEach((p, k) => {
          txt(svg, p.x, r.head - name * .02, p.s, { class: "mib-t", "font-size": m.small });
          if (k < parts.length - 1) {
            const ax = p.x - m.small * 1.45, ay = r.head - m.small * .32, al = m.small * .85;
            sv("path", { d: `M${ax},${ay}H${ax + al}M${ax + al - m.small * .28},${ay - m.small * .24}L${ax + al},${ay}L${ax + al - m.small * .28},${ay + m.small * .24}`,
              class: "mib-arrow", fill: "none", "stroke-width": lw, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
          }
        });
      }
      sv("rect", { x: 0, y: r.barY, width: W, height: bar, rx: bar / 2, class: "mib-track" }, svg);
      sv("rect", { x: x(s.from), y: r.barY, width: Math.max(bar, x(s.to) - x(s.from)), height: bar, rx: bar / 2, fill: c }, svg);
    });
    if (two) {
      const [a, z] = series[0].to <= series[1].to ? [0, 1] : [1, 0];
      const ra = rows[a], rz = rows[z], xa = x(series[a].to), xz = x(series[z].to);
      const labelA = series[a].label ?? fmt(series[a].to), labelZ = series[z].label ?? fmt(series[z].to);
      // short row: dashed elbow down from its end to its label
      const la = ra.barY + bar + m.small * 1.6;
      sv("path", { d: `M${xa},${ra.barY + bar + lw * 2}V${la + m.small * .9}`, class: "mib-lead", "stroke-dasharray": dash, "stroke-width": lw, fill: "none" }, svg);
      txt(svg, xa + m.small * .6, la, labelA, { class: "mib-t--value", "font-size": m.small * 1.05, "font-weight": 500 });
      // long row: label above its end, dashed tick down to the bar
      const lz = rz.barY - m.small * 1.1;
      sv("path", { d: `M${xz},${lz - m.small * 2.2}V${rz.barY - lw * 2}`, class: "mib-lead", "stroke-dasharray": dash, "stroke-width": lw, fill: "none" }, svg);
      txt(svg, xz - m.small * .6, lz, labelZ, { class: "mib-t--value", "font-size": m.small * 1.05, "font-weight": 500, "text-anchor": "end" });
      // the gap callout between the two ends
      const midY = (ra.barY + bar + rz.barY) / 2 + m.small * .2;
      const gapText = fig.dataset.gap;
      let size = m.body * 1.9;
      const room = Math.max(40, xz - xa - m.small * 6);
      const tw = textW(gapText, size, cssVar(fig, "--font-display") || "sans-serif", 700);
      if (tw > room) size *= room / tw;
      const w2 = textW(gapText, size, cssVar(fig, "--font-display") || "sans-serif", 700);
      const cx = (xa + xz) / 2;
      txt(svg, cx, midY + size * .35, gapText, { class: "mib-t--gap", "font-size": size, "font-weight": 700, "text-anchor": "middle" });
      const ly = midY;
      sv("path", { d: `M${xa + m.small * .6},${ly}H${cx - w2 / 2 - m.small * .8}M${cx + w2 / 2 + m.small * .8},${ly}H${xz}V${lz - m.small * 2.2}`,
        class: "mib-lead", "stroke-dasharray": dash, "stroke-width": lw, fill: "none" }, svg);
      sv("path", { d: `M${xa},${la + m.small * .9}V${ly}H${xa + m.small * .6}`, class: "mib-lead", "stroke-dasharray": dash, "stroke-width": lw, fill: "none" }, svg);
    }
  }

  function dots(ctx) {
    const { svg, W, H, fig, series } = ctx;
    const total = +fig.dataset.max || 100, v = Math.max(0, Math.min(total, series[0].values[0]));
    let cols = Math.max(1, Math.round(Math.sqrt(total * W / H))), rowsN = Math.ceil(total / cols);
    const cw = W / cols, ch = H / rowsN, r = Math.min(cw, ch) * .3;
    const on = Math.round(v);
    const idx = [...Array(total).keys()];
    // scatter: a low-discrepancy order, the same every time, spread evenly over the field
    const order = fig.dataset.pattern === "scatter" ? idx.slice().sort((a, b) => ((a * .6180339887) % 1) - ((b * .6180339887) % 1)) : idx;
    const lit = new Set(order.slice(0, on));
    for (const i of idx) {
      const c = fig.dataset.pattern === "scatter" ? i % cols : Math.floor(i / rowsN), ro = fig.dataset.pattern === "scatter" ? Math.floor(i / cols) : i % rowsN;
      sv("circle", { cx: cw * (c + .5), cy: ch * (ro + .5), r, fill: lit.has(i) ? "var(--chart-accent, var(--chart-1))" : undefined, class: lit.has(i) ? undefined : "mib-dot-off" }, svg);
    }
  }

  function spark(el, m) {
    $$("[data-gen]", el).forEach(n => n.remove());
    el.removeAttribute("data-invalid");
    const vals = json(el, "data-spark");
    if (!Array.isArray(vals) || vals.length < 2 || vals.some(v => typeof v !== "number")) return invalid(el, "data-spark needs 2–24 numbers");
    const W = el.clientWidth, H = el.clientHeight;
    if (W < 10 || H < 6) return;
    const r = Math.max(3, m.stroke * 2), pad = r * 1.6;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const x = i => pad * .2 + i / (vals.length - 1) * (W - pad * 1.4);
    const y = v => H - pad - (hi === lo ? .5 : (v - lo) / (hi - lo)) * (H - pad * 2);
    const svg = sv("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, "data-gen": "" });
    const pts = vals.map((v, i) => [x(i), y(v)]);
    sv("path", { d: `M${pts[0][0]},${H}L${pts.map(p => p.join(",")).join("L")}L${pts[pts.length - 1][0]},${H}Z`, fill: "color-mix(in srgb, var(--chart-accent, var(--chart-1)) 10%, transparent)" }, svg);
    sv("polyline", { points: pts.map(p => p.join(",")).join(" "), fill: "none", stroke: "var(--chart-accent, var(--chart-1))", "stroke-width": Math.max(1.5, m.stroke * 1.1), "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    const last = pts[pts.length - 1];
    sv("circle", { cx: last[0], cy: last[1], r, fill: "var(--chart-accent, var(--chart-1))", class: "mib-dot", "stroke-width": r * .6 }, svg);
    el.appendChild(svg);
  }

  /* ============================================================ diagram edges */

  const SIDES = { r: [1, .5, 1, 0], l: [0, .5, -1, 0], t: [.5, 0, 0, -1], b: [.5, 1, 0, 1] };

  RENDER.diagram = b => {
    const m = metrics(b);
    $$(".diagram", b).forEach(d => {
      $$(":scope > .mib-edges", d).forEach(n => n.remove());
      const nodes = $$(":scope > .node", d);
      nodes.forEach(n => (n.style.minHeight = ""));
      const tallest = Math.max(0, ...nodes.map(n => n.offsetHeight));
      nodes.forEach(n => { if (n.style.gridRow.includes("span 1") || !/span [2-9]/.test(n.style.gridRow)) n.style.minHeight = tallest + "px"; });
      const byId = new Map();
      nodes.forEach(n => {
        if (!n.dataset.id) return invalid(n, "node needs data-id");
        if (byId.has(n.dataset.id)) invalid(n, `duplicate data-id "${n.dataset.id}"`);
        byId.set(n.dataset.id, { x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight });
      });
      const svg = sv("svg", { class: "mib-edges", width: d.clientWidth, height: d.clientHeight, "data-gen": "" });
      const lw = Math.max(1.5, m.stroke * 1.1), head = Math.max(9, lw * 5.2), gap = Math.max(3, m.stroke * 2), radius = Math.max(6, m.stroke * 6);
      // several connections on one side of a node spread along that side, ordered by where the
      // other end sits, so fan-outs don't share a line or stack their labels
      const edges = [];
      $$(":scope > .edge", d).forEach(e => {
        e.removeAttribute("data-invalid");
        e.style.cssText = "";
        const a = byId.get(e.dataset.from), z = byId.get(e.dataset.to);
        if (!a || !z) return invalid(e, `unknown node "${!a ? e.dataset.from : e.dataset.to}"`);
        const [s1, s2] = sidesFor(a, z, e.dataset.ports);
        edges.push({ e, a, z, s1, s2, fa: .5, fz: .5 });
      });
      const slots = new Map();
      const slot = (key, entry) => (slots.get(key) || slots.set(key, []).get(key)).push(entry);
      edges.forEach(x => {
        slot(`${x.e.dataset.from}:${x.s1}`, { x, end: "fa", other: x.z, side: x.s1 });
        slot(`${x.e.dataset.to}:${x.s2}`, { x, end: "fz", other: x.a, side: x.s2 });
      });
      for (const list of slots.values()) {
        if (list.length < 2) continue;
        const along = s => (s.side === "l" || s.side === "r") ? s.other.y + s.other.h / 2 : s.other.x + s.other.w / 2;
        list.sort((p, q) => along(p) - along(q));
        list.forEach((s, i) => { s.x[s.end] = (i + 1) / (list.length + 1); });
      }
      edges.forEach(({ e, a, z, s1, s2, fa, fz }) => {
        const pts = route(a, z, s1, s2, gap, fa, fz);
        const style = e.dataset.style || "arrow";
        const arrowEnd = style === "arrow" || style === "dashed" || style === "both", arrowStart = style === "both";
        if (arrowEnd) shorten(pts, pts.length - 1, head * .8);
        if (arrowStart) shorten(pts, 0, head * .8);
        const g = sv("g", { class: "mib-edge" }, svg);
        sv("path", { d: roundedPath(pts, radius), fill: "none", stroke: "currentColor", "stroke-width": lw,
          "stroke-dasharray": style === "dashed" ? `${lw * 3.5} ${lw * 2.5}` : undefined, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
        if (arrowEnd) arrow(g, pts[pts.length - 2], pts[pts.length - 1], head);
        if (arrowStart) arrow(g, pts[1], pts[0], head);
        placeLabel(e, pts, m);
      });
      d.prepend(svg);
    });
  };

  // frac: where along the side the connection attaches (0.5 = the middle)
  function sidePoint(r, side, gap, frac = .5) {
    const [fx, fy, dx, dy] = SIDES[side];
    const horizontalSide = side === "l" || side === "r";
    return { x: r.x + r.w * (horizontalSide ? fx : frac) + dx * gap, y: r.y + r.h * (horizontalSide ? frac : fy) + dy * gap, side };
  }

  function sidesFor(a, z, ports) {
    const acx = a.x + a.w / 2, acy = a.y + a.h / 2, zcx = z.x + z.w / 2, zcy = z.y + z.h / 2;
    const forced = /^([trbl])-([trbl])$/.exec(ports || "");
    if (forced) return [forced[1], forced[2]];
    if (Math.abs(acy - zcy) < Math.min(a.h, z.h) / 2) return zcx > acx ? ["r", "l"] : ["l", "r"];
    if (Math.abs(acx - zcx) < Math.min(a.w, z.w) / 2) return zcy > acy ? ["b", "t"] : ["t", "b"];
    return [zcx > acx ? "r" : "l", zcy > acy ? "t" : "b"];
  }

  function route(a, z, s1, s2, gap, fa = .5, fz = .5) {
    const p = sidePoint(a, s1, gap, fa), q = sidePoint(z, s2, gap, fz);
    const h1 = s1 === "l" || s1 === "r", h2 = s2 === "l" || s2 === "r";
    if (h1 && h2) {
      if (Math.abs(p.y - q.y) < 1) return [p, { x: q.x, y: p.y }];
      const mx = (p.x + q.x) / 2;
      return [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q];
    }
    if (!h1 && !h2) {
      if (Math.abs(p.x - q.x) < 1) return [p, { x: p.x, y: q.y }];
      const my = (p.y + q.y) / 2;
      return [p, { x: p.x, y: my }, { x: q.x, y: my }, q];
    }
    return h1 ? [p, { x: q.x, y: p.y }, q] : [p, { x: p.x, y: q.y }, q];
  }

  function shorten(pts, i, by) {
    const o = pts[i], n = pts[i === 0 ? 1 : i - 1];
    const len = Math.hypot(o.x - n.x, o.y - n.y);
    if (len < by * 1.5) return;
    o.x += (n.x - o.x) / len * by;
    o.y += (n.y - o.y) / len * by;
  }

  function roundedPath(pts, r) {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], a = pts[i - 1], c = pts[i + 1];
      const la = Math.hypot(p.x - a.x, p.y - a.y), lc = Math.hypot(c.x - p.x, c.y - p.y);
      const rr = Math.min(r, la / 2, lc / 2);
      d += `L${p.x - (p.x - a.x) / la * rr},${p.y - (p.y - a.y) / la * rr}Q${p.x},${p.y} ${p.x + (c.x - p.x) / lc * rr},${p.y + (c.y - p.y) / lc * rr}`;
    }
    const e = pts[pts.length - 1];
    return d + `L${e.x},${e.y}`;
  }

  function arrow(g, from, to, size) {
    const ang = Math.atan2(to.y - from.y, to.x - from.x), w = size * .42;
    const tip = { x: to.x + Math.cos(ang) * size * .8, y: to.y + Math.sin(ang) * size * .8 };
    const bx = tip.x - Math.cos(ang) * size, by = tip.y - Math.sin(ang) * size;
    sv("path", { d: `M${tip.x},${tip.y}L${bx - Math.sin(ang) * w},${by + Math.cos(ang) * w}L${bx + Math.sin(ang) * w},${by - Math.cos(ang) * w}Z`, fill: "currentColor" }, g);
  }

  function placeLabel(e, pts, m) {
    if (!e.textContent.trim() && !editing) return;
    let best = 0, len = -1;
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      if (l > len) { len = l; best = i; }
    }
    const p = pts[best], q = pts[best + 1], mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    const horizontal = Math.abs(q.y - p.y) < 1;
    // PRIMITIVES §7: a labelled segment crosses an empty cell. When the label is wider than its
    // line, the nodes sit too close for it; say so instead of drawing it over a node.
    if (horizontal && e.textContent.trim() && textW(e.textContent.trim(), m.small, m.mono) + m.small > len) {
      invalid(e, "edge label is longer than its line; leave an empty column between these nodes");
    }
    e.style.left = mx + (horizontal ? 0 : m.small * .6) + "px";
    e.style.top = my - (horizontal ? m.small * .45 : 0) + "px";
    e.style.transform = horizontal ? "translate(-50%, -100%)" : "translate(0, -50%)";
    e.style.display = "block";
  }

  const rerouteSoon = debounce(b => RENDER.diagram(b), 120);
  sheet.addEventListener("input", e => { const b = e.target.closest?.(".board"); if (b && e.target.closest(".diagram")) rerouteSoon(b); });

  /* ---------- node drag, by whole cells, edit mode only */
  let drag = null;
  sheet.addEventListener("pointerdown", e => {
    if (!editing || e.button !== 0) return;
    const node = e.target.closest?.(".diagram > .node");
    if (!node || e.target.isContentEditable) return;
    e.preventDefault();
    drag = { node, d: node.parentElement, b: node.closest(".board"), start: node.dataset.at, moved: false };
    node.setPointerCapture(e.pointerId);
    node.classList.add("is-dragging");
  });
  sheet.addEventListener("pointermove", e => {
    if (!drag) return;
    const { node, d, b } = drag;
    const s = +b.dataset.mibScale || 1, r = d.getBoundingClientRect();
    const cols = +d.dataset.cols || 4, rows = +d.dataset.rows || 3;
    const [sw, sh] = cell(node.dataset.span) || [1, 1];
    const lx = (e.clientX - r.left) / s, ly = (e.clientY - r.top) / s;
    const c = Math.min(cols - sw + 1, Math.max(1, Math.floor(lx / (d.clientWidth / cols)) + 1));
    const ro = Math.min(rows - sh + 1, Math.max(1, Math.floor(ly / (d.clientHeight / rows)) + 1));
    const at = `${c},${ro}`;
    if (at === node.dataset.at) return;
    if (!drag.moved) { commitText(); snapshot(); drag.moved = true; }
    node.dataset.at = at;
    RENDER.place(b);
    RENDER.diagram(b);
  });
  const endDrag = () => {
    if (!drag) return;
    drag.node.classList.remove("is-dragging");
    if (drag.moved) checkBoard(drag.b);
    drag = null;
  };
  sheet.addEventListener("pointerup", endDrag);
  sheet.addEventListener("pointercancel", endDrag);

  /* ============================================================ keys, boot */

  document.addEventListener("keydown", e => {
    if (hosted) return;
    const meta = e.metaKey || e.ctrlKey;
    const typing = e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (meta && e.key.toLowerCase() === "z" && editing) {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (typing || meta || e.altKey) return;
    if (e.key === "e" || e.key === "E") { e.preventDefault(); toggleEdit(); }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); stepBoard(e.key === "ArrowLeft" ? -1 : 1); }
    if ((e.key === "g" || e.key === "G") && boards.length > 1) { e.preventDefault(); openPicker(); }
    if ((e.key === "n" || e.key === "N") && editing) { e.preventDefault(); noteDialog(); }
  });
  window.addEventListener("resize", debounce(fit, 120));

  /* ?mib-board=N (0-based): render only that board, at true size, at the page origin, with no chrome
     and a transparent page. For headless export (export.py); <html data-mib-ready> marks it done. */
  const params = new URLSearchParams(location.search);
  const only = params.get("mib-board"), print = params.get("mib-print");
  if (hosted) {
    /* the host mounts boards and calls decorate() / check() on them */
  } else if (print !== null) {
    document.documentElement.classList.add("mib-solo", "mib-print");
    mountBoards();
    document.fonts.ready.then(async () => {
      mountBoards();
      const n = printLayout(print.toLowerCase(), params.get("mib-boards"), params.get("mib-bleed") === "1");
      await assetsIdle();
      requestAnimationFrame(() => document.documentElement.setAttribute("data-mib-ready", n ? `pages:${n}` : "missing"));
    });
  } else if (only !== null) {
    document.documentElement.classList.add("mib-solo");
    activeTab = String(+only);
    const settle = () => {
      mountBoards();
      boards.forEach((b, i) => {
        frameOf(b).hidden = i !== +only;
        b.style.transform = "none";
        b.parentElement.style.width = b.offsetWidth + "px";
        b.parentElement.style.height = b.offsetHeight + "px";
      });
    };
    settle();
    document.fonts.ready.then(async () => {
      settle();
      await assetsIdle();
      requestAnimationFrame(() => document.documentElement.setAttribute("data-mib-ready", boards[+only] ? "ok" : "missing"));
    });
  } else {
    mountBar();
    mountBoards();
    document.fonts.ready.then(() => { mountBoards(); });
  }

  window.makeitbrand = {
    render: RENDER, boards: () => boards, refresh: mountBoards, decorate, check: checkBoard, idle: assetsIdle, hosted,
    boardPNG, boardSVG, markup: boardsMarkup, html: sheetHTML, exportBoard, exportPDF, pdfGroups,
  };
})();
