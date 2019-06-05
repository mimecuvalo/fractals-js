class Fractal {
  constructor(canvasId) {
    this.variables = {};

    this.canvas = document.getElementById(canvasId || 'canvas');
    this.canvas.width = this.canvas.height = this.canvas.clientHeight;

    this.gl = this.canvas.getContext('webgl');
    this.gl.viewport(0, 0, this.canvas.clientHeight, this.canvas.clientHeight);

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
    return `
    precision highp float;

    // Double emulation based on GLSL Mandelbrot Shader by Henry Thasler (www.thasler.org/blog)
    //
    // Emulation based on Fortran-90 double-single package. See http://crd.lbl.gov/~dhbailey/mpdist/
    // Substract: res = ds_add(a, b) => res = a + b
    vec2 add(vec2 dsa, vec2 dsb) {
      vec2 dsc;
      float t1, t2, e;

      t1 = dsa.x + dsb.x;
      e = t1 - dsa.x;
      t2 = ((dsb.x - e) + (dsa.x - (t1 - e))) + dsa.y + dsb.y;

      dsc.x = t1 + t2;
      dsc.y = t2 - (dsc.x - t1);
      return dsc;
    }

    // Substract: res = ds_sub(a, b) => res = a - b
    vec2 sub(vec2 dsa, vec2 dsb) {
      vec2 dsc;
      float e, t1, t2;

      t1 = dsa.x - dsb.x;
      e = t1 - dsa.x;
      t2 = ((-dsb.x - e) + (dsa.x - (t1 - e))) + dsa.y - dsb.y;

      dsc.x = t1 + t2;
      dsc.y = t2 - (dsc.x - t1);
      return dsc;
    }

    // Compare: res = -1 if a < b
    //              =  0 if a == b
    //              =  1 if a > b
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

    // Multiply: res = ds_mul(a, b) => res = a * b
    vec2 mul(vec2 dsa, vec2 dsb) {
      vec2 dsc;
      float c11, c21, c2, e, t1, t2;
      float a1, a2, b1, b2, cona, conb, split = 8193.;

      cona = dsa.x * split;
      conb = dsb.x * split;
      a1 = cona - (cona - dsa.x);
      b1 = conb - (conb - dsb.x);
      a2 = dsa.x - a1;
      b2 = dsb.x - b1;

      c11 = dsa.x * dsb.x;
      c21 = a2 * b2 + (a2 * b1 + (a1 * b2 + (a1 * b1 - c11)));

      c2 = dsa.x * dsb.y + dsa.y * dsb.x;

      t1 = c11 + c2;
      e = t1 - c11;
      t2 = dsa.y * dsb.y + ((c2 - e) + (c11 - (t1 - e))) + c21;

      dsc.x = t1 + t2;
      dsc.y = t2 - (dsc.x - t1);

      return dsc;
    }

    // create double-single number from float
    vec2 set(float a) {
      vec2 z;
      z.x = a;
      z.y = 0.0;
      return z;
    }

    float rand(vec2 co){
      // implementation found at: lumina.sourceforge.net/Tutorials/Noise.html
      return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453);
    }

    vec2 complexMul(vec2 a, vec2 b) {
      return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
    }

    // double complex multiplication
    vec4 dcMul(vec4 a, vec4 b) {
      return vec4(sub(mul(a.xy, b.xy), mul(a.zw, b.zw)), add(mul(a.xy, b.zw), mul(a.zw, b.xy)));
    }

    vec4 dcAdd(vec4 a, vec4 b) {
      return vec4(add(a.xy, b.xy), add(a.zw, b.zw));
    }

    // Length of double complex
    vec2 dcLength(vec4 a) {
      return add(mul(a.xy, a.xy), mul(a.zw, a.zw));
    }

    vec4 dcSet(vec2 a) {
      return vec4(a.x, 0., a.y, 0.);
    }

    // Multiply double-complex with double
    vec4 dcMul(vec4 a, vec2 b) {
      return vec4(mul(a.xy, b), mul(a.wz, b));
    }
    `;
  }
}
