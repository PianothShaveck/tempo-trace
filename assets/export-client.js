/* Browser-only decoding, cancellable export worker and SVG rasterization. */
(() => {
  'use strict';
  function audio(file,options,onProgress,signal){
    return new Promise((resolve,reject)=>{
      let worker=null,url=null,settled=false;
      const finish=(error,result)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);worker?.terminate();if(url)URL.revokeObjectURL(url);error?reject(error):resolve(result);};
      const cancel=()=>finish(new DOMException('Esportazione annullata','AbortError'));
      if(signal?.aborted)return cancel();signal?.addEventListener('abort',cancel,{once:true});
      (async()=>{
        let start=Math.max(0,options.start||0),end=Math.min(options.duration,options.end??options.duration),channels=[],sr=44100;
        if(end<=start)throw new Error('Seleziona un tratto valido.');
        if(options.mode==='mix'){
          if(!file)throw new Error('Collega il file originale per esportare audio e beat.');
          onProgress?.({stage:'Decodifica',progress:0});
          const AudioCtx=window.OfflineAudioContext||window.webkitOfflineAudioContext;
          if(!AudioCtx)throw new Error('Esportazione audio non disponibile in questo browser.');
          const context=new AudioCtx(2,1,sr);
          let buffer=await context.decodeAudioData(await file.arrayBuffer());
          if(settled)return;
          sr=buffer.sampleRate;end=Math.min(end,buffer.duration);if(end<=start)throw new Error('Tratto fuori dalla registrazione.');
          const first=Math.floor(start*sr),last=Math.min(buffer.length,Math.ceil(end*sr));start=first/sr;
          for(let i=0;i<Math.min(2,buffer.numberOfChannels);i++)channels.push(buffer.getChannelData(i).slice(first,last));
          buffer=null;
        }
        if(settled)return;
        if(typeof Worker!=='function')throw new Error('Worker audio non disponibile.');
        const beats=options.beats.filter(b=>b.time>=start&&b.time<=end).map(b=>({time:b.time-start}));
        if(!beats.length)throw new Error('Nessun beat nel tratto scelto.');
        url=URL.createObjectURL(new Blob([TempoAudioExport.workerSource()],{type:'text/javascript'}));worker=new Worker(url);
        worker.onerror=()=>finish(new Error('Esportazione audio non riuscita.'));
        worker.onmessage=event=>{const d=event.data;if(settled)return;if(d.error)return finish(new Error(d.error));if(d.buffer)return finish(null,new Blob([d.buffer],{type:'audio/wav'}));onProgress?.({stage:'Esportazione',progress:.1+.9*d.progress});};
        worker.postMessage({...options,start:0,duration:end-start,sampleRate:sr,channels,beats},channels.map(c=>c.buffer));
      })().catch(finish);
    });
  }
  async function png(svg,width,height){
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
    try{
      const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Impossibile generare il PNG.'));image.src=url;});
      const scale=Math.min(2,Math.sqrt(24000000/(width*height)));
      if(height*scale>32000)throw new Error('Grafico troppo alto per PNG. Usa SVG.');
      const canvas=document.createElement('canvas');canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
      const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Esportazione PNG non disponibile.');
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('PNG non generato.')),'image/png'));
    }finally{URL.revokeObjectURL(url);}
  }
  globalThis.TempoExportClient={audio,png};
})();
