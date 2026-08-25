// Perturbation Method Implementation for Ultra-Deep Mandelbrot Zooms
// Based on techniques from https://github.com/iskandarov-egor/mandelset

class PerturbationRenderer {
  constructor() {
    // Below this zoom the viewport is small enough that a single reference orbit
    // approximates every pixel, so we switch from direct double-single iteration
    // to single-float perturbation.
    this.PERTURBATION_THRESHOLD = 1e-3;

    this.referenceOrbit = [];
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
  }

  // --- Double-double arithmetic for JS float64 ---
  // Split constant for 53-bit mantissa: 2^27 + 1
  static SPLIT = 134217729.0;

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

  // Split a JS float64 into float32 hi/lo pair (for GPU upload)
  splitToFloat32(value) {
    const hi = Math.fround(value);
    const lo = value - hi;
    return { hi, lo };
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

    const orbit = [];

    // Julia: z_0 = reference point, additive constant is the fixed juliaC.
    // Mandelbrot: z_0 = 0, additive constant is the reference point C.
    const julia = this.mode === 'julia';
    let zRe = julia ? refRe : this.ddFrom(0);
    let zIm = julia ? refIm : this.ddFrom(0);
    const addRe = julia ? this._asDD(this.juliaC.re) : refRe;
    const addIm = julia ? this._asDD(this.juliaC.im) : refIm;

    const target = Math.min(maxIters, this.maxRefIterations);

    for (let i = 0; i < target; i++) {
      // Convert orbit point to float32 hi/lo pairs for GPU texture
      const reVal = this.ddToNumber(zRe);
      const imVal = this.ddToNumber(zIm);
      const reSplit = this.splitToFloat32(reVal);
      const imSplit = this.splitToFloat32(imVal);

      orbit.push({
        re_hi: reSplit.hi,
        re_lo: reSplit.lo,
        im_hi: imSplit.hi,
        im_lo: imSplit.lo,
      });

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

    return orbit;
  }

  findBestReference(centerX, centerY, zoom, maxIters, canvasWidth, canvasHeight) {
    const cRe = this._asDD(centerX);
    const cIm = this._asDD(centerY);
    const stepX = (2 / Math.max(1, canvasWidth)) * zoom;
    const stepY = (2 / Math.max(1, canvasHeight)) * zoom;

    const best = { orbit: [], len: 0, reDD: cRe, imDD: cIm };

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

    // Always try center first
    tryPoint(cRe, cIm);

    // Grid search across viewport (if center isn't good enough)
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

    // If grid didn't find a long enough orbit, try random sampling at wider distances
    if (best.len < maxIters) {
      for (let attempt = 0; attempt < 100 && best.len < maxIters; attempt++) {
        const scale = 1 + attempt * 5;
        const ox = (Math.random() * 2 - 1) * stepX * 8 * scale;
        const oy = (Math.random() * 2 - 1) * stepY * 8 * scale;
        tryPoint(this.ddAdd(cRe, this.ddFrom(ox)), this.ddAdd(cIm, this.ddFrom(oy)));
      }
    }

    const reNum = this.ddToNumber(best.reDD);
    const imNum = this.ddToNumber(best.imDD);
    console.log(`[ref] orbit=${best.len}/${maxIters} at (${reNum.toExponential(6)}, ${imNum.toExponential(6)})`);

    this.referenceOrbit = best.orbit;
    // Keep numeric re/im for display/legacy readers plus the DD pair for precise
    // reference-offset computation.
    this.referencePoint = { re: reNum, im: imNum, reDD: best.reDD, imDD: best.imDD };
    return best.orbit;
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

    if (!movedFar && !wantMoreIters && !juliaCChanged && this.referenceOrbit.length > 0) {
      return;
    }

    this.findBestReference(cRe, cIm, zoom, maxIters, canvasWidth, canvasHeight);
    this._last.reDD = cRe;
    this._last.imDD = cIm;
    this._last.maxIters = maxIters;
    this._last.orbitLen = this.referenceOrbit.length;
    this._last.juliaCRe = this.juliaC.re;
    this._last.juliaCIm = this.juliaC.im;
  }

  shouldUsePerturbation(zoom) {
    return zoom < this.PERTURBATION_THRESHOLD;
  }

  // --- GPU texture upload ---
  createOrUpdateTexture(gl) {
    if (this.referenceOrbit.length === 0) return null;

    // Pack orbit data: each texel = (re_hi, re_lo, im_hi, im_lo)
    const data = new Float32Array(this.referenceOrbit.length * 4);
    for (let i = 0; i < this.referenceOrbit.length; i++) {
      const p = this.referenceOrbit[i];
      data[i * 4 + 0] = p.re_hi;
      data[i * 4 + 1] = p.re_lo;
      data[i * 4 + 2] = p.im_hi;
      data[i * 4 + 3] = p.im_lo;
    }

    if (!this._texture) {
      this._texture = gl.createTexture();
    }
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F,
      this.referenceOrbit.length, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return this._texture;
  }
}
