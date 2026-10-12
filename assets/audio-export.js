/* PCM WAV export. The worker renders blocks twice to normalize without a full float mix. */
(function(root,factory){
  const api=factory();
  api.workerSource=()=>`'use strict';const renderer=(${factory.toString()})();self.onmessage=e=>{try{const result=renderer.renderWav(e.data,p=>self.postMessage({progress:p}));self.postMessage({buffer:result.buffer,normalization:result.normalization},[result.buffer]);}catch(error){self.postMessage({error:error.message});}};`;
  if(typeof module==='object'&&module.exports)module.exports=api;else root.TempoAudioExport=api;
})(globalThis,function(){
  'use strict';
  function renderWav(options,progress=()=>{}){
    const sr=options.sampleRate||44100,rate=options.mode==='mix'?1:(options.rate||1),duration=Number(options.duration);
    if(!Number.isFinite(duration)||duration<=0||duration>7200||!Number.isFinite(rate)||rate<.25||rate>2||![11025,22050,44100,48000].includes(sr))throw new Error('Durata o frequenza audio non valida.');
    const mix=options.mode==='mix',channels=mix?options.channels:[],n=mix?channels?.length:1;
    if(!n||n>2||mix&&!channels.every(c=>c instanceof Float32Array))throw new Error('Audio originale non disponibile.');
    const clickVolume=Math.max(0,Math.min(2,Number.isFinite(options.clickVolume)?options.clickVolume:1));
    const musicVolume=Math.max(0,Math.min(1,Number.isFinite(options.musicVolume)?options.musicVolume:.8));
    const beats=(options.beats||[]).filter(b=>Number.isFinite(b.time)&&b.time>=0&&b.time<=duration).map(b=>({frame:Math.round(b.time/rate*sr),time:b.time})).sort((a,b)=>a.frame-b.frame);
    const frames=Math.ceil(Math.max(duration/rate,beats.length?beats.at(-1).time/rate+.035:0)*sr),bytes=frames*n*2;
    if(bytes>256*1024*1024)throw new Error('WAV troppo grande. Esporta un tratto più breve.');
    const clickLength=Math.round(.035*sr),duckLead=Math.round(.008*sr),duckTail=Math.round(.20*sr),blockSize=32768;
    for(const beat of beats){
      beat.duck=1;
      if(mix&&options.autoBalance&&clickVolume>0&&musicVolume>0){
        let sum=0,count=0;
        const a=Math.max(0,beat.frame-Math.round(.035*sr)),b=Math.min(Math.round(duration*sr),beat.frame+Math.round(.025*sr));
        for(const channel of channels)for(let i=a;i<b;i+=4){const v=channel[i]||0;sum+=v*v;count++;}
        const rms=Math.sqrt(sum/Math.max(1,count))*musicVolume;
        if(rms>.0001)beat.duck=Math.min(1,Math.max(.22,.20*clickVolume*.55/rms));
      }
    }
    const clicks=new Float32Array(blockSize),duck=new Float32Array(blockSize);
    let peak=0,normalization=1,view=null;
    function pass(encode){
      let first=0;
      for(let base=0;base<frames;base+=blockSize){
        const length=Math.min(blockSize,frames-base);clicks.fill(0);duck.fill(1);
        while(first<beats.length&&beats[first].frame+duckTail<base)first++;
        for(let j=first;j<beats.length&&beats[j].frame-duckLead<base+length;j++){
          const beat=beats[j],a=Math.max(base,beat.frame),b=Math.min(base+length,beat.frame+clickLength);
          for(let i=a;i<b;i++){
            const t=(i-beat.frame)/sr;
            const envelope=t<.002?t/.002:t<.028?Math.exp(Math.log(.005)*(t-.002)/.026):.005*Math.max(0,(.035-t)/.007);
            clicks[i-base]+=.20*clickVolume*envelope*Math.sin(2*Math.PI*2600*t);
          }
          if(beat.duck<1){
            const from=Math.max(base,beat.frame-duckLead),to=Math.min(base+length,beat.frame+duckTail);
            const releaseStart=1-(1-beat.duck)*(1-Math.exp(-.043/.003));
            for(let i=from;i<to;i++){
              const t=(i-beat.frame)/sr;
              const value=t<.035?1-(1-beat.duck)*(1-Math.exp(-(t+.008)/.003)):1-(1-releaseStart)*Math.exp(-(t-.035)/.035);
              duck[i-base]=Math.min(duck[i-base],value);
            }
          }
        }
        for(let i=0;i<length;i++)for(let channel=0;channel<n;channel++){
          const raw=mix?(channels[channel][base+i]||0)*musicVolume*duck[i]:0;
          const value=raw+clicks[i];
          if(encode){const v=Math.max(-1,Math.min(1,value*normalization));view.setInt16(44+((base+i)*n+channel)*2,Math.round(v*(v<0?32768:32767)),true);}
          else peak=Math.max(peak,Math.abs(value));
        }
        if(base%(blockSize*8)===0)progress((encode ? .5 : 0)+.49*(base+length)/frames);
      }
    }
    pass(false);normalization=peak>.98?.98/peak:1;
    const buffer=new ArrayBuffer(44+bytes);view=new DataView(buffer);
    const text=(offset,s)=>{for(let i=0;i<s.length;i++)view.setUint8(offset+i,s.charCodeAt(i));};
    text(0,'RIFF');view.setUint32(4,36+bytes,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,n,true);view.setUint32(24,sr,true);view.setUint32(28,sr*n*2,true);view.setUint16(32,n*2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,bytes,true);
    pass(true);progress(1);return {buffer,normalization};
  }
  return {renderWav};
});
