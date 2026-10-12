'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Midi=require('../assets/midi.js');
const b=(...values)=>values.flat(Infinity),u16=n=>[n>>8&255,n&255],u32=n=>[n>>>24,n>>16&255,n>>8&255,n&255];
function vlq(n){const a=[n&127];while((n>>>=7))a.unshift(n&127|128);return a;}
function chunk(name,data){return [...Buffer.from(name),...u32(data.length),...data];}
function file(tracks,ppq=480,format=tracks.length===1?0:1){return Uint8Array.from(b(chunk('MThd',b(u16(format),u16(tracks.length),u16(ppq))),tracks.map(t=>chunk('MTrk',t))));}
const end=delta=>b(vlq(delta||0),255,47,0),tempo=(delta,us)=>b(vlq(delta),255,81,3,us>>16&255,us>>8&255,us&255),note=(delta,status,n,v)=>b(vlq(delta),status,n,v);
const map=(bpms=[60,120,90])=>{let quarter=0,time=0;const anchors=[{quarter,time}];for(const bpm of bpms){quarter++;time+=60/bpm;anchors.push({quarter,time});}return {anchors,meterEvents:[{quarter:0,numerator:11,denominator:8}],firstBar:17,pickup:0};};
function close(a,b,tolerance=1e-5){assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);}
const musicalEvents=parsed=>parsed.tracks.map(t=>t.filter(e=>e.type!=='meta'||![47,81,88,127,6].includes(e.metaType)).map(({tick,type,status,data,metaType})=>({tick,type,status,data,metaType})));

test('format 0 running status, zero-velocity note off and defaults decode correctly',()=>{
 const p=Midi.parse(file([b(note(0,144,60,100),vlq(240),64,90,vlq(240),60,0,note(240,128,64,0),end(240))]));
 assert.equal(p.ppq,480);assert.equal(p.duration,1);assert.equal(p.tempoEvents[0].bpm,120);assert.equal(p.timeSignatures[0].numerator,4);assert.equal(p.timeSignatures[0].denominator,4);
 assert.deepEqual(p.notes.map(n=>[n.note,n.start,n.end,n.velocity]),[[60,0,.5,100],[64,.25,.75,90]]);
});
test('format 1 tempo map spans tracks and quarter/seconds inverses include off-grid changes',()=>{
 const p=Midi.parse(file([b(tempo(0,1000000),tempo(120,500000),end(360)),b(note(0,144,60,100),note(480,128,60,0),end())]));
 close(p.duration,.625);assert.equal(p.tempoEvents[1].quarter,.25);assert.equal(p.notes[0].end,.625);
 for(const q of [0,.1,.25,.5,1,10])close(Midi.secondsToQuarter(p,Midi.quarterToSeconds(p,q)),q);
 const beats=Midi.importBeats(p,1);assert.deepEqual(beats.map(b=>b.quarter),[0,.25,1]);assert.deepEqual(beats.map(b=>b.time),[0,.25,.625]);
});
test('pedal sustains released notes; all-notes-off obeys pedal and all-sound-off stops it',()=>{
 const cc=(d,c,v)=>note(d,176,c,v),p=Midi.parse(file([b(note(0,144,60,100),cc(0,64,127),note(480,128,60,0),cc(480,64,0),note(0,144,64,100),cc(0,64,127),cc(480,123,0),cc(480,120,0),end())]));
 assert.deepEqual(p.notes.map(n=>[n.note,n.start,n.end]),[[60,0,1],[64,1,2]]);
});
test('sustain channels and MIDI ports remain separate',()=>{
 const p=Midi.parse(file([b(0,255,33,1,0,note(0,144,60,100),note(0,176,64,127),note(480,128,60,0),note(480,176,64,0),end()),b(0,255,33,1,1,note(0,144,64,100),note(480,128,64,0),end(480))]));
 assert.equal(p.notes.find(n=>n.note===60).end,1);assert.equal(p.notes.find(n=>n.note===64).end,.5);
});
test('truncated chunks, malformed VLQs, malformed statuses and tempo zero are rejected',()=>{
 for(const input of [new Uint8Array(),file([b(128,128,128,128,0)]),file([b(0,60,100,end())]),file([b(tempo(0,0),end())]),file([b(note(0,144,200,90),end())]),file([b(0,255,1,9,65)])])assert.throws(()=>Midi.parse(input));
 const valid=file([end()]);assert.throws(()=>Midi.parse(valid.slice(0,-1)),/Truncated/);
});
test('format 2 independent patterns fail clearly instead of being merged',()=>{
 assert.throws(()=>Midi.parse(file([end()],480,2)),e=>e.code==='MIDI_FORMAT_2');
});
test('SMPTE uses absolute ticks and tempos still define musical quarter positions',()=>{
 const p=Midi.parse(file([b(tempo(0,1000000),note(0,144,60,90),tempo(1000,500000),note(1000,128,60,0),end())],0xe728));
 assert.equal(p.timing.type,'smpte');assert.equal(p.timing.ticksPerSecond,1000);assert.equal(p.duration,2);assert.equal(p.maxQuarter,3);assert.equal(p.notes[0].end,2);assert.equal(Midi.quarterToSeconds(p,2),1.5);
 assert.throws(()=>Midi.convert(p,map()),e=>e.code==='MIDI_SMPTE_CONVERSION');
 const drop=Midi.parse(file([end(30000)],0xe350));close(drop.duration,12.5125);
});
test('tempo-only export preserves every measured interval, meter, numbering and metadata',()=>{
 const m=map(),bytes=Midi.exportTempo(m),p=Midi.parse(bytes);assert.equal(p.notes.length,0);assert.equal(p.format,0);assert.equal(p.tempoEvents.length,3);assert.equal(p.timeSignatures[0].numerator,11);assert.equal(p.timeSignatures[0].denominator,8);assert.equal(p.notation.firstBar,17);
 for(const a of m.anchors)close(Midi.quarterToSeconds(p,a.quarter),a.time,2e-6);
});
test('export excludes media leading silence and respects quarter-note tap lengths',()=>{
 const p=Midi.parse(Midi.exportTempo({anchors:[{quarter:0,time:30},{quarter:3,time:32},{quarter:6,time:36}],meterEvents:[{quarter:0,numerator:3,denominator:1}],firstBar:0}));
 close(p.duration,6);close(p.tempoEvents[0].bpm,90,.0001);assert.equal(p.timeSignatures[0].denominator,1);assert.equal(p.notation.firstBar,0);
});
test('conversion preserves channel events, tracks, sysex and unrelated metadata exactly',()=>{
 const original=Midi.parse(file([b(tempo(0,500000),0,255,88,4,4,2,24,8,0,255,1,3,65,66,67,end(1440)),b(0,192,41,0,240,4,125,1,2,247,note(0,144,60,80),note(120,176,64,127),note(360,128,60,0),note(480,176,64,0),0,255,127,3,1,2,3,end(480))]));
 const converted=Midi.parse(Midi.convert(original,map()));assert.equal(converted.tracks.length,2);assert.equal(converted.ppq,original.ppq);assert.deepEqual(musicalEvents(converted),musicalEvents(original));
 assert.ok(converted.tracks[1].some(e=>e.metaType===127&&e.data.join(',')==='1,2,3'));close(converted.notes[0].end,1.5);close(original.notes[0].end,1);
});
test('conversion alignment retains prefix tempo, replaces later tempo and extends final tempo',()=>{
 const original=Midi.parse(file([b(tempo(0,500000),tempo(480,400000),tempo(480,250000),end(2400))]));
 const converted=Midi.parse(Midi.convert(original,map([60,60]),{offsetQuarter:2}));
 assert.deepEqual(converted.tempoEvents.map(e=>[e.quarter,e.bpm]),[[0,120],[1,150],[2,60],[3,60]]);close(Midi.quarterToSeconds(converted,2),.9);close(Midi.quarterToSeconds(converted,7),5.9);
});
test('unrepresentable meters retain exact custom data and return explicit compatibility warnings',()=>{
 const m=map();m.meterEvents=[{quarter:0,numerator:5,denominator:3},{quarter:2,numerator:300,denominator:8}];const bytes=Midi.exportTempo(m),p=Midi.parse(bytes);
 assert.equal(bytes.warnings.filter(w=>w.startsWith('Meter')).length,2);assert.deepEqual(p.timeSignatures.map(e=>[e.quarter,e.numerator,e.denominator]),[[0,5,3],[2,300,8]]);
});
test('gaps, duplicate anchor quarters, tempo encoding and PPQ collisions reject without silent changes',()=>{
 const m=map();m.anchors[2].breakBefore=true;assert.throws(()=>Midi.exportTempo(m),e=>e.code==='MIDI_GAPS');
 assert.throws(()=>Midi.exportTempo({anchors:[{quarter:0,time:0},{quarter:0,time:1}]}),e=>e.code==='MIDI_ANCHOR_ORDER');
 assert.throws(()=>Midi.exportTempo({anchors:[{quarter:0,time:0},{quarter:1,time:18}]}),e=>e.code==='MIDI_TEMPO_RANGE');
 assert.throws(()=>Midi.exportTempo({anchors:[{quarter:0,time:0},{quarter:.0001,time:1}],ppq:480}),e=>e.code==='MIDI_RESOLUTION');
});
test('large tracks serialize without variadic argument overflow',()=>{
 const bytes=file([end(1)]),p=Midi.parse(bytes);p.tracks[0]=Array.from({length:70000},(_,i)=>({tick:i,type:'channel',status:176,data:[11,i%128]}));p.endTick=69999;
 const result=Midi.parse(Midi.convert(p,map()));assert.equal(result.tracks[0].filter(e=>e.type==='channel').length,70000);
});
test('pickup creates a short standard first bar and restores the actual meter at the full downbeat',()=>{
 const m=map([120,120,120,120,120,120]);m.firstBar=42;m.pickup=1;m.meterEvents=[{quarter:0,numerator:4,denominator:4,bar:42},{quarter:5,numerator:3,denominator:1,bar:43}];
 const bytes=Midi.exportTempo(m),p=Midi.parse(bytes),standard=p.tracks[0].filter(e=>e.metaType===88);
 assert.deepEqual(standard.map(e=>[e.tick/p.ppq,...e.data.slice(0,2)]),[[0,1,2],[1,4,2],[5,3,0]]);
 assert.deepEqual(Midi.advancedFromMidi(p).advanced,{enabled:true,firstBar:42,pickup:1,meters:[{bar:42,numerator:4,denominator:4},{bar:43,numerator:3,denominator:1}]});
 assert.ok(bytes.warnings.some(w=>w.includes('numbering')));
});
test('ordinary MIDI meter changes derive exact bar numbers, including 3/1 and 11/8',()=>{
 const p=Midi.parse(file([b(0,255,88,4,3,0,24,8,vlq(12*480),255,88,4,11,3,24,8,end(11*240))]));
 assert.deepEqual(p.advanced.meters,[{bar:1,numerator:3,denominator:1},{bar:2,numerator:11,denominator:8}]);assert.equal(p.advanced.pickup,0);
});
test('mid-bar signatures remain in parsed data with an explicit warning instead of shifting on import',()=>{
 const p=Midi.parse(file([b(0,255,88,4,4,2,24,8,vlq(3*480),255,88,4,3,2,24,8,end(3*480))]));
 assert.equal(p.timeSignatures[1].quarter,3);assert.equal(p.advanced.meters.length,1);assert.ok(p.warnings.some(w=>w.includes('inside a bar')));
});
test('malformed extension metadata is ignored without corrupting valid standard signatures',()=>{
 const payload=Array.from(Buffer.from('TempoTrace:1:'+JSON.stringify({meterEvents:[null],offsetQuarter:-10}))),p=Midi.parse(file([b(0,255,127,vlq(payload.length),payload,end(480))]));
 assert.equal(p.notation,null);assert.equal(p.timeSignatures[0].numerator,4);assert.ok(p.warnings.some(w=>w.includes('Invalid Tempo Trace')));
});
test('export uses noncommercial manufacturer ID for its sequencer-specific extension',()=>{
 const p=Midi.parse(Midi.exportTempo(map()));assert.equal(p.tracks[0].find(e=>e.metaType===127).data[0],125);assert.equal(p.notation.firstBar,17);
});
test('off-grid tempo boundaries and terminal positions are silent anchors, regular beats remain audible',()=>{
 const p=Midi.parse(file([b(tempo(0,1000000),tempo(120,500000),tempo(360,750000),end(120))]));
 const beats=Midi.importBeats(p,1);
 assert.deepEqual(beats.map(b=>[b.quarter,!!b.tempoAnchor]),[[0,false],[.25,true],[1,false],[1.25,true]]);
 for(const beat of beats)close(beat.time,Midi.quarterToSeconds(p,beat.quarter));
 const reconstructed=Midi.parse(Midi.exportTempo({anchors:beats}));
 for(const q of [0,.1,.25,.5,1,1.1,1.25])close(Midi.quarterToSeconds(p,q),Midi.quarterToSeconds(reconstructed,q),2e-6);
});
test('optional MIDI beat limit is checked conservatively before allocating any grid',()=>{
 const p=Midi.parse(file([end(4800)]));assert.equal(Midi.importBeats(p,1,{maxBeats:13}).length,11);
 assert.throws(()=>Midi.importBeats(p,1,{maxBeats:12}),e=>e.code==='MIDI_BEAT_LIMIT');
 assert.throws(()=>Midi.importBeats({...p,maxQuarter:1e12},1,{maxBeats:50000}),e=>e.code==='MIDI_BEAT_LIMIT');
 assert.equal(Midi.importBeats(p,2).length,6);
});
test('coverage ending within a pickup does not emit its future downbeat or lengthen the export',()=>{
 const p=Midi.parse(Midi.exportTempo({anchors:[{quarter:0,time:5},{quarter:.5,time:5.25}],pickup:1,meterEvents:[{quarter:0,numerator:4,denominator:4}],firstBar:3}));
 close(p.duration,.25);assert.equal(p.endTick,p.ppq*.5);assert.equal(p.notation.pickup,1);
 assert.deepEqual(p.tracks[0].filter(e=>e.metaType===88).map(e=>[e.tick,...e.data.slice(0,2)]),[[0,1,2]]);
 assert.ok(p.tracks[0].every(e=>e.tick<=p.ppq*.5));
});
test('future meter config survives metadata but never extends coverage or changes the longer converted tail',()=>{
 const m=map([120,120]);m.firstBar=1;m.meterEvents=[{quarter:0,numerator:4,denominator:4},{quarter:12,numerator:11,denominator:8}];
 const exported=Midi.parse(Midi.exportTempo(m));close(exported.duration,1);assert.equal(exported.notation.meterEvents.length,2);assert.equal(exported.tracks[0].filter(e=>e.metaType===88).length,1);
 const original=Midi.parse(file([b(tempo(0,600000),0,255,88,4,3,2,24,8,end(20*480))]));
 const converted=Midi.parse(Midi.convert(original,m));close(converted.duration,10);assert.equal(converted.endTick,original.endTick);assert.deepEqual(converted.tracks[0].filter(e=>e.metaType===88).map(e=>[e.tick,...e.data.slice(0,2)]),[[0,4,2]]);assert.equal(converted.notation.meterEvents.length,2);
});
