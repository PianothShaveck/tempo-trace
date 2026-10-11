/* Optional background analysis for long recordings; no network or media access. */
'use strict';
importScripts('analysis.js?v=a8b1d626185c');
self.onmessage = event => {
  const {id, beats, options} = event.data;
  try { self.postMessage({id, analysis: TempoAnalysis.analyze(beats, options)}); }
  catch { self.postMessage({id, error: true}); }
};
