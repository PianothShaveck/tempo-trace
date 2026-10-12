/* Shared local PCM cache and a cancellable, self-contained detection worker. */
(() => {
  'use strict';
  let cachedFile=null, cachedPromise=null;
  const aborted=()=>new DOMException('Operazione annullata','AbortError');
  async function decode(file,duration) {
    if(!file)throw new Error('Collega il file audio o video.');
    if(file===cachedFile && cachedPromise)return cachedPromise;
    const AudioCtx=window.AudioContext || window.webkitAudioContext;
    if(!AudioCtx)throw new Error('Decodifica audio non disponibile in questo browser.');
    cachedFile=file;
    const promise=(async()=>{
      let context;
      try {
        context=new AudioCtx({sampleRate:11025});
        const buffer=await context.decodeAudioData(await file.arrayBuffer());
        const channels=Math.min(2,buffer.numberOfChannels), mono=new Float32Array(buffer.length);
        const left=buffer.getChannelData(0),right=channels>1?buffer.getChannelData(1):null;
        let mixEnergy=0,leftEnergy=0,rightEnergy=0;
        for(let i=0;i<mono.length;i++){
          const l=left[i]||0,r=right?(right[i]||0):l; mono[i]=(l+r)*.5;
          if(i%16===0){mixEnergy+=mono[i]*mono[i];leftEnergy+=l*l;rightEnergy+=r*r;}
        }
        // A stereo phase inversion must not turn a real performance into silence.
        if(right && mixEnergy<.08*Math.max(leftEnergy,rightEnergy))mono.set(leftEnergy>=rightEnergy?left:right);
        return {samples:mono,sampleRate:buffer.sampleRate,duration:buffer.duration};
      } catch(error){
        if(error.message?.startsWith('Rilevamento'))throw error;
        throw new Error('Audio non decodificabile. Prova WAV, MP3 o l’audio estratto dal video.');
      } finally {if(context)context.close().catch(()=>{});}
    })();
    cachedPromise=promise;
    promise.catch(()=>{if(cachedPromise===promise){cachedFile=null;cachedPromise=null;}});
    return promise;
  }
  function run(file,duration,options,onProgress,signal) {
    return new Promise((resolve,reject)=>{
      let worker=null,url=null,settled=false;
      const finish=(error,result)=>{
        if(settled)return;settled=true;
        signal?.removeEventListener('abort',cancel);
        worker?.terminate();if(url)URL.revokeObjectURL(url);
        error?reject(error):resolve(result);
      };
      const cancel=()=>finish(aborted());
      if(signal?.aborted)return cancel();
      signal?.addEventListener('abort',cancel,{once:true});
      onProgress?.({stage:'Decodifica',progress:.02});
      decode(file,duration).then(audio=>{
        if(settled)return;
        if(typeof Worker!=='function' || typeof TempoDetector==='undefined')throw new Error('Rilevamento non disponibile in questo browser.');
        const start=Math.max(0,Number(options.start)||0),end=Math.min(audio.duration,Number(options.end)||audio.duration);
        if(end-start<4)throw new Error('Seleziona almeno 4 secondi.');
        const first=Math.floor(start*audio.sampleRate), last=Math.min(audio.samples.length,Math.ceil(end*audio.sampleRate));
        const samples=audio.samples.slice(first,last), offset=first/audio.sampleRate;
        const localOptions={...options,anchors:(options.anchors||[]).filter(b=>b.time>=start && b.time<=end).map(b=>({time:b.time-offset,breakBefore:!!b.breakBefore,fermataBefore:!!b.fermataBefore}))};
        const source=TempoDetector.createWorkerSource();
        url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
        worker=new Worker(url);
        worker.onerror=()=>finish(new Error('Impossibile avviare il rilevamento. Prova il sito su GitHub Pages con un browser aggiornato.'));
        worker.onmessage=event=>{
          const data=event.data;
          if(data.type==='progress'){onProgress?.({stage:data.stage,progress:.1+.9*Math.min(1,Math.max(0,data.progress||0))});return;}
          if(data.type==='error'){finish(new Error(data.message||'Rilevamento non riuscito.'));return;}
          if(data.type==='result'){
            const result=data.result;
            if(!result || !Array.isArray(result.beats))return finish(new Error('Risultato non valido.'));
            result.beats=result.beats.map(b=>({...b,time:b.time+offset}));
            if(result.diagnostics?.localTempo)result.diagnostics.localTempo=result.diagnostics.localTempo.map(p=>({...p,time:p.time+offset}));
            finish(null,result);
          }
        };
        worker.postMessage({samples,sampleRate:audio.sampleRate,options:localOptions},[samples.buffer]);
      }).catch(error=>finish(error));
    });
  }
  globalThis.TempoDetectionClient={decode,run,clear(){cachedFile=null;cachedPromise=null;}};
})();
