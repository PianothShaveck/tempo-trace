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
  const createChart = () => {const chart = {render(data) {this.latest = data;}, setPlayhead(time) {this.time = time;}, exportSVG() {return '<svg/>';}}; charts.push(chart); return chart;};
  const context = vm.createContext({document, window, TempoAnalysis,
    TempoCharts: {createTempoChart: createChart, createWaveform: createChart},
    crypto: {randomUUID: () => 'generated-' + ++nextId},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    setTimeout: () => ++taskId, clearTimeout() {}, requestAnimationFrame: () => ++taskId, cancelAnimationFrame() {},
    URL: {revokeObjectURL() {}, createObjectURL: () => 'blob:test'}, Blob, console, ...overrides});
  // Expose only in this VM copy. Production app remains a closed IIFE.
  const hook = `globalThis.app = {validateProject, adoptProject, loadProject, tap, moveBeat, removeSelected,
    selectBeat, undo, redo, seekTo, persist, payload, snapshot,
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
      analysis: TempoAnalysis.analyze(data.beats, data.options)}});}
    fail() {this.onerror(new Error('Worker unavailable'));}
    terminate() {this.terminated = true;}
  }
  return {...boot([], {Worker: WorkerDouble}), workers};
}
const longProject = () => project(Array.from({length: 1201}, (_, i) => i * .5), {duration: 700});

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
  assert.equal(worker.url, 'assets/analysis-worker.js');
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
