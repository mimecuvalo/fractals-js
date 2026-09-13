// adapted and greatly modified from
// http://blog.hvidtfeldts.net/index.php/2012/07/double-precision-in-opengl-and-webgl/
// http://hvidtfeldts.net/WebGL-DP/webgl.html  (code is out-of-date but works if you tweak it)
// http://hvidtfeldts.net/WebGL/webgl.html

class Mandelbrot extends Fractal {
  constructor(canvasId) {
    super(canvasId);

    const w = this.canvas.width * 0.5;
    const h = this.canvas.height * 0.5;

    this.variables = {
      one:        { type: '1f',  value: 1.0 },
      antiAlias:  { type: '1i',  value: 1 },
      blobSize:   { type: '1f',  value: 1000.0 },
      center:     { type: '2fv', value: [0, 0] },
      colorControl:  { type: '1f',  value: 1.0 },
      iterations: { type: '1i',  value: 128 },
      offsetX:    { type: '2fv', value: [0.0, 0.0] },
      offsetY:    { type: '2fv', value: [0.0, 0.0] },
      pixelSize:  { type: '2fv', value: [1.0 / w, 1.0 / h] },
      time:       { type: '1f',  value: Date.now() / 1000 },
      zoom:       { type: '2fv', value: [1.5, 0.0] },
      // Perturbation uniforms
      usePerturbation: { type: '1i',  value: 0 },
      refOrbitLength:  { type: '1i',  value: 0 },
      refOrbitTexture: { type: '1i',  value: 0 },
      refOffsetX:      { type: '1f',  value: 0.0 },
      refOffsetY:      { type: '1f',  value: 0.0 },
      // Series approximation: skip this many iterations, starting from the
      // pre-computed deltaZ that seriesA/B/C evaluate to.
      seriesSkip:      { type: '1i',  value: 0 },
      seriesA:         { type: '2fv', value: [0.0, 0.0] },
      seriesB:         { type: '2fv', value: [0.0, 0.0] },
      seriesC:         { type: '2fv', value: [0.0, 0.0] },
      refOffsetScaled: { type: '2fv', value: [0.0, 0.0] },
    };

    this.buffer = [
       1.0,  1.0,  0.0,
      -1.0,  1.0,  0.0,
       1.0, -1.0,  0.0,
      -1.0, -1.0,  0.0,
    ];

    this.glDrawArraysMode = this.gl.TRIANGLE_STRIP;

    // Complex center = offset + centerReShift on the real axis. Mandelbrot's shader
    // bakes in a -1 shift (`offsetX - 1`); Julia uses no shift. The UI reads this to
    // build the high-precision centerDD for the perturbation reference.
    this.centerReShift = -1;

    this.perturbation = new PerturbationRenderer();
    // A reference computed off-thread lands after the frame that asked for it,
    // so repaint when it arrives.
    this.perturbation.onReady = () => this.draw();

    this.buildProgram(this.vertexShader, this.doublePrecisionMath + this.fragmentShader);
    this.assignAttribOffsets(0, 3, { position: 0 });
  }

  setOptionsAndDraw(options, ...args) {
    // Split float64 values into hi/lo pairs for double-precision uniforms.
    // Note: the high-precision complex center is supplied out-of-band via the
    // `centerDD` property (see preDraw) so it never round-trips through the float32
    // DS uniforms, which would cap it at ~1e-14.
    const processed = {...options};
    for (const key of ['offsetX', 'offsetY', 'zoom']) {
      if (key in processed && typeof processed[key] === 'number') {
        processed[key] = this.splitFloat64(processed[key]);
      }
    }
    super.setOptionsAndDraw(processed, ...args);
  }

  preDraw() {
    this.variables['time'].value = Date.now() / 1000;

    // Reconstitute full-precision values from hi/lo pairs
    const offsetX = this.variables['offsetX'].value;
    const offsetY = this.variables['offsetY'].value;
    const zoomPair = this.variables['zoom'].value;
    const zoomVal = zoomPair[0] + zoomPair[1];
    const offsetXVal = offsetX[0] + offsetX[1];
    const offsetYVal = offsetY[0] + offsetY[1];
    const iterations = this.variables['iterations'].value;
    const p = this.perturbation;

    // Complex center as double-double: prefer the UI's high-precision value; fall
    // back to the DS uniform (float64-ish) when it isn't supplied.
    const cxDD = this.centerDD ? this.centerDD.re : p.ddFrom(offsetXVal - 1.0);
    const cyDD = this.centerDD ? this.centerDD.im : p.ddFrom(offsetYVal);
    const cx = p.ddToNumber(cxDD);
    const cy = p.ddToNumber(cyDD);

    // Shallow zoom: the viewport is too wide for a single reference orbit to
    // approximate (perturbation assumes deltaC is small), so iterate directly in
    // double-single. Deep zoom: switch to single-float perturbation.
    if (!p.shouldUsePerturbation(zoomVal)) {
      this.variables['usePerturbation'].value = 0;
      return;
    }

    // Grid/step search scales with the true render size, not the (possibly
    // shrunken) preview buffer, so reference selection is stable while zooming.
    p.ensureReference(cxDD, cyDD, zoomVal, iterations, this.fullSize, this.fullSize);

    const tex = p.createOrUpdateTexture(this.gl);
    const orbitLen = p.referenceOrbitLength;
    // Rebasing reads reference points m and m+1 each step, so it needs at least
    // two stored orbit points to be well-defined.
    if (tex && orbitLen >= 2) {
      this.variables['usePerturbation'].value = 1;
      this.variables['refOrbitLength'].value = orbitLen;

      // Reference offset = center - reference, computed in double-double so it stays
      // exact; the result is tiny (~zoom) and fits a single-float shader uniform.
      const ref = p.referencePoint;
      this.variables['refOffsetX'].value = p.ddToNumber(p.ddSub(cxDD, ref.reDD));
      this.variables['refOffsetY'].value = p.ddToNumber(p.ddSub(cyDD, ref.imDD));

      // The shader works in the normalized screen coordinate u = deltaC / zoom, so
      // hand it the reference offset in those same units.
      const offX = this.variables['refOffsetX'].value;
      const offY = this.variables['refOffsetY'].value;
      this.variables['refOffsetScaled'].value = [offX / zoomVal, offY / zoomVal];

      // Series approximation lets every pixel jump the first `skip` iterations.
      const series = p.seriesFor(zoomVal, iterations);
      this.variables['seriesSkip'].value = series.skip;
      this.variables['seriesA'].value = series.a;
      this.variables['seriesB'].value = series.b;
      this.variables['seriesC'].value = series.c;

      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    } else {
      // No usable reference — fall back to direct iteration rather than black.
      this.variables['usePerturbation'].value = 0;
      this.variables['seriesSkip'].value = 0;
    }
  }

  get vertexShader() {
    return `#version 300 es
    layout(location = 0) in vec3 position;
    out vec2 coord;

    void main(void) {
      coord = position.xy;
      gl_Position = vec4(position, 1.0);
    }
    `;
  }

  get fragmentShader() {
    return `
    const int MAX_ITERATIONS = 16384;

    in vec2 coord;
    out vec4 fragColor;
    uniform vec2 pixelSize;
    uniform float time;
    uniform int iterations;
    uniform int antiAlias;

    // Trippy stuff
    uniform float blobSize;
    uniform float colorControl;

    // Mandelbrot coords (hi/lo pairs for double-single precision)
    uniform vec2 offsetX;
    uniform vec2 offsetY;
    uniform vec2 zoom;

    // Perturbation uniforms
    uniform int usePerturbation;
    uniform int refOrbitLength;
    uniform highp sampler2D refOrbitTexture;
    uniform float refOffsetX;
    uniform float refOffsetY;
    uniform int seriesSkip;
    uniform vec2 seriesA;
    uniform vec2 seriesB;
    uniform vec2 seriesC;
    uniform vec2 refOffsetScaled;

    // Color parameters
    float R = 0.0;
    float G = 0.43;
    float B = 1.;

    // sRGB <-> linear conversion for gamma-correct blending
    vec3 srgbToLinear(vec3 c) {
      return pow(max(c, 0.0), vec3(2.2));
    }
    vec3 linearToSrgb(vec3 c) {
      return pow(max(c, 0.0), vec3(1.0 / 2.2));
    }

    // Shared coloring: iterValue < 0 means inside the set.
    // Returns color in linear space for correct AA blending.
    vec3 colorize(float iterValue, float falloff) {
      vec3 srgb;
      if (iterValue < 0.0) {
        srgb = vec3(0.05, 0.01, 0.02);
      } else {
        float co = sqrt(max(0.0, iterValue) / (256.0 * colorControl));
        srgb = falloff * vec3(
            .5 + .5 * cos(6.2831 * co + R),
            .5 + .5 * cos(6.2831 * co + G),
            .5 + .5 * cos(6.2831 * co + B));
      }
      return srgbToLinear(srgb);
    }

    // Direct double-single iteration (used at wide zoom levels)
    float directIterations(vec2 p) {
      vec4 c = dcAdd(dcMul(dcSet(p), zoom), vec4(sub(offsetX, set(1.0)), offsetY));
      vec4 dZ = dcSet(vec2(0.0, 0.0));

      for (int i = 0; i <= MAX_ITERATIONS; i++) {
        if (i > iterations) {
          return -1.0;
        }
        if (cmp(dcLength(dZ), set(blobSize)) > 0.) {
          float dotZZ = dZ.x * dZ.x + dZ.z * dZ.z;
          return float(i) + 1.0 - log2(.5 * log2(dotZZ));
        }
        dZ = dcAdd(dcMul(dZ, dZ), c);
      }
      return -1.0;
    }

    // Perturbation iteration with rebasing (Zhuoran's method), used at deep zoom.
    //
    // Single-precision float32 delta, following the technique from mandelset
    // (iskandarov-egor/mandelset). The perturbation delta (deltaC, deltaZ) stays
    // tiny -- magnitude ~= zoom -- so float32's huge *exponent* range (down to ~1e-38)
    // sets the reachable depth, while the ~1e-7 relative mantissa only ever has to
    // resolve sub-pixel differences. This reaches ~1e-30 zoom and is ~10x cheaper
    // than double-single, whose hard wall sits at ~2^-48 (3.5e-15) because a tiny
    // deltaZ vanishes when stored relative to the O(1) reference.
    //
    // Plain perturbation walks the reference in lockstep with the pixel and fails two
    // ways. If the reference escapes before the iteration budget, every pixel that outlives it
    // gets reported as interior -- a solid black screen. And deltaZ can grow until it
    // dwarfs the reference, at which point Z_ref + deltaZ loses its significant bits
    // and the pixel glitches into a wrong-coloured blob.
    //
    // Rebasing fixes both with one test: whenever |z| < |deltaZ|, or the reference
    // runs out, restart at orbit index 0 and carry the full z across as the new
    // deltaZ. That substitution is exact here because the Mandelbrot reference starts
    // at Z_ref[0] == 0, so z == Z_ref[0] + z identically. Correctness therefore no
    // longer depends on the reference lasting the whole render.
    float perturbIterations(vec2 p) {
      // Work in the normalized screen coordinate u, so that deltaC = u * zoom
      // exactly. refOffsetScaled is the center->reference vector in the same units.
      vec2 u = p + refOffsetScaled;
      float dcx = u.x * zoom.x;
      float dcy = u.y * zoom.x;

      float dx = 0.0;  // deltaZ.re
      float dy = 0.0;  // deltaZ.im
      int m = 0;       // index into the reference orbit, reset by each rebase

      // Series approximation: the first seriesSkip iterations are identical in form
      // for every pixel, so the CPU solved them once as a cubic in u and we drop
      // straight into the orbit at that point. seriesA/B/C are pre-scaled by powers
      // of zoom (see computeSeries), which is what keeps them inside float32.
      if (seriesSkip > 0) {
        vec2 u2 = complexMul(u, u);
        vec2 u3 = complexMul(u2, u);
        vec2 d = complexMul(seriesA, u) + complexMul(seriesB, u2) + complexMul(seriesC, u3);
        dx = d.x;
        dy = d.y;
        m = seriesSkip;
      }

      // Z_ref[m], carried in registers so the loop costs one texel fetch per
      // iteration rather than two.
      vec4 startTexel = texelFetch(refOrbitTexture, ivec2(m, 0), 0);
      float Zx = startTexel.x;
      float Zy = startTexel.z;

      for (int i = seriesSkip; i < MAX_ITERATIONS; i++) {
        if (i >= iterations) break;

        // Perturbation recurrence: deltaZ' = 2*Z_ref*deltaZ + deltaZ^2 + deltaC
        // (kept entirely in the small-magnitude delta domain -- never rounded
        // against the O(1) reference).
        float ndx = 2.0 * (Zx * dx - Zy * dy) + (dx * dx - dy * dy) + dcx;
        float ndy = 2.0 * (Zx * dy + Zy * dx) + (2.0 * dx * dy) + dcy;
        dx = ndx;
        dy = ndy;

        // Advance the reference. Texel packs (re_hi, re_lo, im_hi, im_lo); the
        // single-float reference is just the high word of each component.
        m++;
        vec4 refTexel = texelFetch(refOrbitTexture, ivec2(m, 0), 0);
        Zx = refTexel.x;
        Zy = refTexel.z;

        // Total z = Z_ref[m] + deltaZ. Adding tiny deltaZ to the O(1) reference here
        // is safe: it only matters once deltaZ has grown to O(1) near escape.
        float zx = Zx + dx;
        float zy = Zy + dy;
        float zz = zx * zx + zy * zy;
        if (zz > blobSize) {
          return float(i + 1) + 1.0 - log2(0.5 * log2(max(1e-20, zz)));
        }

        // Rebase when the reference has stopped carrying information (|z| < |deltaZ|,
        // so the sum is mostly delta anyway) or when advancing would run off the end
        // of the stored orbit. Restarting at index 0 needs no fetch: Z_ref[0] == 0.
        if (zz < dx * dx + dy * dy || m >= refOrbitLength - 1) {
          dx = zx;
          dy = zy;
          m = 0;
          Zx = 0.0;
          Zy = 0.0;
        }
      }
      return -1.0;
    }

    void main() {
      const int MAX_ANTI_ALIAS = 4;
      vec3 v = vec3(0.0, 0.0, 0.0);
      float d = 1.0 / float(antiAlias);
      vec2 ard = vec2(pixelSize.x, pixelSize.y) * d;
      for (int x = 0; x < MAX_ANTI_ALIAS; x++) {
        if (x >= antiAlias) break;
        for (int y = 0; y < MAX_ANTI_ALIAS; y++) {
          if (y >= antiAlias) break;
          vec2 cor = coord + vec2(x, y) * ard;
          float falloff = exp(-dot(cor, cor));
          float it;
          if (usePerturbation == 1) {
            it = perturbIterations(cor);
          } else {
            it = directIterations(cor);
          }
          v += colorize(it, falloff).bgr;
        }
      }
      fragColor = vec4(linearToSrgb(v / float(antiAlias * antiAlias)), 1.0);
    }
    `;
  }

  // Legacy purposes: here's the single precision shader.
  get singlePrecisionShader() {
    return `
    vec3 colorSinglePrecision(vec2 p, float falloff) {
      vec2 c = p * zoom + effectiveCenter;
      vec2 z = vec2(0.0, 0.0);

      int j = iterations;
      for (int i = 0; i <= MAX_ITERATIONS; i++) {
        if (i > iterations) {
          break;
        }
        if (length(z) > 1000.0) {
          break;
        }
        z = complexMul(z, z) + c;
        j = i;
      }

      float dotZZ = dot(z, z);

      if (j < iterations) {
        // The color scheme here is based on one
        // from the Mandelbrot in Inigo Quilez's Shader Toy:
        float co = float(j) + 1.0 - log2(.5 * log2(dotZZ));
        co = sqrt(max(0., co) / 256.0);
        co += rand(coord * fract(time)) * 0.02;
        return falloff * vec3(
            .5 + .5 * cos(6.2831 * co + R),
            .5 + .5 * cos(6.2831 * co + G),
            .5 + .5 * cos(6.2831 * co + B));
      } else {
        // Inside
        return vec3(0.05, 0.01, 0.02);
      }
    }

    // Splits in single and double precision halves
    vec3 colorSplit(vec2 cor) {
      float split = (smoothstep(0.0, 1.0, (cor.y * 0.5) + 0.5) - 0.5) * 0.1;
      if (cor.x - split < 0.) {
        vec2 c = vec2(cor.x * 2.0 + 1.0, cor.y);
        vec2 p = c * zoom + effectiveCenter;
        float falloff = exp(-dot(c, c) / (1.0 + 0.2 * rand(cor)));
        return colorSinglePrecision(c, falloff);
      } else {
        vec2 c = vec2(cor.x * 2.0 - 1.0, cor.y);
        float falloff = exp(-dot(c, c) / 1.0 + 0.2 * rand(cor));
        vec2 p = c * zoom + effectiveCenter;
        return (colorDoublePrecision(c, falloff)).bgr;
      }
    }
    `;
  }
}
