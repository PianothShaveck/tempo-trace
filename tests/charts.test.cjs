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
 const callbacks={onSeek:t=>calls.push(['seek',t]),onPan:view=>calls.push(['pan',view]),onSelectBeat:id=>calls.push(['select',id]),onSelectBar:number=>calls.push(['bar',number]),onMoveBeat:(...a)=>calls.push(['move',...a]),onInspectBeat:id=>calls.push(['inspect',id])};
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

test('advanced chart adds a separate bar strip with pickup, custom numbers and meter tooltips',()=>{
 const Musical=require('../assets/musical.js'),h=harness();
 h.state.timeline=Musical.build(h.state.beats,{enabled:true,firstBar:12,pickup:1,meters:[{bar:12,numerator:3,denominator:1}]},1);h.chart.render(h.state);
 const strip=h.svg.querySelector('g[data-bar-strip="true"]');assert.ok(strip);
 assert.ok(strip.querySelector('text[data-bar-label="11"]'));assert.ok(strip.querySelector('text[data-bar-label="12"]'));
 assert.match(strip.querySelector('text[data-bar-label="11"]').textContent,/11/);
 assert.match(strip.querySelector('text[data-bar-label="12"]').querySelector('title').textContent,/12.*3\/1/);
 assert.ok(h.svg.querySelector('line[data-bar-boundary="12"]'));
 const bpm=h.svg.querySelectorAll('text').find(node=>node.textContent==='BPM');assert.equal(bpm.getAttribute('y'),'66','BPM and section labels have their own lower strip');
 h.event('pointermove',250,18);const visible=h.svg.querySelector('g[aria-hidden="true"]');assert.equal(visible.getAttribute('visibility'),'visible');assert.match(visible.querySelectorAll('tspan').map(item=>item.textContent).join(' '),/12.*3\/1/);
 h.event('pointerdown',300,105);h.event('pointerup',300,105);assert.equal(h.calls[0][0],'seek','advanced grid retains ordinary background seeking');
});

test('clicking the advanced ruler selects the bar without seeking, editing beats or panning',()=>{
 const Musical=require('../assets/musical.js'),h=harness();
 h.state.timeline=Musical.build(h.state.beats,{enabled:true,firstBar:17,meters:[{bar:17,numerator:4,denominator:4}]});h.chart.render(h.state);
 const x=49+3/10*733;h.event('pointerdown',x,18);h.event('pointermove',x+40,120);h.event('pointerup',x+40,120);
 assert.deepEqual(h.calls,[['bar',18]]);
 h.calls.length=0;
 const target=h.svg.querySelector('g[data-bar-target="18"]');
 target.dispatch('pointerdown',{button:0});target.dispatch('click',{detail:1});
 assert.deepEqual(h.calls,[['bar',18]],'ordinary click does not duplicate pointer selection');
 target.dispatch('pointerdown',{button:2});assert.equal(h.calls.length,1,'right click leaves selection alone');
});

test('the bar ruler is keyboard accessible with one tab stop and supports offscreen navigation',()=>{
 const Musical=require('../assets/musical.js'),h=harness();
 h.state.timeline=Musical.build(h.state.beats,{enabled:true,firstBar:-1,pickup:1,meters:[{bar:-1,numerator:4,denominator:4}]});
 h.state.selectedBar=0;h.state.viewStart=2;h.state.viewEnd=6;h.chart.render(h.state);
 assert.equal(h.svg.getAttribute('role'),'group');
 const controls=h.svg.querySelectorAll('g[data-bar-target]');
 assert.equal(controls.filter(node=>node.getAttribute('tabindex')==='0').length,1);
 const target=h.svg.querySelector('g[data-bar-target="0"]');assert.equal(target.getAttribute('aria-pressed'),'true');
 assert.match(target.getAttribute('aria-label'),/0.*4\/4/);
 for(const key of ['ArrowLeft','ArrowRight','Home','End','Enter',' ']){
  const {event}=target.dispatch('keydown',{key});assert.equal(event.defaultPrevented,true,key+' is handled without triggering transport shortcuts');
 }
 assert.deepEqual(h.calls,[['bar',-1],['bar',1],['bar',-2],['bar',3],['bar',0],['bar',0]]);
 target.dispatch('click',{detail:0});assert.deepEqual(h.calls.at(-1),['bar',0],'screen reader activation works');
 const {event}=target.dispatch('keydown',{key:'Tab'});assert.equal(event.defaultPrevented,false,'Tab can leave the ruler');
});

test('every meter change retains an accent marker at dense zoom and selected numbers remain visible',()=>{
 const Musical=require('../assets/musical.js'),h=harness();
 h.state.beats=Array.from({length:1001},(_,i)=>({id:String(i),time:i*.5}));h.state.duration=500;h.state.viewEnd=500;
 h.state.analysis=Analysis.analyze(h.state.beats);
 h.state.timeline=Musical.build(h.state.beats,{enabled:true,firstBar:100,meters:[{bar:100,numerator:4,denominator:4},{bar:101,numerator:3,denominator:1},{bar:102,numerator:11,denominator:8},{bar:104,numerator:5,denominator:4}]});
 h.state.selectedBar=102;h.chart.render(h.state);
 assert.equal(h.svg.querySelectorAll('g[data-meter-marker]').length,4);
 for(const number of [100,101,102,104]){
  const line=h.svg.querySelector(`line[data-meter-change="${number}"]`);assert.ok(line,'meter '+number+' is never removed by line thinning');
  assert.equal(line.getAttribute('stroke-opacity'),'0.6');
 }
 assert.ok(h.svg.querySelector('text[data-bar-label="102"]'));
 assert.ok(h.svg.querySelector('rect[data-selected-bar="102"]'));
 assert.match(h.svg.querySelector('g[data-meter-marker="102"]').querySelector('title').textContent,/11\/8/);
 assert.equal(h.svg.style.height,'468px','the larger ruler does not reduce the plot height');
 h.state.viewStart=8;h.state.viewEnd=15;h.chart.render(h.state);
 assert.ok(h.svg.querySelector('text[data-meter-label="102"]'));
});

test('a dense ruler stays lightweight while all bars remain reachable by pointer and keyboard',()=>{
 const Musical=require('../assets/musical.js'),h=harness();
 h.state.beats=Array.from({length:10001},(_,i)=>({id:String(i),time:i*.5}));h.state.duration=5000;h.state.viewEnd=5000;
 h.state.analysis=Analysis.analyze(h.state.beats);h.state.timeline=Musical.build(h.state.beats,{enabled:true,meters:[{bar:1,numerator:1,denominator:4}]});
 h.state.selectedBar=5000;h.chart.render(h.state);
 assert.ok(h.svg.querySelectorAll('g[data-bar-target]').length<=2,'dense bars share hit testing, rather than adding thousands of DOM controls');
 const bar=h.state.timeline.bars[6789],x=49+(bar.start+.1)/5000*733;
 h.event('pointerdown',x,18);h.event('pointerup',x,18);assert.deepEqual(h.calls,[['bar',6790]]);
 h.svg.querySelector('g[data-bar-target="5000"]').dispatch('keydown',{key:'ArrowRight'});assert.deepEqual(h.calls.at(-1),['bar',5001]);
 h.state.viewStart=2500.1;h.state.viewEnd=2503;h.chart.render(h.state);
 assert.equal(h.svg.querySelector('text[data-meter-continuation]').textContent,'1/4','the current meter remains explicit when its change is outside the view');
});

test('bar labels and boundaries are thinned at wide zoom and restored when zooming in',()=>{
 const Musical=require('../assets/musical.js'),h=harness();
 h.state.beats=Array.from({length:1001},(_,i)=>({id:String(i),time:i*.5}));h.state.duration=500;h.state.viewEnd=500;
 h.state.analysis=Analysis.analyze(h.state.beats);h.state.timeline=Musical.build(h.state.beats,{enabled:true,firstBar:100,meters:[{bar:100,numerator:4,denominator:4}]});h.chart.render(h.state);
 const wideLabels=h.svg.querySelectorAll('text[data-bar-label]'),wideLines=h.svg.querySelectorAll('line[data-bar-boundary]');
 assert.ok(wideLabels.length>=5&&wideLabels.length<=20);assert.ok(wideLines.length<=34);
 for(let i=1;i<wideLabels.length;i++)assert.ok(Number(wideLabels[i].getAttribute('x'))-Number(wideLabels[i-1].getAttribute('x'))>=40);
 h.state.viewStart=20;h.state.viewEnd=30;h.chart.render(h.state);
 assert.equal(h.svg.querySelectorAll('text[data-bar-label]').length,5);
 assert.ok(h.svg.querySelector('text[data-bar-label="110"]'));assert.ok(h.svg.querySelector('text[data-bar-label="114"]'));
});

test('advanced barlines do not invent positions across gaps and simple mode remains unchanged',()=>{
 const Musical=require('../assets/musical.js'),h=harness();
 assert.ok(!h.svg.querySelector('g[data-bar-strip]'));
 const simple=h.svg.querySelectorAll('text').find(node=>node.textContent==='BPM');assert.equal(simple.getAttribute('y'),'18');
 h.state.beats=[0,.5,1,10,10.5,11].map((time,i)=>({id:String(i),time,breakBefore:i===3}));h.state.duration=11;h.state.viewEnd=11;
 h.state.analysis=Analysis.analyze(h.state.beats);h.state.timeline=Musical.build(h.state.beats,{enabled:true,firstBar:1,meters:[{bar:1,numerator:1,denominator:8}]});h.chart.render(h.state);
 assert.equal(h.state.timeline.bars.find(bar=>bar.number===6).start,null);
 assert.ok(!h.svg.querySelector('line[data-bar-boundary="6"]'));assert.ok(!h.svg.querySelector('text[data-bar-label="6"]'));
 assert.ok(h.svg.querySelector('rect[data-anchor-beat="3"]'),'resume markers survive the extra bar strip');
 const wave=harness(true);wave.state.timeline=h.state.timeline;wave.chart.render(wave.state);assert.ok(!wave.svg.querySelector('g[data-bar-strip]'));
});

test('tempo-only MIDI anchors stay editable on the curve but never appear in the audible beat lane',()=>{
 const h=harness();h.state.beats[10].tempoAnchor=true;h.chart.render(h.state);
 const lane=h.svg.querySelector('g[data-beat-lane="true"]'),marks=lane.querySelectorAll('path').map(path=>path.getAttribute('d')).join('');
 assert.equal((marks.match(/M/g)||[]).length,20);
 const x=49+5/10*733;h.event('pointerdown',x,370);h.event('pointerup',x,370);
 assert.deepEqual(h.calls,[['seek',5]],'tempo-only anchor is not a beat-lane editing target');h.calls.length=0;
 const scale=h.chart.getScale(),y=34+(scale.max-120)/(scale.max-scale.min)*(420-34-90);
 h.event('pointermove',x,y);const tooltip=h.svg.querySelector('g[aria-hidden="true"]');
 assert.match(tooltip.querySelectorAll('tspan').map(item=>item.textContent).join(' '),/Tempo change/);
 h.event('pointerdown',x,y);h.event('pointerup',x,y);assert.deepEqual(h.calls,[['select','10']]);
});
