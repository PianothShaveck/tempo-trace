'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createDOM}=require('./dom-stub.cjs'),Analysis=require('../assets/analysis.js');
function harness(wave=false){
 const document=createDOM('<body><svg id="chart"></svg></body>'),svg=document.getElementById('chart'),calls=[];
 const height=wave?88:420;svg.getBoundingClientRect=()=>({left:0,top:0,width:800,height});
 svg.getScreenCTM=()=>({inverse:()=>({a:1,b:0,c:0,d:1,e:0,f:0})});
 svg.setPointerCapture=()=>{};svg.hasPointerCapture=()=>false;
 const context=vm.createContext({document,requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
 vm.runInContext(fs.readFileSync(require.resolve('../assets/charts.js'),'utf8'),context);
 const callbacks={onSeek:t=>calls.push(['seek',t]),onSelectBeat:id=>calls.push(['select',id]),onMoveBeat:(...a)=>calls.push(['move',...a]),onInspectBeat:id=>calls.push(['inspect',id])};
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
