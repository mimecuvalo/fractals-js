// adapted and greatly modified from http://universefactory.net/test/julia/

class Julia extends Fractal {
  constructor(canvasId) {
    super(canvasId);

    const w = this.canvas.width * 0.5;
    const h = this.canvas.height * 0.5;

    this.variables = {
      one:        { type: '1f',  value: 1.0 },
      antiAlias:  { type: '1i',  value: 1 },
      blobSize:   { type: '1f',  value: 2.0 },
      center:     { type: '2fv', value: [0.0, 0.0] },
      colorControl:  { type: '1f',  value: 2.0 },
      iterations: { type: '1i',  value: 128 },
      offsetX:    { type: '2fv', value: [0.0, 0.0] },
      offsetY:    { type: '2fv', value: [0.0, 0.0] },
      pixelSize:  { type: '2fv', value: [1.0 / w, 1.0 / h] },
      zoom:       { type: '2fv', value: [1.5, 0.0] },
      // Perturbation uniforms (deep-zoom path; mirrors Mandelbrot)
      usePerturbation: { type: '1i',  value: 0 },
      refOrbitLength:  { type: '1i',  value: 0 },
      refOrbitTexture: { type: '1i',  value: 0 },
      refOffsetX:      { type: '1f',  value: 0.0 },
      refOffsetY:      { type: '1f',  value: 0.0 },
    };
    this.buffer = [-1, -1, 1, -1, 1, 1, -1, 1];

    // Julia's complex center is the z-plane offset directly (no -1 shift like
    // Mandelbrot). The UI reads this to build the high-precision centerDD.
    this.centerReShift = 0;

    // Perturbation reference in 'julia' mode: orbit starts at the reference point and
    // iterates z^2 + c with c fixed (the `center` uniform).
    this.perturbation = new PerturbationRenderer();
    this.perturbation.mode = 'julia';
    this.perturbation.onReady = () => this.draw();

    this.buildProgram(this.vertexShader, this.doublePrecisionMath + this.fragmentShader);
    this.assignAttribOffsets(0, 2, { p: 0 });
  }

  preDraw() {
    // Reconstitute full-precision values from hi/lo pairs.
    const offsetX = this.variables['offsetX'].value;
    const offsetY = this.variables['offsetY'].value;
    const zoomPair = this.variables['zoom'].value;
    const zoomVal = zoomPair[0] + zoomPair[1];
    const offsetXVal = offsetX[0] + offsetX[1];
    const offsetYVal = offsetY[0] + offsetY[1];
    const iterations = this.variables['iterations'].value;
    const c = this.variables['center'].value;
    const p = this.perturbation;

    // Fixed Julia constant drives the reference orbit.
    p.juliaC = { re: c[0], im: c[1] };

    // z-plane center as double-double: prefer the UI's high-precision value, else the
    // DS uniform (no -1 shift for Julia).
    const czDD = this.centerDD ? this.centerDD.re : p.ddFrom(offsetXVal);
    const cwDD = this.centerDD ? this.centerDD.im : p.ddFrom(offsetYVal);

    // Wide zoom: iterate directly in double-single. Deep zoom: single-float perturbation.
    if (!p.shouldUsePerturbation(zoomVal)) {
      this.variables['usePerturbation'].value = 0;
      return;
    }

    p.ensureReference(czDD, cwDD, zoomVal, iterations, this.fullSize, this.fullSize);

    const tex = p.createOrUpdateTexture(this.gl);
    const orbitLen = p.referenceOrbitLength;
    if (tex && orbitLen > 0) {
      this.variables['usePerturbation'].value = 1;
      this.variables['refOrbitLength'].value = orbitLen;

      // Reference offset = center - reference (double-double, stays exact; tiny result).
      const ref = p.referencePoint;
      this.variables['refOffsetX'].value = p.ddToNumber(p.ddSub(czDD, ref.reDD));
      this.variables['refOffsetY'].value = p.ddToNumber(p.ddSub(cwDD, ref.imDD));

      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    } else {
      this.variables['usePerturbation'].value = 0;
    }
  }

  setOptionsAndDraw(options, ...args) {
    const processed = {...options};
    for (const key of ['offsetX', 'offsetY', 'zoom']) {
      if (key in processed && typeof processed[key] === 'number') {
        processed[key] = this.splitFloat64(processed[key]);
      }
    }
    super.setOptionsAndDraw(processed, ...args);
  }

  get vertexShader() {
    return `#version 300 es
    layout(location = 0) in vec2 p;
    out vec2 coord;

    void main() {
      coord = p;
      gl_Position = vec4(p, 0.0, 1.0);
    }
    `;
  }

  get fragmentShader() {
    return `
    // Raised from 1536: at deeper zoom, pixels that hadn't escaped by 1536 all
    // pinned to the same value and whole regions washed out to a flat colour.
    const int MAX_ITERATIONS = 4096;
    uniform int iterations;
    uniform int antiAlias;
    uniform float blobSize;
    uniform float colorControl;
    uniform vec2 center;
    uniform vec2 zoom;
    uniform vec2 offsetX;
    uniform vec2 offsetY;
    uniform vec2 pixelSize;
    in vec2 coord;
    out vec4 fragColor;

    // Palette scale. The colour ramp below is expressed in units of
    // escapeValue/COLOR_SCALE, so this - and NOT the iteration budget - decides which
    // escape times land in the red/yellow/green/blue/white bands. Normalising by the
    // iteration count instead would repaint the whole image whenever that
    // budget changed (e.g. 128 on first draw, 2000 after the first zoom), which is
    // exactly the "colours jump on the first zoom" bug. Anything slower than
    // COLOR_SCALE saturates to white, matching the old iterations=128 look.
    const float COLOR_SCALE = 128.0;

    // Perturbation uniforms (deep-zoom path)
    uniform int usePerturbation;
    uniform int refOrbitLength;
    uniform highp sampler2D refOrbitTexture;
    uniform float refOffsetX;
    uniform float refOffsetY;

    // Smooth escape value, shared by both iteration paths. zLen = |z| at escape.
    float escapeValue(int i, float zLen) {
      return float(i) + colorControl - 1.0 - log(log(zLen * 2.0) / log(2.0)) / log(colorControl);
    }

    // Double-precision Julia iteration
    float niterDP(vec2 cor) {
      // Construct z0 in double-single precision: z0 = zoom * cor + offset
      vec4 z = dcAdd(dcMul(dcSet(cor), zoom), vec4(offsetX, offsetY));
      vec4 c = dcSet(center);

      for (int i = 0; i < MAX_ITERATIONS; ++i) {
        if (i >= iterations) break;
        z = dcAdd(dcMul(z, z), c);
        vec2 r2 = dcLength(z);
        if (cmp(r2, set(blobSize)) > 0.0) {
          float dotZZ = z.x * z.x + z.z * z.z;
          return escapeValue(i, sqrt(dotZZ));
        }
      }
      return float(iterations);
    }

    // Perturbation iteration (deep-zoom path).
    //
    // For Julia, c is fixed, so per-pixel variation lives entirely in the initial
    // point: z0 = Z0_ref + delta0. With delta_n = z_n - Z_n the recurrence collapses
    // to delta' = 2*Z_ref*delta + delta^2 (no per-step delta-c term, unlike
    // Mandelbrot). delta stays tiny (~zoom), so single-float32's exponent range sets
    // the reachable depth (~1e-30) far past double-single's 3.5e-15 wall.
    float niterPerturb(vec2 cor) {
      // delta0 = screenCoord * zoom + refOffset (center -> reference vector).
      float dx = cor.x * zoom.x + refOffsetX;
      float dy = cor.y * zoom.x + refOffsetY;

      for (int i = 0; i < MAX_ITERATIONS; i++) {
        if (i >= iterations || i >= refOrbitLength) break;

        vec4 refTexel = texelFetch(refOrbitTexture, ivec2(i, 0), 0);
        float Zx = refTexel.x;
        float Zy = refTexel.z;

        // Total z = Z_ref + delta.
        float zx = Zx + dx;
        float zy = Zy + dy;
        float dotZZ = zx * zx + zy * zy;
        if (dotZZ > blobSize) {
          return escapeValue(i, sqrt(dotZZ));
        }

        // delta' = 2*Z_ref*delta + delta^2 (kept in the small-magnitude delta domain).
        float new_dx = 2.0 * (Zx * dx - Zy * dy) + (dx * dx - dy * dy);
        float new_dy = 2.0 * (Zx * dy + Zy * dx) + (2.0 * dx * dy);
        dx = new_dx;
        dy = new_dy;
      }
      return float(iterations);
    }

    vec3 red(float a)    { return vec3(a,       0.0,     0.0); }
    vec3 yellow(float a) { return vec3(1.0,     a,       0.0); }
    vec3 green(float a)  { return vec3(1.0 - a, 1.0,     0.0); }
    vec3 blue(float a)   { return vec3(0.0,     1.0 - a, a); }
    vec3 white(float a)  { return vec3(a,       a,       1.0); }
    vec3 color(float a) {
      if (a <= 0.0)  return vec3(               0.0);
      if (a <= 0.03) return red(   (a - 0.0)  / 0.03);
      if (a <= 0.1)  return yellow((a - 0.03) / 0.07);
      if (a <= 0.2)  return green( (a - 0.1)  / 0.1);
      if (a <= 0.4)  return blue(  (a - 0.2)  / 0.2);
      if (a <= 1.0)  return white( (a - 0.4)  / 0.6);
      return vec3(1.0);
    }

    void main() {
      const int MAX_ANTI_ALIAS = 4;
      vec3 v = vec3(0.0);
      float d = 1.0 / float(antiAlias);
      vec2 ard = pixelSize * d;
      for (int x = 0; x < MAX_ANTI_ALIAS; x++) {
        if (x >= antiAlias) break;
        for (int y = 0; y < MAX_ANTI_ALIAS; y++) {
          if (y >= antiAlias) break;
          vec2 cor = coord + vec2(x, y) * ard;
          float raw = (usePerturbation == 1) ? niterPerturb(cor) : niterDP(cor);
          float a = raw / COLOR_SCALE;
          // Accumulate in linear space for gamma-correct blending
          vec3 srgb = color(a);
          v += pow(max(srgb, 0.0), vec3(2.2));
        }
      }
      v = v / float(antiAlias * antiAlias);
      fragColor = vec4(pow(max(v, 0.0), vec3(1.0 / 2.2)), 1.0);
    }
    `
  }
}
