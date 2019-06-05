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
    this.buffer = [-1, -1, 1, -1, 1, 1, -1, 1];

    this.buildProgram(this.vertexShader, this.fragmentShader);
    this.assignAttribOffsets(0, 2, { p: 0 });
  }

  get vertexShader() {
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

  get fragmentShader() {
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
    `
  }
}
