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

    this.buffer = [
       1.0,  1.0,  0.0,
      -1.0,  1.0,  0.0,
       1.0, -1.0,  0.0,
      -1.0, -1.0,  0.0,
    ];

    this.glDrawArraysMode = this.gl.TRIANGLE_STRIP;

    this.buildProgram(this.vertexShader, this.doublePrecisionMath + this.fragmentShader);
    this.assignAttribOffsets(0, 3, { position: 0 });
  }

  preDraw() {
    this.variables['time'].value = Date.now() / 1000;
  }

  get vertexShader() {
    return `
    attribute vec3 position;
    varying vec2 coord;

    void main(void) {
      coord = position.xy;
      gl_Position = vec4(position, 1.0);
    }
    `;
  }

  get fragmentShader() {
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
