// Reference-orbit worker.
//
// The reference orbit is a few thousand double-double complex squarings, and the
// series coefficients are another pass over it. Both are inherently serial -- there
// is nothing to parallelise, the GPU can't help, and float64 is the minimum
// precision that works -- so the only way to keep them off the critical path is to
// run them on another thread. That is all this file does.
//
// PerturbationRenderer is loaded wholesale so the maths lives in exactly one place;
// only its WebGL method is main-thread-only, and the worker never calls it.
importScripts('perturbation.js');

const renderer = new PerturbationRenderer();

self.onmessage = (evt) => {
  const job = evt.data;

  renderer.mode = job.mode;
  renderer.juliaC = job.juliaC;
  renderer.maxRefIterations = job.maxRefIterations;

  const orbit = renderer.calculateReferenceOrbit(job.centerRe, job.centerIm, job.zoom, job.maxIters);
  renderer.referenceOrbit = orbit.data;
  renderer.referenceOrbitLength = orbit.length;

  const series = renderer.computeSeries(job.zoom, job.maxIters);

  // The orbit buffer is handed over rather than copied; the worker drops its own
  // reference to it on the next job anyway.
  self.postMessage({
    id: job.id,
    data: orbit.data,
    length: orbit.length,
    series,
    centerRe: job.centerRe,
    centerIm: job.centerIm,
    zoom: job.zoom,
    maxIters: job.maxIters,
  }, [orbit.data.buffer]);
};
