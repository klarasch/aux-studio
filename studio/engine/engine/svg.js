/* SVG export: walks the rendered DOM of an asset and emits a real vector SVG (no foreignObject),
   so designers get a Figma/Penpot-friendly fallback. Loaded after Studio.boot(); adds a "SVG"
   caption button (click = copy to clipboard, shift-click = download .svg) and exposes
   window.StudioSVG.toSVG(id) -> Promise<string> for headless use (Playwright, QA scripts). */
(function () {
'use strict';
if (!window.Studio || !Studio.api) return;

const NS = 'http://www.w3.org/2000/svg';
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600;700&family=Work+Sans:wght@400;500;600&display=swap";

/* ───────────── small string / colour helpers ───────────── */
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = s => esc(s).replace(/"/g, '&quot;');

function splitTopLevel(str) {
  const out = []; let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}
function parseColor(s) {
  s = (s || '').trim();
  if (!s || s === 'none') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) { const p = m[1].split(',').map(x => parseFloat(x)); return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p[3] != null ? p[3] : 1 }; }
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }; }
  m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) { const h = m[1]; return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 }; }
  return { r: 0, g: 0, b: 0, a: 1 };
}
const colorToRgba = c => `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a})`;

function parseLinearGradient(str) {
  const m = str && str.match(/^linear-gradient\((.+)\)$/i); if (!m) return null;
  const parts = splitTopLevel(m[1]);
  let dir = 'to bottom';
  if (parts.length && (/^to\s/i.test(parts[0].trim()) || /-?[\d.]+deg\s*$/i.test(parts[0].trim()))) dir = parts.shift().trim();
  const stops = parts.map(p => {
    p = p.trim();
    const pm = p.match(/^(.*)\s(-?[\d.]+%)$/);
    let colorStr = p, pct = null;
    if (pm) { colorStr = pm[1].trim(); pct = parseFloat(pm[2]); }
    return { pct, c: parseColor(colorStr) };
  });
  if (stops.length) { if (stops[0].pct == null) stops[0].pct = 0; if (stops[stops.length - 1].pct == null) stops[stops.length - 1].pct = 100; }
  for (let i = 1; i < stops.length - 1; i++) if (stops[i].pct == null) {
    let j = i + 1; while (stops[j].pct == null) j++;
    stops[i].pct = stops[i - 1].pct + (stops[j].pct - stops[i - 1].pct) / (j - i + 1);
  }
  return { dir, stops };
}
function dirToVector(dir) {
  const kw = {
    'to top': [0, -1], 'to bottom': [0, 1], 'to left': [-1, 0], 'to right': [1, 0],
    'to top left': [-.7071, -.7071], 'to top right': [.7071, -.7071],
    'to bottom left': [-.7071, .7071], 'to bottom right': [.7071, .7071],
  };
  if (kw[dir]) return kw[dir];
  const dm = dir.match(/^(-?[\d.]+)deg$/);
  if (dm) { const a = parseFloat(dm[1]) * Math.PI / 180; return [Math.sin(a), -Math.cos(a)]; }
  return [0, 1];
}

/* ───────────── per-export state ───────────── */
let origin, W, H, uid, usedIds;
function nextId(p) { return `${p}${uid++}`; }
function nameId(base) { let n = base, i = 2; while (usedIds.has(n)) { n = base + (i++); } usedIds.add(n); return n; }
function localRect(el) { const r = el.getBoundingClientRect(); return { x: r.left - origin.x, y: r.top - origin.y, w: r.width, h: r.height }; }
function parseZ(el) { const n = parseInt(getComputedStyle(el).zIndex, 10); return Number.isNaN(n) ? 0 : n; }

function addGradientDef(str, defs, idBase) {
  const g = parseLinearGradient(str); if (!g || !g.stops.length) return null;
  const [dx, dy] = dirToVector(g.dir);
  const x1 = .5 - dx / 2, y1 = .5 - dy / 2, x2 = .5 + dx / 2, y2 = .5 + dy / 2;
  const id = nextId(idBase);
  const stops = g.stops.map(s => `<stop offset="${s.pct}%" stop-color="rgb(${Math.round(s.c.r)},${Math.round(s.c.g)},${Math.round(s.c.b)})" stop-opacity="${s.c.a}"/>`).join('');
  defs.push(`<linearGradient id="${id}" x1="${x1.toFixed(3)}" y1="${y1.toFixed(3)}" x2="${x2.toFixed(3)}" y2="${y2.toFixed(3)}">${stops}</linearGradient>`);
  return id;
}
function addMaskDef(gradStr, rectLocal, defs) {
  const gid = addGradientDef(gradStr, defs, 'mg'); if (!gid) return null;
  const mid = nextId('mask');
  defs.push(`<mask id="${mid}" maskUnits="userSpaceOnUse" x="${rectLocal.x.toFixed(1)}" y="${rectLocal.y.toFixed(1)}" width="${rectLocal.w.toFixed(1)}" height="${rectLocal.h.toFixed(1)}" style="mask-type:alpha" mask-type="alpha"><rect x="${rectLocal.x.toFixed(1)}" y="${rectLocal.y.toFixed(1)}" width="${rectLocal.w.toFixed(1)}" height="${rectLocal.h.toFixed(1)}" fill="url(#${gid})"/></mask>`);
  return mid;
}
function parseClipPolygon(str) {
  const m = str && str.match(/^polygon\(([^)]*)\)$/i); if (!m) return null;
  return splitTopLevel(m[1]).map(pair => { const [xs, ys] = pair.trim().split(/\s+/); return [parseFloat(xs) || 0, parseFloat(ys) || 0]; });
}
function parseBgPos(str) {
  const parts = (str || '50% 50%').trim().split(/\s+/);
  const toFrac = p => { if (!p) return .5; if (p.endsWith('%')) return parseFloat(p) / 100; if (p === 'left' || p === 'top') return 0; if (p === 'right' || p === 'bottom') return 1; if (p === 'center') return .5; const n = parseFloat(p); return Number.isNaN(n) ? .5 : n / 100; };
  return [toFrac(parts[0]), toFrac(parts[1])];
}
function radiusInfo(cs, w, h) {
  const r = parseFloat(cs.borderTopLeftRadius) || 0;
  if (r <= 0) return { rx: 0, circle: false };
  const full = r >= Math.min(w, h) / 2 - .5;
  // only a near-square fully-rounded box (avatar) is a circle; a wide/tall one is a stadium/pill
  if (full && Math.abs(w - h) <= Math.max(w, h) * .12) return { rx: 0, circle: true };
  return { rx: full ? Math.min(w, h) / 2 : r, circle: false };
}
const sizeCache = new Map();
function naturalSize(url) {
  if (sizeCache.has(url)) return sizeCache.get(url);
  const p = new Promise(resolve => {
    const img = new Image();
    const to = setTimeout(() => resolve(null), 6000);
    img.onload = () => { clearTimeout(to); resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 }); };
    img.onerror = () => { clearTimeout(to); resolve(null); };
    img.src = url;
  });
  sizeCache.set(url, p); return p;
}
function coverBox(boxW, boxH, natW, natH, px, py) {
  const scale = Math.max(boxW / natW, boxH / natH);
  const dw = natW * scale, dh = natH * scale;
  return { x: -(dw - boxW) * px, y: -(dh - boxH) * py, w: dw, h: dh };
}
function rectShape(rectLocal, rx, circle, fill, maskId) {
  const extra = maskId ? ` mask="url(#${maskId})"` : '';
  if (circle) return `<circle cx="${(rectLocal.x + rectLocal.w / 2).toFixed(1)}" cy="${(rectLocal.y + rectLocal.h / 2).toFixed(1)}" r="${(Math.min(rectLocal.w, rectLocal.h) / 2).toFixed(1)}" fill="${fill}"${extra}/>`;
  return `<rect x="${rectLocal.x.toFixed(1)}" y="${rectLocal.y.toFixed(1)}" width="${rectLocal.w.toFixed(1)}" height="${rectLocal.h.toFixed(1)}"${rx > 0 ? ` rx="${rx.toFixed(1)}"` : ''} fill="${fill}"${extra}/>`;
}

/* ───────────── background painters: photo / gradient / colour ───────────── */
async function emitBox(el, rectLocal, defs, out) {
  if (rectLocal.w <= 0 || rectLocal.h <= 0) return false;
  const cs = getComputedStyle(el);
  const bgImg = cs.backgroundImage;
  const urlMatch = bgImg && bgImg.match(/url\((['"]?)(.*?)\1\)/);
  // getBoundingClientRect() returns the POST-transform box; a plain axis-aligned rect/circle at that
  // box would be wrong for a rotated/skewed element (only the tiny lockup divider does this today).
  // Skip painting a solid fill there rather than draw a misshapen blob; still emit photos (clipped).
  if (!urlMatch && cs.transform && cs.transform !== 'none') return false;
  const { rx, circle } = radiusInfo(cs, rectLocal.w, rectLocal.h);
  const clipStr = cs.clipPath;
  let clipId = null;
  if (clipStr && clipStr !== 'none') {
    const poly = parseClipPolygon(clipStr);
    if (poly && poly.length) {
      clipId = nextId('clip');
      defs.push(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><polygon points="${poly.map(([x, y]) => `${(x + rectLocal.x).toFixed(1)},${(y + rectLocal.y).toFixed(1)}`).join(' ')}"/></clipPath>`);
    }
  } else if (urlMatch && (rx > 0 || circle)) {
    clipId = nextId('clip');
    const shape = circle
      ? `<circle cx="${(rectLocal.x + rectLocal.w / 2).toFixed(1)}" cy="${(rectLocal.y + rectLocal.h / 2).toFixed(1)}" r="${(Math.min(rectLocal.w, rectLocal.h) / 2).toFixed(1)}"/>`
      : `<rect x="${rectLocal.x.toFixed(1)}" y="${rectLocal.y.toFixed(1)}" width="${rectLocal.w.toFixed(1)}" height="${rectLocal.h.toFixed(1)}" rx="${rx.toFixed(1)}"/>`;
    defs.push(`<clipPath id="${clipId}">${shape}</clipPath>`);
  }
  const maskStr = cs.maskImage && cs.maskImage !== 'none' ? cs.maskImage : (cs.webkitMaskImage && cs.webkitMaskImage !== 'none' ? cs.webkitMaskImage : null);
  const maskId = maskStr ? addMaskDef(maskStr, rectLocal, defs) : null;

  if (urlMatch) {
    const href = urlMatch[2];
    const nat = await naturalSize(href);
    const [px, py] = parseBgPos(cs.backgroundPosition);
    let ix = rectLocal.x, iy = rectLocal.y, iw = rectLocal.w, ih = rectLocal.h;
    if (nat) { const c = coverBox(rectLocal.w, rectLocal.h, nat.w, nat.h, px, py); ix = rectLocal.x + c.x; iy = rectLocal.y + c.y; iw = c.w; ih = c.h; }
    out.push(`<image href="${escAttr(href)}" x="${ix.toFixed(1)}" y="${iy.toFixed(1)}" width="${iw.toFixed(1)}" height="${ih.toFixed(1)}" preserveAspectRatio="none"${clipId ? ` clip-path="url(#${clipId})"` : ''}${maskId ? ` mask="url(#${maskId})"` : ''}/>`);
    return true;
  }
  if (bgImg && bgImg !== 'none' && /linear-gradient/i.test(bgImg)) {
    const gid = addGradientDef(bgImg, defs, 'bg');
    if (gid) { out.push(rectShape(rectLocal, rx, circle, `url(#${gid})`, maskId)); return true; }
  }
  const bg = parseColor(cs.backgroundColor);
  if (bg.a > 0) { out.push(rectShape(rectLocal, rx, circle, colorToRgba(bg), maskId)); return true; }
  return false;
}

/* ───────────── text: line-accurate <text>/<tspan> via Range.getClientRects ───────────── */
function collectTextNodes(el) {
  const nodes = [];
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { if (c.textContent.trim() !== '') nodes.push(c); }
      else if (c.nodeType === 1 && c.tagName !== 'BR') walk(c);
    }
  })(el);
  return nodes;
}
function lineSegments(textNode) {
  const text = textNode.textContent, segs = [], range = document.createRange();
  // curStart only ever advances on an actual line-break flush, so a zero-rect char (whitespace
  // collapsed at an inline-element boundary) that appears before the first "real" char of a
  // segment is still kept in its text slice, instead of being silently dropped.
  let curStart = 0, curTop = null, curRect = null;
  for (let i = 0; i < text.length; i++) {
    range.setStart(textNode, i); range.setEnd(textNode, i + 1);
    const rc = range.getBoundingClientRect();
    if (rc.width === 0 && rc.height === 0) continue;
    const top = Math.round(rc.top);
    if (curTop === null) { curTop = top; curRect = { left: rc.left, right: rc.right, top: rc.top, bottom: rc.bottom }; }
    else if (Math.abs(top - curTop) > 2) {
      segs.push({ text: text.slice(curStart, i), rect: curRect });
      curTop = top; curStart = i; curRect = { left: rc.left, right: rc.right, top: rc.top, bottom: rc.bottom };
    } else {
      curRect.left = Math.min(curRect.left, rc.left); curRect.right = Math.max(curRect.right, rc.right);
      curRect.top = Math.min(curRect.top, rc.top); curRect.bottom = Math.max(curRect.bottom, rc.bottom);
    }
  }
  if (curTop !== null) segs.push({ text: text.slice(curStart), rect: curRect });
  return segs;
}
// font ascent in px, so <text> can be positioned on its real baseline (Figma/Penpot ignore dominant-baseline)
const _asc = new Map(); let _actx;
function ascentPx(r) {
  const font = `${r.fontWeight} ${r.fontSize}px ${r.fontFamily}`;
  if (!_asc.has(font)) { _actx ||= document.createElement('canvas').getContext('2d'); _actx.font = font; const m = _actx.measureText('Hg'); _asc.set(font, m.fontBoundingBoxAscent || r.fontSize * .8); }
  return _asc.get(font);
}
function renderText(el) {
  const nodes = collectTextNodes(el);
  if (!nodes.length) return '';
  // Flatten every text node's per-line segments into one ordered run list (document order == visual
  // left-to-right order for this LTR brand), each carrying its own resolved style.
  const runs = [];
  for (const tn of nodes) {
    const cs = getComputedStyle(tn.parentElement);
    const color = colorToRgba(parseColor(cs.color));
    const fontSize = parseFloat(cs.fontSize) || 16;
    const upper = cs.textTransform === 'uppercase';
    for (const seg of lineSegments(tn)) {
      if (seg.text === '') continue;
      runs.push({ text: upper ? seg.text.toUpperCase() : seg.text, rect: seg.rect, color, fontSize, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing });
    }
  }
  if (!runs.length) return '';
  // Group runs that share a rendered line into one positioned outer <tspan>; the runs inside it are
  // plain (no x/y) so they flow one after another exactly like normal text — this is what keeps an
  // inter-run space (e.g. after a highlighted *word*) from being lost, unlike giving every run its
  // own absolute x, which some SVG-as-<img> renderers re-collapse whitespace around.
  const lines = [];
  for (const r of runs) {
    const top = Math.round(r.rect.top);
    const line = lines[lines.length - 1];
    if (!line || Math.abs(line.top - top) > 2) lines.push({ top, x: r.rect.left, y: r.rect.top, runs: [r] });
    else line.runs.push(r);
  }
  const tspans = lines.map(line => {
    // baseline = top of the line's tallest run content box + that run's ascent
    const big = line.runs.reduce((a, r) => r.fontSize > a.fontSize ? r : a, line.runs[0]);
    const x = (line.x - origin.x).toFixed(1), y = (big.rect.top + ascentPx(big) - origin.y).toFixed(1);
    const inner = line.runs.map(r => `<tspan fill="${r.color}" font-family="${escAttr(r.fontFamily)}" font-size="${r.fontSize.toFixed(1)}" font-weight="${r.fontWeight}" letter-spacing="${r.letterSpacing}">${esc(r.text)}</tspan>`).join('');
    return `<tspan x="${x}" y="${y}">${inner}</tspan>`;
  });
  return `<text xml:space="preserve">${tspans.join('')}</text>`;
}
// replicate the .timeline .ti ::before/::after dot + connector (CSS generated content isn't visible to the DOM walk)
function timelineMarker(el, rectLocal) {
  const root = el.closest('.asset'); if (!root) return '';
  const rcs = getComputedStyle(root);
  const u = parseFloat(rcs.getPropertyValue('--u')) || 1;
  const accent = rcs.getPropertyValue('--t-accent').trim() || '#000';
  const fgSoft = rcs.getPropertyValue('--t-fgSoft').trim() || '#000';
  const fontSize = parseFloat(getComputedStyle(el).fontSize) || 16;
  const dotR = 7 * u, cx = rectLocal.x + 5 * u + dotR, cy = rectLocal.y + .45 * fontSize + dotR;
  const lineX = rectLocal.x + 12 * u, lineTop = cy + dotR, lineBottom = rectLocal.y + rectLocal.h - 2 * u;
  let s = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${dotR.toFixed(1)}" fill="${accent}"/>`;
  if (lineBottom > lineTop) s += `<line x1="${lineX.toFixed(1)}" y1="${lineTop.toFixed(1)}" x2="${lineX.toFixed(1)}" y2="${lineBottom.toFixed(1)}" stroke="${fgSoft}" stroke-opacity=".5" stroke-width="${(2 * u).toFixed(1)}"/>`;
  return s;
}

/* ───────────── inline the brand logo (currentColor / var(--t-logoAccent) → concrete colours) ───────────── */
function inlineLogo(svgEl) {
  const clone = svgEl.cloneNode(true);
  const origShapes = svgEl.querySelectorAll('path,circle,rect,ellipse,polygon,line');
  const cloneShapes = clone.querySelectorAll('path,circle,rect,ellipse,polygon,line');
  origShapes.forEach((o, i) => {
    const c = cloneShapes[i], cs = getComputedStyle(o);
    c.setAttribute('fill', cs.fill && cs.fill !== 'none' ? cs.fill : 'none');
    if (cs.stroke && cs.stroke !== 'none') c.setAttribute('stroke', cs.stroke);
    c.removeAttribute('style');
  });
  clone.removeAttribute('class'); clone.removeAttribute('aria-hidden');
  const r = localRect(svgEl);
  clone.setAttribute('x', r.x.toFixed(1)); clone.setAttribute('y', r.y.toFixed(1));
  clone.setAttribute('width', r.w.toFixed(1)); clone.setAttribute('height', r.h.toFixed(1));
  return `<g id="${nameId('logo-lockup')}">${clone.outerHTML}</g>`;
}

/* ───────────── text-container detection (pure-inline subtree: text, em, span, b, small…) ───────────── */
const INLINE_TAGS = new Set(['SPAN', 'EM', 'B', 'STRONG', 'SMALL', 'I', 'BR']);
function hasOwnBox(el) {
  const cs = getComputedStyle(el);
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  return parseColor(cs.backgroundColor).a > 0;
}
// an inline-tagged child (span/em/…) still needs its own box treatment (chip/pill background,
// the foot arrow circle, …) rather than being merged as plain text — only merge boxless runs.
function isPureInline(el) {
  for (const c of el.children) { if (!INLINE_TAGS.has(c.tagName) || hasOwnBox(c) || !isPureInline(c)) return false; }
  return true;
}
function isTextContainer(el) {
  if (!el.textContent || !el.textContent.trim()) return false;
  return el.children.length === 0 || isPureInline(el);
}
function pickLayerName(el) {
  const map = {
    content: 'content', top: 'top', speakers: 'speakers', 'sp-card': 'speaker', 'sp-dot': 'speaker',
    meta: 'meta', stats: 'stats', timeline: 'timeline', agenda: 'agenda', lockup: 'logo-lockup',
    foot: 'footer', panel: 'photo', shade: 'shade', quote: 'text-quote', desc: 'text-description',
    kicker: 'text-kicker', bigdate: 'text-date', body: 'text-body',
  };
  for (const cls in map) if (el.classList && el.classList.contains(cls)) return map[cls];
  if (el.tagName === 'H1') return 'text-title';
  return null;
}

/* ───────────── walk ───────────── */
async function visit(el, defs, out) {
  if (el.nodeType !== 1 || el.tagName === 'BR' || el.classList.contains('avoid')) return;
  let cs0;
  try { cs0 = getComputedStyle(el); } catch { return; }
  if (cs0.display === 'none' || cs0.visibility === 'hidden') return;
  if (el.tagName.toLowerCase() === 'svg') { // SVGElement.tagName is lower-case, unlike HTML elements
    try {
      if (el.classList.contains('motif')) out.push(`<g id="${nameId('motif')}">${el.innerHTML}</g>`);
      else if (el.classList.contains('grid-tex')) out.push(`<g id="${nameId('texture')}">${el.innerHTML}</g>`);
      else out.push(inlineLogo(el));
    } catch (e) { console.warn('svg.js: logo/motif inline failed', e); }
    return;
  }
  const rectLocal = localRect(el);
  const layerName = pickLayerName(el);
  const buf = [];
  try { await emitBox(el, rectLocal, defs, buf); } catch (e) { console.warn('svg.js: box paint failed', e); }
  if (isTextContainer(el)) {
    try {
      const markup = renderText(el);
      if (markup) buf.push(markup);
      if (el.classList.contains('ti')) buf.push(timelineMarker(el, rectLocal));
    } catch (e) { console.warn('svg.js: text render failed', e); }
  } else {
    const children = [...el.children].sort((a, b) => parseZ(a) - parseZ(b));
    for (const c of children) await visit(c, defs, buf);
  }
  if (!buf.length) return;
  if (layerName) out.push(`<g id="${nameId(layerName)}">${buf.join('')}</g>`);
  else out.push(buf.join(''));
}

function renderBackground(node, defs) {
  const cs = getComputedStyle(node);
  const bg = parseColor(cs.backgroundColor);
  const out = [`<rect x="0" y="0" width="${W}" height="${H}" fill="${colorToRgba(bg.a > 0 ? bg : { r: 255, g: 255, b: 255, a: 1 })}"/>`];
  if (node.classList.contains('tex')) {
    const u = parseFloat(cs.getPropertyValue('--u')) || 1;
    const chip = (cs.getPropertyValue('--t-chip') || '').trim() || 'rgba(0,0,0,.08)';
    const tile = 44 * u, r = 2.2 * u, off = 22 * u;
    const pid = nextId('texpat');
    defs.push(`<pattern id="${pid}" x="0" y="0" width="${tile.toFixed(1)}" height="${tile.toFixed(1)}" patternUnits="userSpaceOnUse"><circle cx="${off.toFixed(1)}" cy="${off.toFixed(1)}" r="${r.toFixed(1)}" fill="${chip}"/></pattern>`);
    out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#${pid})"/>`);
  }
  return `<g id="${nameId('background')}">${out.join('')}</g>`;
}

/* ───────────── public entry point ───────────── */
async function toSVG(id) {
  const { a, node, done } = await Studio.api.renderNode(id);
  try {
    const r = node.getBoundingClientRect();
    origin = { x: r.left, y: r.top }; W = a.fmt.w; H = a.fmt.h; uid = 0; usedIds = new Set();
    const defs = [], out = [];
    out.push(renderBackground(node, defs));
    const children = [...node.children].sort((x, y) => parseZ(x) - parseZ(y));
    for (const c of children) await visit(c, defs, out);
    const style = `<style>@import url('${esc(FONT_CSS)}');</style>`;
    return `<svg xmlns="${NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${style}<defs>${defs.join('')}</defs>${out.join('')}</svg>`;
  } finally { done(); }
}

window.StudioSVG = { toSVG };

/* ───────────── caption button: click = copy, shift-click = download ───────────── */
async function downloadSVG(id) {
  Studio.api.toast('Building SVG…');
  try {
    const svg = await toSVG(id);
    const asset = Studio.api.list().find(x => x.id === id);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = (asset ? asset.name : id) + '.svg'; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    Studio.api.toast('Downloaded ' + (asset ? asset.name : id) + '.svg' + (/href="https?:/.test(svg) ? ' (remote images linked)' : ''));
  } catch (e) { console.error(e); Studio.api.toast('SVG export failed: ' + e.message); }
}
// shift-click intercepted in the capture phase, before the engine's own click handler runs the action's `run`
document.addEventListener('click', e => {
  const ext = e.target.closest('[data-ext="svg"]');
  if (!ext || !e.shiftKey) return;
  const card = ext.closest('.card'); if (!card) return;
  e.stopPropagation();
  downloadSVG(card.dataset.id);
}, true);

Studio.api.addAction({
  id: 'svg', label: 'SVG', title: 'Copy SVG for Figma/Penpot (click) · Shift-click to download .svg',
  run: async (id) => {
    Studio.api.toast('Building SVG…');
    try {
      const svg = await toSVG(id);
      await navigator.clipboard.writeText(svg);
      Studio.api.toast('SVG copied — paste into Figma/Penpot' + (/href="https?:/.test(svg) ? ' (remote images linked, not embedded)' : ''));
    } catch (e) { console.error(e); Studio.api.toast('SVG export failed: ' + e.message); }
  },
});
})();
