'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createDOM}=require('./dom-stub.cjs'),Analysis=require('../assets/analysis.js');
function harness(wave=false){
 const document=createDOM('<body><svg id="chart"></svg></body>'),svg=document.getElementById('chart'),calls=[];
 const height=wave?88:420;svg.getBoundingClientRect=()=>({left:0,top:0,width:800,height});
 svg.getScreenCTM=()=>({inverse:()=>({a:1,b:0,c:0,d:1,e:0,f:0})});
 svg.setPointerCapture=()=>{};svg.hasPointerCapture=()=>false;
 const context=vm.createContext({document,requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
 vm.runInContext(fs.readFileSync(require.resolve('../assets/i18n.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(require.resolve('../assets/charts.js'),'utf8'),context);
 const callbacks={onSeek:t=>calls.push(['seek',t]),onPan:view=>calls.push(['pan',view]),onSelectBeat:id=>calls.push(['select',id]),onMoveBeat:(...a)=>calls.push(['move',...a]),onInspectBeat:id=>calls.push(['inspect',id])};
 const chart=(wave?context.TempoCharts.createWaveform:context.TempoCharts.createTempoChart)(svg,callbacks);
 const beats=Array.from({length:21},(_,i)=>({id:String(i),time:i*.5}));
 const state={duration:10,viewStart:0,viewEnd:10,beats,analysis:Analysis.analyze(beats),showRaw:true,showSmooth:true};chart.render(state);
 const event=(type,x,y)=>svg.dispatch(type,{button:0,pointerId:1,clientX:x,clientY:y});
 return {chart,svg,state,calls,event,scale:context.TempoCharts.tempoScale};
}
test('waveform clicks seek even exactly on a beat and pointer movement cannot edit it',()=>{
 const h=harness(true),x=14+5/10*(800-14-18);h.event('pointerdown',x,35);h.event('pointermove',x+20,35);h.event('pointerup',x+20,35);
 assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'seek');assert.equal(h.calls[0][1],5);
});
test('first beat remains available in its own lane regardless of the BPM scale',()=>{
 const h=harness();h.state.yRange={min:500,max:1000};h.chart.render(h.state);
 assert.ok(h.svg.querySelector('g[data-beat-lane="true"]'));
 h.event('pointerdown',49,370);h.event('pointerup',49,370);
 assert.deepEqual(h.calls,[['select','0']]);
});
test('first interaction selects; only a subsequent selected, sufficiently spaced beat can be dragged',()=>{
 const h=harness(),x=49+5/10*733;
 h.event('pointerdown',x,370);h.event('pointermove',x+10,370);h.event('pointerup',x+10,370);
 assert.deepEqual(h.calls,[['select','10']]);
 h.state.selectedId='10';h.chart.render(h.state);h.calls.length=0;
 h.event('pointerdown',x,370);h.event('pointermove',x+200,370);h.event('pointerup',x+200,370);
 assert.equal(h.calls[1][0],'move');assert.ok(h.calls[1][2]<=5.42,'pointer edits retain a gap from the next beat');
});
test('dense beat lanes zoom into the selected beat instead of allowing accidental edits',()=>{
 const h=harness();h.state.duration=1000;h.state.viewEnd=1000;h.chart.render(h.state);
 const x=49+5/1000*733;h.event('pointerdown',x,370);h.event('pointermove',x+100,370);h.event('pointerup',x+100,370);
 assert.deepEqual(h.calls,[['select','10'],['inspect','10']]);
});
test('automatic vertical scale resists isolated extreme values and explicit limits are honored',()=>{
 const h=harness(),values=Array.from({length:100},(_,i)=>({bpm:i===20?60000:100+i%5,smoothed:102}));
 const scale=h.scale(values);assert.ok(scale.max<200);assert.equal(scale.clipped,1);
 const explicit=h.scale(values,{min:0,max:61000});assert.equal(explicit.max,61000);assert.equal(explicit.clipped,0);
});

test('dragging empty plot space pans both axes without selecting, moving a beat or seeking',()=>{
 const h=harness();h.state.viewStart=2;h.state.viewEnd=8;h.state.yRange={min:80,max:160};h.chart.render(h.state);
 h.event('pointerdown',300,90);h.event('pointermove',400,140);h.event('pointerup',400,140);
 assert.equal(h.calls.length,1);const [action,view]=h.calls[0];assert.equal(action,'pan');assert.ok(view.start<2);assert.ok(view.min>80);assert.equal(view.end-view.start,6);assert.equal(view.max-view.min,80);assert.ok(view.vertical);
 assert.equal(h.svg.style.touchAction,'none');
});
test('clicking empty plot space still seeks, while vertical dragging only changes the BPM view',()=>{
 const h=harness();h.event('pointerdown',300,90);h.event('pointerup',300,90);assert.equal(h.calls[0][0],'seek');h.calls.length=0;
 h.event('pointerdown',300,90);h.event('pointermove',300,160);h.event('pointerup',300,160);assert.equal(h.calls[0][0],'pan');assert.equal(h.calls[0][1].start,0);
});
test('a restart beat has a selectable square on the curve using the following interval, without inventing a BPM',()=>{
 const h=harness();h.state.beats[10].breakBefore=true;h.state.analysis=Analysis.analyze(h.state.beats);h.chart.render(h.state);
 assert.equal(h.state.analysis.intervals.length,19);assert.ok(!h.state.analysis.intervals.some(p=>p.beatId==='10'));
 const marker=h.svg.querySelector('rect[data-anchor-beat="10"]');assert.ok(marker);const x=Number(marker.getAttribute('x'))+5,y=Number(marker.getAttribute('y'))+5;
 h.event('pointerdown',x,y);h.event('pointerup',x,y);assert.deepEqual(h.calls,[['select','10']]);
});

test('multiple beat selection is visible in the lane and never drags an individual beat',()=>{
 const h=harness();h.state.selectedId='10';h.state.selectedIds=['8','9','10'];h.chart.render(h.state);
 assert.equal(h.svg.querySelectorAll('rect[data-selected-beat]').length,3);
 const x=49+5/10*733;h.event('pointerdown',x,370);h.event('pointermove',x+150,370);h.event('pointerup',x+150,370);
 assert.ok(!h.calls.some(call=>call[0]==='move'));
});

test('modifier clicks forward selection intent and do not trigger drag or dense zoom',()=>{
 const document=createDOM('<body><svg id="chart"></svg></body>'),svg=document.getElementById('chart'),context=vm.createContext({document}),calls=[];
 vm.runInContext(fs.readFileSync(require.resolve('../assets/i18n.js'),'utf8'),context);vm.runInContext(fs.readFileSync(require.resolve('../assets/charts.js'),'utf8'),context);
 svg.getBoundingClientRect=()=>({left:0,top:0,width:800,height:420});svg.getScreenCTM=()=>({inverse:()=>({a:1,b:0,c:0,d:1,e:0,f:0})});svg.setPointerCapture=()=>{};
 const chart=context.TempoCharts.createTempoChart(svg,{onSelectBeat:(id,options)=>calls.push({id,...options}),onInspectBeat:()=>calls.push('zoom'),onMoveBeat:()=>calls.push('move')});
 const beats=Array.from({length:1000},(_,i)=>({id:String(i),time:i*.5}));chart.render({beats,analysis:Analysis.analyze(beats),duration:500,viewStart:0,viewEnd:500,selectedId:'10'});
 const x=49+5/500*733;
 svg.dispatch('pointerdown',{button:0,pointerId:1,clientX:x,clientY:370,shiftKey:true,metaKey:true});svg.dispatch('pointerup',{pointerId:1,clientX:x,clientY:370});
 assert.deepEqual(calls,[{id:'10',extend:true,toggle:true}]);
});
