'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const Audio=require('../assets/audio-export.js'),Report=require('../assets/report-export.js'),Analysis=require('../assets/analysis.js');
function decode(result){
 const v=new DataView(result.buffer),channels=v.getUint16(22,true),sr=v.getUint32(24,true),frames=v.getUint32(40,true)/(channels*2);
 assert.equal(Buffer.from(result.buffer,0,4).toString(),'RIFF');assert.equal(Buffer.from(result.buffer,8,4).toString(),'WAVE');
 assert.equal(v.getUint32(4,true),result.buffer.byteLength-8);assert.equal(v.getUint16(34,true),16);
 return {channels,sr,frames,sample:(frame,channel=0)=>v.getInt16(44+(frame*channels+channel)*2,true)/32768};
}
test('WAV click times preserve tempo changes, sustained notes and gaps, including at slower practice speed',()=>{
 const beats=[.2,.7,1.24,3.1],rate=.5,sr=44100;
 const wav=decode(Audio.renderWav({mode:'clicks',duration:4,beats:beats.map(time=>({time})),rate,sampleRate:sr}));
 assert.equal(wav.channels,1);assert.equal(wav.frames,8*sr);
 for(let i=0;i<wav.frames;i++){
  const inClick=beats.some(time=>i>=Math.round(time/rate*sr)&&i<Math.round(time/rate*sr)+Math.round(.035*sr));
  if(!inClick)assert.equal(wav.sample(i),0,'no invented clicks during the sustained interval');
 }
 for(const time of beats){let energy=0;for(let i=Math.round(time/rate*sr);i<Math.round((time/rate+.035)*sr);i++)energy+=wav.sample(i)**2;assert.ok(energy>1);}
});
test('stereo mix preserves both channels and original sample timing independently of playback speed',()=>{
 const sr=11025,channels=[330,550].map(hz=>Float32Array.from({length:sr},(_,i)=>.35*Math.sin(i*2*Math.PI*hz/sr)));
 const wav=decode(Audio.renderWav({mode:'mix',duration:1,sampleRate:sr,channels,rate:.5,musicVolume:1,clickVolume:0,beats:[{time:.2}]}));
 assert.equal(wav.channels,2);assert.equal(wav.frames,sr);
 for(let i=0;i<sr;i++)for(let channel=0;channel<2;channel++)assert.ok(Math.abs(wav.sample(i,channel)-channels[channel][i])<.00005);
});
test('export click is high pitched and a beat at the final sample retains its complete tail',()=>{
 const sr=44100,wav=decode(Audio.renderWav({mode:'clicks',duration:.5,beats:[{time:.5}],sampleRate:sr}));
 assert.ok(wav.frames>=Math.ceil(.535*sr));
 let crossings=0;for(let i=Math.ceil(.503*sr);i<Math.floor(.519*sr);i++)if(wav.sample(i-1)<0&&wav.sample(i)>=0)crossings++;
 assert.ok(Math.abs(crossings/.016-2600)<100);
});
test('automatic balancing attenuates loud music only around beats; normalization prevents clipping',()=>{
 const sr=11025,channels=[new Float32Array(sr).fill(.8)];
 const balanced=decode(Audio.renderWav({mode:'mix',sampleRate:sr,duration:1,channels,beats:[{time:.5}],musicVolume:1,clickVolume:1,autoBalance:true}));
 assert.ok(Math.abs(balanced.sample(Math.round(.2*sr))-.8)<.00005);
 assert.ok(balanced.sample(Math.round(.55*sr))<.5);
 assert.ok(balanced.sample(Math.round(.9*sr))>.79);
 const loud=Audio.renderWav({mode:'mix',sampleRate:sr,duration:1,channels:[new Float32Array(sr).fill(1)],beats:[{time:.5}],musicVolume:1,clickVolume:2});
 assert.ok(loud.normalization<1);const wav=decode(loud);let peak=0;for(let i=0;i<wav.frames;i++)peak=Math.max(peak,Math.abs(wav.sample(i)));assert.ok(peak<=.98005);
});
test('oversized and unavailable audio exports fail before rendering',()=>{
 assert.throws(()=>Audio.renderWav({mode:'mix',duration:2}),/originale/);
 assert.throws(()=>Audio.renderWav({mode:'clicks',duration:7200,rate:.25}),/troppo grande/);
});
test('serialized export worker runs without imports and transfers valid WAV',()=>{
 const messages=[],context=vm.createContext({Float32Array,ArrayBuffer,DataView,self:{postMessage:(data,transfer)=>messages.push({data,transfer})}});
 vm.runInContext(Audio.workerSource(),context);context.self.onmessage({data:{mode:'clicks',duration:.1,beats:[{time:.01}]}});
 const result=messages.at(-1);assert.ok(result.data.buffer);assert.equal(result.transfer[0],result.data.buffer);assert.equal(decode(result.data).sr,44100);
});
test('SVG report escapes filenames and includes calculated statistics, sections and separate beat lane',()=>{
 const beats=Array.from({length:61},(_,i)=>({id:String(i),time:i*.5})),analysis=Analysis.analyze(beats);
 const report=Report.create({title:'Piano <script>alert(1)</script> & "test"',duration:30,beats,analysis},{scale:{min:110,max:130}});
 assert.ok(report.svg.includes('&lt;script&gt;'));assert.ok(!report.svg.includes('<script>'));assert.ok(report.svg.includes('120 BPM'));assert.ok(report.svg.includes('SEZIONI'));assert.ok(report.svg.includes('>Beat</text>'));
 assert.ok(!/NaN|Infinity/.test(report.svg));assert.equal(report.width,1440);assert.ok(report.height>=856);
});
test('single-beat and narrow-range graphic exports remain valid with distinct fractional time labels',()=>{
 const report=Report.create({title:'One',duration:1,beats:[{time:.5}],analysis:Analysis.analyze([{time:.5}])},{start:.4,end:.9});
 assert.ok(!/NaN|Infinity/.test(report.svg));assert.ok(report.svg.includes('0:00.40'));assert.ok(report.svg.includes('0:00.90'));assert.ok(report.height>=856);
});
function clientHarness({deferDecode=false,imageFails=false}={}){
 const sr=44100,channelData=[new Float32Array(sr*4).fill(.25),new Float32Array(sr*4).fill(-.5)],workers=[],revoked=[];let decodeResolve;
 const buffer={sampleRate:sr,duration:4,length:sr*4,numberOfChannels:2,getChannelData:i=>channelData[i]};
 class OfflineAudioContext{decodeAudioData(){return deferDecode?new Promise(resolve=>decodeResolve=resolve):Promise.resolve(buffer);}}
 class Worker{constructor(url){this.url=url;workers.push(this);}postMessage(data,transfer){this.data=data;this.transfer=transfer;}terminate(){this.terminated=true;}}
 class Image{set src(value){imageFails?this.onerror():this.onload();}}
 const context=vm.createContext({window:{OfflineAudioContext},Worker,Image,Blob,DOMException,TempoAudioExport:Audio,
  URL:{createObjectURL:()=>`blob:${workers.length}`,revokeObjectURL:url=>revoked.push(url)},document:{createElement:()=>({getContext:()=>({drawImage(){}}),toBlob:callback=>callback(new Blob(['png'],{type:'image/png'}))})}});
 vm.runInContext(fs.readFileSync(require.resolve('../assets/export-client.js'),'utf8'),context);
 return {client:context.TempoExportClient,workers,revoked,buffer,resolveDecode:()=>decodeResolve(buffer)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('audio client crops full-quality stereo and aligns only beats inside the chosen excerpt',async()=>{
 const h=clientHarness(),file={size:100,arrayBuffer:async()=>new ArrayBuffer(10)};
 const promise=h.client.audio(file,{mode:'mix',duration:4,start:1,end:2,beats:[{time:.5},{time:1},{time:1.6},{time:2.2}]});await tick();
 const worker=h.workers[0];assert.equal(worker.data.sampleRate,44100);assert.equal(worker.data.duration,1);assert.equal(worker.data.channels.length,2);
 assert.equal(worker.data.channels[0].length,44100);assert.equal(worker.data.channels[0][0],.25);assert.equal(worker.data.channels[1][0],-.5);
 assert.deepEqual(Array.from(worker.data.beats,b=>Math.round(b.time*10)/10),[0,.6]);assert.equal(worker.transfer.length,2);
 worker.onmessage({data:{buffer:Audio.renderWav(worker.data).buffer}});const blob=await promise;assert.equal(blob.type,'audio/wav');assert.ok(worker.terminated);assert.equal(h.revoked.length,1);
});
test('cancel during decode prevents any late worker or download',async()=>{
 const h=clientHarness({deferDecode:true}),controller=new AbortController();
 const promise=h.client.audio({size:100,arrayBuffer:async()=>new ArrayBuffer(0)},{mode:'mix',duration:4,beats:[{time:1}]},null,controller.signal);
 await tick();controller.abort();await assert.rejects(promise,{name:'AbortError'});h.resolveDecode();await tick();assert.equal(h.workers.length,0);
});
test('click-only export needs no original audio and cancellation terminates its worker',async()=>{
 const h=clientHarness(),controller=new AbortController();
 const promise=h.client.audio(null,{mode:'clicks',duration:4,beats:[{time:1}]},null,controller.signal);
 await tick();assert.equal(h.workers.length,1);assert.equal(h.workers[0].data.channels.length,0);controller.abort();await assert.rejects(promise,{name:'AbortError'});assert.ok(h.workers[0].terminated);assert.equal(h.revoked.length,1);
});
test('PNG conversion releases SVG URL on both success and decode failure',async()=>{
 const h=clientHarness();assert.equal((await h.client.png('<svg/>',1440,856)).type,'image/png');assert.equal(h.revoked.length,1);
 const failed=clientHarness({imageFails:true});await assert.rejects(failed.client.png('<svg/>',1440,856),/generare/);assert.equal(failed.revoked.length,1);
});
