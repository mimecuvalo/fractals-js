class ComboFractal extends Mandelbrot {
  constructor() {
    super();

    // Create Julia canvas and renderer - initialization will be async
    document.getElementById('julia-map').innerHTML = '<canvas id="julia-canvas" />';
    this.julia = new Julia('julia-canvas');
  }

  async setupCompute() {
    // Wait for parent Mandelbrot to set up
    await super.setupCompute();
    
    // Wait for Julia to be ready
    while (!this.julia.initialized) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  setOptionsAndDraw(options, opt_mouseX, opt_mouseY) {
    super.setOptionsAndDraw(options);

    // Only update Julia if it's initialized
    if (this.julia && this.julia.initialized) {
      if (options['center']) {
        options['center'] = [
          this.variables['offsetX'].value + (opt_mouseX / this.canvas.width * 2 - 1) * this.variables['zoom'].value - 1.0,
          this.variables['offsetY'].value + (1 - opt_mouseY / this.canvas.height * 2) * this.variables['zoom'].value
        ];
      }
      options['offsetX'] = 0;
      options['offsetY'] = 0;
      if (options['zoom']) {
        options['zoom'] *= 100;
        options['zoom'] = Math.min(1.5, options['zoom']);
      }
      this.julia.setOptionsAndDraw(options);
    }
  }

  dispose() {
    document.getElementById('julia-map').innerHTML = '';
  }
}
