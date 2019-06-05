importScripts('fractal.js');

class ComboFractal extends Mandelbrot {
  constructor() {
    super();

    // TODO(mime): move out of web worker
    document.getElementById('julia-map').innerHTML = '<canvas id="julia-canvas" />';
    this.julia = new Julia('julia-canvas');
  }

  setCanvas(canvas, height) {
    super.setCanvas(canvas, height);

    postMessage(this.variables);
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
    // TODO(mime): hook up to webworker
    document.getElementById('julia-map').innerHTML = '';
  }
}


const instance = new ComboFractal();
onmessage = (e) => {
  switch (e.data.msg) {
    case 'init':
      instance.setCanvas(e.data.canvas, e.data.height);
      break;
    default:
      instance.setOptionsAndDraw(e.data.options, e.data.mouseX, e.data.mouseY);
      break;
  }
};
