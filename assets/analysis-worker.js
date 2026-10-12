/* Optional background analysis for long recordings; no network or media access. */
'use strict';
importScripts('analysis.js?v=d1764770161b');
self.onmessage = event => {
  const {id, beats, options, sectionBoundaries} = event.data;
  try { self.postMessage({id, analysis: TempoAnalysis.analyze(beats, options,sectionBoundaries)}); }
  catch { self.postMessage({id, error: true}); }
};
