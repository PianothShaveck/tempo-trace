'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createDOM, Element} = require('./dom-stub.cjs');
const TempoAnalysis = require('../assets/analysis.js');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../assets/app.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function project(times = [], extra = {}) {
  return {app: 'Tempo Trace', version: 1, duration: 30,
    media: {name: 'piano.wav', size: 1234, type: 'audio/wav', kind: 'audio'},
    beats: times.map((time, i) => ({id: 'b' + i, time, breakBefore: false})), ...extra};
}
function boot(storageEntries = [], overrides = {}) {
  const document = createDOM(html), window = new Element('window'), storage = new Map(storageEntries);
  let nextId = 0, taskId = 0;
  const charts = [];
  const createChart = (svg, callbacks) => {const chart = {render(data) {this.latest = data;callbacks?.onScale?.({...this.getScale(),clipped:0});}, getScale(){return this.latest?.yRange||{min:80,max:120};}, setPlayhead(time) {this.time = time;}, exportSVG() {return '<svg/>';}}; charts.push(chart); return chart;};
  const context = vm.createContext({document, window, TempoAnalysis,
    TempoCharts: {createTempoChart: createChart, createWaveform: createChart,tempoScale:()=>({min:80,max:160})},
    crypto: {randomUUID: () => 'generated-' + ++nextId},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    setTimeout: () => ++taskId, clearTimeout() {}, requestAnimationFrame: () => ++taskId, cancelAnimationFrame() {},
    URL: {revokeObjectURL() {}, createObjectURL: () => 'blob:test'}, Blob, AbortController, console, ...overrides});
  // Expose only in this VM copy. Production app remains a closed IIFE.
  const hook = `globalThis.app = {validateProject, adoptProject, loadProject, loadFile, tap, moveBeat, removeSelected,
    selectBeat, undo, redo, seekTo, persist, payload, snapshot, openDetection, runDetection, applyDetection, cancelDetection, exportGraphic, exportAudio, followPlayhead, panChart, animatePlayback,
    get view(){return {start:viewStart,end:viewEnd,yRange,follow:followPlayback};},
    attachFile(file = {name:'piano.wav',size:1234}) {currentFile = file;}, setView(start, end) {viewStart=start;viewEnd=end;},
    stubProbe(duration=30) {probeFile=async()=>duration;},
    attachMedia() {hasMedia = true;}, get state() {return state;}, get analysis() {return analysis;},
    get history() {return {undo: undoStack.length, redo: redoStack.length};}, get hasMedia() {return hasMedia;}};`;
  assert.match(source, /\}\)\(\);\s*$/);
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, hook + '\n})();'), context, {filename: 'app.js'});
  const $ = id => document.getElementById(id), api = context.app;
  return {api, $, document, storage, charts, media: $('media'),
    open(data = project()) {api.adoptProject(api.validateProject(data));},
    press(code, target = document.body, extra = {}) {return document.dispatch('keydown', {code, target, ...extra}).event;}};
}

function workerHarness() {
  const workers = [];
  class WorkerDouble {
    constructor(url) {this.url = url; this.messages = []; this.terminated = false; workers.push(this);}
    // Browser postMessage clones the data at dispatch, rather than keeping a
    // reference that later edits can mutate. Preserve that important behavior.
    postMessage(data) {this.messages.push(plain(data));}
    complete(index) {const data = this.messages[index]; this.onmessage({data: {id: data.id,
      analysis: TempoAnalysis.analyze(data.beats, data.options, data.sectionBoundaries)}});}
    fail() {this.onerror(new Error('Worker unavailable'));}
    terminate() {this.terminated = true;}
  }
  return {...boot([], {Worker: WorkerDouble}), workers};
}
const longProject = () => project(Array.from({length: 1201}, (_, i) => i * .5), {duration: 700});

function detectionHarness() {
  const requests = [];
  const client = {clear() {}, run(file, duration, options, progress, signal) {
    return new Promise((resolve, reject) => requests.push({file, duration, options, progress, signal, resolve, reject}));
  }};
  return {...boot([], {TempoDetectionClient: client}), requests};
}
function detected(times) {
  return {beats: times.map(time => ({time, confidence: .8})), diagnostics: {localTempo:
    [{time: times[0], bpm: 120}, {time: times.at(-1), bpm: 120}]}};
}

test('app boots against real HTML IDs even when saved JSON is corrupt', () => {
  const h = boot([['tempo-trace.session.v1', '{broken']]);
  assert.equal(h.$('welcome').hidden, false);
  assert.equal(h.$('workspace').hidden, true);
  assert.equal(h.$('exportButton').disabled, true);
  assert.equal(h.$('restoreButton').hidden, true);
});

test('project validation rejects malformed files, impossible times, and rounded duplicates', () => {
  const {api} = boot();
  const invalid = [null, {}, project([], {version: 2}), project([], {duration: 0}),
    project([], {duration: Infinity}), project([], {duration: 86401}), project([], {media: {name: 12}}),
    project([-1]), project([NaN]), project([Infinity]), project(['1']), project([31]),
    project([1, 1.0001]), project([], {options: []}),
    project([], {beats: [{time: 1, breakBefore: 'yes'}]}),
    project([], {beats: [{time: 1, fermataBefore: 'yes'}]}), project([], {beats: Array(50001).fill({time: 0})})];
  for (const data of invalid) assert.throws(() => api.validateProject(data));
});

test('valid imports sort beats, replace colliding IDs, sanitize fields, and bound settings', () => {
  const {api} = boot();
  const data = project([], {beats: [{id: 'same', time: 2.12349, fermataBefore: true}, {id: 'same', time: 1, breakBefore: true}],
    options: {beatUnit: 2, sectionThreshold: 99, minSectionSeconds: -2, smoothing: 999}, evil: '<script>'});
  const result = api.validateProject(data);
  assert.deepEqual(plain(result.beats.map(b => b.time)), [1, 2.123]);
  assert.equal(new Set(result.beats.map(b => b.id)).size, 2);
  assert.equal(result.beats[0].breakBefore, true);
  assert.equal(result.beats[1].fermataBefore, true);
  assert.deepEqual(plain(result.options), {beatUnit: 2, sectionThreshold: .6, minSectionSeconds: 3, smoothing: 5});
  assert.equal(result.evil, undefined);
  assert.equal(data.beats[0].time, 2.12349);
});

test('taps measure media seconds, so slowing or accelerating playback does not change BPM', () => {
  const h = boot(); h.open(); h.api.attachMedia();
  h.media.playbackRate = .5; h.media.currentTime = 10; h.api.tap();
  h.media.playbackRate = 2; h.media.currentTime = 10.5; h.api.tap();
  assert.deepEqual(plain(h.api.state.beats.map(b => b.time)), [10, 10.5]);
  assert.equal(h.api.analysis.stats.mean, 120);
  assert.equal(h.charts[0].latest.analysis.stats.mean, 120);
});

test('near duplicate taps are ignored without creating an undo operation', () => {
  const h = boot(); h.open(); h.api.attachMedia();
  h.media.currentTime = 2; h.api.tap();
  h.media.currentTime = 2.025; h.api.tap();
  assert.equal(h.api.state.beats.length, 1);
  assert.equal(h.api.history.undo, 1);
  h.api.undo(); assert.equal(h.api.state.beats.length, 0);
});

test('a paused insert between existing beats keeps chronological order and both intervals', () => {
  const h = boot(); h.open(project([1, 2, 3]));
  h.api.seekTo(1.5); h.api.tap();
  assert.deepEqual(plain(h.api.state.beats.map(b => b.time)), [1, 1.5, 2, 3]);
  assert.equal(h.api.state.beats[1].breakBefore, false);
  assert.equal(h.api.analysis.intervals.length, 3);
});

test('precise edits round to milliseconds and cannot cross neighbors or media boundaries', () => {
  const h = boot(); h.open(project([1, 2, 3]));
  h.api.moveBeat('b1', 2.3456); assert.equal(h.api.state.beats[1].time, 2.346);
  for (const time of [1, 3, -.01, 31, NaN, Infinity]) h.api.moveBeat('b1', time);
  assert.equal(h.api.state.beats[1].time, 2.346);
  h.api.moveBeat('b0', -.001); h.api.moveBeat('b2', 30.001);
  assert.deepEqual(plain(h.api.state.beats.map(b => b.time)), [1, 2.346, 3]);
  h.api.moveBeat('b1', 1.001); assert.equal(h.api.state.beats[1].time, 1.001);
  assert.equal(h.api.history.undo, 2);
});

test('deleting a beat at an interruption preserves the gap on its successor', () => {
  const h = boot(), data = project([1, 2, 10, 11, 12]); data.beats[2].breakBefore = true;
  h.open(data); h.api.selectBeat('b2'); h.api.removeSelected();
  assert.equal(h.api.state.beats[2].id, 'b3');
  assert.equal(h.api.state.beats[2].breakBefore, true);
  assert.equal(h.api.analysis.intervals.length, 2);
  assert.equal(h.api.analysis.stats.mean, 60);
  h.api.undo(); assert.equal(h.api.state.beats[2].id, 'b2');
  assert.equal(h.api.state.beats[3].breakBefore, false);
});

test('undo and redo restore insert, correction, deletion, and selected beat together', () => {
  const h = boot(); h.open(project([1, 2, 3])); const original = plain(h.api.snapshot());
  h.api.seekTo(1.5); h.api.tap(); const inserted = plain(h.api.snapshot());
  h.api.moveBeat(h.api.state.selectedId, 1.6); const corrected = plain(h.api.snapshot());
  h.api.removeSelected(); const deleted = plain(h.api.snapshot());
  for (const expected of [corrected, inserted, original]) {h.api.undo(); assert.deepEqual(plain(h.api.snapshot()), expected);}
  for (const expected of [inserted, corrected, deleted]) {h.api.redo(); assert.deepEqual(plain(h.api.snapshot()), expected);}
});

test('a fresh correction after undo discards the old redo branch', () => {
  const h = boot(); h.open(project([1, 2, 3]));
  h.api.moveBeat('b1', 2.1); h.api.undo(); h.api.moveBeat('b1', 2.2); h.api.redo();
  assert.equal(h.api.state.beats[1].time, 2.2);
  assert.equal(h.api.history.redo, 0);
});

test('restoring a project resets attachment/history and can roundtrip through local storage', () => {
  const h = boot(); h.open(project([1, 2])); h.api.attachMedia(); h.api.moveBeat('b0', .9);
  const data = project([5, 6], {media: {name: '<img onerror=bad>.wav', kind: 'audio'}});
  h.open(data); h.api.persist();
  assert.equal(h.api.hasMedia, false); assert.deepEqual(plain(h.api.history), {undo: 0, redo: 0});
  assert.equal(h.$('relinkBanner').hidden, false);
  assert.equal(h.$('fileName').textContent, '<img onerror=bad>.wav');
  const saved = JSON.parse(h.storage.get('tempo-trace.session.v1'));
  assert.deepEqual(plain(h.api.validateProject(saved)), plain(h.api.state));
  assert.equal(JSON.stringify(saved).includes('blob:'), false);
  const reopened = boot([['tempo-trace.session.v1', JSON.stringify(saved)]]);
  assert.equal(reopened.$('restoreButton').hidden, false);
  reopened.$('restoreButton').click();
  assert.deepEqual(plain(reopened.api.state.beats.map(b => b.time)), [5, 6]);
});

test('seeking beyond a restored tail creates an interruption instead of false low BPM', () => {
  const h = boot(); h.open(project([1, 1.5, 2]));
  h.api.seekTo(20); h.api.tap();
  assert.equal(h.api.state.beats.at(-1).breakBefore, true);
  assert.equal(h.api.analysis.stats.mean, 120);
  assert.equal(h.api.analysis.intervals.length, 2);
});

test('continuous listening remains connected; explicitly seeking ahead starts a new run', () => {
  const h = boot(); h.open(); h.api.attachMedia();
  for (const time of [1, 1.5, 2]) {h.media.currentTime = time; h.api.tap();}
  assert.equal(h.api.analysis.intervals.length, 2);
  assert.ok(h.api.state.beats.every(b => !b.breakBefore));
  h.api.seekTo(20); h.api.tap(); h.media.currentTime = 20.5; h.api.tap();
  assert.equal(h.api.state.beats[3].breakBefore, true);
  assert.equal(h.api.state.beats[4].breakBefore, false);
  assert.equal(h.api.analysis.intervals.length, 3);
  assert.equal(h.api.analysis.stats.mean, 120);
});

test('keyboard tap works once and respects held keys, editable fields, controls, and dialogs', () => {
  const h = boot(); h.open(); h.api.attachMedia(); h.media.currentTime = 1;
  assert.equal(h.press('Space').defaultPrevented, true);
  assert.equal(h.api.state.beats.length, 1);
  h.media.currentTime = 2;
  h.press('Space', h.document.body, {repeat: true});
  h.press('Space', h.$('beatTime')); h.press('Space', h.$('speed')); h.press('Space', h.$('playButton'));
  h.$('helpDialog').showModal(); h.press('Space'); h.$('helpDialog').close();
  assert.equal(h.api.state.beats.length, 1);
  h.press('Space', h.$('tapButton')); assert.equal(h.api.state.beats.length, 2);
  h.press('KeyZ', h.document.body, {ctrlKey: true}); assert.equal(h.api.state.beats.length, 1);
  h.press('KeyZ', h.document.body, {ctrlKey: true, shiftKey: true}); assert.equal(h.api.state.beats.length, 2);
});

test('invalid JSON imports leave the current session and history intact', async () => {
  const h = boot(); h.open(project([1, 2, 3])); h.api.moveBeat('b1', 2.1);
  const before = plain(h.api.snapshot()), history = plain(h.api.history);
  await h.api.loadProject({size: 10, text: async () => '{broken'});
  await h.api.loadProject({size: 10, text: async () => JSON.stringify(project([100]))});
  await h.api.loadProject({size: 13 * 1024 * 1024, text: async () => {throw new Error('Should not read oversized file');}});
  assert.deepEqual(plain(h.api.snapshot()), before);
  assert.deepEqual(plain(h.api.history), history);
});

test('worker discards an obsolete response and then analyzes only the latest queued correction', () => {
  const h = workerHarness(); h.open(project([1, 2])); h.open(longProject());
  const worker = h.workers[0];
  assert.match(worker.url, /^assets\/analysis-worker\.js\?v=[a-f0-9]{12}$/);
  assert.equal(worker.messages.length, 1);
  h.api.moveBeat('b600', 300.1); h.api.moveBeat('b600', 300.2);
  assert.equal(worker.messages.length, 1);
  assert.equal(h.$('saveBeats').disabled, true);
  assert.equal(h.$('tempoChart').getAttribute('aria-busy'), 'true');
  const displayedBeforeReply = plain(h.api.analysis);
  worker.complete(0);
  assert.deepEqual(plain(h.api.analysis), displayedBeforeReply, 'obsolete worker result must not replace the current displayed analysis');
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.messages[0].beats[600].time, 300, 'in-flight request is a snapshot');
  assert.equal(worker.messages[1].beats[600].time, 300.2, 'queued work uses the latest correction');
  worker.complete(1);
  const expected = TempoAnalysis.analyze(h.api.state.beats, h.api.state.options);
  assert.deepEqual(plain(h.api.analysis), plain(expected));
  assert.equal(h.api.state.beats[600].time, 300.2);
  assert.equal(h.$('saveBeats').disabled, false);
  assert.equal(h.$('tempoChart').getAttribute('aria-busy'), 'false');
  assert.equal(worker.messages.length, 2);
});

test('an old worker cannot overwrite a newly opened smaller session', () => {
  const h = workerHarness(); h.open(longProject()); const worker = h.workers[0];
  h.open(project([2, 3, 4], {media: {name: 'new.wav', kind: 'audio'}}));
  const expected = plain(h.api.analysis);
  worker.complete(0);
  assert.deepEqual(plain(h.api.analysis), expected);
  assert.equal(h.api.analysis.stats.mean, 60);
  assert.equal(h.api.state.media.name, 'new.wav');
  assert.deepEqual(plain(h.api.state.beats.map(b => b.time)), [2, 3, 4]);
  assert.equal(worker.messages.length, 1);
  assert.equal(h.$('saveBeats').disabled, false);
});

test('worker errors fall back to current data without losing edits or undo history', () => {
  const h = workerHarness(); h.open(longProject()); const worker = h.workers[0];
  h.api.moveBeat('b0', .1); const snapshot = plain(h.api.snapshot());
  worker.fail();
  assert.equal(worker.terminated, true);
  assert.deepEqual(plain(h.api.snapshot()), snapshot);
  assert.deepEqual(plain(h.api.analysis), plain(TempoAnalysis.analyze(h.api.state.beats, h.api.state.options)));
  assert.equal(h.api.history.undo, 1);
  assert.equal(h.$('saveBeats').disabled, false);
  assert.equal(h.$('tempoChart').getAttribute('aria-busy'), 'false');
  h.api.moveBeat('b0', .2);
  assert.equal(h.workers.length, 1);
  assert.equal(worker.messages.length, 1);
  assert.deepEqual(plain(h.api.analysis), plain(TempoAnalysis.analyze(h.api.state.beats, h.api.state.options)));
  h.api.undo(); assert.equal(h.api.state.beats[0].time, .1);
});

test('audio detection is a reviewable proposal and never changes beats before Apply', async () => {
  const h = detectionHarness(); h.open(project([1, 2])); h.api.attachFile(); h.api.openDetection();
  const original = plain(h.api.snapshot()), pending = h.api.runDetection(), request = h.requests[0];
  assert.deepEqual(plain(request.options.anchors.map(b => b.time)), [1, 2]);
  assert.deepEqual(plain(h.api.snapshot()), original);
  assert.equal(h.$('detectApply').hidden, true);
  request.progress({stage: 'tracking', progress: .5});
  assert.match(h.$('detectStage').textContent, /50%/);
  request.resolve(detected([1, 1.5, 2, 2.5])); await pending;
  assert.deepEqual(plain(h.api.snapshot()), original);
  assert.equal(h.api.history.undo, 0);
  assert.equal(h.$('detectApply').hidden, false);
  assert.equal(h.$('detectResult').hidden, false);
  assert.equal(h.$('detectionPreview').children.length, 3);
});

test('cancel, dialog close, session switch, and intervening edits ignore late detection results', async () => {
  for (const action of ['cancel', 'close', 'session', 'edit']) {
    const h = detectionHarness(); h.open(project([1, 2])); h.api.attachFile(); h.api.openDetection();
    const pending = h.api.runDetection(), request = h.requests[0];
    if (action === 'cancel') h.api.cancelDetection();
    if (action === 'close') h.$('detectDialog').close();
    if (action === 'session') h.open(project([5, 6]));
    if (action === 'edit') h.api.moveBeat('b0', 1.1);
    const expected = plain(h.api.snapshot());
    if (action !== 'edit') assert.equal(request.signal.aborted, true);
    request.resolve(detected([1, 1.5, 2, 2.5])); await pending;
    h.api.applyDetection();
    assert.deepEqual(plain(h.api.snapshot()), expected, action);
    assert.equal(h.$('detectApply').hidden, true, action);
    assert.equal(h.$('detectRun').disabled, false, action);
  }
});

test('applying scoped detection preserves exact manual anchors, isolates edges, and is fully undoable', async () => {
  const h = detectionHarness(), data = project([1, 2, 10, 12, 14, 17, 19, 20]);
  data.beats.forEach(beat => {beat.source = 'auto'; beat.confidence = .6;});
  for (const index of [3, 5]) {data.beats[index].source = 'manual'; delete data.beats[index].confidence;}
  data.beats[3].fermataBefore = true;
  h.open(data); h.api.attachFile(); h.api.setView(10, 18); h.api.openDetection(); h.$('detectScope').value = 'view';
  const original = plain(h.api.snapshot()), pending = h.api.runDetection(), request = h.requests[0];
  assert.equal(request.options.start, 10); assert.equal(request.options.end, 18);
  assert.deepEqual(plain(request.options.anchors.map(b => b.time)), [12, 17]);
  request.resolve(detected([10, 11, 12.03, 13, 14, 16.99, 18, 19])); await pending;
  h.api.applyDetection();
  assert.deepEqual(plain(h.api.state.beats.map(b => b.time)), [1, 2, 10, 11, 12, 13, 14, 17, 18, 19, 20]);
  for (const index of [3, 5]) assert.deepEqual(plain(h.api.state.beats.find(b => b.id === data.beats[index].id)), original.beats[index]);
  assert.equal(h.api.state.beats.find(b => b.time === 10).breakBefore, true);
  assert.equal(h.api.state.beats.find(b => b.time === 19).breakBefore, true);
  assert.deepEqual(plain(h.api.state.beats.find(b => b.time === 1)), original.beats[0]);
  assert.deepEqual(plain(h.api.state.beats.find(b => b.time === 20)), original.beats[7]);
  assert.ok(h.api.state.beats.filter(b => !data.beats.some(old => old.id === b.id)).every(b => b.source === 'auto' && b.confidence === .8));
  assert.equal(h.api.history.undo, 1); assert.equal(h.$('detectDialog').open, false);
  h.api.undo(); assert.deepEqual(plain(h.api.snapshot()), original);
});

test('a corrected or explicitly confirmed automatic beat becomes manual and can be undone', () => {
  const h = boot(), data = project([1, 2, 3]);
  data.beats.forEach(beat => {beat.source = 'auto'; beat.confidence = .3; beat.inferred = true;});
  h.open(data); h.api.moveBeat('b1', 2.001);
  assert.equal(h.api.state.beats[1].source, 'manual');
  assert.equal(h.api.state.beats[1].confidence, undefined);
  assert.equal(h.api.state.beats[1].inferred, undefined);
  h.api.undo(); assert.equal(h.api.state.beats[1].source, 'auto'); assert.equal(h.api.state.beats[1].confidence, .3);
  h.api.selectBeat('b1'); h.$('confirmBeat').click();
  assert.equal(h.api.state.beats[1].time, 2);
  assert.equal(h.api.state.beats[1].source, 'manual');
  assert.equal(h.api.state.beats[1].confidence, undefined);
  assert.equal(h.api.state.beats[1].inferred, undefined);
  assert.equal(h.$('confirmBeat').hidden, true);
  h.api.undo(); assert.equal(h.api.state.beats[1].source, 'auto');
});

test('project roundtrip preserves provenance and confidence while rejecting invalid auto confidence', () => {
  const h = boot(), data = project([1, 2, 3, 4]);
  Object.assign(data.beats[0], {source: 'auto', confidence: 0, inferred: true});
  Object.assign(data.beats[1], {source: 'auto', confidence: 1});
  Object.assign(data.beats[2], {source: 'manual', confidence: .2});
  Object.assign(data.beats[3], {source: '<script>', confidence: 'bad'});
  h.open(data);
  assert.equal(h.api.state.beats[0].inferred, true);
  assert.equal(h.api.state.beats[2].confidence, undefined);
  assert.equal(h.api.state.beats[3].source, undefined);
  const exported = plain(h.api.payload());
  assert.deepEqual(plain(h.api.validateProject(exported).beats), plain(h.api.state.beats));
  for (const confidence of [undefined, null, NaN, Infinity, -1, 1.001, '0.8']) {
    const invalid = project([1]); Object.assign(invalid.beats[0], {source: 'auto', confidence});
    assert.throws(() => h.api.validateProject(invalid));
  }
  for (const inferred of ['true', 1, {}]) {
    const invalid = project([1]); Object.assign(invalid.beats[0], {source: 'auto', confidence: .8, inferred});
    assert.throws(() => h.api.validateProject(invalid));
  }
});

test('rounded detection at a scope edge cannot duplicate an existing retained beat', async () => {
  const h = detectionHarness(), data = project([1, 9, 12.001, 14]);
  data.beats.forEach(beat => Object.assign(beat, {source: 'auto', confidence: .7}));
  h.open(data); h.api.attachFile(); h.api.setView(8, 12.0007); h.api.openDetection(); h.$('detectScope').value = 'view';
  const pending = h.api.runDetection();
  h.requests[0].resolve(detected([8, 9, 10, 11, 12.0006])); await pending;
  h.api.applyDetection();
  assert.deepEqual(plain(h.api.state.beats.map(b => b.time)), [1, 8, 9, 10, 11, 12.001, 14]);
  const edge = h.api.state.beats.find(b => b.time === 12.001);
  assert.equal(edge.id, 'b2'); assert.equal(edge.confidence, .7);
  assert.ok(h.api.state.beats.some(b => b.id === h.api.state.selectedId));
  assert.doesNotThrow(() => h.api.validateProject(plain(h.api.payload())));
});

test('manual fermata and interruption decisions on auto beats survive another detection', async () => {
  const h = detectionHarness(), data = project([1, 2, 3, 4]);
  data.beats.forEach(beat => Object.assign(beat, {source: 'auto', confidence: .4, inferred: true}));
  data.beats[1].breakBefore = true;
  h.open(data); h.api.attachFile();
  for (const [id, control] of [['b1', 'fermataBefore'], ['b2', 'breakBefore']]) {
    h.api.selectBeat(id); h.$(control).checked = true; h.$(control).dispatch('change');
    const beat = h.api.state.beats.find(b => b.id === id);
    assert.equal(beat.source, 'manual');
    assert.equal(beat.confidence, undefined); assert.equal(beat.inferred, undefined);
    if (control === 'fermataBefore') assert.equal(beat.breakBefore, false);
  }
  const protectedBeats = plain(h.api.state.beats.filter(b => b.source === 'manual'));
  h.api.openDetection(); const pending = h.api.runDetection();
  assert.deepEqual(plain(h.requests[0].options.anchors.map(b => b.id)), ['b1', 'b2']);
  h.requests[0].resolve(detected([1, 1.5, 2, 2.5, 3, 3.5, 4])); await pending;
  h.api.applyDetection();
  assert.deepEqual(plain(h.api.state.beats.filter(b => b.source === 'manual')), protectedBeats);
});

test('a single confirmed manual beat among automatic beats survives a fresh detection', async () => {
  const h = detectionHarness(), data = project([1, 2, 3, 4]);
  data.beats.forEach(beat => Object.assign(beat, {source: 'auto', confidence: .7}));
  h.open(data); h.api.attachFile(); h.api.selectBeat('b1'); h.$('confirmBeat').click();
  const confirmed = plain(h.api.state.beats[1]);
  h.api.openDetection();
  assert.equal(h.$('detectAnchors').disabled, false);
  assert.equal(h.$('detectAnchors').checked, true);
  const pending = h.api.runDetection();
  assert.deepEqual(plain(h.requests[0].options.anchors.map(b => b.id)), ['b1']);
  h.requests[0].resolve(detected([1, 1.5, 2.03, 2.5, 3, 3.5, 4])); await pending;
  h.api.applyDetection();
  assert.deepEqual(plain(h.api.state.beats.find(b => b.id === 'b1')), confirmed);
  assert.equal(h.api.state.beats.some(b => b.time === 2.03), false);
});

test('a fresh import offers automatic or manual marking; relinking a saved project does not', async () => {
  const file={name:'piano.wav',size:1234,type:'audio/wav'};
  const automatic=detectionHarness();automatic.api.stubProbe();
  await automatic.api.loadFile(file);
  assert.equal(automatic.$('beatModeDialog').open,true);
  assert.equal(automatic.requests.length,0,'import must not start detection before a choice');
  automatic.$('chooseAutomatic').click();
  assert.equal(automatic.$('beatModeDialog').open,false);
  assert.equal(automatic.$('detectDialog').open,true);
  const manual=detectionHarness();manual.api.stubProbe();await manual.api.loadFile(file);
  manual.$('chooseManual').click();
  assert.equal(manual.$('beatModeDialog').open,false);
  assert.equal(manual.$('detectDialog').open,false);
  assert.equal(manual.requests.length,0);
  const restored=detectionHarness();restored.open(project([1,2,3]));restored.api.stubProbe();
  await restored.api.loadFile(file,true);
  assert.equal(restored.$('beatModeDialog').open,false);
  assert.equal(restored.api.state.beats.length,3);
});

test('vertical zoom, explicit BPM limits and Auto operate independently from the temporal window',()=>{
 const h=boot();h.open(project([0,.5,1,1.5,2]));h.api.setView(.5,2);
 h.$('yZoomIn').click();assert.deepEqual(plain(h.charts[0].latest.yRange),{min:87,max:113});assert.equal(h.charts[0].latest.viewStart,.5);
 h.$('bpmMin').value='90';h.$('bpmMax').value='150';h.$('bpmMax').dispatch('change');assert.deepEqual(plain(h.charts[0].latest.yRange),{min:90,max:150});
 h.$('yAuto').click();assert.equal(h.charts[0].latest.yRange,null);assert.equal(h.charts[0].latest.viewEnd,2);
});
test('graphic export uses the selected excerpt with its own BPM statistics',async()=>{
 let report;
 const h=boot([],{TempoReport:{create(project,options){report={project,options};return {svg:'<svg/>',width:1440,height:856};}}});
 h.open(project([0,.5,1,1.5,2,3,4]));h.api.setView(1.5,4);h.$('exportScope').value='view';await h.api.exportGraphic('svg');
 assert.deepEqual(plain(report.project.beats.map(b=>b.time)),[1.5,2,3,4]);assert.equal(report.options.start,1.5);assert.equal(report.options.end,4);assert.equal(report.project.analysis.stats.mean,72);
 assert.equal(h.$('saveSvg').disabled,false);
});
test('audio dialog exports click-only excerpts without a linked source and ignores completion after cancellation',async()=>{
 let pending,downloads=0;
 const h=boot([],{TempoExportClient:{audio(file,options,progress,signal){return new Promise(resolve=>pending={file,options,signal,resolve});}},URL:{revokeObjectURL(){},createObjectURL(){downloads++;return 'blob:download';}}});
 h.open(project([0,.5,1,1.5,2,3,4]));h.api.setView(1,3);h.$('exportScope').value='view';h.$('saveClicks').click();h.$('exportRate').value='.75';
 assert.equal(h.$('audioExportDialog').open,true);assert.equal(h.$('exportMusicRow').hidden,true);assert.equal(h.$('exportRateRow').hidden,false);
 const promise=h.api.exportAudio();assert.equal(pending.file,null);assert.equal(pending.options.rate,.75);assert.equal(pending.options.start,1);assert.equal(pending.options.end,3);
 h.$('audioExportDialog').close();assert.ok(pending.signal.aborted);pending.resolve(new Blob(['stale']));await promise;assert.equal(downloads,0);assert.equal(h.$('startAudioExport').disabled,false);
});

test('zoomed playback follows near the right edge and after seeks without changing either zoom',async()=>{
 const h=boot();h.open(project([0,.5,1,1.5,2]));h.api.attachMedia();h.api.setView(0,10);
 h.$('bpmMin').value='80';h.$('bpmMax').value='140';h.$('bpmMax').dispatch('change');
 assert.equal(h.api.followPlayhead(9),false,'paused playback leaves the window alone');await h.media.play();
 assert.equal(h.api.followPlayhead(7),false);h.media.currentTime=8.5;h.api.animatePlayback(100);
 assert.equal(h.api.view.start,3.5);assert.equal(h.api.view.end,13.5);assert.deepEqual(plain(h.api.view.yRange),{min:80,max:140});
 h.api.seekTo(29);assert.equal(h.api.view.start,20);assert.equal(h.api.view.end,30);
 h.api.seekTo(1);assert.equal(h.api.view.start,0);assert.equal(h.api.view.end,10);
});
test('manual two-axis panning clamps to data and disables follow until it is explicitly restored',async()=>{
 const h=boot();h.open(project([0,.5,1]));h.api.attachMedia();await h.media.play();
 h.api.panChart({start:-2,end:8,min:-20,max:80,vertical:true});
 assert.deepEqual(plain(h.api.view),{start:0,end:10,yRange:{min:0,max:100},follow:false});
 h.media.currentTime=25;assert.equal(h.api.followPlayhead(25),false);
 h.$('followPlayback').click();assert.equal(h.api.view.start,20);assert.equal(h.api.view.end,30);assert.equal(h.api.view.follow,true);
 h.$('pan').value='5';h.$('pan').dispatch('input');assert.equal(h.api.view.follow,false);assert.equal(h.api.view.start,5);
 h.api.panChart({start:8,end:18,min:0,max:100,vertical:false});assert.deepEqual(plain(h.api.view.yRange),{min:0,max:100});
});
test('section edits split, move and merge with undo, persistence, and automatic reset',()=>{
 const h=boot();h.open(project(Array.from({length:41},(_,i)=>i*.5)));
 h.$('editSections').click();h.$('newSectionTime').value='5.2';h.$('addSection').click();h.$('sectionsForm').dispatch('submit');
 assert.deepEqual(plain(h.api.state.sectionBoundaries),[5]);assert.equal(h.api.analysis.sections.length,2);
 h.$('editSections').click();let inputs=h.$('sectionBoundaries').querySelectorAll('input');inputs[1].value='7.4';inputs[1].dispatch('input');h.$('sectionsForm').dispatch('submit');
 assert.deepEqual(plain(h.api.state.sectionBoundaries),[7.5]);h.api.persist();
 const restored=h.api.validateProject(JSON.parse(h.storage.get('tempo-trace.session.v1')));assert.deepEqual(plain(restored.sectionBoundaries),[7.5]);
 h.$('editSections').click();h.$('sectionBoundaries').querySelector('button').click();h.$('sectionsForm').dispatch('submit');
 assert.deepEqual(plain(h.api.state.sectionBoundaries),[]);assert.equal(h.api.analysis.sections.length,1);
 h.api.undo();assert.deepEqual(plain(h.api.state.sectionBoundaries),[7.5]);
 h.$('editSections').click();h.$('automaticSections').click();assert.equal(h.api.state.sectionBoundaries,null);h.api.undo();assert.deepEqual(plain(h.api.state.sectionBoundaries),[7.5]);
 h.api.moveBeat('b15',7.55);assert.deepEqual(plain(h.api.state.sectionBoundaries),[7.55]);assert.equal(h.api.analysis.sections[1].start,7.55);
});
test('section dialog cancellation and invalid cuts leave the session and history untouched',()=>{
 const h=boot();h.open(project([0,.5,1,1.5,2]));const initial=plain(h.api.snapshot());
 h.$('editSections').click();h.$('newSectionTime').value='0';h.$('addSection').click();assert.equal(h.$('sectionEditError').hidden,false);
 h.$('newSectionTime').value='1';h.$('addSection').click();h.$('sectionsDialog').close();assert.deepEqual(plain(h.api.snapshot()),initial);assert.equal(h.api.history.undo,0);
 for(const sectionBoundaries of ['no',[NaN],[-1],[31],[1,1]])assert.throws(()=>h.api.validateProject(project([0,.5,1],{sectionBoundaries})));
 assert.equal(h.api.validateProject(project([0,.5,1])).sectionBoundaries,null);
});
test('a false detected gap can be reconnected without changing beat positions and the action is undoable',()=>{
 const h=boot();h.open(project([], {beats:[{id:'a',time:0},{id:'b',time:.5},{id:'c',time:1,breakBefore:true},{id:'d',time:1.5}]}));
 h.api.selectBeat('c');assert.equal(h.$('connectBeat').hidden,false);assert.equal(h.api.analysis.intervals.length,2);
 h.$('connectBeat').click();assert.equal(h.api.analysis.intervals.length,3);assert.equal(h.$('connectBeat').hidden,true);
 assert.deepEqual(plain(h.api.state.beats.map(b=>b.time)),[0,.5,1,1.5]);h.api.undo();assert.equal(h.api.state.beats[2].breakBefore,true);
});
test('beat nudge buttons provide 50 and 10 ms while direct input retains millisecond precision',()=>{
 const h=boot();h.open(project([0,1,2]));h.api.selectBeat('b1');
 const buttons=h.document.querySelectorAll('[data-nudge]');assert.deepEqual(buttons.map(b=>Number(b.dataset.nudge)),[-.05,-.01,.01,.05]);
 buttons[0].click();assert.equal(h.api.state.beats[1].time,.95);buttons[2].click();assert.equal(h.api.state.beats[1].time,.96);
 h.$('beatTime').value='0.963';h.$('beatTime').dispatch('change');assert.equal(h.api.state.beats[1].time,.963);
});
test('manual boundaries reach the background worker and graphic export',async()=>{
 const h=workerHarness();h.open(longProject());h.workers[0].complete(0);
 h.$('editSections').click();h.$('newSectionTime').value='200';h.$('addSection').click();h.$('sectionsForm').dispatch('submit');h.workers[0].complete(1);
 assert.deepEqual(plain(h.workers[0].messages[1].sectionBoundaries),[200]);assert.equal(h.api.analysis.sections.length,2);
 let report;
 const g=boot([],{TempoReport:{create(project){report=project;return {svg:'<svg/>',width:1440,height:884};}}});
 g.open(project([0,.5,1,1.5,2],{sectionBoundaries:[1]}));await g.api.exportGraphic('svg');assert.equal(report.analysis.sections.length,2);assert.equal(report.analysis.sections[1].start,1);
});
