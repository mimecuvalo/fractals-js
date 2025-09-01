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
      antiAlias:  { type: '1i',  value: 1 },
      blobSize:   { type: '1f',  value: 1000.0 },
      center:     { type: '2fv', value: [0, 0] },
      colorControl:  { type: '1f',  value: 1.0 },
      iterations: { type: '1i',  value: 128 },
      offsetX:    { type: '1f',  value: 0.0 },
      offsetY:    { type: '1f',  value: 0.0 },
      pixelSize:  { type: '2fv', value: [1.0 / w, 1.0 / h] },
      time:       { type: '1f',  value: Date.now() / 1000 },
      zoom:       { type: '1f',  value: 1.5 },
    };
  }

  async setupCompute() {
    this.createBuffers();
    await this.createComputePipeline(this.doublePrecisionMathWGSL + this.computeShader);
    await this.createRenderPipeline();
    this.createBindGroups();
  }

  setupWebGL() {
    // WebGL fallback setup
    this.buffer = [
       1.0,  1.0,  0.0,
      -1.0,  1.0,  0.0,
       1.0, -1.0,  0.0,
      -1.0, -1.0,  0.0,
    ];

    this.glDrawArraysMode = this.gl.TRIANGLE_STRIP;

    this.buildProgramWebGL(this.vertexShaderGLSL, this.doublePrecisionMathGLSL + this.fragmentShaderGLSL);
    this.assignAttribOffsetsWebGL(0, 3, { position: 0 });
  }

  buildProgramWebGL(vertexShader, fragmentShader) {
    const prog = this.gl.createProgram();
    const vshader = this.createShaderWebGL(vertexShader, this.gl.VERTEX_SHADER);
    const fshader = this.createShaderWebGL(fragmentShader, this.gl.FRAGMENT_SHADER);

    this.gl.attachShader(prog, vshader);
    this.gl.attachShader(prog, fshader);
    this.gl.linkProgram(prog);

    if (!this.gl.getProgramParameter(prog, this.gl.LINK_STATUS)) {
      throw "Error linking WebGL program:\n" + this.gl.getProgramInfoLog(prog);
    }

    this.gl.validateProgram(prog);
    this.gl.deleteShader(vshader);
    this.gl.deleteShader(fshader);

    this.gl.useProgram(prog);

    this.makeArrayBufferWebGL(this.buffer);

    for (const key in this.variables) {
      const variable = this.variables[key];
      variable.location = this.gl.getUniformLocation(prog, key);
    }
  }

  createShaderWebGL(source, type) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      throw "Error compiling WebGL shader:\n" + this.gl.getShaderInfoLog(shader);
    }

    return shader;
  }

  makeArrayBufferWebGL(data) {
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(data), this.gl.STATIC_DRAW);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
  }

  assignAttribOffsetsWebGL(index, size, offsets) {
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

  preDraw() {
    this.variables['time'].value = Date.now() / 1000;
  }

  getUniformStructLayout() {
    // Must match the WGSL struct layout exactly
    return [
      { name: 'antiAlias', offset: 0 },   // i32 - 4 bytes
      { name: 'blobSize', offset: 4 },    // f32 - 4 bytes  
      { name: 'center', offset: 8 },      // vec2<f32> - 8 bytes
      { name: 'colorControl', offset: 16 }, // f32 - 4 bytes (aligned to 16)
      { name: 'iterations', offset: 20 },  // i32 - 4 bytes
      { name: 'offsetX', offset: 24 },     // f32 - 4 bytes
      { name: 'offsetY', offset: 28 },     // f32 - 4 bytes
      { name: 'pixelSize', offset: 32 },   // vec2<f32> - 8 bytes (aligned to 16)
      { name: 'time', offset: 40 },        // f32 - 4 bytes
      { name: 'zoom', offset: 44 },        // f32 - 4 bytes
    ];
  }

  get computeShader() {
    return `
    struct Uniforms {
      antiAlias: i32,
      blobSize: f32,
      center: vec2<f32>,
      colorControl: f32,
      iterations: i32,
      offsetX: f32,
      offsetY: f32,
      pixelSize: vec2<f32>,
      time: f32,
      zoom: f32,
    }

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    @group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;

    const MAX_ITERATIONS: i32 = 1024;

    // Color parameters
    const R: f32 = 0.0;
    const G: f32 = 0.43;
    const B: f32 = 1.0;

    fn colorDoublePrecision(p: vec2<f32>, falloff: f32) -> vec3<f32> {
      let c = dc_add(dc_mul_scalar(dc_set(p), vec2<f32>(uniforms.zoom, 0.0)), dc_set(vec2<f32>(uniforms.offsetX - 1.0, uniforms.offsetY)));

      var dZ = dc_set(vec2<f32>(0.0, 0.0));
      let add_val = c;

      var j = uniforms.iterations;
      for (var i: i32 = 0; i <= MAX_ITERATIONS; i++) {
        if (i > uniforms.iterations) {
          break;
        }
        if (ds_cmp(dc_length(dZ), ds_set(uniforms.blobSize)) > 0.0) {
          break;
        }
        dZ = dc_add(dc_mul(dZ, dZ), add_val);
        j = i;
      }
      let dotZZ = dZ.x * dZ.x + dZ.z * dZ.z; // extract high part

      if (j < uniforms.iterations) {
        // The color scheme here is based on one
        // from the Mandelbrot in Inigo Quilez's Shader Toy:
        var co = f32(j) + 1.0 - log2(0.5 * log2(dotZZ));
        co = sqrt(max(0.0, co) / (256.0 * uniforms.colorControl));
        co = co + rand(p * fract(uniforms.time)) * 0.02;
        return falloff * vec3<f32>(
            0.5 + 0.5 * cos(6.2831 * co + R),
            0.5 + 0.5 * cos(6.2831 * co + G),
            0.5 + 0.5 * cos(6.2831 * co + B));
      } else {
        // Inside
        return vec3<f32>(0.05, 0.01, 0.02);
      }
    }

    @compute @workgroup_size(16, 16)
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      let dimensions = textureDimensions(outputTexture);
      let pixel_coord = vec2<i32>(global_id.xy);
      
      if (pixel_coord.x >= i32(dimensions.x) || pixel_coord.y >= i32(dimensions.y)) {
        return;
      }

      // Convert pixel coordinates to normalized coordinates [-1, 1]
      // Flip Y coordinate to match WebGL coordinate system (bottom-left origin)
      let coord = vec2<f32>(
        (f32(pixel_coord.x) / f32(dimensions.x) - 0.5) * 2.0,
        (f32(i32(dimensions.y) - pixel_coord.y) / f32(dimensions.y) - 0.5) * 2.0
      );

      const MAX_ANTI_ALIAS: i32 = 4;
      var v = vec3<f32>(0.0, 0.0, 0.0);
      let d = 1.0 / f32(uniforms.antiAlias);
      let ard = uniforms.pixelSize * d;
      
      for (var x: i32 = 0; x < MAX_ANTI_ALIAS; x++) {
        if (x >= uniforms.antiAlias) {
          break;
        }
        for (var y: i32 = 0; y < MAX_ANTI_ALIAS; y++) {
          if (y >= uniforms.antiAlias) {
            break;
          }
          let cor = coord + vec2<f32>(f32(x), f32(y)) * ard;
          let c = vec2<f32>(cor.x - 0.0, cor.y);
          let falloff = exp(-dot(c, c) / 1.0 + 0.2 * rand(cor));
          let p = c * uniforms.zoom + vec2<f32>(uniforms.offsetX - 1.0, uniforms.offsetY);
          v = v + colorDoublePrecision(c, falloff).bgr;
        }
      }
      
      let final_color = pow(v / f32(uniforms.antiAlias * uniforms.antiAlias), vec3<f32>(1.0 / 2.2));
      textureStore(outputTexture, pixel_coord, vec4<f32>(final_color, 1.0));
    }
    `;
  }

  // WebGL fallback shaders (original GLSL)
  get vertexShaderGLSL() {
    return `
    attribute vec3 position;
    varying vec2 coord;

    void main(void) {
      coord = position.xy;
      gl_Position = vec4(position, 1.0);
    }
    `;
  }

  get fragmentShaderGLSL() {
    return `
    const int MAX_ITERATIONS = 1024;

    varying vec2 coord;
    uniform vec2 pixelSize;
    uniform float time;
    uniform int iterations;
    uniform int antiAlias;

    // Trippy stuff
    uniform float blobSize;
    uniform float colorControl;

    // Mandelbrot coords
    uniform float offsetX;
    uniform float offsetY;
    uniform float zoom;

    // Color parameters
    float R = 0.0;
    float G = 0.43;
    float B = 1.;

    vec3 colorDoublePrecision(vec2 p, float falloff) {
      vec4 c = dcAdd(dcMul(dcSet(p), vec2(zoom, 0.)), dcSet(vec2(offsetX - 1.0, offsetY)));

      vec4 dZ = dcSet(vec2(0.0, 0.0));
      vec4 add = c;

      int j = iterations;
      for (int i = 0; i <= MAX_ITERATIONS; i++) {
        if (i > iterations) {
          break;
        }
        if (cmp(dcLength(dZ), set(blobSize)) > 0.) {
          break;
        }
        dZ = dcAdd(dcMul(dZ, dZ), add);
        j = i;
      }
      float dotZZ = dZ.x * dZ.x + dZ.z * dZ.z; // extract high part

      if (j < iterations) {
        // The color scheme here is based on one
        // from the Mandelbrot in Inigo Quilez's Shader Toy:
        float co = float(j) + 1.0 - log2(.5 * log2(dotZZ));
        co = sqrt(max(0., co) / (256.0 * colorControl));
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

    void main() {
      const int MAX_ANTI_ALIAS = 4;
      vec3 v = vec3(0.0, 0.0, 0.0);
      float d = 1.0 / float(antiAlias);
      vec2 ard = vec2(pixelSize.x, pixelSize.y) * d;
      for (int x = 0; x < MAX_ANTI_ALIAS; x++) {
        if (x >= antiAlias) {
          break;
        }
        for (int y = 0; y < MAX_ANTI_ALIAS; y++) {
          if (y >= antiAlias) {
            break;
          }
          //v += colorSplit(coord + vec2(x, y) * ard);
          vec2 cor = coord + vec2(x, y) * ard;
          vec2 c = vec2(cor.x - 0., cor.y);
          float falloff = exp(-dot(c, c) / 1.0 + 0.2 * rand(cor));
          vec2 p = c * zoom + vec2(offsetX - 1.0, offsetY);
          v += (colorDoublePrecision(c, falloff)).bgr;
        }
      }
      gl_FragColor = vec4(pow(v / float(antiAlias * antiAlias), vec3(1. / 2.2)), 1.0);
    }
    `;
  }

  get doublePrecisionMathGLSL() {
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
