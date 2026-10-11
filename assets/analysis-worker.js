/* Optional background analysis for long recordings; no network or media access. */
'use strict';
importScripts('analysis.js');
self.onmessage = event => {
  const {id, beats, options} = event.data;
  try { self.postMessage({id, analysis: TempoAnalysis.analyze(beats, options)}); }
  catch { self.postMessage({id, error: true}); }
};
