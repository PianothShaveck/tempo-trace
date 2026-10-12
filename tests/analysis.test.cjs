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
    assert.deepEqual(result.stats, {mean: null, start: null, end: null, min: null, max: null,
      perceived: {bpm:null,status:'insufficient',support:0}});
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

test('recurring base tempo stays at 66 through rubato, rallentandi and held notes while the exact mean falls',()=>{
 const periods=[...Array(30).fill(60/66),...Array.from({length:12},(_,i)=>60/(66-21*i/11)),6,
  ...Array(30).fill(60/66),...Array.from({length:40},(_,i)=>60/(66+4*Math.sin(i*Math.PI/10))),7,...Array(20).fill(60/66)];
 const beats=beatsFromPeriods(periods);beats[43].fermataBefore=true;beats[114].expressionBefore='fermata';
 const result=analyze(beats);
 assert.equal(result.stats.perceived.status,'ok');near(result.stats.perceived.bpm,66,.1);
 assert.ok(result.stats.mean>56&&result.stats.mean<60);
 near(result.stats.mean,periods.length*60/periods.reduce((sum,p)=>sum+p,0));
 assert.ok(result.stats.perceived.support>.8&&result.stats.perceived.support<=1);
 assert.ok(result.sections.every(s=>s.perceived.status==='ok'));
});

test('recurring pulse does not systematically favor faster excursions and centers symmetric rubato',()=>{
 for(const direction of [-1,1]){
  const periods=Array.from({length:100},(_,i)=>60/(66*Math.exp(i%20>=15?direction*.2:0)));
  const result=analyze(beatsFromPeriods(periods));
  assert.equal(result.stats.perceived.status,'ok');near(result.stats.perceived.bpm,66,.1);
  assert.ok(direction*(result.stats.mean-66)>0);
 }
 const cyclic=analyze(beatsFromPeriods(Array.from({length:160},(_,i)=>60/(66+5*Math.sin(i*Math.PI/10)))));
 assert.equal(cyclic.stats.perceived.status,'ok');near(cyclic.stats.perceived.bpm,66,.3);
});

test('distinct sustained tempi have no invented global base, even when sections are manually merged',()=>{
 const beats=beatsFromPeriods([...Array(40).fill(1),...Array(60).fill(2/3)]);
 const result=analyze(beats),merged=analyze(beats,{},[]),arbitrary=analyze(beats,{},[5,15,35,45]);
 assert.equal(result.stats.perceived.status,'variable');assert.equal(result.stats.perceived.bpm,null);
 near(result.sections[0].perceived.bpm,60);near(result.sections[1].perceived.bpm,90);
 assert.deepEqual(merged.stats.perceived,result.stats.perceived);
 assert.deepEqual(arbitrary.stats.perceived,result.stats.perceived);
 assert.equal(merged.sections[0].perceived.status,'variable');
 const minorPlateau=analyze(beatsFromPeriods([...Array(160).fill(1),...Array(12).fill(2/3)]));
 assert.equal(minorPlateau.stats.perceived.status,'variable','a short but sustained real second tempo is retained');
});

test('continuous expressive ramps and scattered multimodal tempi do not claim a fixed base',()=>{
 for(const [from,to] of [[70,140],[140,70],[60,65],[65,60]]){
  const result=analyze(beatsFromPeriods(Array.from({length:90},(_,i)=>60/(from+(to-from)*i/89))));
  assert.equal(result.stats.perceived.status,'variable');assert.equal(result.stats.perceived.bpm,null);
 }
 const mixed=analyze(beatsFromPeriods(Array.from({length:160},(_,i)=>60/(i%16<8?82+3*Math.sin(i):137+4*Math.cos(i)))));
 assert.equal(mixed.stats.perceived.status,'variable');assert.equal(mixed.stats.perceived.bpm,null);
});

test('base tempo is unavailable with too few usable beats or only held notes',()=>{
 for(const beats of [[],constant(66,1),constant(66,7),constant(66,40).map((b,i)=>({...b,fermataBefore:i>0}))]){
  const result=analyze(beats);
  assert.deepEqual(result.stats.perceived,{bpm:null,status:'insufficient',support:0});
 }
 const result=analyze(constant(66,8));assert.equal(result.stats.perceived.status,'ok');near(result.stats.perceived.bpm,66);
});

test('missing coverage and beat-unit changes never distort recurring-pulse evidence',()=>{
 const first=constant(66,20),second=constant(66,20,1000).map((b,i)=>({...b,id:'second-'+i,breakBefore:i===0}));
 const result=analyze([...first,...second]),contiguous=analyze(constant(66,40));
 near(result.stats.perceived.bpm,contiguous.stats.perceived.bpm);
 near(result.stats.perceived.support,contiguous.stats.perceived.support);
 const mixed=beatsFromPeriods([...Array(40).fill(1),...Array(50).fill(2/3)]);
 for(const unit of [.25,.5,2,4,16]){
  const scaled=analyze([...first,...second],{beatUnit:unit});
  assert.equal(scaled.stats.perceived.status,result.stats.perceived.status);near(scaled.stats.perceived.bpm,66*unit);
  near(scaled.stats.perceived.support,result.stats.perceived.support);
  assert.equal(analyze(mixed,{beatUnit:unit}).stats.perceived.status,'variable');
 }
});

test('isolated extra taps cannot hijack the base tempo and expressive overrides control its evidence',()=>{
 const beats=constant(66,80);beats.push({id:'extra',time:beats[40].time+.01});
 const result=analyze(beats);assert.ok(result.anomalies.length>0);
 assert.equal(result.stats.perceived.status,'ok');near(result.stats.perceived.bpm,66);
 const held=constant(66,40).map((b,i)=>({...b,expressionBefore:i>0?'fermata':undefined}));
 assert.equal(analyze(held).stats.perceived.status,'insufficient');
 const ramp=constant(66,40).map((b,i)=>({...b,expressionBefore:i>0?'accelerando':undefined}));
 assert.equal(analyze(ramp).stats.perceived.status,'variable');
 for(const beat of ramp)beat.expressionBefore='none';
 assert.equal(analyze(ramp).stats.perceived.status,'ok');
});

function positionedBeats(spans, start = 0, quarter = 0) {
  const beats = [{id:'position-0',time:start,quarter}];
  for (const [quarters, bpm] of spans) {
    const previous = beats.at(-1);
    beats.push({id:'position-'+beats.length,time:previous.time+60*quarters/bpm,quarter:previous.quarter+quarters});
  }
  return beats;
}

test('positioned MIDI tempo anchors between grid beats preserve exact BPM and covered-quarter means', () => {
  const spans = [...Array.from({length:20},()=>[1,66]), [.25,66], [.75,90], ...Array.from({length:20},()=>[1,90])];
  const beats = positionedBeats(spans, 5), snapshot=structuredClone(beats);
  const result = analyze(beats);
  const boundary=beats[21].time;
  assert.equal(result.intervals.length,42);
  near(result.intervals[20].quarters,.25);
  near(result.intervals[21].quarters,.75);
  near(result.intervals[20].bpm,66);
  near(result.intervals[21].bpm,90);
  near(result.stats.mean,41*60/(20.25*60/66+20.75*60/90));
  assert.equal(result.anomalies.length,0);
  assert.equal(result.events.length,0);
  assert.equal(result.sections.length,2);
  near(result.sections[0].end,boundary);
  near(result.sections[0].bpm,66);
  near(result.sections[1].bpm,90);
  near(result.sections[0].quarters,20.25);
  near(result.sections[1].quarters,20.75);
  assert.deepEqual(beats,snapshot);
  const manual=analyze(beats,{beatUnit:.5},[boundary]);
  near(manual.stats.mean,result.stats.mean);
  near(manual.sections[0].bpm,66);
  near(manual.sections[1].bpm,90);
});

test('mixed musical beat lengths do not invent anomalies, holds or tempo changes', () => {
  const spans = Array.from({length:64},(_,i)=>[[4,1,.5,1.5,4/11][i%5],78]);
  const result=analyze(positionedBeats(spans));
  assert.equal(result.anomalies.length,0);
  assert.equal(result.events.length,0);
  assert.equal(result.sections.length,1);
  for(const p of result.intervals)near(p.bpm,78);
  near(result.stats.mean,78);
  near(result.sections[0].bpm,78);
  near(result.stats.perceived.bpm,78);
});

test('positioned gaps omit both unmeasured quarters and elapsed time from merged means', () => {
  const first=positionedBeats(Array.from({length:20},()=>[.5,72]));
  const second=positionedBeats(Array.from({length:15},()=>[1.5,72]),100,80).map((b,i)=>({...b,id:'second-'+i,breakBefore:i===0}));
  for(const boundaries of [null,[],[100]]){
    const result=analyze([...first,...second],{},boundaries);
    near(result.stats.mean,72);
    near(result.sections.reduce((sum,s)=>sum+s.quarters,0),32.5);
    for(const section of result.sections)near(section.bpm,72);
    assert.equal(result.intervals.length,35);
    assert.equal(result.intervals.filter(p=>p.breakBefore).length,2);
    assert.ok(result.intervals.every(p=>p.end-p.start<2));
  }
  assert.equal(analyze([...first,...second]).sections.length,1);
});

test('any positive finite beat unit is supported, while invalid explicit spans use the chosen unit', () => {
  const plain=constant(60,10);
  near(analyze(plain,{beatUnit:32}).stats.mean,1920);
  near(analyze(plain,{beatUnit:1/31}).stats.mean,60/31);
  for(const beatUnit of [0,-1,Infinity,NaN])near(analyze(plain,{beatUnit}).stats.mean,60);
  const beats=[{time:0,quarter:1},{time:1,quarter:2},{time:2,quarter:2},{time:3},{time:4,quarter:4}];
  const result=analyze(beats,{beatUnit:.5});
  assert.deepEqual(result.intervals.map(p=>p.quarters),[1,.5,.5,.5]);
  near(result.stats.mean,37.5);
});

test('normalization retains finite musical positions without changing the original records', () => {
  const beats=[{time:0,quarter:-.5},{time:1,quarter:NaN},{time:2,quarter:Infinity},{time:3,quarter:'4'},{time:4},{time:4,quarter:7}];
  const snapshot=structuredClone(beats),normalized=normalizeBeats(beats);
  assert.equal(normalized[0].quarter,-.5);
  for(const index of [1,2,3])assert.equal(Object.hasOwn(normalized[index],'quarter'),false);
  assert.equal(normalized[4].quarter,7);
  assert.deepEqual(beats,snapshot);
});

test('densely inserted tempo anchors cannot outweigh a longer recurring pulse', () => {
  const spans=[...Array.from({length:20},()=>[1,66]),...Array.from({length:200},()=>[.005,100]),...Array.from({length:20},()=>[1,66])];
  const result=analyze(positionedBeats(spans),{},[]);
  near(result.stats.perceived.bpm,66);
  near(result.sections[0].perceived.bpm,66);
  near(result.stats.mean,41*60/(40*60/66+60/100));
  assert.equal(result.anomalies.length,0);
  assert.equal(result.events.length,0);
});
