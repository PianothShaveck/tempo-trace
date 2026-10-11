'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/click-track.js'), 'utf8');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function harness({rms=.005, routingFails=false} = {}) {
  const contexts = [], intervals = new Map(), listeners = new Map();
  let timerId = 0;
  const parameter = () => ({value: 1, events: [],
    setValueAtTime(value, time) {this.value = value; this.events.push({type: 'set', value, time});},
    linearRampToValueAtTime(value, time) {this.events.push({type: 'linear', value, time});},
    exponentialRampToValueAtTime(value, time) {this.events.push({type: 'exponential', value, time});},
    cancelScheduledValues(time) {this.events.push({type: 'cancel', time});},
    setTargetAtTime(value, time, constant) {this.events.push({type: 'target', value, time, constant});}
  });
  class AudioContextDouble {
    constructor() {this.currentTime = 12; this.state = 'running'; this.destination = {}; this.gains = []; this.oscillators = []; this.sources=[]; this.rms=rms; contexts.push(this);}
    resume() {this.state = 'running'; return Promise.resolve();}
    createAnalyser() {
      const context=this;
      const node={fftSize:1024,connect(target){this.connected=target;},getFloatTimeDomainData(samples){samples.fill(context.rms);}};
      this.analyser=node;return node;
    }
    createMediaElementSource(element) {
      if(routingFails)throw new Error('Unavailable');
      const node={mediaElement:element,connect(target){this.connected=target;},disconnect(){this.connected=null;}};
      this.sources.push(node);return node;
    }
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
  const audio = h.contexts[0], master = audio.gains[0], oscillator = audio.oscillators[0], voice = oscillator.connected;
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

test('click level changes affect pending clicks without changing media volume or timing', async () => {
  const h = harness(); h.clicks.setBeats([{time: .08}]); h.clicks.setVolume(.5);
  await h.clicks.setEnabled(true);
  const audio = h.contexts[0], master = audio.gains[0], voice = audio.oscillators[0].connected;
  near(master.gain.value, .4);
  h.clicks.setVolume(2); near(master.gain.value, 1.6);
  assert.equal(voice.connected, master); assert.equal(h.media.volume, .8);
  near(audio.oscillators[0].starts[0], 12.08);
  h.clicks.setVolume(0); assert.equal(master.gain.value, 0);
  h.clicks.setVolume(NaN); assert.equal(master.gain.value, 0);
  h.clicks.setVolume(1); h.media.muted = true; h.emit('volumechange');
  assert.equal(master.gain.value, 0);
});

test('automatic balance attenuates loud recordings around a high click and leaves quiet recordings intact', async () => {
  for(const rms of [.005,.4]){
    const h=harness({rms});h.clicks.setBeats([{time:.08}]);await h.clicks.setEnabled(true);
    const audio=h.contexts[0], gain=audio.analyser.connected;
    assert.equal(audio.sources[0].mediaElement,h.media);
    assert.equal(audio.sources[0].connected,audio.analyser);
    assert.equal(gain.connected,audio.destination);
    assert.equal(audio.oscillators[0].frequency.value,2600);
    const ducks=gain.gain.events.filter(e=>e.type==='target'&&e.value<1);
    assert.equal(ducks.length,rms>.1?1:0);
    if(ducks.length){
      assert.ok(ducks[0].value>=.22&&ducks[0].value<.5);
      near(ducks[0].time,12.072);
      const release=gain.gain.events.at(-1);assert.equal(release.value,1);near(release.time,12.115);
    }
    assert.equal(h.media.volume,.8);
  }
});

test('disabling automatic balance, a zero click level and stopping playback restore the recording gain', async () => {
  const h=harness({rms:.4});h.clicks.setBeats([{time:.08}]);await h.clicks.setEnabled(true);
  const audio=h.contexts[0], gain=audio.analyser.connected;
  h.clicks.setAutoBalance(false);
  assert.equal(gain.gain.events.at(-2).type,'cancel');assert.equal(gain.gain.events.at(-1).value,1);
  h.clicks.setAutoBalance(true);h.clicks.setVolume(0);
  assert.equal(gain.gain.events.at(-2).type,'cancel');assert.equal(gain.gain.events.at(-1).value,1);
  h.clicks.setVolume(1);h.media.paused=true;h.emit('pause');
  assert.equal(gain.gain.events.at(-1).value,1);
  await h.clicks.setEnabled(false);await h.clicks.setEnabled(true);
  assert.equal(audio.sources.length,1,'the media source must be reused after toggling');
});

test('click playback remains available when automatic audio routing is unsupported', async () => {
  const h=harness({routingFails:true});h.clicks.setBeats([{time:.08}]);await h.clicks.setEnabled(true);
  assert.equal(h.clicks.balanceAvailable,false);assert.equal(h.clicks.enabled,true);
  assert.equal(h.contexts[0].oscillators.length,1);assert.equal(h.media.volume,.8);
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
