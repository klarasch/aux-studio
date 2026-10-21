/* Animation extension — brand-agnostic, loaded after Studio.boot().
   Gives every asset a deterministic entrance animation (bands slide in along their own
   slant, outlines draw on, the dot pops, photos fade+scale, text fades+rises, staggered),
   and exposes a stable API for engine/ui.js's per-image Motion toggle and for headless export:

     window.StudioAnimate = {
       seek(node, t), resetNode(node), DURATION, FPS,
       isAnimated(id), play(node), stop(node),
       exportMp4(id) -> Promise<Blob> (video/mp4),
     }

   Everything is driven by seek(node, t): it sets every animated property as inline
   styles/attributes for an exact time t (seconds), so both the looping preview and the
   frame-by-frame MP4 export read from the same deterministic timeline. Nothing here relies
   on CSS animation/transition timing.

   No caption buttons here anymore — engine/ui.js owns the per-image "Motion" toggle
   (S.overrides[assetId].__motion === true marks an asset as animated) and calls play()/
   stop()/exportMp4() directly; this file just auto-loops any node the gallery renders for
   an asset marked animated, and gets out of the way otherwise. */
(function () {
  'use strict';
  if (!window.Studio || !window.Studio.api) { console.warn('animate.js: Studio.api not ready'); return; }

  /* ─────────── Timeline constants ─────────── */
  const DURATION = 6;    // seconds, one export/preview pass
  const LOOP_HOLD = 1;   // extra seconds held on the static frame before a looping preview restarts
  const FPS = 30;
  const T = {
    band:    { start: 0.00, dur: 0.85 },
    outline: { start: 0.15, dur: 0.90 },
    dot:     { start: 0.65, dur: 0.60 },
    photo:   { start: 0.20, dur: 0.70 },
    shade:   { start: 0.20, dur: 0.70 },
    text:    { start: 0.50, dur: 0.55, stagger: 0.08 },
  };

  /* ─────────── Easing (exact at both ends: e(0)=0, e(1)=1) ─────────── */
  const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
  const easeOutCubic = x => 1 - Math.pow(1 - x, 3);
  function easeOutBack(x, overshoot = 1.7) {
    const c1 = overshoot, c3 = c1 + 1, m = x - 1;
    return 1 + c3 * m * m * m + c1 * m * m;
  }
  const progress = (t, start, dur) => clamp01((t - start) / dur);

  /* ─────────── Shape helpers (read geometry live off the rendered motif — never altered) ─────────── */
  function classifyShape(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'circle') return 'dot';
    if (tag === 'polygon' && el.getAttribute('fill') && el.getAttribute('fill') !== 'none') return 'band';
    return 'outline'; // open path, closed polygon outline, or decorative <line>
  }
  // a band is always a parallelogram (a strip cut, or a rotated full-width band); its own
  // "slant" is the direction of its longer edge — sliding along it never touches its shape.
  function bandAxis(el) {
    const pts = [...el.points].map(p => [p.x, p.y]);
    if (pts.length < 4) return [0, 1];
    const e1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
    const e2 = [pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]];
    const l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1]);
    const long = l1 >= l2 ? e1 : e2, len = Math.hypot(long[0], long[1]) || 1;
    return [long[0] / len, long[1] / len];
  }
  function outlineLength(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'line') {
      const x1 = +el.getAttribute('x1'), y1 = +el.getAttribute('y1'), x2 = +el.getAttribute('x2'), y2 = +el.getAttribute('y2');
      return Math.hypot(x2 - x1, y2 - y1);
    }
    if (typeof el.getTotalLength === 'function') { try { return el.getTotalLength(); } catch (e) {} }
    if (el.points) {
      const pts = [...el.points].map(p => [p.x, p.y]);
      let len = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      return len;
    }
    return 500;
  }

  /* ─────────── seek(node, t): sets every animated property for time t, deterministically ─────────── */
  function seek(node, t) {
    t = Math.max(0, t);
    const svg = node.querySelector('.motif');
    if (svg) {
      const dim = Math.max(parseFloat(node.style.width) || node.offsetWidth || 1080, parseFloat(node.style.height) || node.offsetHeight || 1350);
      const offset = dim * 0.22;
      [...svg.children].forEach(el => {
        const kind = classifyShape(el);
        if (kind === 'band') {
          const e = easeOutBack(progress(t, T.band.start, T.band.dur));
          const [ax, ay] = bandAxis(el);
          const dx = -ax * offset * (1 - e), dy = -ay * offset * (1 - e);
          el.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
        } else if (kind === 'dot') {
          const p = progress(t, T.dot.start, T.dot.dur);
          const s = t < T.dot.start ? 0 : Math.max(0, easeOutBack(p, 2.2));
          const cx = el.getAttribute('cx'), cy = el.getAttribute('cy');
          el.style.transformOrigin = `${cx}px ${cy}px`;
          el.style.transform = `scale(${s.toFixed(3)})`;
        } else {
          const e = easeOutCubic(progress(t, T.outline.start, T.outline.dur));
          const len = outlineLength(el);
          el.style.strokeDasharray = len.toFixed(1);
          el.style.strokeDashoffset = (len * (1 - e)).toFixed(1);
        }
      });
    }
    // photo panels / speaker & spotlight photos (skip image slots with no photo — initials only)
    node.querySelectorAll('.panel, .img').forEach(el => {
      const bg = el.style.backgroundImage;
      if (!bg || bg === 'none') return;
      const e = easeOutCubic(progress(t, T.photo.start, T.photo.dur));
      el.style.opacity = e.toFixed(3);
      el.style.transform = `scale(${(1.06 - 0.06 * e).toFixed(4)})`;
      el.style.transformOrigin = 'center';
    });
    node.querySelectorAll('.shade').forEach(el => {
      el.style.opacity = easeOutCubic(progress(t, T.shade.start, T.shade.dur)).toFixed(3);
    });
    // text: lockup, chips, title, description, speakers, kicker, quote, CTA... in document order
    node.querySelectorAll('.lockup, .meta, h1, .desc, .kicker, .quote, .speakers, .foot, .agenda .ti, .stats .stat, .bigdate, .swipe, .pager, .body')
      .forEach((el, i) => {
        const start = T.text.start + i * T.text.stagger;
        const e = easeOutCubic(progress(t, start, T.text.dur));
        el.style.opacity = e.toFixed(3);
        el.style.transform = `translateY(${(24 * (1 - e)).toFixed(2)}px)`;
      });
  }
  function resetNode(node) { seek(node, DURATION + 1); } // final rest state === the static design

  /* ─────────── Motion toggle: S.overrides[id].__motion === true marks an asset as animated ─────────── */
  function isAnimated(id) {
    try { return Studio.api.state.overrides[id]?.__motion === true; } catch (e) { return false; }
  }

  /* ─────────── Looping preview on a visible, already-rendered asset node ─────────── */
  const loops = new WeakMap(); // node -> { raf }
  function play(node) {
    if (!node || loops.has(node)) return;
    const period = DURATION + LOOP_HOLD, start = performance.now();
    const entry = { raf: 0 };
    loops.set(node, entry);
    const frame = () => {
      if (loops.get(node) !== entry) return; // stopped
      const t = ((performance.now() - start) / 1000) % period;
      seek(node, t); // seek clamps internally, so t in [DURATION, period) just holds the static frame
      entry.raf = requestAnimationFrame(frame);
    };
    entry.raf = requestAnimationFrame(frame);
  }
  function stop(node) {
    if (!node) return;
    const entry = loops.get(node);
    if (entry) cancelAnimationFrame(entry.raf);
    loops.delete(node);
    resetNode(node);
  }

  function reducedMotion() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  // auto-manage loops: whatever the gallery just rendered, play the ones marked animated,
  // stop everything else (old nodes from the previous render are about to be discarded anyway).
  let managed = new Set();
  document.addEventListener('studio:rendered', e => {
    for (const node of managed) stop(node);
    managed = new Set();
    if (reducedMotion()) return;
    for (const c of e.detail.cards) {
      if (isAnimated(c.id)) { play(c.node); managed.add(c.node); }
    }
  });

  /* ─────────── MP4 export: WebCodecs H.264 + mp4-muxer, muxed in the browser, any format ─────────── */
  function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
  let muxerPromise;
  function ensureMuxer() {
    if (window.Mp4Muxer) return Promise.resolve();
    if (!muxerPromise) muxerPromise = loadScript('https://cdn.jsdelivr.net/npm/mp4-muxer@5/build/mp4-muxer.min.js');
    return muxerPromise;
  }
  async function pickCodec(width, height) {
    const candidates = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f', 'avc1.42001e'];
    for (const codec of candidates) {
      try { const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 8_000_000, framerate: FPS }); if (r.supported) return codec; }
      catch (e) { /* try next */ }
    }
    return null;
  }
  const evenUp = n => n + (n % 2); // H.264/yuv420p needs even width & height (e.g. LinkedIn's 1200×627)
  // draws src (w0×h0) into a w×h canvas, duplicating the last row/col into any padding so a
  // 1px-odd dimension doesn't grow a visible seam — used only when w0/h0 are themselves odd.
  function padCanvas(src, w, h) {
    if (w === src.width && h === src.height) return src;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    if (h > src.height) ctx.drawImage(src, 0, src.height - 1, src.width, 1, 0, src.height, src.width, 1);
    if (w > src.width) ctx.drawImage(src, src.width - 1, 0, 1, src.height, src.width, 0, 1, src.height);
    return c;
  }

  // Renders id's asset off-screen at native size (padded to even dimensions if needed for H.264)
  // and encodes DURATION*FPS frames into an in-memory MP4. Works for any format, not just stories.
  async function exportMp4(id) {
    const { a, node, done } = await Studio.api.renderNode(id);
    try {
      const width = evenUp(a.fmt.w), height = evenUp(a.fmt.h), total = Math.round(DURATION * FPS);
      if (typeof VideoEncoder === 'undefined') throw new Error('WebCodecs VideoEncoder is not available in this browser');
      await ensureMuxer();
      const codec = await pickCodec(width, height);
      if (!codec) throw new Error('no supported H.264 encoder configuration for ' + width + 'x' + height);
      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width, height, frameRate: FPS },
        fastStart: 'in-memory',
      });
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => console.error('animate.js VideoEncoder error', e),
      });
      encoder.configure({ codec, width, height, bitrate: 8_000_000, framerate: FPS });
      for (let i = 0; i < total; i++) {
        seek(node, i / FPS);
        const raw = await htmlToImage.toCanvas(node, { pixelRatio: 1, width: a.fmt.w, height: a.fmt.h });
        const canvas = padCanvas(raw, width, height);
        const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
        encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();
        if (i % 10 === 0) Studio.api.toast(`Rendering frame ${i + 1}/${total}…`);
        if (encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 0)); // don't runaway the queue
      }
      await encoder.flush();
      encoder.close();
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    } finally { done(); }
  }

  // Fallback for a headless Chromium without WebCodecs H.264: renders the same DURATION*FPS
  // frames as PNGs (base64) so a caller (tools/animate.py) can encode them with ffmpeg itself.
  // Not part of the stable UI-facing API, but kept for tools/animate.py --all-stories parity.
  async function renderFramesPng(id) {
    const { a, node, done } = await Studio.api.renderNode(id);
    try {
      const total = Math.round(DURATION * FPS), frames = [];
      for (let i = 0; i < total; i++) {
        seek(node, i / FPS);
        const canvas = await htmlToImage.toCanvas(node, { pixelRatio: 1, width: a.fmt.w, height: a.fmt.h });
        frames.push(canvas.toDataURL('image/png').split(',')[1]);
        if (i % 10 === 0) Studio.api.toast(`Rendering frame ${i + 1}/${total}…`);
      }
      return { frames, fps: FPS, width: a.fmt.w, height: a.fmt.h };
    } finally { done(); }
  }

  window.StudioAnimate = { seek, resetNode, DURATION, FPS, isAnimated, play, stop, exportMp4, renderFramesPng };
})();
