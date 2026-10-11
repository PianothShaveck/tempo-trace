'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/click-track.js'), 'utf8');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function harness() {
  const contexts = [], intervals = new Map(), listeners = new Map();
  let timerId = 0;
  const parameter = () => ({value: 1, events: [],
    setValueAtTime(value, time) {this.value = value; this.events.push({type: 'set', value, time});},
    linearRampToValueAtTime(value, time) {this.events.push({type: 'linear', value, time});},
    exponentialRampToValueAtTime(value, time) {this.events.push({type: 'exponential', value, time});}
  });
  class AudioContextDouble {
    constructor() {this.currentTime = 12; this.state = 'running'; this.destination = {}; this.gains = []; this.oscillators = []; contexts.push(this);}
    resume() {this.state = 'running'; return Promise.resolve();}
    createGain() {
      const node = {gain: parameter(), connected: null, connect(target) {this.connected = target;}, disconnect() {}};
      this.gains.push(node); return node;
    }
    createOscillator() {
      const node = {frequency: {value: 0}, starts: [], stops: [], connected: null,
        connect(target) {this.connected = target;}, disconnect() {},
        start(when) {this.starts.push(when);}, stop(when) {this.stops.push(when);}
      };
      this.oscillators.push(node); return node;
    }
  }
  const media = {currentTime: 0, playbackRate: 1, volume: .8, muted: false, paused: false, ended: false, seeking: false,
    addEventListener(name, listener) {if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(listener);}
  };
  const sandbox = vm.createContext({window: {AudioContext: AudioContextDouble},
    setInterval(callback) {const id = ++timerId; intervals.set(id, callback); return id;},
    clearInterval(id) {intervals.delete(id);}
  });
  vm.runInContext(source, sandbox, {filename: 'click-track.js'});
  return {media, contexts, clicks: sandbox.TempoClicks.create(media),
    emit(name) {for (const listener of listeners.get(name) || []) listener();},
    pump() {for (const callback of intervals.values()) callback();}
  };
}

test('mute and zero volume silence already scheduled clicks through the shared output gain', async () => {
  const h = harness(); h.clicks.setBeats([{time: .08}]); await h.clicks.setEnabled(true);
  const audio = h.contexts[0], master = audio.gains[0], voice = audio.gains[1], oscillator = audio.oscillators[0];
  assert.equal(master.connected, audio.destination); assert.equal(voice.connected, master); assert.equal(oscillator.connected, voice);
  near(master.gain.value, .8); near(oscillator.starts[0], 12.08);
  h.media.muted = true; h.emit('volumechange'); assert.equal(master.gain.value, 0);
  // The pending voice still feeds this same, now exactly silent, output gain.
  assert.equal(voice.connected, master); assert.equal(oscillator.stops.length, 1);
  h.media.muted = false; h.media.volume = .3; h.emit('volumechange'); near(master.gain.value, .3);
  h.media.volume = 0; h.emit('volumechange'); assert.equal(master.gain.value, 0);
  assert.equal(voice.gain.events.find(event => event.type === 'linear').value, .2);
});

test('original-time offsets convert to wall-clock delays at slow and fast playback rates', async () => {
  for (const rate of [.25, .5, 1, 1.5, 2]) {
    const h = harness(); h.media.currentTime = 4; h.media.playbackRate = rate;
    h.clicks.setBeats([{time: 4 + .08 * rate}]); await h.clicks.setEnabled(true);
    assert.equal(h.contexts[0].oscillators.length, 1);
    near(h.contexts[0].oscillators[0].starts[0], 12.08);
  }
});

test('seek, rate changes, pause and buffering cancel stale clicks before scheduling against the new clock', async () => {
  const h = harness(); h.clicks.setBeats([{time: .08}, {time: 1.08}]); await h.clicks.setEnabled(true);
  const audio = h.contexts[0], first = audio.oscillators[0];
  h.media.currentTime = 1; h.media.seeking = true; h.emit('seeking');
  assert.equal(first.stops.at(-1), undefined); h.pump(); assert.equal(audio.oscillators.length, 1);
  h.media.seeking = false; h.emit('seeked'); h.pump();
  assert.equal(audio.oscillators.length, 2); near(audio.oscillators[1].starts[0], 12.08);
  h.media.playbackRate = 2; h.emit('ratechange'); assert.equal(audio.oscillators[1].stops.at(-1), undefined);
  h.pump(); near(audio.oscillators[2].starts[0], 12.04);
  h.media.paused = true; h.emit('pause'); h.pump(); assert.equal(audio.oscillators.length, 3);
  h.media.paused = false; h.emit('playing'); assert.equal(audio.oscillators.length, 4);
  h.emit('waiting'); h.pump(); assert.equal(audio.oscillators.length, 4);
  assert.equal(audio.oscillators[3].stops.at(-1), undefined);
  h.emit('playing'); assert.equal(audio.oscillators.length, 5); near(audio.oscillators[4].starts[0], 12.04);
  await h.clicks.setEnabled(false); h.pump(); assert.equal(audio.oscillators.length, 5);
});
