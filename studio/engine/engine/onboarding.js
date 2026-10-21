/* Onboarding wizard: a compact 3-step "New campaign" dialog on top of the engine (engine/studio.js) +
   editor (engine/ui.js). Loaded after boot; reads/writes state only through Studio._ (X) and Studio.ui,
   never touches engine/ui.js, engine/studio.js or templates directly. Exposes window.StudioOnboarding.open(opts). */
(function () {
'use strict';
const X = Studio._;
const esc = X.esc;
const ONBOARDED_KEY = 'studio:onboarded';

/* ═════════════ storage (never let a blocked/private localStorage break the dialog) ═════════════ */
function hasOnboarded() { try { return !!localStorage.getItem(ONBOARDED_KEY); } catch (e) { return true; } }
function markOnboarded() { try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch (e) { /* ignore */ } }

/* ═════════════ campaign menu: order + hints + preselection for the event path ═════════════ */
const EVENT_PUBLISH = [
  { tid: 'event', hint: '≈3 weeks before — the main announcement', pre: () => true },
  { tid: 'spotlight', hint: '≈2 weeks before — one image per speaker', pre: w => w.speakers.some(s => s.name.trim()) },
  { tid: 'carousel', hint: '≈1 week before — a swipeable recap of the lineup', pre: () => false },
  { tid: 'save-the-date', hint: 'the day before or day of', pre: () => true, name: 'Reminder', fields: { stdKicker: 'Už zítra!' } },
  { tid: 'recap', hint: 'after the event — say thanks', pre: () => false },
  { tid: 'announcement', hint: 'anytime — calls for speakers, partners, membership', pre: () => false },
];
// Single-post offers: only templates whose content lives entirely in the post's own fields (no event/speaker data needed).
const SINGLE_TEMPLATES = ['announcement', 'save-the-date', 'recap', 'slides'];

/* ═════════════ dialog shell ═════════════ */
let root = null, wiz = null, lastFocused = null;

function fmtChip(k) { const f = X.FORMATS[k]; return f ? `<span class="onb-chip" title="${esc(f.label + ', ' + f.hint)}">${esc(f.short || k)}</span>` : ''; }
function tplChips(t) { return X.allowedFormats(t, t.channels).map(fmtChip).join(''); }

function hasCurrentSet() {
  const s = X.S;
  return !!(s.title || s.series || (s.posts && s.posts.length) || (s.speakers || []).some(sp => sp.name));
}

function open(opts = {}) {
  if (root) close();
  lastFocused = document.activeElement;
  const s = X.S, keep = hasCurrentSet();
  wiz = {
    welcome: !!opts.welcome,
    path: null, // 'event' | 'single'
    step: 1,
    keepCurrent: keep,
    event: keep
      ? { series: s.series, title: s.title, description: s.description, date: s.date, time: s.time, venue: s.venue, city: s.city, cta: s.cta }
      : { series: '', title: '', description: '', date: '', time: '', venue: '', city: '', cta: '' },
    speakers: keep && s.speakers.some(sp => sp.name) ? s.speakers.filter(sp => sp.name).map(sp => ({ ...sp })) : [{ name: '', role: '', company: '', photo: '' }],
    publish: {}, // tid -> bool, lazily seeded when step 3 of the event path first renders
    template: null, // single path
    fields: {}, // single path, keyed by field key
  };
  injectStyles();
  root = document.createElement('div');
  root.className = 'onb-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  document.body.appendChild(root);
  root.addEventListener('mousedown', e => { if (e.target === root) close(); });
  document.addEventListener('keydown', onKeydown, true);
  render();
}
function close() {
  if (!root) return;
  document.removeEventListener('keydown', onKeydown, true);
  root.remove(); root = null; wiz = null;
  markOnboarded();
  if (lastFocused && lastFocused.focus) try { lastFocused.focus(); } catch (e) { /* ignore */ }
}
function onKeydown(e) {
  if (!root) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && !e.target.closest('[data-onb-noenter]')) {
    const primary = root.querySelector('[data-onb-primary]');
    if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
  }
}

/* ═════════════ render dispatch ═════════════ */
function render() {
  if (!root) return;
  let body, head;
  if (wiz.step === 1) { head = stepHead(1, 3, wiz.welcome ? 'Welcome to AUX Studio' : 'New campaign'); body = step1(); }
  else if (wiz.path === 'event' && wiz.step === 2) { head = stepHead(2, 3, 'The event'); body = step2Event(); }
  else if (wiz.path === 'event' && wiz.step === 3) { head = stepHead(3, 3, 'What will you publish?'); body = step3Event(); }
  else if (wiz.path === 'single' && wiz.step === 2) { head = stepHead(2, 3, 'What are you posting?'); body = step2Single(); }
  else if (wiz.path === 'single' && wiz.step === 3) { head = stepHead(3, 3, headlineTitle()); body = step3Single(); }
  root.innerHTML = `<div class="onb-sheet" tabindex="-1">${head}${body}</div>`;
  const first = root.querySelector('input, textarea, button');
  if (first) first.focus();
  bind();
}
function stepHead(n, total, title) {
  const dots = Array.from({ length: total }, (_, i) => `<span class="onb-dot ${i < n ? 'on' : ''}"></span>`).join('');
  return `<div class="onb-head"><div class="onb-steps">${dots}<span>Step ${n} of ${total}</span></div>
    <h2>${esc(title)}</h2>${hasCurrentSet() && !wiz.welcome ? `<p class="onb-warn">This replaces your current set. <b>⌘Z</b> in the editor brings it back.</p>` : ''}</div>`;
}
function headlineTitle() { const t = X.templates[wiz.template]; return t ? `Headline for “${esc(t.label)}”` : 'Headline & copy'; }

/* ═════════════ step 1: what are you making ═════════════ */
function step1() {
  return `
    <p class="onb-sub">${wiz.welcome ? 'Set up your first campaign, or jump straight into a single post.' : 'Pick a starting point — you can change anything afterwards.'}</p>
    <div class="onb-choices">
      <button class="onb-choice" data-onb-path="event" data-onb-primary>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>
        <b>An event campaign</b>
        <span>UXMonday, UX Camp, a meetup… a whole run of posts around one event, with speakers, dates and places.</span>
      </button>
      <button class="onb-choice" data-onb-path="single">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="3" width="15" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
        <b>A single post</b>
        <span>News, a call for speakers, a membership push — one quick post, no event needed.</span>
      </button>
    </div>
    <div class="onb-foot"><span></span><button class="onb-lnk" data-onb-example>Explore the example</button></div>`;
}

/* ═════════════ step 2 (event): the event + speakers ═════════════ */
function field2(key, label, type = 'text', wide = false) {
  const v = esc(wiz.event[key] ?? '');
  return `<label class="onb-fld ${wide ? 'wide' : ''}"><span>${esc(label)}</span>${type === 'textarea' ? `<textarea data-onb-ev="${key}" rows="2">${v}</textarea>` : `<input data-onb-ev="${key}" type="${type}" value="${v}" ${key === 'series' ? 'list="onbSeries"' : ''}>`}</label>`;
}
function step2Event() {
  const seriesList = (X.B.series || []).map(x => `<option>${esc(x)}</option>`).join('');
  return `
    ${wiz.keepCurrent !== null && hasCurrentSet() ? `<label class="onb-toggle"><input type="checkbox" data-onb-keep ${wiz.keepCurrent ? 'checked' : ''}> Keep current event details</label>` : ''}
    <datalist id="onbSeries">${seriesList}</datalist>
    <div class="onb-grid2">${field2('series', 'Series')}${field2('title', 'Title')}</div>
    <div class="onb-grid2">${field2('date', 'Date', 'date')}${field2('time', 'Time', 'time')}</div>
    <div class="onb-grid2">${field2('venue', 'Venue')}${field2('city', 'City')}</div>
    <div class="onb-sec"><div class="onb-t">Speakers <small>optional — add now or later</small></div>
      ${wiz.speakers.map((sp, i) => `
        <div class="onb-sprow">
          <input placeholder="Name" value="${esc(sp.name)}" data-onb-sp="${i}.name">
          <input placeholder="Role" value="${esc(sp.role)}" data-onb-sp="${i}.role">
          <input placeholder="Company" value="${esc(sp.company)}" data-onb-sp="${i}.company">
          <button class="onb-x" data-onb-sprm="${i}" title="Remove" ${wiz.speakers.length <= 1 ? 'hidden' : ''}>×</button>
        </div>`).join('')}
      <button class="onb-ghost" data-onb-spadd>+ Add speaker</button>
    </div>
    <div class="onb-foot"><button class="onb-btn" data-onb-back>Back</button><button class="onb-btn primary" data-onb-next data-onb-primary>Next</button></div>`;
}

/* ═════════════ step 2 (single): pick a post type ═════════════ */
function step2Single() {
  if (!wiz.template) selectSingleTemplate(SINGLE_TEMPLATES[0]);
  return `
    <p class="onb-sub">Pick what you want to publish.</p>
    <div class="onb-radios">${SINGLE_TEMPLATES.map(tid => { const t = X.templates[tid]; return `
      <button class="onb-radio ${wiz.template === tid ? 'on' : ''}" data-onb-tpl="${tid}">
        <span class="onb-radio-dot"></span>
        <span class="onb-radio-body"><b>${esc(t.label)}</b><span>${esc(t.description || '')}</span><em>${tplChips(t)}</em></span>
      </button>`; }).join('')}</div>
    <div class="onb-foot"><button class="onb-btn" data-onb-back>Back</button><button class="onb-btn primary" data-onb-next data-onb-primary>Next</button></div>`;
}
function selectSingleTemplate(tid) {
  wiz.template = tid;
  const p = X.newPost(tid);
  wiz.fields = { ...p.fields };
  wiz.usesTitle = tid === 'save-the-date';
  if (wiz.usesTitle && wiz.titleField == null) wiz.titleField = X.S.title || '';
}

/* ═════════════ step 3 (event): the campaign checklist ═════════════ */
function step3Event() {
  if (!wiz.publishSeeded) { EVENT_PUBLISH.forEach(x => { wiz.publish[x.tid] = x.pre(wiz); }); wiz.publishSeeded = true; }
  return `
    <p class="onb-sub">Pick what to publish — sizes are a sensible default, change them later per post.</p>
    <div class="onb-checks">${EVENT_PUBLISH.map(x => { const t = X.templates[x.tid]; return `
      <label class="onb-check ${wiz.publish[x.tid] ? 'on' : ''}">
        <input type="checkbox" data-onb-pub="${x.tid}" ${wiz.publish[x.tid] ? 'checked' : ''}>
        <span class="onb-check-body"><b>${esc(x.name || t.label)}</b><span>${esc(x.hint)}</span><em>${tplChips(t)}</em></span>
      </label>`; }).join('')}</div>
    <div class="onb-foot"><button class="onb-btn" data-onb-back>Back</button><button class="onb-btn primary" data-onb-finish data-onb-primary>Create campaign</button></div>`;
}

/* ═════════════ step 3 (single): headline / copy for the chosen template ═════════════ */
function step3Single() {
  const t = X.templates[wiz.template], fields = t.fields || [];
  return `
    <p class="onb-sub">${esc(t.description || '')}</p>
    ${wiz.usesTitle ? `<label class="onb-fld wide"><span>Headline</span><input data-onb-title value="${esc(wiz.titleField || '')}"></label>` : ''}
    ${fields.map(f => `<label class="onb-fld wide"><span>${esc(f.label)}</span>${f.type === 'textarea'
      ? `<textarea data-onb-f="${f.key}" rows="3">${esc(wiz.fields[f.key] ?? '')}</textarea>`
      : `<input data-onb-f="${f.key}" value="${esc(wiz.fields[f.key] ?? '')}">`}</label>`).join('') || `<p class="onb-note">Nothing to fill in — this one writes itself from a starter slide.</p>`}
    <div class="onb-foot"><button class="onb-btn" data-onb-back>Back</button><button class="onb-btn primary" data-onb-finish data-onb-primary>Create post</button></div>`;
}

/* ═════════════ bindings ═════════════ */
function bind() {
  root.querySelectorAll('[data-onb-path]').forEach(b => b.onclick = () => { wiz.path = b.dataset.onbPath; wiz.step = 2; render(); });
  const ex = root.querySelector('[data-onb-example]'); if (ex) ex.onclick = exploreExample;
  root.querySelectorAll('[data-onb-ev]').forEach(el => el.addEventListener('input', () => { wiz.event[el.dataset.onbEv] = el.value; }));
  const keepBox = root.querySelector('[data-onb-keep]');
  if (keepBox) keepBox.onchange = () => {
    wiz.keepCurrent = keepBox.checked;
    const s = X.S;
    wiz.event = wiz.keepCurrent
      ? { series: s.series, title: s.title, description: s.description, date: s.date, time: s.time, venue: s.venue, city: s.city, cta: s.cta }
      : { series: '', title: '', description: '', date: '', time: '', venue: '', city: '', cta: '' };
    wiz.speakers = wiz.keepCurrent && s.speakers.some(sp => sp.name) ? s.speakers.filter(sp => sp.name).map(sp => ({ ...sp })) : [{ name: '', role: '', company: '', photo: '' }];
    render();
  };
  root.querySelectorAll('[data-onb-sp]').forEach(el => el.addEventListener('input', () => { const [i, k] = el.dataset.onbSp.split('.'); wiz.speakers[i][k] = el.value; }));
  root.querySelectorAll('[data-onb-sprm]').forEach(b => b.onclick = () => { wiz.speakers.splice(+b.dataset.onbSprm, 1); render(); });
  const spadd = root.querySelector('[data-onb-spadd]'); if (spadd) spadd.onclick = () => { wiz.speakers.push({ name: '', role: '', company: '', photo: '' }); render(); };
  root.querySelectorAll('[data-onb-tpl]').forEach(b => b.onclick = () => { selectSingleTemplate(b.dataset.onbTpl); render(); });
  root.querySelectorAll('[data-onb-pub]').forEach(el => el.addEventListener('change', () => { wiz.publish[el.dataset.onbPub] = el.checked; render(); }));
  const titleEl = root.querySelector('[data-onb-title]'); if (titleEl) titleEl.addEventListener('input', () => { wiz.titleField = titleEl.value; });
  root.querySelectorAll('[data-onb-f]').forEach(el => el.addEventListener('input', () => { wiz.fields[el.dataset.onbF] = el.value; }));
  const back = root.querySelector('[data-onb-back]'); if (back) back.onclick = () => { wiz.step = 1; render(); };
  const next = root.querySelector('[data-onb-next]'); if (next) next.onclick = () => { wiz.step = 3; render(); };
  const finish = root.querySelector('[data-onb-finish]'); if (finish) finish.onclick = () => (wiz.path === 'event' ? finishEvent() : finishSingle());
}

/* ═════════════ finishing: replace the set, keep brand/theme/texture/duotone ═════════════ */
function baseReplace() {
  const cur = X.S, s = JSON.parse(JSON.stringify(cur));
  s.overrides = {};
  return s;
}
function afterBuild(firstPostId, msg) {
  X.changed({ form: true });
  setTimeout(() => {
    Studio.ui.select({ type: 'post', key: firstPostId });
    Studio.ui.fitAll();
  }, 300);
  X.toast(msg);
  close();
}
function finishEvent() {
  const s = baseReplace();
  Object.assign(s, wiz.event);
  s.speakers = wiz.speakers.filter(sp => sp.name.trim());
  X.S = s; // so field defaults (e.g. "*series*?") compute off the new event, not the old one
  const chosen = EVENT_PUBLISH.filter(x => wiz.publish[x.tid]);
  const posts = (chosen.length ? chosen : [EVENT_PUBLISH[0]]).map(x => {
    const p = X.newPost(x.tid);
    if (x.name) p.name = x.name;
    if (x.fields) Object.assign(p.fields, x.fields);
    return p;
  });
  s.posts = posts;
  X.S = X.normalize(s);
  afterBuild(X.S.posts[0].id, 'Campaign ready — click any text to edit');
}
function finishSingle() {
  const s = baseReplace();
  if (wiz.usesTitle && wiz.titleField) s.title = wiz.titleField;
  X.S = s;
  const p = X.newPost(wiz.template);
  Object.assign(p.fields, wiz.fields);
  s.posts = [p];
  X.S = X.normalize(s);
  afterBuild(X.S.posts[0].id, 'Post ready — click any text to edit');
}
function exploreExample() {
  X.S = X.normalize(window.STUDIO_EXAMPLE || {});
  X.changed({ form: true });
  Studio.ui.select(null);
  setTimeout(() => Studio.ui.fitAll(), 300);
  X.toast('Loaded the example — click any text to edit');
  close();
}

/* ═════════════ styles ═════════════ */
let injected = false;
function injectStyles() {
  if (injected) return; injected = true;
  const css = `
  .onb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);display:grid;place-items:center;z-index:50;font:13px/1.45 "Geist",system-ui,sans-serif;animation:onb-fade .15s ease}
  @keyframes onb-fade{from{opacity:0}to{opacity:1}}
  .onb-sheet{background:var(--e-panel);color:var(--e-text);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.35);width:min(520px,92vw);max-height:88vh;overflow:auto;padding:22px 26px 24px;display:grid;gap:14px}
  .onb-head h2{margin:2px 0 0;font-family:"Geist",system-ui;font-size:19px;font-weight:600}
  .onb-steps{display:flex;align-items:center;gap:6px;color:var(--e-muted);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
  .onb-dot{width:6px;height:6px;border-radius:50%;background:var(--e-line)}
  .onb-dot.on{background:var(--e-accent)}
  .onb-steps span{margin-left:4px}
  .onb-warn{margin:6px 0 0;color:var(--e-muted);font-size:12px}
  .onb-warn b{color:var(--e-text)}
  .onb-sub{margin:0;color:var(--e-muted)}
  .onb-choices{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .onb-choice{display:grid;gap:6px;justify-items:start;text-align:left;background:var(--e-field);border:1px solid var(--e-line);border-radius:12px;padding:16px 14px;cursor:pointer;color:var(--e-text);font:inherit}
  .onb-choice:hover{border-color:var(--e-accent);background:color-mix(in srgb,var(--e-accent) 8%,var(--e-field))}
  .onb-choice svg{color:var(--e-accent)}
  .onb-choice b{font-size:14px}
  .onb-choice span{color:var(--e-muted);font-size:12px;line-height:1.4}
  .onb-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px}
  .onb-lnk{border:0;background:none;color:var(--e-sel);font:inherit;cursor:pointer;padding:2px 0}
  .onb-lnk:hover{text-decoration:underline}
  .onb-btn{border:1px solid var(--e-line);background:var(--e-panel);color:var(--e-text);font:inherit;font-weight:500;padding:8px 16px;border-radius:9px;cursor:pointer}
  .onb-btn:hover{border-color:var(--e-muted)}
  .onb-btn.primary{background:var(--e-accent);border-color:var(--e-accent);color:#07140a;font-weight:600;margin-left:auto}
  .onb-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .onb-fld{display:grid;gap:4px;font-size:12px;color:var(--e-muted)}
  .onb-fld.wide{grid-column:1/-1}
  .onb-fld input,.onb-fld textarea{font:inherit;color:var(--e-text);background:var(--e-field);border:1px solid var(--e-line);border-radius:7px;padding:7px 9px;width:100%;box-sizing:border-box}
  .onb-fld input:focus,.onb-fld textarea:focus{outline:2px solid var(--e-sel);outline-offset:-1px}
  .onb-toggle{display:flex;align-items:center;gap:7px;color:var(--e-muted);font-size:12px}
  .onb-overlay input[type=checkbox]{width:auto!important;height:auto!important;box-sizing:content-box;margin:0;flex:none}
  .onb-toggle input{accent-color:var(--e-accent)}
  .onb-sec{display:grid;gap:8px;border-top:1px solid var(--e-line);padding-top:12px}
  .onb-t{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--e-muted)}
  .onb-t small{text-transform:none;font-weight:400;letter-spacing:0;margin-left:6px}
  .onb-sprow{display:grid;grid-template-columns:1fr 1fr 1fr 22px;gap:6px;align-items:center}
  .onb-sprow input{font:inherit;color:var(--e-text);background:var(--e-field);border:1px solid var(--e-line);border-radius:7px;padding:6px 8px}
  .onb-x{border:0;background:none;color:var(--e-muted);cursor:pointer;font-size:15px}
  .onb-x:hover{color:var(--e-warn)}
  .onb-ghost{border:1px dashed var(--e-line);background:none;color:var(--e-muted);font:inherit;padding:7px;border-radius:8px;cursor:pointer;justify-self:start;width:100%}
  .onb-ghost:hover{color:var(--e-text);border-color:var(--e-muted)}
  .onb-checks,.onb-radios{display:grid;gap:8px;max-height:48vh;overflow:auto}
  .onb-check,.onb-radio{display:flex;align-items:flex-start;gap:10px;border:1px solid var(--e-line);border-radius:10px;padding:10px 12px;cursor:pointer;background:var(--e-field)}
  .onb-check.on,.onb-radio.on{border-color:var(--e-accent);background:color-mix(in srgb,var(--e-accent) 7%,var(--e-field))}
  .onb-check input{margin-top:3px;accent-color:var(--e-accent)}
  .onb-radio{font:inherit;color:var(--e-text);text-align:left;width:100%}
  .onb-radio-dot{width:15px;height:15px;border-radius:50%;border:1.5px solid var(--e-muted);margin-top:3px;flex:none;position:relative}
  .onb-radio.on .onb-radio-dot{border-color:var(--e-accent)}
  .onb-radio.on .onb-radio-dot::after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--e-accent)}
  .onb-check-body,.onb-radio-body{display:grid;gap:2px}
  .onb-check-body b,.onb-radio-body b{font-size:13px}
  .onb-check-body span,.onb-radio-body span{color:var(--e-muted);font-size:12px}
  .onb-check-body em,.onb-radio-body em{margin-top:2px}
  .onb-chip{display:inline-block;border:1px solid var(--e-line);border-radius:5px;padding:1px 6px;margin:2px 4px 0 0;font-size:10.5px;color:var(--e-muted);font-style:normal}
  .onb-note{color:var(--e-muted);margin:4px 0}
  `;
  const style = document.createElement('style');
  style.id = 'onb-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

window.StudioOnboarding = { open };

/* ═════════════ first-visit welcome ═════════════ */
try {
  if (!hasOnboarded()) {
    let embedded = '';
    try { const el = document.getElementById('studio-data'); embedded = (el && el.textContent || '').trim(); } catch (e) { /* ignore */ }
    if ((!embedded || embedded === '{}') && !location.hash) {
      setTimeout(() => { try { open({ welcome: true }); } catch (e) { console.warn('Onboarding welcome skipped:', e); } }, 400);
    }
  }
} catch (e) { /* ignore */ }
})();
