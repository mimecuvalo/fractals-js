class Fractal {
  constructor(canvasId) {
    this.variables = {};

    this.canvas = document.getElementById(canvasId || 'canvas');
    this.fullSize = this.canvas.clientHeight;
    this.canvas.width = this.canvas.height = this.fullSize;

    // preserveDrawingBuffer lets a frame be painted a tile at a time across several
    // animation frames without the compositor wiping the tiles already drawn.
    //
    // antialias:false because the default framebuffer is otherwise multisampled,
    // which both makes it an illegal blit target for the preview pass and spends
    // time smoothing edges the fragment shader is already supersampling itself.
    this.gl = this.canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      antialias: false,
    });
    this.gl.viewport(0, 0, this.fullSize, this.fullSize);

    // Preview renders go through an off-screen buffer and get blitted up, so the
    // canvas itself never resizes and never blanks.
    this.previewMode = false;
    this.previewSize = Math.max(1, Math.floor(this.fullSize / 4));

    // Progressive tiling state: grid x grid tiles, adapted to keep frames short.
    // Starts split rather than whole: the first full-resolution frame after a deep
    // zoom is exactly the one that can take seconds, and adapting only happens after
    // a frame has already been drawn.
    this.tileGrid = 4;
    this._tileQueue = null;
    this._tileRaf = null;
    this._tileTimer = null;

    // Enable float texture support (needed for perturbation reference orbit textures)
    this.gl.getExtension('EXT_color_buffer_float');

    this.glDrawArraysMode = this.gl.TRIANGLE_FAN;

    // Built once, up front. Creating it lazily meant binding a texture mid-frame,
    // which silently displaced the reference orbit bound to TEXTURE0 and left the
    // shader sampling nothing.
    this.createPreviewTarget();

    this.draw = this.throttle(this.drawInternal, 33);
  }

  // Underscore.js 1.5.2
  // http://underscorejs.org
  // (c) 2009-2013 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
  // Underscore may be freely distributed under the MIT license.
  throttle(func, wait, options) {
    var context, args, result;
    var timeout = null;
    var previous = 0;
    options || (options = {});
    var later = function() {
      previous = options.leading === false ? 0 : new Date;
      timeout = null;
      result = func.apply(context, args);
    };
    return function() {
      var now = new Date;
      if (!previous && options.leading === false) previous = now;
      var remaining = wait - (now - previous);
      context = this;
      args = arguments;
      if (remaining <= 0) {
        clearTimeout(timeout);
        timeout = null;
        previous = now;
        result = func.apply(context, args);
      } else if (!timeout && options.trailing !== false) {
        timeout = setTimeout(later, remaining);
      }
      return result;
    };
  }

  // Split a JS float64 into two float32 values (hi, lo) such that hi + lo ≈ value.
  // This preserves the full double-precision value across two single-precision uniforms.
  splitFloat64(value) {
    const hi = Math.fround(value);
    const lo = value - hi;
    return [hi, lo];
  }

  setPreview(on) {
    this.previewMode = on;
  }

  dispose() {
    this.cancelTiles();
  }

  cancelTiles() {
    if (this._tileRaf !== null) {
      cancelAnimationFrame(this._tileRaf);
      this._tileRaf = null;
    }
    if (this._tileTimer !== null && this._tileTimer !== undefined) {
      clearTimeout(this._tileTimer);
      this._tileTimer = null;
    }
    this._tileQueue = null;
  }

  setOptionsAndDraw(options, opt_mouseX, opt_mouseY) {
    for (const key in options) {
      this.variables[key].value = options[key];
    }

    this.draw();
  }

  drawInternal() {
    if (this.preDraw) {
      this.preDraw();
    }
    this.uploadUniforms();

    if (this.previewMode) {
      this.drawPreviewPass();
    } else {
      this.drawProgressive();
    }
  }

  uploadUniforms() {
    for (const key in this.variables) {
      const variable = this.variables[key];
      this.gl['uniform' + variable.type](variable.location, variable.value);
    }
  }

  // Render the whole canvas in one draw call, for views cheap enough not to need
  // splitting.
  drawAll() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.fullSize, this.fullSize);
    gl.drawArrays(this.glDrawArraysMode, 0, 4);
  }

  // Quarter-resolution pass for interactive motion. It renders into an off-screen
  // buffer and is blitted up to the canvas, so the canvas keeps its full size: a
  // resize would clear it, and the blurry preview is exactly what we want left on
  // screen underneath while the sharp tiles land on top of it.
  drawPreviewPass() {
    const gl = this.gl;
    const size = this.previewSize;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._previewFbo);
    gl.viewport(0, 0, size, size);
    gl.drawArrays(this.glDrawArraysMode, 0, 4);

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._previewFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, size, size,
                       0, 0, this.fullSize, this.fullSize,
                       gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.fullSize, this.fullSize);
  }

  createPreviewTarget() {
    const gl = this.gl;
    const size = this.previewSize;
    this._previewTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._previewTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._previewFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._previewFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._previewTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // Progressive rendering.
  //
  // A deep-zoom frame at full resolution can take most of a second inside one draw
  // call. That blocks the main thread for its whole duration, drops input, and on
  // some drivers trips the GPU watchdog that resets the context and loses the page.
  // Splitting the frame into scissored tiles spread across animation frames keeps
  // every individual draw short, so the page stays interactive and the image
  // refines visibly over the preview instead of arriving in one lurch.
  drawProgressive() {
    this.cancelTiles();

    if (this.tileGrid <= 1) {
      this.drawAll();
      this.measureAndAdapt();
      return;
    }

    const grid = this.tileGrid;
    const queue = [];
    for (let ty = 0; ty < grid; ty++) {
      for (let tx = 0; tx < grid; tx++) queue.push([tx, ty]);
    }
    this._tileQueue = queue;
    this._tileIndex = 0;
    this._tileWork = 0;
    this.pumpTiles();
  }

  pumpTiles() {
    const gl = this.gl;
    const queue = this._tileQueue;
    if (!queue) return;

    const grid = this.tileGrid;
    const step = Math.ceil(this.fullSize / grid);
    const frameStart = performance.now();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.fullSize, this.fullSize);
    gl.enable(gl.SCISSOR_TEST);

    // Draw at least one tile, then keep going only while the frame budget lasts.
    do {
      const [tx, ty] = queue[this._tileIndex++];
      gl.scissor(tx * step, ty * step, step, step);
      gl.drawArrays(this.glDrawArraysMode, 0, 4);
    } while (this._tileIndex < queue.length && performance.now() - frameStart < 8);

    gl.disable(gl.SCISSOR_TEST);

    // Only count time actually spent issuing draws; the idle stretches between
    // animation frames are not work and must not inflate the estimate.
    this._tileWork += performance.now() - frameStart;

    if (this._tileIndex < queue.length) {
      this.scheduleNextTile();
    } else {
      this._tileQueue = null;
      this.measureAndAdapt(this._tileWork);
    }
  }

  // Animation frames are the right pacing while the page is on screen. A hidden tab
  // suspends them entirely, though, which would leave a frame stuck half-drawn, so
  // fall back to timers there and let the render finish.
  scheduleNextTile() {
    if (document.hidden) {
      this._tileTimer = setTimeout(() => { this._tileTimer = null; this.pumpTiles(); }, 0);
    } else {
      this._tileRaf = requestAnimationFrame(() => { this._tileRaf = null; this.pumpTiles(); });
    }
  }

  // Pick the tile count for the next frame from what this one actually cost. The
  // work per pixel varies by orders of magnitude between a shallow view and a deep
  // one, so this is measured rather than guessed.
  measureAndAdapt(elapsed) {
    const gl = this.gl;
    if (elapsed === undefined) {
      // Single-draw path: time it with a pixel read, which forces the GPU to finish.
      const t0 = performance.now();
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      elapsed = performance.now() - t0;
    }

    // Target roughly one animation frame of GPU work per tile.
    const perTile = elapsed / (this.tileGrid * this.tileGrid);
    let grid = this.tileGrid;
    if (perTile > 14 && grid < 16) grid *= 2;
    else if (perTile < 2 && grid > 1) grid = Math.max(1, grid / 2);
    this.tileGrid = grid;
  }

  buildProgram(vertexShader, fragmentShader) {
    const prog = this.gl.createProgram();
    const vshader = this.createShader(vertexShader, this.gl.VERTEX_SHADER);
    const fshader = this.createShader(fragmentShader, this.gl.FRAGMENT_SHADER);

    this.gl.attachShader(prog, vshader);
    this.gl.attachShader(prog, fshader);
    this.gl.linkProgram(prog);

    if (!this.gl.getProgramParameter(prog, this.gl.LINK_STATUS)) {
      throw "Error linking program:\n" + this.gl.getProgramInfoLog(prog);
    }

    this.gl.validateProgram(prog);
    this.gl.deleteShader(vshader);
    this.gl.deleteShader(fshader);

    this.gl.useProgram(prog);

    this.makeArrayBuffer(this.buffer);

    for (const key in this.variables) {
      const variable = this.variables[key];
      variable.location = this.gl.getUniformLocation(prog, key);
    }
  }

  createShader(source, type) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      throw "Error compiling shader:\n" + this.gl.getShaderInfoLog(shader);
    }

    return shader;
  }

  makeArrayBuffer(data) {
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(data), this.gl.STATIC_DRAW);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
  }

  assignAttribOffsets(index, size, offsets) {
    const bytes = Float32Array.BYTES_PER_ELEMENT;
    let stride = 0;

    for (const name in offsets) {
      stride = Math.max(stride, offsets[name] + size);
    }

    for (const name in offsets) {
      this.gl.enableVertexAttribArray(index);
      this.gl.vertexAttribPointer(index, size, this.gl.FLOAT, false, stride * bytes, offsets[name] * bytes);
    }
  }

  get doublePrecisionMath() {
    return `#version 300 es
    precision highp float;

    // Double-single emulation using Dekker's algorithms.
    // Represents extended-precision numbers as vec2(high, low) pairs.
    // Based on: https://github.com/iskandarov-egor/mandelset
    //
    // The 'one' uniform (always 1.0) prevents the GLSL compiler from
    // optimizing away error-correction terms that look like no-ops.
    uniform float one;

    // Veltkamp split for single-precision float (24-bit mantissa).
    // Splits float into high and low parts for exact multiplication.
    vec2 splitFloat(float x) {
      float c = 4097.0; // 2^12 + 1, correct for 24-bit mantissa
      float y = c * x;
      float b = x - y;
      float hi = y * one + b;
      float lo = x - hi;
      return vec2(hi, lo);
    }

    // Fast2Sum: error-free floating-point addition.
    // Requires |a| >= |b| for correctness.
    vec2 fast2sum(float a, float b) {
      if (abs(a) < abs(b)) {
        float t = a; a = b; b = t;
      }
      float s = a + b;
      float z = s - one * a;
      float e = b - one * z;
      return vec2(s, e);
    }

    // Dekker's exact multiplication of two floats.
    // Returns (product, error) such that a*b = product + error exactly.
    vec2 dekkerMul(float a, float b) {
      vec2 x = splitFloat(a);
      vec2 y = splitFloat(b);
      float p = a * b;
      float err = -p + x.x * y.x;
      err = err + x.x * y.y;
      err = err + x.y * y.x;
      err = err + x.y * y.y;
      return vec2(p, err);
    }

    // Double-single addition: res = a + b
    vec2 add(vec2 a, vec2 b) {
      vec2 r;
      float s;
      if (abs(a.x) >= abs(b.x)) {
        r = fast2sum(a.x, b.x);
        s = ((r.y + b.y) * one + a.y);
      } else {
        r = fast2sum(b.x, a.x);
        s = ((r.y + a.y) * one + b.y);
      }
      return fast2sum(r.x, s);
    }

    // Double-single subtraction: res = a - b
    vec2 sub(vec2 a, vec2 b) {
      return add(a, vec2(-b.x, -b.y));
    }

    // Compare: res = -1 if a < b, 0 if a == b, 1 if a > b
    float cmp(vec2 dsa, vec2 dsb) {
      if (dsa.x < dsb.x) {
        return -1.;
      } else if (dsa.x == dsb.x) {
        if (dsa.y < dsb.y) {
          return -1.;
        } else if (dsa.y == dsb.y) {
          return 0.;
        } else {
          return 1.;
        }
      } else {
        return 1.;
      }
    }

    // Double-single multiplication using Dekker's algorithm: res = a * b
    vec2 mul(vec2 a, vec2 b) {
      vec2 c = dekkerMul(a.x, b.x);
      float p1 = a.x * b.y;
      float p2 = a.y * b.x;
      c.y = c.y + one * (p1 + p2);
      return fast2sum(c.x, c.y);
    }

    // Create double-single number from float
    vec2 set(float a) {
      return vec2(a, 0.0);
    }

    float rand(vec2 co){
      // implementation found at: lumina.sourceforge.net/Tutorials/Noise.html
      return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453);
    }

    vec2 complexMul(vec2 a, vec2 b) {
      return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
    }

    // Double-complex multiplication: (a.re + a.im*i) * (b.re + b.im*i)
    vec4 dcMul(vec4 a, vec4 b) {
      return vec4(sub(mul(a.xy, b.xy), mul(a.zw, b.zw)), add(mul(a.xy, b.zw), mul(a.zw, b.xy)));
    }

    vec4 dcAdd(vec4 a, vec4 b) {
      return vec4(add(a.xy, b.xy), add(a.zw, b.zw));
    }

    // Length squared of double-complex
    vec2 dcLength(vec4 a) {
      return add(mul(a.xy, a.xy), mul(a.zw, a.zw));
    }

    vec4 dcSet(vec2 a) {
      return vec4(a.x, 0., a.y, 0.);
    }

    // Multiply double-complex with double-single scalar
    vec4 dcMul(vec4 a, vec2 b) {
      return vec4(mul(a.xy, b), mul(a.zw, b));
    }
    `;
  }
}
