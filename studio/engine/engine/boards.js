/* Markup templates — a makeitbrand board with fields, registered as a Studio template.

   A template is one HTML file, no JS (see studio/TEMPLATES.md):

     <template data-template="id" data-label="…" data-description="…" data-sizes="ig-post ig-story">
       <script type="application/json">{ "fields": [...], "parts": [...] }</script>
       <section class="board">…makeitbrand primitives, with data-f / data-p / data-each…</section>
       <section class="board" data-when="landscape">…an optional variant for some sizes…</section>
     </template>

   This file compiles that into the object Studio.registerTemplate() expects, renders it as a
   .board (the board is the asset element), and hands layout to the makeitbrand runtime in host
   mode. It also builds a Studio brand object from the makeitbrand brand stylesheet on the page. */
(function () {
'use strict';
const Studio = window.Studio;
const TEXT_SHARED = ['title', 'description', 'cta'], FACTS = ['date', 'time', 'venue', 'city'], LISTS = ['speakers', 'agenda', 'photos'];
const words = s => (s || '').split(/\s+/).filter(Boolean);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// field text → board markup: line breaks, and *word* as the brand highlight (<strong>)
const rich = s => esc(s).replace(/\n/g, '<br>').replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
const get = (o, p) => p.split('.').reduce((a, k) => a == null ? a : a[k], o);
// an item's `id` (see newId) is bookkeeping, not content: an item with nothing else in it is still empty
const filled = v => Array.isArray(v) ? v.some(filled) : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => k !== 'id' && filled(x)) : v != null && v !== '' && v !== false;
// a short permanent id for an item of a list (a slide): per-image settings follow the item when it moves. `used` is a Set of ids in that list.
const newId = used => { let id; do id = Math.random().toString(36).slice(2, 6); while (used && used.has(id) || !/^[a-z]/.test(id)); used && used.add(id); return id; };

/* ───────────── choices ─────────────
   A part with "choices" is a pick: an array of { id, label }, or the name of a list the fork registers in
   Studio.boards.choices (custom.js), so every template can share one list. */
const choices = {};
const choicesOf = c => (typeof c === 'string' ? choices[c] || [] : c || []).map(x => typeof x === 'string' ? { id: x, label: x } : x);

/* ───────────── compile ───────────── */
function compile(src) {
  let el = src;
  if (typeof src === 'string') { const d = document.createElement('div'); d.innerHTML = src; el = d.querySelector('template[data-template]'); }
  if (!el || !el.dataset.template) throw new Error('A markup template needs <template data-template="id">');
  const kids = [...el.content.children];
  const ms = kids.find(k => k.matches('script[type="application/json"]'));
  const manifest = ms ? JSON.parse(ms.textContent) : {};
  const boards = kids.filter(k => k.matches('section.board'));
  if (!boards.length) throw new Error(`Template "${el.dataset.template}" has no <section class="board">`);
  const fields = manifest.fields || [], own = fields.filter(f => !f.shared), shared = fields.filter(f => f.shared).map(f => f.key);
  const sizes = words(el.dataset.sizes || 'ig-post'), fixed = sizes.every(k => Studio.formats[k]?.fixed);
  // data-pages="list": one image per item of that list field, between an optional first and last page
  const pages = el.dataset.pages || null, kinds = new Set(boards.map(b => b.dataset.page || 'each'));
  // page layouts: several "each" boards named with data-layout; every item picks one (cover, text, photo…)
  const layouts = [];
  for (const b of boards) if (b.dataset.layout && !layouts.some(l => l.id === b.dataset.layout)) layouts.push({ id: b.dataset.layout, label: b.dataset.label || b.dataset.layout });
  const labels = {}, itemLabels = {};
  for (const f of fields) { labels[f.key] = f.label || f.key; for (const x of f.item || []) itemLabels[x.key] = x.label || x.key; }
  return {
    id: el.dataset.template, label: el.dataset.label || el.dataset.template, description: el.dataset.description || '', group: el.dataset.group || '',
    channels: sizes, supports: el.dataset.supports ? words(el.dataset.supports) : undefined,
    ...(fixed ? { formats: sizes } : {}),
    container: el.hasAttribute('data-container'), // the template every design is made of: a list of pages, each of any `data-slide` template
    slide: el.hasAttribute('data-slide'), // may be used as a page of another design's carousel (item.template)
    ownKeys: new Set([...own.map(f => f.key)]), // the page's own fields and image slots (a page of a carousel keeps them on the page)
    markup: true, coverPhoto: false, boards, manifest, pages, pdf: !!pages, layouts, labels, itemLabels,
    kinds: manifest.uses || [], // the kinds of shared content this template binds to (`event.title`)
    // `pagesOwn`: the list is the design's own (pages can be added, moved, removed); a shared list (`event.speakers`) is only read
    pagesOwn: pages && !pages.includes('.') ? pages : null,
    ...(pages ? { items(d) {
      const list = get(d, pages) || [], out = [];
      // fixed pages before and after the list; several are allowed, in the order written. A page board may carry data-if
      // (a path that must be filled) to be left out, like an agenda nobody wrote
      const fixed = kind => boards.filter(b => b.dataset.page === kind).map((b, bi) => ({ b, bi })).filter(({ b }) => !b.dataset.if || filled(get(d, b.dataset.if)))
        .map(({ b, bi }) => ({ key: kind === 'first' ? (bi ? 'first' + (bi + 1) : 'cover') : (bi ? 'end' + (bi + 1) : 'end'), label: b.dataset.label || (kind === 'first' ? 'Cover' : 'End'), page: kind, bi }));
      out.push(...fixed('first'));
      list.forEach((v, i) => { if (filled(v)) out.push({ key: v?.id ? 's-' + v.id : 's' + i, label: String(out.length + 1), page: 'each', index: i, layout: v?.layout }); });
      out.push(...fixed('last'));
      // nothing to page over yet (a shared list nobody filled): one page of placeholders, so the design has a canvas to type on
      if (!out.length) out.push({ key: 's0', label: '1', page: 'each', index: 0, layout: list[0]?.layout });
      return out;
    } } : {}),
    // what the inspector shows: the post's own texts, its image slots, the shared content it reads
    fields: own.filter(f => f.type !== 'image' && f.type !== 'list').map(f => ({ key: f.key, label: f.label || f.key, type: f.type === 'long' ? 'textarea' : 'text', default: f.default ?? '' })),
    slots: own.filter(f => f.type === 'image').map(f => f.key),
    // list fields: each item has its own small set of fields (a carousel's slides)
    lists: own.filter(f => f.type === 'list').map(f => ({ key: f.key, label: f.label || f.key, itemLabel: f.itemLabel || 'Item', max: f.max || 20, item: f.item || [], default: f.default || [], newLayout: f.newLayout })),
    uses: shared.filter(k => TEXT_SHARED.includes(k)), facts: shared.some(k => FACTS.includes(k)), needs: shared.filter(k => LISTS.includes(k)),
    // parts are shown/hidden; a part with `choices` is a pick instead (a graphic, a texture), see TEMPLATES.md
    optional: (manifest.parts || []).map(p => ({ key: p.key, label: p.label || p.key, auto: p.auto, scope: p.scope, ...(p.choices ? { choices: choicesOf(p.choices), default: p.default ?? choicesOf(p.choices)[0]?.id, fit: !!p.fit } : {}) })),
    partDefault: Object.fromEntries((manifest.parts || []).map(p => [p.key, p.choices ? true : p.default !== false])),
    backdrop: () => ['auto'],
    render: () => '',
  };
}

/* ───────────── formats ─────────────
   data-format="name" on a data-show element looks the name up here: (value, h, data) → text.
   A fork adds its own from custom.js (Studio.boards.formats.shout = v => String(v).toUpperCase()).
   Dates are ISO (yyyy-mm-dd); days come from the brand's strings.days, months from strings.months
   or, failing that, Intl in strings.locale. */
const isoDate = v => /^\d{4}-\d\d-\d\d/.test(v) ? new Date(String(v).slice(0, 10) + 'T12:00') : null;
const formats = {
  date: (v, h) => h.date({ date: v }),
  weekday: (v, h) => { const x = isoDate(v); return x ? h.s.days[x.getDay()] : ''; },
  day: v => { const x = isoDate(v); return x ? String(x.getDate()) : ''; },
  month: (v, h) => { const x = isoDate(v); return !x ? '' : h.s.months?.[x.getMonth()] || x.toLocaleDateString(h.s.locale || 'en', { month: 'short' }); },
};

/* ───────────── render ───────────── */
// does a `data-when` / `data-unless` list name this size (by id or by kind)?
const names = (list, a) => words(list).some(w => w === a.fk || w === a.fmt.kind);
const allowed = (el, a) => (!el.dataset.when || names(el.dataset.when, a)) && (!el.dataset.unless || !names(el.dataset.unless, a));

function expand(el, ctx) {
  const { a, d, h, tpl } = ctx;
  if (!allowed(el, a)) return el.remove();
  // an optional part: shown unless the post or frame hides it; `data-part-off` flips the default for this element
  if (el.dataset.part && !h.shown(d, el.dataset.part, !el.hasAttribute('data-part-off') && tpl.partDefault[el.dataset.part] !== false)) return el.remove();
  el.removeAttribute('data-part-off');
  // inside a page, a path is relative to the page; `/x` is the design's own field; the shared kinds the template declares (`event.title`) are absolute too
  const fieldBase = ctx.a.item.fieldBase; // a page of a paged template inside a carousel: the template's own fields (`cover`, `/closing`) are on the page
  const abs = p => fieldBase && ctx.tpl.ownKeys.has(p.replace(/^\//, '').split('.')[0]) ? fieldBase + '.' + p.replace(/^\//, '')
    : ctx.base && !p.startsWith('/') && !ctx.tpl.kinds.includes(p.split('.')[0]) ? ctx.base + '.' + p : p.replace(/^\//, '');
  if (el.dataset.if && !filled(get(d, abs(el.dataset.if)))) return el.remove();
  if (el.dataset.ifNot && filled(get(d, abs(el.dataset.ifNot)))) return el.remove();

  if (el.dataset.each) {
    const path = abs(el.dataset.each), items = (get(d, path) || []).map((v, i) => ({ v, i })).filter(x => filled(x.v));
    const n = items.length, lo = +el.dataset.min || 1, hi = +el.dataset.max || Infinity;
    if (n < lo || n > hi) return el.remove();
    for (const { i } of items) {
      const c = el.cloneNode(true);
      ['each', 'min', 'max'].forEach(k => delete c.dataset[k]);
      el.before(c);
      expand(c, { ...ctx, base: `${path}.${i}` });
    }
    return el.remove();
  }
  for (const k of ['when', 'unless', 'part', 'if', 'ifNot']) delete el.dataset[k];

  if (el.dataset.p) { // image slot: figure.media gets an <img>, an .avatar gets its src or initials
    const path = abs(el.dataset.p), url = get(d, path);
    if (ctx.hidden.includes(path)) return el.remove();
    el.dataset.p = path;
    if (el.matches('.avatar')) {
      if (url) { const img = document.createElement('img'); for (const at of el.attributes) img.setAttribute(at.name, at.value); img.src = url; img.alt = ''; el.replaceWith(img); return; }
      const from = el.dataset.initials && get(d, abs(el.dataset.initials));
      el.dataset.initials = h.initials(from || '');
    } else if (url) el.innerHTML = `<img src="${esc(url)}" alt="">`;
    return;
  }
  if (el.dataset.show) { // a value to show, not a field to edit (a page number, a formatted date)
    // several paths ("role company") are joined with data-join (default a space), skipping empty ones;
    // data-format names a function in Studio.boards.formats and is applied to each value before joining
    const paths = words(el.dataset.show), sep = el.dataset.join, fm = formats[el.dataset.format];
    let vals = paths.map(p => get(d, abs(p))).filter(filled);
    if (fm) vals = vals.map(x => fm(x, h, d));
    delete el.dataset.show; delete el.dataset.format; delete el.dataset.join;
    const v = paths.length > 1 || sep != null ? vals.filter(filled).join(sep ?? ' ') : vals[0];
    if (!filled(v)) return el.remove();
    el.textContent = v; return;
  }
  if (el.dataset.f) {
    const rel = el.dataset.f, path = abs(rel), v = get(d, path);
    if (ctx.hidden.includes(path)) return el.remove();
    el.dataset.f = path;
    // an empty text stays on the canvas as a placeholder to click into; exports and thumbnails drop it
    if (!filled(v)) { el.dataset.ph = ''; el.textContent = sharedLabel(path) || (ctx.base && !rel.startsWith('/') ? tpl.itemLabels[rel] || tpl.labels[rel] : tpl.labels[rel.replace(/^\//, '')]) || rel.split('.').at(-1); return; }
    el.innerHTML = rich(v);
    return;
  }
  [...el.children].forEach(c => expand(c, ctx));
  // a container whose bound children all dropped out goes too (an empty row of chips, an empty stack)
  if (el.dataset.group != null && !el.children.length) el.remove();
}

// the label of a shared field (`event.title`, `event.speakers.0.name`), from the kind's declaration
function sharedLabel(path) {
  const [k, f, i, sub] = path.split('.'), kind = Studio.shared[k]; if (!kind) return '';
  const fld = kind.fields.find(x => x.key === f); if (!fld) return '';
  return sub ? (fld.item || []).find(x => x.key === sub)?.label || sub : fld.label || f;
}
// which source board renders this asset: the page kind (first / each / last), then the layout, then the size
function boardFor(a) {
  const tpl = a.tpl, kind = a.item.page || 'each';
  let pool = tpl.pages ? tpl.boards.filter(x => (x.dataset.page || 'each') === kind) : tpl.boards;
  if (kind === 'each' && tpl.layouts.length) { const want = pool.filter(x => x.dataset.layout === a.item.layout); pool = want.length ? want : pool.filter(x => x.dataset.layout === tpl.layouts[0].id); }
  return a.item.bi != null ? pool[a.item.bi] : pool.find(b => b.dataset.when && names(b.dataset.when, a)) || pool.find(b => !b.dataset.when) || pool[0];
}
// the choices of a part this board allows on this size: data-choices-<key>="id id id@size id@kind"; null = every choice.
// The part's default is always allowed.
function choicesOn(src, a, key) {
  const at = src.getAttribute('data-choices-' + key.toLowerCase()); if (at == null) return null;
  const op = a.tpl.optional.find(o => o.key === key), ids = words(at).filter(t => { const [, x] = t.split('@'); return !x || x === a.fk || x === a.fmt.kind; }).map(t => t.split('@')[0]);
  return op?.default != null ? [...new Set([...ids, op.default])] : ids;
}
const choicesAllowed = (a, key) => choicesOn(boardFor(a), a, key);
function render(a, d, h) {
  const tpl = a.tpl, fmt = a.fmt;
  const hidden = (Studio._.S.overrides[a.id] || {}).__hide || []; // texts and images hidden on this frame ("Hide here")
  const kind = a.item.page || 'each', src = boardFor(a);
  const b = src.cloneNode(true);
  delete b.dataset.when; delete b.dataset.page; delete b.dataset.layout; delete b.dataset.label; delete b.dataset.if;
  // values every template may bind without declaring: the event's date, time and place as written
  d = Object.assign({}, d);
  d.dateLabel ??= h.date(d); d.timeLabel ??= d.time; d.placeLabel ??= h.place(d);
  let base = '';
  if (tpl.pages) { // "/pageNo" and "/pageCount" are there for every page; an item's own fields are relative
    const all = tpl.items(d); d.pageCount = String(all.length); d.pageNo = String(all.findIndex(x => x.key === a.item.key) + 1).padStart(2, '0');
    if (kind === 'each') base = `${tpl.pages}.${a.item.index}`;
  }
  if (!tpl.pages && a.item.base) { // a page of another template inside a carousel: its fields live on that page, and it has a page number like the others
    base = a.item.base; const c = Studio._.templates[a.post.template];
    d.pageCount = String((a.post.fields[c.pagesOwn] || []).length); d.pageNo = String(a.item.slideIndex + 1).padStart(2, '0');
  }
  [...b.children].forEach(c => expand(c, { a, d, h, tpl, base, hidden }));

  b.classList.add('asset', 'k-' + fmt.kind);
  b.dataset.size = a.fk; b.dataset.kind = fmt.kind; // for onSettle hooks
  // the pick of each part with choices, as data-opt-<key> (the frame's, else the design's, else the default)
  // a pick this board does not allow on this size falls back to the part's default
  for (const op of tpl.optional) if (op.choices) { const ok = choicesOn(src, a, op.key), v = d.show?.[op.key]; b.setAttribute('data-opt-' + op.key, v && (!ok || ok.includes(v)) ? v : op.default); }
  b.dataset.id = a.id; b.dataset.name = a.name; b.dataset.title = a.name; b.dataset.pick = '0';
  // the look: this size's own choice, else the post's, else what the template wrote
  const look = d.__bd && d.__bd !== 'auto' ? d.__bd : d.__slideLook || a.post.look;
  b.dataset.bd = look || 'auto';
  if (look) b.dataset.ground = look;
  if (fmt.medium) b.dataset.medium = fmt.medium;
  else { b.dataset.medium = 'custom'; b.dataset.like = fmt.like || 'social-portrait'; b.dataset.w = fmt.w; b.dataset.h = fmt.h; }
  if (fmt.safe) b.dataset.safe = fmt.safe.join(' ');
  return b.outerHTML;
}

/* hooks run inside settle(): onSettle(fn, { when: 'before' | 'after' }), default 'after'.
   'before' runs after the runtime has decorated the board (so data-g and the logo are set) and before it
   measures overflow: insert a backdrop element here. 'after' runs once layout is final (after steps and
   drops): measure, wrap text, draw. fn(node, info), info = { size: {id, kind, w, h}, ground, exporting, thumb }.
   A board is rendered from scratch each time, but settle can run again on the same node (a resize), so
   a hook that inserts something should check for its own element first. */
const hooks = { before: [], after: [] };
function onSettle(fn, opts = {}) { hooks[opts.when === 'before' ? 'before' : 'after'].push(fn); }
function runHooks(when, node, info) {
  for (const fn of hooks[when]) try { fn(node, info); } catch (e) { console.error('[studio] onSettle hook failed', e); }
}

/* lay the board out with the makeitbrand runtime, then report whether everything fits */
function settle(node) {
  const mib = window.makeitbrand;
  if (!mib || !mib.decorate) { console.warn('[studio] makeitbrand runtime not loaded in host mode'); return true; }
  // an image slot nobody filled shows in the editor (as a place to drop a photo) but never exports
  const out = node.closest('[data-export]'), thumb = node.closest('.tplc-pv');
  if (out) node.querySelectorAll('figure.media[data-p]').forEach(m => { if (!m.querySelector('img')) m.remove(); });
  if (out || thumb) { // placeholders for empty texts are an editor affordance only
    node.querySelectorAll('[data-ph]').forEach(e => e.remove());
    [...node.querySelectorAll('[data-group]')].reverse().forEach(g => { if (!g.children.length) g.remove(); });
  }
  mib.decorate(node);
  const bs = node.getBoundingClientRect(), num = n => parseFloat(getComputedStyle(node).getPropertyValue(n));
  const info = { size: { id: node.dataset.size, kind: node.dataset.kind, w: num('--board-w') || node.offsetWidth || bs.width, h: num('--board-h') || node.offsetHeight || bs.height },
    ground: node.getAttribute('data-g'), exporting: !!out, thumb: !!thumb };
  if (node.dataset.safe) ['t', 'r', 'b', 'l'].forEach((s, i) => node.style.setProperty('--safe-' + s, node.dataset.safe.split(' ')[i] + 'px'));
  // check() measures on screen, so it needs the zoom the canvas currently shows the board at
  const r = node.getBoundingClientRect();
  if (r.width) node.dataset.mibScale = r.width / node.offsetWidth;
  runHooks('before', node, info);
  mib.check(node);
  // too much for this size: first step headings down the type scale (data-steps="display h1 h2"),
  // one step at a time, so type stays on the brand's scale instead of shrinking freely
  const steppers = [...node.querySelectorAll('[data-steps]')], most = Math.max(0, ...steppers.map(e => words(e.dataset.steps).length));
  for (let i = 1; i < most && node.hasAttribute('data-overflow'); i++) {
    steppers.forEach(e => { const st = words(e.dataset.steps); e.classList.remove(...st); e.classList.add(st[Math.min(i, st.length - 1)]); e.dataset.stepped = i; });
    mib.check(node);
  }
  // still too much: give up the parts the template marked as droppable, lowest level first
  // (data-drop="1" goes before "2"), instead of shrinking type or clipping
  const levels = [...new Set([...node.querySelectorAll('[data-drop]')].map(e => +e.dataset.drop))].sort((x, y) => x - y);
  for (const lv of levels) {
    if (!node.hasAttribute('data-overflow')) break;
    node.querySelectorAll(`[data-drop="${lv}"]`).forEach(e => { e.style.display = 'none'; e.dataset.dropped = ''; });
    mib.check(node);
  }
  runHooks('after', node, info);
  return !node.hasAttribute('data-overflow');
}

/* ───────────── brand ─────────────
   The makeitbrand brand stylesheet on the page is the brand. Studio's editor still wants a brand
   object (name, theme list, background list), so build one from the tokens. */
function groundBg(id) { // the --bg a brand ground sets, read off a throwaway board
  const t = document.createElement('div'); t.className = 'board'; t.dataset.ground = id;
  t.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'; document.body.appendChild(t);
  const c = getComputedStyle(t).getPropertyValue('--bg').trim(); t.remove(); return c || 'var(--bg)';
}
// the file a url() token of the brand stylesheet points at. A relative url in a custom property is relative to the stylesheet
// that declares it, which getComputedStyle does not say, so find that sheet (the runtime does the same for a board's logo)
function tokenUrl(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim(), m = /^url\(\s*(['"]?)(.*?)\1\s*\)$/.exec(raw);
  if (!m) return '';
  if (m[2].startsWith('data:')) return m[2];
  let base = location.href;
  const walk = (rules, href) => { for (const r of rules) { if (r.style?.getPropertyValue(name).trim() === raw) { base = href; return true; } if (r.cssRules?.length && walk(r.cssRules, href)) return true; } };
  for (const s of document.styleSheets) { try { if (walk(s.cssRules, s.href || location.href)) break; } catch { /* a cross-origin sheet */ } }
  return new URL(m[2], base).href;
}
function brandFromTokens(opts = {}) {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  return {
    id: opts.id || 'brand', name: opts.name || 'Brand', studioName: opts.studioName || '', url: opts.url || '', series: opts.series || '',
    fonts: { head: v('--font-display') || 'system-ui', body: v('--font-body') || 'system-ui', css: null },
    defaultTheme: 'default',
    themes: { default: { label: 'Default', bg: v('--bg'), fg: v('--fg'), accent: v('--accent'), chip: v('--surface'), dot: v('--accent') } },
    logo: { viewBox: '0 0 1 1', svg: '', url: tokenUrl('--logo-dark') || tokenUrl('--logo-full-dark') }, // the editor's header is light: the variant for light grounds
    strings: Object.assign({ days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] }, opts.strings),
    // a board's background is its makeitbrand ground
    // opts.grounds: { id: { label, swatch? } }, grounds the brand stylesheet defines as token overrides under
    // .board[data-ground="id"] { --bg: …; --fg: …; --bg-tone: dark|light }. Without a swatch, read its --bg.
    // opts.stockGrounds: which of the stock grounds (bg, surface, accent, inverse, art) to offer; default all.
    // opts.groundLabels renames them ({ bg: 'Dark' }). A brand whose own grounds replace the stock ones lists none or one.
    backdrops: Object.assign({ auto: { label: 'Template default' } },
      Object.fromEntries(Object.entries(Object.assign({ bg: { label: 'Background', swatch: 'var(--bg)' }, surface: { label: 'Surface', swatch: 'var(--surface)' },
        accent: { label: 'Accent', swatch: 'var(--accent)' }, inverse: { label: 'Inverse', swatch: 'var(--fg)' } },
        v('--art') ? { art: { label: 'Art', swatch: 'var(--art)' } } : {})).filter(([k]) => !opts.stockGrounds || opts.stockGrounds.includes(k))
        .map(([k, g]) => [k, { ...g, label: (opts.groundLabels || {})[k] || g.label }])),
      Object.fromEntries(Object.entries(opts.grounds || {}).map(([id, g]) => [id, { label: g.label || id, swatch: g.swatch || groundBg(id) }]))),
    backdrop: () => ({ svg: '', layers: {} }),
  };
}

/* ───────────── loading ───────────── */
function register(src) { const t = compile(src); Studio.registerTemplate(t); return t; }
/* Files the page reads by fetch (templates, shared kinds). Their text is kept, and "Save sheet" writes it into the file
   (<script id="studio-files">), so a saved sheet opens from anywhere, with no server next to it. */
let files = null;
async function readFile(url, what) {
  if (!files) { files = {}; try { Object.assign(files, JSON.parse(document.getElementById('studio-files')?.textContent || '{}')); } catch (e) { console.warn(e); } }
  if (files[url] != null) return files[url];
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${what} ${url} (${res.status})`);
  return files[url] = await res.text();
}
async function load(urls) { for (const url of urls) register(await readFile(url, 'template')); }
// templates already in the page (a self-contained sheet inlines them as <template> elements)
async function loadShared(urls) {
  for (const url of urls) Studio.registerShared(JSON.parse(await readFile(url, 'shared content')));
}
function registerInline() { document.querySelectorAll('template[data-template]').forEach(t => { if (!Studio.templates[t.dataset.template]) register(t); }); }

Studio.boards = { get files() { return files || {}; }, compile, register, registerInline, load, loadShared, sharedLabel, render, boardFor, allowed: choicesAllowed, settle, brandFromTokens, formats, choices, onSettle, newId };
})();
