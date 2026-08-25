class ComboFractal extends Mandelbrot {
  constructor() {
    super();

    document.getElementById('julia-map').innerHTML = '<canvas id="julia-canvas" />';
    this.julia = new Julia('julia-canvas');
  }

  setOptionsAndDraw(options, opt_mouseX, opt_mouseY) {
    super.setOptionsAndDraw(options);

    // Reconstitute doubles from hi/lo uniform pairs for Julia calculations
    const offsetX = this.variables['offsetX'].value;
    const offsetY = this.variables['offsetY'].value;
    const zoom = this.variables['zoom'].value;
    const offsetXVal = offsetX[0] + offsetX[1];
    const offsetYVal = offsetY[0] + offsetY[1];
    const zoomVal = zoom[0] + zoom[1];

    const juliaOptions = {...options};
    if (juliaOptions['center']) {
      juliaOptions['center'] = [
        offsetXVal + (opt_mouseX / this.canvas.width * 2 - 1) * zoomVal - 1.0,
        offsetYVal + (1 - opt_mouseY / this.canvas.height * 2) * zoomVal
      ];
    }
    juliaOptions['offsetX'] = 0;
    juliaOptions['offsetY'] = 0;
    if (juliaOptions['zoom']) {
      juliaOptions['zoom'] = Math.min(1.5, juliaOptions['zoom'] * 100);
    }
    this.julia.setOptionsAndDraw(juliaOptions);
  }

  dispose() {
    document.getElementById('julia-map').innerHTML = '';
  }
}
