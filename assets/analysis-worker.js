/* Optional background analysis for long recordings; no network or media access. */
'use strict';
importScripts('analysis.js?v=6964a5bc7ae6');
self.onmessage = event => {
  const {id, beats, options, sectionBoundaries} = event.data;
  try { self.postMessage({id, analysis: TempoAnalysis.analyze(beats, options,sectionBoundaries)}); }
  catch { self.postMessage({id, error: true}); }
};
