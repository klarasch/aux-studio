/* Studio editor — a Figma-like canvas on top of the engine (engine/studio.js).
   Left: layers (content sections + frames). Center: pannable/zoomable canvas with every frame at native size;
   click to select a frame, click text/photos to select elements, double-click text to edit in place.
   Floating toolbar = quick controls for the selection. Right: inspector. Export: one panel. */
(function () {
'use strict';
const X = Studio._;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = X.esc;

/* ═════════════ view state ═════════════ */
const view = { x: 40, y: 40, z: .25 };
let sel = null;            // { type:'frame'|'text'|'photo'|'content'|'post'|'newpost', id?, path?, key? }
let editing = null;        // element being edited inline
let layout = new Map();    // frameId → { x, y, w, h, a }
let groupsLayout = [];     // [{ tpl, x, y, w, h }]
let collapsed = new Set(JSON.parse(localStorage.getItem('studio:collapsed') || '[]'));
const hist = { stack: [], i: -1, t: null, quiet: false };

const S = () => X.S, B = () => X.B;
const assets = () => X.assetList().flatMap(g => g.assets);
const assetById = id => assets().find(a => a.id === id);
// a frame that is a page of a paged design: the design's own page, or a page of another template (a Speaker page in a carousel)
const containerOf = a => X.templates[a.post.template];
const isPage = a => !!(containerOf(a).pagesOwn && (a.item.slideIndex != null || a.item.page === 'each'));
const pageIdx = a => a.item.slideIndex ?? a.item.index;
const ov = id => X.S.overrides[id] || {};

/* ═════════════ undo / redo (snapshots of the set) ═════════════ */
function snapshot() { return JSON.stringify(X.S); }
function recordNow() {
  const snap = snapshot();
  if (hist.stack[hist.i] === snap) return;
  hist.stack = hist.stack.slice(0, hist.i + 1); hist.stack.push(snap);
  if (hist.stack.length > 80) hist.stack.shift();
  hist.i = hist.stack.length - 1; updateUndo();
}
function record() { if (hist.quiet) return; clearTimeout(hist.t); hist.t = setTimeout(recordNow, 350); }
function travel(d) {
  clearTimeout(hist.t); recordNow();
  const j = hist.i + d; if (j < 0 || j >= hist.stack.length) return;
  hist.i = j; hist.quiet = true; X.S = JSON.parse(hist.stack[j]); X.persist(); X.syncJson(); refreshPanels(); render(); hist.quiet = false; updateUndo();
}
function updateUndo() { const u = $('#undo'), r = $('#redo'); if (u) u.disabled = hist.i <= 0; if (r) r.disabled = hist.i >= hist.stack.length - 1; }

/* ═════════════ shell ═════════════ */
function mount() {
  if (Studio.sheet?.wanted()) { document.body.classList.remove('studio2'); return Studio.sheet.mount(); } // a phone, or ?view=sheet: the light view (sheet.js)
  document.body.classList.remove('sheetv'); document.body.classList.add('studio2');
  $('#app').innerHTML = `
  <header class="topbar">
    <div class="tb-brand">${B().logo.svg ? `<svg class="mk" viewBox="${B().logo.viewBox}">${B().logo.svg}</svg>` : B().logo.url ? `<img class="mk" src="${B().logo.url}" alt="">` : ''}<b>${esc(B().studioName || "Studio")}</b></div>
    <input class="tb-name" id="docName" placeholder="Untitled project" title="Project name" spellcheck="false">
    <div class="tb-sp"></div>
    <div class="tb-group hist"><button class="ib" id="undo" title="Undo (⌘Z)"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 5 3.5 9l4 4"/><path d="M3.5 9h8a5 5 0 0 1 0 10H9"/></svg></button><button class="ib" id="redo" title="Redo (⇧⌘Z)"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12.5 5 4 4-4 4"/><path d="M16.5 9h-8a5 5 0 0 0 0 10H11"/></svg></button></div>
    <div class="tb-group zoom"><button class="ib" id="zOut" title="Zoom out (⌘−)">−</button><button class="zlabel" id="zLabel" title="Zoom to fit (⇧1)">25%</button><button class="ib" id="zIn" title="Zoom in (⌘+)">+</button></div>
    <button class="btn save" id="saveBtn" title="Save the project as one file that opens anywhere (⌘S)">Save</button>
    <button class="ib more" id="dataBtn" title="Project: open a file, share a link, data" aria-label="Project">${IC.more}</button>
    <button class="btn primary" id="exportBtn">Export</button>
  </header>
  <aside id="left" class="ui-panel" data-ui-clear></aside>
  <main id="stage"><div id="world" data-ui-clear></div><div id="ftb" class="ftb" hidden></div><div class="stage-hint" id="stageHint"></div></main>
  <aside id="right" class="ui-panel" data-ui-clear></aside>
  <div id="modal" class="modal" hidden data-ui-clear></div>`;
  bindTopbar(); bindStage(); bindKeys();
  $('#filePick').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f || !X.pickPath) return;
    const [pid, path] = X.pickPath.includes('|') ? X.pickPath.split('|') : [null, X.pickPath];
    X.setContent(pid, path, await X.readImage(f)); X.pickPath = null; X.changed({ form: true });
  });
  refreshPanels(); render(); recordNow();
  requestAnimationFrame(() => fitAll());
}
function reset() { sel = null; }

/* ═════════════ layout of frames on the canvas ═════════════ */
const GAP = 90, ROW = 720, LABEL = 60;
// multi-item posts (carousels, spotlights) with several sizes: one row per size, items left to right.
// A design whose pages are its own gets a row per size even with one page: each row ends with its "add a page" tile
function sizeRows(g) {
  const fks = [...new Set(g.assets.map(a => a.fk))], items = new Set(g.assets.map(a => a.item.key));
  return (items.size > 1 || g.tpl.pagesOwn) && fks.length > 1 ? fks.map(fk => g.assets.filter(a => a.fk === fk)) : [g.assets];
}
function computeLayout() {
  layout = new Map(); groupsLayout = [];
  let y = 0;
  for (const g of X.assetList()) {
    const gy = y + LABEL * 1.6, rows = sizeRows(g);
    let ry = gy, maxW = 0;
    rows.forEach((row, ri) => {
      let x = 0, h = 0, lastItem = null;
      for (const a of row) {
        if (rows.length === 1 && lastItem !== null && a.item.key !== lastItem) x += GAP * .8; // a little air between items
        lastItem = a.item.key;
        layout.set(a.id, { x, y: ry, w: a.fmt.w, h: a.fmt.h, a });
        x += a.fmt.w + GAP; h = Math.max(h, a.fmt.h);
      }
      maxW = Math.max(maxW, x - GAP);
      ry += h + (ri < rows.length - 1 ? GAP * 3.2 : 0);
    });
    groupsLayout.push({ tpl: g.tpl, post: g.post, g, x: 0, y, w: Math.max(maxW, 600), h: ry - y });
    y = Math.max(ry, gy + 400) + ROW;
  }
}

/* ═════════════ render the canvas ═════════════ */
// a text being typed survives a redraw of the canvas (one comes ~90ms after the previous text is committed, so clicking from one
// text straight into the next used to drop the new edit): its typed content and caret move to the same text in the new canvas
function caretAt(f) { const s = getSelection(); if (!s.rangeCount || !f.contains(s.anchorNode)) return null; const r = document.createRange(); r.selectNodeContents(f); r.setEnd(s.anchorNode, s.anchorOffset); return r.toString().length; }
function setCaret(f, n) {
  const r = document.createRange(), w = document.createTreeWalker(f, NodeFilter.SHOW_TEXT); let t, left = n ?? Infinity, last = null;
  while ((t = w.nextNode())) { last = t; if (left <= t.length) { r.setStart(t, left); break; } left -= t.length; }
  if (!t) { if (last) r.setStart(last, last.length); else r.selectNodeContents(f); r.collapse(!last); } else r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function render() {
  const world = $('#world'); if (!world) return;
  const keep = editing && editing.isConnected ? { id: editing.closest('.asset')?.dataset.id, path: editing.dataset.f, html: editing.innerHTML, orig: editing.dataset.orig, origHtml: editing._origHtml, caret: caretAt(editing) } : null;
  editing = null;
  computeLayout();
  const parts = [];
  for (const gl of groupsLayout) {
    parts.push(`<div class="glabel" data-post="${gl.post.id}" style="left:0;top:${gl.y + LABEL * 1.6}px">${esc(gl.g.label)}<span>${gl.g.assets.length}</span></div>`);
    if (!gl.g.assets.length) parts.push(`<div class="gempty" style="left:0;top:${gl.y + LABEL * 1.6}px">${esc(gl.tpl.empty || 'Nothing to render yet.')}</div>`);
  }
  for (const [id, L] of layout) {
    const a = L.a, o = ov(id), edits = Object.keys(o).filter(k => !k.startsWith('__')).length;
    parts.push(`<div class="fr" data-id="${id}" style="left:${L.x}px;top:${L.y}px;width:${L.w}px;height:${L.h}px">
      <div class="flabel"><span>${esc(a.fmt.label)}${a.item.label ? ' / ' + esc(a.item.label) : ''}</span>${o.__motion ? '<i class="fl-motion" title="Animated">◷</i>' : ''}${edits ? `<i class="fl-edit" title="${edits} edit(s) on this frame">●</i>` : ''}</div>
      ${X.renderAsset(a)}</div>`);
  }
  for (const gl of groupsLayout) { // a paged design ends each row with a tile that adds a page
    const t = gl.g.tpl; if (!t.pagesOwn) continue;
    const full = (gl.post.fields[t.pagesOwn] || []).length >= t.lists.find(x => x.key === t.pagesOwn).max;
    for (const fk of full ? [] : gl.post.formats) {
      const row = gl.g.assets.filter(a => a.fk === fk).map(a => layout.get(a.id)); if (!row.length) continue;
      const last = row.at(-1);
      parts.push(`<button class="fr-add" data-addpage="${gl.g.assets.filter(a => a.fk === fk).at(-1).id}" style="left:${last.x + last.w + GAP}px;top:${last.y}px;width:${last.w * .5}px;height:${last.h}px" title="Add a page"><span>+</span></button>`);
    }
  }
  world.innerHTML = parts.join('');
  applyView();
  if (keep) {
    const f = $(`#world .fr[data-id="${CSS.escape(keep.id)}"] [data-f="${CSS.escape(keep.path)}"]`);
    if (f) { f.innerHTML = keep.html; f.removeAttribute('data-ph'); f.dataset.orig = keep.orig; f._origHtml = keep.origHtml; f.contentEditable = 'true'; editing = f; f.focus(); setCaret(f, keep.caret); }
    else { const tmp = document.createElement('div'); tmp.innerHTML = keep.html; const v = fromEditHtml(tmp); if (keep.id && v !== keep.orig) { writeText(keep.id, keep.path, v); X.changed({ form: true }); } } // the text is gone from the canvas: keep what was typed
  }
  // empty project: the template library is the first thing you see
  const hint = $('#stageHint');
  if (S().posts.length) hint.innerHTML = ''; // a design with nothing to draw yet still has its place on the canvas
  else if (!$('.lib', hint)) {
    hint.innerHTML = `<div class="lib-empty"><div class="lib-h"><b>Pick a template</b><span>Start with one design. You can add more, change sizes and switch template later.</span></div>
      ${libraryHTML()}${window.STUDIO_EXAMPLE ? '<div class="btnrow"><button class="lnk" data-example>Or open the example project</button></div>' : ''}</div>`;
    bindLibrary(hint);
    const ex = $('[data-example]', hint); if (ex) ex.onclick = () => { X.S = X.normalize(window.STUDIO_EXAMPLE); sel = null; X.changed({ form: true }); requestAnimationFrame(fitAll); };
  }
  document.fonts.ready.then(() => {
    $$('.fr', world).forEach(fr => {
      const a = layout.get(fr.dataset.id)?.a; if (!a) return;
      const node = X.fitBest(a, $('.asset', fr));
      fr.classList.toggle('warn', X.hitsShapes(node));
    });
    paintSelection();
    document.dispatchEvent(new CustomEvent('studio:rendered', { detail: { cards: $$('.fr', world).map(fr => ({ id: fr.dataset.id, card: fr, node: $('.asset', fr) })) } }));
  });
  const dn = $('#docName'); if (dn && document.activeElement !== dn) dn.value = S().name || ''; if (dn) dn.title = S().name || 'Project name';
}

/* ═════════════ template library (empty state + "New post") ═════════════ */
function libraryHTML() {
  const card = id => { const t = X.templates[id], sz = X.allowedFormats(t, t.channels);
    return `<button class="tplc" data-newpost="${id}"><div class="tplc-pv" data-tplpv="${id}"></div><b>${esc(t.label)}</b><span>${esc(t.description || '')}</span><em>${sz.map(fmtChip).join('')}</em></button>`; };
  // templates may name a group (data-group): the library shows a heading per group, in the order they first appear
  const groups = [...new Set(X.order.map(id => X.templates[id].group || ''))];
  if (groups.length < 2 && !groups[0]) return `<div class="lib">${X.order.map(card).join('')}</div>`;
  return groups.map(g => `${g ? `<h3 class="lib-g">${esc(g)}</h3>` : ''}<div class="lib">${X.order.filter(id => (X.templates[id].group || '') === g).map(card).join('')}</div>`).join('');
}
function bindLibrary(root, after) {
  root.querySelectorAll('[data-newpost]').forEach(b => b.onclick = () => { after && after(); addPost(b.dataset.newpost); });
  // thumbnails: each template rendered with its starter content, scaled down
  const paint = () => root.querySelectorAll('[data-tplpv]').forEach(box => {
    try {
      const { a, html } = X.previewAsset(box.dataset.tplpv), W = 168, k = W / a.fmt.w;
      box.style.height = Math.min(210, a.fmt.h * k) + 'px';
      box.innerHTML = `<div class="tplc-sc" style="width:${a.fmt.w}px;height:${a.fmt.h}px;transform:scale(${k})">${html}</div>`;
      X.fit(box.querySelector('.asset'));
    } catch (e) { console.warn('[studio] no preview for', box.dataset.tplpv, e); }
  });
  paint(); document.fonts.ready.then(paint);
}
function openLibrary() {
  const m = openModal(`<div class="sh-h"><b>New design</b><button class="ib" data-close>×</button></div>
    <p class="ip-note">Pick a template. You can change sizes, content and the template itself afterwards.</p>${libraryHTML()}`, 'wide lib-dlg');
  bindLibrary(m, closeModal);
}
function addPost(tid) {
  const p = X.newPost(tid); X.S.posts.push(p); X.changed({ form: true });
  select({ type: 'post', key: p.id }); setTimeout(() => zoomToGroup(p.id), 300);
}
function applyView() {
  const w = $('#world'); if (!w) return;
  w.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.z})`;
  w.style.setProperty('--inv', 1 / view.z);
  $('#zLabel').textContent = Math.round(view.z * 100) + '%';
  positionToolbar();
}
function zoomAt(z, cx, cy) {
  z = Math.min(2, Math.max(.04, z));
  const r = $('#stage').getBoundingClientRect(); cx ??= r.width / 2; cy ??= r.height / 2;
  view.x = cx - (cx - view.x) * (z / view.z); view.y = cy - (cy - view.y) * (z / view.z); view.z = z; applyView();
}
function fitRect(x, y, w, h, pad = 60) {
  const r = $('#stage').getBoundingClientRect();
  const z = Math.min(1.2, (r.width - pad * 2) / w, (r.height - pad * 2) / h);
  view.z = Math.max(.04, z); view.x = (r.width - w * view.z) / 2 - x * view.z; view.y = (r.height - h * view.z) / 2 - y * view.z; applyView();
}
function fitAll() {
  if (!layout.size) return;
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  for (const gl of groupsLayout) { x1 = Math.min(x1, gl.x); y1 = Math.min(y1, gl.y); x2 = Math.max(x2, gl.x + gl.w); y2 = Math.max(y2, gl.y + gl.h); }
  fitRect(x1, y1, x2 - x1, y2 - y1);
}
function zoomToFrame(id) { const L = layout.get(id); if (L) fitRect(L.x, L.y, L.w, L.h, 90); }
function zoomToGroup(pid) { const gl = groupsLayout.find(g => g.post.id === pid); if (gl) fitRect(gl.x, gl.y, gl.w, gl.h, 50); }

/* ═════════════ selection ═════════════ */
function select(s, opts = {}) {
  sel = s; paintSelection(); renderInspector(); renderLayers();
  if (opts.zoom && s?.id) zoomToFrame(s.id);
}
function paintSelection() {
  $$('#world .sel').forEach(el => el.classList.remove('sel'));
  $$('#world .el-sel').forEach(el => el.classList.remove('el-sel'));
  if (sel?.id) {
    const fr = $(`#world .fr[data-id="${CSS.escape(sel.id)}"]`);
    if (fr) {
      fr.classList.add('sel');
      if (sel.type === 'text') $$(`[data-f="${CSS.escape(sel.path)}"]`, fr).forEach(el => el.classList.add('el-sel'));
      if (sel.type === 'photo') $$(`[data-p="${CSS.escape(sel.path)}"]`, fr).forEach(el => el.classList.add('el-sel'));
      $$('.st-h', fr).forEach(x => x.remove());
      if (sel.type === 'sticker') { const st = $(`.sticker[data-st="${sel.idx}"]`, fr); if (st) { st.classList.add('el-sel'); st.insertAdjacentHTML('beforeend', '<i class="st-h" title="Drag to resize"></i>'); } }
    }
  }
  if (sel?.type === 'post') $$(`#world .fr`).forEach(fr => { if (fr.dataset.id.startsWith(sel.key + '.')) fr.classList.add('sel'); });
  renderToolbar();
}

/* ═════════════ stage interaction: pan, zoom, select, edit ═════════════ */
function bindStage() {
  const stage = $('#stage');
  stage.addEventListener('wheel', e => {
    if (e.target.closest('.lib-empty')) return; // the library scrolls like a page
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const r = stage.getBoundingClientRect(); zoomAt(view.z * Math.exp(-e.deltaY * .0025), e.clientX - r.left, e.clientY - r.top); }
    else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
  }, { passive: false });

  let pan = null, drag = null, sdrag = null, spaceDown = false;
  document.addEventListener('keydown', e => { if (e.code === 'Space' && !isTyping(e)) { spaceDown = true; stage.classList.add('grab'); } });
  document.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; stage.classList.remove('grab'); } });

  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('.ftb, .lib-empty, .fr-add')) return;
    if (editing && e.target.closest('[contenteditable]')) return;
    const onFrame = e.target.closest('.fr');
    if (e.button === 1 || spaceDown || (!onFrame && !e.target.closest('.glabel'))) {
      pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; stage.setPointerCapture(e.pointerId); stage.classList.add('panning'); return;
    }
    const st = e.target.closest('.sticker');
    if (st) {
      const id = onFrame.dataset.id, idx = +st.dataset.st, s0 = ov(id).__stickers[idx], fr = onFrame.getBoundingClientRect();
      commitEdit(); if (!(sel.type === 'sticker' && sel.idx === idx)) select({ type: 'sticker', id, idx });
      sdrag = { id, idx, resize: !!e.target.closest('.st-h'), x: e.clientX, y: e.clientY, s0: { ...s0 }, fw: fr.width, fh: fr.height, el: $(`#world .fr[data-id="${CSS.escape(id)}"] .sticker[data-st="${idx}"]`) };
      stage.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    const p = e.target.closest('[data-p]');
    if (p && sel?.type === 'photo' && sel.path === p.dataset.p && sel.id === onFrame.dataset.id) {
      const pos = getComputedStyle(p).backgroundPosition.split(' ').map(parseFloat);
      drag = { p, x: e.clientX, y: e.clientY, px: pos[0], py: pos[1], moved: false }; stage.setPointerCapture(e.pointerId);
    }
  });
  stage.addEventListener('pointermove', e => {
    if (pan) { const dx = e.clientX - pan.x, dy = e.clientY - pan.y; if (Math.hypot(dx, dy) > 3) pan.moved = true; view.x = pan.vx + dx; view.y = pan.vy + dy; applyView(); return; }
    if (sdrag) {
      const dx = (e.clientX - sdrag.x) / sdrag.fw * 100, dy = (e.clientY - sdrag.y) / sdrag.fh * 100, s0 = sdrag.s0, el = $(`#world .fr[data-id="${CSS.escape(sdrag.id)}"] .sticker[data-st="${sdrag.idx}"]`);
      if (sdrag.resize) sdrag.now = { ...s0, w: Math.max(4, Math.min(120, s0.w + dx)) };
      else sdrag.now = { ...s0, x: +(s0.x + dx).toFixed(2), y: +(s0.y + dy).toFixed(2) };
      if (el) { el.style.left = sdrag.now.x + '%'; el.style.top = sdrag.now.y + '%'; el.style.width = sdrag.now.w + '%'; }
      positionToolbar(); return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (!drag.moved && Math.hypot(dx, dy) < 3) return; drag.moved = true;
      const r = drag.p.getBoundingClientRect();
      drag.p.style.backgroundPosition = `${Math.max(0, Math.min(100, drag.px - dx / r.width * 160)).toFixed(1)}% ${Math.max(0, Math.min(100, drag.py - dy / r.height * 160)).toFixed(1)}%`;
    }
  });
  stage.addEventListener('pointerup', e => {
    stage.classList.remove('panning');
    if (sdrag) { const d = sdrag; sdrag = null; if (d.now) { ov(d.id).__stickers[d.idx] = d.now; X.changed(); } return; }
    if (pan) { const moved = pan.moved; pan = null; if (!moved && !e.target.closest('.fr, .glabel')) { commitEdit(); select(null); } return; }
    if (drag) {
      const { p, moved } = drag; drag = null;
      if (moved) { const id = p.closest('.asset').dataset.id; (X.S.overrides[id] ||= {})['pos:' + p.dataset.p] = p.style.backgroundPosition; X.changed(); return; }
    }
  });
  stage.addEventListener('click', e => {
    if (e.target.closest('.ftb') || e.target.closest('[contenteditable]') || e.target.closest('.sticker')) return;
    const gl = e.target.closest('.glabel'); if (gl) { commitEdit(); select({ type: 'post', key: gl.dataset.post }); return; }
    const ad = e.target.closest('.fr-add'); if (ad) { commitEdit(); pageOps(assetById(ad.dataset.addpage)).add(); return; }
    const fr = e.target.closest('.fr'); if (!fr) return;
    const id = fr.dataset.id;
    const pe = e.target.closest('.panel.empty, figure.media[data-empty]');
    if (pe && !e.target.closest('[data-f]')) { commitEdit(); select({ type: 'photo', id, path: pe.dataset.p }); X.pickPath = id.split('.')[0] + '|' + pe.dataset.p; $('#filePick').click(); return; }
    if (e.target.closest('.flabel')) { commitEdit(); select({ type: 'frame', id }); return; }
    const f = e.target.closest('[data-f]'), p = e.target.closest('[data-p]');
    // a click on a text starts editing it, caret where you clicked
    if (f) { if (editing !== f) { commitEdit(); select({ type: 'text', id, path: f.dataset.f }); startEdit(f, e); } return; }
    // otherwise the first click selects the frame; clicks inside an already-selected frame select elements (like Figma)
    if (sel?.id !== id || sel.type === 'post') { commitEdit(); select({ type: 'frame', id }); return; }
    if (p) { commitEdit(); select({ type: 'photo', id, path: p.dataset.p }); return; }
    commitEdit(); select({ type: 'frame', id });
  });
  stage.addEventListener('dblclick', e => {
    const fr = e.target.closest('.fr'); if (!fr) { fitAll(); return; }
    const f = e.target.closest('[data-f]'), p = e.target.closest('[data-p]');
    if (f) { if (editing === f) return; /* already editing: the browser selects the word */ select({ type: 'text', id: fr.dataset.id, path: f.dataset.f }); startEdit(f); return; }
    if (p) { X.pickPath = fr.dataset.id.split('.')[0] + '|' + p.dataset.p; $('#filePick').click(); return; }
    select({ type: 'frame', id: fr.dataset.id }, { zoom: true });
  });
  // inline edit keys
  stage.addEventListener('keydown', e => {
    if (!editing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitEdit(); }
    if (e.key === 'Escape') { e.stopPropagation(); editing.innerHTML = editing._origHtml; commitEdit(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); X.toggleStrong(); }
  });
  // a text on the canvas takes plain text and the highlight only: no pasted markup, no italics, no block breaks
  stage.addEventListener('paste', e => { if (!editing || !editing.contains(e.target)) return; e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\r?\n/g, ' ')); });
  stage.addEventListener('beforeinput', e => { if (editing && (e.inputType === 'insertParagraph' || (e.inputType.startsWith('format') && e.inputType !== 'formatBold'))) e.preventDefault(); });
  // drop images on photos
  stage.addEventListener('dragover', e => { const p = e.target.closest('[data-p]'); if (p) { e.preventDefault(); p.classList.add('drop'); } });
  stage.addEventListener('dragleave', e => { const p = e.target.closest('[data-p]'); if (p) p.classList.remove('drop'); });
  stage.addEventListener('dragover', e => { if (e.target.closest('.fr') && !e.target.closest('[data-p]')) e.preventDefault(); });
  stage.addEventListener('drop', async e => {
    const p = e.target.closest('[data-p]'), fr = e.target.closest('.fr');
    if (!p && fr) { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) addSticker(fr.dataset.id, f); return; }
    if (!p) return; e.preventDefault();
    const f = e.dataTransfer.files[0]; if (!f || !f.type.startsWith('image/')) return;
    X.setContent(p.closest('.asset').dataset.id.split('.')[0], p.dataset.p, await X.readImage(f)); X.changed({ form: true });
  });
  new ResizeObserver(() => positionToolbar()).observe(stage);
}
/* Editing a text on the canvas shows the highlight as it will look: *word* becomes a <strong> while typing and goes back to
   *word* when the edit is committed (⌘B or the Highlight button toggles it; typing the asterisks still works). */
const toEditHtml = raw => esc(String(raw ?? '')).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
function fromEditHtml(root) {
  let out = '';
  const walk = (n, inBold) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeName === 'BR') out += '\n';
      else if (c.nodeType === 1) {
        const block = c.nodeName === 'DIV' || c.nodeName === 'P';
        if (block && out && !out.endsWith('\n')) out += '\n';
        const bold = c.nodeName === 'B' || c.nodeName === 'STRONG' || /^(bold|[6-9]00)$/.test(c.style?.fontWeight || '');
        if (bold && !inBold) {
          const start = out.length; walk(c, true);
          const m = out.slice(start).match(/^(\s*)([\s\S]*?)(\s*)$/);
          out = out.slice(0, start) + (m[2] ? `${m[1]}*${m[2]}*${m[3]}` : m[0]);
        } else walk(c, inBold);
      }
    }
  };
  walk(root, false);
  return out.replace(/\u00a0/g, ' ').replace(/\*\*/g, '').replace(/\n$/, '');
}
function startEdit(f, ev) {
  commitEdit();
  const id = f.closest('.asset').dataset.id;
  const raw = X.getPath(X.assetData(id), f.dataset.f);
  if (typeof raw === 'string' || f.dataset.ph != null) f.innerHTML = toEditHtml(raw);
  f.removeAttribute('data-ph');
  f.dataset.orig = fromEditHtml(f); f._origHtml = f.innerHTML;
  f.contentEditable = 'true';
  editing = f; f.focus();
  // opened by a click: the caret goes where it was; opened otherwise: everything is selected
  let r = null;
  if (ev && ev.clientX != null) { r = document.caretRangeFromPoint ? document.caretRangeFromPoint(ev.clientX, ev.clientY) : null; if (r && !f.contains(r.startContainer)) r = null; }
  if (!r) { r = document.createRange(); r.selectNodeContents(f); if (ev && ev.clientX != null) r.collapse(false); } else r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  renderToolbar();
}
function commitEdit() {
  const f = editing; if (!f) return; editing = null;
  f.removeAttribute('contenteditable');
  const v = fromEditHtml(f), id = f.closest('.asset')?.dataset.id;
  if (id && v !== f.dataset.orig) { writeText(id, f.dataset.f, v); X.changed({ form: true }); }
  else { if (!v) X.scheduleRender(); else if (f._origHtml != null) f.innerHTML = f._origHtml; renderToolbar(); }
}
// Text typed on the canvas changes the content for every size. Once a size has its own version of a
// text ("Only this size"), typing there changes that version only.
function writeText(id, path, v) {
  const o = X.S.overrides[id];
  if (o && o[path] != null) o[path] = v; else X.setContent(id.split('.')[0], path, v);
}
function onlyHere(id, path) { (X.S.overrides[id] ||= {})[path] = X.getPath(X.assetData(id), path) ?? ''; X.changed(); }
/* pages of a paged design (a carousel's slides): add, move, remove, change layout, from the canvas */
function pageOps(a) {
  const t = containerOf(a), p = X.S.posts.find(x => x.id === a.post.id), list = p.fields[t.pages], l = t.lists.find(x => x.key === t.pages);
  const ids = () => list.map(x => x.id), used = () => new Set(ids().filter(Boolean));
  const remap = before => X.afterListChange(t.pages, before, list, p); // frame settings stay with the slide; index paths inside them follow it
  const go = (i, before) => { if (before) remap(before); computeLayout(); sel = i == null ? { type: 'post', key: p.id } : { type: 'frame', id: (X.assetList().flatMap(g => g.assets).filter(x => x.post.id === p.id && pageIdx(x) === i).sort((x, y) => (y.fk === a.fk) - (x.fk === a.fk))[0] || {}).id || `${p.id}.s-${list[i].id}.${a.fk}` }; X.changed({ form: true }); };
  return {
    list, l, max: l.max,
    add(at = list.length) { const before = ids(), it = Object.fromEntries(l.item.map(f => [f.key, ''])); it.id = Studio.boards.newId(used()); if (t.layouts.length) it.layout = l.newLayout || t.layouts[0].id; list.splice(at, 0, it); go(at, before); },
    move(i, d) { const j = i + d; if (j < 0 || j >= list.length) return; const before = ids(); [list[i], list[j]] = [list[j], list[i]]; go(j, before); },
    dup(i) {
      const before = ids(), src = list[i].id, c = JSON.parse(JSON.stringify(list[i])); c.id = Studio.boards.newId(used()); list.splice(i + 1, 0, c);
      remap(before); // the copy starts with the same per-frame settings as the original (its own copy, paths pointing at itself)
      for (const k of Object.keys(X.S.overrides)) if (k.startsWith(`${p.id}.s-${src}.`) || k.startsWith(`${p.id}.s-${src}~`)) {
        const o = JSON.parse(JSON.stringify(X.S.overrides[k])), re = new RegExp(`^(pos:)?${t.pages}\\.${list.findIndex(x => x.id === src)}\\.`), at = `${t.pages}.${i + 1}.`;
        for (const key of Object.keys(o)) if (re.test(key)) { o[key.replace(re, (_, pos) => (pos || '') + at)] = o[key]; delete o[key]; }
        if (Array.isArray(o.__hide)) o.__hide = o.__hide.map(h => re.test(h) ? h.replace(re, at) : h);
        X.S.overrides[k.replace(`.s-${src}`, `.s-${c.id}`)] = o;
      }
      go(i + 1);
    },
    remove(i) { if (list.length <= 1) return X.toast('A design needs at least one page'); const before = ids(); list.splice(i, 1); go(Math.min(i, list.length - 1), before); X.toast('Page removed. ⌘Z brings it back'); },
    layout(i, v) { list[i].layout = v; X.changed({ form: true }); },
  };
}

/* ═════════════ stickers ═════════════ */
async function addSticker(id, file) {
  const { src, ar } = await X.readPng(file), list = ((X.S.overrides[id] ||= {}).__stickers ||= []);
  const w = 28, h = w / ar * (layout.get(id).w / layout.get(id).h);
  list.push({ src, ar, w, x: +(50 - w / 2).toFixed(2), y: +(50 - h / 2).toFixed(2) });
  X.changed(); select({ type: 'sticker', id, idx: list.length - 1 }); X.toast('Sticker added: drag to place, corner to resize, ⌫ to delete');
}
function removeSticker(id, idx) { const l = ov(id).__stickers; if (!l) return; l.splice(idx, 1); if (!l.length) delete X.S.overrides[id].__stickers; select({ type: 'frame', id }); X.changed(); }
function stickerToPost(id, idx) { // copy a sticker to every frame of the same post
  const s0 = ov(id).__stickers[idx], pid = id.split('.')[0];
  for (const a of assets()) if (a.post.id === pid && a.id !== id) ((X.S.overrides[a.id] ||= {}).__stickers ||= []).push({ ...s0 });
  X.changed(); X.toast('Sticker copied to every frame of this post');
}
document.addEventListener('paste', e => {
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/')); if (!item) return;
  e.preventDefault();
  if (!sel?.id) { X.toast('Select a frame first, then paste the image as a sticker'); return; }
  addSticker(sel.id, item.getAsFile());
});
function pickSticker(id) { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => i.files[0] && addSticker(id, i.files[0]); i.click(); }

/* ═════════════ keyboard ═════════════ */
const isTyping = e => e.target.closest?.('input, textarea, select, [contenteditable]');
function bindKeys() {
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !isTyping(e)) { e.preventDefault(); travel(e.shiftKey ? 1 : -1); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAt(view.z * 1.25); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomAt(view.z / 1.25); return; }
    if (isTyping(e)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel?.type === 'sticker') { e.preventDefault(); removeSticker(sel.id, sel.idx); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel?.type === 'post') { e.preventDefault(); deletePost(sel.key); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel?.type === 'frame') { e.preventDefault(); removeSize(sel.id); return; }
    if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else select(sel?.type === 'text' || sel?.type === 'photo' ? { type: 'frame', id: sel.id } : null); }
    if (e.shiftKey && e.code === 'Digit1') fitAll();
    if (e.shiftKey && e.code === 'Digit2' && sel?.id) zoomToFrame(sel.id);
    if (e.key === 'Enter' && sel?.type === 'text') { const f = $(`#world .fr[data-id="${CSS.escape(sel.id)}"] [data-f="${CSS.escape(sel.path)}"]`); if (f) { e.preventDefault(); startEdit(f); } }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && sel?.id) {
      const ids = [...layout.keys()], i = ids.indexOf(sel.id), j = i + (e.key === 'ArrowRight' ? 1 : -1);
      if (ids[j]) { e.preventDefault(); select({ type: 'frame', id: ids[j] }); ensureVisible(ids[j]); }
    }
  });
}
function ensureVisible(id) {
  const L = layout.get(id), r = $('#stage').getBoundingClientRect(); if (!L) return;
  const sx = view.x + L.x * view.z, sy = view.y + L.y * view.z, sw = L.w * view.z, sh = L.h * view.z;
  if (sx < 0 || sy < 0 || sx + sw > r.width || sy + sh > r.height) { view.x += r.width / 2 - (sx + sw / 2); view.y += r.height / 2 - (sy + sh / 2); applyView(); }
}

/* ═════════════ floating toolbar (controls on the canvas) ═════════════ */
function positionToolbar() {
  const t = $('#ftb'); if (!t || t.hidden || !sel?.id) return;
  const L = layout.get(sel.id); if (!L) return;
  let x = view.x + L.x * view.z, y = view.y + L.y * view.z - 12;
  if (sel.type === 'text' || sel.type === 'photo' || sel.type === 'sticker') {
    const el = $(`#world .fr[data-id="${CSS.escape(sel.id)}"] ${sel.type === 'text' ? `[data-f="${CSS.escape(sel.path)}"]` : sel.type === 'sticker' ? `.sticker[data-st="${sel.idx}"]` : `[data-p="${CSS.escape(sel.path)}"]`}`);
    if (el) { const sr = $('#stage').getBoundingClientRect(), er = el.getBoundingClientRect(); x = er.left - sr.left; y = er.top - sr.top - 12; }
  }
  t.style.left = Math.max(8, x) + 'px'; t.style.top = Math.max(8, y) + 'px';
}
function renderToolbar() {
  const t = $('#ftb'); if (!t) return;
  if (!sel?.id || !layout.has(sel.id)) { t.hidden = true; return; }
  const a = layout.get(sel.id).a, o = ov(sel.id), node = $(`#world .fr[data-id="${CSS.escape(sel.id)}"] .asset`);
  let html = '';
  if (sel.type === 'frame') {
    const cur = node?.dataset.bd, themes = Object.entries(B().themes), curTheme = o.__theme || a.item.theme || S().theme;
    // boards choose their look in the inspector; the toolbar keeps what applies
    html = `${a.tpl.backdrop && !a.tpl.markup ? `<div class="ftb-seg" title="Background"><select data-t="bg">${bgOptions(a, o, cur)}</select></div>` : ''}
      ${themes.length > 1 ? `<div class="ftb-seg sw" title="Theme">${themes.map(([k, th]) => `<button data-t="theme" data-v="${k}" class="swatch ${k === curTheme ? 'on' : ''}" style="--sw:${th.bg};--sw2:${th.accent}" title="${esc(th.label || k)}"></button>`).join('')}</div>` : ''}
      ${window.StudioAnimate ? `<button class="ftb-btn ${o.__motion ? 'on' : ''}" data-t="motion" title="Animate this image (exports MP4)">◷ Motion</button>` : ''}
      ${isPage(a) ? `<button class="ftb-btn" data-t="pgL" title="Move earlier">←</button><button class="ftb-btn" data-t="pgR" title="Move later">→</button><button class="ftb-btn ftb-ic" data-t="pgDup" title="Duplicate this page" aria-label="Duplicate this page">${IC.dup}</button><button class="ftb-btn ftb-ic" data-t="pgDel" title="Remove this page (⌫)" aria-label="Remove this page">${IC.del}</button><button class="ftb-btn" data-t="export" title="Export this image">Export</button>`
        : `<button class="ftb-btn" data-t="export" title="Export this image">Export</button>${a.tpl.formats ? '' : `<button class="ftb-btn ftb-ic" data-t="rmsize" title="Remove this size (⌫)" aria-label="Remove this size">${IC.del}</button>`}`}`;
  } else if (sel.type === 'text') {
    const isOv = o[sel.path] != null;
    const kind = X.kinds[sel.path.split('.')[0]];
    html = editing ? `<button class="ftb-btn" data-t="strong" title="Highlight (⌘B)"><b>B</b> Highlight</button><button class="ftb-btn" data-t="done">Done ↵</button>${kind && !isOv ? `<span class="ftb-hint">shared: ${esc(kind.label)}</span>` : ''}`
      : `<button class="ftb-btn" data-t="edit" title="Edit in place (Enter / double-click)">Edit</button><button class="ftb-btn" data-t="hide" title="Hide this text on this size only">Hide here</button>${isOv ? `<span class="ftb-hint">only this size</span><button class="ftb-btn" data-t="resetText" title="Back to the text all sizes share">Reset</button><button class="ftb-btn" data-t="promote" title="Use this text on every size">Use ${kind ? 'everywhere' : 'on all sizes'}</button>` : multi(a) || kind ? '<button class="ftb-btn" data-t="onlyHere" title="Give this size its own version of this text">Only this size</button>' : ''}${kind && !isOv ? `<span class="ftb-hint">shared: ${esc(kind.label)}</span>` : ''}`;
  } else if (sel.type === 'sticker') {
    html = `<button class="ftb-btn" data-t="stAll" title="Place the same sticker on every frame of this post">Copy to post</button><button class="ftb-btn ftb-ic" data-t="stDel" title="Delete (⌫)" aria-label="Delete">${IC.del}</button>`;
  } else if (sel.type === 'photo') {
    const hasPos = o['pos:' + sel.path] != null;
    html = `<button class="ftb-btn" data-t="replace">Replace…</button>${hasPos ? '<button class="ftb-btn" data-t="resetPos">Reset crop</button>' : ''}<span class="ftb-hint">drag to reframe</span>`;
  }
  t.innerHTML = html; t.hidden = !html; positionToolbar();
  t.onclick = e => {
    const b = e.target.closest('[data-t]'); if (!b) return; const k = b.dataset.t, id = sel.id;
    if (k === 'theme') setTheme(id, b.dataset.v);
    if (k === 'motion') toggleMotion(id);
    if (k === 'export') openExport({ scope: 'frame' });
    if (k === 'rmsize') removeSize(id);
    if (k === 'onlyHere') { onlyHere(id, sel.path); X.toast('This size now has its own text. Type to change it'); }
    if (k.startsWith('pg')) { const pg = pageOps(a), i = pageIdx(a); k === 'pgL' ? pg.move(i, -1) : k === 'pgR' ? pg.move(i, 1) : k === 'pgDup' ? pg.dup(i) : pg.remove(i); }
    if (k === 'edit') { const f = $(`#world .fr[data-id="${CSS.escape(id)}"] [data-f="${CSS.escape(sel.path)}"]`); f && startEdit(f); }
    if (k === 'strong') { editing?.focus(); X.toggleStrong(); }
    if (k === 'done') commitEdit();
    if (k === 'resetText') { delete X.S.overrides[id][sel.path]; X.changed(); }
    if (k === 'promote') promote(id, sel.path);
    if (k === 'replace') { X.pickPath = id.split('.')[0] + '|' + sel.path; $('#filePick').click(); }
    if (k === 'resetPos') { delete X.S.overrides[id]['pos:' + sel.path]; X.changed(); }
    if (k === 'stAll') stickerToPost(id, sel.idx);
    if (k === 'stDel') removeSticker(id, sel.idx);
    if (k === 'hide') { const l = ((X.S.overrides[id] ||= {}).__hide ||= []); if (!l.includes(sel.path)) l.push(sel.path); select({ type: 'frame', id }); X.changed(); X.toast('Hidden on this frame. Restore it in the frame panel.'); }
  };
  t.onmousedown = e => { if (editing && e.target.closest('[data-t="strong"]')) e.preventDefault(); }; // keep the text selection
  const bgs = $('[data-t="bg"]', t); if (bgs) bgs.onchange = () => setBg(sel.id, bgs.value);
  const lys = $('[data-t="layout"]', t); if (lys) lys.onchange = () => pageOps(a).layout(a.item.index, lys.value);
}
// which backgrounds can hold THIS frame's content? test-fit each one off-screen (cached per frame + content)
const fitCache = new Map();
function bgFits(a) {
  const key = a.id + '|' + JSON.stringify(X.assetData(a.id)).length + '|' + JSON.stringify(X.S.posts.find(p => p.id === a.post.id)).length + '|' + X.S.theme;
  if (fitCache.has(key)) return fitCache.get(key);
  const o = (X.S.overrides[a.id] ||= {}), keep = o.__bg, host = document.createElement('div'), res = {};
  host.style.cssText = 'position:fixed;left:-99999px;top:0;';
  document.body.appendChild(host);
  try {
    for (const k of Object.keys(B().backdrops)) {
      o.__bg = k; host.innerHTML = X.renderAsset(a);
      const node = host.firstElementChild; res[k] = X.fit(node) && !X.hitsShapes(node);
    }
  } finally { if (keep) o.__bg = keep; else delete o.__bg; host.remove(); }
  fitCache.set(key, res); return res;
}
let fitPending = null;
function bgOptions(a, o, cur) {
  // use cached results; otherwise test-fit after this paint and refresh the pickers (keeps selection snappy)
  const key = a.id + '|' + JSON.stringify(X.assetData(a.id)).length + '|' + JSON.stringify(X.S.posts.find(p => p.id === a.post.id)).length + '|' + X.S.theme;
  let fits = fitCache.get(key) || null;
  if (!fits && fitPending !== a.id) {
    fitPending = a.id;
    setTimeout(() => { try { bgFits(a); } catch (e) { console.warn(e); } fitPending = null; if (sel?.id === a.id) { renderToolbar(); if (!document.activeElement?.closest('#right')) renderInspector(); } }, 60);
  }
  const tag = k => fits && fits[k] === false ? ' (too tight)' : '';
  return `<option value="">Auto${!o.__bg && cur ? `: ${esc(B().backdrops[cur]?.label || cur)}` : ''}</option>` +
    Object.entries(B().backdrops).map(([k, b]) => `<option value="${k}" ${o.__bg === k ? 'selected' : ''}>${esc(b.label)}${tag(k)}</option>`).join('');
}
function setBg(id, v) { const o = (X.S.overrides[id] ||= {}); if (v) o.__bg = v; else delete o.__bg; X.changed(); }
function setTheme(id, v) { const a = assetById(id), o = (X.S.overrides[id] ||= {}); if (v === (a.item.theme || X.S.theme)) delete o.__theme; else o.__theme = v; X.changed(); }
function toggleMotion(id) { const o = (X.S.overrides[id] ||= {}); if (o.__motion) delete o.__motion; else o.__motion = true; X.changed(); }
function promote(id, path) { const pid = id.split('.')[0], v = X.S.overrides[id][path]; X.setContent(pid, path, v); for (const k in X.S.overrides) if (k.startsWith(pid + '.')) delete X.S.overrides[k][path]; X.changed({ form: true }); }

/* ═════════════ left: posts, then shared content (only when a template reads any) ═════════════ */
const fmtChip = k => `<span class="sz sz-${X.FORMATS[k]?.kind}" title="${esc(X.FORMATS[k]?.label + ', ' + X.FORMATS[k]?.hint)}">${esc(X.FORMATS[k]?.short || k)}</span>`;
function sharedSections() {
  const s = S(), k = X.sharedKinds(), list = [];
  const d = s.date ? s.date.split('-') : null;
  if (k.details) list.push({ key: 'event', label: s.title ? s.title.replace(/\*/g, '') : (B().sharedLabel || 'Details'), icon: '▤', meta: d ? `${+d[2]}. ${+d[1]}.` : '' });
  if (k.speakers) list.push({ key: 'speakers', label: 'Speakers', icon: '☺', meta: s.speakers.filter(x => x.name).length });
  if (k.agenda) list.push({ key: 'agenda', label: 'Agenda', icon: '≡', meta: s.agenda.filter(x => x.label).length });
  if (k.photos) list.push({ key: 'photos', label: 'Photos', icon: '▣', meta: s.photos.length });
  for (const key of k.declared) { // one row per item (each event), then a button for another
    for (const v of s.shared[key]) { const dt = X.itemDate(key, v).split('-'); list.push({ key: `kind:${key}:${v.id}`, label: X.itemLabel(key, v), icon: '◆', meta: dt[2] ? `${+dt[2]}. ${+dt[1]}.` : X.usersOf(key, v).length || '' }); }
    list.push({ add: key, label: X.kinds[key].label });
  }
  return list;
}
function renderLayers() {
  const L = $('#left'); if (!L) return;
  const groups = X.assetList(), shared = sharedSections();
  // two lists, each with its own scroll: designs on top, shared content pinned under it with its "+ New" buttons always in reach
  const at = { list: $('.lp-list', L)?.scrollTop || 0, items: $('.lp-items', L)?.scrollTop || 0 };
  L.innerHTML = `
    <div class="lp-top"><div class="lp-h">Designs <span class="lp-sub">${groups.length || ''}</span></div>
      <button class="btn primary lp-new" id="addPost"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>New design</button></div>
    <div class="lp-sec lp-list">
      ${groups.map(g => {
        const p = g.post, open = !collapsed.has(p.id), on = sel?.type === 'post' && sel.key === p.id;
        return `<div class="post ${on ? 'on' : ''}" data-post="${p.id}">
          <div class="post-h"><b class="tw" data-tw="${p.id}">${open ? '▾' : '▸'}</b><span>${esc(g.label)}</span><em>${g.assets.length}</em><button class="ly-x post-x" data-delpost="${p.id}" title="Delete design (⌫)">×</button></div>
          <div class="post-sz">${p.formats.map(fmtChip).join('')}${X.kindsOf(p).filter(k => X.kinds[k] && X.S.shared[k].length > 1).map(k => `<span class="post-it" title="${esc(X.kinds[k].label)}">${esc(X.itemLabel(k, X.sharedItem(p, k)))}</span>`).join('')}</div></div>
        ${open ? sizeRows(g).flat().map(a => { const o = ov(a.id), here = sel?.id === a.id; return `<div class="ly ly-frame ${here && sel.type === 'frame' ? 'on' : ''} ${here ? 'open' : ''}" data-frame="${a.id}"><i class="fk fk-${a.fmt.kind}"></i><span>${esc(a.fmt.short || a.fmt.label)}${a.item.label ? ` <small>${esc(a.item.label)}</small>` : ''}</span>${o.__motion ? '<em title="Motion">◷</em>' : ''}</div>${here ? layerRows(a) : ''}`; }).join('') : ''}`;
      }).join('') || '<p class="ip-note lp-none">No designs yet.</p>'}
    </div>
    ${shared.length ? `<div class="lp-shared"><div class="lp-h">Shared content</div>
      <div class="lp-items">${shared.filter(c => !c.add).map(c => `<div class="ly ly-content ${sel?.type === 'content' && sel.key === c.key ? 'on' : ''}" data-content="${c.key}"><i>${c.icon}</i><span>${esc(c.label)}</span><em>${esc(String(c.meta ?? ''))}</em></div>`).join('')}</div>
      ${shared.filter(c => c.add).map(c => `<button class="btn ghost lp-newitem" data-newitem="${c.add}">+ New ${esc(c.label.toLowerCase())}</button>`).join('')}
    </div>` : ''}`;
  if ($('.lp-list', L)) $('.lp-list', L).scrollTop = at.list; if ($('.lp-items', L)) $('.lp-items', L).scrollTop = at.items;
  L.onclick = e => {
    const tw = e.target.closest('[data-tw]'); if (tw) { const k = tw.dataset.tw; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); localStorage.setItem('studio:collapsed', JSON.stringify([...collapsed])); renderLayers(); return; }
    if (e.target.closest('#addPost')) { openLibrary(); return; }
    const ni = e.target.closest('[data-newitem]'); if (ni) { const k = ni.dataset.newitem, v = X.newItem(k); X.changed({ form: true }); select({ type: 'content', key: `kind:${k}:${v.id}` }); return; }
    const dp = e.target.closest('[data-delpost]'); if (dp) { deletePost(dp.dataset.delpost); return; }
    const c = e.target.closest('[data-content]'); if (c) { select({ type: 'content', key: c.dataset.content }); return; }
    const p = e.target.closest('[data-post]'); if (p) { select({ type: 'post', key: p.dataset.post }); zoomToGroup(p.dataset.post); return; }
    const ly = e.target.closest('[data-layer]'); if (ly) { const [type, id, path] = ly.dataset.layer.split('|'); select({ type, id, path }); return; }
    const f = e.target.closest('[data-frame]'); if (f) { const id = f.dataset.frame; select({ type: 'frame', id }); e.detail >= 2 ? zoomToFrame(id) : ensureVisible(id); }
  };
}
// the layers of the selected image: its texts and images, top to bottom, as they sit on the canvas
function layerRows(a) {
  const fr = $(`#world .fr[data-id="${CSS.escape(a.id)}"]`); if (!fr) return '';
  const named = Object.fromEntries((a.tpl.manifest?.fields || []).flatMap(f => [[f.key, f.label || f.key], ...(f.item || []).map(x => [x.key, x.label || x.key])]));
  const seen = new Set(), rows = [];
  $$('[data-f], [data-p]', fr).forEach(el => {
    const text = el.dataset.f != null, path = text ? el.dataset.f : el.dataset.p, key = (text ? 't' : 'p') + path;
    if (seen.has(key) || el.dataset.dropped != null) return; seen.add(key);
    const leaf = path.split('.').at(-1), on = sel.path === path && sel.type === (text ? 'text' : 'photo');
    const preview = text ? el.textContent.trim().slice(0, 40) : (X.getContent(a.post.id, path) ? 'image' : 'empty');
    rows.push(`<div class="ly ly-layer ${on ? 'on' : ''}" data-layer="${text ? 'text' : 'photo'}|${a.id}|${esc(path)}"><i>${text ? 'T' : '▣'}</i><span>${esc(named[leaf] || TEXT_LABEL[leaf] || leaf)} <small>${esc(preview)}</small></span></div>`);
  });
  return rows.join('');
}

/* ═════════════ right: inspector ═════════════ */
const field = (key, label, type = 'text', extra = '', val = X.S[key], attr = 'data-k') => {
  const v = esc(val ?? '');
  return `<label class="fld"><span>${esc(label)}</span>${type === 'textarea' ? `<textarea ${attr}="${key}" rows="2" ${extra}>${v}</textarea>` : `<input ${attr}="${key}" type="${type}" value="${v}" ${extra}>`}</label>`;
};
function renderInspector() {
  const R = $('#right'); if (!R) return;
  let html = '';
  if (!sel) html = docInspector();
  else if (sel.type === 'content') html = contentInspector(sel.key);
  else if (sel.type === 'post' && S().posts.some(p => p.id === sel.key)) html = inspector(sel.key, null);
  else if (sel.id && layout.has(sel.id)) html = inspector(sel.id.split('.')[0], sel.id);
  else { sel = null; html = docInspector(); }
  R.innerHTML = html;
  bindInspector(R);
}
function docInspector() {
  const s = S(), themes = Object.entries(B().themes), opts = B().options || [];
  return `<div class="ip-h">Project</div>
    <div class="ip-sec">${field('name', 'Name', 'text', 'placeholder="Untitled project"')}
      <p class="ip-note">Brand: ${esc(B().name)}. ${s.posts.length} design${s.posts.length === 1 ? '' : 's'}, ${assets().length} image${assets().length === 1 ? '' : 's'}.</p></div>
    ${themes.length > 1 || opts.length ? `<div class="ip-sec"><div class="ip-t">Style</div>
      ${themes.length > 1 ? `<div class="seg">${themes.map(([k, t]) => `<button data-theme="${k}" aria-pressed="${k === s.theme}">${esc(t.label || k)}</button>`).join('')}</div>` : ''}
      ${opts.map(o => `<label class="chk urow"><input type="checkbox" data-flag="${o.key}" ${s[o.key] ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}</div>` : ''}
    <div class="ip-sec"><div class="ip-t">How it works</div>
      <p class="ip-note">A <b>design</b> is one template with its own content, shown at the sizes you pick: a post, a carousel, a header. Its settings are here on the right; its content is edited on the canvas.</p>
      <p class="ip-note">Click an image once to select it, again to select a text or photo. Double-click a text to type.</p>
      <p class="ip-note"><kbd>⇧1</kbd> fit all, <kbd>⇧2</kbd> zoom to selection, <kbd>Space</kbd>-drag to pan, <kbd>⌫</kbd> delete, <kbd>⌘Z</kbd> undo.</p></div>`;
}
// a declared kind of shared content: its fields and lists, edited here because it has no place on the canvas of its own
function kindInspector(key, id) {
  const k = X.kinds[key], all = S().shared[key], v = all.find(x => x.id === id) || X.sharedItem(null, key); X.setFocus(key, v.id); // edits and new designs go to the item on show
  const users = X.usersOf(key, v).map(p => p.name || X.templates[p.template].label), low = k.label.toLowerCase();
  const input = f => { const val = esc(v[f.key] ?? ''), at = `data-sh="${key}.${f.key}"`;
    return `<label class="fld"><span>${esc(f.label || f.key)}</span>${f.type === 'long' ? `<textarea rows="3" ${at}>${val}</textarea>` : `<input type="${f.type === 'date' || f.type === 'time' ? f.type : 'text'}" value="${val}" ${at}>`}</label>`; };
  const list = l => { const items = v[l.key] || [], img = (l.item || []).find(f => f.type === 'image'), one = l.itemLabel || 'Item';
    return `<div class="ip-sec"><div class="ip-t">${esc(l.label || l.key)} <small>${items.length}</small></div>${items.map((x, i) => `
      <div class="item ${img ? '' : 'noimg'}">${img ? `<div class="ph" data-pick="|${key}.${l.key}.${i}.${img.key}" style="${x[img.key] ? `background-image:url('${x[img.key]}')` : ''}">${x[img.key] ? '' : '+'}</div>` : ''}
        <div class="f">${(l.item || []).filter(f => f.type !== 'image').map(f => `<input placeholder="${esc(f.label || f.key)}" value="${esc(x[f.key] ?? '')}" data-sh="${key}.${l.key}.${i}.${f.key}">`).join('')}</div>
        <div class="mv"><button data-shmv="${key}.${l.key}.${i}.-1" title="Move up">↑</button><button data-shmv="${key}.${l.key}.${i}.1" title="Move down">↓</button><button data-shrm="${key}.${l.key}.${i}" title="Remove">×</button></div></div>`).join('')}
      <button class="btn ghost" data-shadd="${key}.${l.key}">+ Add ${esc(one.toLowerCase())}</button></div>`; };
  return `<div class="ip-h ip-head"><span class="ip-name">${esc(k.label)}${all.length > 1 ? ` ${all.indexOf(v) + 1} of ${all.length}` : ''}</span>
      <button class="ib" data-itdup="${key}:${v.id}" title="Duplicate this ${esc(low)}${users.length ? ' and its designs' : ''}">${IC.dup}</button>${all.length > 1 ? `<button class="ib danger" data-itdel="${key}:${v.id}" title="Delete this ${esc(low)}${users.length ? ' and its designs' : ''}">${IC.del}</button>` : ''}</div>
    <p class="ip-note" style="padding:0 16px">Shared content. ${users.length ? `Used by ${users.map(esc).join(', ')}. A change here, or on the canvas, changes all of them.` : `No design uses it yet. A new design will use this ${esc(low)}.`}</p>
    <div class="ip-sec">${k.fields.filter(f => f.type !== 'list' && f.type !== 'image').map(input).join('')}</div>
    ${k.fields.filter(f => f.type === 'list').map(list).join('')}`;
}
function contentInspector(key) {
  if (key.startsWith('kind:')) { const [, k, id] = key.split(':'); return X.kinds[k] ? kindInspector(k, id) : ''; }
  const s = S();
  const used = k => S().posts.filter(p => (X.templates[p.template].needs || []).includes(k) || k === 'event').map(p => p.name || X.templates[p.template].label);
  const usedLine = k => { const u = used(k); return u.length ? `<p class="ip-note">Used by ${u.map(esc).join(', ')}.</p>` : '<p class="ip-note">No post uses this yet.</p>'; };
  if (key === 'event') return `<div class="ip-h">Event</div>${usedLine('event')}<div class="ip-sec">
      <label class="fld"><span>Series</span><input data-k="series" list="seriesList" value="${esc(s.series)}"><datalist id="seriesList">${(B().series || []).map(x => `<option>${esc(x)}</option>`).join('')}</datalist></label>
      ${field('title', 'Title', 'textarea')}${field('description', 'Description', 'textarea', 'rows="3"')}
      <div class="row2">${field('date', 'Date', 'date')}${field('time', 'Time', 'time')}</div>
      <div class="row2">${field('venue', 'Venue')}${field('city', 'City')}</div>
      ${field('cta', 'Call to action')}</div>
      <p class="ip-note">Write <code>*word*</code> or press <kbd>⌘B</kbd> to make a word green.</p>`;
  if (key === 'speakers') return `<div class="ip-h">Speakers</div>${usedLine('speakers')}<div class="ip-sec">${s.speakers.map((x, i) => `
      <div class="item"><div class="ph" data-pick="speakers.${i}.photo" style="${x.photo ? `background-image:url('${x.photo}')` : ''}">${x.photo ? '' : '+'}</div>
      <div class="f"><input placeholder="Name" value="${esc(x.name)}" data-sp="${i}.name"><input placeholder="Role" value="${esc(x.role)}" data-sp="${i}.role"><input placeholder="Company" value="${esc(x.company)}" data-sp="${i}.company"></div>
      <div class="mv"><button data-mv="speakers.${i}.-1" title="Move up">↑</button><button data-mv="speakers.${i}.1" title="Move down">↓</button><button data-rm="speakers.${i}" title="Remove">×</button></div></div>`).join('')}
      <button class="btn ghost" data-add="speakers">+ Add speaker</button></div>`;
  if (key === 'agenda') return `<div class="ip-h">Agenda</div>${usedLine('agenda')}<div class="ip-sec">${s.agenda.map((x, i) => `
      <div class="item noimg"><div class="f two"><input placeholder="18:30" value="${esc(x.time)}" data-ag="${i}.time"><input placeholder="What happens" value="${esc(x.label)}" data-ag="${i}.label"></div>
      <div class="mv"><button data-mv="agenda.${i}.-1">↑</button><button data-mv="agenda.${i}.1">↓</button><button data-rm="agenda.${i}">×</button></div></div>`).join('')}
      <button class="btn ghost" data-add="agenda">+ Add item</button></div>`;
  if (key === 'photos') return `<div class="ip-h">Photos</div>${usedLine('photos')}<div class="ip-sec"><div class="thumbs">${s.photos.map((p, i) => `<div style="background-image:url('${p}')"><button data-rm="photos.${i}">×</button></div>`).join('')}</div>
      <button class="btn ghost" data-addphotos>+ Add photos</button><input type="file" id="phPick" accept="image/*" multiple hidden></div>`;
  return '';
}
function slidesEditor(p) {
  const TYPES = [['photo', 'Full photo'], ['photo-text', 'Photo + text'], ['text', 'Text + stats'], ['list', 'List']];
  const sl = p.fields.slides || [];
  return `<div class="ip-sec"><div class="ip-t">Slides <small>${sl.length === 1 ? 'one slide = single post' : sl.length + ' slides = carousel'}</small></div>${sl.map((x, i) => `
    <div class="item ${x.type.startsWith('photo') ? '' : 'noimg'}">${x.type.startsWith('photo') ? `<div class="ph" data-pick="${p.id}|slides.${i}.photo" style="${x.photo ? `background-image:url('${x.photo}')` : ''}">${x.photo ? '' : '+'}</div>` : ''}
      <div class="f"><select data-sl="${i}.type">${TYPES.map(([v, l]) => `<option value="${v}" ${v === x.type ? 'selected' : ''}>${i + 1}. ${l}</option>`).join('')}</select>
        <input placeholder="Title" value="${esc(x.title)}" data-sl="${i}.title">
        ${x.type === 'list' ? `<textarea rows="4" placeholder="One item per line" data-sl="${i}.items">${esc((x.items || []).join('\n'))}</textarea>` : `<textarea rows="3" placeholder="Text" data-sl="${i}.body">${esc(x.body)}</textarea>`}
        ${x.type === 'text' ? `<input placeholder="Stats, comma separated" value="${esc((x.stats || []).join(', '))}" data-sl="${i}.stats">` : ''}</div>
      <div class="mv"><button data-slmv="${i}.-1">↑</button><button data-slmv="${i}.1">↓</button><button data-slrm="${i}">×</button></div></div>`).join('')}
    <button class="btn ghost" data-sladd>+ Add slide</button></div>`;
}
const TEXT_LABEL = { title: 'Title', description: 'Description', cta: 'Call to action' };
// every photo slot a post (or one frame) shows, read from the rendered frames + the cover photo
function photoSlots(pid, frameId) {
  const p = S().posts.find(x => x.id === pid), t = X.templates[p.template], paths = new Set();
  if (t.coverPhoto !== false) paths.add('coverPhoto');
  (t.slots || []).forEach(k => paths.add(k)); // a markup template names its image fields itself
  $$('#world .fr').filter(fr => frameId ? fr.dataset.id === frameId : fr.dataset.id.startsWith(pid + '.')).forEach(fr => $$('[data-p]', fr).forEach(el => paths.add(el.dataset.p)));
  if (frameId && !$$(`#world .fr[data-id="${CSS.escape(frameId)}"] [data-p="coverPhoto"]`).length) paths.delete('coverPhoto');
  const named = Object.fromEntries((t.manifest?.fields || []).map(f => [f.key, f.label || f.key]));
  for (const l of t.lists || []) for (const x of [...paths]) if (x.startsWith(l.key + '.')) paths.delete(x);
  const label = path => named[path] ? named[path] : path === 'coverPhoto' ? 'Cover photo' : /^speakers\.(\d+)/.test(path) ? (S().speakers[+path.split('.')[1]]?.name || 'Speaker') : /^slides\.(\d+)/.test(path) ? `Slide ${+path.split('.')[1] + 1}` : /^photos\.(\d+)/.test(path) ? `Event photo ${+path.split('.')[1] + 1}` : path;
  return [...paths].map(path => ({ path, label: label(path), url: X.getContent(pid, path) }));
}
function photosBlock(pid, frameId) {
  const slots = photoSlots(pid, frameId);
  const t = X.templates[S().posts.find(x => x.id === pid).template];
  if (!slots.length) return '';
  return `<div class="ip-sec"><div class="ip-t">Images</div><div class="slots">${slots.map(sl => `
    <div class="slot"><div class="pv xs" data-pick="${pid}|${sl.path}" style="${sl.url ? `background-image:url('${sl.url}')` : ''}" title="${sl.url ? 'Replace' : 'Add photo'}">${sl.url ? '' : '+'}</div>
      <span>${esc(sl.label)}${sl.path === 'coverPhoto' ? `<small>${sl.url ? 'photo layouts are used first' : 'adding one switches to photo layouts'}</small>` : ''}</span>
      ${sl.url ? `<button class="lnk danger" data-unpick="${pid}|${sl.path}">Remove</button>` : ''}</div>`).join('')}</div>
    <p class="ip-note">Click a tile to upload, or drop an image onto its place on the canvas.</p></div>`;
}
function postTexts(p, t) {
  const uses = t.uses || [];
  const facts = t.facts ? `<div class="facts"><span>${esc([S().date && S().date.split('-').reverse().map(Number).join('. '), S().time, [S().venue, S().city].filter(Boolean).join(', ')].filter(Boolean).join(', ') || 'No date or place yet')}</span><button class="lnk" data-goto="event">Edit event ›</button></div>` : '';
  if (!uses.length && !facts) return '';
  return `<div class="ip-sec"><div class="ip-t">Text</div>${uses.map(k => {
    const own = p.fields[k] != null, v = own ? p.fields[k] : S()[k];
    return `<label class="fld"><span>${esc(TEXT_LABEL[k] || k)} <em class="src ${own ? 'own' : ''}">${own ? 'this post only' : 'from Event'}</em>${own ? ` <button class="lnk" data-pureset="${k}">Use Event’s</button>` : ''}</span>
      ${k === 'cta' ? `<input data-pu="${k}" value="${esc(v)}">` : `<textarea data-pu="${k}" rows="${k === 'title' ? 2 : 3}">${esc(v)}</textarea>`}</label>`;
  }).join('')}${facts}</div>`;
}
// optional parts a template declares (description, speakers, CTA…): Auto / Show / Hide
function optionalSeg(opt, cur, attr) {
  const vals = [['auto', opt.auto ? `Auto` : 'Show'], ['1', 'Show'], ['0', 'Hide']].filter((v, i) => opt.auto || i !== 1);
  const v = cur == null ? 'auto' : cur ? '1' : '0';
  return `<div class="optrow"><span>${esc(opt.label)}${opt.auto && cur == null ? `<small>${esc(opt.auto)}</small>` : ''}</span>
    <div class="seg mini">${vals.map(([k, l]) => `<button data-${attr}="${opt.key}" data-v="${k}" aria-pressed="${k === v}">${l}</button>`).join('')}</div></div>`;
}
// does each offered choice of a part hold this frame's content? Test-fit off-screen with the choice forced (like renderNode),
// cached per frame + content (the pick itself is left out of the key). Only for parts marked "fit": true in the manifest.
const pickFits = new Map(), pickBusy = new Set();
const pickKey = (a, op) => { const sk = (k, v) => k === 'show' || k === '__show' ? undefined : v; return [a.id, op.key, JSON.stringify(X.assetData(a.id), sk).length, JSON.stringify(X.S.posts.find(p => p.id === a.post.id), sk).length, X.S.theme].join('|'); };
function testPicks(a, op, ids) {
  const had = X.S.overrides[a.id], o = had || (X.S.overrides[a.id] = {}), keep = o.__show, host = document.createElement('div'), res = {};
  host.style.cssText = 'position:fixed;left:-99999px;top:0;'; host.dataset.export = ''; document.body.appendChild(host);
  try {
    for (const id of ids) { o.__show = { ...keep, [op.key]: id }; host.innerHTML = X.renderAsset(a); res[id] = !X.fitBest(a, host.firstElementChild).hasAttribute('data-overflow'); }
  } finally { if (keep) o.__show = keep; else delete o.__show; if (!had && !Object.keys(o).length) delete X.S.overrides[a.id]; host.remove(); }
  return res;
}
// cached results for these frames, or null (and a test queued after paint, one frame per tick, then the inspector refreshes)
function pickFitsOf(list, op, offer) {
  const todo = list.filter(a => !pickFits.has(pickKey(a, op)));
  if (!todo.length) return new Map(list.map(a => [a.id, pickFits.get(pickKey(a, op))]));
  const job = todo.map(a => pickKey(a, op)).join(';');
  if (!pickBusy.has(job)) {
    pickBusy.add(job); const at = JSON.stringify(sel);
    const step = () => {
      const a = todo.shift();
      if (a) { try { pickFits.set(pickKey(a, op), testPicks(a, op, offer(a))); } catch (e) { console.warn(e); pickFits.set(pickKey(a, op), {}); } return setTimeout(step, 20); }
      pickBusy.delete(job);
      if (JSON.stringify(sel) === at && !document.activeElement?.closest('#right')) renderInspector();
    };
    setTimeout(step, 60);
  }
  return null;
}
// a part with choices: one pick. On a size the first entry is the design's pick, named ("All sizes: Auto"), on the design it is the default.
// `list`: the frames the pick applies to (this one, or the design's). A board may allow only some choices (data-choices-<key>);
// the design offers the union, the frame what its own board allows.
function choiceRow(opt, cur, attr, list, design, from = 'All sizes') { // `design`: the design-level pick, for the first entry of an image's select
  const own = attr === 'fchoice' || attr === 'schoice', ok = a => { const al = Studio.boards.allowed(a, opt.key); return c => !al || al.includes(c.id); };
  const offered = opt.choices.filter(c => !list.length || list.some(a => ok(a)(c)));
  let v = cur ?? (own ? '' : opt.default); if (v && !offered.some(c => c.id === v)) v = own ? '' : opt.default; // no longer offered: show the default
  let tag = () => '', off = () => false;
  if (opt.fit && list.length) { // paged designs with many images: only the first image of each size is tested
    const test = list.length > 8 ? [...new Map(list.map(a => [a.fk, a])).values()] : list, fits = pickFitsOf(test, opt, a => opt.choices.filter(ok(a)).map(c => c.id));
    if (fits) {
      const bad = c => test.filter(a => ok(a)(c) && fits.get(a.id)?.[c.id] === false), good = c => test.filter(a => ok(a)(c) && fits.get(a.id)?.[c.id] !== false);
      if (own) { tag = c => bad(c).length ? ' (too tight)' : ''; off = c => bad(c).length && c.id !== v; }
      else {
        tag = c => { const b = bad(c); return !b.length ? '' : good(c).length ? ` (not on ${[...new Set(b.map(a => a.fmt.short || a.fmt.label))].join(', ')})` : ' (too tight)'; };
        off = c => bad(c).length && !good(c).length && c.id !== v;
      }
    }
  }
  // what an image with no pick of its own uses: the design's pick, or the default when that pick is not allowed on this image
  const inherited = () => { const c = opt.choices.find(c => c.id === design && (!list.length || ok(list[0])(c))) || opt.choices.find(c => c.id === opt.default); return c ? c.label : ''; };
  const optn = c => `<option value="${esc(c.id)}" ${c.id === v ? 'selected' : ''} ${off(c) ? 'disabled' : ''}>${esc(c.label)}${tag(c)}</option>`;
  return `<div class="optrow"${own ? ' title="This image uses the choice made for all sizes, unless you pick one here."' : ''}><span>${esc(opt.label)}</span><select data-${attr}="${opt.key}">${own ? `<option value="">${attr === 'schoice' ? 'Design' : from}: ${esc(inherited())}</option>` : ''}${[...new Set(offered.map(c => c.group || ''))].map(g => { const o = offered.filter(c => (c.group || '') === g).map(optn).join(''); return g ? `<optgroup label="${esc(g)}">${o}</optgroup>` : o; }).join('')}</select></div>`;
}
const strip = s => String(s || '').replace(/\*([^*]+)\*/g, '$1');
function autoCaption(p) {
  const d = X.postData(p), t = X.templates[p.template], b = B(), L = [];
  if (t.caption) return t.caption(d, b);
  if (t.markup && t.pagesOwn) { // a design of pages: what each page says, and the title and description of the shared content its template reads
    const l = t.lists.find(x => x.key === t.pagesOwn), lines = [(d[t.pagesOwn] || []).some(x => !X.slideTemplate(t, x)) ? strip(d.kicker) : '']; // the design's kicker shows on its own pages only
    for (const x of d[t.pagesOwn] || []) {
      const st = X.slideTemplate(t, x) || t;
      for (const k of st.kinds || []) for (const f of ['title', 'description']) lines.push(strip((X.sharedFor(p)[k] || {})[f]));
      lines.push(...(st === t ? l.item.filter(f => f.type !== 'image') : (st.fields || [])).map(f => strip(x[f.key])));
    }
    return [...new Set(lines.filter(Boolean))].join('\n\n');
  }
  if (t.markup) return [...[...(t.uses || []), ...(t.fields || []).map(f => f.key)].map(k => strip(d[k])),
    ...(t.lists || []).flatMap(l => (d[l.key] || []).map(x => l.item.filter(f => f.type !== 'image').map(f => strip(x[f.key])).filter(Boolean).join('\n')))].filter(Boolean).join('\n\n');
  const days = b.strings.days || [];
  const when = d.date ? (() => { const x = new Date(d.date + 'T12:00'); return `${days[x.getDay()] || ''} ${x.getDate()}. ${x.getMonth() + 1}. ${x.getFullYear()}${d.time ? ` v ${d.time}` : ''}`.trim(); })() : '';
  const where = [d.venue, d.city].filter(Boolean).join(', ');
  const tag = s => '#' + strip(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '');
  if (p.template === 'announcement') { L.push(strip(d.annTitle), '', strip(d.annBody), '', strip(d.annCta)); }
  else if (p.template === 'recap') { L.push(strip(d.recapTitle), d.recapText ? '\n' + strip(d.recapText) : '', d.quote ? `\n„${strip(d.quote)}“${d.quoteBy ? ` (${d.quoteBy})` : ''}` : ''); }
  else if (p.template === 'slides') { (d.slides || []).forEach(sl => { if (sl.title) L.push(strip(sl.title)); if (sl.body) L.push(strip(sl.body)); (sl.items || []).forEach(i => L.push('→ ' + strip(i))); L.push(''); }); }
  else {
    if (p.template === 'save-the-date') L.push(strip(d.stdKicker) + ' ' + strip(d.title));
    else if (p.template === 'spotlight') { const sp = d.speakers.filter(s => s.name); L.push(sp.map(s => `${s.name}${s.role || s.company ? ` (${[s.role, s.company].filter(Boolean).join(', ')})` : ''}`).join(', ') + ` na ${d.series || b.name}: ${strip(d.title)}`); }
    else L.push(`${strip(d.title)}${d.series ? ` | ${d.series}` : ''}`);
    if (d.description && p.template !== 'save-the-date') L.push('', strip(d.description));
    const sp = d.speakers.filter(s => s.name);
    if (sp.length && p.template !== 'spotlight') L.push('', 'Mluví: ' + sp.map(s => s.name).join(', '));
    if (when || where) L.push('', [when, where].filter(Boolean).join(', '));
    if (d.cta) L.push(strip(d.cta));
  }
  L.push('', [d.series && tag(d.series), tag(b.name), '#UX', '#UXdesign'].filter(Boolean).join(' '));
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function captionOf(p) { return p.fields.caption != null ? p.fields.caption : autoCaption(p); }
function deletePost(pid) {
  const s = X.S, p = s.posts.find(x => x.id === pid); if (!p) return;
  s.posts.splice(s.posts.indexOf(p), 1);
  for (const k in s.overrides) if (k.startsWith(p.id + '.')) delete s.overrides[k];
  sel = null; X.changed({ form: true }); X.toast('Design deleted. ⌘Z brings it back');
}
function duplicatePost(pid) {
  const s = X.S, p = s.posts.find(x => x.id === pid), c = JSON.parse(JSON.stringify(p));
  c.id = 'p' + Math.random().toString(36).slice(2, 7); c.name = (p.name || X.templates[p.template].label) + ' copy';
  s.posts.splice(s.posts.indexOf(p) + 1, 0, c); X.changed({ form: true }); select({ type: 'post', key: c.id }); setTimeout(() => zoomToGroup(c.id), 300);
}
// the brand's grounds as swatches; the first one means "don't override"
function lookSwatches(cur, attr, autoLabel) {
  return `<div class="looks">${Object.entries(B().backdrops).map(([k, b]) => { const v = k === 'auto' && attr !== 'plook' ? '' : k;
    return `<button class="look ${v === cur ? 'on' : ''}" data-${attr}="${v}" title="${esc(k === 'auto' ? autoLabel : b.label)}" style="${b.swatch ? `background:${b.swatch}` : ''}">${k === 'auto' ? '<i>Auto</i>' : ''}</button>`; }).join('')}</div>`;
}
const multi = a => a.post.formats.length > 1; // more than one size: "only this size" means something
function removeSize(id) {
  const a = assetById(id); if (!a) return;
  if (isPage(a)) return pageOps(a).remove(pageIdx(a)); // ⌫ on a page removes the page
  if (a.tpl.formats) return;
  const p = X.S.posts.find(x => x.id === a.post.id);
  if (p.formats.length <= 1) return deletePost(p.id);
  p.formats = p.formats.filter(f => f !== a.fk);
  select({ type: 'post', key: p.id }); X.changed({ form: true }); X.toast(`${a.fmt.label} removed. ⌘Z brings it back`);
}
// a list field (a carousel's slides): each item has its own texts and, if the template says so, an image
function listEditor(p, t) {
  return (t.lists || []).map(l => {
    const items = p.fields[l.key] || [], img = l.item.find(f => f.type === 'image'), one = l.itemLabel;
    return `<div class="ip-sec"><div class="ip-t">${esc(l.label)} <small>${items.length}</small></div>${items.map((x, i) => `
      <div class="item ${img ? '' : 'noimg'}">${img ? `<div class="ph" data-pick="${p.id}|${l.key}.${i}.${img.key}" title="${esc(img.label || 'Image')}" style="${x[img.key] ? `background-image:url('${x[img.key]}')` : ''}">${x[img.key] ? '' : '+'}</div>` : ''}
        <div class="f"><b class="item-n">${esc(one)} ${i + 1}</b>${l.item.filter(f => f.type !== 'image').map(f => f.type === 'long'
          ? `<textarea rows="2" placeholder="${esc(f.label || f.key)}" data-li="${l.key}.${i}.${f.key}">${esc(x[f.key] ?? '')}</textarea>`
          : `<input placeholder="${esc(f.label || f.key)}" value="${esc(x[f.key] ?? '')}" data-li="${l.key}.${i}.${f.key}">`).join('')}</div>
        <div class="mv"><button data-limv="${l.key}.${i}.-1" title="Move up">↑</button><button data-limv="${l.key}.${i}.1" title="Move down">↓</button><button data-lirm="${l.key}.${i}" title="Remove">×</button></div></div>`).join('')}
      ${items.length < l.max ? `<button class="btn ghost" data-liadd="${l.key}">+ Add ${esc(one.toLowerCase())}</button>` : `<p class="ip-note">At most ${l.max}.</p>`}</div>`;
  }).join('');
}
const IC = {
  more: '<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15.5" cy="10" r="1.5"/></svg>',
  dup: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7"/></svg>',
  del: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/></svg>',
};
/* One inspector for a post and for anything selected inside it (an image, a text, a photo).
   Order: what is selected, template, content, images, sizes, show/hide, style, caption, export. */
function inspector(pid, id) {
  const p = S().posts.find(x => x.id === pid), t = X.templates[p.template], g = X.assetList().find(g => g.post.id === pid);
  const a = id ? layout.get(id).a : null, o = id ? ov(id) : {};
  const allowed = X.allowedFormats(t), needs = t.needs || [], themes = Object.entries(B().themes);
  const hasMotion = !!window.StudioAnimate;

  // 1. the selected element, when there is one
  let elem = '';
  if (a && sel.type === 'text') {
    const v = X.getPath(X.assetData(id), sel.path) ?? '', own = o[sel.path] != null;
    elem = `<div class="ip-sec el"><div class="ip-t">Selected text</div>
      <textarea data-ovtext rows="3">${esc(v)}</textarea>
      <div class="scope"><span>${own ? `Only on ${esc(a.fmt.short || a.fmt.label)}` : X.kinds[sel.path.split('.')[0]] ? `Shared: ${esc(X.kinds[sel.path.split('.')[0]].label)}. Changes every design that uses it` : multi(a) ? 'Same on all sizes' : ''}</span>${own ? '<button class="lnk" data-el="reset">Reset</button><button class="lnk" data-el="promote">Use on all sizes</button>' : multi(a) || X.kinds[sel.path.split('.')[0]] ? '<button class="lnk" data-el="onlyHere">Only this size</button>' : ''}</div></div>`;
  } else if (a && sel.type === 'sticker') {
    const st = (o.__stickers || [])[sel.idx] || {};
    elem = `<div class="ip-sec el"><div class="ip-t">Selected sticker</div>
      <label class="fld"><span>Size</span><input type="range" min="4" max="120" step="0.5" value="${st.w}" data-st="w"></label>
      <label class="fld"><span>Rotation</span><input type="range" min="-45" max="45" step="1" value="${st.rot || 0}" data-st="rot"></label>
      <div class="btnrow"><button class="btn" data-el="stAll">Copy to all sizes</button><button class="btn danger" data-el="stDel">Delete</button></div></div>`;
  } else if (a && sel.type === 'photo') {
    const url = X.getContent(pid, sel.path);
    elem = `<div class="ip-sec el"><div class="ip-t">Selected image</div><div class="pv" style="${url ? `background-image:url('${url}')` : ''}"></div>
      <div class="btnrow"><button class="btn" data-el="replace">${url ? 'Replace…' : 'Upload…'}</button>${o['pos:' + sel.path] ? '<button class="btn" data-el="resetPos">Reset crop</button>' : ''}</div></div>`;
  }

  // 2. content: shared texts the template reads, the post's own texts, slides
  const own = (t.fields || []).length ? t.fields.map(f => field(f.key, f.label, f.type || 'text', '', p.fields[f.key], 'data-pf')).join('') : '';
  // boards are edited on the canvas (click a text, click or drop on an image); only JS templates keep the form
  const content = t.markup ? '' : postTexts(p, t) + (own ? `<div class="ip-sec"><div class="ip-t">${(t.uses || []).length ? 'More text' : 'Content'} <small>all sizes</small></div>${own}</div>` : '') + (needs.includes('slides') ? slidesEditor(p) : '');
  const hint = t.markup && !elem ? `<div class="ip-sec"><p class="ip-note">Edit on the canvas: double-click a text to type, click an image slot to add a photo. ${multi({ post: p }) ? 'A change applies to every size unless you choose “Only this size”.' : ''}${t.pagesOwn ? ' Use the toolbar above a page to change its layout, move or remove it; the + tile adds a page.' : ''}</p></div>` : '';

  // the slide: what belongs to this page at every size (layout, look, graphic); the design: what is shared; this size: what differs
  const paged = !!(a && isPage(a)), item = paged ? X.pageItem(id) : null, pt = paged ? a.tpl : t, cont = !!t.container, inSlide = op => cont ? op.scope !== 'design' : op.scope === 'slide', sparts = paged ? (pt.optional || []).filter(inSlide) : []; // in a design of pages every option of a page's template is the page's, unless the template says `design`
  const slideTpls = [t, ...X.order.map(k => X.templates[k]).filter(x => x.slide && x !== t)];
  const slide = !item ? '' : `<div class="ip-sec"><div class="ip-t">Slide ${pageIdx(a) + 1} of ${p.fields[t.pagesOwn].length} <small>all sizes</small></div>
    <label class="fld"><span>Template</span><select data-stemplate>${slideTpls.map(x => `<option value="${x.id}" ${x === pt ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
    ${pt.layouts.length ? `<label class="fld"><span>Layout</span><select data-slayout>${pt.layouts.map(l => `<option value="${l.id}" ${l.id === (item.layout || pt.layouts[0].id) ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select></label>` : ''}
    <div class="fld"><span>Look</span>${lookSwatches(item.ground || '', 'slook', 'Same as the design')}</div>
    ${p.formats.filter(fk => !X.allowedFormats(pt).includes(fk)).length ? `<p class="warnline">⚠ This page is not made at ${p.formats.filter(fk => !X.allowedFormats(pt).includes(fk)).map(fk => esc(X.FORMATS[fk].short || X.FORMATS[fk].label)).join(', ')}, so it is left out there.</p>` : ''}
    ${sparts.map(op => op.choices ? choiceRow(op, (item.show || {})[op.key], 'schoice', g.assets.filter(x => pageIdx(x) === pageIdx(a)), (p.fields.show || {})[op.key]) : optionalSeg(op, (item.show || {})[op.key], 'sshow')).join('')}</div>`;

  // 3. show / hide: for the selected size when there is one, else for the whole post
  const partsList = (pt.optional || []).filter(op => !((cont || paged) && inSlide(op)));
  const parts = partsList.length ? `<div class="ip-sec"><div class="ip-t">${cont ? 'Design: show' : 'Show'} <small>${a ? `on ${esc(a.fmt.short || a.fmt.label)} only` : 'on all sizes'}</small></div>
    ${partsList.map(op => op.choices ? choiceRow(op, a ? (o.__show || {})[op.key] : (p.fields.show || {})[op.key], a ? 'fchoice' : 'pchoice', a ? [a] : g.assets, (p.fields.show || {})[op.key])
      : a ? optionalSeg(op, (o.__show || {})[op.key] ?? (p.fields.show || {})[op.key], 'fshow') : optionalSeg(op, (p.fields.show || {})[op.key], 'pshow')).join('')}
    ${a && (o.__hide || []).length ? `<div class="scope"><span>Hidden here: ${o.__hide.map(esc).join(', ')}</span><button class="lnk" data-unhide>Show all</button></div>` : ''}</div>` : '';

  // 4. style of the selected size
  let style = '';
  if (a) {
    const node = $(`#world .fr[data-id="${CSS.escape(id)}"] .asset`), cur = node?.dataset.bd, curTheme = o.__theme || a.item.theme || S().theme;
    const warn = $(`#world .fr[data-id="${CSS.escape(id)}"]`)?.classList.contains('warn');
    const edits = Object.keys(o).filter(k => !k.startsWith('__'));
    style = `<div class="ip-sec"><div class="ip-t">${paged ? 'This size' : 'Style'} <small>${esc(a.fmt.short || a.fmt.label)} only</small></div>
      ${warn ? `<p class="warnline">⚠ ${a.tpl.markup ? 'Some content doesn’t fit this size. Shorten the text or hide a part.' : 'Text touches a shape with this background. Pick another one or shorten the text.'}</p>` : ''}
      ${sparts.filter(op => !op.choices).map(op => optionalSeg(op, (o.__show || {})[op.key], 'fshow')).join('')}
      ${sparts.filter(op => op.choices).map(op => choiceRow(op, (o.__show || {})[op.key], 'fchoice', [a], (item.show || {})[op.key] || (p.fields.show || {})[op.key], 'Slide')).join('')}
      ${paged && cont ? (o.__bg ? `<div class="fld"><span>Look</span>${lookSwatches(o.__bg, 'flook', 'Same as the slide')}</div>` : '') : a.tpl.markup ? `<div class="fld"><span>Look</span>${lookSwatches(o.__bg || '', 'flook', p.look ? 'Same as the design' : 'Template default')}</div>` : a.tpl.backdrop ? `<label class="fld"><span>Background</span><select data-fbg>${bgOptions(a, o, cur)}</select></label>` : ''}
      ${themes.length > 1 ? `<label class="fld"><span>Theme</span><div class="seg">${themes.map(([k, th]) => `<button data-ftheme="${k}" aria-pressed="${k === curTheme}">${esc(th.label || k)}</button>`).join('')}</div></label>` : ''}
      ${hasMotion ? `<label class="chk urow"><input type="checkbox" data-fmotion ${o.__motion ? 'checked' : ''}> Motion <small>animated, exports MP4</small></label>` : ''}
      ${edits.length ? `<div class="scope"><span>${edits.length} text change${edits.length > 1 ? 's' : ''} on this size</span><button class="lnk" data-freset>Reset all</button></div>` : ''}
      ${a.tpl.markup ? '' : `<div class="scope"><span>${(o.__stickers || []).length ? `${o.__stickers.length} sticker${o.__stickers.length > 1 ? 's' : ''}` : 'Stickers: paste a PNG (⌘V) or'}</span><button class="lnk" data-fsticker>Add sticker…</button></div>`}
    </div>`;
  }
  if (!a && t.markup) style = `<div class="ip-sec"><div class="ip-t">Look <small>all sizes</small></div>${lookSwatches(p.look || 'auto', 'plook', 'Template default')}</div>`;
  for (const k in X.kinds) X.setFocus(k, X.sharedItem(p, k).id); // a design made next reads the same items as the one on show
  // the item of each kind this design reads: a pick when the project has several (two events), and the way to its editor
  const itemUses = X.kindsOf(p).filter(k => X.kinds[k]).map(k => { const items = X.S.shared[k], cur = X.sharedItem(p, k);
    return `<div class="fld"><span>${esc(X.kinds[k].label)}</span><div class="userow">${items.length > 1 ? `<select data-puse="${k}">${items.map(v => `<option value="${v.id}" ${v === cur ? 'selected' : ''}>${esc(X.itemLabel(k, v))}</option>`).join('')}</select>` : ''}<button class="use" data-goto="kind:${k}:${cur.id}">${items.length > 1 ? 'Edit' : esc(X.itemLabel(k, cur))} ›</button></div></div>`; }).join('');
  const sharedUses = [((t.uses || []).length || t.facts) && ['event', 'Details'], needs.includes('speakers') && ['speakers', 'Speakers'], needs.includes('agenda') && ['agenda', 'Agenda'], needs.includes('photos') && ['photos', 'Photos']].filter(Boolean);
  const motion = g.assets.filter(x => ov(x.id).__motion).length;

  return `<div class="ip-h ip-head"><input class="ip-name" data-pname value="${esc(p.name || t.label)}" title="Rename">
      <button class="ib" data-pdup title="Duplicate">${IC.dup}</button><button class="ib danger" data-pdel title="Delete (⌫)">${IC.del}</button></div>
    <div class="ip-sub">${a ? `<b>${esc(a.fmt.label)}</b> ${a.fmt.w}×${a.fmt.h}${a.item.label ? ', ' + esc(a.item.label) : ''} <button class="use" data-gopost="${pid}">All sizes</button>` : `${g.assets.length} image${g.assets.length === 1 ? '' : 's'}, all sizes selected`}</div>
    ${elem}
    ${slide}
    ${cont ? '' : `<div class="ip-sec"><div class="ip-t">Template</div><select data-ptpl>${[...new Set(X.order.map(k => X.templates[k].group || ''))].map(g => { const o = X.order.filter(k => (X.templates[k].group || '') === g).map(k => `<option value="${k}" ${k === p.template ? 'selected' : ''}>${esc(X.templates[k].label)}</option>`).join(''); return g ? `<optgroup label="${esc(g)}">${o}</optgroup>` : o; }).join('')}</select>
      <p class="ip-note">${esc(t.description || '')}</p></div>`}
    ${hint}${content}
    ${t.markup ? '' : photosBlock(pid, id)}
    ${a ? '' : `<div class="ip-sec"><div class="ip-t">Sizes</div>${t.formats ? `<p class="ip-note">${esc(X.FORMATS[t.formats[0]].label)}: ${esc(X.FORMATS[t.formats[0]].hint)}.</p>` :
      `<div class="sizes">${allowed.map(k => { const f = X.FORMATS[k]; return `<label class="size ${p.formats.includes(k) ? 'on' : ''}"><input type="checkbox" data-psize="${k}" ${p.formats.includes(k) ? 'checked' : ''}><i class="fk fk-${f.kind}"></i><span><b>${esc(f.label)}</b><small>${esc(f.hint)}</small></span></label>`; }).join('')}</div>`}</div>`}
    ${parts}
    ${style}
    <div class="ip-sec"><div class="ip-t">Caption <small>${p.fields.caption != null ? 'edited' : 'generated'}</small></div>
      <textarea data-caption rows="5">${esc(captionOf(p))}</textarea>
      <div class="btnrow"><button class="btn" data-capcopy>Copy caption</button>${p.fields.caption != null ? '<button class="lnk" data-capreset>Regenerate</button>' : ''}</div></div>
    ${sharedUses.length || itemUses ? `<div class="ip-sec"><div class="ip-t">Uses shared content</div>${itemUses}<div class="uses">${sharedUses.map(([k, l]) => `<button class="use" data-goto="${k}">${esc(l)} ›</button>`).join('')}</div></div>` : ''}
    <div class="ip-sec"><div class="btnrow"><button class="btn primary" ${a ? 'data-fexport' : 'data-pexport'}>Export ${a ? 'this image' : 'design'}…</button>${a ? '<button class="btn" data-fzoom>Zoom to</button>' : ''}${hasMotion && !a ? `<button class="btn" data-pmotion>${motion && motion === g.assets.length ? 'Stop motion' : 'Animate all'}</button>` : ''}</div>
      ${a ? X.actions.filter(x => !x.test || x.test(a)).map(x => `<button class="lnk" data-ext="${x.id}" title="${esc(x.title || '')}">${esc(x.label)}</button>`).join('') : ''}</div>`;
}
function bindInspector(R) {
  const s = X.S;
  R.querySelectorAll('[data-k]').forEach(el => el.addEventListener('input', () => { s[el.dataset.k] = el.value; X.changed(); }));
  R.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { s.theme = b.dataset.theme; X.changed({ form: true }); });
  R.querySelectorAll('[data-flag]').forEach(el => el.onchange = () => { s[el.dataset.flag] = el.checked; X.changed(); });
  R.querySelectorAll('[data-sp]').forEach(el => el.oninput = () => { const [i, k] = el.dataset.sp.split('.'); s.speakers[i][k] = el.value; X.changed(); });
  R.querySelectorAll('[data-ag]').forEach(el => el.oninput = () => { const [i, k] = el.dataset.ag.split('.'); s.agenda[i][k] = el.value; X.changed(); });
  R.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => { X.pickPath = el.dataset.pick; $('#filePick').click(); });
  // shared content of a declared kind
  const sh = X.sharedFor(null); // the items on show in the editor (kindInspector puts its item in focus)
  R.querySelectorAll('[data-sh]').forEach(el => el.addEventListener('input', () => { X.setPath(sh, el.dataset.sh, el.value); X.changed(); if (/^\w+\.(title|name|date)$/.test(el.dataset.sh)) renderLayers(); }));
  R.querySelectorAll('[data-itdup]').forEach(b => b.onclick = () => { const [k, id] = b.dataset.itdup.split(':'), from = s.shared[k].find(x => x.id === id), n = X.usersOf(k, from).length, v = X.newItem(k, from, true);
    X.changed({ form: true }); select({ type: 'content', key: `kind:${k}:${v.id}` }); X.toast(`Copied${n ? ` with ${n} design${n > 1 ? 's' : ''}` : ''}. Now change what differs`); });
  R.querySelectorAll('[data-itdel]').forEach(b => b.onclick = () => { const [k, id] = b.dataset.itdel.split(':'), v = s.shared[k].find(x => x.id === id), n = X.usersOf(k, v).length;
    if (n && !confirm(`Delete "${X.itemLabel(k, v)}" and the ${n} design${n > 1 ? 's' : ''} that use it?`)) return;
    if (X.removeItem(k, id)) { sel = null; X.changed({ form: true }); X.toast('Deleted. ⌘Z brings it back'); } });
  R.querySelectorAll('[data-shadd]').forEach(b => b.onclick = () => { const [k, l] = b.dataset.shadd.split('.'), def = X.kinds[k].fields.find(f => f.key === l); { const a = sh[k][l]; a.push({ ...Object.fromEntries((def.item || []).map(f => [f.key, ''])), id: Studio.boards.newId(new Set(a.map(x => x.id))) }); } X.changed({ form: true }); renderInspector(); });
  R.querySelectorAll('[data-shrm]').forEach(b => b.onclick = () => { const [k, l, i] = b.dataset.shrm.split('.'), a = sh[k][l], before = a.map(x => x.id); a.splice(+i, 1); X.afterListChange(`${k}.${l}`, before, a, null, sh[k]); X.changed({ form: true }); renderInspector(); });
  R.querySelectorAll('[data-shmv]').forEach(b => b.onclick = () => { const [k, l, i, d] = b.dataset.shmv.split('.'), a = sh[k][l], j = +i + +d; if (j < 0 || j >= a.length) return; const before = a.map(x => x.id); [a[i], a[j]] = [a[j], a[i]]; X.afterListChange(`${k}.${l}`, before, a, null, sh[k]); X.changed({ form: true }); renderInspector(); });
  R.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    const k = b.dataset.add;
    if (k === 'speakers') s.speakers.push({ id: Studio.boards.newId(new Set(s.speakers.map(x => x.id))), name: '', role: '', company: '', photo: '' });
    if (k === 'agenda') s.agenda.push({ id: Studio.boards.newId(new Set(s.agenda.map(x => x.id))), time: '', label: '' });
    X.changed({ form: true });
  });
  R.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { const [k, i] = b.dataset.rm.split('.'), before = s[k].map(x => x && x.id); s[k].splice(+i, 1); if (k !== 'photos') X.afterListChange(k, before, s[k]); X.changed({ form: true }); });
  R.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => { const [k, i, d] = b.dataset.mv.split('.'), j = +i + +d; if (j < 0 || j >= s[k].length) return; const before = s[k].map(x => x && x.id); [s[k][i], s[k][j]] = [s[k][j], s[k][i]]; if (k !== 'photos') X.afterListChange(k, before, s[k]); else s.overrides = {}; X.changed({ form: true }); });
  const ap = R.querySelector('[data-addphotos]'); if (ap) { ap.onclick = () => $('#phPick').click(); $('#phPick').onchange = async e => { for (const f of e.target.files) s.photos.push(await X.readImage(f)); X.changed({ form: true }); }; }
  // post: the one selected, or the one the selected image belongs to
  const pid = sel?.type === 'post' ? sel.key : sel?.id ? sel.id.split('.')[0] : null;
  const p = pid ? s.posts.find(x => x.id === pid) : null;
  const on = (q, fn) => { const el = R.querySelector(q); if (el) el.onclick = fn; };
  if (p) {
    const nm = R.querySelector('[data-pname]'); if (nm) nm.oninput = () => { p.name = nm.value; X.changed(); };
    const tp = R.querySelector('[data-ptpl]'); if (tp) tp.onchange = () => { X.changeTemplate(p.id, tp.value); sel = { type: 'post', key: p.id }; X.changed({ form: true }); renderInspector(); X.toast('Template changed. Matching texts and images were kept'); };
    R.querySelectorAll('[data-psize]').forEach(el => el.onchange = () => { const k = el.dataset.psize; p.formats = X.allowedFormats(X.templates[p.template]).filter(f => f === k ? el.checked : p.formats.includes(f)); X.changed({ form: true }); });
    R.querySelectorAll('[data-pf]').forEach(el => el.addEventListener('input', () => { p.fields[el.dataset.pf] = el.value; X.changed(); }));
    R.querySelectorAll('[data-sl]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const [i, k] = el.dataset.sl.split('.'), x = p.fields.slides[i];
      x[k] = k === 'items' ? el.value.split('\n').filter(v => v.trim()) : k === 'stats' ? el.value.split(',').map(v => v.trim()).filter(Boolean) : el.value;
      X.changed({ form: k === 'type' });
    }));
    R.querySelectorAll('[data-slmv]').forEach(b => b.onclick = () => { const [i, d] = b.dataset.slmv.split('.'), j = +i + +d, a = p.fields.slides; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; X.changed({ form: true }); });
    R.querySelectorAll('[data-slrm]').forEach(b => b.onclick = () => { p.fields.slides.splice(+b.dataset.slrm, 1); X.changed({ form: true }); });
    const sa = R.querySelector('[data-sladd]'); if (sa) sa.onclick = () => { p.fields.slides.push({ type: 'text', title: '', body: '', photo: '', items: [], stats: [] }); X.changed({ form: true }); };
    R.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => select({ type: 'content', key: b.dataset.goto }));
    // list fields: item order changes which image is which, so per-size changes of this post are dropped
    const dropOv = () => { for (const k in s.overrides) if (k.startsWith(p.id + '.')) delete s.overrides[k]; };
    R.querySelectorAll('[data-li]').forEach(el => el.addEventListener('input', () => { const [k, i, f] = el.dataset.li.split('.'); p.fields[k][i][f] = el.value; X.changed(); }));
    R.querySelectorAll('[data-limv]').forEach(b => b.onclick = () => { const [k, i, d] = b.dataset.limv.split('.'), j = +i + +d, a = p.fields[k]; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; dropOv(); X.changed({ form: true }); renderInspector(); });
    R.querySelectorAll('[data-lirm]').forEach(b => b.onclick = () => { const [k, i] = b.dataset.lirm.split('.'); p.fields[k].splice(+i, 1); dropOv(); X.changed({ form: true }); renderInspector(); });
    R.querySelectorAll('[data-liadd]').forEach(b => b.onclick = () => { const k = b.dataset.liadd, l = X.templates[p.template].lists.find(x => x.key === k); p.fields[k].push(Object.fromEntries(l.item.map(f => [f.key, '']))); X.changed({ form: true }); renderInspector(); });
    R.querySelectorAll('[data-plook]').forEach(b => b.onclick = () => { if (b.dataset.plook === 'auto') delete p.look; else p.look = b.dataset.plook; X.changed({ form: true }); renderInspector(); });
    on('[data-pexport]', () => openExport({ scope: 'post' }));
    on('[data-pmotion]', () => { const g = X.assetList().find(g => g.post.id === p.id), all = g.assets.every(a => ov(a.id).__motion); g.assets.forEach(a => { const o = (s.overrides[a.id] ||= {}); if (all) delete o.__motion; else o.__motion = true; }); X.changed(); });
    on('[data-pdup]', () => duplicatePost(p.id));
    R.querySelectorAll('[data-puse]').forEach(el => el.onchange = () => { X.setUse(p, el.dataset.puse, el.value); X.changed({ form: true }); });
    on('[data-pdel]', () => deletePost(p.id));
  }
  // frame
  const id = sel?.id;
  const gp = R.querySelector('[data-gopost]'); if (gp) gp.onclick = () => select({ type: 'post', key: gp.dataset.gopost });
  const fbg = R.querySelector('[data-fbg]'); if (fbg) fbg.onchange = () => setBg(id, fbg.value);
  R.querySelectorAll('[data-stemplate]').forEach(el => el.onchange = () => { const A = assetById(id); X.setSlideTemplate(A.post.id, pageIdx(A), el.value); X.changed({ form: true }); select({ type: 'frame', id: X.assetList().flatMap(g => g.assets).find(x => x.post.id === A.post.id && pageIdx(x) === pageIdx(A))?.id || id }); renderInspector(); });
  R.querySelectorAll('[data-slayout]').forEach(el => el.onchange = () => pageOps(assetById(id)).layout(pageIdx(assetById(id)), el.value));
  R.querySelectorAll('[data-slook]').forEach(b => b.onclick = () => { const it = X.pageItem(id); if (!it) return; if (b.dataset.slook) it.ground = b.dataset.slook; else delete it.ground; X.changed({ form: true }); renderInspector(); });
  R.querySelectorAll('[data-schoice]').forEach(el => el.onchange = () => { const it = X.pageItem(id); if (!it) return; const sh = (it.show ||= {}), k = el.dataset.schoice; if (el.value) sh[k] = el.value; else delete sh[k]; if (!Object.keys(sh).length) delete it.show; X.changed({ form: true }); renderInspector(); });
  R.querySelectorAll('[data-sshow]').forEach(b => b.onclick = () => { const it = X.pageItem(id); if (!it) return; const sh = (it.show ||= {}), k = b.dataset.sshow; if (b.dataset.v === 'auto') delete sh[k]; else sh[k] = b.dataset.v === '1'; if (!Object.keys(sh).length) delete it.show; X.changed({ form: true }); renderInspector(); });
  R.querySelectorAll('[data-flook]').forEach(b => b.onclick = () => { setBg(id, b.dataset.flook); renderInspector(); });
  R.querySelectorAll('[data-ftheme]').forEach(b => b.onclick = () => setTheme(id, b.dataset.ftheme));
  const fm = R.querySelector('[data-fmotion]'); if (fm) fm.onchange = () => toggleMotion(id);
  const fr = R.querySelector('[data-freset]'); if (fr) fr.onclick = () => { s.overrides[id] = Object.fromEntries(Object.entries(s.overrides[id] || {}).filter(([k]) => k.startsWith('__'))); X.changed(); };
  const fe = R.querySelector('[data-fexport]'); if (fe) fe.onclick = () => openExport({ scope: 'frame' });
  const fz = R.querySelector('[data-fzoom]'); if (fz) fz.onclick = () => zoomToFrame(id);
  R.querySelectorAll('[data-ext]').forEach(b => b.onclick = () => { const x = X.actions.find(a => a.id === b.dataset.ext); x && x.run(id, assetById(id)); });
  const ot = R.querySelector('[data-ovtext]'); if (ot) ot.oninput = () => { writeText(id, sel.path, ot.value); X.changed(); };
  R.querySelectorAll('[data-el]').forEach(b => b.onclick = () => {
    const k = b.dataset.el;
    if (k === 'reset') { delete s.overrides[id][sel.path]; X.changed(); }
    if (k === 'onlyHere') { onlyHere(id, sel.path); renderInspector(); }
    if (k === 'promote') promote(id, sel.path);
    if (k === 'replace') { X.pickPath = id.split('.')[0] + '|' + sel.path; $('#filePick').click(); }
    if (k === 'resetPos') { delete s.overrides[id]['pos:' + sel.path]; X.changed(); }
    if (k === 'stAll') stickerToPost(id, sel.idx);
    if (k === 'stDel') removeSticker(id, sel.idx);
  });
  R.querySelectorAll('[data-fchoice]').forEach(el => el.onchange = () => { const sh = ((s.overrides[id] ||= {}).__show ||= {}), k = el.dataset.fchoice; if (el.value) sh[k] = el.value; else delete sh[k]; if (!Object.keys(sh).length) delete s.overrides[id].__show; X.changed(); renderInspector(); });
  R.querySelectorAll('[data-fshow]').forEach(b => b.onclick = () => { const sh = ((s.overrides[id] ||= {}).__show ||= {}), k = b.dataset.fshow; if (b.dataset.v === 'auto') delete sh[k]; else sh[k] = b.dataset.v === '1'; if (!Object.keys(sh).length) delete s.overrides[id].__show; X.changed(); renderInspector(); });
  const uh = R.querySelector('[data-unhide]'); if (uh) uh.onclick = () => { delete s.overrides[id].__hide; X.changed(); };
  const fs = R.querySelector('[data-fsticker]'); if (fs) fs.onclick = () => pickSticker(id);
  R.querySelectorAll('input[data-st]').forEach(el => el.oninput = () => { const st = ov(id).__stickers[sel.idx]; st[el.dataset.st] = +el.value; X.changed(); });
  R.querySelectorAll('[data-unpick]').forEach(b => b.onclick = () => { const [pid, path] = b.dataset.unpick.split('|'); X.setContent(pid, path, ''); X.changed({ form: true }); });
  if (p) {
    R.querySelectorAll('[data-pchoice]').forEach(el => el.onchange = () => { const sh = (p.fields.show ||= {}), k = el.dataset.pchoice, op = X.templates[p.template].optional.find(x => x.key === k); if (el.value === op.default) delete sh[k]; else sh[k] = el.value; X.changed({ form: true }); renderInspector(); });
    R.querySelectorAll('[data-pshow]').forEach(b => b.onclick = () => { const sh = (p.fields.show ||= {}), k = b.dataset.pshow; if (b.dataset.v === 'auto') delete sh[k]; else sh[k] = b.dataset.v === '1'; X.changed({ form: true }); renderInspector(); });
    const cap = R.querySelector('[data-caption]'); if (cap) cap.oninput = () => { p.fields.caption = cap.value; X.persist(); };
    const cc = R.querySelector('[data-capcopy]'); if (cc) cc.onclick = () => { navigator.clipboard.writeText(captionOf(p)); X.toast('Caption copied'); };
    const cr = R.querySelector('[data-capreset]'); if (cr) cr.onclick = () => { delete p.fields.caption; X.changed({ form: true }); };
    R.querySelectorAll('[data-pu]').forEach(el => el.addEventListener('input', () => { const k = el.dataset.pu; if (el.value === X.S[k]) delete p.fields[k]; else p.fields[k] = el.value; X.changed(); }));
    R.querySelectorAll('[data-pureset]').forEach(b => b.onclick = () => { delete p.fields[b.dataset.pureset]; X.changed({ form: true }); });
  }
}
function refreshPanels() { renderLayers(); if (!document.activeElement?.closest('#right')) renderInspector(); }

/* ═════════════ top bar, data popover ═════════════ */
function bindTopbar() {
  $('#undo').onclick = () => travel(-1); $('#redo').onclick = () => travel(1);
  $('#zIn').onclick = () => zoomAt(view.z * 1.25); $('#zOut').onclick = () => zoomAt(view.z / 1.25); $('#zLabel').onclick = fitAll;
  $('#exportBtn').onclick = () => openExport({ scope: sel?.id ? 'frame' : sel?.type === 'post' ? 'post' : 'all' });
  $('#dataBtn').onclick = openData;
  $('#saveBtn').onclick = () => X.saveSheet();
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); commitEdit(); X.saveSheet(); } });
  saveState();
  $('#docName').oninput = e => { X.S.name = e.target.value; X.changed(); };
}
function openModal(html, cls = '') { const m = $('#modal'); m.innerHTML = `<div class="dlg ${cls}">${html}</div>`; m.hidden = false; m.onclick = e => { if (e.target === m || e.target.closest('[data-close]')) closeModal(); }; return m; }
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
// the Save button says whether there is work that is only in this browser
// ("Saved" only after a save in this session: an untouched new project or example has nothing to lose, and says Save)
let savedHere = false;
function saveState() { const b = $('#saveBtn'); if (!b) return; if (!X.unsaved && b.classList.contains('dirty')) savedHere = true; b.classList.toggle('dirty', X.unsaved); b.innerHTML = X.unsaved ? '<i class="dot"></i>Save' : savedHere ? 'Saved' : 'Save'; }
function openData() {
  const m = openModal(`<div class="sh-h"><b>Project</b><button class="ib" data-close>×</button></div>
    <div class="pj">
      <div class="pj-row"><div><b>Save as one file</b><p class="ip-note">An .html file with the whole project in it. Open it in any browser to see and edit it, send it to share. This is the real save: work is otherwise kept in this browser only.</p></div><button class="btn primary" id="saveSheet">Save (⌘S)</button></div>
      <div class="pj-row"><div><b>Open a file</b><p class="ip-note">A saved .html project or its .json. Replaces what is open here (⌘Z brings it back).</p></div><button class="btn" id="openFile">Open…</button><input type="file" id="openPick" accept=".html,.htm,.json,text/html,application/json" hidden></div>
      <div class="pj-row"><div><b>Share a link</b><p class="ip-note">The project in a link. Uploaded photos are left out.</p></div><button class="btn" id="copyLink">Copy link</button></div>
      <div class="pj-row"><div><b>New empty project</b><p class="ip-note">Starts over in this browser. ⌘Z brings this one back.</p></div><button class="btn danger" id="resetAll">New project</button></div>
      <details class="pj-data"><summary>Project data (JSON)</summary>
        <p class="ip-note">The whole project as JSON. Claude can write this (or a <code>#d=</code> link, or a whole sheet) and the editor renders every image from it.</p>
        <textarea id="json" spellcheck="false"></textarea>
        <div class="btnrow"><button class="btn" id="applyJson">Apply</button><button class="btn" id="copyJson">Copy JSON</button></div></details>
    </div>`, 'wide');
  $('#openFile', m).onclick = () => $('#openPick', m).click();
  $('#openPick', m).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await X.openFile(f); sel = null; X.changed({ form: true }); X.setUnsaved(false); closeModal(); X.toast('Opened ' + f.name); } catch (err) { X.toast('Could not open: ' + err.message); } };
  X.syncJson();
  $('#applyJson', m).onclick = () => { try { X.S = X.normalize(JSON.parse($('#json').value)); sel = null; X.changed({ form: true }); closeModal(); X.toast('Applied'); } catch (e) { X.toast('Invalid JSON: ' + e.message); } };
  $('#copyJson', m).onclick = () => { navigator.clipboard.writeText($('#json').value); X.toast('JSON copied'); };
  $('#copyLink', m).onclick = () => { navigator.clipboard.writeText(location.href.split('#')[0] + '#d=' + X.b64enc(JSON.stringify(X.exportData({ dropUploads: true })))); X.toast('Link copied (uploaded photos stay local)'); };
  $('#saveSheet', m).onclick = () => { X.saveSheet(); closeModal(); };
  $('#resetAll', m).onclick = () => { X.S = X.normalize({}); sel = null; X.changed({ form: true }); closeModal(); X.toast('New project. ⌘Z brings the old one back'); };
}

/* ═════════════ export panel ═════════════ */
function openExport(opts = {}) {
  const all = assets(), postId = sel?.type === 'post' ? sel.key : sel?.id?.split('.')[0], post = S().posts.find(p => p.id === postId);
  const scopes = [
    sel?.id && ['frame', 'This frame', [sel.id]],
    post && ['post', `${post.name || X.templates[post.template].label} (${all.filter(a => a.post.id === postId).length})`, all.filter(a => a.post.id === postId).map(a => a.id)],
    ['all', `All designs (${all.length})`, all.map(a => a.id)],
  ].filter(Boolean);
  let scope = scopes.find(s => s[0] === opts.scope) ? opts.scope : scopes[0][0];
  const hasSVG = !!window.StudioSVG, hasMP4 = !!window.StudioAnimate?.exportMp4;
  const m = openModal(`<div class="sh-h"><b>Export</b><button class="ib" data-close>×</button></div>
    <div class="ip-t">Scope</div><div class="seg" id="exScope">${scopes.map(([k, l]) => `<button data-v="${k}">${esc(l)}</button>`).join('')}</div>
    <div class="ip-t">Files</div>
    <label class="chk urow"><input type="checkbox" data-ft="png" checked> PNG <small>every frame</small></label>
    ${hasSVG ? '<label class="chk urow"><input type="checkbox" data-ft="svg"> SVG <small>editable vectors for Figma / Penpot</small></label>' : ''}
    <label class="chk urow"><input type="checkbox" data-ft="pdf" checked> PDF <small>carousels as one document, for LinkedIn</small></label>
    ${hasMP4 ? '<label class="chk urow"><input type="checkbox" data-ft="mp4" checked> MP4 <small>frames with Motion on</small></label>' : ''}
    <div class="ex-sum" id="exSum"></div>
    <div class="progress" hidden><div></div></div>
    <div class="btnrow"><span class="tb-sp"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="exGo">Export</button></div>`);
  const ids = () => scopes.find(s => s[0] === scope)[2];
  const types = () => $$('[data-ft]', m).filter(x => x.checked).map(x => x.dataset.ft);
  const plan = () => {
    const list = ids().map(assetById), t = types(), jobs = [];
    if (t.includes('png')) list.forEach(a => jobs.push({ kind: 'png', a }));
    if (t.includes('svg')) list.forEach(a => jobs.push({ kind: 'svg', a }));
    if (t.includes('mp4')) list.filter(a => ov(a.id).__motion).forEach(a => jobs.push({ kind: 'mp4', a }));
    if (t.includes('pdf')) { const byT = {}; list.filter(a => X.templates[a.post.template].pdf).forEach(a => (byT[a.post.id + '|' + a.fk] ||= []).push(a)); Object.values(byT).filter(v => v.length > 1).forEach(v => jobs.push({ kind: 'pdf', list: v })); }
    return jobs;
  };
  const sum = () => {
    $$('#exScope button', m).forEach(b => b.setAttribute('aria-pressed', b.dataset.v === scope));
    const j = plan(), c = k => j.filter(x => x.kind === k).length;
    $('#exSum', m).textContent = j.length ? `${[c('png') && c('png') + ' PNG', c('svg') && c('svg') + ' SVG', c('pdf') && c('pdf') + ' PDF', c('mp4') && c('mp4') + ' MP4'].filter(Boolean).join(', ')}${j.length > 1 ? ', as one ZIP' : ''}` : 'Nothing to export with these options.';
    $('#exGo', m).disabled = !j.length;
  };
  $('#exScope', m).onclick = e => { const b = e.target.closest('button'); if (b) { scope = b.dataset.v; sum(); } };
  $$('[data-ft]', m).forEach(x => x.onchange = sum); sum();
  $('#exGo', m).onclick = async () => {
    const jobs = plan(), bar = $('.progress', m); bar.hidden = false; $('#exGo', m).disabled = true;
    const files = [];
    try {
      for (const [i, j] of jobs.entries()) {
        bar.firstElementChild.style.width = (i / jobs.length * 100) + '%';
        $('#exSum', m).textContent = `Rendering ${i + 1}/${jobs.length}: ${j.kind.toUpperCase()} ${j.a ? j.a.name : ''}`;
        if (j.kind === 'png') { const r = await X.toBlob(j.a.id); files.push([r.name + '.png', r.blob]); }
        if (j.kind === 'svg') files.push([j.a.name + '.svg', new Blob([await window.StudioSVG.toSVG(j.a.id)], { type: 'image/svg+xml' })]);
        if (j.kind === 'mp4') { const b = await window.StudioAnimate.exportMp4(j.a.id); if (b instanceof Blob) files.push([j.a.name + '.mp4', b]); }
        if (j.kind === 'pdf') { const lbl = X.slug(j.list[0].post.name || j.list[0].tpl.label), b = await X.exportPdf(j.list.map(a => a.id), lbl, { blob: true }); if (b) files.push([`${X.projSlug()}-${lbl}.pdf`, b]); }
      }
      bar.firstElementChild.style.width = '100%';
      if (files.length === 1) X.save(files[0][1], files[0][0]);
      else if (files.length) { const zip = new JSZip(); files.forEach(([n, b]) => zip.file(n, b));
        [...new Set(ids().map(i => i.split('.')[0]))].forEach(pid => { const p = S().posts.find(x => x.id === pid); if (p) zip.file(`${X.slug(p.name || X.templates[p.template].label)}-caption.txt`, captionOf(p)); }); zip.file('set.json', JSON.stringify(X.exportData(), null, 2)); X.save(await zip.generateAsync({ type: 'blob' }), `${X.projSlug()}.zip`); }
      closeModal(); X.toast(`Exported ${files.length} file${files.length === 1 ? '' : 's'}`);
    } catch (e) { console.error(e); $('#exSum', m).textContent = 'Export failed: ' + e.message; $('#exGo', m).disabled = false; }
  };
}

/* ═════════════ engine callbacks ═════════════ */
Studio.ui = {
  mount, render, reset,
  refreshPanels,
  saveState,
  changed(opts) { record(); if (!opts?.form) { renderLayers(); if (!document.activeElement?.closest('#right')) renderInspector(); } },
  select, fitAll, zoomToFrame, get view() { return view; }, get selection() { return sel; },
};
})();
