// Perturbation Method Implementation for Ultra-Deep Mandelbrot Zooms
// Based on techniques from https://github.com/iskandarov-egor/mandelset

class PerturbationRenderer {
  constructor() {
    // Reference orbit, packed as the RGBA32F texture the shader samples:
    // one texel per iteration holding (re_hi, re_lo, im_hi, im_lo).
    this.referenceOrbit = new Float32Array(0);
    this.referenceOrbitLength = 0;
    this.series = { skip: 0, a: [0, 0], b: [0, 0], c: [0, 0] };
    this.referencePoint = { re: 0, im: 0 };
    this.maxRefIterations = 16384;

    // 'mandelbrot': reference orbit is z_{n+1}=z_n^2+C with z_0=0 and C=reference
    //               point (per-pixel variation is in C -> a per-step delta-c).
    // 'julia':      reference orbit is z_{n+1}=z_n^2+c with z_0=reference point and
    //               c=juliaC fixed (per-pixel variation is in z_0 -> an initial
    //               delta, no per-step delta-c).
    this.mode = 'mandelbrot';
    this.juliaC = { re: 0, im: 0 };

    this._last = {
      reDD: null,
      imDD: null,
      maxIters: 0,
      orbitLen: 0,
    };

    this._texture = null;
    // Set whenever a new orbit lands, so the texture is only re-uploaded on change.
    this._textureDirty = false;
  }

  // --- Double-double arithmetic for JS float64 ---
  // Split constant for 53-bit mantissa: 2^27 + 1
  static SPLIT = 134217729.0;

  // Below this zoom the Julia viewport is narrow enough that a single reference
  // orbit approximates every pixel (see shouldUsePerturbation).
  static JULIA_PERTURBATION_THRESHOLD = 1e-3;

  ddFrom(value) {
    return { hi: value, lo: 0.0 };
  }

  ddAdd(a, b) {
    const s = a.hi + b.hi;
    const v = s - a.hi;
    const e = (a.hi - (s - v)) + (b.hi - v) + a.lo + b.lo;
    const hi = s + e;
    return { hi, lo: e - (hi - s) };
  }

  ddSub(a, b) {
    return this.ddAdd(a, { hi: -b.hi, lo: -b.lo });
  }

  ddMul(a, b) {
    const split = PerturbationRenderer.SPLIT;
    const cona = a.hi * split;
    const conb = b.hi * split;
    const a1 = cona - (cona - a.hi);
    const b1 = conb - (conb - b.hi);
    const a2 = a.hi - a1;
    const b2 = b.hi - b1;

    const c11 = a.hi * b.hi;
    const c21 = a2 * b2 + (a2 * b1 + (a1 * b2 + (a1 * b1 - c11)));
    const c2 = a.hi * b.lo + a.lo * b.hi;

    const t1 = c11 + c2;
    const e = t1 - c11;
    const t2 = a.lo * b.lo + ((c2 - e) + (c11 - (t1 - e))) + c21;
    const hi = t1 + t2;
    return { hi, lo: t2 - (hi - t1) };
  }

  ddToNumber(dd) {
    return dd.hi + dd.lo;
  }

  // Coerce a value to double-double: pass through {hi,lo}, promote a plain number.
  _asDD(v) {
    return (v && typeof v === 'object' && 'hi' in v) ? v : this.ddFrom(v);
  }

  // --- Mandelbrot quick-inside tests ---
  isInMainCardioid(cx, cy) {
    const x = cx - 0.25;
    const p = Math.sqrt(x * x + cy * cy);
    return cx < p - 2.0 * p * p + 0.25;
  }

  isInPeriod2Bulb(cx, cy) {
    const x = cx + 1.0;
    return x * x + cy * cy <= 0.0625;
  }

  // --- Reference orbit computation ---
  // centerX/centerY may be plain numbers or double-double {hi,lo} pairs. Double-
  // double lets the reference orbit stay accurate below the float64 floor (~1e-16),
  // which is what makes panning and positioning work at extreme zoom.
  calculateReferenceOrbit(centerX, centerY, zoom, maxIters) {
    const refRe = this._asDD(centerX);
    const refIm = this._asDD(centerY);

    // Julia: z_0 = reference point, additive constant is the fixed juliaC.
    // Mandelbrot: z_0 = 0, additive constant is the reference point C.
    const julia = this.mode === 'julia';
    let zRe = julia ? refRe : this.ddFrom(0);
    let zIm = julia ? refIm : this.ddFrom(0);
    const addRe = julia ? this._asDD(this.juliaC.re) : refRe;
    const addIm = julia ? this._asDD(this.juliaC.im) : refIm;

    const target = Math.min(maxIters, this.maxRefIterations);

    // Written straight into the packed texture layout. Building 16k little {re,im}
    // objects instead used to cost more than the arithmetic did.
    const data = new Float32Array(target * 4);
    let length = 0;

    for (let i = 0; i < target; i++) {
      const reVal = this.ddToNumber(zRe);
      const imVal = this.ddToNumber(zIm);
      const reHi = Math.fround(reVal);
      const imHi = Math.fround(imVal);

      data[i * 4 + 0] = reHi;
      data[i * 4 + 1] = reVal - reHi;
      data[i * 4 + 2] = imHi;
      data[i * 4 + 3] = imVal - imHi;
      length = i + 1;

      // Check escape
      const r2 = reVal * reVal + imVal * imVal;
      if (r2 > 4.0) break;

      // Z_{n+1} = Z_n^2 + K  (K = C for Mandelbrot, fixed c for Julia)
      const zRe2 = this.ddMul(zRe, zRe);
      const zIm2 = this.ddMul(zIm, zIm);
      const zReIm = this.ddMul(zRe, zIm);

      zRe = this.ddAdd(this.ddSub(zRe2, zIm2), addRe);
      zIm = this.ddAdd(this.ddMul(this.ddFrom(2), zReIm), addIm);
    }

    return { data, length };
  }

  // Reference orbit point n, reconstituted from its float32 hi/lo pair.
  orbitRe(n) { return this.referenceOrbit[n * 4] + this.referenceOrbit[n * 4 + 1]; }
  orbitIm(n) { return this.referenceOrbit[n * 4 + 2] + this.referenceOrbit[n * 4 + 3]; }

  // --- Series approximation ---
  //
  // Every pixel shares the same reference orbit, and deltaZ is a power series in that
  // pixel's deltaC:  dz_n = A_n*d + B_n*d^2 + C_n*d^3, with
  //     A_{n+1} = 2*Z_n*A_n + 1
  //     B_{n+1} = 2*Z_n*B_n + A_n^2
  //     C_{n+1} = 2*Z_n*C_n + 2*A_n*B_n
  // Since the coefficients don't depend on the pixel, the first `skip` iterations can
  // be evaluated once here and jumped over by every pixel on the GPU.
  //
  // The raw A/B/C track the derivative and grow like 2^n, overflowing float64 within a
  // few hundred iterations, let alone the float32 uniforms they have to travel in. So
  // they are carried pre-scaled -- a = A*zoom, b = B*zoom^2, c = C*zoom^3 -- which is
  // just the same series re-expressed in the normalized screen coordinate
  // u = d / zoom instead of in d. Scaled that way every term stays the size of dz
  // itself and float32 handles them comfortably.
  computeSeries(zoom, maxIters) {
    const none = { skip: 0, a: [0, 0], b: [0, 0], c: [0, 0] };
    if (this.referenceOrbitLength < 3 || this.mode === 'julia') return none;

    // Largest |u| the viewport can ask for: the corner is sqrt(2), plus up to 0.25
    // from a cached (slightly stale) reference offset. Round up for margin -- the
    // series only has to be valid out to here.
    const R = 1.75;
    const R2 = R * R;
    const R3 = R2 * R;

    let ar = 0, ai = 0, br = 0, bi = 0, cr = 0, ci = 0;
    let skip = 0;
    let best = none;

    const limit = Math.min(maxIters, this.referenceOrbitLength - 1);
    for (let n = 0; n < limit; n++) {
      const Zr = this.orbitRe(n);
      const Zi = this.orbitIm(n);

      const naR = 2 * (Zr * ar - Zi * ai) + zoom;
      const naI = 2 * (Zr * ai + Zi * ar);
      const nbR = 2 * (Zr * br - Zi * bi) + (ar * ar - ai * ai);
      const nbI = 2 * (Zr * bi + Zi * br) + 2 * ar * ai;
      const ncR = 2 * (Zr * cr - Zi * ci) + 2 * (ar * br - ai * bi);
      const ncI = 2 * (Zr * ci + Zi * cr) + 2 * (ar * bi + ai * br);
      ar = naR; ai = naI; br = nbR; bi = nbI; cr = ncR; ci = ncI;

      const mA = Math.hypot(ar, ai);
      const mB = Math.hypot(br, bi);
      const mC = Math.hypot(cr, ci);
      if (!isFinite(mA) || !isFinite(mB) || !isFinite(mC)) break;

      // Truncation test: the first dropped term (the cubic) must be negligible
      // against the linear one everywhere in the viewport.
      if (!(mC * R3 < 1e-3 * mA * R)) break;

      // Safety: never skip past an iteration where some pixel has already escaped,
      // because the skip jumps over the escape test that would have caught it.
      // Two things can put a pixel over the edge. Its own deltaZ growing large --
      // bounded here at 2, which keeps |z| far below the escape radius. Or the
      // reference itself heading for infinity, in which case z = Z + deltaZ escapes
      // no matter how small deltaZ is, so the series has to stop while the reference
      // is still inside |Z| < 2.
      if (mA * R + mB * R2 + mC * R3 > 2.0) break;
      const Zr1 = this.orbitRe(n + 1);
      const Zi1 = this.orbitIm(n + 1);
      if (Zr1 * Zr1 + Zi1 * Zi1 > 4.0) break;

      skip = n + 1;
      best = { skip, a: [ar, ai], b: [br, bi], c: [cr, ci] };
    }

    // A skip of a handful of iterations isn't worth the extra uniforms and the jump.
    return skip >= 8 ? best : none;
  }

  // The orbit survives a pure zoom (it doesn't depend on zoom at all) but the series
  // coefficients are scaled by powers of zoom, so they have to be rebuilt whenever
  // the zoom or the orbit changes. Memoised because preDraw asks every frame and a
  // 16k-term series is real work to redo for an unchanged view.
  seriesFor(zoom, maxIters) {
    const version = this._orbitVersion || 0;
    const memo = this._seriesMemo;
    if (memo && memo.zoom === zoom && memo.maxIters === maxIters && memo.version === version) {
      return memo.series;
    }
    const series = this.computeSeries(zoom, maxIters);
    this._seriesMemo = { zoom, maxIters, version, series };
    return series;
  }

  // Pick the reference orbit for the current view.
  //
  // Mandelbrot: always the center. This used to grid-search up to 289 candidate
  // points and then randomly sample 100 more, keeping whichever produced the longest
  // orbit -- 2-60ms of double-double arithmetic on the main thread, per move.
  // Rebasing made that search pointless: orbit length no longer affects correctness,
  // and a reference drawn from anywhere but the center only inflates deltaC, which is
  // the one quantity perturbation wants small.
  //
  // Julia: still searched, because its shader has no rebase to fall back on. There a
  // reference that escapes before the iteration budget really does truncate every
  // pixel that outlives it, so a long orbit is worth hunting for.
  findBestReference(centerX, centerY, zoom, maxIters, canvasWidth, canvasHeight) {
    const cRe = this._asDD(centerX);
    const cIm = this._asDD(centerY);

    if (this.mode !== 'julia') {
      this._installReference(this.calculateReferenceOrbit(cRe, cIm, zoom, maxIters), cRe, cIm);
      return this.referenceOrbit;
    }

    const stepX = (2 / Math.max(1, canvasWidth)) * zoom;
    const stepY = (2 / Math.max(1, canvasHeight)) * zoom;
    const best = { orbit: null, len: 0, reDD: cRe, imDD: cIm };

    // Candidate points are carried as double-double so a reference offset from the
    // center is computed exactly. Grid/random offsets are small (~zoom) floats added
    // onto the DD center.
    const tryPoint = (reDD, imDD) => {
      const orbit = this.calculateReferenceOrbit(reDD, imDD, zoom, maxIters);
      if (orbit.length > best.len) {
        best.len = orbit.length;
        best.orbit = orbit;
        best.reDD = reDD;
        best.imDD = imDD;
      }
    };

    tryPoint(cRe, cIm);

    if (best.len < maxIters) {
      const range = 8;
      for (let dx = -range; dx <= range && best.len < maxIters; dx++) {
        for (let dy = -range; dy <= range && best.len < maxIters; dy++) {
          if (dx === 0 && dy === 0) continue;
          tryPoint(this.ddAdd(cRe, this.ddFrom(dx * stepX)),
                   this.ddAdd(cIm, this.ddFrom(dy * stepY)));
        }
      }
    }

    if (best.len < maxIters) {
      for (let attempt = 0; attempt < 100 && best.len < maxIters; attempt++) {
        const scale = 1 + attempt * 5;
        const ox = (Math.random() * 2 - 1) * stepX * 8 * scale;
        const oy = (Math.random() * 2 - 1) * stepY * 8 * scale;
        tryPoint(this.ddAdd(cRe, this.ddFrom(ox)), this.ddAdd(cIm, this.ddFrom(oy)));
      }
    }

    this._installReference(best.orbit, best.reDD, best.imDD);
    return this.referenceOrbit;
  }

  _installReference(orbit, reDD, imDD) {
    this.referenceOrbit = orbit.data;
    this.referenceOrbitLength = orbit.length;
    this._textureDirty = true;
    this._orbitVersion = (this._orbitVersion || 0) + 1;
    this.referencePoint = {
      re: this.ddToNumber(reDD),
      im: this.ddToNumber(imDD),
      reDD,
      imDD,
    };
  }

  ensureReference(centerX, centerY, zoom, maxIters, canvasWidth, canvasHeight) {
    // The reference orbit (Z_{n+1} = Z_n^2 + C) depends only on the reference
    // point and the iteration count — NOT on zoom. So a pure zoom-in over a fixed
    // center reuses the cached orbit; we only recompute when the center moves far
    // enough to leave the current viewport, or when a higher iteration count could
    // yield a longer (still-bounded) orbit.
    const cRe = this._asDD(centerX);
    const cIm = this._asDD(centerY);

    // Compare movement in double-double: the *difference* is small (~zoom) and fits
    // a float64 fine, but computing it from float64 centers would round to zero at
    // deep zoom — which is exactly why panning used to appear frozen.
    const dRe = this._last.reDD ? this.ddToNumber(this.ddSub(cRe, this._last.reDD)) : Infinity;
    const dIm = this._last.imDD ? this.ddToNumber(this.ddSub(cIm, this._last.imDD)) : Infinity;
    const movedFar =
      this._last.reDD === null ||
      Math.abs(dRe) > zoom * 0.25 ||
      Math.abs(dIm) > zoom * 0.25;

    // A longer orbit is only obtainable if the previous one was capped by the
    // iteration budget rather than by escaping.
    const wantMoreIters =
      maxIters > this._last.maxIters &&
      this._last.orbitLen >= this._last.maxIters;

    // Julia's reference orbit also depends on the fixed constant c, so a change to it
    // (e.g. the Combo preview tracking the mouse) must invalidate the cached orbit.
    const juliaCChanged =
      this.mode === 'julia' &&
      (this._last.juliaCRe !== this.juliaC.re || this._last.juliaCIm !== this.juliaC.im);

    if (!movedFar && !wantMoreIters && !juliaCChanged && this.referenceOrbitLength > 0) {
      return;
    }

    // Compute inline when we can't afford to draw a frame without the new orbit:
    //  - the first reference of the session, where there is nothing valid to draw
    //    with at all and going async would flash one frame of the fallback path;
    //  - Julia, which has no rebasing in its shader, so a stale reference really is
    //    wrong rather than merely suboptimal;
    //  - no worker available (file:// origins, mainly).
    // Julia's orbits are short enough that computing them inline is not felt.
    if (this.referenceOrbitLength === 0 || this.mode === 'julia' || !this._ensureWorker()) {
      this.findBestReference(cRe, cIm, zoom, maxIters, canvasWidth, canvasHeight);
      this.series = this.computeSeries(zoom, maxIters);
      this._rememberRequest(cRe, cIm, maxIters);
      return;
    }

    // Otherwise hand the work to the worker and keep drawing with the orbit we
    // already have. Rebasing is what makes that safe: a slightly stale reference
    // only means a slightly larger deltaC, not a wrong picture. The swap happens in
    // _onWorkerResult, which asks for a redraw.
    this._rememberRequest(cRe, cIm, maxIters);
    this._dispatch(cRe, cIm, zoom, maxIters);
  }

  _rememberRequest(cRe, cIm, maxIters) {
    this._last.reDD = cRe;
    this._last.imDD = cIm;
    this._last.maxIters = maxIters;
    this._last.orbitLen = this.referenceOrbitLength;
    this._last.juliaCRe = this.juliaC.re;
    this._last.juliaCIm = this.juliaC.im;
  }

  // Lazily create the worker. Returns false when workers aren't usable at all
  // (opening the page over file://, for one), in which case callers fall back to
  // computing on the main thread.
  _ensureWorker() {
    if (this._worker !== undefined) return this._worker !== null;
    try {
      this._worker = new Worker('reference-worker.js');
      this._worker.onmessage = (evt) => this._onWorkerResult(evt.data);
      this._worker.onerror = () => { this._worker = null; };
    } catch (e) {
      this._worker = null;
    }
    return this._worker !== null;
  }

  _dispatch(cRe, cIm, zoom, maxIters) {
    this._jobId = (this._jobId || 0) + 1;
    // Only the newest request matters; anything older is about to be superseded.
    this._inFlightId = this._jobId;
    this._worker.postMessage({
      id: this._jobId,
      mode: this.mode,
      juliaC: this.juliaC,
      maxRefIterations: this.maxRefIterations,
      centerRe: cRe,
      centerIm: cIm,
      zoom,
      maxIters,
    });
  }

  _onWorkerResult(msg) {
    // A newer request has already gone out; this result is stale.
    if (msg.id !== this._inFlightId) return;

    this.referenceOrbit = msg.data;
    this.referenceOrbitLength = msg.length;
    this.series = msg.series;
    this._textureDirty = true;
    this._orbitVersion = (this._orbitVersion || 0) + 1;
    this.referencePoint = {
      re: this.ddToNumber(msg.centerRe),
      im: this.ddToNumber(msg.centerIm),
      reDD: msg.centerRe,
      imDD: msg.centerIm,
    };
    this._last.orbitLen = msg.length;

    if (this.onReady) this.onReady();
  }

  // Mandelbrot perturbation is always on.
  //
  // It used to be gated behind a zoom threshold, because a single reference orbit
  // could only approximate a narrow viewport. Rebasing removed that constraint: a
  // pixel whose delta outgrows the reference just restarts at orbit index 0, so
  // accuracy stopped depending on the viewport being small or the reference being
  // long. Measured against a float64 CPU reference, perturbation is now more
  // accurate than the double-single path at every zoom level and 1.1-2.4x faster,
  // so the double-single path survives only as the fallback for when there is no
  // usable reference orbit at all.
  //
  // Julia cannot rebase: its reference orbit starts at the reference point rather
  // than at 0, so the substitution `deltaZ = z` that makes a rebase exact for
  // Mandelbrot would instead need `z - Z_ref[0]`, a difference of two O(1) floats
  // that loses all of its significant bits in float32. Until that path grows a
  // rebase of its own it keeps the old zoom gate: only switch to perturbation once
  // the viewport is narrow enough for one reference to approximate every pixel.
  shouldUsePerturbation(zoom) {
    if (this.mode === 'julia') {
      return zoom < PerturbationRenderer.JULIA_PERTURBATION_THRESHOLD;
    }
    return true;
  }

  // --- GPU texture upload ---
  createOrUpdateTexture(gl) {
    if (this.referenceOrbitLength === 0) return null;
    if (!this._texture) {
      this._texture = gl.createTexture();
    }
    if (!this._textureDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      return this._texture;
    }
    this._textureDirty = false;

    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F,
      this.referenceOrbitLength, 1, 0, gl.RGBA, gl.FLOAT, this.referenceOrbit);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return this._texture;
  }
}
