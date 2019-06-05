class ComboFractal extends Mandelbrot {
  constructor() {
    super();

    document.getElementById('julia-map').innerHTML = '<canvas id="julia-canvas" />';
    this.julia = new Julia('julia-canvas');
  }

  setOptionsAndDraw(options, opt_mouseX, opt_mouseY) {
    super.setOptionsAndDraw(options);

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

  dispose() {
    document.getElementById('julia-map').innerHTML = '';
  }
}
