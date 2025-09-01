class Fractal {
  constructor(canvasId) {
    this.variables = {};

    this.canvas = document.getElementById(canvasId || 'canvas');
    this.canvas.width = this.canvas.height = this.canvas.clientHeight;

    // WebGPU initialization will be async
    this.device = null;
    this.context = null;
    this.presentationFormat = null;
    this.initialized = false;

    this.draw = this.throttle(this.drawInternal, 33);
    
    // Initialize WebGPU
    this.initWebGPU();
  }

  async initWebGPU() {
    try {
      if (!navigator.gpu) {
        console.warn('WebGPU is not supported in this browser');
        this.fallbackToWebGL();
        return;
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.warn('No WebGPU adapter found');
        this.fallbackToWebGL();
        return;
      }

      this.device = await adapter.requestDevice();
      this.context = this.canvas.getContext('webgpu');
      
      if (!this.context) {
        console.warn('Failed to get WebGPU context');
        this.fallbackToWebGL();
        return;
      }
      
      this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.presentationFormat,
        alphaMode: 'premultiplied'
      });

      this.initialized = true;
      
      // Create compute pipeline and resources
      await this.setupCompute();
      
      // Initial draw
      this.draw();
      
      console.log('WebGPU initialization successful');
    } catch (error) {
      console.error('WebGPU initialization failed:', error);
      this.fallbackToWebGL();
    }
  }

  fallbackToWebGL() {
    console.log('Falling back to WebGL implementation');
    
    // Show a notification to the user
    this.showNotification('Using WebGL fallback - WebGPU not available in this browser');
    
    // Initialize WebGL context
    this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
    if (!this.gl) {
      throw new Error('Neither WebGPU nor WebGL are supported in this browser');
    }
    
    this.gl.viewport(0, 0, this.canvas.clientHeight, this.canvas.clientHeight);
    this.glDrawArraysMode = this.gl.TRIANGLE_FAN;
    this.initialized = true;
    this.usingWebGL = true;
    
    // Set up WebGL (this will be implemented by subclasses)
    this.setupWebGL();
  }

  setupWebGL() {
    // This will be implemented by subclasses for WebGL fallback
    throw new Error('setupWebGL must be implemented by subclasses when WebGL fallback is needed');
  }

  showNotification(message) {
    // Create a simple notification
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(255, 255, 255, 0.9);
      color: #333;
      padding: 10px 20px;
      border-radius: 5px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px;
      z-index: 1000;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 5000);
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
    if (!this.initialized) {
      return;
    }

    if (this.preDraw) {
      this.preDraw();
    }

    if (this.usingWebGL) {
      // WebGL fallback rendering
      this.renderWebGL();
    } else {
      // WebGPU rendering
      this.updateUniforms();
      this.render();
    }
  }

  renderWebGL() {
    // Legacy WebGL rendering - will be implemented by subclasses
    for (const key in this.variables) {
      const variable = this.variables[key];
      if (variable.location) {
        this.gl['uniform' + variable.type](variable.location, variable.value);
      }
    }
    this.gl.drawArrays(this.glDrawArraysMode, 0, 4);
  }

  async setupCompute() {
    // This will be implemented by subclasses
    throw new Error('setupCompute must be implemented by subclasses');
  }

  updateUniforms() {
    if (!this.uniformBuffer || !this.uniformData) {
      return;
    }

    // Update uniform buffer with current variable values
    // Need to match the uniform struct layout exactly
    const uniformStruct = this.getUniformStructLayout();
    
    for (const field of uniformStruct) {
      const variable = this.variables[field.name];
      if (!variable) continue;
      
      const value = variable.value;
      
      switch (variable.type) {
        case '1f':
          this.uniformData.setFloat32(field.offset, value, true);
          break;
        case '1i':
          this.uniformData.setInt32(field.offset, value, true);
          break;
        case '2fv':
          this.uniformData.setFloat32(field.offset, value[0], true);
          this.uniformData.setFloat32(field.offset + 4, value[1], true);
          break;
      }
    }

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  getUniformStructLayout() {
    // This should be implemented by subclasses to match their uniform struct
    throw new Error('getUniformStructLayout must be implemented by subclasses');
  }

  render() {
    if (!this.computePipeline || !this.outputTexture) {
      return;
    }

    const commandEncoder = this.device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();
    
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.bindGroup);
    
    const workgroupsX = Math.ceil(this.canvas.width / 16);
    const workgroupsY = Math.ceil(this.canvas.height / 16);
    computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
    
    computePass.end();

    // Copy from compute output to canvas
    const renderPassEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    renderPassEncoder.setPipeline(this.renderPipeline);
    renderPassEncoder.setBindGroup(0, this.renderBindGroup);
    renderPassEncoder.draw(3); // Full-screen triangle
    renderPassEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  async createComputePipeline(computeShaderCode) {
    const computeShaderModule = this.device.createShaderModule({
      code: computeShaderCode,
    });

    this.computePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: computeShaderModule,
        entryPoint: 'main',
      },
    });
  }

  async createRenderPipeline() {
    // Full-screen triangle vertex shader
    const vertexShaderCode = `
      @vertex
      fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
        var pos = array<vec2<f32>, 3>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>(-1.0,  3.0),
          vec2<f32>( 3.0, -1.0)
        );
        return vec4<f32>(pos[vertexIndex], 0.0, 1.0);
      }
    `;

    // Fragment shader to display the computed texture
    const fragmentShaderCode = `
      @group(0) @binding(0) var outputTexture: texture_2d<f32>;
      @group(0) @binding(1) var textureSampler: sampler;

      @fragment
      fn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
        let uv = pos.xy / vec2<f32>(${this.canvas.width}.0, ${this.canvas.height}.0);
        return textureSample(outputTexture, textureSampler, uv);
      }
    `;

    const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
    const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });

    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: vertexShaderModule,
        entryPoint: 'main',
      },
      fragment: {
        module: fragmentShaderModule,
        entryPoint: 'main',
        targets: [{
          format: this.presentationFormat,
        }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
  }

  createBuffers() {
    // Calculate uniform buffer size
    let uniformBufferSize = 0;
    for (const key in this.variables) {
      const variable = this.variables[key];
      switch (variable.type) {
        case '1f':
        case '1i':
          uniformBufferSize += 4;
          break;
        case '2fv':
          uniformBufferSize += 8;
          break;
        // Add more types as needed
      }
    }

    // Round up to multiple of 16 for WebGPU alignment
    uniformBufferSize = Math.ceil(uniformBufferSize / 16) * 16;

    this.uniformBuffer = this.device.createBuffer({
      size: uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.uniformData = new DataView(new ArrayBuffer(uniformBufferSize));

    // Create output texture for compute shader
    this.outputTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Create sampler
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  createBindGroups() {
    // Compute bind group
    this.bindGroup = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: this.outputTexture.createView(),
        },
      ],
    });

    // Render bind group
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: this.outputTexture.createView(),
        },
        {
          binding: 1,
          resource: this.sampler,
        },
      ],
    });
  }

  get doublePrecisionMathWGSL() {
    return `
    // Double emulation based on GLSL Mandelbrot Shader by Henry Thasler (www.thasler.org/blog)
    // Converted to WGSL syntax
    // Emulation based on Fortran-90 double-single package. See http://crd.lbl.gov/~dhbailey/mpdist/

    // Add: res = ds_add(a, b) => res = a + b
    fn ds_add(dsa: vec2<f32>, dsb: vec2<f32>) -> vec2<f32> {
      var dsc: vec2<f32>;
      var t1: f32;
      var t2: f32;
      var e: f32;

      t1 = dsa.x + dsb.x;
      e = t1 - dsa.x;
      t2 = ((dsb.x - e) + (dsa.x - (t1 - e))) + dsa.y + dsb.y;

      dsc.x = t1 + t2;
      dsc.y = t2 - (dsc.x - t1);
      return dsc;
    }

    // Subtract: res = ds_sub(a, b) => res = a - b
    fn ds_sub(dsa: vec2<f32>, dsb: vec2<f32>) -> vec2<f32> {
      var dsc: vec2<f32>;
      var e: f32;
      var t1: f32;
      var t2: f32;

      t1 = dsa.x - dsb.x;
      e = t1 - dsa.x;
      t2 = ((-dsb.x - e) + (dsa.x - (t1 - e))) + dsa.y - dsb.y;

      dsc.x = t1 + t2;
      dsc.y = t2 - (dsc.x - t1);
      return dsc;
    }

    // Compare: res = -1 if a < b, = 0 if a == b, = 1 if a > b
    fn ds_cmp(dsa: vec2<f32>, dsb: vec2<f32>) -> f32 {
      if (dsa.x < dsb.x) {
        return -1.0;
      } else if (dsa.x == dsb.x) {
        if (dsa.y < dsb.y) {
          return -1.0;
        } else if (dsa.y == dsb.y) {
          return 0.0;
        } else {
          return 1.0;
        }
      } else {
        return 1.0;
      }
    }

    // Multiply: res = ds_mul(a, b) => res = a * b
    fn ds_mul(dsa: vec2<f32>, dsb: vec2<f32>) -> vec2<f32> {
      var dsc: vec2<f32>;
      var c11: f32;
      var c21: f32;
      var c2: f32;
      var e: f32;
      var t1: f32;
      var t2: f32;
      var a1: f32;
      var a2: f32;
      var b1: f32;
      var b2: f32;
      var cona: f32;
      var conb: f32;
      let split: f32 = 8193.0;

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

    // Create double-single number from float
    fn ds_set(a: f32) -> vec2<f32> {
      return vec2<f32>(a, 0.0);
    }

    // Random function
    fn rand(co: vec2<f32>) -> f32 {
      return fract(sin(dot(co.xy, vec2<f32>(12.9898, 78.233))) * 43758.5453);
    }

    // Complex multiplication
    fn complex_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
      return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
    }

    // Double complex multiplication
    fn dc_mul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
      return vec4<f32>(
        ds_sub(ds_mul(a.xy, b.xy), ds_mul(a.zw, b.zw)), 
        ds_add(ds_mul(a.xy, b.zw), ds_mul(a.zw, b.xy))
      );
    }

    // Double complex addition
    fn dc_add(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
      return vec4<f32>(ds_add(a.xy, b.xy), ds_add(a.zw, b.zw));
    }

    // Length of double complex
    fn dc_length(a: vec4<f32>) -> vec2<f32> {
      return ds_add(ds_mul(a.xy, a.xy), ds_mul(a.zw, a.zw));
    }

    // Create double complex from vec2
    fn dc_set(a: vec2<f32>) -> vec4<f32> {
      return vec4<f32>(a.x, 0.0, a.y, 0.0);
    }

    // Multiply double-complex with double
    fn dc_mul_scalar(a: vec4<f32>, b: vec2<f32>) -> vec4<f32> {
      return vec4<f32>(ds_mul(a.xy, b), ds_mul(a.zw, b));
    }
    `;
  }
}
