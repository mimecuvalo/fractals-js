class FractalUI {
  // URL <-> fractal mapping. Order matches `fractalOptions` below.
  static FRACTAL_NAME = ['julia', 'mandelbrot', 'combo'];
  static FRACTAL_INDEX = { julia: 0, mandelbrot: 1, combo: 2 };

  constructor() {
    // Constants
    this.ZOOM_LIMIT = 1.5;  // Tweak if you want zoom to freeze at a lower value.
    this.ZOOM_MAX = 1.5;  // Tweak if you want higher zoom
    this.ZOOM_SPEED = 0.1;
    this.ZOOM_MIN_PANNING = 0.000001;
    this.ZOOM_MIN = 1e-28;
    this.MORPHING_SPEED = 1.0;
    this.PANNING_SPEED = 0.1;
    this.ITERATION_DAMPENER = 0.01;

    this.x = 0.0;
    this.y = 0.0;

    // Center is tracked as a double-double (hi + lo) so panning and zoom
    // positioning keep working below the float64 floor (~1e-16) at extreme zoom.
    // The `*lo` words are 0 until the zoom gets deep enough to need them.
    this.offsetX = 0.0;
    this.offsetXlo = 0.0;
    this.offsetY = 0.0;
    this.offsetYlo = 0.0;
    this.zoom = 1.5;
    this.iterations = 2000;

    this.RETINA_RATIO = 2; // "retina" mode
    this._settleTimer = null;
    this._urlTimer = null;

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
    this.initHUD();

    // Hydrate from URL params or use defaults
    const params = new URLSearchParams(window.location.search);
    if (params.has('x') && params.has('y') && params.has('s')) {
      // Select the fractal named in the URL (legacy links without `f` are Mandelbrot).
      const wanted = FractalUI.FRACTAL_INDEX[params.get('f')] ?? 1;
      while (this.currentFractalIndex !== wanted) {
        this.changeFractal();
      }
      // Restore the Julia c parameter, if present.
      if (params.has('jx') && params.has('jy') && this.currentFractal.variables.center) {
        this.currentFractal.variables.center.value =
          [parseFloat(params.get('jx')), parseFloat(params.get('jy'))];
      }
      this.goTo({
        offsetX: params.get('x'),
        offsetY: params.get('y'),
        scale: parseFloat(params.get('s')),
        iterations: params.has('i') ? parseInt(params.get('i')) : undefined,
      });
    } else {
      this.currentFractal.setOptionsAndDraw({ zoom: 1.5 });
      this.updateHUD();
    }

    setTimeout(() => {
      document.getElementById('aside').className = '';
    }, 5000);
  }

  changeFractal() {
    this.currentFractal.dispose();

    document.getElementById('container').innerHtml = '<canvas id="canvas" />';
    this.currentFractalIndex = (this.currentFractalIndex + 1) % this.fractalOptions.length;
    this.currentFractal = new this.fractalOptions[this.currentFractalIndex];

    // Reset tracked state
    this.offsetX = 0.0;
    this.offsetXlo = 0.0;
    this.offsetY = 0.0;
    this.offsetYlo = 0.0;
    this.zoom = 1.5;
    this.iterations = 128;
  }

  bindEventListeners() {
    // Reload only when the window is actually resized (debounced). Some events
    // (e.g. devtools/DPR nudges) fire 'resize' with unchanged dimensions; reloading
    // on those needlessly throws away the current deep-zoom position.
    this._lastW = window.innerWidth;
    this._lastH = window.innerHeight;
    window.addEventListener('resize', () => {
      if (window.innerWidth === this._lastW && window.innerHeight === this._lastH) return;
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => { document.location.reload(); }, 300);
    });
    window.addEventListener('mousedown', this.onMouseDown.bind(this));
    window.addEventListener('mouseup', this.onMouseUp.bind(this));
    window.addEventListener('mousemove', this.onMouseMove.bind(this), { passive: true });
    // Non-passive so we can preventDefault() on trackpad pinch (which the browser
    // would otherwise turn into a page zoom).
    window.addEventListener('wheel', this.onMouseWheel.bind(this), { passive: false });
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

  // --- Double-double center arithmetic (Knuth two-sum, ~106-bit) ---
  _ddAdd(ahi, alo, bhi, blo) {
    const s = ahi + bhi;
    const v = s - ahi;
    const e = (ahi - (s - v)) + (bhi - v) + alo + blo;
    const hi = s + e;
    return [hi, e - (hi - s)];
  }

  // Add a float64 delta to the center; the delta may be far below the center's ULP.
  _addX(d) { [this.offsetX, this.offsetXlo] = this._ddAdd(this.offsetX, this.offsetXlo, d, 0); }
  _addY(d) { [this.offsetY, this.offsetYlo] = this._ddAdd(this.offsetY, this.offsetYlo, d, 0); }

  // Complex center as a {re,im} pair of double-double {hi,lo} objects, for the
  // perturbation reference. The real-axis shift depends on the fractal: Mandelbrot/
  // Combo bake in -1, Julia uses 0 (its center is the z-plane offset directly).
  _centerDD() {
    const shift = this.currentFractal.centerReShift ?? -1;
    const cx = this._ddAdd(this.offsetX, this.offsetXlo, shift, 0);
    return { re: { hi: cx[0], lo: cx[1] }, im: { hi: this.offsetY, lo: this.offsetYlo } };
  }

  _applyCenterDD() {
    if (this.currentFractal.perturbation) {
      this.currentFractal.centerDD = this._centerDD();
    }
  }

  // A float64 as an exact scaled BigInt: floatToBig(x, K) = round(x * 10^K), using
  // toFixed's exact decimal expansion of the float64.
  _floatToBig(x, K) {
    const neg = x < 0;
    const [ip, fp = ''] = Math.abs(x).toFixed(K).split('.');
    const b = BigInt(ip) * (10n ** BigInt(K)) + BigInt(fp.padEnd(K, '0').slice(0, K));
    return neg ? -b : b;
  }

  // Parse a decimal string into a double-double [hi, lo], preserving ~30 digits (so
  // pasted/shared deep coordinates survive). Uses BigInt so the low word carries the
  // true continuation digits, not float64 rounding noise. Exponent forms fall back
  // to float64 (they're only used for shallow values).
  _ddFromString(s) {
    s = String(s).trim();
    if (s.indexOf('e') !== -1 || s.indexOf('E') !== -1) return [parseFloat(s), 0];
    const neg = s[0] === '-';
    if (neg || s[0] === '+') s = s.slice(1);
    const K = 40;
    const scaleB = 10n ** BigInt(K);
    const dot = s.indexOf('.');
    const ip = dot === -1 ? s : s.slice(0, dot);
    let fp = dot === -1 ? '' : s.slice(dot + 1);
    fp = fp.slice(0, K).padEnd(K, '0');
    const valB = BigInt(ip || '0') * scaleB + BigInt(fp);
    const hi = Number(valB) / Number(scaleB);
    const lo = Number(valB - this._floatToBig(hi, K)) / Number(scaleB);
    const r = this._ddAdd(hi, 0, lo, 0);
    return neg ? [-r[0], -r[1]] : r;
  }

  // Format a double-double [hi, lo] as a decimal string with ~30 digits.
  _ddToString(hi, lo, digits = 30) {
    if (!isFinite(hi)) return String(hi);
    let b = this._floatToBig(hi, digits) + this._floatToBig(lo, digits);
    const neg = b < 0n;
    if (neg) b = -b;
    const str = b.toString().padStart(digits + 1, '0');
    const ipart = str.slice(0, str.length - digits);
    const fpart = str.slice(str.length - digits).replace(/0+$/, '');
    return (neg ? '-' : '') + ipart + (fpart ? '.' + fpart : '');
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
    const zoom = this.zoom;
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

      if (this.isMousePressed) {
        // Pixel-exact drag: 1 mouse pixel = 1 image pixel. The complex-plane width
        // is 2*zoom across `size` device pixels, and the mouse moves in CSS pixels
        // (device = RETINA_RATIO * CSS), so the per-pixel step is 2*zoom*RETINA/size.
        // This matches the wheel handler's coordinate mapping exactly, and stays
        // faithful at any depth because the increment accumulates in double-double.
        const size = this.currentFractal.fullSize;
        const PAN_INTERVAL = 2 * zoom * this.RETINA_RATIO / size;
        this._addX(deltaX * PAN_INTERVAL);
        this._addY(-1 * deltaY * PAN_INTERVAL);
        this.drawPreview({ offsetX: this.offsetX, offsetY: this.offsetY });
        this.updateHUD();
        this.updateURL();
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

    // macOS trackpad pinch arrives as a wheel event with ctrlKey set (no real
    // Control key held). Claim it as a fractal zoom and stop the browser's page
    // zoom. Must call preventDefault synchronously, before the rAF.
    const isPinch = evt.ctrlKey && !this.ctrlPressed;
    if (isPinch) evt.preventDefault();

    window.requestAnimationFrame(() => {
      let blobSize = this.getVarValue('blobSize');
      let colorControl = this.getVarValue('colorControl');
      let zoom = this.zoom;

      if (isPinch) {
        // Continuous, cursor-anchored zoom scaled by the pinch amount. Spreading
        // (deltaY < 0) zooms in; the point under the cursor stays put.
        const size = this.currentFractal.fullSize;
        let newZoom = zoom * Math.exp(evt.deltaY * 0.01);
        newZoom = Math.min(this.ZOOM_MAX, Math.max(this.ZOOM_MIN, newZoom));
        if (this.mouseX >= 0 && this.mouseX <= size / this.RETINA_RATIO) {
          const cx = this.mouseX * this.RETINA_RATIO / size * 2 - 1;
          const cy = 1 - this.mouseY * this.RETINA_RATIO / size * 2;
          this._addX(cx * (zoom - newZoom));
          this._addY(cy * (zoom - newZoom));
        }
        this.zoom = newZoom;
        this.iterations = 2000;
        this.drawPreview({
          antiAlias: 1,
          zoom: newZoom,
          iterations: this.iterations,
          offsetX: this.offsetX,
          offsetY: this.offsetY,
        });
        this.updateHUD();
        this.updateURL();
        return;
      }

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

      // Use the stable full render size, NOT canvas.width: preview mode shrinks
      // the drawing buffer to 1/4 while zooming, which would otherwise throw the
      // zoom-toward-cursor math off by 4x mid-gesture.
      const size = this.currentFractal.fullSize;
      if (direction == -1 && zoom >= this.ZOOM_LIMIT) {
        // Halving is exact in double-double.
        this.offsetX *= 0.5; this.offsetXlo *= 0.5;
        this.offsetY *= 0.5; this.offsetYlo *= 0.5;
      } else if (this.mouseX >= 0 && this.mouseX <= size / this.RETINA_RATIO) {
        // Pan toward the cursor as we zoom. The increment is ~zoom, which is far
        // below the center's float64 ULP at deep zoom — hence double-double, which
        // keeps the cursor anchored at any depth (no ZOOM_MIN_PANNING cutoff).
        const PAN_INTERVAL = zoom * this.PANNING_SPEED;
        this._addX(direction * PAN_INTERVAL * (this.mouseX * this.RETINA_RATIO / size * 2 - 1));
        this._addY(direction * PAN_INTERVAL * (1 - this.mouseY * this.RETINA_RATIO / size * 2));
      }

      zoom += -1 * direction * (zoom * this.ZOOM_SPEED);
      zoom = Math.min(this.ZOOM_MAX, zoom);

      this.zoom = zoom;
      this.iterations = 2000;

      this.drawPreview({
        antiAlias: 1,
        zoom,
        iterations: this.iterations,
        offsetX: this.offsetX,
        offsetY: this.offsetY,
      });

      this.updateHUD();
      this.updateURL();
   });
  }

  onKeyDown(evt) {
    const PAN_INTERVAL = this.zoom * this.PANNING_SPEED;
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
        this._addX(-PAN_INTERVAL);
        this.drawPreview({ offsetX: this.offsetX });
        this.updateHUD(); this.updateURL();
        break;
      case 'ArrowRight':
        this._addX(PAN_INTERVAL);
        this.drawPreview({ offsetX: this.offsetX });
        this.updateHUD(); this.updateURL();
        break;
      case 'ArrowDown':
        this._addY(-PAN_INTERVAL);
        this.drawPreview({ offsetY: this.offsetY });
        this.updateHUD(); this.updateURL();
        break;
      case 'ArrowUp':
        this._addY(PAN_INTERVAL);
        this.drawPreview({ offsetY: this.offsetY });
        this.updateHUD(); this.updateURL();
        break;
      case ' ':
        this.changeFractal();
        break;
      default:
        break;
    }
  }

  drawPreview(options) {
    this._applyCenterDD();
    this.currentFractal.setPreview(true);
    this.currentFractal.setOptionsAndDraw(options);
    this.scheduleRefine();
  }

  scheduleRefine() {
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      this.currentFractal.setPreview(false);
      this.currentFractal.draw();
      this.updateHUD();
    }, 250);
  }

  initHUD() {
    this.hudEl = document.getElementById('hud');
  }

  updateHUD() {
    const cx = this._ddAdd(this.offsetX, this.offsetXlo, this.currentFractal.centerReShift ?? -1, 0);
    const usePert = this.currentFractal.variables['usePerturbation']
      ? this.currentFractal.variables['usePerturbation'].value : 0;
    const orbitLen = this.currentFractal.perturbation
      ? this.currentFractal.perturbation.referenceOrbitLength : 0;

    this.hudEl.innerHTML =
      `<span>x:</span> ${this._ddToString(cx[0], cx[1], 25)}<br>` +
      `<span>y:</span> ${this._ddToString(this.offsetY, this.offsetYlo, 25)}<br>` +
      `<span>scale:</span> ${this.zoom.toExponential(4)}<br>` +
      `<span>iter:</span> ${this.iterations}` +
      (usePert ? ` <span>perturb:</span> orbit=${orbitLen}` : '') +
      `<button id="hud-copy">copy</button>`;

    document.getElementById('hud-copy').onclick = () => {
      const obj = this.where();
      navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
      const btn = document.getElementById('hud-copy');
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'copy'; }, 1000);
    };
  }

  updateURL() {
    if (this._urlTimer) return;
    this._urlTimer = setTimeout(() => {
      this._urlTimer = null;
      const cx = this._ddAdd(this.offsetX, this.offsetXlo, this.currentFractal.centerReShift ?? -1, 0);
      const params = new URLSearchParams();
      params.set('f', FractalUI.FRACTAL_NAME[this.currentFractalIndex]);
      // Full double-double precision as a decimal string so deep positions survive
      // reload/sharing (float64's 16 digits aren't enough past ~1e-15 zoom).
      params.set('x', this._ddToString(cx[0], cx[1], 30));
      params.set('y', this._ddToString(this.offsetY, this.offsetYlo, 30));
      params.set('s', this.zoom.toExponential(6));
      params.set('i', this.iterations);
      // Julia's shape depends on its c parameter, so persist it too.
      if (this.currentFractalIndex === 0) {
        const c = this.currentFractal.variables.center.value;
        params.set('jx', c[0]);
        params.set('jy', c[1]);
      }
      history.replaceState(null, '', '?' + params.toString());
    }, 500);
  }

  // Navigate to a location. Accepts either:
  //   fractalUI.goTo(x, y, zoom, iterations)
  //   fractalUI.goTo({ offsetX: "...", offsetY: "...", scale: ..., iterations: ... })
  // The object form is compatible with mandelset's navigation format.
  goTo(xOrObj, y, zoom, iterations) {
    // Parse the complex center in double-double, then store offset = center + 1.
    let cx, cy;
    if (typeof xOrObj === 'object' && xOrObj !== null) {
      const obj = xOrObj;
      cx = this._ddFromString(obj.offsetX);
      cy = this._ddFromString(obj.offsetY);
      this.zoom = obj.scale;
      this.iterations = obj.iterations || 2000;
    } else {
      cx = this._ddFromString(xOrObj);
      cy = this._ddFromString(y);
      this.zoom = zoom;
      this.iterations = iterations || 2000;
    }
    // offset = center - centerReShift (Mandelbrot shift -1 => offset = center + 1;
    // Julia shift 0 => offset = center).
    const shift = this.currentFractal.centerReShift ?? -1;
    const ox = this._ddAdd(cx[0], cx[1], -shift, 0);
    this.offsetX = ox[0]; this.offsetXlo = ox[1];
    this.offsetY = cy[0]; this.offsetYlo = cy[1];

    let antiAlias = 1;
    if (this.iterations >= 1500) {
      antiAlias = 2;
    }

    this._applyCenterDD();
    this.currentFractal.setOptionsAndDraw({
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      zoom: this.zoom,
      iterations: this.iterations,
      antiAlias,
    });

    this.updateHUD();
    this.updateURL();
  }

  // Print current position in mandelset-compatible format
  where() {
    const cx = this._ddAdd(this.offsetX, this.offsetXlo, this.currentFractal.centerReShift ?? -1, 0);
    const obj = {
      fractal: FractalUI.FRACTAL_NAME[this.currentFractalIndex],
      iterations: this.iterations,
      offsetX: this._ddToString(cx[0], cx[1], 30),
      offsetY: this._ddToString(this.offsetY, this.offsetYlo, 30),
      scale: this.zoom,
    };
    if (this.currentFractalIndex === 0) {
      const c = this.currentFractal.variables.center.value;
      obj.juliaC = [c[0], c[1]];
    }
    console.log(JSON.stringify(obj, null, 2));
    return obj;
  }

  // Dump full perturbation debug state
  debug() {
    const p = this.currentFractal.perturbation;
    if (!p) { console.log('No perturbation renderer'); return; }

    const cx = this.offsetX - 1.0;
    const cy = this.offsetY;
    const ref = p.referencePoint;
    const orbitLen = p.referenceOrbitLength;
    const usePert = this.currentFractal.variables['usePerturbation'].value;

    const offsetToRef = Math.hypot(cx - ref.re, cy - ref.im);
    const viewportWidth = this.zoom * 2;

    console.group('Perturbation Debug');
    console.log('Center (complex):', cx, cy);
    console.log('Zoom/scale:', this.zoom.toExponential());
    console.log('Iterations requested:', this.iterations);
    console.log('Perturbation active:', !!usePert);
    console.log('Reference point:', ref.re, ref.im);
    console.log('Distance center→ref:', offsetToRef.toExponential(), `(${(offsetToRef / viewportWidth).toFixed(1)}x viewport)`);
    console.log('Orbit length:', orbitLen, orbitLen < this.iterations ? `⚠️ SHORT (need ${this.iterations})` : '✓');
    console.log('maxRefIterations:', p.maxRefIterations);

    // Check if center is inside main cardioid/period-2
    console.log('Center in cardioid:', p.isInMainCardioid(cx, cy));
    console.log('Center in period-2:', p.isInPeriod2Bulb(cx, cy));

    // Test center point orbit length
    const centerOrbit = p.calculateReferenceOrbit(cx, cy, this.zoom, this.iterations);
    console.log('Center orbit length:', centerOrbit.length);

    // Show first/last orbit points
    if (orbitLen > 0) {
      const lastR2 = p.orbitRe(orbitLen - 1) ** 2 + p.orbitIm(orbitLen - 1) ** 2;
      console.log('Last orbit point |z|²:', lastR2.toExponential(), lastR2 > 4 ? '(escaped)' : '(bounded)');
    }

    // Hi/lo split check for offset uniforms
    const oxHiLo = this.currentFractal.variables['offsetX'].value;
    const oyHiLo = this.currentFractal.variables['offsetY'].value;
    const zHiLo = this.currentFractal.variables['zoom'].value;
    console.log('offsetX uniform [hi,lo]:', oxHiLo, '→', oxHiLo[0] + oxHiLo[1]);
    console.log('offsetY uniform [hi,lo]:', oyHiLo, '→', oyHiLo[0] + oyHiLo[1]);
    console.log('zoom uniform [hi,lo]:', zHiLo, '→', zHiLo[0] + zHiLo[1]);
    console.log('refOffsetX:', this.currentFractal.variables['refOffsetX'].value);
    console.log('refOffsetY:', this.currentFractal.variables['refOffsetY'].value);
    console.groupEnd();
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

window.fractalUI = new FractalUI();
