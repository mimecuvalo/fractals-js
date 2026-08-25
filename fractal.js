class Fractal {
  constructor(canvasId) {
    this.variables = {};

    this.canvas = document.getElementById(canvasId || 'canvas');
    this.fullSize = this.canvas.clientHeight;
    this.canvas.width = this.canvas.height = this.fullSize;

    this.gl = this.canvas.getContext('webgl2');
    this.gl.viewport(0, 0, this.fullSize, this.fullSize);

    // Enable float texture support (needed for perturbation reference orbit textures)
    this.gl.getExtension('EXT_color_buffer_float');

    this.glDrawArraysMode = this.gl.TRIANGLE_FAN;

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
    const size = on ? Math.floor(this.fullSize / 4) : this.fullSize;
    this.canvas.width = this.canvas.height = size;
    this.gl.viewport(0, 0, size, size);
  }

  dispose() {

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

    for (const key in this.variables) {
      const variable = this.variables[key];
      this.gl['uniform' + variable.type](variable.location, variable.value);
    }
    this.gl.drawArrays(this.glDrawArraysMode, 0, 4);
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
