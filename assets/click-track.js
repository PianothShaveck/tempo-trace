/* Optional audible beat review, scheduled against original media time. */
(() => {
  'use strict';
  function create(media) {
    let enabled=false,context=null,masterGain=null,timer=null,beats=[],next=0,waiting=false;
    const scheduled=new Set();
    function syncVolume(){
      if(!context || !masterGain)return;
      const volume=media.muted?0:Math.max(0,Math.min(1,Number(media.volume)||0));
      // A shared output gain also silences clicks already scheduled in the horizon.
      masterGain.gain.setValueAtTime(volume,context.currentTime);
    }
    function reset(){
      for(const node of scheduled){try{node.stop();}catch{}}scheduled.clear();
      let low=0,high=beats.length;
      while(low<high){const mid=(low+high)>>>1;if(beats[mid].time<media.currentTime-.012)low=mid+1;else high=mid;}
      next=low;
    }
    function tick(){
      if(!enabled || !context || context.state!=='running' || media.paused || media.ended || media.seeking || waiting)return;
      const position=media.currentTime,rate=media.playbackRate||1;
      while(next<beats.length && beats[next].time<position-.035*rate)next++;
      while(next<beats.length && beats[next].time<=position+.10*rate){
        const beat=beats[next++], when=context.currentTime+Math.max(.002,(beat.time-position)/rate);
        const oscillator=context.createOscillator(),gain=context.createGain();
        oscillator.type='sine';oscillator.frequency.value=beat.source==='auto'&&beat.confidence<.45?1100:1500;
        gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(.20,when+.002);gain.gain.exponentialRampToValueAtTime(.001,when+.028);
        oscillator.connect(gain);gain.connect(masterGain);oscillator.start(when);oscillator.stop(when+.035);
        scheduled.add(oscillator);oscillator.onended=()=>{scheduled.delete(oscillator);oscillator.disconnect();gain.disconnect();};
      }
    }
    async function setEnabled(value){
      if(value){
        const AudioCtx=window.AudioContext||window.webkitAudioContext;
        if(!AudioCtx)throw new Error('Click audio non disponibile.');
        if(!context){context=new AudioCtx();masterGain=context.createGain();masterGain.connect(context.destination);}
        syncVolume();await context.resume();
      }
      enabled=!!value;reset();
      if(timer)clearInterval(timer);timer=enabled?setInterval(tick,25):null;
      tick();return enabled;
    }
    media.addEventListener('volumechange',syncVolume);
    for(const event of ['pause','seeking','seeked','ratechange'])media.addEventListener(event,reset);
    media.addEventListener('waiting',()=>{waiting=true;reset();});
    media.addEventListener('playing',()=>{waiting=false;reset();tick();});
    media.addEventListener('play',()=>{context?.resume().catch(()=>{});waiting=false;reset();});
    return {setEnabled,reset,setBeats(value){beats=value;reset();},get enabled(){return enabled;}};
  }
  globalThis.TempoClicks={create};
})();
