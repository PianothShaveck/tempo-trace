/* Offline MIDI audition: a small additive piano synth, not a General MIDI soundfont. */
(function(root,factory){
  const api=factory();
  api.workerSource=()=>`'use strict';const renderer=(${factory.toString()})();self.onmessage=e=>{try{const r=renderer.renderWav(e.data.parsed,e.data.options,p=>self.postMessage({type:'progress',progress:p}));self.postMessage({type:'result',...r},[r.buffer,r.peaks.buffer]);}catch(error){self.postMessage({type:'error',message:error.message});}};`;
  api.render=(parsed,options={})=>new Promise((resolve,reject)=>{
    const {signal,onProgress,sampleRate=22050}=options;
    let worker=null,url=null,settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);worker?.terminate();if(url)URL.revokeObjectURL(url);error?reject(error):resolve(result);};
    const cancel=()=>finish(new DOMException('MIDI rendering cancelled.','AbortError'));
    if(signal?.aborted)return cancel();signal?.addEventListener('abort',cancel,{once:true});
    try{
      if(typeof Worker!=='function')throw new Error('MIDI rendering requires Web Workers.');
      url=URL.createObjectURL(new Blob([api.workerSource()],{type:'text/javascript'}));worker=new Worker(url);
      worker.onerror=()=>finish(new Error('Could not render the MIDI audio.'));
      worker.onmessage=event=>{
        if(settled)return;const data=event.data;
        if(data?.type==='progress'){try{onProgress?.(Math.max(0,Math.min(1,Number(data.progress)||0)));}catch(error){finish(error);}return;}
        if(data?.type==='error')return finish(new Error(data.message||'Could not render the MIDI audio.'));
        if(data?.type==='result'){
          if(!(data.buffer instanceof ArrayBuffer)||!(data.peaks instanceof Float32Array)||!Number.isFinite(data.duration)||data.duration<=0)return finish(new Error('Invalid MIDI audio result.'));
          finish(null,{blob:new Blob([data.buffer],{type:'audio/wav'}),duration:data.duration,peaks:data.peaks,sampleRate:data.sampleRate,normalization:data.normalization});
        }
      };
      // The original event tracks are unnecessary for synthesis and remain with the project.
      worker.postMessage({parsed:{notes:parsed?.notes,duration:parsed?.duration},options:{sampleRate}});
    }catch(error){finish(error);}
  });
  if(typeof module==='object'&&module.exports)module.exports=api;else root.TempoMidiAudio=api;
})(globalThis,function(){
  'use strict';
  const TAU=2*Math.PI,RELEASE=.22,BLOCK=16384;
  function noise(frame,seed){let n=(Math.imul(frame+1,1597334677)^Math.imul(seed+1,3812015801))|0;n^=n>>>16;n=Math.imul(n,2246822519);n^=n>>>13;return (n>>>0)/2147483648-1;}
  function renderWav(parsed,options={},progress=()=>{}){
    const sr=options.sampleRate??22050;
    if(!Number.isSafeInteger(sr)||sr<1||sr>0x7fffffff)throw new Error('Invalid audio sample rate.');
    if(!parsed||!Array.isArray(parsed.notes)||!Number.isFinite(parsed.duration)||parsed.duration<0)throw new Error('Invalid MIDI audio data.');
    const notes=[];let duration=parsed.duration;
    for(const note of parsed.notes){
      const {start,end,velocity,channel}=note,pitch=note.note;
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||!Number.isInteger(pitch)||pitch<0||pitch>127||!Number.isFinite(velocity)||velocity<=0)continue;
      const drum=channel===9,frequency=440*Math.pow(2,(pitch-69)/12),decay=Math.min(5,Math.max(.9,2.7*Math.pow(261.63/frequency,.24)));
      const onset=Math.round(start*sr),off=Math.max(onset+1,Math.round(end*sr));
      // Very long held notes naturally decay; only their audible portion needs synthesis.
      const stop=Math.ceil(Math.min(end+RELEASE,start+(drum?1.5:decay*13))*sr);
      notes.push({onset,off,stop,pitch,drum,frequency,decay,amplitude:.22*Math.pow(Math.min(127,velocity)/127,1.35),velocity:Math.min(127,velocity)/127});
      duration=Math.max(duration,end+RELEASE);
    }
    notes.sort((a,b)=>a.onset-b.onset);
    duration=Math.max(duration,.05);
    const frames=Math.ceil(duration*sr),bytes=frames*2;
    if(!Number.isSafeInteger(bytes)||bytes>0xffffffff-36)throw new Error('The MIDI audio exceeds the WAV format’s 4 GB capacity.');
    let buffer;
    try{buffer=new ArrayBuffer(44+bytes);}catch(error){throw new Error('Not enough memory to render this MIDI audio.');}
    const view=new DataView(buffer),mix=new Float32Array(BLOCK),peaks=new Float32Array(Math.min(2048,frames));
    let peak=0,normalization=1;
    function piano(note,base,length){
      const from=Math.max(base,note.onset),to=Math.min(base+length,note.stop);
      if(to<=from)return;
      const t=(from-note.onset)/sr,step=TAU*note.frequency/sr,releaseFrames=Math.max(1,Math.round(RELEASE*sr));
      const harmonics=[];
      const weights=[1,.36+.14*note.velocity,.14+.1*note.velocity,.075,.035,.018];
      for(let h=1;h<=weights.length&&h*note.frequency<sr*.47;h++){
        const angular=step*h,attenuation=Math.exp(-(1+.42*(h-1))/(note.decay*sr)),level=weights[h-1]*Math.exp(-t*(1+.42*(h-1))/note.decay);
        harmonics.push({s:Math.sin(angular*(from-note.onset))*level,c:Math.cos(angular*(from-note.onset))*level,sine:Math.sin(angular)*attenuation,cosine:Math.cos(angular)*attenuation});
      }
      if(!harmonics.length)return;
      for(let frame=from;frame<to;frame++){
        let value=0;
        for(let h=0;h<harmonics.length;h++){const partial=harmonics[h];value+=partial.s;const next=partial.s*partial.cosine+partial.c*partial.sine;partial.c=partial.c*partial.cosine-partial.s*partial.sine;partial.s=next;}
        const elapsed=(frame-note.onset)/sr;
        if(elapsed<.03)value+=.035*note.velocity*noise(frame-note.onset,note.pitch)*Math.exp(-elapsed/.006);
        const attack=Math.min(1,elapsed/.002),u=Math.max(0,(frame-note.off)/releaseFrames),release=Math.pow(Math.max(0,1-u),3);
        mix[frame-base]+=value*note.amplitude*attack*release;
      }
    }
    function percussion(note,base,length){
      const from=Math.max(base,note.onset),to=Math.min(base+length,note.stop),kick=note.pitch===35||note.pitch===36,hat=[42,44,46,49,51,52,55,57,59].includes(note.pitch);
      const decay=kick?.12:hat?(note.pitch===46?.16:.05):.085;
      for(let frame=from;frame<to;frame++){
        const n=frame-note.onset,t=n/sr;if(t>decay*13)break;
        const random=(noise(n,note.pitch)-noise(n-1,note.pitch))*.5;
        const body=kick?Math.sin(TAU*(46*t+7*(1-Math.exp(-t*15)))):Math.sin(TAU*(hat?310:155)*t)*.3;
        const attack=Math.min(1,t/.001);
        mix[frame-base]+=note.amplitude*attack*Math.exp(-t/decay)*(kick?body*.9+random*.08:random*.8+body*(hat?.1:.5));
      }
    }
    function pass(encode){
      let next=0,active=[];
      for(let base=0;base<frames;base+=BLOCK){
        const length=Math.min(BLOCK,frames-base);mix.fill(0);
        active=active.filter(note=>note.stop>base);
        while(next<notes.length&&notes[next].onset<base+length)active.push(notes[next++]);
        for(const note of active)(note.drum?percussion:piano)(note,base,length);
        for(let i=0;i<length;i++){
          const value=mix[i];
          if(encode){const scaled=Math.max(-1,Math.min(1,value*normalization));view.setInt16(44+(base+i)*2,Math.round(scaled*(scaled<0?32768:32767)),true);}
          else{const absolute=Math.abs(value);peak=Math.max(peak,absolute);const bin=Math.min(peaks.length-1,Math.floor((base+i)/frames*peaks.length));if(absolute>peaks[bin])peaks[bin]=absolute;}
        }
        if(base%(BLOCK*8)===0)progress((encode?.5:0)+.5*(base+length)/frames);
      }
    }
    progress(0);pass(false);normalization=peak>.94?.94/peak:1;
    const text=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
    text(0,'RIFF');view.setUint32(4,36+bytes,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sr,true);view.setUint32(28,sr*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,bytes,true);
    pass(true);for(let i=0;i<peaks.length;i++)peaks[i]*=normalization;progress(1);
    return {buffer,duration:frames/sr,peaks,sampleRate:sr,normalization};
  }
  return {renderWav};
});
