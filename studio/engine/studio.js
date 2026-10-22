/* Studio engine — brand-agnostic. Brands and templates register themselves; the engine owns state,
   rendering, canvas editing, export and the data bridge (JSON, #d= links, embedded sheets). */
(function () {
'use strict';

/* ═════════════ Registry ═════════════ */
const brands = {}, templates = {}, order = [], kinds = {};
const Studio = window.Studio = {
  brands, templates, shared: kinds,
  registerBrand(b) { brands[b.id] = b; },
  /* Shared content: a fork declares a kind (an event, a product, a team) with the same field format
     templates use. A project holds one or more items of each kind (S.shared[key] is a list: two events,
     three products); a design names the item it reads (post.uses[key]) and every template that lists the
     kind under "uses" binds to it as `key.field`. */
  registerShared(def) { kinds[def.key] = Object.assign({ label: def.key, fields: [] }, def); },
  registerTemplate(t) { templates[t.id] = t; order.push(t.id); },
  pts: a => a.map(p => p.map(v => (+v).toFixed(1)).join(',')).join(' '),
};

/* Formats: add a line here to support a new size everywhere. kind picks the type scale + motif geometry. */
const FORMATS = Studio.formats = {
  'ig-post':   { label: 'Feed 4:5',        short: 'Feed',      hint: 'Instagram, LinkedIn, Facebook', w: 1080, h: 1350, kind: 'portrait',  medium: 'social-portrait' },
  'ig-square': { label: 'Square 1:1',      short: 'Square',    hint: 'Instagram, LinkedIn',           w: 1080, h: 1080, kind: 'square',    medium: 'social-square' },
  'ig-story':  { label: 'Story 9:16',      short: 'Story',     hint: 'Instagram, Facebook stories',   w: 1080, h: 1920, kind: 'story',     like: 'social-portrait', safe: [170, 96, 250, 96] },
  'linkedin':  { label: 'Landscape',       short: 'Landscape', hint: 'LinkedIn link post, Facebook',  w: 1200, h: 627,  kind: 'landscape', like: 'social-landscape' },
  'meetup':    { label: 'Meetup cover',    short: 'Meetup',    hint: 'Meetup event page 16:9',        w: 1200, h: 675,  kind: 'landscape', like: 'social-landscape' },
  'carousel':  { label: 'Carousel 4:5',    short: 'Carousel',  hint: 'Instagram slides + LinkedIn PDF', w: 1080, h: 1350, kind: 'portrait', fixed: true, medium: 'carousel' },
};
/* `medium` is the makeitbrand medium profile a board renders with at this size; a size without an
   exact profile renders as a `custom` board that borrows `like` (and `safe`, when its safe area differs). */
const SCALE = {
  portrait:  { u: 1.25, pad: 100, title: 118, desc: 32, meta: 26, photo: 164, photoS: 118, spName: 26, spRole: 21, textW: '86%', spkW: '84%', gap1: 46, lines: 4 },
  square:    { u: 1.15, pad: 88, title: 100, desc: 29, meta: 24, photo: 140, photoS: 104, spName: 24, spRole: 19, textW: '84%', spkW: '84%', gap1: 34, lines: 3 },
  story:     { u: 1.25, pad: 96, title: 132, desc: 36, meta: 28, photo: 160, photoS: 130, spName: 28, spRole: 22, textW: '88%', spkW: '84%', gap1: 56, lines: 5, safeTop: 170, safeBottom: 250 },
  landscape: { u: 1,    pad: 60, title: 66,  desc: 21, meta: 18, photo: 86,  photoS: 74,  spName: 17, spRole: 14, textW: '58%', spkW: '62%', gap1: 22, lines: 2 },
};

/* ═════════════ Utils ═════════════ */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const text = s => esc(s).replace(/\n/g, '<br>');
const rich = s => text(s).replace(/\*([^*\n]+)\*/g, '<em class="hl">$1</em>');
const initials = n => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const slug = s => (s || 'asset').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const clone = o => JSON.parse(JSON.stringify(o));
const getPath = (o, p) => p.split('.').reduce((a, k) => a == null ? a : a[k], o);
function setPath(o, p, v) { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach((k, i) => { if (a[k] == null) a[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; a = a[k]; }); a[ks.at(-1)] = v; }
const b64enc = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } } };
let toastT; function toast(m) { const t = $('#toast'); if (!t) return; t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2000); }
function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
function readImage(file, max = 1400) {
  return new Promise(ok => { const r = new FileReader(); r.onload = () => { const img = new Image(); img.onload = () => {
    const sc = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    ok(c.toDataURL('image/jpeg', .88)); }; img.src = r.result; }; r.readAsDataURL(file); });
}

/* ═════════════ State ═════════════ */
const BASE = {
  name: '', theme: null, templates: [], formats: ['ig-post', 'ig-story', 'linkedin', 'meetup'],
  series: '', title: '', description: '', date: '', time: '', venue: '', city: '', cta: '',
  speakers: [], agenda: [], photos: [], slides: [], posts: null, overrides: {},
};
let S, B, T; // state, brand, active theme tokens
// autosave key: the page's path, the same for /studio/ and /studio/index.html (an older key is read once, see loadInitial)
const KEY = 'studio:' + location.pathname.replace(/index\.html$/, ''), OLD_KEY = 'studio:' + location.pathname;
/* Saved or not: autosave keeps work in this browser only; the file ("Save") is the real save. `unsaved` is true from the first change
   after a save (or after opening a file) until the next save, and travels with the autosave so a reload still knows. */
let unsaved = false;

// every item of a list that can be paged over or linked to gets a permanent id (see boards.newId); items that have one keep it
function giveIds(list) { if (!Array.isArray(list)) return; const used = new Set(list.map(x => x && x.id).filter(Boolean)); for (const x of list) if (x && typeof x === 'object' && !x.id) x.id = Studio.boards.newId(used); }
/* After a list's items moved or were removed (a speaker, a slide): the settings of every frame are keyed by item id and stay put, but
   index paths inside them (`event.speakers.2.photo` crops, "Hide here" lists, texts for one size) point at positions, so rewrite them
   by id. `path` is the list's path, `before` its ids before the change. With `post`, the list is that design's own (only its frames
   are touched); without, it is shared content (every frame may read it) and frames of designs paged over it lose the removed items. */
function afterListChange(path, before, list, post, item) {
  const users = item ? new Set(S.posts.filter(p => sharedItem(p, path.split('.')[0]) === item).map(p => p.id)) : null; // only designs that read this item
  const map = new Map(before.map((id, oi) => [oi, list.findIndex(x => x.id === id)]));
  const gone = before.filter(id => !list.some(x => x.id === id));
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), re = new RegExp(`^(pos:)?${esc}\\.(\\d+)\\.`);
  const move = s => { const m = typeof s === 'string' && s.match(re); if (!m) return s; const ni = map.get(+m[2]); return ni == null ? s : ni < 0 ? null : s.replace(re, `${m[1] || ''}${path}.${ni}.`); };
  const paged = new Set(S.posts.filter(p => templates[p.template]?.pages === path).map(p => p.id));
  for (const k of Object.keys(S.overrides)) {
    const pid = k.slice(0, k.indexOf('.'));
    if (post ? !k.startsWith(post.id + '.') : users && !users.has(pid)) continue;
    if (((post ? post.id === pid : paged.has(pid)) || gone.some(id => k.includes(`~s-${id}.`))) && gone.some(id => k.includes(`.s-${id}.`) || k.includes(`.s-${id}~`) || k.includes(`~s-${id}.`))) { delete S.overrides[k]; continue; }
    const o = S.overrides[k], renames = [];
    for (const key of Object.keys(o)) { const to = move(key); if (to !== key) renames.push([key, to]); }
    const vals = renames.map(([key, to]) => [to, o[key]]); renames.forEach(([key]) => delete o[key]);
    vals.forEach(([to, v]) => { if (to) o[to] = v; });
    if (Array.isArray(o.__hide)) o.__hide = o.__hide.map(move).filter(Boolean);
  }
}
function normalize(d) {
  const s = Object.assign(clone(BASE), d || {});
  s.speakers = (s.speakers || []).map(x => Object.assign({ name: '', role: '', company: '', photo: '' }, x));
  s.agenda = (s.agenda || []).map(x => Object.assign({ time: '', label: '' }, x));
  s.photos = (s.photos || []).filter(x => typeof x === 'string');
  s.slides = (s.slides || []).map(x => Object.assign({ type: 'text', title: '', body: '', photo: '', items: [], stats: [] }, x));
  s.overrides = s.overrides || {}; delete s.__unsaved;
  s.shared = s.shared || {};
  for (const k of Object.values(kinds)) { // every declared kind has at least one item, and every item its fields, so bindings and editors never meet a hole
    let a = s.shared[k.key];
    if (!Array.isArray(a)) a = s.shared[k.key] = [a && typeof a === 'object' ? a : {}]; // a file from before items: its one value is the first item
    if (!a.length) a.push({});
    giveIds(a);
    a.forEach(v => fillItem(k, v));
  }
  giveIds(s.speakers); giveIds(s.agenda); // the older root lists
  s.brand = brands[s.brand] ? s.brand : Object.keys(brands)[0];
  s.templates = s.templates.filter(t => templates[t]);
  s.formats = s.formats.filter(f => FORMATS[f] && !FORMATS[f].fixed);
  if (!brands[s.brand].themes[s.theme]) s.theme = brands[s.brand].defaultTheme;
  // Posts: the campaign. Each post = one template + its own sizes + its own copy (fields).
  // Older sets (templates × formats) migrate to one post per template, keeping asset ids stable.
  if (!Array.isArray(s.posts)) s.posts = s.templates.map(tid => {
    const t = templates[tid], p = { id: tid, template: tid, formats: allowedFormats(t, s.formats), fields: {} };
    for (const f of t.fields || []) if (s[f.key] != null) p.fields[f.key] = s[f.key];
    if ((t.needs || []).includes('slides')) p.fields.slides = s.slides;
    return p;
  });
  s.posts = s.posts.filter(p => templates[p.template]).map(p => fillPost(p, s));
  for (const p of s.posts) { p.uses = p.uses || {}; for (const k in kinds) if (!s.shared[k].some(x => x.id === p.uses[k])) p.uses[k] = sharedItem(p, k, s).id; } // every design names its item
  s.templates = [...new Set(s.posts.map(p => p.template))];
  return s;
}
/* Shared content: the items of a kind, and the one a design reads. A design without a valid pick (a new one, a library
   thumbnail) reads the item in focus: the one last opened in the editor, else the first. */
const focus = {};
function fillItem(k, v) {
  for (const f of k.fields) if (v[f.key] == null) v[f.key] = f.type === 'list' ? clone(f.default || []) : (f.default ?? '');
  for (const f of k.fields) if (f.type === 'list') giveIds(v[f.key]);
  return v;
}
function sharedItem(p, kind, s = S) { const a = s.shared[kind] || []; return a.find(x => x.id === p?.uses?.[kind]) || a.find(x => x.id === focus[kind]) || a[0]; }
function sharedFor(p, s = S) { const o = {}; for (const k in kinds) o[k] = sharedItem(p, k, s); return o; }
function setFocus(kind, id) { focus[kind] = id; }
// what an item is called in lists: its title or name (or the field the kind names as "title"), else "Event 2"
function itemLabel(kind, v) {
  const k = kinds[kind], f = k.title || ['title', 'name'].find(x => k.fields.some(y => y.key === x)) || k.fields[0]?.key;
  return String(v?.[f] || '').replace(/\*/g, '').trim() || `${k.label} ${S.shared[kind].indexOf(v) + 1}`;
}
const itemDate = (kind, v) => { const f = kinds[kind].fields.find(f => f.type === 'date'); return f && /^\d{4}-\d\d-\d\d/.test(v?.[f.key] || '') ? v[f.key].slice(0, 10) : ''; };
const usersOf = (kind, v) => S.posts.filter(p => kindsOf(p).includes(kind) && sharedItem(p, kind) === v);
// a new item; with `from`, a copy of that item, and with `designs` also a copy of every design that reads it (next month's event from this month's)
function newItem(kind, from, designs) {
  const a = S.shared[kind], v = fillItem(kinds[kind], from ? clone(from) : {});
  v.id = Studio.boards.newId(new Set(a.map(x => x.id)));
  if (from && designs) for (const p of usersOf(kind, from)) {
    const c = clone(p); c.id = 'p' + Math.random().toString(36).slice(2, 7); c.uses = { ...c.uses, [kind]: v.id };
    for (const k of Object.keys(S.overrides)) if (k.startsWith(p.id + '.')) S.overrides[c.id + k.slice(p.id.length)] = clone(S.overrides[k]);
    S.posts.push(c);
  }
  a.push(v); focus[kind] = v.id;
  return v;
}
// remove an item and the designs that read it; the last item of a kind stays
function removeItem(kind, id) {
  const a = S.shared[kind], v = a.find(x => x.id === id); if (!v || a.length < 2) return false;
  for (const p of usersOf(kind, v)) { S.posts.splice(S.posts.indexOf(p), 1); for (const k of Object.keys(S.overrides)) if (k.startsWith(p.id + '.')) delete S.overrides[k]; }
  a.splice(a.indexOf(v), 1); if (focus[kind] === id) delete focus[kind];
  for (const p of S.posts) if (p.uses?.[kind] === id) p.uses[kind] = a[0].id; // designs that do not read the kind just point at one that exists
  return true;
}
// point a design at another item. What one size said about the old item (a text for this size, a crop, a hidden text, a frame per speaker) goes
function setUse(p, kind, id) {
  if (!S.shared[kind].some(x => x.id === id) || p.uses?.[kind] === id) return;
  (p.uses ||= {})[kind] = id;
  const re = new RegExp(`^(pos:)?${kind}\\.`);
  for (const k of Object.keys(S.overrides)) {
    if (!k.startsWith(p.id + '.')) continue;
    if (k.includes('~s-')) { delete S.overrides[k]; continue; }
    const o = S.overrides[k];
    for (const f of Object.keys(o)) if (re.test(f)) delete o[f];
    if (Array.isArray(o.__hide)) o.__hide = o.__hide.filter(x => !re.test(x));
  }
}
// sizes a template can use: fixed (carousels) or the ones it supports
function allowedFormats(t, wanted) {
  if (t.formats) return t.formats.slice();
  const ok = Object.keys(FORMATS).filter(f => t.supports ? t.supports.includes(f) : !FORMATS[f].fixed);
  return wanted === undefined ? ok : (wanted || []).filter(f => ok.includes(f));
}
function fillPost(p, s) {
  let t = templates[p.template]; const b = brands[s.brand];
  p = Object.assign({ id: 'p' + Math.random().toString(36).slice(2, 7), name: '', formats: null, fields: {} }, p);
  const cont = containerTpl(); if (cont && t !== cont && t.slide && p.id !== '__preview') { p = wrapLegacy(p, s, t, cont); t = cont; }
  if (!p.formats || !p.formats.length) p.formats = allowedFormats(t, t.channels);
  p.formats = t.formats ? t.formats.slice() : p.formats.filter(f => allowedFormats(t).includes(f));
  if (t.coverPhoto !== false && p.fields.coverPhoto == null) p.fields.coverPhoto = '';
  for (const k of t.slots || []) if (p.fields[k] == null) p.fields[k] = ''; // a markup template's own image fields
  for (const l of t.lists || []) if (!Array.isArray(p.fields[l.key])) p.fields[l.key] = clone(l.default);
  for (const f of t.fields || []) if (p.fields[f.key] == null) p.fields[f.key] = typeof f.default === 'function' ? f.default(s, b) : (f.default ?? '');
  // every item of the design's own paged list (a slide) has a permanent id, and its frame's settings are keyed by it, so they
  // stay with the slide when it moves. Files from before ids are migrated here: `<post>.s2.<size>` becomes `<post>.s-<id>.<size>`.
  // a page's own pick of a slide-scoped part used to be `graphic` on the page; it is now any part's value in `show`
  if (t.pagesOwn) for (const x of p.fields[t.pagesOwn] || []) if (x && x.graphic) { (x.show ||= {}).graphic ??= x.graphic; delete x.graphic; }
  if (t.pages) {
    const list = (t.pagesOwn ? p.fields[t.pagesOwn] : kinds[t.pages.split('.')[0]] ? getPath(sharedFor(p, s), t.pages) : getPath(s, t.pages)) || [], used = new Set(list.map(x => x && x.id).filter(Boolean));
    list.forEach((x, i) => {
      if (!x || typeof x !== 'object') return;
      if (!x.id) x.id = Studio.boards.newId(used);
      for (const k of Object.keys(s.overrides || {})) if (k.startsWith(`${p.id}.s${i}.`)) { s.overrides[`${p.id}.s-${x.id}.${k.slice(p.id.length + 2 + String(i).length + 1)}`] = s.overrides[k]; delete s.overrides[k]; }
    });
  }
  if ((t.needs || []).includes('slides')) p.fields.slides = (p.fields.slides || []).map(x => Object.assign({ type: 'text', title: '', body: '', photo: '', items: [], stats: [] }, x));
  return p;
}
// Every design is a list of pages. The container template (data-container) holds the list; a page is of any template that is data-slide.
const containerTpl = () => Object.values(templates).find(t => t.container && t.pagesOwn) || null;
// a page of template `t`: its id, its fields at their starter content, its first layout
function makeSlide(c, t) {
  const item = { id: Studio.boards.newId() };
  if (t !== c) item.template = t.id;
  for (const f of c.lists.find(l => l.key === c.pagesOwn).item) if (t === c) item[f.key] = '';
  for (const f of t.fields || []) item[f.key] = typeof f.default === 'function' ? f.default(S, brands[S.brand]) : (f.default ?? '');
  for (const k of t.slots || []) item[k] = '';
  if (t.layouts.length) item.layout = t.layouts[0].id;
  return Object.assign(item, t.starter ? clone(t.starter) : {});
}
function newPost(tid) { const p = makePost(tid); p.uses = Object.fromEntries(Object.keys(kinds).map(k => [k, sharedItem(null, k).id])); return p; } // a new design reads the item in focus
function makePost(tid) {
  const t = templates[tid], c = containerTpl();
  if (c && t.slide && t !== c) return fillPost({ template: c.id, name: t.label, formats: (f => f.length ? f : allowedFormats(c).slice(0, 1))(allowedFormats(c, t.channels).filter(f => allowedFormats(t).includes(f))), fields: { [c.pagesOwn]: [makeSlide(c, t)] } }, S);
  return fillPost({ template: tid, name: t.label, fields: t.starter ? clone(t.starter) : {} }, S);
}
// a design saved as one template (an Event, a Speaker design) becomes a design of one page of that template
function wrapLegacy(p, s, t, c) {
  const { caption, show, ...own } = p.fields || {}, slide = { id: Studio.boards.newId(), template: t.id, ...own };
  const designKeys = new Set((t.optional || []).filter(o => o.scope === 'design').map(o => o.key)), keep = {};
  if (show) for (const [k, v] of Object.entries(show)) { if (designKeys.has(k)) keep[k] = v; else (slide.show ||= {})[k] = v; } // texture and the like stay on the design
  if (t.layouts.length && !slide.layout) slide.layout = t.layouts[0].id;
  const sharedList = t.pages && !t.pagesOwn ? (t.pages.split('.')[0] in kinds ? getPath(sharedFor(p, s), t.pages) : getPath(s, t.pages)) || [] : [];
  const ownRoot = k => (t.ownKeys && t.ownKeys.has(k.replace(/^pos:/, '').split('.')[0])) || k.replace(/^pos:/, '').split('.')[0] in own;
  const to = k => ownRoot(k) ? k.replace(/^(pos:)?/, (m, pos) => (pos || '') + `${c.pagesOwn}.0.`) : k;
  for (const k of Object.keys(s.overrides || {})) { // frames: `<post>.<key>.<size>` becomes `<post>.s-<page id>[~<key>].<size>`
    if (!k.startsWith(p.id + '.')) continue;
    const rest = k.slice(p.id.length + 1), i = rest.lastIndexOf('.'); let key = rest.slice(0, i);
    const m = key.match(/^s(\d+)$/); if (m && sharedList[+m[1]]?.id) key = `s-${sharedList[+m[1]].id}`; // an older file: pages over a shared list were keyed by position
    const o = s.overrides[k];
    for (const f of Object.keys(o)) if (f !== to(f) && !f.startsWith('__')) { o[to(f)] = o[f]; delete o[f]; } // paths of the page's own fields now go through the page
    if (Array.isArray(o.__hide)) o.__hide = o.__hide.map(to);
    s.overrides[`${p.id}.s-${slide.id}${key === 'main' ? '' : '~' + key}.${rest.slice(i + 1)}`] = o; delete s.overrides[k];
  }
  return { ...p, template: c.id, fields: { ...(caption != null ? { caption } : {}), ...(Object.keys(keep).length ? { show: keep } : {}), ...(own.kicker != null ? { kicker: own.kicker } : {}), [c.pagesOwn]: [slide] } };
}
// Shared content (an event, a speaker list…) exists only when a registered template reads it.
// Upstream's own templates don't; a fork's do.
function sharedKinds() {
  const ts = order.map(id => templates[id]), needs = new Set(ts.flatMap(t => t.needs || []));
  return { details: ts.some(t => (t.uses || []).length || t.facts), speakers: needs.has('speakers'), agenda: needs.has('agenda'), photos: needs.has('photos'),
    declared: Object.keys(kinds).filter(k => ts.some(t => (t.kinds || []).includes(k))) };
}
const hasShared = () => { const k = sharedKinds(); return k.details || k.speakers || k.agenda || k.photos || k.declared.length > 0; };
// switch a post to another template: texts and images with the same field name carry over
function changeTemplate(postId, tid) {
  const p = S.posts.find(x => x.id === postId), from = templates[p.template], to = templates[tid]; if (!to || to === from) return;
  const keep = new Set([...(to.fields || []).map(f => f.key), ...(to.slots || []), ...(to.lists || []).map(l => l.key), 'caption']);
  const fields = Object.fromEntries(Object.entries(p.fields).filter(([k, v]) => keep.has(k) && v !== '' && !(Array.isArray(v) && !v.length)));
  if (!p.name || p.name === from.label) p.name = to.label;
  p.template = tid; p.fields = fields;
  const sizes = p.formats.filter(f => allowedFormats(to).includes(f));
  p.formats = sizes.length ? sizes : null;
  Object.assign(p, fillPost(p, S));
  for (const k in S.overrides) if (k.startsWith(p.id + '.')) delete S.overrides[k];
}
// one template at one size with its starter content, for the library's thumbnails
function previewAsset(tid, fk) {
  const t = templates[tid], p = fillPost({ id: '__preview', template: tid, name: t.label, fields: clone({ ...(t.starter || {}), ...(t.manifest?.preview || {}) }) }, S); // "preview" in the manifest: content for the thumbnail only
  fk = p.formats.includes(fk) ? fk : p.formats[0];
  S.posts.push(p);
  try {
    const d = postData(p), it = (t.items ? t.items(d, B) : [{ key: 'main' }])[0] || { key: 'main' };
    const a = { id: `${p.id}.${it.key}.${fk}`, tpl: t, post: p, item: it, fk, fmt: FORMATS[fk], name: 'preview' };
    return { a, html: renderAsset(a) };
  } finally { S.posts.pop(); }
}
const projSlug = () => slug(S.name || S.series || B.name);
function postOf(id) { const pid = id.split('.')[0]; return S.posts.find(p => p.id === pid); }
// shared event content + this post's own copy (no per-image overrides)
function postData(p) {
  const d = clone(S); Object.assign(d, clone(p.fields || {})); Object.assign(d, sharedFor(p, d)); d.__post = p.id;
  // a library thumbnail of a template that reads shared content nobody wrote yet shows the kind's sample ("sample" in its declaration)
  if (p.id === '__preview') for (const k in kinds) if (kinds[k].sample && !kinds[k].fields.some(f => (d[k][f.key] || '').length)) d[k] = fillItem(kinds[k], clone(kinds[k].sample));
  return d;
}
// write content where it lives: a post's own field, or the shared event
function setContent(postId, path, v) {
  const p = S.posts.find(x => x.id === postId), root = path.split('.')[0];
  if (kinds[root]) return setPath(sharedFor(p), path, v); // shared content: one value for every design that reads this item
  if (p && p.fields && root in p.fields) setPath(p.fields, path, v); else setPath(S, path, v);
}
function getContent(postId, path) { const p = S.posts.find(x => x.id === postId); return kinds[path.split('.')[0]] ? getPath(sharedFor(p), path) : p ? getPath(postData(p), path) : getPath(S, path); }
function embedded() { try { const el = $('#studio-data'); const t = el && el.textContent.trim(); return t && t !== '{}' ? JSON.parse(t) : null; } catch (e) { console.warn(e); return null; } }
function loadInitial() {
  const m = location.hash.match(/#d=([^&]+)/);
  if (m) { try { return normalize(JSON.parse(b64dec(m[1]))); } catch (e) { console.warn('Bad #d payload', e); } }
  const emb = embedded(), saved = store.get(KEY) || (OLD_KEY !== KEY ? store.get(OLD_KEY) : null);
  if (saved && (!emb || saved.__rev === emb.__rev)) { unsaved = !!saved.__unsaved; return normalize(saved); }
  if (emb) return normalize(emb);
  // a new project starts empty; ?example loads the example set when the page ships one
  return normalize(/[?&]example\b/.test(location.search) && window.STUDIO_EXAMPLE || {});
}
function persist() { const ok = store.set(KEY, { ...S, __rev: embedded()?.__rev, __unsaved: unsaved }); if (!ok) console.warn('Autosave skipped (storage full or blocked)'); }
function setUnsaved(v) { unsaved = v; persist(); Studio.ui?.saveState?.(); }
// open a project from a file: a saved sheet (.html, its project is in #studio-data) or the project's JSON
async function openFile(file) {
  const t = await file.text(); let d;
  if (/^\s*[{[]/.test(t)) d = JSON.parse(t);
  else { const el = new DOMParser().parseFromString(t, 'text/html').querySelector('#studio-data'); if (!el || !el.textContent.trim() || el.textContent.trim() === '{}') throw new Error('No project in this file'); d = JSON.parse(el.textContent); }
  delete d.__rev; delete d.__unsaved;
  S = normalize(d); unsaved = false; return S;
}

/* per-asset data: global state + that asset's overrides */
// the item of the design's own list that a frame id (`<post>.s-<item id>.<size>`) shows
function pageItem(id) {
  const m = id.match(/^(.*)\.s-([^.~]+)(?:~[^.]*)?\.[^.]+$/), p = m && S.posts.find(x => x.id === m[1]), t = p && templates[p.template];
  return t && t.pagesOwn ? (p.fields[t.pagesOwn] || []).find(x => x.id === m[2]) : null;
}
function assetData(id) {
  const p = postOf(id), d = p ? postData(p) : clone(S), ov = S.overrides[id] || {};
  d.__pos = {};
  for (const [k, v] of Object.entries(ov)) {
    if (k.startsWith('__')) continue;
    if (k.startsWith('pos:')) d.__pos[k.slice(4)] = v; else setPath(d, k, v);
  }
  // a page of a paged design has its own look and graphic (saved on the page, all sizes): design < page < this size
  const it = pageItem(id); let slide = {};
  if (it) { if (it.ground) d.__slideLook = it.ground; slide = { ...(it.show || {}) }; }
  // optional parts: post default (fields.show) < this page < this frame (__show)
  d.show = { ...(d.show || {}), ...slide, ...(ov.__show || {}) };
  return d;
}

/* ═════════════ Template helpers (passed as `h`) ═════════════ */
function helpers(fmt) {
  const t = B.strings;
  const h = {
    esc, text, rich, initials, slug, brand: B, s: t, fmt, kind: fmt.kind,
    date(d) { if (!d.date) return ''; const x = new Date(d.date + 'T12:00'); return `${t.days[x.getDay()]} ${x.getDate()}. ${x.getMonth() + 1}.`; },
    dayMonth(d) { if (!d.date) return ''; const x = new Date(d.date + 'T12:00'); return `${x.getDate()}. ${x.getMonth() + 1}.`; },
    weekday(d) { if (!d.date) return ''; return t.days[new Date(d.date + 'T12:00').getDay()]; },
    place: d => [d.venue, d.city].filter(Boolean).join(', '),
    // is an optional part shown? explicit choice (post or frame) wins, else the template's default
    shown: (d, key, def = true) => d.show && d.show[key] != null ? !!d.show[key] : def,
    // join inline parts with a thin vertical divider (brand rule: never a middle dot)
    parts: a => a.filter(Boolean).join('<span class="dv" aria-hidden="true"></span>'),
    lockup(d) { return `<div class="lockup"><svg viewBox="${B.logo.viewBox}">${B.logo.svg}</svg>${d.series ? `<span class="sep"></span><span class="series" data-f="series">${esc(d.series)}</span>` : ''}</div>`; },
    chips(d, opts = {}) {
      const c = [], dl = d.dateLabel ?? h.date(d), tl = d.timeLabel ?? d.time;
      if ((dl || tl) && !opts.noDate) c.push(`<span class="chip hl">${h.parts([dl && `<span data-f="dateLabel">${esc(dl)}</span>`, tl && `<span data-f="timeLabel">${esc(tl)}</span>`])}</span>`);
      const pl = h.shown(d, 'place') ? (d.placeLabel ?? h.place(d)) : '';
      if (pl) c.push(`<span class="chip" data-f="placeLabel">${esc(pl)}</span>`);
      return c.length ? `<div class="meta${opts.big ? ' big' : ''}">${c.join('')}</div>` : '';
    },
    // background-image style for a photo path, with per-asset focus
    bg(d, path, fallbackPos = '50% 30%') {
      let url = getPath(d, path);
      if (url && S.duotone && /^speakers\.\d+\.photo$/.test(path)) url = duotone(url, T) || url;
      return (url ? `background-image:url('${url}');` : '') + `background-position:${d.__pos?.[path] || fallbackPos};`;
    },
    photo(d, path, cls, fallback = '') {
      const url = getPath(d, path);
      return `<div class="img ${cls || ''}" data-p="${path}" style="${h.bg(d, path)}">${url ? '' : esc(fallback)}</div>`;
    },
    speakers(d) {
      const sp = d.speakers.map((s, i) => ({ ...s, i })).filter(s => s.name);
      if (!sp.length) return '';
      if (sp.length <= 3 || (sp.length <= 4 && fmt.kind === 'story')) return `<div class="speakers rows${sp.length === 1 ? ' solo' : ''}">${sp.map(s => `<div class="sp-card">${h.photo(d, `speakers.${s.i}.photo`, '', initials(s.name))}<div><div class="n" data-f="speakers.${s.i}.name">${esc(s.name)}</div><div class="r" data-drop="3">${h.role(s)}</div></div></div>`).join('')}</div>`;
      return `<div class="speakers dots">${sp.map(s => `<div class="sp-dot">${h.photo(d, `speakers.${s.i}.photo`, '', initials(s.name))}<div class="n" data-f="speakers.${s.i}.name">${esc(s.name)}</div></div>`).join('')}</div>`;
    },
    role(s) { return [s.role && `<span data-f="speakers.${s.i}.role">${esc(s.role)}</span>`, s.company && `<span data-f="speakers.${s.i}.company">${esc(s.company)}</span>`].filter(Boolean).join(', '); },
    // brand backdrop (+ its photo layer); id comes from the per-image override, else the template default
    backdrop(d, id, photoPath, opts = {}) {
      const r = B.backdrop(id, fmt, T, opts), L = r.layers.photo;
      let photo = '';
      photoPath = photoPath || d.__photoPath;
      if (L && photoPath) {
        const has = !!getPath(d, photoPath);
        const bgStyle = h.bg(d, photoPath, '50% 40%') + (has ? '' : `background-image:linear-gradient(160deg,${T.chip},transparent);`);
        if (L.full) photo = `<div class="panel${has ? '' : ' empty'}" data-p="${photoPath}" style="left:0;top:0;width:${fmt.w}px;height:${fmt.h}px;${bgStyle}"></div><div class="shade"></div>`;
        else {
          const xs = L.poly.map(p => p[0]), ys = L.poly.map(p => p[1]);
          const bx = Math.max(0, Math.min(...xs)), by = Math.max(0, Math.min(...ys)), bw = Math.min(fmt.w, Math.max(...xs)) - bx, bh = Math.min(fmt.h, Math.max(...ys)) - by;
          const clip = L.poly.map(([x, y]) => `${(x - bx).toFixed(1)}px ${(y - by).toFixed(1)}px`).join(',');
          photo = `<div class="panel${has ? '' : ' empty'}" data-p="${photoPath}" style="left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px;--clip:${clip};${bgStyle}"></div>`;
        }
      }
      h.__avoid = r.layers.avoid; h.__dot = r.layers.dot; h.__shapes = r.layers.shapes || [];
      return photo + r.svg;
    },
    // text in a .top block flows around the backdrop's main shape (CSS shape-outside), never over it
    wrap() {
      return ''; // superseded by wrapText(): every paragraph wraps around shapes
      const A = h.__avoid; if (!A) return '';
      const sc = SCALE[fmt.kind], ox = sc.pad, oy = fmt.kind === 'story' ? sc.safeTop : sc.pad;
      const cw = fmt.w - 2 * sc.pad, ch = fmt.h - oy - (fmt.kind === 'story' ? sc.safeBottom : sc.pad);
      let poly = A.poly.map(([x, y]) => [x - ox, y - oy]);
      // the text zone ends above the dot (or at 62% of the content box); no float if the shape stays below it
      const H = Math.max(0, Math.min(ch * .62, h.__dot ? h.__dot[1] - h.__dot[2] - oy - 20 : ch));
      if (Math.min(...poly.map(p => p[1])) > H - 20) return '';
      poly = poly.map(([x, y]) => [Math.max(-cw, Math.min(2 * cw, x)), Math.max(-10, Math.min(H + 10, y))]);
      return `<div class="avoid" data-h="${H.toFixed(0)}" style="height:${H.toFixed(0)}px;shape-outside:polygon(${poly.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',')})"></div>`;
    },
    foot(d, key = 'cta') { const v = d[key] || B.url; return `<div class="foot" data-drop="2"><span class="arrow">→</span><span data-f="${key}">${esc(v)}</span></div>`; },
  };
  return h;
}

/* ═════════════ Duotone (optional, speaker photos) ═════════════
   Maps luminance onto the theme: shadows → bg-ish dark green, highlights → mint/lime. Cached per url+theme;
   computed async, then re-renders. Remote images without CORS are left untouched. */
const duoCache = new Map();
function hexRgb(c) { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; }
function duotone(url, t) {
  const dark = hexRgb(t.duoDark || t.bg), light = hexRgb(t.duoLight || t.dot);
  if (!dark || !light) return null;
  const key = url.length > 200 ? url.slice(0, 100) + url.length + url.slice(-100) : url;
  const k = key + '|' + dark + '|' + light;
  if (duoCache.has(k)) return duoCache.get(k);
  duoCache.set(k, null);
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => { try {
    const c = document.createElement('canvas'), sc = Math.min(1, 1000 / Math.max(img.width, img.height));
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
    const px = x.getImageData(0, 0, c.width, c.height), a = px.data;
    for (let i = 0; i < a.length; i += 4) {
      let l = (a[i] * .299 + a[i + 1] * .587 + a[i + 2] * .114) / 255; l = Math.min(1, Math.max(0, (l - .06) / .88)); // slight contrast stretch
      for (let j = 0; j < 3; j++) a[i + j] = dark[j] + (light[j] - dark[j]) * l;
    }
    x.putImageData(px, 0, 0); duoCache.set(k, c.toDataURL('image/jpeg', .9)); scheduleRender();
  } catch (e) { console.warn('Duotone skipped (image not readable):', e.message); } };
  img.src = url;
  return null;
}

/* ═════════════ Render ═════════════ */
function cssVars(fmt, t) {
  const sc = SCALE[fmt.kind], v = {
    '--b-head': B.fonts.head, '--b-body': B.fonts.body, '--u': sc.u,
    '--pad': fmt.kind === 'story' ? `${sc.safeTop}px ${sc.pad}px ${sc.safeBottom}px` : sc.pad + 'px',
    '--padX': sc.pad + 'px', '--padY': (sc.safeTop || sc.pad) + 'px',
    '--title': sc.title + 'px', '--desc': sc.desc + 'px', '--meta': sc.meta + 'px', '--photo': sc.photo + 'px', '--photoS': sc.photoS + 'px',
    '--spName': sc.spName + 'px', '--spRole': sc.spRole + 'px', '--textW': sc.textW, '--spkW': sc.spkW, '--gap1': sc.gap1 + 'px',
  };
  for (const [k, val] of Object.entries(t)) if (typeof val === 'string' && k !== 'label') v['--t-' + k] = val;
  return Object.entries(v).map(([k, val]) => `${k}:${val}`).join(';');
}

// the template of a page that is not the design's own (a Speaker or Agenda page in a carousel), or null
function slideTemplate(container, slide) { const t = slide && slide.template && slide.template !== container.id ? templates[slide.template] : null; return t && t.slide ? t : null; }
// turn a page of a carousel into a page of another template (or back to the design's own). Its fields stay; the new template's fields it lacks get their
// starter content; frame settings of that page are cleared (they pointed at fields of the old template)
function setSlideTemplate(postId, index, tid) {
  const p = S.posts.find(x => x.id === postId), c = templates[p.template], item = c.pagesOwn && p.fields[c.pagesOwn][index], to = templates[tid];
  if (!item || !to || (to !== c && !to.slide)) return;
  if (to === c) delete item.template; else item.template = tid;
  const fill = (k, v) => { if (item[k] == null) item[k] = v; };
  if (to === c) for (const f of c.lists.find(l => l.key === c.pagesOwn).item) fill(f.key, '');
  for (const f of to.fields || []) fill(f.key, typeof f.default === 'function' ? f.default(S, B) : (f.default ?? ''));
  for (const k of to.slots || []) fill(k, '');
  if (to.layouts.length) { if (!to.layouts.some(l => l.id === item.layout)) item.layout = to.layouts[0].id; } else delete item.layout;
  for (const k of Object.keys(S.overrides)) if (k.startsWith(`${p.id}.s-${item.id}.`) || k.startsWith(`${p.id}.s-${item.id}~`)) delete S.overrides[k];
}
// the part of an export file name that says which image of the design this is: the page's place (01, 02...), not its id, so files sort in page order
function pageName(p, tpl, it) {
  if (!tpl.pagesOwn || !/^s-/.test(it.key)) return it.key === 'main' ? '' : '-' + it.key;
  const n = it.slideIndex ?? it.index, many = (p.fields[tpl.pagesOwn] || []).length > 1, sub = it.key.includes('~') ? slug(it.sub || it.key.split('~')[1]) : '';
  return (many ? '-' + String(n + 1).padStart(2, '0') : '') + (sub ? '-' + sub : '');
}
// the shared kinds a design reads: its template's, and those of every page's template
function kindsOf(p) {
  const t = templates[p.template], out = new Set(t.kinds || []);
  if (t.pagesOwn) for (const x of p.fields[t.pagesOwn] || []) for (const k of (slideTemplate(t, x) || t).kinds || []) out.add(k);
  return [...out];
}
// with several items of a kind (two events), a design's files say which one it is about: its date, else its name
function itemTag(p) {
  return kindsOf(p).filter(k => kinds[k] && S.shared[k].length > 1).map(k => { const v = sharedItem(p, k); return '-' + (itemDate(k, v) || slug(itemLabel(k, v)).slice(0, 24)); }).join('');
}
function assetList() {
  const out = [], taken = new Map();
  for (const p of S.posts) {
    const tpl = templates[p.template]; if (!tpl) continue;
    let stem = `${projSlug()}${itemTag(p)}-${slug(p.name || tpl.label)}`; // two designs of one name would overwrite each other's files
    const n = (taken.get(stem) || 0) + 1; taken.set(stem, n); if (n > 1) stem += '-' + n;
    const d = postData(p);
    let items = tpl.items ? tpl.items(d, B) : [{ key: 'main' }];
    // a page of a carousel may be of another template (item.template): its frames come from that template, and its fields live on the page
    if (tpl.pagesOwn) items = items.flatMap(it => {
      const slide = it.page === 'each' ? p.fields[tpl.pagesOwn][it.index] : null, st = slideTemplate(tpl, slide);
      if (!st) return [it];
      const sub = st.items ? st.items(d, B) : [{ key: 'main' }];
      return sub.map(x => ({ ...x, key: `s-${slide.id}` + (sub.length > 1 || x.key !== 'main' ? '~' + x.key : ''), label: sub.length > 1 && x.label ? `${st.label}: ${x.label}` : st.label,
        slideIndex: it.index, tpl: st, ...(st.pages ? { fieldBase: `${tpl.pagesOwn}.${it.index}` } : { base: `${tpl.pagesOwn}.${it.index}` }), sub: x.label, layout: st.layouts.length ? slide.layout : undefined }));
    });
    const group = { tpl, post: p, label: p.name || tpl.label, assets: [] };
    for (const it of items) for (const fk of p.formats) {
      if (!FORMATS[fk]) continue;
      const itpl = it.tpl || tpl; if (it.tpl && !allowedFormats(itpl).includes(fk)) continue; // this page's template does not make this size
      const id = `${p.id}.${it.key}.${fk}`;
      group.assets.push({ id, tpl: itpl, post: p, item: it, fk, fmt: FORMATS[fk], name: `${stem}${pageName(p, tpl, it)}-${fk}`.slice(0, 120) });
    }
    out.push(group);
  }
  return out;
}

function bgSel(a, ov) {
  const cur = ov.__bg || bdList(a, postData(a.post))[0];
  return Object.entries(B.backdrops).map(([k, b]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(b.label)}</option>`).join('');
}
/* Grid texture: a quiet ascii field of "+" marks with the odd "/" (at the brand's 0.8 slash angle)
   and the occasional "-" — deterministic per format, vector so SVG export keeps it. */
function gridTexture(fmt, t) {
  const sc = SCALE[fmt.kind], step = Math.round(46 * sc.u), arm = 4.5 * sc.u, sw = Math.max(1.4, 1.5 * sc.u);
  let seed = fmt.w * 7 + fmt.h * 13; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let plus = '', slash = '';
  for (let y = step / 2; y < fmt.h; y += step) for (let x = step / 2; x < fmt.w; x += step) {
    const r = rnd();
    if (r < .07) { const dy = 7 * sc.u; slash += `M${(x - dy * .8).toFixed(1)} ${(y + dy).toFixed(1)}L${(x + dy * .8).toFixed(1)} ${(y - dy).toFixed(1)}`; }
    else if (r < .1) plus += `M${(x - arm * 1.6).toFixed(1)} ${y}H${(x + arm * 1.6).toFixed(1)}`;
    else if (r < .16) continue;
    else plus += `M${(x - arm).toFixed(1)} ${y}H${(x + arm).toFixed(1)}M${x} ${(y - arm).toFixed(1)}V${(y + arm).toFixed(1)}`;
  }
  return `<svg class="grid-tex" viewBox="0 0 ${fmt.w} ${fmt.h}" aria-hidden="true"><path d="${plus}" stroke="${t.grid || t.fg}" stroke-opacity="${t.gridOpacity || .16}" stroke-width="${sw}" fill="none"/><path d="${slash}" stroke="${t.accent}" stroke-opacity="${t.gridAccentOpacity || .4}" stroke-width="${sw}" fill="none"/></svg>`;
}
// ordered backdrop candidates from the template (bold first); a per-image override always wins
const PHOTO_BDS = ['photo-cut', 'photo-chevron', 'photo-rotated'];
const bdList = (a, d) => {
  const list = [].concat(a.tpl.backdrop ? a.tpl.backdrop(a.fmt, a.item, d) : 'plain');
  // with a cover photo the post stays in photo layouts; full-bleed photo is the always-fits fallback
  return a.tpl.coverPhoto !== false && d.coverPhoto ? [...PHOTO_BDS, 'photo'].filter(k => B.backdrops[k]) : list;
};
// stickers: pasted PNGs placed per frame; x/y/w in % of the frame, ar = width/height
function stickers(list) {
  // data-gen: the makeitbrand runtime leaves it out of its layout checks (a sticker is not part of the board's composition)
  return (list || []).map((s, i) => `<div class="sticker" data-gen data-st="${i}" style="left:${s.x}%;top:${s.y}%;width:${s.w}%;aspect-ratio:${s.ar};background-image:url('${s.src}');${s.rot ? `transform:rotate(${s.rot}deg);` : ''}"></div>`).join('');
}
// keep transparency for stickers (readImage makes JPEGs)
function readPng(file, max = 900) {
  return new Promise(ok => { const r = new FileReader(); r.onload = () => { const img = new Image(); img.onload = () => {
    const sc = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    ok({ src: c.toDataURL('image/png'), ar: +(c.width / c.height).toFixed(4) }); }; img.src = r.result; }; r.readAsDataURL(file); });
}
function textZoneTop(fmt, shapes) {
  if (!shapes.length || fmt.kind === 'landscape') return 0;
  // only shapes that sit in the left half of the frame near the top push the text down
  const sc = SCALE[fmt.kind], top = fmt.kind === 'story' ? sc.safeTop : sc.pad, colR = fmt.w * .55, gap = 30 * sc.u;
  let minY = Infinity, maxY = -Infinity;
  for (const sh of shapes) {
    if (sh.circle) { const [cx, cy, r] = sh.circle; if (cx - r < colR) { minY = Math.min(minY, cy - r); maxY = Math.max(maxY, cy + r); } continue; }
    // the part of the polygon left of the text column's right edge, sampled every 8px
    for (let y = 0; y <= fmt.h; y += 8) { const L = shapeSpanLeft(sh, y); if (L != null && L < colR) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); } }
  }
  return minY < fmt.h * .22 && maxY + gap > top ? Math.min(maxY + gap, fmt.h * .8) : 0;
}
function renderAsset(a, pick = 0) {
  const ov = S.overrides[a.id] || {}, themeId = ov.__theme || a.item.theme || S.theme;
  T = B.themes[themeId] || B.themes[B.defaultTheme];
  const d = assetData(a.id), h = helpers(a.fmt);
  h.__shapes = [];
  d.__photoPath = a.tpl.coverPhoto === false ? null : 'coverPhoto';
  const list = bdList(a, d); d.__bd = ov.__bg || list[Math.min(pick, list.length - 1)];
  // a markup template renders a makeitbrand board: the board itself is the asset element
  if (a.tpl.markup) { const html = Studio.boards.render(a, d, h), st = stickers(ov.__stickers); return st ? html.replace(/<\/section>\s*$/, st + '</section>') : html; } // a board carries its stickers too
  let body = a.tpl.render(d, a.fmt, T, a.item, h);
  // if the composition occupies the top of the text column (photo cut, chevron high…), start the text below it
  const zt = textZoneTop(a.fmt, h.__shapes || []);
  if (zt) body = body.replace('class="content"', `class="content" style="top:${zt.toFixed(0)}px"`);
  return `<div class="asset k-${a.fmt.kind}" data-bd="${d.__bd}" data-pick="${pick}" data-id="${a.id}" data-name="${a.name}" style="width:${a.fmt.w}px;height:${a.fmt.h}px;${cssVars(a.fmt, T)}">${S.texture ? (Studio.texture || gridTexture)(a.fmt, T, h.__shapes || [], SCALE[a.fmt.kind]) : ''}${body}${stickers(ov.__stickers)}</div>`;
}

/* Text wraps around solid brand shapes on ANY background: each paragraph gets a right float whose
   shape-outside follows the free space left of the shapes (scanned every few px from data-shapes). */
const WRAP_SEL = '.content h1, .content .desc, .content .quote, .content .body, .content .kicker, .content .bigdate-sub, .content .role-big';
function shapeSpanLeft(sh, y) { // leftmost x a solid shape occupies on row y (or null)
  if (sh.circle) { const [cx, cy, r] = sh.circle, dy = y - cy; return Math.abs(dy) < r ? cx - Math.sqrt(r * r - dy * dy) : null; }
  const P = sh.poly, xs = [];
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [x1, y1] = P[j], [x2, y2] = P[i]; if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1)); }
  return xs.length ? Math.min(...xs) : null;
}
function wrapText(node) {
  node.querySelectorAll('.wrapf').forEach(f => f.remove());
  const m = $('.motif[data-shapes]', node); if (!m) return;
  const shapes = JSON.parse(m.dataset.shapes || '[]'); if (!shapes.length) return;
  const nb = node.getBoundingClientRect(), k = node.offsetWidth / nb.width, u = SCALE[node.className.match(/k-(\w+)/)[1]].u;
  const gap = 26 * u, step = 6;
  const build = (el, x0, y0, w, H) => {
    const pts = []; let any = false;
    for (let yy = 0; yy <= H; yy += step) {
      let xl = w; // free until the right edge
      for (const dy of [-6 * u, 0, 6 * u]) for (const sh of shapes) { // sample around the row for line-height slack
        const L = shapeSpanLeft(sh, y0 + yy + dy); if (L == null) continue;
        const R = sh.circle ? sh.circle[0] + sh.circle[2] : Math.max(...sh.poly.map(p => p[0]));
        if (R < x0) continue; // shape entirely left of the text: not in the way
        xl = Math.min(xl, Math.max(0, L - x0 - gap));
      }
      if (xl < w * .45) xl = 0; // never squeeze text into a sliver beside a shape: skip the row instead
      if (xl < w - 1) any = true;
      pts.push([xl, yy]);
    }
    if (!any) return null;
    const poly = [[w, 0], ...pts, [w, H]].map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',');
    const f = document.createElement('span'); f.className = 'wrapf'; f.setAttribute('aria-hidden', 'true');
    f.style.cssText = `float:right;width:${w.toFixed(1)}px;height:${H.toFixed(1)}px;shape-outside:polygon(${poly})`;
    return f;
  };
  node.querySelectorAll(WRAP_SEL).forEach(el => {
    if (el.isContentEditable) return;
    el.classList.add('wrapbox');
    const b = el.getBoundingClientRect(), x0 = (b.left - nb.left) * k, y0 = (b.top - nb.top) * k, w = b.width * k;
    let H = el.scrollHeight;
    // wrapping makes text taller; grow the float until it covers every line (max 4 passes)
    for (let pass = 0; pass < 4; pass++) {
      el.querySelector(':scope > .wrapf')?.remove();
      const f = build(el, x0, y0, w, H); if (!f) return;
      el.prepend(f);
      // float height == content height means the text fits; when lines spill below, retry taller
      const lines = [...el.childNodes].filter(n => n !== f);
      const r = document.createRange(); r.setStartBefore(lines[0] || f); r.setEndAfter(lines.at(-1) || f);
      const need = (r.getBoundingClientRect().bottom - b.top) * k;
      if (need <= H + 2) break;
      H = need + 4;
    }
  });
}
// text line boxes (+ chips, photos, speaker rows) in native asset px
function textRects(node, pad = 0) {
  const nb = node.getBoundingClientRect(), k = node.offsetWidth / nb.width, rects = [];
  const walker = document.createTreeWalker($('.content', node) || node, NodeFilter.SHOW_TEXT);
  for (let t; (t = walker.nextNode());) {
    if (!t.textContent.trim() || t.parentElement.closest('[style*="display: none"]')) continue;
    const r = document.createRange(); r.selectNodeContents(t);
    for (const b of r.getClientRects()) if (b.width) rects.push([(b.left - nb.left) * k - pad, (b.top - nb.top) * k - pad, (b.right - nb.left) * k + pad, (b.bottom - nb.top) * k + pad]);
  }
  node.querySelectorAll('.content .chip, .content .img, .content .lockup svg, .content .foot .arrow').forEach(el => { const b = el.getBoundingClientRect(); if (b.width) rects.push([(b.left - nb.left) * k - pad, (b.top - nb.top) * k - pad, (b.right - nb.left) * k + pad, (b.bottom - nb.top) * k + pad]); });
  return rects;
}
// thin decorative outlines are cut where text sits (editorial knockout), never drawn through words
let koSeq = 0;
function knockout(node) {
  const m = $('.motif', node); if (!m) return;
  m.querySelectorAll('mask.ko').forEach(x => x.remove()); m.querySelectorAll('.ol').forEach(x => x.removeAttribute('mask'));
  const ols = m.querySelectorAll('.ol'); if (!ols.length) return;
  const u = SCALE[node.className.match(/k-(\w+)/)[1]].u, rects = textRects(node, 16 * u);
  if (!rects.length) return;
  const id = 'ko' + (++koSeq), NS = 'http://www.w3.org/2000/svg';
  const mask = document.createElementNS(NS, 'mask'); mask.setAttribute('id', id); mask.setAttribute('class', 'ko'); mask.setAttribute('maskUnits', 'userSpaceOnUse');
  mask.innerHTML = `<rect x="0" y="0" width="${node.offsetWidth}" height="${node.offsetHeight}" fill="white"/>` + rects.map(([x0, y0, x1, y1]) => `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" rx="${(8 * u).toFixed(1)}" fill="black"/>`).join('');
  m.prepend(mask);
  ols.forEach(x => x.setAttribute('mask', `url(#${id})`));
}
// when the text has to start below the shapes, park the lockup in the free top-left corner if it fits there
function placeLockup(node) {
  const content = $('.content', node), lk = content && $('.lockup', content);
  if (!lk) return;
  lk.style.position = lk.style.left = lk.style.top = ''; lk.classList.remove('parked');
  if (!content.style.top) return;
  const m = $('.motif[data-shapes]', node), shapes = m ? JSON.parse(m.dataset.shapes || '[]') : [];
  const kind = node.className.match(/k-(\w+)/)[1], sc = SCALE[kind], padT = kind === 'story' ? sc.safeTop : sc.pad, u = sc.u;
  const nb = node.getBoundingClientRect(), k = node.offsetWidth / nb.width, lb = lk.getBoundingClientRect();
  const R = [sc.pad - 20 * u, padT - 20 * u, sc.pad + lb.width * k + 20 * u, padT + lb.height * k + 20 * u];
  const hit = shapes.some(sh => {
    if (sh.circle) { const [cx, cy, r] = sh.circle, dx = Math.max(R[0] - cx, 0, cx - R[2]), dy = Math.max(R[1] - cy, 0, cy - R[3]); return dx * dx + dy * dy < r * r; }
    for (let y = R[1]; y <= R[3]; y += 6) { const L = shapeSpanLeft(sh, y); if (L != null && L < R[2]) return true; }
    return false;
  });
  if (hit) return;
  // .content is the containing block: put the lockup back at the frame's top padding
  lk.classList.add('parked'); lk.style.position = 'absolute'; lk.style.left = '0'; lk.style.top = (padT - parseFloat(content.style.top)) + 'px';
}
/* Rows where solid shapes leave less than half the text column free are barriers: the text group above the
   spacer must end before one, the group below must start after it (no squeezing text through a blocked band). */
function barriers(node) {
  const m = $('.motif[data-shapes]', node); if (!m) return [];
  const shapes = JSON.parse(m.dataset.shapes || '[]'); if (!shapes.length) return [];
  const kind = node.className.match(/k-(\w+)/)[1], sc = SCALE[kind], W = node.offsetWidth, H = node.offsetHeight;
  const cl = sc.pad, cr = kind === 'landscape' ? W * .62 : W - sc.pad, need = (cr - cl) * .5, out = [];
  let cur = null;
  for (let y = 0; y <= H; y += 6) {
    const occ = [];
    for (const sh of shapes) {
      if (sh.circle) { const [cx, cy, r] = sh.circle, dy = y - cy; if (Math.abs(dy) < r) { const hw = Math.sqrt(r * r - dy * dy); occ.push([cx - hw, cx + hw]); } continue; }
      const P = sh.poly, xs = [];
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [x1, y1] = P[j], [x2, y2] = P[i]; if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1)); }
      xs.sort((a, b) => a - b); for (let i = 0; i + 1 < xs.length; i += 2) occ.push([xs[i], xs[i + 1]]);
    }
    occ.sort((a, b) => a[0] - b[0]);
    let x = cl, best = 0;
    for (const [a, b] of occ) { if (b < cl || a > cr) continue; best = Math.max(best, Math.min(a, cr) - x); x = Math.max(x, b); }
    best = Math.max(best, cr - x);
    const blocked = best < need;
    if (blocked && !cur) cur = [y, y]; else if (blocked) cur[1] = y; else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map(([a, b]) => [a - 12 * sc.u, b + 12 * sc.u]);
}
function fit(node) {
  // boards never shrink type: the makeitbrand runtime lays them out and marks what overflows
  if (node.matches('.board')) return Studio.boards.settle(node);
  const kind = node.className.match(/k-(\w+)/)[1], sc = SCALE[kind], content = $('.content', node);
  const bars = barriers(node);
  // text groups (before / after the spacer) must not run into a blocked band of rows
  const overTop = (which = 'all') => {
    if (!bars.length || !content) return false;
    const nb = node.getBoundingClientRect(), k = node.offsetWidth / nb.width, kids = [...content.children];
    const si = kids.findIndex(c => c.classList.contains('spacer'));
    let groups = si < 0 ? [kids] : [kids.slice(0, si), kids.slice(si + 1)];
    if (which === 'top') groups = groups.slice(0, 1);
    return groups.some(g => {
      const rs = g.filter(el => el.offsetParent && el.getBoundingClientRect().height).map(el => el.getBoundingClientRect());
      if (!rs.length) return false;
      const t = (Math.min(...rs.map(r => r.top)) - nb.top) * k, b = (Math.max(...rs.map(r => r.bottom)) - nb.top) * k;
      return bars.some(([b0, b1]) => b0 < b - 2 && b1 > t + 2);
    });
  };
  const overflow = () => content && content.scrollHeight > content.clientHeight + 1;
  const pass = () => {
    // titles give way first, so hero numbers (the big date) stay big as long as possible
    [...node.querySelectorAll('[data-fit]')].sort((a, b) => (b.tagName === 'H1') - (a.tagName === 'H1')).forEach(el => {
      // restart from the size the template designed (inline style), not the CSS default
      if (el.dataset.base == null) el.dataset.base = el.style.fontSize || '';
      el.style.fontSize = el.dataset.base;
      const maxLines = +el.dataset.fit || sc.lines;
      let size = parseFloat(getComputedStyle(el).fontSize), start = size, min = size * .42, guard = 40;
      const lh = () => parseFloat(getComputedStyle(el).lineHeight) || size * 1.05;
      wrapText(node);
      while (guard-- && size > min && (overTop('top') || el.offsetHeight > lh() * maxLines + 2 || (!el.closest('.top') && el.scrollWidth > el.clientWidth + 1) || overflow())) {
        size *= .94; el.style.fontSize = size + 'px'; wrapText(node);
      }
      el.dataset.ratio = (size / start).toFixed(2);
    });
    return !overflow() && ![...node.querySelectorAll('[data-fit]')].some(el => +el.dataset.ratio < .75) && !overTop();
  };
  node.querySelectorAll('[data-drop]').forEach(el => { if (!el.dataset.hidden) el.style.display = ''; });
  node.classList.remove('compact');
  const hid = (S.overrides[node.dataset.id] || {}).__hide || [];
  hid.forEach(path => node.querySelectorAll(`[data-f="${CSS.escape(path)}"]`).forEach(el => { el.style.display = 'none'; el.dataset.hidden = '1'; }));
  placeLockup(node);
  let ok = pass();
  // still too tight: simplify step by step instead of crushing or clipping:
  // 1 drop the description, 2 compact speakers (side by side, no roles), 3 drop the CTA line
  const steps = [() => hide(1), () => node.classList.add('compact'), () => hide(2), () => hide(3)];
  function hide(lv) { node.querySelectorAll(`[data-drop="${lv}"]`).forEach(el => { el.style.display = 'none'; }); }
  // shapes count too: text touching the band/photo/dot triggers the same simplification
  if (ok && hitsShapes(node)) ok = false;
  for (const step of steps) { if (ok) break; step(); ok = pass() && !hitsShapes(node); }
  knockout(node);
  return ok;
}
/* Does any line of text touch a solid brand shape (band, photo strip, dot)? Shapes come from the motif's data-shapes. */
function hitsShapes(node, pad = 6) {
  if (node.matches('.board')) return node.hasAttribute('data-overflow') || node.hasAttribute('data-invalid');
  const m = $('.motif[data-shapes]', node); if (!m) return false;
  const shapes = JSON.parse(m.dataset.shapes || '[]'); if (!shapes.length) return false;
  const nb = node.getBoundingClientRect(), k = node.offsetWidth / nb.width;
  const rects = [];
  const walker = document.createTreeWalker($('.content', node) || node, NodeFilter.SHOW_TEXT);
  for (let t; (t = walker.nextNode());) {
    if (!t.textContent.trim()) continue;
    const r = document.createRange(); r.selectNodeContents(t);
    for (const b of r.getClientRects()) rects.push([(b.left - nb.left) * k - pad, (b.top - nb.top) * k - pad, (b.right - nb.left) * k + pad, (b.bottom - nb.top) * k + pad]);
  }
  node.querySelectorAll('.content .img, .content .chip, .content .sp-card').forEach(el => { const b = el.getBoundingClientRect(); rects.push([(b.left - nb.left) * k, (b.top - nb.top) * k, (b.right - nb.left) * k, (b.bottom - nb.top) * k]); });
  const inPoly = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const segHit = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
  return rects.some(([x0, y0, x1, y1]) => shapes.some(sh => {
    if (sh.circle) { const [cx, cy, r] = sh.circle, dx = Math.max(x0 - cx, 0, cx - x1), dy = Math.max(y0 - cy, 0, cy - y1); return dx * dx + dy * dy < r * r; }
    const P = sh.poly, R = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    if (R.some(([x, y]) => inPoly(x, y, P)) || P.some(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1)) return true;
    return P.some((p, i) => R.some((q, j) => segHit(p, P[(i + 1) % P.length], q, R[(j + 1) % 4])));
  }));
}
// fit, and if the text doesn't sit well on this composition, fall back to the next candidate
function fitBest(a, node) {
  if (a.tpl.markup) { fit(node); return node; }
  let ok = fit(node) && !hitsShapes(node), pick = +node.dataset.pick;
  while (!ok && !(S.overrides[a.id] || {}).__bg && pick < bdList(a, postData(a.post)).length - 1) {
    pick++; const tmp = document.createElement('div'); tmp.innerHTML = renderAsset(a, pick);
    const next = tmp.firstElementChild; node.replaceWith(next); node = next; ok = fit(node) && !hitsShapes(node);
  }
  return node;
}

function render() { B = brands[S.brand]; Studio.ui && Studio.ui.render(); }
let renderT; function scheduleRender() { clearTimeout(renderT); renderT = setTimeout(render, 90); }
function changed(opts = {}) { if (!unsaved) { unsaved = true; Studio.ui?.saveState?.(); } if (opts.form) buildForm(); syncJson(); persist(); Studio.ui?.changed?.(opts); scheduleRender(); }

/* ═════════════ Canvas editing ═════════════ */
let pickPath = null;
const actions = []; // extension caption buttons
/* Cmd/Ctrl+B: wrap the selection in *…* (green highlight), or unwrap it. Works on canvas text and form fields. */
function toggleStrong(field) {
  if (field) { // <input>/<textarea>
    const { selectionStart: a, selectionEnd: b, value: v } = field; if (a === b) return;
    const sel = v.slice(a, b), wrapped = /^\*[^*]+\*$/.test(sel), outer = v[a - 1] === '*' && v[b] === '*';
    if (wrapped) field.setRangeText(sel.slice(1, -1), a, b, 'select');
    else if (outer) { field.setRangeText(sel, a - 1, b + 1, 'select'); }
    else field.setRangeText(`*${sel}*`, a, b, 'select');
    field.dispatchEvent(new Event('input', { bubbles: true })); return;
  }
  const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed) return;
  document.execCommand('bold'); // on the canvas the highlight is the browser's bold; it is saved back as *word*
}
document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'b') return;
  const f = e.target; if (f.matches && f.matches('.ui-panel input[type=text], .ui-panel input:not([type]), .ui-panel textarea')) { e.preventDefault(); toggleStrong(f); }
});

/* ═════════════ Export ═════════════ */
async function renderNode(id) {
  // render off-screen at native size so export never depends on what's visible
  const a = assetList().flatMap(g => g.assets).find(x => x.id === id);
  const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-99999px;top:0;';
  host.dataset.export = ''; // boards leave empty image slots out of an export
  host.innerHTML = renderAsset(a); document.body.appendChild(host);
  await document.fonts.ready; const node = fitBest(a, host.firstElementChild);
  // a board's logo, icons and illustrations load after decorate(): wait for them before anyone captures the node
  if (a.tpl.markup && window.makeitbrand?.idle) await window.makeitbrand.idle();
  // idle() does not cover every <img> (a logo the runtime adds to a fresh node can still be loading): without this the
  // first captures came out without their logo
  await Promise.all([...node.querySelectorAll('img')].filter(i => !i.complete).map(i => new Promise(ok => { i.addEventListener('load', ok, { once: true }); i.addEventListener('error', ok, { once: true }); })));
  return { a, node, done: () => host.remove() };
}
// scale: pixels per CSS pixel (2 and 4 for retina and print); the file name says it (name@2x.png)
async function toBlob(id, type = 'image/png', scale = 1) {
  const { a, node, done } = await renderNode(id);
  try {
    const blob = await htmlToImage[type === 'image/png' ? 'toBlob' : 'toJpeg'](node, { pixelRatio: scale, width: a.fmt.w, height: a.fmt.h });
    if (!blob) throw new Error(`The browser could not draw ${a.fmt.w * scale}×${a.fmt.h * scale} px; try a smaller size`);
    return { name: a.name + (scale > 1 ? `@${scale}x` : ''), blob, fmt: a.fmt };
  }
  finally { done(); }
}
function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
async function downloadOne(id) { toast('Rendering…'); const r = await toBlob(id); save(r.blob, r.name + '.png'); toast('Saved ' + r.name + '.png'); }
async function exportZip(ids, label) {
  ids = ids || assetList().flatMap(g => g.assets.map(a => a.id));
  const zip = new JSZip();
  for (const [i, id] of ids.entries()) { toast(`Rendering ${i + 1}/${ids.length}…`); const r = await toBlob(id); zip.file(r.name + '.png', r.blob); }
  zip.file('set.json', JSON.stringify(exportData(), null, 2));
  save(await zip.generateAsync({ type: 'blob' }), `${projSlug()}${label ? '-' + label : ''}.zip`);
  toast('ZIP ready');
}
async function exportPdf(ids, label, opts = {}) {
  if (!window.jspdf) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  let pdf;
  for (const [i, id] of ids.entries()) {
    toast(`Rendering ${i + 1}/${ids.length}…`);
    const { a, node, done } = await renderNode(id);
    const url = await htmlToImage.toJpeg(node, { pixelRatio: opts.scale || 1, quality: .92, width: a.fmt.w, height: a.fmt.h }); done();
    const o = a.fmt.w > a.fmt.h ? 'l' : 'p';
    if (!pdf) pdf = new jspdf.jsPDF({ unit: 'px', format: [a.fmt.w, a.fmt.h], orientation: o, hotfixes: ['px_scaling'] }); else pdf.addPage([a.fmt.w, a.fmt.h], o);
    pdf.addImage(url, 'JPEG', 0, 0, a.fmt.w, a.fmt.h);
  }
  if (opts.blob) return pdf.output('blob');
  pdf.save(`${projSlug()}-${label}.pdf`); toast('PDF ready');
}

/* ═════════════ Panels (owned by engine/ui.js) ═════════════ */
function buildForm() { Studio.ui && Studio.ui.refreshPanels(); }

/* ═════════════ Data bridge ═════════════ */
function exportData(o = {}) {
  const d = clone(S); d.brand = S.brand;
  if (o.dropUploads || o.short) {
    const strip = v => typeof v === 'string' && v.startsWith('data:') ? (o.short ? '(uploaded image)' : '') : v;
    d.speakers.forEach(s => s.photo = strip(s.photo)); d.photos = d.photos.map(strip).filter(Boolean);
    if (o.dropUploads) d.photos = d.photos.filter(p => p);
  }
  return d;
}
function syncJson() { const j = $('#json'); if (j && document.activeElement !== j) j.value = JSON.stringify(exportData({ short: true }), null, 2).replace(/"\(uploaded image\)"/g, '"(uploaded image)"'); }
// a stylesheet written into a saved sheet loses its address, so the files it points at (the brand's fonts and logo) go in as data
async function inlineUrls(css, base) {
  const found = [...new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map(m => m[2]).filter(u => !/^(data:|https?:|#)/.test(u)))];
  for (const u of found) {
    try {
      const b = await (await fetch(new URL(u, base), { cache: 'no-cache' })).blob();
      const data = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });
      css = css.split(u).join(data);
    } catch (e) { console.warn('Not packed into the sheet:', u, e); }
  }
  return css;
}
let saving = false;
async function saveSheet() {
  if (saving) return; saving = true; Studio.ui?.saveState?.();
  try { await packSheet(); } finally { saving = false; Studio.ui?.saveState?.(); }
}
async function packSheet() {
  toast('Packing the sheet…');
  const doc = document.documentElement.cloneNode(true);
  doc.querySelectorAll('[data-ui-clear]').forEach(el => el.innerHTML = '');
  const tst = doc.querySelector('#toast'); if (tst) { tst.textContent = ''; tst.classList.remove('on'); } // not the "Packing…" of this moment
  doc.querySelector('base')?.remove();
  // self-contained: inline the editor's own scripts and styles so the file opens anywhere
  // (fonts and the export libraries still come from their CDNs, so it needs to be online)
  let inlined = true;
  try {
    for (const el of doc.querySelectorAll('script[src]')) {
      const url = new URL(el.getAttribute('src'), document.baseURI);
      if (url.origin !== location.origin || location.protocol === 'file:') continue;
      const code = await (await fetch(url, { cache: 'no-cache' })).text();
      const s2 = document.createElement('script'); s2.textContent = code.replace(/<\/script/gi, '<\\/script'); s2.dataset.src = el.getAttribute('src');
      el.replaceWith(s2);
    }
    for (const el of doc.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(el.getAttribute('href'), document.baseURI);
      if (url.origin !== location.origin || location.protocol === 'file:') continue;
      const st = document.createElement('style'); st.textContent = await inlineUrls(await (await fetch(url, { cache: 'no-cache' })).text(), url); st.dataset.href = el.getAttribute('href');
      el.replaceWith(st);
    }
  } catch (e) { inlined = false; console.warn('Inlining failed, the sheet will link to this editor instead', e); }
  if (!inlined || location.protocol === 'file:') { const b = document.createElement('base'); b.href = new URL('.', document.baseURI).href; doc.querySelector('head').prepend(b); }
  const data = { ...exportData(), __rev: Date.now() };
  doc.querySelector('#studio-data').textContent = JSON.stringify(data).replace(/</g, '\\u003c');
  // the templates and shared kinds the page fetched travel in the file too
  let fl = doc.querySelector('#studio-files'); if (!fl) { fl = document.createElement('script'); fl.type = 'application/json'; fl.id = 'studio-files'; doc.querySelector('#studio-data').after(fl); }
  fl.textContent = JSON.stringify(Studio.boards?.files || {}).replace(/</g, '\\u003c');
  save(new Blob(['<!doctype html>\n' + doc.outerHTML], { type: 'text/html' }), `${projSlug()}.html`);
  setUnsaved(false);
  toast(inlined ? 'Sheet saved: one file, opens anywhere (online)' : 'Sheet saved (links to this editor)');
}

/* ═════════════ Boot + automation API ═════════════ */
Studio.boot = function () {
  S = normalize(loadInitial()); B = brands[S.brand];
  if (B.fonts.css && !document.querySelector(`link[href="${B.fonts.css}"]`)) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.crossOrigin = 'anonymous'; l.href = B.fonts.css; document.head.appendChild(l);
  }
  Studio.ui ? Studio.ui.mount() : console.warn('engine/ui.js not loaded: headless mode');
};
// For Claude / Playwright: Studio.api.load(json) → await Studio.api.exportAll() → [{name, dataUrl}]
Studio.api = {
  load(d) { S = normalize(d); Studio.ui?.reset?.(); buildForm(); render(); return assetList().flatMap(g => g.assets.map(a => a.name)); },
  get state() { return clone(S); },
  list: () => assetList().flatMap(g => g.assets.map(a => ({ id: a.id, name: a.name, w: a.fmt.w, h: a.fmt.h, kind: a.fmt.kind, format: a.fk, template: a.tpl.id, post: a.post.id }))),
  // Extension hooks (engine/svg.js, engine/animate.js, tools/qa.py):
  // renderNode(id) → { a, node, done() }: the asset rendered off-screen at native size and fitted; call done() to remove it.
  renderNode,
  // fired on document after every gallery render: 'studio:rendered' (detail: { cards: [{ id, card, node }] })
  // extensions add caption buttons via Studio.api.addAction({ id, label, title, test(asset), run(id, asset) })
  addAction(act) { actions.push(act); Studio.ui?.refreshPanels?.(); },
  toast,
  async exportAll(ids) {
    await document.fonts.ready; const out = [];
    for (const a of assetList().flatMap(g => g.assets).filter(a => !ids || ids.includes(a.id))) { const r = await toBlob(a.id); out.push({ name: r.name + '.png', dataUrl: await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(r.blob); }) }); }
    return out;
  },
};
// Internals for engine/ui.js (the editor). Not a public API: headless tools use Studio.api.
Studio._ = {
  get S() { return S; }, set S(v) { S = v; }, get B() { return brands[S.brand]; },
  FORMATS, SCALE, templates, order, brands, actions, kinds,
  esc, slug, clone, getPath, setPath, readImage, normalize, b64enc, helpers,
  assetList, assetData, renderAsset, fit, fitBest, hitsShapes, bdList, readPng,
  postOf, postData, setContent, getContent, newPost, allowedFormats, sharedKinds, hasShared, changeTemplate, previewAsset, projSlug,
  changed, scheduleRender, render, persist, toast, save, afterListChange, pageItem, slideTemplate, setSlideTemplate, containerTpl, kindsOf,
  sharedItem, sharedFor, setFocus, itemLabel, itemDate, usersOf, newItem, removeItem, setUse,
  toBlob, exportPdf, exportData, saveSheet, openFile, get unsaved() { return unsaved; }, get saving() { return saving; }, setUnsaved, syncJson, toggleStrong,
  set pickPath(v) { pickPath = v; }, get pickPath() { return pickPath; },
};
})();
