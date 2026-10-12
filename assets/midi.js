/* Standard MIDI Files 0/1, tempo-map export and non-destructive event retiming.
 * TempoMidi (UMD): parse, tickToSeconds, secondsToQuarter, quarterToSeconds,
 * importBeats, exportTempo, convert. No network, synthesizer or dependencies.
 * All quarter positions are quarter notes, independent of the chosen tap unit.
 * Exported time zero is musical quarter zero, not an audio's leading silence.
 * convert replaces tempo/meter from offsetQuarter onwards; the final tempo
 * continues after measured coverage. PPQ event ticks and track order survive.
 * TempoTrace:1: sequencer metadata preserves pickup, numbering and meters which
 * SMF FF58 cannot represent. Consumers without that extension get warnings.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.TempoMidi=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const PREFIX='TempoTrace:1:',MAX_VLQ=0x0fffffff;
function fail(message,code='MIDI_INVALID'){const error=new Error(message);error.code=code;throw error;}
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const utf8=text=>Array.from(new TextEncoder().encode(text));
const text=bytes=>new TextDecoder().decode(Uint8Array.from(bytes));
const notationText=data=>text(data[0]===125?data.slice(1):data);
const meta=(tick,metaType,data)=>({tick,type:'meta',status:255,metaType,data:Array.from(data)});
function bytesOf(input){if(input instanceof Uint8Array)return input;if(input instanceof ArrayBuffer)return new Uint8Array(input);if(ArrayBuffer.isView(input))return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);fail('Choose a Standard MIDI File (.mid or .midi).');}
class Reader{
 constructor(bytes,start=0,end=bytes.length){this.bytes=bytes;this.pos=start;this.end=end;}
 need(n){if(!Number.isSafeInteger(n)||n<0||this.pos+n>this.end)fail('Truncated MIDI data.');}
 byte(){this.need(1);return this.bytes[this.pos++];}
 u16(){return this.byte()*256+this.byte();}
 u32(){return this.byte()*16777216+this.byte()*65536+this.byte()*256+this.byte();}
 data(n){this.need(n);const result=Array.from(this.bytes.subarray(this.pos,this.pos+n));this.pos+=n;return result;}
 ascii(n){return String.fromCharCode(...this.data(n));}
 vlq(){let value=0;for(let i=0;i<4;i++){const b=this.byte();value=value*128+(b&127);if(!(b&128))return value;}fail('Invalid MIDI variable-length integer.');}
}
function trackEvents(reader,trackIndex,warnings){
 const events=[];let tick=0,running=0,ended=false;
 while(reader.pos<reader.end){tick+=reader.vlq();if(!Number.isSafeInteger(tick))fail('MIDI tick position exceeds numeric precision.');let status=reader.byte();
  if(status<128){if(!running)fail('MIDI running status has no preceding channel message.');reader.pos--;status=running;}
  let event;
  if(status>=128&&status<=239){running=status;const length=(status>>4)===12||(status>>4)===13?1:2,data=reader.data(length);if(data.some(b=>b>=128))fail('Invalid MIDI channel data.');event={tick,type:'channel',status,data};}
  else if(status===255){running=0;const metaType=reader.byte(),data=reader.data(reader.vlq());event=meta(tick,metaType,data);
   if(metaType===47){if(data.length)fail('Invalid MIDI end-of-track event.');ended=true;}
   if(metaType===81&&(data.length!==3||!(data[0]*65536+data[1]*256+data[2])))fail('Invalid MIDI tempo event.');
   if(metaType===88&&(data.length<4||!data[0]))fail('Invalid MIDI time signature.');
  }else if(status===240||status===247){running=0;event={tick,type:'sysex',status,data:reader.data(reader.vlq())};}
  else fail('Unsupported MIDI system event in a track.');
  event.track=trackIndex;event.order=events.length;events.push(event);
  if(ended){if(reader.pos<reader.end)warnings.push('Data after end-of-track was ignored.');break;}
 }
 if(!ended)warnings.push('A track has no end-of-track marker.');return events;
}
function uniqueAtTick(events){const result=[];for(const e of events.slice().sort((a,b)=>a.tick-b.tick||(a.track||0)-(b.track||0)||(a.order||0)-(b.order||0))){if(result.length&&result.at(-1).tick===e.tick)result[result.length-1]=e;else result.push(e);}return result;}
function segmentAt(items,value,key){let lo=0,hi=items.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(items[mid][key]<=value)lo=mid;else hi=mid-1;}return items[lo];}
function tickToSeconds(parsed,tick){if(!finite(tick)||tick<0)fail('Invalid MIDI tick position.');if(parsed.timing.type==='smpte')return tick/parsed.timing.ticksPerSecond;const e=segmentAt(parsed.tempoEvents,tick,'tick');return e.time+(tick-e.tick)/parsed.ppq*e.microseconds/1e6;}
function secondsToQuarter(parsed,seconds){if(!finite(seconds)||seconds<0)fail('Invalid MIDI time.');const e=segmentAt(parsed.tempoEvents,seconds,'time');return e.quarter+(seconds-e.time)*1e6/e.microseconds;}
function quarterToSeconds(parsed,quarter){if(!finite(quarter)||quarter<0)fail('Invalid MIDI quarter position.');const e=segmentAt(parsed.tempoEvents,quarter,'quarter');return e.time+(quarter-e.quarter)*e.microseconds/1e6;}
function readNotes(parsed){
 const events=parsed.tracks.flat().filter(e=>e.type==='channel'||e.type==='meta'&&e.metaType===33).sort((a,b)=>a.tick-b.tick||a.track-b.track||a.order-b.order),ports=new Map(),channels=new Map(),notes=[];
 const stateFor=(port,channel)=>{const key=port+':'+channel;if(!channels.has(key))channels.set(key,{pedal:false,keys:new Map(),held:[]});return channels.get(key);};
 const finish=(note,tick)=>{note.endTick=Math.max(note.startTick,tick);note.end=tickToSeconds(parsed,note.endTick);notes.push(note);};
 const release=(state,note,tick)=>{if(state.pedal)state.held.push(note);else finish(note,tick);};
 for(const event of events){if(event.type==='meta'){if(event.data.length)ports.set(event.track,event.data[0]);continue;}
  const command=event.status>>4,channel=event.status&15,port=ports.get(event.track)||0,state=stateFor(port,channel),[a,b]=event.data;
  if(command===9&&b>0){const note={start:tickToSeconds(parsed,event.tick),end:0,startTick:event.tick,endTick:0,note:a,velocity:b,channel,track:event.track,port};if(!state.keys.has(a))state.keys.set(a,[]);state.keys.get(a).push(note);}
  else if(command===8||command===9&&b===0){const queue=state.keys.get(a);if(queue?.length)release(state,queue.shift(),event.tick);}
  else if(command===11){if(a===64){const down=b>=64;if(state.pedal&&!down){for(const note of state.held)finish(note,event.tick);state.held=[];}state.pedal=down;}
   else if(a===120||a===123){for(const queue of state.keys.values())for(const note of queue){if(a===120)finish(note,event.tick);else release(state,note,event.tick);}state.keys.clear();if(a===120){for(const note of state.held)finish(note,event.tick);state.held=[];}}
   else if(a===121){state.pedal=false;for(const note of state.held)finish(note,event.tick);state.held=[];}
  }
 }
 for(const state of channels.values()){for(const queue of state.keys.values())for(const note of queue)finish(note,parsed.endTick);for(const note of state.held)finish(note,parsed.endTick);}
 return notes.sort((a,b)=>a.start-b.start||a.track-b.track||a.note-b.note);
}
function parse(input){
 const bytes=bytesOf(input),reader=new Reader(bytes),warnings=[];
 if(reader.ascii(4)!=='MThd')fail('Choose a Standard MIDI File (.mid or .midi).');const headerLength=reader.u32();if(headerLength<6)fail('Invalid MIDI header.');reader.need(headerLength);
 const headerEnd=reader.pos+headerLength,format=reader.u16(),count=reader.u16(),division=reader.u16();reader.pos=headerEnd;
 if(format===2)fail('MIDI format 2 contains independent patterns. Export it as format 0 or 1 first.','MIDI_FORMAT_2');if(format!==0&&format!==1)fail('Unsupported MIDI format.');if(!count||format===0&&count!==1)fail('Invalid MIDI track count.');
 let timing,ppq=null;if(division&32768){const code=(division>>8)-256,ticksPerFrame=division&255;if(![-24,-25,-29,-30].includes(code)||!ticksPerFrame)fail('Invalid SMPTE MIDI division.');const fps=code===-29?30000/1001:-code;timing={type:'smpte',fps,ticksPerFrame,ticksPerSecond:fps*ticksPerFrame};}else{ppq=division;if(!ppq)fail('MIDI resolution must be positive.');timing={type:'ppq',ppq};}
 const tracks=[];while(reader.pos<reader.end){const kind=reader.ascii(4),length=reader.u32();reader.need(length);if(kind==='MTrk')tracks.push(trackEvents(new Reader(bytes,reader.pos,reader.pos+length),tracks.length,warnings));reader.pos+=length;}
 if(tracks.length!==count)fail('MIDI track count does not match its header.');
 const all=tracks.flat(),endTick=all.reduce((max,e)=>Math.max(max,e.tick),0);let tempos=uniqueAtTick(all.filter(e=>e.type==='meta'&&e.metaType===81).map(e=>({...e,microseconds:e.data[0]*65536+e.data[1]*256+e.data[2]})));
 if(!tempos.length||tempos[0].tick!==0)tempos.unshift({tick:0,microseconds:500000,implicit:true});
 let previous=null;const tempoEvents=tempos.map(e=>{let time=0,quarter=0;if(timing.type==='ppq'){quarter=e.tick/ppq;if(previous)time=previous.time+(e.tick-previous.tick)/ppq*previous.microseconds/1e6;}else{time=e.tick/timing.ticksPerSecond;if(previous)quarter=previous.quarter+(time-previous.time)*1e6/previous.microseconds;}const item={tick:e.tick,time,quarter,microseconds:e.microseconds,bpm:60e6/e.microseconds,implicit:!!e.implicit};previous=item;return item;});
 const parsed={format,division,ppq,timing,tracks,tempoEvents,timeSignatures:[],notes:[],endTick,duration:0,warnings,notation:null};parsed.duration=tickToSeconds(parsed,endTick);parsed.maxQuarter=secondsToQuarter(parsed,parsed.duration);
 let signatures=uniqueAtTick(all.filter(e=>e.type==='meta'&&e.metaType===88));if(!signatures.length||signatures[0].tick!==0)signatures.unshift({...meta(0,88,[4,2,24,8]),implicit:true});
 parsed.timeSignatures=signatures.map(e=>({tick:e.tick,time:tickToSeconds(parsed,e.tick),quarter:secondsToQuarter(parsed,tickToSeconds(parsed,e.tick)),numerator:e.data[0],denominator:2**e.data[1],clocksPerClick:e.data[2],thirtySecondsPerQuarter:e.data[3],implicit:!!e.implicit}));
 for(const e of all)if(e.type==='meta'&&e.metaType===127){const value=notationText(e.data);if(value.startsWith(PREFIX)){try{const notation=JSON.parse(value.slice(PREFIX.length));if(!validNotation(notation))throw new Error();parsed.notation=notation;}catch{warnings.push('Invalid Tempo Trace notation metadata was ignored.');}}}
 if(parsed.notation?.meterEvents?.length){const offset=finite(parsed.notation.offsetQuarter)?parsed.notation.offsetQuarter:0;const custom=parsed.notation.meterEvents.filter(e=>finite(e.quarter)&&e.quarter>=0&&Number.isSafeInteger(e.numerator)&&e.numerator>0&&Number.isSafeInteger(e.denominator)&&e.denominator>0).map(e=>({...e,quarter:e.quarter+offset,time:quarterToSeconds(parsed,e.quarter+offset),custom:true}));parsed.timeSignatures=parsed.timeSignatures.filter(e=>e.quarter<offset).concat(custom).sort((a,b)=>a.quarter-b.quarter);}
 parsed.notes=readNotes(parsed);const imported=advancedFromMidi(parsed);parsed.advanced=imported.advanced;parsed.warnings.push(...imported.warnings);return parsed;
}
function importBeats(parsed,beatUnit=1,options={}){
 if(!finite(beatUnit)||beatUnit<=0)fail('The MIDI beat unit must be positive.');const end=parsed.maxQuarter,quarters=[];
 const count=Math.floor((end+1e-9)/beatUnit);if(!Number.isSafeInteger(count))fail('MIDI beat grid exceeds numeric precision.');
 // Reject before allocating the grid. This conservative upper bound includes
 // duplicate tempo boundaries; the final deduplicated list can only be smaller.
 if(options.maxBeats!==undefined){if(!Number.isSafeInteger(options.maxBeats)||options.maxBeats<1)fail('Invalid MIDI beat limit.');if(count+1+parsed.tempoEvents.length+(end>0?1:0)>options.maxBeats)fail("MIDI beat grid exceeds the project's beat limit. Use a longer beat unit or a shorter MIDI file.",'MIDI_BEAT_LIMIT');}
 for(let i=0;i<=count;i++)quarters.push(i*beatUnit);for(const e of parsed.tempoEvents)if(e.quarter>=0&&e.quarter<=end)quarters.push(e.quarter);
 if(end>0)quarters.push(end);quarters.sort((a,b)=>a-b);return quarters.filter((q,i)=>i===0||q-quarters[i-1]>1e-8).map(quarter=>({quarter,time:quarterToSeconds(parsed,quarter),...(Math.abs(quarter-Math.round(quarter/beatUnit)*beatUnit)>1e-8?{tempoAnchor:true}:{})}));
}
function vlq(value){if(!Number.isSafeInteger(value)||value<0||value>MAX_VLQ)fail('MIDI event spacing exceeds the SMF delta-time range.','MIDI_TICK_RANGE');const bytes=[value%128];while((value=Math.floor(value/128))>0)bytes.unshift((value%128)|128);return bytes;}
const u16=n=>[Math.floor(n/256)&255,n&255];
const u32=n=>[Math.floor(n/16777216)&255,Math.floor(n/65536)&255,Math.floor(n/256)&255,n&255];
function chunk(name,body){if(body.length>0xffffffff)fail('MIDI chunk exceeds the file-format size range.');const result=new Uint8Array(8+body.length);result.set(Array.from(name,c=>c.charCodeAt(0)));result.set(u32(body.length),4);result.set(body,8);return result;}
function encodeTrack(events,endTick=0){
 const sorted=events.filter(e=>!(e.type==='meta'&&e.metaType===47)).map((e,order)=>({...e,encodeOrder:order})).sort((a,b)=>a.tick-b.tick||a.encodeOrder-b.encodeOrder);const out=[];let tick=0;
 for(const e of sorted){if(!Number.isSafeInteger(e.tick)||e.tick<tick)fail('Invalid MIDI event tick.');out.push(...vlq(e.tick-tick));tick=e.tick;
  if(e.type==='channel')out.push(e.status,...e.data);else if(e.type==='meta'){out.push(255,e.metaType,...vlq(e.data.length));for(const b of e.data)out.push(b);}else if(e.type==='sysex'){out.push(e.status,...vlq(e.data.length));for(const b of e.data)out.push(b);}else fail('Invalid MIDI event type.');
 }
 out.push(...vlq(Math.max(tick,endTick)-tick),255,47,0);return chunk('MTrk',out);
}
function encode(format,ppq,tracks,endTicks){if(!Number.isInteger(ppq)||ppq<1||ppq>32767)fail('MIDI PPQ must be between 1 and 32767.','MIDI_RESOLUTION');if(tracks.length>65535)fail('Too many MIDI tracks.');const chunks=[chunk('MThd',[...u16(format),...u16(tracks.length),...u16(ppq)]),...tracks.map((track,i)=>encodeTrack(track,endTicks?.[i]||0))];const size=chunks.reduce((n,c)=>n+c.length,0),out=new Uint8Array(size);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}return out;}
function buildMap(map,ppq,offsetQuarter=0){
 const anchors=map?.anchors;if(!Array.isArray(anchors)||anchors.length<2)fail('Add at least two beats before exporting a MIDI tempo map.','MIDI_NEEDS_BEATS');if(!finite(offsetQuarter)||offsetQuarter<0)fail('The MIDI alignment must be zero or a positive quarter-note position.');
 const warnings=[],events=[],ticks=[];let previous=null;
 for(const a of anchors){if(!finite(a.quarter)||a.quarter<0||!finite(a.time)||a.time<0)fail('MIDI anchors need valid quarter-note positions and times.');if(previous&&(a.quarter<=previous.quarter||a.time<=previous.time))fail('MIDI beats must increase in time and musical position.','MIDI_ANCHOR_ORDER');if(previous&&a.breakBefore)fail('Join the interrupted beat groups before exporting MIDI: no tempo is defined across the gap.','MIDI_GAPS');const tick=Math.round((a.quarter+offsetQuarter)*ppq);if(!Number.isSafeInteger(tick)||ticks.length&&tick<=ticks.at(-1))fail('Two beats fall on the same MIDI tick. Increase MIDI resolution or move the beats apart.','MIDI_RESOLUTION');ticks.push(tick);previous=a;}
 for(let i=0;i<anchors.length-1;i++){const seconds=anchors[i+1].time-anchors[i].time,quarters=(ticks[i+1]-ticks[i])/ppq,microseconds=Math.round(seconds/quarters*1e6);if(microseconds<1||microseconds>0xffffff)fail('This interval exceeds the MIDI tempo range. Adjust its beat count or duration.','MIDI_TEMPO_RANGE');events.push(meta(ticks[i],81,[(microseconds>>16)&255,(microseconds>>8)&255,microseconds&255]));}
 const startTick=Math.round(offsetQuarter*ppq);if(events[0].tick>startTick)events.unshift({...events[0],tick:startTick});
 const meterEvents=Array.isArray(map.meterEvents)&&map.meterEvents.length?map.meterEvents:[{quarter:0,numerator:4,denominator:4}];let previousQuarter=-1;
 const pickup=finite(map.pickup)?map.pickup:0;if(pickup<0)fail('The pickup length cannot be negative.');
 // A short first signature gives other sequencers the correct first full
 // downbeat. The actual musical meter is retained in our notation metadata.
 let pickupSignature=null;
 if(pickup>0){for(let exponent=0;exponent<=52;exponent++){const numerator=pickup*2**exponent/4;if(numerator>=1&&numerator<=255&&Math.abs(numerator-Math.round(numerator))<1e-10){pickupSignature=[Math.round(numerator),exponent,24,8];break;}}if(pickupSignature)events.push(meta(startTick,88,pickupSignature));else warnings.push('This pickup cannot be represented by a standard MIDI time signature; its exact length is preserved in Tempo Trace metadata.');}

 if(meterEvents[0]?.quarter!==0)fail('The MIDI meter map must start at quarter zero.');
 for(const meter of meterEvents){if(!meter||typeof meter!=='object')fail('Invalid MIDI meter map.');const {quarter,numerator,denominator}=meter;if(!finite(quarter)||quarter<0||quarter<=previousQuarter||!Number.isSafeInteger(numerator)||numerator<1||!Number.isSafeInteger(denominator)||denominator<1)fail('Invalid MIDI meter map.');previousQuarter=quarter;const position=quarter===0&&pickupSignature?pickup:quarter,tick=Math.round((position+offsetQuarter)*ppq),exponent=Math.log2(denominator);
  if(numerator<=255&&Number.isInteger(exponent)&&exponent<=255)events.push(meta(tick,88,[numerator,exponent,24,8]));
  else {warnings.push(`Meter ${numerator}/${denominator} is preserved in Tempo Trace metadata; standard MIDI time signatures cannot represent it.`);events.push(meta(tick,6,utf8(`Meter ${numerator}/${denominator} (Tempo Trace)`)));}
 }
 const notation={firstBar:Number.isSafeInteger(map.firstBar)?map.firstBar:1,pickup:finite(map.pickup)?map.pickup:0,meterEvents:meterEvents.map(e=>({...e})),offsetQuarter};events.push(meta(startTick,127,[125,...utf8(PREFIX+JSON.stringify(notation))]));events.push(meta(startTick,6,utf8(`Bar ${notation.pickup>0?notation.firstBar-1:notation.firstBar}${notation.pickup>0?'; pickup '+notation.pickup+' quarter notes':''}`)));if(notation.pickup>0)events.push(meta(Math.round((offsetQuarter+notation.pickup)*ppq),6,utf8(`Bar ${notation.firstBar}`)));
 if(notation.firstBar!==1)warnings.push('Custom bar numbering is stored as MIDI markers and Tempo Trace metadata; other sequencers choose their own displayed bar numbers.');
 // Future notation stays in the extension but must not lengthen the file or
 // introduce unmeasured standard meter changes when converting a longer MIDI.
 const endTick=ticks.at(-1);return {events:events.filter(event=>event.tick<=endTick),warnings,startTick,endTick};
}
function exportTempo(map){const ppq=map?.ppq??960;if(!Number.isInteger(ppq)||ppq<1||ppq>32767)fail('MIDI PPQ must be between 1 and 32767.','MIDI_RESOLUTION');const built=buildMap(map,ppq),events=[meta(0,3,utf8(map.title||'Tempo Trace')),...built.events],out=encode(0,ppq,[events],[built.endTick]);out.warnings=built.warnings;return out;}
function convert(parsed,map,options={}){
 if(parsed.timing.type!=='ppq')fail('This MIDI uses SMPTE timecode. Save a copy with musical PPQ timing before applying a tempo map.','MIDI_SMPTE_CONVERSION');const built=buildMap(map,parsed.ppq,options.offsetQuarter??0),tracks=parsed.tracks.map(track=>track.filter(e=>!(e.type==='meta'&&(e.metaType===81||e.metaType===88||e.metaType===127&&notationText(e.data).startsWith(PREFIX))&&e.tick>=built.startTick)).map(e=>({...e,data:e.data.slice()}))),endTicks=parsed.tracks.map(track=>track.reduce((max,e)=>Math.max(max,e.tick),0));
 // Insert the conductor events before source events at equal ticks, keeping
 // relative order of every original channel, sysex and unrelated meta event.
 tracks[0]=[...built.events,...tracks[0]];endTicks[0]=Math.max(endTicks[0]||0,built.endTick);const out=encode(parsed.format,parsed.ppq,tracks,endTicks);out.warnings=built.warnings;return out;
}
function validNotation(value){return value&&typeof value==='object'&&Array.isArray(value.meterEvents)&&value.meterEvents.length>0&&(value.offsetQuarter===undefined||finite(value.offsetQuarter)&&value.offsetQuarter>=0)&&value.meterEvents.every((e,i)=>e&&finite(e.quarter)&&e.quarter>=0&&Number.isSafeInteger(e.numerator)&&e.numerator>0&&Number.isSafeInteger(e.denominator)&&e.denominator>0&&(i===0?e.quarter===0:e.quarter>value.meterEvents[i-1].quarter));}
function advancedFromMidi(parsed){
 const warnings=[],notation=parsed.notation;
 const validMeter=e=>Number.isSafeInteger(e.numerator)&&e.numerator>0&&Number.isSafeInteger(e.denominator)&&e.denominator>0;
 const exact=notation&&(!notation.offsetQuarter||notation.offsetQuarter===0),firstBar=exact&&Number.isSafeInteger(notation.firstBar)?notation.firstBar:1,pickup=exact&&finite(notation.pickup)&&notation.pickup>=0?notation.pickup:0;
 const signatures=exact&&notation.meterEvents.length?notation.meterEvents:parsed.timeSignatures;
 const meters=[];let current=null,quarterOrigin=pickup,barOrigin=firstBar,skipRest=false;
 for(const signature of signatures){if(!finite(signature.quarter)||signature.quarter<0||!validMeter(signature)){warnings.push('A MIDI time signature exceeds the supported numeric precision.');continue;}
  if(skipRest)continue;
  if(!current){if(signature.quarter!==0){warnings.push('The initial MIDI time signature does not start at quarter zero.');continue;}current={bar:firstBar,numerator:signature.numerator,denominator:signature.denominator};meters.push(current);continue;}
  const bars=(signature.quarter-quarterOrigin)/(current.numerator*4/current.denominator),rounded=Math.round(bars),nextBar=barOrigin+rounded;
  if(Math.abs(bars-rounded)>1e-7||!Number.isSafeInteger(nextBar)||nextBar<=current.bar){warnings.push(`The MIDI meter change at quarter ${Number(signature.quarter.toFixed(6))} falls inside a bar. It and later meter changes were not added to the measure grid; set those changes manually.`);skipRest=true;continue;}
  current={bar:nextBar,numerator:signature.numerator,denominator:signature.denominator};meters.push(current);quarterOrigin=signature.quarter;barOrigin=nextBar;
 }
 if(!meters.length)meters.push({bar:firstBar,numerator:4,denominator:4});
 if(notation&&notation.offsetQuarter>0)warnings.push('Tempo Trace numbering starts after the MIDI alignment point; imported bar numbers start at the beginning of this file.');
 return {advanced:{enabled:true,firstBar,pickup,meters},warnings};
}
return {parse,tickToSeconds,secondsToQuarter,quarterToSeconds,importBeats,advancedFromMidi,exportTempo,convert};
});
