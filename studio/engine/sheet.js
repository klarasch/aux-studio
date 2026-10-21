/* Sheet view: the same file, light. What a project opens in on a phone (a sheet sent over Slack, a chat preview) or with
   ?view=sheet: every image of every design, fitted to the screen, a carousel's pages side by side to swipe. Tap a text to fix it,
   tap a photo to replace it, save an image to the phone. No panels, no layout, no settings: those are the Studio view
   (?view=studio, or any wide screen). Uses the engine's state, rendering and export; ui.js hands over to it in mount(). */
(function () {
'use strict';
const X = () => Studio._;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// sheet view when asked for, or on a narrow screen unless the Studio view was asked for
function wanted() {
  const v = new URLSearchParams(location.search).get('view');
  return v === 'sheet' || (v !== 'studio' && matchMedia('(max-width: 720px)').matches);
}
function switchTo(view) { const u = new URL(location.href); u.searchParams.set('view', view); location.href = u.href; }

let editing = null, pick = null;
function mount() {
  document.body.classList.remove('studio2'); document.body.classList.add('sheetv');
  const B = X().B;
  $('#app').innerHTML = `
  <header class="sv-top">
    <div class="sv-brand">${B.logo.url ? `<img src="${B.logo.url}" alt="">` : ''}<b id="svName"></b></div>
    <button class="sv-btn" id="svSave" title="Save the project as one file">Save</button>
    <button class="sv-btn sv-studio" id="svStudio" title="Open the full editor (best on a computer)">Studio</button>
  </header>
  <main id="svList" data-ui-clear></main>`;
  $('#svSave').onclick = () => X().saveSheet();
  $('#svStudio').onclick = () => switchTo('studio');
  // the engine calls these after every change; the Studio's panels do not exist here
  Object.assign(Studio.ui, { render, changed() {}, saveState, refreshPanels() {}, reset() {} });
  const list = $('#svList');
  list.addEventListener('click', onTap);
  list.addEventListener('keydown', e => { if (editing && e.key === 'Escape') { e.preventDefault(); editing.blur(); } }); // Enter is a new line; Esc or tapping away finishes
  saveState(); render();
}
function saveState() { const b = $('#svSave'); if (!b) return; b.classList.toggle('dirty', X().unsaved); b.disabled = X().saving; b.textContent = X().saving ? 'Saving…' : 'Save'; }

/* ── render: a design, then a row per size (a carousel's pages scroll sideways) ── */
function render() {
  const list = $('#svList'); if (!list || editing) return; // never redraw under a text being typed
  const S = X().S; $('#svName').textContent = S.name || X().B.name;
  const groups = X().assetList().filter(g => g.assets.length);
  list.innerHTML = groups.length ? groups.map(g => {
    const sizes = [...new Set(g.assets.map(a => a.fk))];
    return `<section class="sv-design"><h2>${esc(g.label)}</h2>${sizes.map(fk => {
      const row = g.assets.filter(a => a.fk === fk), f = row[0].fmt;
      return `<div class="sv-size"><div class="sv-label">${esc(f.short || f.label)}${row.length > 1 ? ` <small>${row.length} pages, swipe</small>` : ''}</div>
        <div class="sv-row ${row.length > 1 ? 'many' : ''}">${row.map(a => `<figure class="sv-img" data-id="${esc(a.id)}" style="--w:${a.fmt.w};--h:${a.fmt.h}">
          <div class="sv-fit"><div class="sv-scale">${X().renderAsset(a)}</div></div>
          <figcaption><span>${esc(a.item.label && row.length > 1 ? a.item.label : '')}</span><button class="sv-btn sm" data-saveimg="${esc(a.id)}">Save image</button></figcaption></figure>`).join('')}</div></div>`;
    }).join('')}</section>`;
  }).join('') : '<p class="sv-empty">Nothing to show yet. Open this file on a computer to start a design.</p>';
  layout();
  document.fonts.ready.then(() => $$('.sv-img', list).forEach(fig => { const a = asset(fig.dataset.id), node = $('.asset', fig); if (a && node) X().fitBest(a, node); }));
}
const asset = id => X().assetList().flatMap(g => g.assets).find(a => a.id === id);
// each image is drawn at its true size and scaled to the width it has on screen
function layout() { $$('.sv-img').forEach(fig => { const w = $('.sv-fit', fig).clientWidth, k = w / +getComputedStyle(fig).getPropertyValue('--w'); $('.sv-scale', fig).style.transform = `scale(${k})`; }); }
addEventListener('resize', () => { if (document.body.classList.contains('sheetv')) layout(); });

/* ── tap: a text to edit it, a photo to replace it, Save image ── */
function onTap(e) {
  const sv = e.target.closest('[data-saveimg]'); if (sv) return saveImage(sv.dataset.saveimg, sv);
  const fig = e.target.closest('.sv-img'); if (!fig) return;
  const f = e.target.closest('[data-f]'); if (f) return startEdit(f, fig.dataset.id);
  const p = e.target.closest('[data-p]'); if (p) { pick = { id: fig.dataset.id, path: p.dataset.p }; filePick().click(); }
}
function startEdit(f, id) {
  if (editing === f) return;
  // the stored text, with *highlight* marks, so nothing is lost; it is drawn again when done
  const raw = X().getPath(X().assetData(id), f.dataset.f);
  const float = f.querySelector(':scope > .wrapf'); // the text keeps wrapping around the brand's shapes while it is edited
  f.textContent = typeof raw === 'string' ? raw : '';
  if (float) { float.contentEditable = 'false'; f.prepend(float); }
  f.removeAttribute('data-ph'); f.setAttribute('contenteditable', 'plaintext-only'); f.spellcheck = false;
  editing = f; f.focus();
  const r = document.createRange(); r.selectNodeContents(f); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  f.addEventListener('blur', () => {
    editing = null; const v = f.textContent.replace(/ /g, ' ').trim(), o = X().S.overrides[id];
    if (v !== (raw ?? '')) { if (o && o[f.dataset.f] != null) o[f.dataset.f] = v; else X().setContent(id.split('.')[0], f.dataset.f, v); X().changed(); }
    render();
  }, { once: true });
}
function filePick() {
  let i = $('#svPick');
  if (!i) { i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.id = 'svPick'; i.hidden = true; document.body.appendChild(i);
    i.onchange = async () => { const f = i.files[0]; i.value = ''; if (!f || !pick) return; X().setContent(pick.id.split('.')[0], pick.path, await X().readImage(f)); pick = null; X().changed(); render(); }; }
  return i;
}
// on a phone, the share sheet ("Save image" to Photos); elsewhere a download
async function saveImage(id, btn) {
  btn.disabled = true; btn.textContent = 'Rendering…';
  try {
    const r = await X().toBlob(id), file = new File([r.blob], r.name + '.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] }).catch(() => {});
    else X().save(r.blob, r.name + '.png');
  } finally { btn.disabled = false; btn.textContent = 'Save image'; }
}

Studio.sheet = { wanted, mount, render };
})();
