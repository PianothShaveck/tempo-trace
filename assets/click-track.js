/* Optional audible beat review, scheduled against original media time. */
(() => {
  'use strict';
  function create(media) {
    let enabled=false,context=null,masterGain=null,timer=null,beats=[],next=0,waiting=false,level=1;
    let autoBalance=true,source=null,analyser=null,musicGain=null,meter=null,balanceUnavailable=false;
    const scheduled=new Set();
    const CLICK_PEAK=.20, CLICK_HZ=2600;
    function connectRecording(){
      if(source || balanceUnavailable)return;
      try{
        analyser=context.createAnalyser();analyser.fftSize=1024;
        meter=new Float32Array(analyser.fftSize);
        musicGain=context.createGain();
        source=context.createMediaElementSource(media);
        source.connect(analyser);analyser.connect(musicGain);musicGain.connect(context.destination);
      }catch{
        // If routing partially succeeded, preserve the original recording path.
        if(source){try{source.disconnect();source.connect(context.destination);}catch{}}
        analyser=null;musicGain=null;meter=null;balanceUnavailable=true;
      }
    }
    function restoreRecording(){
      if(!musicGain)return;
      musicGain.gain.cancelScheduledValues(context.currentTime);
      musicGain.gain.setTargetAtTime(1,context.currentTime,.012);
    }
    function recordingLevel(){
      if(!analyser || !autoBalance || level===0)return 0;
      analyser.getFloatTimeDomainData(meter);
      let sum=0;for(const sample of meter)sum+=sample*sample;
      return Math.sqrt(sum/meter.length);
    }
    function balanceAt(when,rms){
      if(!autoBalance || !musicGain || rms<.0001 || level===0 || media.muted)return;
      // RMS is measured before attenuation. Leave quiet passages unchanged and
      // briefly make room for the click; never rewrite the user's volume slider.
      const clickPeak=CLICK_PEAK*level*media.volume;
      const target=Math.min(1,Math.max(.22,clickPeak*.55/rms));
      if(target>=.98)return;
      const start=Math.max(context.currentTime,when-.008);
      musicGain.gain.cancelScheduledValues(start);
      musicGain.gain.setTargetAtTime(target,start,.003);
      musicGain.gain.setTargetAtTime(1,when+.035,.035);
    }
    function syncVolume(){
      if(!context || !masterGain)return;
      const volume=media.muted?0:Math.max(0,Math.min(1,Number(media.volume)||0));
      // A shared output gain also silences clicks already scheduled in the horizon.
      masterGain.gain.setValueAtTime(volume*level,context.currentTime);
    }
    function reset(){
      for(const node of scheduled){try{node.stop();}catch{}}scheduled.clear();
      restoreRecording();
      let low=0,high=beats.length;
      while(low<high){const mid=(low+high)>>>1;if(beats[mid].time<media.currentTime-.012)low=mid+1;else high=mid;}
      next=low;
    }
    function tick(){
      if(!enabled || !context || context.state!=='running' || media.paused || media.ended || media.seeking || waiting)return;
      const position=media.currentTime,rate=media.playbackRate||1,rms=recordingLevel();
      while(next<beats.length && beats[next].time<position-.035*rate)next++;
      while(next<beats.length && beats[next].time<=position+.10*rate){
        const beat=beats[next++], when=context.currentTime+Math.max(.002,(beat.time-position)/rate);
        const oscillator=context.createOscillator(),gain=context.createGain();
        oscillator.type='sine';oscillator.frequency.value=CLICK_HZ;
        gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(CLICK_PEAK,when+.002);gain.gain.exponentialRampToValueAtTime(.001,when+.028);
        oscillator.connect(gain);gain.connect(masterGain);oscillator.start(when);oscillator.stop(when+.035);
        balanceAt(when,rms);
        scheduled.add(oscillator);oscillator.onended=()=>{scheduled.delete(oscillator);oscillator.disconnect();gain.disconnect();};
      }
    }
    async function setEnabled(value){
      if(value){
        const AudioCtx=window.AudioContext||window.webkitAudioContext;
        if(!AudioCtx)throw new Error('Click audio non disponibile.');
        if(!context){context=new AudioCtx();masterGain=context.createGain();masterGain.connect(context.destination);}
        syncVolume();await context.resume();
        if(autoBalance)connectRecording();
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
    return {setEnabled,reset,setBeats(value){beats=value;reset();},
      setVolume(value){if(Number.isFinite(value)){level=Math.max(0,Math.min(2,value));syncVolume();if(level===0)restoreRecording();}},
      setAutoBalance(value){autoBalance=!!value;if(enabled && autoBalance)connectRecording();if(!autoBalance)restoreRecording();},
      get balanceAvailable(){return !balanceUnavailable;},get enabled(){return enabled;}};
  }
  globalThis.TempoClicks={create};
})();
