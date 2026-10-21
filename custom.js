/* AUX behaviour: graphics (backdrops), cover photo window, grid texture, text wrap, outline knockout.
   Ours (see FORK.md); no upstream update touches this file. Runs on the settle hook (Studio.boards.onSettle).
   Ported from the prototype's brands/asociace-ux/brand.js, engine/studio.js and engine/texture.js.

   A template names its default graphic on the board:
     data-aux-backdrop="rotated"          one id (or a list "rotated corner": tried in order, the first that fits is kept)
     data-aux-backdrop="auto"             by size kind and speaker count (AUTO below, the prototype's table)
     data-aux-backdrop="none"             nothing
     data-aux-backdrop="chevron-low@ig-story corner"   "id@size" counts only on that size (id or kind)
     data-aux-anchor="bottom"             where a story's frame sits (top | center | bottom); default center
     data-aux-photo="own"                 the photo in the cover slot does not switch to the photo graphics (a speaker page)
   and offers the choice to people as parts (choices "graphic" and "texture", registered below):
     data-opt-graphic="…"   a pick overrides the template; "auto" leaves it to the template
     data-opt-texture="off" switches the grid texture off
   A cover photo (figure.media[data-p="cover"], first child of the board) is the photo window of the photo graphics;
   with "auto" and a photo in it, the photo graphics are tried before the template's own list.

   Per board, in order: the graphic (an <svg class="aux-backdrop"> as first child), the texture, the photo window,
   the top shift when the graphic sits on the text column's top, then text wrap around its solid shapes; after layout
   the next candidate is tried if text still touches a shape, and outlines are cut where text sits. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  /* ── the choices every template shares ── */
  const GRAPHICS = [
    ['Shapes', { 'chevron-low': 'Chevron low', 'chevron-high': 'Chevron high', cross: 'Cross', rotated: 'Rotated' }],
    ['Subtle', { corner: 'Corner', lines: 'Lines', plain: 'Plain' }],
    ['With a photo', { 'photo-cut': 'Photo cut', 'photo-chevron': 'Photo chevron', 'photo-rotated': 'Photo band', photo: 'Full photo' }],
  ];
  Studio.boards.choices.graphic = [{ id: 'auto', label: 'Auto' }, ...GRAPHICS.flatMap(([group, m]) => Object.entries(m).map(([id, label]) => ({ id, label, group })))];
  Studio.boards.choices.texture = [{ id: 'on', label: 'Grid texture' }, { id: 'off', label: 'None' }];

  /* ── geometry ──
     In u (u = frame height; frame width / .778 for stories), x measured from the RIGHT edge, y from the top.
     Every strip is .243u wide at a 0.8 slope (dx/dy). Same data as the prototype's brand.js. */
  const BACKDROPS = {
    'chevron-low':  { band: { x: .762, y: .500, cut: 'top', s: .8 }, dot: { x: .390, y: .500, r: .052 }, outline: { x: .276, y: .497, cut: 'bottom', s: .8 } },
    'chevron-high': { storyAnchor: 'top', band: { x: .744, y: .470, cut: 'bottom', s: -.8 }, dot: { x: .283, y: .500, r: .100 }, outline: { x: .744, y: .530, cut: 'top', s: .8 } },
    'cross':        { band: { x: .582, y: .751, cut: 'bottom', s: -.8 }, dot: { x: .531, y: .357, r: .051 }, outline: { x: .577, y: .450, cut: 'top', s: .8, fg: true } },
    'rotated':      { rotated: { x: .437, y: .377, y2: .619, t: -.75 }, dot: { x: .609, y: .499, r: .106 }, lines: [{ x: .437, y: .619, t: .8 }, { x: .286, y: .501, t: .8 }] },
    'corner':       { band: { x: .30, y: .86, cut: 'top', s: .8 }, outline: { x: .30, y: .86, cut: 'bottom', s: -.8 }, dot: { x: .336, y: .812, r: .04 } },
    'lines':        { outline: { x: .40, y: .60, cut: 'top', s: .8 }, dot: { x: .10, y: .552, r: .036 } },
    'photo-cut':    { storyAnchor: 'top', photo: { x: .690, y: .646, cut: 'bottom', s: -.8, wd: .456 }, dot: { x: .404, y: .157, r: .081 }, outline: { x: .546, y: .470, y2: .877, s: .8, wd: .163 } },
    'photo-chevron': { photo: { x: .762, y: .500, cut: 'top', s: .8, wd: .456 }, dot: { x: .25, y: .455, r: .045 }, outline: { x: .276, y: .497, cut: 'bottom', s: .8 } },
    'photo-rotated': { rotated: { x: .437, y: .377, y2: .619, t: -.75 }, rotatedPhoto: true, dot: { x: .609, y: .499, r: .106 }, lines: [{ x: .437, y: .619, t: .8 }, { x: .286, y: .501, t: .8 }] },
    'photo':        { full: true },
    'plain':        {},
  };
  const PHOTO = ['photo-cut', 'photo-chevron', 'photo-rotated', 'photo'];

  /* The prototype's choice by size kind and number of speakers (candidates in order). */
  const AUTO = {
    landscape: n => n <= 2 ? ['chevron-low', 'lines'] : ['lines', 'corner'],
    square:    n => n <= 1 ? ['rotated', 'corner', 'lines'] : ['corner', 'lines'],
    portrait:  n => n <= 2 ? ['rotated', 'corner', 'lines'] : ['corner', 'lines'],
    story:     n => n <= 2 ? ['rotated', 'corner', 'lines'] : ['corner', 'lines'],
  };
  // the prototype's per-kind scale (its SCALE[kind].u): gaps, padding and the texture's grid step
  const U = { portrait: 1.25, square: 1.15, story: 1.25, landscape: 1 };

  const pathOf = (pl, closed) => `M${pl.map(p => p.map(v => +v.toFixed(1)).join(',')).join(' L')}${closed ? ' Z' : ''}`;
  const pts = a => a.map(p => p.map(v => +v.toFixed(1)).join(',')).join(' ');
  const el = (name, attrs) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const kindU = kind => U[kind] || 1;

  function geometry(b, w, h, kind, anchor) {
    const u = kind === 'story' ? w / .778 : h, W = .243;
    const a = b.storyAnchor || anchor;
    const offY = kind === 'story' ? (a === 'center' ? (h - u) / 2 : a === 'top' ? 0 : h - u) : 0;
    const X = xr => w - xr * u, Y = y => offY + y * u;
    const sw = Math.max(2, u * .0027);
    const strip = (o, wd = W) => { // a strip cut horizontally at y (and y2 if closed), otherwise running off the frame
      const y1 = Y(o.y), yEnd = o.y2 != null ? Y(o.y2) : (o.cut === 'top' ? h + 2 : -2), dy = yEnd - y1;
      const p1 = [X(o.x), y1], p2 = [X(o.x - wd), y1], p3 = [p2[0] + o.s * dy, yEnd], p4 = [p1[0] + o.s * dy, yEnd];
      return { poly: [p1, p2, p3, p4], open: o.y2 == null };
    };
    const items = [], shapes = [];
    let photo = null;
    if (b.full) photo = { full: true };
    if (b.photo) { const pp = strip(b.photo, b.photo.wd).poly; photo = { poly: pp }; shapes.push({ poly: pp }); }
    if (b.outline) {
      const st = strip(b.outline, b.outline.wd || W), [p1, p2, p3, p4] = st.poly;
      items.push({ t: 'ol', fg: !!b.outline.fg, pl: st.open ? [p4, p1, p2, p3] : st.poly, closed: !st.open });
    }
    if (b.lines) for (const l of b.lines) { const x0 = X(l.x), y0 = Y(l.y); items.push({ t: 'ol', pl: [[x0, y0], [w + 2, y0 + l.t * (w + 2 - x0)]], closed: false }); }
    if (b.band) { const pb = strip(b.band).poly; shapes.push({ poly: pb }); items.push({ t: 'band', pts: pts(pb) }); }
    if (b.rotated) {
      const r = b.rotated, x0 = X(r.x), ya = Y(r.y), yb = Y(r.y2), x1 = w + 2;
      const pr = [[x0, ya], [x1, ya + r.t * (x1 - x0)], [x1, yb + r.t * (x1 - x0)], [x0, yb]];
      shapes.push({ poly: pr });
      if (b.rotatedPhoto) photo = { poly: pr }; else items.push({ t: 'band', pts: pts(pr) });
    }
    if (b.dot) { const c = [X(b.dot.x), Y(b.dot.y), b.dot.r * u]; shapes.push({ circle: c }); items.push({ t: 'dot', c }); }
    return { items, shapes, photo, sw };
  }

  /* ── board geometry helpers (px of the unscaled board) ── */
  const boardK = node => { const r = node.getBoundingClientRect(); return { r, k: r.width ? node.offsetWidth / r.width : 1 }; };
  const tok = (node, name) => getComputedStyle(node).getPropertyValue(name).trim();

  function shapeSpanLeft(sh, y) { // leftmost x a solid shape occupies on row y (or null)
    if (sh.circle) { const [cx, cy, r] = sh.circle, dy = y - cy; return Math.abs(dy) < r ? cx - Math.sqrt(r * r - dy * dy) : null; }
    const P = sh.poly, xs = [];
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [x1, y1] = P[j], [x2, y2] = P[i]; if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1)); }
    return xs.length ? Math.min(...xs) : null;
  }
  const shapesOf = node => { try { return JSON.parse(node.getAttribute('data-shapes') || '[]'); } catch (e) { return []; } };

  /* ── the grid texture: a quiet field of "+" marks with the odd "/", strongest next to the solid shapes ── */
  function texture(w, h, u, shapes, col) {
    const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x, smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
    const inPoly = (px, py, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c; } return c; };
    const seg = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; const t = l2 ? clamp01(((px - ax) * dx + (py - ay) * dy) / l2) : 0; return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); };
    const near = (px, py, list) => {
      let dist = Infinity;
      for (const s of list) {
        if (s.circle) { const [cx, cy, r] = s.circle, d = Math.hypot(px - cx, py - cy); if (d < r) return null; dist = Math.min(dist, d - r); continue; }
        if (inPoly(px, py, s.poly)) return null;
        for (let i = 0, j = s.poly.length - 1; i < s.poly.length; j = i++) dist = Math.min(dist, seg(px, py, s.poly[i][0], s.poly[i][1], s.poly[j][0], s.poly[j][1]));
      }
      return dist;
    };
    const LEVELS = 6, step = Math.round(46 * u), arm = 4.5 * u, sw = Math.max(1.4, 1.5 * u), dy = 7 * u;
    let seed = w * 7 + h * 13; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const has = shapes.length > 0, eff = has ? shapes : [{ circle: [w, h, 0] }], R = has ? .55 * Math.min(w, h) : .8 * Math.max(w, h);
    const gMax = col.grid * .75, gMin = .03, aMax = col.accent * .72, aMin = .04;
    const plus = Array.from({ length: LEVELS }, () => ''), slash = Array.from({ length: LEVELS }, () => '');
    for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) {
      const d = near(x, y, eff); if (d == null) continue; // never mark on top of a solid shape
      const g = 1 - smooth(0, R, Math.min(d, R)), lvl = Math.min(LEVELS - 1, Math.floor(g * LEVELS)), r = rnd();
      const slashP = .035 + .085 * g, gapP = .06 + .12 * (1 - g);
      if (r < slashP) slash[lvl] += `M${(x - dy * .8).toFixed(1)} ${(y + dy).toFixed(1)}L${(x + dy * .8).toFixed(1)} ${(y - dy).toFixed(1)}`;
      else if (r < slashP + .03) plus[lvl] += `M${(x - arm * 1.6).toFixed(1)} ${y}H${(x + arm * 1.6).toFixed(1)}`;
      else if (r < slashP + .03 + gapP) continue;
      else plus[lvl] += `M${(x - arm).toFixed(1)} ${y}H${(x + arm).toFixed(1)}M${x} ${(y - arm).toFixed(1)}V${(y + arm).toFixed(1)}`;
    }
    const svg = el('svg', { class: 'aux-texture', viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true', 'data-gen': '', 'data-ui': '' });
    for (let i = 0; i < LEVELS; i++) if (plus[i]) svg.append(el('path', { d: plus[i], stroke: col.fg, 'stroke-opacity': (gMin + (gMax - gMin) * (i + .5) / LEVELS).toFixed(3), 'stroke-width': sw, fill: 'none' }));
    for (let i = 0; i < LEVELS; i++) if (slash[i]) svg.append(el('path', { d: slash[i], stroke: col.accentLine, 'stroke-opacity': (aMin + (aMax - aMin) * (i + .5) / LEVELS).toFixed(3), 'stroke-width': sw, fill: 'none' }));
    return svg;
  }

  /* ── the graphic ── */
  function candidates(node, info) {
    const opt = node.dataset.optGraphic || 'auto';
    if (opt !== 'auto') return [opt];
    const here = list => list.split(/\s+/).filter(Boolean).filter(c => !c.includes('@') || c.split('@')[1] === info.size.id || c.split('@')[1] === info.size.kind).map(c => c.split('@')[0]);
    // Auto never picks a graphic the board does not offer (data-choices-graphic, the list the menu shows)
    const offered = node.dataset.choicesGraphic != null ? here(node.dataset.choicesGraphic) : null, ok = l => offered ? l.filter(c => offered.includes(c)) : l;
    // a cover photo puts the photo graphics first, unless the board keeps its own list (a speaker page: photo-cut, photo)
    if (node.dataset.auxPhoto !== 'own' && node.querySelector('figure.aux-cover img') && ok(PHOTO).length) return ok(PHOTO);
    const spec = (node.dataset.auxBackdrop || '').trim();
    if (!spec || spec === 'none') return [];
    if (spec === 'auto') { const l = ok((AUTO[info.size.kind] || AUTO.portrait)(node.querySelectorAll('.aux-person').length)); return l.length ? l : offered || []; }
    return here(spec);
  }

  function clear(node) {
    node.querySelectorAll(':scope > .aux-backdrop, :scope > .aux-texture, :scope > .aux-shade, :scope > .aux-fade, .wrapf').forEach(e => e.remove());
    node.querySelectorAll('.wrapbox').forEach(e => e.classList.remove('wrapbox'));
    node.style.removeProperty('padding-top'); node.style.removeProperty('padding-bottom');
    node.querySelectorAll('[data-aux-fit]').forEach(e => e.style.removeProperty('font-size'));
    const lk = node.querySelector('.aux-lockup');
    if (lk) { lk.classList.remove('parked'); lk.removeAttribute('data-ui'); ['position', 'left', 'top'].forEach(p => lk.style.removeProperty(p)); }
    node.querySelectorAll('.aux-pill').forEach(e => e.setAttribute('data-ui', '')); // an overlay on purpose: not part of the overflow check
    node.removeAttribute('data-shapes'); node.removeAttribute('data-aux-tight'); node.removeAttribute('data-aux-stack');
  }

  // the graphic leaves the text about a third of the board or less, or the groups do not fit the room at their natural gaps:
  // custom.css closes the gaps, sets the event title smaller and puts the speakers side by side (data-aux-tight), before
  // any type has to give way. The second test is only for boards that spread an .aux-top and an .aux-bottom.
  function tighten(node, h, kind) {
    const top = parseFloat(node.style.paddingTop) || parseFloat(tok(node, '--safe-t')) || 0, bot = parseFloat(node.style.paddingBottom) || parseFloat(tok(node, '--safe-b')) || 0;
    let tight = h - top - bot < h * .36;
    const tg = node.querySelector(':scope > .aux-top'), bg = node.querySelector(':scope > .aux-bottom');
    if (!tight && tg && bg && kind !== 'landscape') {
      node.removeAttribute('data-aux-tight');
      tight = tg.offsetHeight + bg.offsetHeight + 30 * kindU(kind) > h - top - bot;
    }
    node.toggleAttribute('data-aux-tight', tight);
  }

  // speakers that reach a shape beside the column (the pale dot above a photo window, the corner's dot next to a solo speaker)
  // keep to the left of it: data-aux-stack (custom.css) sets side-by-side speakers one under the other, round photos in two
  // rows, a solo speaker smaller. That keeps the title's size, where fit would shrink the title for a hit it does not cause.
  function stackSpeakers(node, info) {
    const sp = node.querySelector('.aux-speakers');
    if (!sp || !hitsShapes(node, 6, sp)) return false;
    node.setAttribute('data-aux-stack', ''); window.makeitbrand?.check?.(node); wrap(node, info);
    if (hitsShapes(node, 6, sp)) { node.removeAttribute('data-aux-stack'); window.makeitbrand?.check?.(node); wrap(node, info); return false; }
    return true;
  }

  // where the text column starts when the graphic sits on its top: below the shapes that reach into the top left
  function topShift(node, shapes, w, h, kind, u) {
    if (!shapes.length || kind === 'landscape') return 0;
    const top = parseFloat(tok(node, '--safe-t')) || 0, colR = w * .55, gap = 30 * u;
    let minY = Infinity, maxY = -Infinity;
    for (const sh of shapes) {
      if (sh.circle) { const [cx, cy, r] = sh.circle; if (cx - r < colR) { minY = Math.min(minY, cy - r); maxY = Math.max(maxY, cy + r); } continue; }
      for (let y = 0; y <= h; y += 8) { const L = shapeSpanLeft(sh, y); if (L != null && L < colR) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); } }
    }
    return minY < h * .22 && maxY + gap > top ? Math.min(maxY + gap, h * .8) : 0;
  }

  // the lockup goes back to the free top-left corner when the text had to start lower
  function parkLockup(node, shapes, u) {
    const lk = node.querySelector('.aux-lockup'); if (!lk || !node.style.paddingTop) return;
    const padT = parseFloat(tok(node, '--safe-t')) || 0, padL = parseFloat(tok(node, '--safe-l')) || 0, { r: nb, k } = boardK(node), lb = lk.getBoundingClientRect();
    const lw = Math.max(lb.width * k, lb.height * k * 5.2); // at least the mark and "UXMONDAY" wide, in case the fonts are not loaded yet
    const R = [padL - 20 * u, padT - 20 * u, padL + lw + 20 * u, padT + lb.height * k + 20 * u];
    const hit = shapes.some(sh => {
      if (sh.circle) { const [cx, cy, r] = sh.circle, dx = Math.max(R[0] - cx, 0, cx - R[2]), dy = Math.max(R[1] - cy, 0, cy - R[3]); return dx * dx + dy * dy < r * r; }
      for (let y = R[1]; y <= R[3]; y += 6) { const L = shapeSpanLeft(sh, y); if (L != null && L < R[2]) return true; }
      return false;
    });
    if (hit) return;
    lk.classList.add('parked'); lk.setAttribute('data-ui', ''); lk.style.position = 'absolute'; lk.style.left = padL + 'px'; lk.style.top = padT + 'px';
  }

  function render(node, info, id) {
    clear(node);
    const { w, h, kind } = info.size, u = kindU(kind), b = BACKDROPS[id] || BACKDROPS.plain;
    const g = geometry(b, w, h, kind, node.dataset.auxAnchor || 'center');
    const col = { band: tok(node, '--aux-band'), dot: tok(node, '--aux-dot'), line: tok(node, '--aux-line'), lineFg: tok(node, '--aux-line-fg') };

    const svg = el('svg', { class: 'aux-backdrop', viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true', 'data-gen': '', 'data-ui': '', 'data-backdrop': id });
    for (const it of g.items) {
      if (it.t === 'ol') {
        const pa = el('path', { class: 'ol', d: pathOf(it.pl, it.closed), fill: 'none', stroke: it.fg ? col.lineFg : col.line, 'stroke-width': g.sw });
        pa._pl = it.pl; pa._closed = it.closed; svg.append(pa);
      }
      else if (it.t === 'band') svg.append(el('polygon', { points: it.pts, fill: col.band }));
      else if (it.t === 'dot') svg.append(el('circle', { cx: it.c[0], cy: it.c[1], r: it.c[2], fill: col.dot }));
    }
    node.prepend(svg);
    node.setAttribute('data-shapes', JSON.stringify(g.shapes.map(s => s.poly ? { poly: s.poly.map(p => p.map(Math.round)) } : { circle: s.circle.map(Math.round) })));

    if (node.dataset.optTexture !== 'off') {
      node.prepend(texture(w, h, u, JSON.parse(node.getAttribute('data-shapes')),
        { fg: tok(node, '--g-fg'), accentLine: tok(node, '--aux-line'), grid: parseFloat(tok(node, '--aux-grid-opacity')) || .16, accent: parseFloat(tok(node, '--aux-grid-accent-opacity')) || .4 }));
    }

    // the cover photo's window: shaped by the graphic, or hidden when the graphic has none
    const fig = node.querySelector(':scope > figure.aux-cover');
    if (fig) {
      const ph = g.photo;
      fig.setAttribute('data-ui', ''); // the window reaches past the content box on purpose: the runtime's overflow check skips it
      ['left', 'top', 'width', 'height', 'clip-path', 'z-index', 'display'].forEach(p => fig.style.removeProperty(p));
      if (!ph) fig.style.display = 'none';
      else if (ph.full) {
        const frac = (parseFloat(node.dataset.auxPhotoH) || 100) / 100, ph2 = Math.round(h * (kind === 'landscape' ? 1 : frac));
        fig.style.cssText += `;left:0;top:0;width:${w}px;height:${ph2}px;z-index:-3`;
        const shade = document.createElement('div'); shade.setAttribute('data-gen', ''); shade.setAttribute('data-ui', '');
        if (frac < 1) { // the photo melts into the ground: a fade over its lower part (its left part on landscape)
          shade.className = 'aux-fade';
          shade.style.cssText = kind === 'landscape'
            ? `left:0;top:0;width:${Math.round(w * .6)}px;height:${h}px;background:linear-gradient(to right, var(--bg) 0%, var(--bg) 25%, transparent 100%)`
            : `left:0;top:${Math.round(ph2 * .55)}px;width:${w}px;height:${Math.round(ph2 * .45) + 2}px;background:linear-gradient(to bottom, transparent, var(--bg))`;
        } else shade.className = 'aux-shade';
        fig.after(shade);
      } else {
        const xs = ph.poly.map(p => p[0]), ys = ph.poly.map(p => p[1]);
        const bx = Math.max(0, Math.min(...xs)), by = Math.max(0, Math.min(...ys)), bw = Math.min(w, Math.max(...xs)) - bx, bh = Math.min(h, Math.max(...ys)) - by;
        fig.style.cssText += `;left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px;z-index:1;clip-path:polygon(${ph.poly.map(([x, y]) => `${(x - bx).toFixed(1)}px ${(y - by).toFixed(1)}px`).join(',')})`;
      }
    }

    const zt = topShift(node, g.shapes, w, h, kind, u);
    if (zt) { node.style.paddingTop = zt.toFixed(0) + 'px'; tighten(node, h, kind); parkLockup(node, g.shapes, u); }
  }

  /* ── free zones: when a graphic blocks the rows the text sits on (a chevron under a bottom-anchored headline), the text
     moves into the largest band of rows the shapes leave free, instead of running under the shape. Used for the last
     candidate only (a pick by a person, or the template's fallback): Auto still prefers a graphic the text clears as written. ── */
  function freeZones(node, shapes, w, h, kind, u) {
    const top = parseFloat(tok(node, '--safe-t')) || 0, bot = h - (parseFloat(tok(node, '--safe-b')) || 0), cl = parseFloat(tok(node, '--safe-l')) || 0;
    const cw = (w - cl - (parseFloat(tok(node, '--safe-r')) || 0)) * (kind === 'landscape' ? .55 : 1), gap = 26 * u, zones = [];
    let cur = null;
    for (let y = top; y <= bot; y += 6) {
      let xl = cw;
      for (const sh of shapes) {
        const L = shapeSpanLeft(sh, y); if (L == null) continue;
        const R = sh.circle ? sh.circle[0] + sh.circle[2] : Math.max(...sh.poly.map(p => p[0]));
        if (R >= cl) xl = Math.min(xl, Math.max(0, L - cl - gap));
      }
      if (xl < cw * .45) cur = null; else if (cur) cur[1] = y; else zones.push(cur = [y, y]);
    }
    return { top, bot, zones };
  }
  function rezone(node, info) {
    const shapes = shapesOf(node); if (!shapes.length) return false;
    const { w, h, kind } = info.size, u = kindU(kind), { top, bot, zones } = freeZones(node, shapes, w, h, kind, u);
    if (zones.length === 1 && zones[0][0] <= top && zones[0][1] >= bot - 6) return false; // nothing is blocked
    const air = 20 * u, byRoom = zones.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])), z = byRoom[0];
    if (!z || z[1] - z[0] < h * .2) return false;
    const lk = node.querySelector('.aux-lockup');
    node.querySelectorAll('[data-aux-fit]').forEach(e => e.style.removeProperty('font-size'));
    if (lk) { lk.classList.remove('parked'); lk.removeAttribute('data-ui'); ['position', 'left', 'top'].forEach(p => lk.style.removeProperty(p)); }
    // Both groups of a spread board (.aux-top above, .aux-bottom below) in one band, or split: the top group in the first free
    // band, the bottom group in the last (a rotated band across the middle leaves a band above it and one below it, and one
    // band of the two is too short for all of it). Whichever leaves less text without room wins; one band on a tie.
    const tg = node.querySelector(':scope > .aux-top'), bg = node.querySelector(':scope > .aux-bottom'), zt = zones[0], zb = zones.at(-1);
    const single = () => {
      if (z[0] > top + 6) node.style.paddingTop = (z[0] + air).toFixed(0) + 'px'; else node.style.removeProperty('padding-top');
      if (z[1] < bot - 6) node.style.paddingBottom = (h - z[1] + air).toFixed(0) + 'px'; else node.style.removeProperty('padding-bottom');
      tighten(node, h, kind);
    };
    let split = false;
    if (tg && bg && zt !== zb && kind !== 'landscape') {
      const need = t => { node.toggleAttribute('data-aux-tight', t); return [tg.offsetHeight, bg.offsetHeight]; };
      const tAvail = zt[1] - air - (zt[0] > top + 6 ? zt[0] + air : top), bAvail = (zb[1] < bot - 6 ? zb[1] - air : bot) - zb[0] - air;
      const one = t => { const [a, c] = need(t); return Math.max(0, a + c + 24 * u - (z[1] - z[0] - 2 * air)); };
      const two = t => { const [a, c] = need(t); return Math.max(0, a - tAvail) + Math.max(0, c - bAvail); };
      const best = f => { const p = f(false), q = f(true); return p <= 0 || p <= q ? [p, false] : [q, true]; };
      const [d1] = best(one), [d2, t2] = best(two);
      if (d2 < d1) {
        node.toggleAttribute('data-aux-tight', t2);
        if (zt[0] > top + 6) node.style.paddingTop = (zt[0] + air).toFixed(0) + 'px'; else node.style.removeProperty('padding-top');
        if (zb[1] < bot - 6) node.style.paddingBottom = (h - zb[1] + air).toFixed(0) + 'px'; else node.style.removeProperty('padding-bottom');
        wrap(node, info); split = !hitsShapes(node); // chips and speakers do not wrap: a band too narrow for them is no band
      }
    }
    if (!split) single();
    parkLockup(node, shapes, u);
    wrap(node, info);
    return true;
  }

  /* ── text wrap: each paragraph gets a right float whose shape-outside follows the free space left of the shapes ── */
  const WRAP_SEL = 'h1, .lead, .eyebrow, .body, .quote, .aux-desc, .aux-role, .aux-quote, .aux-bignum';
  function wrap(node, info) {
    node.querySelectorAll('.wrapf').forEach(f => f.remove());
    node._blocked = false; // set when a paragraph had to skip rows because a shape leaves less than half the column
    const shapes = shapesOf(node); if (!shapes.length) return;
    const { r: nb, k } = boardK(node), u = kindU(info.size.kind), gap = 26 * u, step = 6;
    let f_blocked = false;
    const build = (x0, y0, w, H) => {
      const poly = []; let any = false, blocked = false;
      for (let yy = 0; yy <= H; yy += step) {
        let xl = w; // free until the right edge
        for (const dy of [-6 * u, 0, 6 * u]) for (const sh of shapes) { // sample around the row for line-height slack
          const L = shapeSpanLeft(sh, y0 + yy + dy); if (L == null) continue;
          const R = sh.circle ? sh.circle[0] + sh.circle[2] : Math.max(...sh.poly.map(p => p[0]));
          if (R < x0) continue; // shape entirely left of the text: not in the way
          xl = Math.min(xl, Math.max(0, L - x0 - gap));
        }
        if (xl < w * .45) { xl = 0; blocked = true; } // never squeeze text into a sliver beside a shape: skip the row instead
        if (xl < w - 1) any = true;
        poly.push([xl, yy]);
      }
      if (!any) return null;
      f_blocked = blocked;
      const f = document.createElement('span'); f.className = 'wrapf'; f.setAttribute('aria-hidden', 'true'); f.setAttribute('data-gen', ''); f.setAttribute('data-ui', '');
      f.style.cssText = `float:right;width:${w.toFixed(1)}px;height:${H.toFixed(1)}px;shape-outside:polygon(${[[w, 0], ...poly, [w, H]].map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',')})`;
      return f;
    };
    node.querySelectorAll(WRAP_SEL).forEach(e => {
      if (e.isContentEditable || e.closest('.wrapf') || !e.getClientRects().length) return;
      e.classList.add('wrapbox');
      const b = e.getBoundingClientRect(), x0 = (b.left - nb.left) * k, y0 = (b.top - nb.top) * k, w = b.width * k;
      let H = e.scrollHeight;
      for (let pass = 0; pass < 4; pass++) { // wrapping makes text taller: grow the float until it covers every line
        e.querySelector(':scope > .wrapf')?.remove();
        const f = build(x0, y0, w, H); if (!f) return;
        e.prepend(f);
        if (f_blocked) node._blocked = true;
        const lines = [...e.childNodes].filter(n => n !== f), r = document.createRange();
        r.setStartBefore(lines[0] || f); r.setEndAfter(lines.at(-1) || f);
        const need = (r.getBoundingClientRect().bottom - b.top) * k;
        if (need <= H + 2) break;
        H = need + 4;
      }
    });
  }

  /* ── fit: a hero that still does not fit (overflow, or touching a shape) gives way a little at a time, titles first,
     as the prototype's fit() did, down to 42% of its size. Marked data-aux-fit; runs after the type scale has stepped. ── */
  function fitText(node, info, floor = .42) {
    const mib = window.makeitbrand, els = [...node.querySelectorAll('[data-aux-fit]')].sort((a, b) => (b.tagName === 'H1') - (a.tagName === 'H1'));
    const bad = () => { mib?.check?.(node); return node.hasAttribute('data-overflow') || hitsShapes(node); };
    if (!bad()) return true;
    for (const e of els) {
      let size = parseFloat(getComputedStyle(e).fontSize), guard = 40; const min = size * floor;
      while (guard-- > 0 && size > min && bad()) { size *= .94; e.style.fontSize = size.toFixed(2) + 'px'; wrap(node, info); }
      if (!bad()) return true;
    }
    return false;
  }

  /* ── text rects and shape hits ── */
  function textRects(node, pad = 0, within = node) {
    const { r: nb, k } = boardK(node), rects = [], add = (b, p) => { if (b.width) rects.push([(b.left - nb.left) * k - p, (b.top - nb.top) * k - p, (b.right - nb.left) * k + p, (b.bottom - nb.top) * k + p]); };
    const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT, { acceptNode: t => t.textContent.trim() && !t.parentElement.closest('svg, .wrapf, [data-ph], .aux-shade, .aux-pill') && t.parentElement.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    for (let t; (t = walker.nextNode());) { const r = document.createRange(); r.selectNodeContents(t); for (const b of r.getClientRects()) add(b, pad); }
    within.querySelectorAll('.aux-chip, .aux-lockup .logo, .aux-person > .avatar').forEach(e => add(e.getBoundingClientRect(), pad));
    return rects;
  }
  function hitsShapes(node, pad = 6, within = node) {
    if (within === node && node._blocked) return true; // a paragraph was split by a barrier
    const shapes = shapesOf(node); if (!shapes.length) return false;
    const inPoly = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    const segHit = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
    return textRects(node, pad, within).some(([x0, y0, x1, y1]) => shapes.some(sh => {
      if (sh.circle) { const [cx, cy, r] = sh.circle, dx = Math.max(x0 - cx, 0, cx - x1), dy = Math.max(y0 - cy, 0, cy - y1); return dx * dx + dy * dy < r * r; }
      const P = sh.poly, R = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      if (R.some(([x, y]) => inPoly(x, y, P)) || P.some(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1)) return true;
      return P.some((p, i) => R.some((q, j) => segHit(p, P[(i + 1) % P.length], q, R[(j + 1) % 4])));
    }));
  }

  /* ── thin outlines are cut where text sits (editorial knockout), never drawn through words ──
     Each outline is a polyline; the stretches inside a (padded) text rectangle are left out, so the result is plain
     strokes (no mask, which the rasterizers and PRIMITIVES.md section 12 do not take). */
  function cutPolyline(pl, closed, rects) {
    const P = closed ? [...pl, pl[0]] : pl, out = []; let cur = null, any = false;
    const inside = (a, b) => { // t intervals of a->b inside any rect (Liang-Barsky), merged
      const iv = [];
      for (const [x0, y0, x1, y1] of rects) {
        let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
        const clip = (p, q) => { if (p === 0) return q >= 0; const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } return true; };
        if (clip(-dx, a[0] - x0) && clip(dx, x1 - a[0]) && clip(-dy, a[1] - y0) && clip(dy, y1 - a[1]) && t1 > t0) iv.push([t0, t1]);
      }
      iv.sort((m, n) => m[0] - n[0]); const m = [];
      for (const v of iv) { if (m.length && v[0] <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], v[1]); else m.push(v.slice()); }
      return m;
    };
    const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], cuts = inside(a, b), kept = []; let t = 0;
      for (const [c0, c1] of cuts) { if (c0 > t) kept.push([t, c0]); t = Math.max(t, c1); }
      if (t < 1) kept.push([t, 1]);
      if (cuts.length) any = true;
      if (!kept.length) { cur = null; continue; }
      for (const [k0, k1] of kept) {
        const s0 = at(a, b, k0), s1 = at(a, b, k1);
        if (k0 === 0 && cur) cur.push(s1); else { cur = [s0, s1]; out.push(cur); }
        if (k1 < 1) cur = null;
      }
    }
    return { any, out };
  }
  function knockout(node, info) {
    const svg = node.querySelector(':scope > .aux-backdrop'); if (!svg) return;
    const ols = [...svg.querySelectorAll('.ol')]; if (!ols.length) return;
    const u = kindU(info.size.kind), rects = textRects(node, 16 * u);
    for (const o of ols) {
      if (!o._pl) continue;
      if (!rects.length) { o.setAttribute('d', pathOf(o._pl, o._closed)); continue; }
      const { any, out } = cutPolyline(o._pl, o._closed, rects);
      o.setAttribute('d', any ? out.filter(r => r.length > 1).map(r => pathOf(r, false)).join(' ') : pathOf(o._pl, o._closed));
    }
  }

  /* ── the hooks ── */
  const state = new WeakMap();
  function before(node, info) {
    clear(node);
    const cands = candidates(node, info), st = { cands, idx: 0 };
    state.set(node, st);
    if (!cands.length) { node.querySelector(':scope > figure.aux-cover')?.style.setProperty('display', 'none'); return; }
    // like the prototype's fitBest: the first graphic the text clears (no overflow, no shape touched) when the type may give
    // way by a quarter; the last one is kept when none does. A pick by a person is a list of one, so it is always kept.
    for (; st.idx < cands.length; st.idx++) {
      render(node, info, cands[st.idx]);
      wrap(node, info);
      // the last one (a person's pick, or the template's fallback) is tried as written first, exactly as Auto tries the others;
      // only when the text still touches a shape does it move into the free band
      if (st.idx === cands.length - 1) {
        if (hitsShapes(node) && !fitText(node, info, .75)) { node.querySelectorAll('[data-aux-fit]').forEach(e => e.style.removeProperty('font-size')); wrap(node, info); st.zoned = true; rezone(node, info); }
        break;
      }
      if (fitText(node, info, .75)) break; // fits with the type giving way by up to a quarter, like the prototype
    }
  }
  function after(node, info) {
    const st = state.get(node); if (!st || !st.cands.length) return;
    wrap(node, info); // the type scale may have stepped down since
    let changed = false;
    // text still touches a shape: try the next graphic of the list (only when the template chose, not a person)
    while (st.idx < st.cands.length - 1 && hitsShapes(node)) { st.idx++; render(node, info, st.cands[st.idx]); wrap(node, info); changed = true; }
    if (!st.zoned && st.idx === st.cands.length - 1 && hitsShapes(node)) { st.zoned = true; rezone(node, info); changed = true; }
    if (stackSpeakers(node, info)) changed = true;
    fitText(node, info);
    knockout(node, info);
    if (changed) window.makeitbrand?.check?.(node);
    if (hitsShapes(node)) node.setAttribute('data-overflow', ''); // text still under a shape: the editor flags the frame like an overflow
  }
  Studio.boards.onSettle(before, { when: 'before' });
  Studio.boards.onSettle(after, { when: 'after' });

  // "Mluví na UXMonday" / "Přednáší na UXMonday" (speaker pages), from the brand strings and the number of speakers
  Studio.boards.formats.speaks = (v, h, d) => `${(d.event?.speakers || []).filter(x => x.name).length > 1 ? h.s.speaksMany : h.s.speaksOne} ${v}`;
  Studio.boards.formats.pager = (v, h, d) => +d.pageCount > 1 ? `${parseInt(v, 10)}/${d.pageCount}` : '';
  Studio.boards.formats.int = v => String(parseInt(v, 10));

  // "12. 10." for the save-the-date hero (the prototype's dayMonth)
  Studio.boards.formats.dayMonth = v => { const x = /^\d{4}-\d\d-\d\d/.test(v) ? new Date(String(v).slice(0, 10) + 'T12:00') : null; return x ? `${x.getDate()}. ${x.getMonth() + 1}.` : ''; };
})();
