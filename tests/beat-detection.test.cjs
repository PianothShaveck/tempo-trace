'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {analyze} = require('../assets/beat-detection.js');
const SR = 11025;
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function rhythm(duration, bpmAt, start = 1, stop = duration - 1) {
  const times = [];
  for (let t = start; t < stop; t += 60 / bpmAt(t)) times.push(t);
  return times;
}
function signal(duration, times, {amplitude = 0.65, note = false, gainAt = () => 1} = {}) {
  const audio = new Float32Array(Math.ceil(duration * SR));
  times.forEach((time, beat) => {
    const start = Math.round(time * SR);
    const samples = Math.round(SR * (note ? .22 : .024));
    const frequency = note ? [220, 277.18, 329.63, 440][beat % 4] : 1100;
    for (let i = 0; i < samples && start + i < audio.length; i++) {
      const t = i / SR;
      const envelope = Math.min(1, t / .002) * Math.exp(-t / (note ? .075 : .005));
      audio[start + i] += amplitude * gainAt(time, beat) * envelope *
        (Math.sin(2 * Math.PI * frequency * t) + (note ? .3 * Math.sin(2 * Math.PI * 2.01 * frequency * t) : 0));
    }
  });
  return audio;
}
function localBpm(result, from, to) {
  const periods = [];
  for (let i = 1; i < result.beats.length; i++) {
    const a = result.beats[i - 1], b = result.beats[i];
    if (a.time >= from && b.time <= to && !b.breakBefore) periods.push(60 / (b.time - a.time));
  }
  return median(periods);
}
function near(value, expected, tolerance) {
  assert.ok(Number.isFinite(value) && Math.abs(value - expected) <= tolerance,
    `Expected ${value} within ${tolerance} of ${expected}`);
}
function matchFraction(actual, expected, tolerance = .045) {
  return expected.filter(t => actual.some(b => Math.abs(b.time - t) <= tolerance)).length / expected.length;
}
function assertValid(result, duration) {
  assert.ok(Array.isArray(result.beats));
  result.beats.forEach((beat, i) => {
    assert.ok(Number.isFinite(beat.time) && beat.time >= 0 && beat.time <= duration);
    assert.ok(Number.isFinite(beat.confidence) && beat.confidence >= 0 && beat.confidence <= 1);
    if (i) assert.ok(beat.time > result.beats[i - 1].time);
  });
}

test('silence yields no invented beat train', () => {
  const result = analyze(new Float32Array(SR * 20), SR);
  assert.equal(result.beats.length, 0);
});

test('confirmed fermatas do not slow the tempo inferred from manual guidance', () => {
  const anchors = [1, 1.6, 2.2, 3.4, 4.6, 5.8].map((time, i) => ({time, fermataBefore: i >= 3}));
  const expected = [...anchors.map(b => b.time), ...rhythm(20, () => 100, 6.4)];
  const result = analyze(signal(20, expected), SR, {anchors});
  near(result.diagnostics.preferredBpm, 100, .01);
  near(localBpm(result, 9, 18), 100, 2);
});

test('isolated note does not establish a rhythm', () => {
  const result = analyze(signal(12, [2], {note: true}), SR);
  assert.ok(result.beats.length <= 1);
});

test('constant click train detects timing and absolute pulse without a hint', () => {
  const expected = rhythm(24, () => 120);
  const audio = signal(24, expected);
  const result = analyze(audio, SR);
  assertValid(result, 24);
  near(localBpm(result, 3, 21), 120, 2);
  assert.ok(matchFraction(result.beats, expected) >= .9, 'At least 90% of known impulses must align within45ms');
  assert.ok(result.beats.length <= expected.length + 2, 'Must not add a subdivision grid');
});

test('synthetic piano-like notes retain attack timing at softer dynamics', () => {
  const expected = rhythm(28, () => 100);
  const loud = analyze(signal(28, expected, {note: true, amplitude: .6}), SR, {preferredBpm: 100});
  const quiet = analyze(signal(28, expected, {note: true, amplitude: .012}), SR, {preferredBpm: 100});
  near(localBpm(loud, 3, 24), 100, 3);
  near(localBpm(quiet, 3, 24), 100, 3);
  assert.ok(matchFraction(quiet.beats, expected) >= .85);
  assert.ok(Math.abs(loud.beats.length - quiet.beats.length) <= 2);
});

test('a sustained tempo step follows both sections without octave switching', () => {
  const expected = rhythm(54, t => t < 27 ? 96 : 132);
  const result = analyze(signal(54, expected), SR);
  near(localBpm(result, 5, 23), 96, 4);
  near(localBpm(result, 32, 49), 132, 4);
});

test('gradual accelerando and rallentando retain their direction and local rate', () => {
  const bpm = t => t < 32 ? 84 + 1.5 * t : 132 - 1.5 * (t - 32);
  const expected = rhythm(64, bpm);
  const result = analyze(signal(64, expected, {note: true}), SR, {preferredBpm: 108});
  for (const t of [10, 24, 40, 54]) near(localBpm(result, t - 3, t + 3), bpm(t), 9);
  assert.ok(localBpm(result, 26, 30) > localBpm(result, 5, 9) + 20);
  assert.ok(localBpm(result, 35, 39) > localBpm(result, 55, 59) + 20);
});

test('long silence creates a discontinuity and no invented beats in the rest', () => {
  const expected = [...rhythm(20, () => 120), ...rhythm(43, () => 120, 27, 42)];
  const result = analyze(signal(43, expected), SR, {preferredBpm: 120});
  assert.equal(result.beats.filter(b => b.time > 21 && b.time < 26).length, 0);
  const after = result.beats.find(b => b.time >= 26);
  assert.ok(after && after.breakBefore, 'A rest must not become a very slow measured interval');
  near(localBpm(result, 30, 40), 120, 3);
});

test('preferred pulse resolves audible subdivisions without promoting them to beats', () => {
  const quarters = rhythm(30, () => 100);
  const eighths = rhythm(30, () => 200);
  const audio = signal(30, eighths, {note: true, gainAt: (_t, i) => i % 2 ? .55 : 1});
  const result = analyze(audio, SR, {preferredBpm: 100});
  near(localBpm(result, 4, 26), 100, 4);
  assert.ok(matchFraction(result.beats, quarters) >= .8);
  assert.ok(result.beats.length < quarters.length * 1.2);
});

test('analysis is deterministic, does not mutate PCM, and reports progress', () => {
  const input = signal(18, rhythm(18, () => 112));
  const before = input.slice();
  const updates = [];
  const first = analyze(input, SR, {preferredBpm: 112}, update => updates.push(update));
  const second = analyze(input, SR, {preferredBpm: 112});
  assert.deepEqual(first.beats, second.beats);
  assert.deepEqual(input, before);
  assert.ok(updates.length > 0);
  assert.ok(updates.every(p => Number.isFinite(p.progress) && p.progress >= 0 && p.progress <= 1));
});

test('a sustained fermata does not receive invented beats over resonance', () => {
  const expected = [...rhythm(20, () => 100, 1, 17), ...rhythm(38, () => 100, 24, 37)];
  const audio = signal(38, expected, {note: true});
  const holdStart = 17;
  for (let i = 0; i < 6 * SR; i++) {
    const t = i / SR;
    const envelope = Math.min(1, t / .003) * Math.exp(-t / 2.5);
    audio[Math.round(holdStart * SR) + i] += .5 * envelope *
      (Math.sin(2 * Math.PI * 220 * t) + .3 * Math.sin(2 * Math.PI * 330 * t));
  }
  const result = analyze(audio, SR, {preferredBpm: 100});
  assert.equal(result.beats.filter(b => b.time > 18 && b.time < 22.8).length, 0,
    'A held tone contains no new attacks and must not receive a metronome grid');
  near(localBpm(result, 27, 35), 100, 4);
});

test('small sustained tempo shifts remain measurable rather than snapped to one grid', () => {
  const expected = rhythm(70, t => t < 23 ? 100 : t < 46 ? 106 : 97);
  const result = analyze(signal(70, expected, {note: true}), SR, {preferredBpm: 100});
  near(localBpm(result, 6, 19), 100, 1.5);
  near(localBpm(result, 29, 41), 106, 1.5);
  near(localBpm(result, 52, 64), 97, 1.5);
  assert.ok(matchFraction(result.beats, expected) >= .9);
});

test('phrase-shaped rubato follows individual attacks without flattening timing', () => {
  const bpm = t => 108 + 9 * Math.sin(t * Math.PI / 5);
  const expected = rhythm(42, bpm);
  const result = analyze(signal(42, expected, {note: true, gainAt: (_t, i) => i % 4 === 0 ? 1 : .65}), SR, {preferredBpm: 108});
  assert.ok(matchFraction(result.beats, expected) >= .9);
  assert.ok(result.beats.length <= expected.length + 2);
  const intervals = result.beats.slice(1).map((b, i) => 60 / (b.time - result.beats[i].time));
  assert.ok(Math.max(...intervals) - Math.min(...intervals) > 12);
});

test('a long rest does not discard an earlier played section', () => {
  const first = rhythm(15, () => 120, 1, 13);
  const second = rhythm(50, () => 100, 35, 48);
  const result = analyze(signal(50, [...first, ...second], {note: true}), SR);
  assert.ok(matchFraction(result.beats, first) >= .85, 'The first section must survive an unconnected later section');
  assert.ok(matchFraction(result.beats, second) >= .85, 'The resumed section must also be retained');
  assert.equal(result.beats.filter(b => b.time > 15 && b.time < 34).length, 0);
  assert.ok(result.beats.find(b => b.time >= 34)?.breakBefore);
});

test('a quiet passage inside the same recording remains detectable', () => {
  const expected = rhythm(48, () => 100);
  const audio = signal(48, expected, {note: true, gainAt: t => t >= 16 && t < 32 ? .07 : 1});
  const result = analyze(audio, SR, {preferredBpm: 100});
  const quietExpected = expected.filter(t => t > 18 && t < 30);
  assert.ok(matchFraction(result.beats, quietExpected) >= .85, 'Dynamic normalization must retain the quiet middle passage');
  near(localBpm(result, 19, 29), 100, 3);
});
