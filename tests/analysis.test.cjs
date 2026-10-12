'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {analyze, normalizeBeats} = require('../assets/analysis.js');

function beatsFromPeriods(periods, start = 0) {
  const beats = [{id: 'b0', time: start}];
  for (const duration of periods) beats.push({id: 'b' + beats.length, time: beats[beats.length - 1].time + duration});
  return beats;
}
const constant = (bpm, count, start) => beatsFromPeriods(Array(count).fill(60 / bpm), start);
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance,
  'Expected ' + actual + ' to be within ' + tolerance + ' of ' + expected);

test('constant tempo: exact count / duration statistics, single section and no warnings', () => {
  const result = analyze(constant(120, 80, 17));
  assert.equal(result.intervals.length, 80);
  assert.equal(result.sections.length, 1);
  assert.equal(result.anomalies.length, 0);
  for (const key of ['mean', 'start', 'end', 'min', 'max']) near(result.stats[key], 120);
  near(result.sections[0].bpm, 120);
  assert.equal(result.intervals[0].time, 17.25);
  assert.equal(result.intervals[0].beatId, 'b1');
  assert.equal(result.intervals[0].breakBefore, true);
});

test('tempo uses original timestamps regardless of a playback-rate setting; note unit scales BPM', () => {
  const beats = constant(96, 40);
  assert.deepEqual(analyze(beats, {playbackRate: .5}), analyze(beats, {playbackRate: 2}));
  near(analyze(beats, {beatUnit: .5}).stats.mean, 48);
  near(analyze(beats, {beatUnit: 1.5}).stats.mean, 144);
  near(analyze(beats, {beatUnit: 2}).stats.mean, 192);
});

test('normal cyclic rubato is preserved without creating sections or false anomalies', () => {
  const periods = Array.from({length: 160}, (_, i) => 60 / (100 + 8 * Math.sin(i * Math.PI / 10)));
  const result = analyze(beatsFromPeriods(periods));
  assert.equal(result.sections.length, 1);
  assert.equal(result.anomalies.length, 0);
  assert.ok(result.stats.max - result.stats.min > 15);
  assert.ok(result.intervals.some(i => i.smoothed !== i.bpm));
});

test('sustained tempo steps are found at the real boundary with coherent section means', () => {
  const periods = [...Array(40).fill(.6), ...Array(48).fill(.5), ...Array(36).fill(2 / 3)];
  const result = analyze(beatsFromPeriods(periods));
  assert.equal(result.sections.length, 3);
  assert.equal(result.anomalies.length, 0);
  [100, 120, 90].forEach((bpm, i) => near(result.sections[i].bpm, bpm));
  near(result.sections[1].start, 24);
  near(result.sections[2].start, 48);
  near(result.stats.mean, periods.length * 60 / 72);
  near(result.stats.start, 100);
  near(result.stats.end, 90);
});

test('a doubled interval is an ambiguous hold candidate, never a confirmed tap error', () => {
  const beats = constant(120, 81);
  beats.splice(40, 1);
  const result = analyze(beats);
  assert.equal(result.sections.length, 1);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'possible-fermata');
  assert.equal(result.events[0].confidence, 'candidate');
  const held = result.intervals.find(interval => interval.expressive === 'possible-fermata');
  assert.equal(held.bpm, 60);
  assert.equal(held.smoothed, 120);
  near(result.stats.mean, 80 * 60 / 40.5);
  assert.equal(beats.length, 81);
});

test('an extra tap flags both split intervals and leaves measured means intact', () => {
  const beats = constant(120, 80);
  beats.push({id: 'extra', time: 20.1});
  const result = analyze(beats);
  assert.equal(result.sections.length, 1);
  assert.equal(result.anomalies.length, 2);
  assert.ok(result.anomalies.every(i => i.anomaly === 'Tap in più?'));
  near(result.stats.mean, 121.5);
});

test('explicit gaps create independent groups and never affect tempo or count as beats', () => {
  const first = constant(120, 20);
  const second = constant(90, 18, 100).map((b, i) => ({...b, id: 'second-' + i, breakBefore: i === 0}));
  const result = analyze([...first, ...second]);
  assert.equal(result.intervals.length, 38);
  assert.equal(result.sections.length, 2);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.intervals.filter(i => i.breakBefore).length, 2);
  assert.ok(result.intervals.every(i => i.end - i.start < 1));
  near(result.stats.mean, 38 * 60 / 22);
  near(result.stats.start, 120);
  near(result.stats.end, 90);
  near(result.sections[1].start, 100);
});

test('short changes and isolated pauses do not become sustained tempo sections', () => {
  const result = analyze(beatsFromPeriods([...Array(30).fill(.5), ...Array(4).fill(1), ...Array(40).fill(.5)]));
  assert.equal(result.sections.length, 1);
  const pause = analyze(beatsFromPeriods([...Array(30).fill(.5), 9, ...Array(30).fill(.5)]));
  assert.equal(pause.sections.length, 1);
  assert.equal(pause.anomalies.length, 0);
  assert.equal(pause.events.length, 1);
  assert.equal(pause.events[0].label, 'Fermata o tap mancanti?');
});

test('input is sanitized, sorted, deduplicated and never mutated; duplicate breaks survive', () => {
  const original = [{id: 'b', time: 1}, {id: 'a', time: 0}, {id: 'dup', time: 1, breakBefore: true},
    {id: 'c', time: 1.5}, {time: -1}, {time: NaN}, {time: Infinity}, {time: '2'}, null];
  const result = normalizeBeats(original);
  assert.deepEqual(result, [{id: 'a', time: 0, breakBefore: false, fermataBefore: false}, {id: 'b', time: 1, breakBefore: true, fermataBefore: false},
    {id: 'c', time: 1.5, breakBefore: false, fermataBefore: false}]);
  assert.equal(original[0].breakBefore, undefined);
  assert.equal(original.length, 9);
  const analyzed = analyze(original);
  assert.equal(analyzed.intervals.length, 1);
  near(analyzed.stats.mean, 120);
});

test('empty, single-beat and two-beat performances return usable stable output', () => {
  for (const input of [null, {}, [], [{time: 0}], [{time: 0}, {time: 0}]]) {
    const result = analyze(input);
    assert.deepEqual(result.stats, {mean: null, start: null, end: null, min: null, max: null});
    assert.equal(result.sections.length, 0);
  }
  const result = analyze([{id: 'a', time: 3}, {id: 'b', time: 4.5}],
    {beatUnit: -1, sectionThreshold: NaN, minSectionSeconds: Infinity, smoothing: null});
  near(result.stats.mean, 40);
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].count, 1);
  assert.equal(result.anomalies.length, 0);
});

test('increasing sensitivity detects a modest sustained change while a high threshold ignores it', () => {
  const beats = beatsFromPeriods([...Array(50).fill(.6), ...Array(60).fill(60 / 110)]);
  assert.equal(analyze(beats, {sectionThreshold: .06}).sections.length, 2);
  assert.equal(analyze(beats, {sectionThreshold: .15}).sections.length, 1);
});

test('sections exactly at the duration minimum survive floating-point timestamp error', () => {
  // The sum of twelve 2/3-second intervals is represented just below 8.
  const result = analyze(beatsFromPeriods([...Array(16).fill(.5), ...Array(12).fill(2 / 3)]));
  assert.equal(result.sections.length, 2);
  near(result.sections[0].end, 8);
  near(result.sections[1].bpm, 90);
});

test('doubling or halving a sustained tempo is not mistaken for missing or extra taps', () => {
  for (const periods of [
    [...Array(40).fill(1), ...Array(80).fill(.5)],
    [...Array(80).fill(.5), ...Array(40).fill(1)]
  ]) {
    const result = analyze(beatsFromPeriods(periods));
    assert.equal(result.sections.length, 2);
    assert.equal(result.anomalies.length, 0);
    near(result.sections[0].end, 40);
  }
});

test('smooth accelerando and rallentando become expressive spans without warnings or section explosion', () => {
  for (const [from, to, type] of [[70, 140, 'accelerando'], [140, 70, 'rallentando']]) {
    const periods = Array.from({length: 90}, (_, i) => 60 / (from + (to - from) * i / 89));
    const result = analyze(beatsFromPeriods(periods));
    assert.equal(result.anomalies.length, 0);
    assert.equal(result.sections.length, 1);
    const events = result.events.filter(event => event.type === type);
    assert.equal(events.length, 1);
    assert.equal(events[0].confidence, 'detected');
    assert.ok(events[0].end - events[0].start > 30);
    assert.ok(result.intervals.filter(interval => interval.expressive === type).length > 75);
    near(result.stats.mean, 90 * 60 / periods.reduce((sum, value) => sum + value, 0));
  }
});

test('a manual fermata remains in the real-time mean but never contaminates trend or warnings', () => {
  const beats = beatsFromPeriods([...Array(20).fill(.5), 4, ...Array(20).fill(.5)]);
  beats[21].fermataBefore = true;
  const result = analyze(beats);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.sections.length, 1);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {type: 'fermata', label: 'Fermata', start: 10, end: 14,
    beatId: 'b21', confidence: 'manual'});
  const held = result.intervals[20];
  assert.equal(held.expressive, 'fermata');
  near(held.bpm, 15);
  near(held.smoothed, 120);
  near(result.stats.mean, 41 * 60 / 24);
  near(result.stats.start, 120);
  near(result.stats.end, 120);
  assert.equal(normalizeBeats(beats)[21].fermataBefore, true);
});

test('a manual final hold does not collapse final tempo; a hold-only excerpt has no trend estimate', () => {
  const beats = beatsFromPeriods([...Array(12).fill(.5), 6]);
  beats.at(-1).fermataBefore = true;
  const result = analyze(beats);
  near(result.stats.end, 120);
  assert.equal(result.anomalies.length, 0);
  const onlyHold = analyze([{id: 'a', time: 0}, {id: 'b', time: 6, fermataBefore: true}]);
  assert.equal(onlyHold.stats.start, null);
  assert.equal(onlyHold.stats.end, null);
  assert.equal(onlyHold.intervals[0].smoothed, null);
  near(onlyHold.stats.mean, 10);
});

test('short extra tap remains a warning even next to a manually marked hold', () => {
  const beats = beatsFromPeriods([...Array(20).fill(.5), 3, ...Array(30).fill(.5)]);
  beats[21].fermataBefore = true;
  beats.push({id: 'extra', time: 18.15});
  const result = analyze(beats);
  assert.equal(result.anomalies.length, 2);
  assert.ok(result.anomalies.every(interval => interval.anomaly === 'Tap in più?'));
  assert.equal(result.events.filter(event => event.type === 'fermata').length, 1);
});

test('expressive trend recognition tolerates modest tapping jitter', () => {
  const periods = Array.from({length: 90}, (_, i) =>
    60 / (80 + 60 * i / 89) * (1 + .02 * Math.sin(i * 2.3)));
  const result = analyze(beatsFromPeriods(periods));
  assert.equal(result.sections.length, 1);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.events.filter(event => event.type === 'accelerando').length, 1);
});

test('stable plateaus separated by a gradual ramp become distinct sections after the ramp', () => {
  for (const [before, after, type] of [[96, 126, 'accelerando'], [126, 84, 'rallentando']]) {
    const firstCount = Math.ceil(15 * before / 60), lastCount = Math.ceil(15 * after / 60);
    const ramp = Array.from({length: 12}, (_, i) => 60 / (before + (after - before) * i / 11));
    const periods = [...Array(firstCount).fill(60 / before), ...ramp, ...Array(lastCount).fill(60 / after)];
    const result = analyze(beatsFromPeriods(periods));
    assert.equal(result.sections.length, 2);
    assert.equal(result.anomalies.length, 0);
    const event = result.events.find(event => event.type === type);
    assert.ok(event);
    near(result.sections[1].start, event.end);
    near(result.sections[1].bpm, after);
    // The first section includes the complete transition, using real time.
    near(result.sections[0].bpm, result.sections[0].count * 60 /
      (result.sections[0].end - result.sections[0].start));
  }
});

test('two gradual transitions retain three stable sections despite small rubato and a later fermata', () => {
  const beats = [];
  let time = 1, index = 0, held = false, previousWasHold = false;
  while (time < 59) {
    beats.push({id: 'b' + index, time: Math.round(time * 1000) / 1000, fermataBefore: previousWasHold});
    previousWasHold = false;
    const tempo = time < 16 ? 96 : time < 22 ? 96 + (time - 16) * 5 :
      time < 34 ? 126 : time < 40 ? 126 - (time - 34) * 7 : 84;
    let interval = 60 / tempo * (1 + Math.sin(index * .52) * .018);
    if (time > 47 && !held) { interval += 2.3; held = true; previousWasHold = true; }
    time += interval; index++;
  }
  const result = analyze(beats);
  assert.equal(result.sections.length, 3);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.events.filter(event => event.type === 'fermata').length, 1);
  const ramps = result.events.filter(event => event.confidence === 'detected');
  assert.equal(ramps.length, 2);
  near(result.sections[1].start, ramps[0].end);
  near(result.sections[2].start, ramps[1].end);
});

test('missing coverage at the same pulse does not invent a section; means still exclude the gap',()=>{
 const beats=[...constant(120,20),...constant(120,20,100).map((b,i)=>({...b,id:'right-'+i,breakBefore:i===0}))];
 const result=analyze(beats);assert.equal(result.sections.length,1);assert.equal(result.intervals.length,40);
 near(result.stats.mean,120);near(result.sections[0].bpm,120);assert.equal(result.sections[0].end,110);
 assert.equal(result.intervals.filter(p=>p.breakBefore).length,2,'the missing interval is still absent from the curve');
});
test('a short isolated run cannot force a tempo section at the next tracking restart',()=>{
 const beats=[{id:'a',time:0},{id:'b',time:.6},...constant(100,40,2).map((b,i)=>({...b,id:'c'+i,breakBefore:i===0}))];
 const result=analyze(beats);assert.equal(result.sections.length,1);near(result.sections[0].bpm,100);
});
test('manual divisions and merges preserve every measured interval and exclude gaps at any beat unit',()=>{
 const beats=[...constant(120,20),...constant(90,18,100).map((b,i)=>({...b,id:'r'+i,breakBefore:i===0}))];
 const automatic=analyze(beats,{beatUnit:.5}),merged=analyze(beats,{beatUnit:.5},[]),split=analyze(beats,{beatUnit:.5},[5,100]);
 assert.equal(automatic.sections.length,2);assert.equal(merged.sections.length,1);assert.equal(split.sections.length,3);
 assert.deepEqual(split.stats,automatic.stats);assert.deepEqual(merged.intervals,automatic.intervals);
 near(merged.sections[0].bpm,38*30/22);assert.equal(split.sections.reduce((n,s)=>n+s.count,0),38);
 near(split.sections[0].bpm,60);near(split.sections[2].bpm,45);
});
test('manual section boundaries snap to existing starting beats without creating zero-length sections',()=>{
 const result=analyze(constant(120,20),{},[5.2,5.21,0,-2,10,Infinity]);
 assert.equal(result.sections.length,2);assert.equal(result.sections[1].start,5);assert.equal(result.sections.reduce((n,s)=>n+s.count,0),20);
});

test('manual expression overrides are authoritative, can suppress detection and do not change measured BPM',()=>{
 const beats=Array.from({length:40},(_,i)=>({id:String(i),time:i*.5}));
 beats[10].expressionBefore='fermata';for(let i=20;i<=25;i++)beats[i].expressionBefore='accelerando';
 let result=analyze(beats);assert.equal(result.stats.mean,120);
 assert.equal(result.events.find(e=>e.type==='fermata').confidence,'manual');
 const ramp=result.events.find(e=>e.type==='accelerando');assert.equal(ramp.start,9.5);assert.equal(ramp.end,12.5);assert.equal(ramp.confidence,'manual');
 beats[22].expressionBefore='none';result=analyze(beats);assert.equal(result.events.filter(e=>e.type==='accelerando').length,2);
 assert.equal(result.intervals.find(p=>p.beatId==='22').expressive,null);
});

test('manual fermata runs split at gaps and suppressed possible fermatas stay suppressed',()=>{
 const beats=Array.from({length:30},(_,i)=>({id:String(i),time:i*.5+(i>=15?2:0)}));
 assert.ok(analyze(beats).events.some(e=>e.type==='possible-fermata'));
 beats[15].expressionBefore='none';assert.ok(!analyze(beats).events.some(e=>e.type==='possible-fermata'));
 for(let i=10;i<=20;i++)beats[i].expressionBefore='fermata';beats[15].breakBefore=true;
 const events=analyze(beats).events.filter(e=>e.type==='fermata');assert.equal(events.length,2);assert.ok(events[0].end<events[1].start);
});
