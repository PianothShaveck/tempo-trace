'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const musical = require('../assets/musical.js');
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const constant = (count, duration = .5, start = 0) => Array.from({length: count + 1}, (_, i) => ({id: 'b' + i, time: start + i * duration}));
const meter = (numerator, denominator, rest = {}) => ({enabled: true, firstBar: 1, pickup: 0, meters: [{bar: 1, numerator, denominator}], ...rest});

test('default musical config is independent and supports an empty timeline', () => {
  const a = musical.validate(), b = musical.validate();
  assert.deepEqual(a, {enabled: false, firstBar: 1, pickup: 0, meters: [{bar: 1, numerator: 4, denominator: 4}]});
  a.meters[0].numerator = 9;
  assert.equal(b.meters[0].numerator, 4);
  const timeline = musical.build([], b);
  assert.deepEqual(timeline.bars, []);
  assert.equal(musical.barAtTime(timeline, 0), null);
  assert.equal(musical.timeAtQuarter(timeline, 0), null);
});

test('ordinary bars have exact original-time means and no empty final bar', () => {
  const timeline = musical.build(constant(16, .5, 12), meter(4, 4));
  assert.equal(timeline.bars.length, 4);
  timeline.bars.forEach((bar, index) => {
    assert.equal(bar.number, index + 1);
    assert.equal(bar.startQuarter, index * 4);
    assert.equal(bar.endQuarter, (index + 1) * 4);
    assert.equal(bar.start, 12 + index * 2);
    assert.equal(bar.end, 14 + index * 2);
    assert.equal(bar.complete, true);
    near(bar.meanBpm, 120);
  });
  assert.equal(musical.barAtTime(timeline, 14).number, 2);
  assert.equal(musical.barAtTime(timeline, 20).number, 4);
  assert.equal(musical.barAtTime(timeline, 20.1), null);
});

test('arbitrary integer meters include 3/1, 11/8, and a non-power-of-two denominator', () => {
  const timeline = musical.build(constant(48, .25), {
    enabled: true, firstBar: -3, pickup: 0,
    meters: [{bar: -1, numerator: 11, denominator: 8}, {bar: -3, numerator: 3, denominator: 1}, {bar: 1, numerator: 5, denominator: 3}]
  });
  assert.deepEqual(timeline.meterEvents.map(event => [event.bar, event.quarter]), [[-3, 0], [-1, 24], [1, 35]]);
  assert.deepEqual(timeline.bars.slice(0, 5).map(bar => [bar.number, bar.startQuarter, bar.numerator, bar.denominator]), [
    [-3, 0, 3, 1], [-2, 12, 3, 1], [-1, 24, 11, 8], [0, 29.5, 11, 8], [1, 35, 5, 3]
  ]);
  timeline.bars.forEach(bar => near(bar.meanBpm, 240));
});

test('an upbeat precedes the first full bar and uses the initial meter', () => {
  const timeline = musical.build(constant(18), {enabled: true, firstBar: 42, pickup: 1.5,
    meters: [{bar: 42, numerator: 11, denominator: 8}, {bar: 44, numerator: 3, denominator: 1}]});
  assert.deepEqual(timeline.bars.slice(0, 4).map(bar => [bar.number, bar.pickup, bar.startQuarter, bar.endQuarter]), [
    [41, true, 0, 1.5], [42, false, 1.5, 7], [43, false, 7, 12.5], [44, false, 12.5, 24.5]
  ]);
  assert.deepEqual(timeline.meterEvents.map(event => [event.bar, event.quarter]), [[42, 0], [44, 12.5]]);
  assert.equal(timeline.bars[0].complete, true);
  assert.equal(timeline.bars[3].complete, false);
  assert.equal(timeline.bars[3].end, 9);
  assert.equal(timeline.bars[3].measuredEndQuarter, 18);
  near(timeline.bars[3].meanBpm, 120);
});

test('a recording entirely within the upbeat does not fabricate a full bar', () => {
  const timeline = musical.build(constant(1), meter(4, 4, {pickup: 2}));
  assert.equal(timeline.bars.length, 1);
  assert.equal(timeline.bars[0].number, 0);
  assert.equal(timeline.bars[0].pickup, true);
  assert.equal(timeline.bars[0].complete, false);
  assert.equal(timeline.bars[0].end, .5);
});

test('quarter interpolation and bar means correctly split noninteger beat units', () => {
  const beats = [{id: 'a', time: 10}, {id: 'b', time: 11}, {id: 'c', time: 13}, {id: 'd', time: 14}];
  const timeline = musical.build(beats, meter(2, 4), 1.5);
  assert.deepEqual(timeline.anchors.map(anchor => anchor.quarter), [0, 1.5, 3, 4.5]);
  near(musical.quarterAtTime(timeline, 12), 2.25);
  near(musical.timeAtQuarter(timeline, 2), 11 + 2 / 3);
  near(timeline.bars[0].meanBpm, 72);
  near(timeline.bars[1].meanBpm, 60);
  near(timeline.bars[2].meanBpm, 90);
  assert.equal(timeline.bars[2].complete, false);
});

test('explicit MIDI coordinates preserve unequal score distances and rebase the first active anchor', () => {
  const beats = [{id: 'c', time: 15, quarter: 14}, {id: 'a', time: 10, quarter: 8}, {id: 'b', time: 12, quarter: 10}];
  const saved = JSON.stringify(beats);
  const timeline = musical.build(beats, meter(4, 4), .5);
  assert.deepEqual(timeline.anchors.map(anchor => anchor.quarter), [0, 2, 6]);
  assert.equal(musical.quarterAtTime(timeline, 13.5), 4);
  near(timeline.bars[0].meanBpm, 240 / 3.5);
  near(timeline.bars[1].meanBpm, 80);
  assert.equal(JSON.stringify(beats), saved);
});

test('mixed, reversed, collapsed, and duplicate-time musical positions are rejected explicitly', () => {
  assert.throws(() => musical.build([{time: 0, quarter: 0}, {time: 1}]), /tutti i beat/);
  assert.throws(() => musical.build([{time: 0, quarter: 1}, {time: 1, quarter: 0}]), /crescere/);
  assert.throws(() => musical.build([{time: 0, quarter: 1}, {time: 1, quarter: 1}]), /crescere/);
  assert.throws(() => musical.build([{time: 0, quarter: 0}, {time: 0, quarter: 1}]), /stesso istante/);
  assert.throws(() => musical.build([{time: 0, quarter: 0}, {time: 1, quarter: Infinity}]), /tutti i beat/);
});

test('breaks never invent interpolation or a measured tempo across an unmeasured span', () => {
  const timeline = musical.build([{id: 'a', time: 0}, {id: 'b', time: .5},
    {id: 'c', time: 20, breakBefore: true}, {id: 'd', time: 20.5}, {id: 'e', time: 21}], meter(2, 4));
  assert.equal(musical.quarterAtTime(timeline, 10), null);
  assert.equal(musical.timeAtQuarter(timeline, 1.5), null);
  assert.equal(musical.timeAtQuarter(timeline, 2), 20);
  assert.equal(musical.barAtTime(timeline, 10), null);
  assert.equal(timeline.bars[0].meanBpm, null);
  assert.equal(timeline.bars[0].hasGap, true);
  assert.equal(timeline.bars[0].complete, false);
  assert.equal(timeline.bars[1].hasGap, false);
  assert.equal(timeline.bars[1].complete, true);
  assert.equal(timeline.bars[1].meanBpm, 120);
});

test('a gap containing a bar boundary leaves that boundary time unknown', () => {
  const timeline = musical.build([{time: 0, quarter: 0}, {time: 1, quarter: 1},
    {time: 10, quarter: 7, breakBefore: true}, {time: 11, quarter: 8}], meter(4, 4));
  assert.equal(timeline.bars[0].end, null);
  assert.equal(timeline.bars[1].start, null);
  assert.ok(timeline.bars.every(bar => bar.meanBpm === null && bar.hasGap));
});

test('duplicate seconds merge without mutation and invalid timestamps are ignored', () => {
  const beats = [{time: NaN}, {time: -1}, {time: 0}, {time: 1}, {time: 1, breakBefore: true}, {time: 2}];
  const timeline = musical.build(beats, meter(4, 4));
  assert.equal(timeline.anchors.length, 3);
  assert.equal(timeline.anchors[1].breakBefore, true);
  assert.equal(beats[3].breakBefore, undefined);
  assert.equal(timeline.bars[0].meanBpm, null);
});

test('helpers never extrapolate and can operate directly on the anchors array', () => {
  const timeline = musical.build(constant(4, .5, 8), meter(4, 4));
  assert.equal(musical.timeAtQuarter(timeline.anchors, 2), 9);
  assert.equal(musical.quarterAtTime(timeline.anchors, 9.5), 3);
  for (const value of [-1, 5, NaN, Infinity]) assert.equal(musical.timeAtQuarter(timeline, value), null);
  for (const value of [7, 11, NaN, Infinity]) assert.equal(musical.quarterAtTime(timeline, value), null);
});

test('invalid meter configuration produces clear validation errors rather than silent defaults', () => {
  assert.throws(() => musical.validate(null), /non valide/);
  assert.throws(() => musical.validate({firstBar: 1.5}), /intero/);
  assert.throws(() => musical.validate({pickup: -1}), /levare/);
  assert.throws(() => musical.validate({meters: []}), /almeno/);
  assert.throws(() => musical.validate(meter(0, 4)), /positivi/);
  assert.throws(() => musical.validate(meter(3, 0)), /positivi/);
  assert.throws(() => musical.validate(meter(3.5, 4)), /positivi/);
  assert.throws(() => musical.validate(meter(3, 4, {pickup: 3})), /più corto/);
  assert.throws(() => musical.validate({firstBar: 2, meters: [{bar: 3, numerator: 4, denominator: 4}]}), /primo metro/);
  assert.throws(() => musical.validate({meters: [{bar: 1, numerator: 4, denominator: 4}, {bar: 1, numerator: 3, denominator: 4}]}), /stessa battuta/);
  assert.throws(() => musical.build(constant(8), meter(4, 4), 0), /valore del beat/);
});

test('resource and precision checks stop pathological configurations before allocating impossible bar arrays', () => {
  assert.throws(() => musical.build(constant(8), meter(1, Number.MAX_SAFE_INTEGER)), /troppe battute/);
  assert.throws(() => musical.build(constant(8), meter(4, 4), Number.MIN_VALUE), /precisione/);
  assert.throws(() => musical.build(constant(8), meter(1, 4, {firstBar: Number.MAX_SAFE_INTEGER,
    meters: [{bar: Number.MAX_SAFE_INTEGER, numerator: 1, denominator: 4}]})), /contatore/);
});

test('long fractional meters do not create an empty trailing bar from accumulation error', () => {
  const count = 5000;
  const timeline = musical.build([{time: 0, quarter: 0}, {time: count, quarter: count * 4 / 3}], meter(1, 3));
  assert.equal(timeline.bars.length, count);
  assert.ok(timeline.bars.every(bar => bar.complete));
  near(timeline.bars[count - 1].meanBpm, 80, 1e-6);
});

test('single anchor provides a coordinate but no fabricated tempo or bar duration', () => {
  const timeline = musical.build([{id: 'one', time: 5}], meter(4, 4));
  assert.equal(musical.quarterAtTime(timeline, 5), 0);
  assert.equal(musical.timeAtQuarter(timeline, 0), 5);
  assert.equal(timeline.bars.length, 0);
});
