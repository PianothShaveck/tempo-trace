'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Audio=require('../assets/midi-audio.js');
const note=(overrides={})=>({start:.125,end:.5,note:60,velocity:90,channel:0,...overrides});
const parsed=(notes=[note()],duration=1)=>({notes,duration});
const pcm=result=>new Int16Array(result.buffer,44);
const peak=values=>values.reduce((maximum,value)=>Math.max(maximum,Math.abs(value)),0);

test('MIDI preview keeps onset times, note releases, silent introductions, and the source notes',()=>{
  const input=parsed(),original=JSON.stringify(input),updates=[];
  const result=Audio.renderWav(input,{sampleRate:8000},value=>updates.push(value));
  const samples=pcm(result),view=new DataView(result.buffer);
  assert.equal(view.getUint32(24,true),8000);assert.equal(view.getUint16(22,true),1);assert.equal(result.duration,1);
  assert.equal(peak(samples.slice(0,1000)),0);assert.ok(peak(samples.slice(1000,1100))>1000);
  assert.equal(peak(samples.slice(5760)),0,'the note must end after its release');
  assert.equal(JSON.stringify(input),original);
  assert.equal(updates[0],0);assert.equal(updates.at(-1),1);assert.ok(updates.every((v,i)=>!i||v>=updates[i-1]));
  assert.ok(result.peaks.some(v=>v>0));assert.ok(result.peaks.every(v=>v>=0&&v<=1));
});

test('overlapping notes and dense chords are all rendered with a single clipping-safe gain',()=>{
  const notes=Array.from({length:128},(_,i)=>note({start:.1,end:.3,note:48+i%24,velocity:127}));
  const result=Audio.renderWav(parsed(notes,.6),{sampleRate:8000});
  assert.ok(result.normalization<1);assert.ok(peak(pcm(result))>30000);assert.ok(peak(pcm(result))<=30803);
  assert.ok(result.peaks.every(v=>Number.isFinite(v)&&v<=.941));
  assert.deepEqual(result.buffer,Audio.renderWav(parsed(notes,.6),{sampleRate:8000}).buffer,'rendering is deterministic');
});

test('velocity, sustained note ends, and drum channel affect the audition without quantizing events',()=>{
  const soft=Audio.renderWav(parsed([note({velocity:30})]),{sampleRate:8000});
  const loud=Audio.renderWav(parsed([note({velocity:100})]),{sampleRate:8000});
  assert.ok(peak(pcm(loud))>3*peak(pcm(soft)));
  const held=Audio.renderWav(parsed([note({end:.9})],1.4),{sampleRate:8000});
  assert.ok(peak(pcm(held).slice(6800,7000))>100);
  const drum=Audio.renderWav(parsed([note({channel:9,note:42,start:.137,end:.14})]),{sampleRate:8000});
  assert.equal(peak(pcm(drum).slice(0,1096)),0);assert.ok(peak(pcm(drum).slice(1096,1200))>0);
  assert.notDeepEqual(drum.buffer,loud.buffer);
});

test('tempo-only MIDI renders silence for its full duration and invalid note records cannot corrupt audio',()=>{
  const result=Audio.renderWav(parsed([],2),{sampleRate:8000});
  assert.equal(result.duration,2);assert.equal(pcm(result).length,16000);assert.equal(peak(pcm(result)),0);assert.equal(peak(result.peaks),0);
  const empty=Audio.renderWav(parsed([],0),{sampleRate:8000});assert.ok(empty.duration>0);
  const bad=Audio.renderWav(parsed([note({start:-1}),note({end:NaN}),note({note:200}),note({velocity:0})]),{sampleRate:8000});
  assert.equal(peak(pcm(bad)),0);
  assert.throws(()=>Audio.renderWav(parsed([],Infinity)),/Invalid MIDI/);
  assert.throws(()=>Audio.renderWav(parsed(),{sampleRate:0}),/sample rate/);
  assert.throws(()=>Audio.renderWav(parsed([],300000)),/4 GB/);
});

test('self-contained synthesis worker reports progress and transfers PCM and waveform peaks',()=>{
  const messages=[],self={postMessage:(message,transfer)=>messages.push({message,transfer})};
  vm.runInNewContext(Audio.workerSource(),{self,Float32Array,ArrayBuffer,DataView,Math,Number});
  self.onmessage({data:{parsed:parsed(),options:{sampleRate:8000}}});
  const result=messages.at(-1);
  assert.equal(result.message.type,'result');assert.deepEqual(Array.from(result.transfer),[result.message.buffer,result.message.peaks.buffer]);
  assert.ok(messages.some(entry=>entry.message.type==='progress'));
  assert.deepEqual(result.message.buffer,Audio.renderWav(parsed(),{sampleRate:8000}).buffer);
  self.onmessage({data:{parsed:null,options:{}}});assert.equal(messages.at(-1).message.type,'error');
});

function harness({constructorError=false,noWorker=false}={}){
  const workers=[],created=[],revoked=[];
  class WorkerDouble{
    constructor(url){if(constructorError)throw new Error('worker refused');this.url=url;this.terminated=0;workers.push(this);}
    postMessage(message){this.message=message;}
    terminate(){this.terminated++;}
    send(data){this.onmessage({data});}
  }
  const globals={Worker:noWorker?undefined:WorkerDouble,Blob,DOMException,ArrayBuffer,Float32Array,
    URL:{createObjectURL:blob=>{const url='blob:'+created.length;created.push({url,blob});return url;},revokeObjectURL:url=>revoked.push(url)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/midi-audio.js'),'utf8'),globals);
  return {client:globals.TempoMidiAudio,workers,created,revoked};
}

test('browser MIDI audition runs in a worker and releases it after a playable WAV result',async()=>{
  const h=harness(),updates=[],input={...parsed(),tracks:[{large:'raw track data'}]};
  const pending=h.client.render(input,{sampleRate:8000,onProgress:value=>updates.push(value)});
  const worker=h.workers[0];assert.equal(worker.message.options.sampleRate,8000);assert.equal(worker.message.parsed.tracks,undefined);
  worker.send({type:'progress',progress:.2});worker.send({type:'progress',progress:5});
  worker.send({type:'result',...Audio.renderWav(parsed(),{sampleRate:8000})});
  const result=await pending;assert.equal(result.blob.type,'audio/wav');assert.equal(result.blob.size,16044);assert.equal(result.duration,1);
  assert.deepEqual(updates,[.2,1]);assert.equal(worker.terminated,1);assert.deepEqual(h.revoked,[worker.url]);
});

test('cancellation aborts promptly, terminates synthesis, and ignores late worker results',async()=>{
  const before=new AbortController();before.abort();const h=harness();
  await assert.rejects(h.client.render(parsed(),{signal:before.signal}),{name:'AbortError'});assert.equal(h.workers.length,0);
  const controller=new AbortController(),pending=h.client.render(parsed(),{signal:controller.signal});
  const rejected=assert.rejects(pending,{name:'AbortError'}),worker=h.workers[0];controller.abort();await rejected;
  worker.send({type:'result',...Audio.renderWav(parsed(),{sampleRate:8000})});
  assert.equal(worker.terminated,1);assert.deepEqual(h.revoked,[worker.url]);
});

test('worker errors and malformed output reject cleanly without a blocking main-thread fallback',async()=>{
  for(const mode of ['constructor','unavailable','runtime','error','malformed','progress-callback']){
    const h=harness({constructorError:mode==='constructor',noWorker:mode==='unavailable'});
    const pending=h.client.render(parsed(),{onProgress:()=>{throw new Error('consumer');}}),rejected=assert.rejects(pending);
    const worker=h.workers[0];
    if(mode==='runtime')worker.onerror();
    if(mode==='error')worker.send({type:'error',message:'render failed'});
    if(mode==='malformed')worker.send({type:'result',buffer:new ArrayBuffer(44),duration:NaN});
    if(mode==='progress-callback')worker.send({type:'progress',progress:.1});
    await rejected;if(worker)assert.equal(worker.terminated,1,mode);assert.equal(h.revoked.length,h.created.length,mode);
  }
});
