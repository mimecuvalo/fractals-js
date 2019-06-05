class FractalUI {
  constructor() {
    // Constants
    this.ZOOM_LIMIT = 1.5;  // Tweak if you want zoom to freeze at a lower value.
    this.ZOOM_MAX = 1.5;  // Tweak if you want higher zoom
    this.ZOOM_SPEED = 0.1;
    this.ZOOM_MIN_PANNING = 0.000001;
    this.ZOOM_MIN = 0.00000001;
    this.MORPHING_SPEED = 1.0;
    this.PANNING_SPEED = 0.1;
    this.ITERATION_DAMPENER = 0.01;

    this.x = 0.0;
    this.y = 0.0;

    this.RETINA_RATIO = 2; // "retina" mode

    this.isMousePressed = false;
    this.mouseClientX = 0;
    this.mouseClientY = 0;
    this.mouseX = 0;
    this.mouseY = 0;
    this.latestMouseWheelEvent = null;

    this.shiftPressed = false;
    this.altPressed = false;
    this.ctrlPressed = false;

    this.fractalOptions = [Julia, Mandelbrot, ComboFractal];
    this.currentFractalIndex = 0;
    this.currentFractal = new this.fractalOptions[this.currentFractalIndex];

    this.bindEventListeners();

    this.currentFractal.setOptionsAndDraw({
      zoom: 1.5,
    });

    setTimeout(() => {
      document.getElementById('aside').className = '';
    }, 5000);
  }

  changeFractal() {
    this.currentFractal.dispose();

    document.getElementById('container').innerHtml = '<canvas id="canvas" />';
    this.currentFractalIndex = (this.currentFractalIndex + 1) % this.fractalOptions.length;
    this.currentFractal = new this.fractalOptions[this.currentFractalIndex];
  }

  bindEventListeners() {
    window.addEventListener('resize', () => { document.location.reload(); });
    window.addEventListener('mousedown', this.onMouseDown.bind(this));
    window.addEventListener('mouseup', this.onMouseUp.bind(this));
    window.addEventListener('mousemove', this.onMouseMove.bind(this), { passive: true });
    window.addEventListener('mousewheel', this.onMouseWheel.bind(this), { passive: true });
    window.addEventListener('keydown', this.onKeyDown.bind(this));
    window.addEventListener('keyup', this.onKeyUp.bind(this));
  }

  onMouseDown() {
    this.isMousePressed = true;
    document.body.classList.add('grabbing');
  }

  onMouseUp() {
    this.isMousePressed = false;
    document.body.classList.remove('grabbing');
  }

  getVarValue(variable) {
    return this.currentFractal.variables[variable].value;
  }

  onMouseMove(evt) {
    const canvas = document.getElementById('canvas');
    const canvasCenterX = (evt.clientX - canvas.offsetLeft / this.RETINA_RATIO);
    const canvasCenterY = (evt.clientY - canvas.offsetTop);
    const deltaX = this.mouseClientX - evt.clientX;
    const deltaY = this.mouseClientY - evt.clientY;
    const significantXMovement = Math.abs(deltaX) >= 1;
    const significantYMovement = Math.abs(deltaY) >= 1;
    const directionX = significantXMovement ? (this.mouseClientX > evt.clientX ? 1 : -1) : 0;
    const directionY = significantYMovement ? (this.mouseClientY > evt.clientY ? 1 : -1) : 0;
    this.mouseClientX = evt.clientX;
    this.mouseClientY = evt.clientY;
    this.mouseX = canvasCenterX;
    this.mouseY = canvasCenterY;

    const isComboFractal = this.currentFractal instanceof ComboFractal;
    const zoom = this.getVarValue('zoom');
    if (!isComboFractal && !this.isMousePressed) {
      if (this.ZOOM_LIMIT != this.ZOOM_MAX && Date.now() < this.latestMouseWheelEvent + 1000) {
        return;
      }

      const specialKeyPressed = this.shiftPressed || this.altPressed || this.ctrlPressed;
      if (!specialKeyPressed && zoom < this.ZOOM_LIMIT) {
        return;
      }
    }

    const shiftPressed = this.shiftPressed;

    window.requestAnimationFrame(() => {
      let blobSize = this.getVarValue('blobSize');
      let colorControl = this.getVarValue('colorControl');
      let offsetX = this.getVarValue('offsetX');
      let offsetY = this.getVarValue('offsetY');

      if (this.isMousePressed) {
        const PAN_INTERVAL = zoom * this.PANNING_SPEED * 0.1;
        offsetX += deltaX * PAN_INTERVAL;
        offsetY += -1 * deltaY * PAN_INTERVAL;
        this.currentFractal.setOptionsAndDraw({ offsetX, offsetY });
      } else if (this.altPressed) {
        blobSize += directionX * 0.01;
        blobSize = Math.max(Math.min(blobSize, 2.0), 0);
        this.currentFractal.setOptionsAndDraw({ blobSize });
      } else if (this.ctrlPressed) {
        colorControl += directionX * 0.1;
        colorControl = Math.max(Math.min(colorControl, 1000.0), 0);
        this.currentFractal.setOptionsAndDraw({ colorControl });
      } else if (shiftPressed && zoom < 1.0) {
        this.x += directionX * this.x * zoom * 0.005;  // x is more sensitive so dampen it more
        this.y += directionY * this.y * zoom * 0.01;
        this.currentFractal.setOptionsAndDraw({ center: [this.x, this.y] });
      } else if (!shiftPressed && (zoom >= this.ZOOM_LIMIT || isComboFractal)) {
        this.x = (canvasCenterX * this.RETINA_RATIO / canvas.width * 2 - 1) / this.MORPHING_SPEED;
        this.y = (1 - canvasCenterY * this.RETINA_RATIO / canvas.height * 2) / this.MORPHING_SPEED;
        this.currentFractal.setOptionsAndDraw({ center: [this.x, this.y] },
            this.mouseX * this.RETINA_RATIO, this.mouseY * this.RETINA_RATIO);
      }
   });
  }

  onMouseWheel(evt) {
    this.latestMouseWheelEvent = Date.now();

    window.requestAnimationFrame(() => {
      let blobSize = this.getVarValue('blobSize');
      let colorControl = this.getVarValue('colorControl');
      let iterations = this.getVarValue('iterations');
      let offsetX = this.getVarValue('offsetX');
      let offsetY = this.getVarValue('offsetY');
      let zoom = this.getVarValue('zoom');

      if (this.altPressed) {
        blobSize += -1 * evt.deltaY * 0.001;
        blobSize = Math.max(Math.min(blobSize, 2.0), 0);
        this.currentFractal.setOptionsAndDraw({ blobSize });
        return;
      } else if (this.ctrlPressed) {
        colorControl += evt.deltaY * 0.1;
        colorControl = Math.max(Math.min(colorControl, 1000.0), 0);
        this.currentFractal.setOptionsAndDraw({ colorControl });
        return;
      }

      const direction = evt.deltaY >= 0 ? 1 : -1;
      if (direction == 1 && zoom < this.ZOOM_MIN) {
        return;
      }

      const canvas = document.getElementById('canvas');
      if (direction == -1 && zoom >= this.ZOOM_LIMIT) {
        offsetX *= 0.5;
        offsetY *= 0.5;
      } else if (this.mouseX >= 0 && this.mouseX <= canvas.width / this.RETINA_RATIO && zoom > this.ZOOM_MIN_PANNING) {
        const PAN_INTERVAL = zoom * this.PANNING_SPEED;
        offsetX += direction * PAN_INTERVAL * (this.mouseX * this.RETINA_RATIO / canvas.width * 2 - 1);
        offsetY += direction * PAN_INTERVAL * (1 - this.mouseY * this.RETINA_RATIO / canvas.height * 2);
      }

      zoom += -1 * direction * (zoom * this.ZOOM_SPEED);
      zoom = Math.min(this.ZOOM_MAX, zoom);

      iterations += direction / (zoom / this.ITERATION_DAMPENER);
      iterations = direction == 1 ? iterations : Math.max(iterations, 128);

      let antiAlias = 1;
      if (iterations >= 1500) {
        antiAlias = 2;
      }

      this.currentFractal.setOptionsAndDraw({
        antiAlias,
        zoom,
        iterations,
        offsetX,
        offsetY,
      });
   });
  }

  onKeyDown(evt) {
    let offsetX = this.getVarValue('offsetX');
    let offsetY = this.getVarValue('offsetY');
    const zoom = this.getVarValue('zoom');

    const PAN_INTERVAL = zoom * this.PANNING_SPEED;
    switch (evt.key) {
      case 'Shift':
        this.shiftPressed = true;
        break;
      case 'Control':
        this.ctrlPressed = true;
        break;
      case 'Alt':
        this.altPressed = true;
        break;
      case 'ArrowLeft':
        offsetX -= PAN_INTERVAL;
        this.currentFractal.setOptionsAndDraw({ offsetX });
        break;
      case 'ArrowRight':
        offsetX += PAN_INTERVAL;
        this.currentFractal.setOptionsAndDraw({ offsetX });
        break;
      case 'ArrowDown':
        offsetY -= PAN_INTERVAL;
        this.currentFractal.setOptionsAndDraw({ offsetY });
        break;
      case 'ArrowUp':
        offsetY += PAN_INTERVAL;
        this.currentFractal.setOptionsAndDraw({ offsetY });
        break;
      case ' ':
        this.changeFractal();
        break;
      default:
        break;
    }
  }

  onKeyUp(evt) {
    switch (evt.key) {
      case 'Shift':
        this.shiftPressed = false;
        break;
      case 'Control':
        this.ctrlPressed = false;
        break;
      case 'Alt':
        this.altPressed = false;
        break;
      default:
        break;
    }
  }
}

new FractalUI();
