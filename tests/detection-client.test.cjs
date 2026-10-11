'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/detection-client.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-6, `${value} != ${expected}`);
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
function audio(channels = [Float32Array.from({length: 100}, (_, i) => i / 100)], sampleRate = 10) {
  return {length: channels[0].length, duration: channels[0].length / sampleRate,
    sampleRate, numberOfChannels: channels.length, getChannelData: i => channels[i]};
}
function harness(options = {}) {
  const contexts = [], workers = [], created = [], revoked = [];
  let reads = 0, decodeCalls = 0;
  class AudioContextDouble {
    constructor(settings) {this.settings = settings; this.closed = 0; contexts.push(this);}
    decodeAudioData(bytes) {decodeCalls++; return options.decode ? options.decode(bytes, decodeCalls) : Promise.resolve(options.audio || audio());}
    close() {this.closed++; return Promise.resolve();}
  }
  class WorkerDouble {
    constructor(url) {if (options.constructorError) throw new Error('Worker refused'); this.url = url; this.messages = []; this.terminated = 0; workers.push(this);}
    postMessage(message, transfer) {this.messages.push({message, transfer});}
    terminate() {this.terminated++;}
    send(data) {this.onmessage({data});}
    fail() {this.onerror(new Error('Worker failure'));}
  }
  const file = {name: 'piano.wav', size: 200, async arrayBuffer() {reads++; return new ArrayBuffer(200);}};
  const context = vm.createContext({window: {AudioContext: AudioContextDouble}, Worker: WorkerDouble,
    URL: {createObjectURL(blob) {const url = 'blob:test-' + created.length; created.push({url, blob}); return url;}, revokeObjectURL: url => revoked.push(url)},
    TempoDetector: {createWorkerSource: () => 'self.onmessage = () => {};'}, Blob, DOMException, Float32Array,
    ...options.globals});
  vm.runInContext(source, context, {filename: 'detection-client.js'});
  return {client: context.TempoDetectionClient, file, contexts, workers, created, revoked,
    get reads() {return reads;}, get decodeCalls() {return decodeCalls;}};
}

test('decoded audio is shared while pending and cached until clear, without leaking AudioContexts', async () => {
  const gate = deferred(), h = harness({decode: () => gate.promise});
  const first = h.client.decode(h.file, 10), second = h.client.decode(h.file, 10);
  await flush(); assert.equal(h.reads, 1); assert.equal(h.decodeCalls, 1);
  gate.resolve(audio());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b); assert.equal(h.contexts[0].closed, 1);
  assert.equal(await h.client.decode(h.file, 10), a); assert.equal(h.reads, 1);
  h.client.clear(); await h.client.decode(h.file, 10);
  assert.equal(h.reads, 2); assert.equal(h.contexts.length, 2); assert.equal(h.contexts[1].closed, 1);
});

test('failed decoding clears the cache so retry is possible, and input limits prevent reads', async () => {
  const h = harness({decode: (_bytes, count) => count === 1 ? Promise.reject(new Error('codec')) : Promise.resolve(audio())});
  await assert.rejects(h.client.decode(h.file, 10), /Audio non decodificabile/);
  const result = await h.client.decode(h.file, 10);
  assert.equal(result.samples.length, 100); assert.equal(h.reads, 2);
  assert.ok(h.contexts.every(context => context.closed === 1));
  const before = h.reads;
  await assert.rejects(h.client.decode({...h.file, size: 129 * 1024 * 1024}, 10), /128 MB/);
  await assert.rejects(h.client.decode(h.file, 1801), /30 minuti/);
  assert.equal(h.reads, before);
});

test('opposite-phase stereo keeps a real channel instead of becoming silence', async () => {
  const left = new Float32Array(100).fill(.8), right = new Float32Array(100).fill(-.8);
  const h = harness({audio: audio([left, right])});
  const decoded = await h.client.decode(h.file, 10);
  near(decoded.samples[20], .8);
  assert.notEqual(decoded.samples, left, 'cached mono data must have independent storage');
});

test('cropped worker data and manual anchors use local seconds; returned beats use original seconds', async () => {
  const h = harness(), updates = [];
  const resultPromise = h.client.run(h.file, 10, {start: 2.15, end: 8.05, minBpm: 40, maxBpm: 180,
    anchors: [{time: 1}, {time: 2.15, breakBefore: true}, {time: 7, fermataBefore: true}, {time: 9}]}, update => updates.push(update));
  await flush(); const worker = h.workers[0], posted = worker.messages[0];
  assert.equal(posted.message.samples.length, 60);
  assert.equal(posted.transfer[0], posted.message.samples.buffer);
  near(posted.message.samples[0], .21);
  assert.equal(posted.message.options.anchors.length, 2);
  assert.equal(posted.message.options.anchors[0].breakBefore, true);
  assert.equal(posted.message.options.anchors[1].fermataBefore, true);
  near(posted.message.options.anchors[0].time, .05); near(posted.message.options.anchors[1].time, 4.9);
  worker.send({type: 'progress', stage: 'tracking', progress: .5});
  near(updates.at(-1).progress, .55);
  worker.send({type: 'result', result: {beats: [{time: .2, confidence: .9}], diagnostics: {localTempo: [{time: 1, bpm: 120}]}}});
  const result = await resultPromise;
  near(result.beats[0].time, 2.3); near(result.diagnostics.localTempo[0].time, 3.1);
  assert.equal(worker.terminated, 1); assert.deepEqual(h.revoked, [worker.url]);
  assert.equal((await h.client.decode(h.file, 10)).samples.length, 100, 'transferring a crop must leave cached PCM intact');
  assert.equal(h.reads, 1);
});

test('abort before start or during decode prevents Worker creation and rejects promptly', async () => {
  const h = harness(), before = new AbortController(); before.abort();
  await assert.rejects(h.client.run(h.file, 10, {}, null, before.signal), {name: 'AbortError'});
  assert.equal(h.reads, 0);
  const gate = deferred(), delayed = harness({decode: () => gate.promise}), during = new AbortController();
  const pending = delayed.client.run(delayed.file, 10, {}, null, during.signal);
  await flush(); during.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  gate.resolve(audio()); await flush();
  assert.equal(delayed.workers.length, 0); assert.equal(delayed.created.length, 0);
  assert.equal(delayed.contexts[0].closed, 1);
});

test('abort during analysis terminates Worker, revokes Blob URL once, and ignores late completion', async () => {
  const h = harness(), controller = new AbortController();
  const pending = h.client.run(h.file, 10, {}, null, controller.signal);
  await flush(); const worker = h.workers[0]; controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  worker.send({type: 'result', result: {beats: [{time: 1, confidence: .8}]}});
  assert.equal(worker.terminated, 1); assert.deepEqual(h.revoked, [worker.url]);
  assert.equal((await h.client.decode(h.file, 10)).samples.length, 100);
});

test('Worker failures, detector errors, malformed responses, and constructor failures clean up', async () => {
  for (const failure of ['runtime', 'message', 'malformed', 'constructor']) {
    const h = harness({constructorError: failure === 'constructor'});
    const pending = h.client.run(h.file, 10, {});
    const rejected = assert.rejects(pending);
    await flush();
    if (failure === 'runtime') h.workers[0].fail();
    if (failure === 'message') h.workers[0].send({type: 'error', message: 'No beat found'});
    if (failure === 'malformed') h.workers[0].send({type: 'result', result: {beats: 'bad'}});
    await rejected;
    assert.equal(h.created.length, 1, failure); assert.equal(h.revoked.length, 1, failure);
    if (h.workers.length) assert.equal(h.workers[0].terminated, 1, failure);
  }
});
