/* Grid texture: a quiet ascii field of "+" marks with the odd "/" (at the brand's 0.8 slash angle)
   and the occasional "-" — deterministic per format, vector so SVG export keeps it verbatim (no
   filters/masks/gradients/patterns: the gradient feel comes purely from per-mark stroke-opacity,
   bucketed into a handful of levels so we still emit only a few <path> elements).

   Designer direction: the field should radiate from the backdrop's solid shapes (the lime band /
   photo strip / dot) — strongest close to them, fading to a near-invisible whisper with distance,
   so text zones stay calm. Backdrops with no shapes (plain, full-photo) fall back to a gentle wash
   from the bottom-right corner along the same slash angle, so they still read as part of the system. */
(function () {
'use strict';

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smoothstep(e0, e1, x) { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }

// exact distance from a point to a segment
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp01(t);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// standard ray-casting point-in-polygon
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// {inside, dist} of a point against one shape ({poly:[[x,y],...]} or {circle:[cx,cy,r]})
function shapeInfo(px, py, shape) {
  if (shape.circle) {
    const [cx, cy, r] = shape.circle, d = Math.hypot(px - cx, py - cy);
    return { inside: d < r, dist: Math.max(0, d - r) };
  }
  const poly = shape.poly;
  if (pointInPoly(px, py, poly)) return { inside: true, dist: 0 };
  let dist = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) dist = Math.min(dist, distToSeg(px, py, poly[i][0], poly[i][1], poly[j][0], poly[j][1]));
  return { inside: false, dist };
}
// nearest info across all shapes (a point "inside" any one shape short-circuits)
function nearest(px, py, shapes) {
  let dist = Infinity;
  for (const s of shapes) {
    const info = shapeInfo(px, py, s);
    if (info.inside) return { inside: true, dist: 0 };
    if (info.dist < dist) dist = info.dist;
  }
  return { inside: false, dist };
}

const LEVELS = 6;

window.Studio.texture = function texture(fmt, t, shapes, sc) {
  const step = Math.round(46 * sc.u), arm = 4.5 * sc.u, sw = Math.max(1.4, 1.5 * sc.u), dy = 7 * sc.u;
  let seed = fmt.w * 7 + fmt.h * 13; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const hasShapes = shapes && shapes.length > 0;
  // no shapes (plain / full-photo backdrops) → radiate from a virtual point at the bottom-right
  // corner instead, along the same diagonal, so these still get a soft directional wash
  const effShapes = hasShapes ? shapes : [{ circle: [fmt.w, fmt.h, 0] }];
  const R = hasShapes ? .55 * Math.min(fmt.w, fmt.h) : .8 * Math.max(fmt.w, fmt.h);

  const gridOpMax = (t.gridOpacity || .16) * .75, gridOpMin = .03;
  const accentOpMax = (t.gridAccentOpacity || .4) * .72, accentOpMin = .04;

  const plusBuckets = Array.from({ length: LEVELS }, () => '');
  const slashBuckets = Array.from({ length: LEVELS }, () => '');

  for (let y = step / 2; y < fmt.h; y += step) for (let x = step / 2; x < fmt.w; x += step) {
    const { inside, dist } = nearest(x, y, effShapes);
    if (inside) continue; // never mark on top of a solid shape

    const g = 1 - smoothstep(0, R, Math.min(dist, R)); // 1 = right at a shape's edge, 0 = far away
    const lvl = Math.min(LEVELS - 1, Math.floor(g * LEVELS));

    const r = rnd();
    // slashes cluster more tightly near shapes; gaps (skipped marks) open up further away, so
    // calm text zones read almost clean while the field near a shape stays dense
    const slashP = .035 + .085 * g;
    const gapP = .06 + .12 * (1 - g);
    if (r < slashP) {
      slashBuckets[lvl] += `M${(x - dy * .8).toFixed(1)} ${(y + dy).toFixed(1)}L${(x + dy * .8).toFixed(1)} ${(y - dy).toFixed(1)}`;
    } else if (r < slashP + .03) {
      plusBuckets[lvl] += `M${(x - arm * 1.6).toFixed(1)} ${y}H${(x + arm * 1.6).toFixed(1)}`;
    } else if (r < slashP + .03 + gapP) {
      continue; // gap
    } else {
      plusBuckets[lvl] += `M${(x - arm).toFixed(1)} ${y}H${(x + arm).toFixed(1)}M${x} ${(y - arm).toFixed(1)}V${(y + arm).toFixed(1)}`;
    }
  }

  let paths = '';
  for (let i = 0; i < LEVELS; i++) {
    if (!plusBuckets[i]) continue;
    const gMid = (i + .5) / LEVELS, op = gridOpMin + (gridOpMax - gridOpMin) * gMid;
    paths += `<path d="${plusBuckets[i]}" stroke="${t.grid || t.fg}" stroke-opacity="${op.toFixed(3)}" stroke-width="${sw}" fill="none"/>`;
  }
  for (let i = 0; i < LEVELS; i++) {
    if (!slashBuckets[i]) continue;
    const gMid = (i + .5) / LEVELS, op = accentOpMin + (accentOpMax - accentOpMin) * gMid;
    paths += `<path d="${slashBuckets[i]}" stroke="${t.accent}" stroke-opacity="${op.toFixed(3)}" stroke-width="${sw}" fill="none"/>`;
  }
  return `<svg class="grid-tex" viewBox="0 0 ${fmt.w} ${fmt.h}" aria-hidden="true">${paths}</svg>`;
};
})();
