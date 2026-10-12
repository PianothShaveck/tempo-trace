'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Report=require('../assets/bar-report.js'),Musical=require('../assets/musical.js'),Analysis=require('../assets/analysis.js');
function project(periods,advanced={enabled:true,firstBar:1,pickup:0,meters:[{bar:1,numerator:4,denominator:4}]}){
 let time=0;const beats=[{id:'0',time}];for(const period of periods){time+=period;beats.push({id:String(beats.length),time});}
 return {title:'Piano',beats,duration:time,beatUnit:1,advanced,analysis:Analysis.analyze(beats),timeline:Musical.build(beats,advanced,1)};
}
const barGroup=(svg,number)=>{const start=svg.indexOf('data-bar="'+number+'"');assert.ok(start>=0,'bar '+number+' exists');const end=svg.indexOf('<g data-bar=',start);return svg.slice(start,end<0?svg.length:end);};

test('bar report lays every bar over multiple rows with custom numbering, pickup and arbitrary meters',()=>{
 const advanced={enabled:true,firstBar:-4,pickup:1.5,meters:[{bar:-4,numerator:3,denominator:1},{bar:-2,numerator:11,denominator:8}]};
 const p=project(Array(80).fill(.5),advanced),report=Report.create(p,{barsPerRow:3});
 assert.equal((report.svg.match(/<g data-bar=/g)||[]).length,p.timeline.bars.length);
 assert.ok(report.svg.includes('data-row="4"'));assert.match(report.svg,/>Pickup · -5<\/text>/);
 assert.match(report.svg,/>3\/1<\/text>/);assert.match(report.svg,/>11\/8<\/text>/);
 assert.equal(report.width,1440);assert.ok(report.height>1200);
 assert.match(barGroup(report.svg,-4),/data-start-quarter="1.5" data-end-quarter="13.5"/);
 assert.match(barGroup(report.svg,-2),/data-start-quarter="25.5" data-end-quarter="31"/);
 assert.match(barGroup(report.svg,-4),/>120 BPM<\/text>/);
 assert.ok(!/NaN|Infinity|undefined/.test(report.svg));
});

test('beat dots default to hidden and opt-in markers include initial and final anchors once',()=>{
 const p=project(Array(16).fill(.5));
 const plain=Report.create(p).svg,detail=Report.create(p,{showBeats:true}).svg;
 assert.ok(!plain.includes('<circle'));assert.ok(plain.includes('data-bar-average="true"'));
 assert.equal((detail.match(/data-beat="true"/g)||[]).length,p.beats.length);
 assert.match(plain,/>BASIC TEMPO<\/text>/);assert.match(plain,/>AVERAGE<\/text>/);
 assert.match(detail,/>Beats<\/text>/);
});

test('excerpt preserves global bar numbers and interpolates boundary averages',()=>{
 const p=project([.5,.5,1,1,...Array(28).fill(.5)]);
 const excerpt=Report.create(p,{start:3.25,end:6.75,barsPerRow:4}).svg;
 assert.ok(!excerpt.includes('data-bar="1"'));assert.ok(excerpt.includes('data-bar="2"'));assert.ok(excerpt.includes('data-bar="3"'));
 assert.ok(!excerpt.includes('data-bar="4"'));assert.match(excerpt,/>Partial<\/text>/);
 assert.match(barGroup(excerpt,2),/>120 BPM<\/text>/);
 assert.ok(!/NaN|Infinity/.test(excerpt));
});

test('bars inside gaps stay numbered without fabricated means or connecting lines',()=>{
 const advanced={enabled:true,firstBar:1,pickup:0,meters:[{bar:1,numerator:1,denominator:8}]};
 const beats=[0,.5,1,10,10.5,11].map((time,i)=>({id:String(i),time,breakBefore:i===3}));
 const p={beats,duration:11,advanced,analysis:Analysis.analyze(beats),timeline:Musical.build(beats,advanced,1)};
 const svg=Report.create(p,{showBeats:true}).svg;
 assert.equal((svg.match(/<g data-bar=/g)||[]).length,10);
 for(const number of [5,6]){const group=barGroup(svg,number);assert.ok(!group.includes('data-expression="trend"'));assert.ok(!group.includes('data-bar-average="true"'));assert.ok(!group.includes('>0 BPM<'));
  assert.match(group,/>—<\/text>/);
 }
 assert.equal((svg.match(/data-beat="true"/g)||[]).length,beats.length);
 const excerpt=Report.create(p,{start:5,end:11}).svg;
 assert.ok(!excerpt.includes('data-bar="6"'));assert.ok(excerpt.includes('data-bar="7"'));
});

test('bar curves color expressive segments and show fermatas without beat markers',()=>{
 const p=project(Array(32).fill(.5));
 p.analysis.intervals[2].expressive='accelerando';p.analysis.intervals[8].expressive='rallentando';
 p.analysis.intervals[15].expressive='fermata';p.analysis.intervals[15].smoothed=null;
 const svg=Report.create(p).svg;
 for(const name of ['accelerando','rallentando','fermata'])assert.ok(svg.includes('data-expression="'+name+'"'));
 for(const color of ['#b75b12','#515fbd','#9467a4'])assert.ok(svg.includes(color));
 assert.ok(!svg.includes('data-beat="true"'));assert.match(svg,/>Fermata<\/text>/);
});

test('Italian labels, missing estimates, empty timelines and escaped titles remain valid',()=>{
 const p=project(Array(8).fill(.5),{enabled:true,firstBar:0,pickup:1,meters:[{bar:0,numerator:7,denominator:8}]});
 p.title='Piano <script>"&';p.analysis.stats.perceived={status:'variable',bpm:null};
 const svg=Report.create(p,{language:'it'}).svg;
 assert.match(svg,/>TEMPO DI BASE<\/text>/);assert.match(svg,/>Variabile<\/text>/);assert.match(svg,/>Levare · -1<\/text>/);
 assert.ok(svg.includes('&lt;script&gt;&quot;&amp;'));assert.ok(!svg.includes('<script>'));
 const empty=Report.create({beats:[],advanced:p.advanced},{language:'it'}).svg;
 assert.match(empty,/>Nessuna battuta misurata<\/text>/);assert.ok(!/NaN|Infinity/.test(empty));
});

test('partial bar mean uses measured quarter coverage, never extrapolating to its nominal end',()=>{
 const p=project([1,1,2],{enabled:true,firstBar:20,pickup:0,meters:[{bar:20,numerator:4,denominator:4}]});
 const svg=Report.create(p).svg;
 assert.match(svg,/>45 BPM<\/text>/);assert.match(svg,/>Partial<\/text>/);
 const clipped=Report.create(p,{start:2,end:3}).svg;
 assert.match(clipped,/>30 BPM<\/text>/);assert.ok(!clipped.includes('>45 BPM</text>'));
});

test('off-grid MIDI tempo anchors shape the curve without appearing as optional beat dots',()=>{
 const p=project([.5,.25,.25,.5,.5]);
 p.beats.forEach(beat=>beat.quarter=beat.time*2);p.beats[2].tempoAnchor=true;
 p.timeline=Musical.build(p.beats,p.advanced,1);p.analysis=Analysis.analyze(p.beats);
 const svg=Report.create(p,{showBeats:true}).svg;
 assert.equal((svg.match(/data-beat="true"/g)||[]).length,p.beats.length-1);
 assert.ok(svg.includes('data-expression="trend"'));
 const paths=[...svg.matchAll(/data-expression="trend" d="([^"]+)"/g)].map(match=>match[1]).join('');
 assert.equal((paths.match(/M/g)||[]).length,p.analysis.intervals.length,'tempo-only anchors are retained in the continuous curve');
 p.beats[0].tempoAnchor=true;
 assert.equal((Report.create(p,{showBeats:true}).svg.match(/data-beat="true"/g)||[]).length,p.beats.length-2,'initial tempo-only anchor is silent too');
});
