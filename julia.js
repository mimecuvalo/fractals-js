// adapted and greatly modified from http://universefactory.net/test/julia/

class Julia extends Fractal {
  constructor(canvasId) {
    super(canvasId);

    this.variables = {
      antiAlias:  { type: '1i',  value: 1 },
      blobSize:   { type: '1f',  value: 2.0 },
      center:     { type: '2fv', value: [0.0, 0.0] },
      colorControl:  { type: '1f',  value: 2.0 },
      iterations: { type: '1i',  value: 128 },
      offsetX:    { type: '1f',  value: 0.0 },
      offsetY:    { type: '1f',  value: 0.0 },
      zoom:       { type: '1f',  value: 1.5 },
    };
  }

  async setupCompute() {
    this.createBuffers();
    await this.createComputePipeline(this.computeShader);
    await this.createRenderPipeline();
    this.createBindGroups();
  }

  setupWebGL() {
    // WebGL fallback setup
    this.buffer = [-1, -1, 1, -1, 1, 1, -1, 1];

    this.buildProgramWebGL(this.vertexShaderGLSL, this.fragmentShaderGLSL);
    this.assignAttribOffsetsWebGL(0, 2, { p: 0 });
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

  getUniformStructLayout() {
    // Must match the WGSL struct layout exactly
    return [
      { name: 'antiAlias', offset: 0 },     // i32 - 4 bytes
      { name: 'blobSize', offset: 4 },      // f32 - 4 bytes
      { name: 'center', offset: 8 },        // vec2<f32> - 8 bytes
      { name: 'colorControl', offset: 16 },  // f32 - 4 bytes (aligned to 16)
      { name: 'iterations', offset: 20 },   // i32 - 4 bytes
      { name: 'offsetX', offset: 24 },      // f32 - 4 bytes
      { name: 'offsetY', offset: 28 },      // f32 - 4 bytes
      { name: 'zoom', offset: 32 },         // f32 - 4 bytes (aligned to 16)
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
      zoom: f32,
    }

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    @group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;

    const MAX_ITERATIONS: i32 = 1536;

    fn f(z: vec2<f32>) -> vec2<f32> {
      return vec2<f32>(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + uniforms.center;
    }

    fn niter(z_input: vec2<f32>) -> f32 {
      var z = z_input;
      for (var i: i32 = 0; i < MAX_ITERATIONS; i++) {
        if (i >= uniforms.iterations) {
          break;
        }
        z = f(z);
        if (length(z) > uniforms.blobSize) {
          return f32(i) + uniforms.colorControl - 1.0 - log(log(length(z * 2.0)) / log(2.0)) / log(uniforms.colorControl);
        }
      }
      return f32(uniforms.iterations);
    }

    fn red(a: f32) -> vec3<f32> { return vec3<f32>(a, 0.0, 0.0); }
    fn yellow(a: f32) -> vec3<f32> { return vec3<f32>(1.0, a, 0.0); }
    fn green(a: f32) -> vec3<f32> { return vec3<f32>(1.0 - a, 1.0, 0.0); }
    fn blue(a: f32) -> vec3<f32> { return vec3<f32>(0.0, 1.0 - a, a); }
    fn white(a: f32) -> vec3<f32> { return vec3<f32>(a, a, 1.0); }
    
    fn color(a: f32) -> vec3<f32> {
      if (a <= 0.0) { return vec3<f32>(0.0); }
      if (a <= 0.03) { return red((a - 0.0) / 0.03); }
      if (a <= 0.1) { return yellow((a - 0.03) / 0.07); }
      if (a <= 0.2) { return green((a - 0.1) / 0.1); }
      if (a <= 0.4) { return blue((a - 0.2) / 0.2); }
      if (a <= 1.0) { return white((a - 0.4) / 0.6); }
      return vec3<f32>(1.0);
    }

    @compute @workgroup_size(16, 16)
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      let dimensions = textureDimensions(outputTexture);
      let pixel_coord = vec2<i32>(global_id.xy);
      
      if (pixel_coord.x >= i32(dimensions.x) || pixel_coord.y >= i32(dimensions.y)) {
        return;
      }

      // Convert pixel coordinates to normalized coordinates [-1, 1]
      let coord = (vec2<f32>(pixel_coord) / vec2<f32>(dimensions) - 0.5) * 2.0;
      
      // Calculate z value like the vertex shader did
      let z = uniforms.zoom * coord + vec2<f32>(uniforms.offsetX, uniforms.offsetY);
      
      let a = niter(z) / f32(uniforms.iterations);
      let final_color = color(a);
      
      textureStore(outputTexture, pixel_coord, vec4<f32>(final_color, 1.0));
    }
    `;
  }

  // WebGL fallback shaders (original GLSL)
  get vertexShaderGLSL() {
    return `
    uniform float zoom;
    uniform float offsetX;
    uniform float offsetY;
    attribute vec2 p;
    varying vec2 z;

    void main() {
      z = zoom * p + vec2(offsetX, offsetY);
      gl_Position = vec4(p, 0.0, 1.0);
    }
    `;
  }

  get fragmentShaderGLSL() {
    return `
    precision highp float;
    const int MAX_ITERATIONS = 1536;
    uniform int iterations;
    uniform float blobSize;
    uniform float colorControl;
    uniform vec2 center;
    varying vec2 z;

    vec2 f(in vec2 z) {
      return vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + center;
    }

    float niter(in vec2 z) {
      for (int i = 0; i < MAX_ITERATIONS; ++i) {
        if (i >= iterations) break;
        z = f(z);
        if (length(z) > blobSize) {
          return float(i) + colorControl - 1.0 - log(log(length(z * 2.0)) / log(2.0)) / log(colorControl);
        }
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
      float a = niter(z) / float(iterations);
      gl_FragColor = vec4(color(a), 1.0);
    }
    `;
  }
}
