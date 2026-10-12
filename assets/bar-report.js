/* Standalone, bar-aligned SVG report. All times remain original media seconds. */
(function(root,factory){
 'use strict';
 const api=factory(typeof module==='object'&&module.exports?require('./musical.js'):root.TempoMusical);
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.TempoBarReport=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Musical){
 'use strict';
 const finite=Number.isFinite,clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 const words={en:{basic:'BASIC TEMPO',average:'AVERAGE',start:'START',end:'END',variable:'Variable',pickup:'Pickup',bar:'Bar',bars:'Bars',trend:'Trend',accelerando:'Accelerando',rallentando:'Rallentando',fermata:'Fermata',possible:'Possible fermata',mean:'Bar average',beats:'Beats',quarter:'BPM in quarter notes',partial:'Partial',empty:'No measured bars',description:'Tempo by bar. Bar widths are equal; positions within each bar follow musical time.',outside:'Values outside the BPM scale',page:'Page'},it:{basic:'TEMPO DI BASE',average:'MEDIO',start:'INIZIALE',end:'FINALE',variable:'Variabile',pickup:'Levare',bar:'Battuta',bars:'Battute',trend:'Tendenza',accelerando:'Accelerando',rallentando:'Rallentando',fermata:'Fermata',possible:'Possibile fermata',mean:'Media della battuta',beats:'Beat',quarter:'BPM in semiminime',partial:'Parziale',empty:'Nessuna battuta misurata',description:'Andamento del tempo per battuta. Le battute hanno uguale larghezza; le posizioni interne seguono il tempo musicale.',outside:'Valori fuori dalla scala BPM',page:'Pagina'}};
 const colors={trend:'#088d7c',accelerando:'#b75b12',rallentando:'#515fbd',fermata:'#9467a4',beats:'#8468bd'};
 const clock=value=>{const s=Math.max(0,Math.round((value||0)*10));return Math.floor(s/600)+':'+(s%600/10).toFixed(1).padStart(4,'0');};
 // Report layout stays independent of beat density: at most eight bars share
 // a row, and paginated exports default to four rows of four bars.
 function layoutOptions(options={}){
  const count=(value,fallback,max)=>finite(Number(value))&&Number(value)>0?clamp(Math.round(Number(value)),1,max):fallback;
  return {barsPerRow:count(options.barsPerRow,4,8),rowsPerPage:count(options.rowsPerPage,4,6)};
 }
 function seek(items,value,key){let lo=0,hi=items.length;while(lo<hi){const mid=(lo+hi)>>>1;if(items[mid][key]<=value)lo=mid+1;else hi=mid;}return lo;}
 function prepare(project={},options={}){
  const language=options.language==='it'?'it':'en',t=words[language];
  const number=value=>finite(value)?value.toLocaleString(language==='it'?'it-IT':'en-US',{maximumFractionDigits:1}):'—';
  const perceived=estimate=>finite(estimate?.bpm)?'≈ '+number(Math.round(estimate.bpm)):estimate?.status==='variable'?t.variable:'—';
  const beats=project.beats||[],timeline=project.timeline||Musical.build(beats,project.advanced,project.beatUnit);
  const analysis=project.analysis||{},intervals=analysis.intervals||[],stats=analysis.stats||{};
  const start=finite(options.start)?Math.max(0,options.start):0;
  const last=timeline.anchors?.at(-1)?.time||beats.at(-1)?.time||0;
  const end=finite(options.end)?Math.max(start,options.end):Math.max(start,project.duration||last);
  // An excerpt boundary can fall inside an unmeasured gap. Round it inward to
  // the next/previous known score position, without inventing elapsed beats.
  const anchors=timeline.anchors||[];
  function quarterBound(time,side){
   const exact=Musical.quarterAtTime(timeline,time);if(finite(exact))return exact;
   if(!anchors.length)return null;
   let lo=0,hi=anchors.length;while(lo<hi){const mid=(lo+hi)>>>1;if(anchors[mid].time<time)lo=mid+1;else hi=mid;}
   return anchors[clamp(side==='start'?lo:lo-1,0,anchors.length-1)].quarter;
  }
  const qStart=quarterBound(start,'start'),qEnd=quarterBound(end,'end');
  const bars=(timeline.bars||[]).filter(b=>finite(qStart)&&finite(qEnd)&&b.endQuarter>qStart+1e-8&&b.startQuarter<qEnd-1e-8);
  const showBeats=options.showBeats===true;
  const values=intervals.filter(p=>p.end>=start&&p.start<=end).map(p=>showBeats?p.bpm:p.smoothed).filter(finite).sort((a,b)=>a-b);
  const lowest=values.length?values[0]:60,highest=values.length?values.at(-1):120,padding=Math.max(5,(highest-lowest)*.14);
  const min=finite(options.scale?.min)?options.scale.min:Math.max(0,Math.floor((lowest-padding)/5)*5);
  const max=Math.max(min+1,finite(options.scale?.max)?options.scale.max:Math.ceil((highest+padding)/5)*5);
  function quarterAt(time){
   const value=Musical.quarterAtTime(timeline,time);
   return finite(value)?value:null;
  }
  // Keep each interval separate. Clipping at bar and row boundaries must never
  // join the last pulse before a recording gap to the first pulse after it.
  const segments=[];let previous=null;
  for(const interval of intervals){
   if(!finite(interval.smoothed)){previous=null;continue;}
   const broken=!previous||interval.breakBefore||interval.start>previous.end+.0001;
   const a=broken?{time:interval.start,value:interval.smoothed}:{time:previous.end,value:previous.smoothed};
   if(interval.end>=start&&a.time<=end){
    const q1=quarterAt(a.time),q2=quarterAt(interval.end);
    if(finite(q1)&&finite(q2)&&q2>q1)segments.push({q1,q2,v1:a.value,v2:interval.smoothed,start:a.time,end:interval.end,kind:interval.expressive==='accelerando'||interval.expressive==='rallentando'?interval.expressive:'trend'});
   }
   previous=interval;
  }
  const holds=intervals.filter(p=>(p.expressive==='fermata'||p.expressive==='possible-fermata')&&p.end>=start&&p.start<=end).map(p=>({...p,q1:quarterAt(p.start),q2:quarterAt(p.end)})).filter(p=>finite(p.q1)&&finite(p.q2));
  const silentTimes=new Set(beats.filter(beat=>beat.tempoAnchor===true).map(beat=>beat.time));
  const silentIds=new Set(beats.filter(beat=>beat.tempoAnchor===true&&beat.id!=null).map(beat=>String(beat.id)));
  const dots=showBeats?intervals.filter(p=>p.end>=start&&p.end<=end&&finite(p.bpm)&&!silentTimes.has(p.end)&&!silentIds.has(String(p.beatId))).map(p=>({...p,q:quarterAt(p.end)})).filter(p=>finite(p.q)):[];
  if(showBeats){
   const measured=new Set(intervals.map(p=>p.end));
   for(let i=0;i<intervals.length;i++){const p=intervals[i];if((i===0||p.breakBefore)&&!measured.has(p.start)&&!silentTimes.has(p.start)&&p.start>=start&&p.start<=end&&finite(p.bpm)){const q=quarterAt(p.start);if(finite(q))dots.push({...p,end:p.start,q});}}
   dots.sort((a,b)=>a.q-b.q);
  }
  const gaps=[];for(let i=1;i<anchors.length;i++)if(anchors[i].breakBefore)gaps.push({q1:anchors[i-1].quarter,q2:anchors[i].quarter});
  let clipped=0;
  for(const p of intervals){const value=showBeats?p.bpm:p.smoothed;if(p.end>=start&&p.end<=end&&finite(value)&&(value<min||value>max))clipped++;}
  return {project,options,language,t,number,perceived,timeline,intervals,stats,start,end,qStart,qEnd,bars,min,max,showBeats,segments,holds,dots,gaps,clipped};
 }
 function render(context,bars,page=1,pageCount=1){
  const {project,options,language,t,number,perceived,timeline,intervals,stats,start,end,qStart,qEnd,min,max,showBeats,segments,holds,dots,gaps,clipped}=context;
  const capacity=layoutOptions(options).barsPerRow,rowCount=Math.max(1,Math.ceil(bars.length/capacity));
  const width=1440,left=98,right=1376,barWidth=(right-left)/capacity,firstTop=322,rowHeight=242,plotHeight=142;
  const height=firstTop+rowCount*rowHeight+26,out=[];
  const pageStart=bars.length?Musical.timeAtQuarter(timeline,Math.max(qStart,bars[0].startQuarter)):start;
  const lastBar=bars.at(-1),pageEnd=lastBar?Musical.timeAtQuarter(timeline,Math.min(qEnd,lastBar.measuredEndQuarter??lastBar.endQuarter)):end;
  const text=(x,y,value,size=14,fill='#526475',extra='')=>out.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escape(value)}</text>`);
  const rect=(x,y,w,h,fill,rx=0,extra='')=>out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`);
  const line=(x1,y1,x2,y2,color,width=1,extra='')=>out.push(`<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color}" stroke-width="${width}" fill="none" ${extra}/>`);
  const title=String(project.title||'Tempo Trace');
  out.push(`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" data-page="${page}" data-page-count="${pageCount}" data-bpm-min="${min}" data-bpm-max="${max}"><title>${escape(title)}</title><desc>${escape(t.description)}</desc><g font-family="DejaVu Sans,Arial,sans-serif">`);
  rect(0,0,width,height,'#f3f6fa');rect(32,32,width-64,height-64,'white',18);
  text(64,69,'TEMPO TRACE',14,'#0c8279','font-weight="700" letter-spacing="2"');
  text(right,69,t.page+' '+page+' / '+pageCount,13,'#526475','text-anchor="end"');
  text(64,112,title.length>55?title.slice(0,54)+'…':title,26,'#172d3b','font-weight="700"');
  text(64,139,t.quarter,12);
  const barSpan=bars.length?(bars[0].pickup?t.pickup+' '+bars[0].number:String(bars[0].number))+(bars.length>1?' — '+bars.at(-1).number:''):'—';
  const pageTime=[pageStart,pageEnd].map(value=>finite(value)?clock(value):'—').join(' — ');
  text(right,112,t.bars+' '+barSpan,16,'#172d3b','text-anchor="end" font-weight="700"');
  text(right,139,pageTime,12,'#526475','text-anchor="end"');
  const cards=[[t.basic,perceived(stats.perceived),finite(stats.perceived?.bpm)],[t.average,number(stats.mean),finite(stats.mean)],[t.start,number(stats.start),finite(stats.start)],[t.end,number(stats.end),finite(stats.end)]];
  cards.forEach(([label,value,unit],i)=>{const px=64+i*332;rect(px,159,316,78,i===0?'#e8f7f3':'#f3f6fa',9);text(px+15,182,label,10,'#526475','letter-spacing="1"');text(px+15,219,value,25,i===0?'#087c6e':'#172d3b','font-weight="700"');if(unit)text(px+298,220,'BPM',10,'#526475','text-anchor="end"');});
  const present=new Set(intervals.filter(p=>p.end>=start&&p.start<=end).map(p=>p.expressive));
  let legendX=64;
  const legend=(label,color,advance,dash=false)=>{line(legendX,259,legendX+20,259,color,2.5,dash?'stroke-dasharray="4 3"':'');text(legendX+27,263,label,11,color);legendX+=advance;};
  legend(t.trend,colors.trend,115);legend(t.mean,'#83929d',language==='it'?172:138,true);
  if(present.has('accelerando'))legend(t.accelerando,colors.accelerando,151);
  if(present.has('rallentando'))legend(t.rallentando,colors.rallentando,150);
  if(present.has('fermata'))legend(t.fermata,colors.fermata,113);
  if(present.has('possible-fermata'))legend(t.possible,colors.fermata,170,true);
  if(showBeats)legend(t.beats,colors.beats,80);
  if(clipped)text(right,288,t.outside+': '+clipped,10,'#a76722','text-anchor="end"');
  let previousMeter=null;
  const firstQuarter=bars.length?Math.max(bars[0].startQuarter,qStart):qStart;
  let segmentCursor=seek(segments,firstQuarter,'q2'),holdCursor=seek(holds,firstQuarter,'q2'),dotCursor=seek(dots,firstQuarter-1e-8,'q'),gapCursor=seek(gaps,firstQuarter,'q2');
  bars.forEach((bar,index)=>{
   const row=Math.floor(index/capacity),column=index%capacity,top=firstTop+row*rowHeight,bottom=top+plotHeight,px=left+column*barWidth;
   const y=bpm=>top+(max-bpm)/(max-min)*plotHeight;
   const q0=bar.startQuarter,q1=bar.endQuarter,span=q1-q0;
   if(!finite(q0)||!finite(q1)||span<=0)return;
   const x=q=>px+(q-q0)/span*barWidth;
   const clipStart=Math.max(q0,qStart),clipEnd=Math.min(q1,qEnd,bar.measuredEndQuarter??q1);
   while(gapCursor<gaps.length&&gaps[gapCursor].q2<=clipStart)gapCursor++;
   const hasGap=gapCursor<gaps.length&&gaps[gapCursor].q1<clipEnd;
   const measuredStart=Musical.timeAtQuarter(timeline,clipStart),measuredEnd=Musical.timeAtQuarter(timeline,clipEnd);
   const mean=!hasGap&&finite(measuredStart)&&finite(measuredEnd)&&measuredEnd>measuredStart?60*(clipEnd-clipStart)/(measuredEnd-measuredStart):null;
   const clipId='barPlot'+index;
   out.push(`<g data-bar="${escape(bar.number)}" data-row="${row}" data-pickup="${bar.pickup===true}" data-start-quarter="${q0}" data-end-quarter="${q1}">`);
   rect(px,top,barWidth,plotHeight,index%2?'#f8fafc':'#f1f9f7');
   if(column===0){text(left-13,top-8,'BPM',10,'#526475','text-anchor="end"');for(let i=0;i<=4;i++){const v=min+(max-min)*i/4;text(left-13,y(v)+4,number(v),10,'#526475','text-anchor="end"');}}
   for(let i=0;i<=4;i++){const v=min+(max-min)*i/4;line(px,y(v),px+barWidth,y(v),'#dfe7ed');}
   line(px,top,px,bottom,'#c9d5dd',1.1);line(px+barWidth,top,px+barWidth,bottom,'#c9d5dd',1.1);
   const meter=bar.numerator+'/'+bar.denominator,meterChanged=previousMeter!==meter;
   const barLabel=(bar.pickup?t.pickup+' · ':'')+String(bar.number);
   text(px+9,top-22,barLabel,barWidth<170?12:15,'#172d3b','font-weight="700"');
   if(meterChanged||column===0)text(px+9,top-6,meter,10,meterChanged?'#087c6e':'#70808d',meterChanged?'font-weight="700"':'');
   previousMeter=meter;
   const partial=bar.complete===false||clipStart>q0+.00001||clipEnd<q1-.00001;
   text(px+9,bottom+21,finite(mean)?number(mean)+' BPM':'—',barWidth<130?10:11,'#526475');
   text(px+9,bottom+39,finite(measuredStart)?clock(measuredStart):'—',10,'#70808d');
   if(partial)text(px+barWidth-9,barWidth<130?bottom+54:bottom+39,t.partial,9,'#70808d','text-anchor="end"');
   out.push(`<defs><clipPath id="${clipId}"><rect x="${x(clipStart)}" y="${top}" width="${Math.max(0,x(clipEnd)-x(clipStart))}" height="${plotHeight}"/></clipPath></defs><g clip-path="url(#${clipId})">`);
   while(holdCursor<holds.length&&holds[holdCursor].q2<=clipStart)holdCursor++;
   for(let k=holdCursor;k<holds.length&&holds[k].q1<clipEnd;k++){const p=holds[k],a=Math.max(clipStart,p.q1),b=Math.min(clipEnd,p.q2);if(b<=a)continue;rect(x(a),top,x(b)-x(a),plotHeight,colors.fermata,0,'opacity=".1" data-expression="'+p.expressive+'"');line(x(a),top+3,x(b),top+3,colors.fermata,3,p.expressive==='possible-fermata'?'stroke-dasharray="4 3"':'');}
   if(finite(mean))line(px+4,y(mean),px+barWidth-4,y(mean),'#8b9aa4',1,'stroke-dasharray="4 4" data-bar-average="true"');
   const paths=new Map();
   while(segmentCursor<segments.length&&segments[segmentCursor].q2<=clipStart)segmentCursor++;
   for(let k=segmentCursor;k<segments.length&&segments[k].q1<clipEnd;k++){const segment=segments[k],a=Math.max(clipStart,segment.q1),b=Math.min(clipEnd,segment.q2);if(b<=a)continue;const value=q=>segment.v1+(segment.v2-segment.v1)*(q-segment.q1)/(segment.q2-segment.q1);const d=`M${x(a).toFixed(2)} ${y(value(a)).toFixed(2)}L${x(b).toFixed(2)} ${y(value(b)).toFixed(2)} `;paths.set(segment.kind,(paths.get(segment.kind)||'')+d);}
   for(const [kind,d] of paths)out.push(`<path data-expression="${kind}" d="${d}" fill="none" stroke="${colors[kind]}" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>`);
   out.push('</g>');
   if(showBeats){
    const pixels=new Set();
    while(dotCursor<dots.length&&dots[dotCursor].q<clipStart-1e-8)dotCursor++;
    for(let k=dotCursor;k<dots.length&&dots[k].q<=clipEnd+1e-8;k++){const p=dots[k],q=p.q;
     // A shared barline owns its marker on the right, except the final bar.
     if(q>=q1-1e-8&&q<qEnd-1e-8)continue;
     const cx=x(q),cy=clamp(y(p.bpm),top+4,bottom-4),key=Math.round(cx)+','+Math.round(cy);if(pixels.has(key))continue;pixels.add(key);
     const color=p.anomaly?'#b47a29':p.expressive==='fermata'||p.expressive==='possible-fermata'?colors.fermata:colors.beats;
     out.push(`<circle data-beat="true" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="2.4" fill="${color}"><title>${escape(number(p.bpm)+' BPM · '+clock(p.end))}</title></circle>`);
    }
   }
   out.push('</g>');
  });
  if(!bars.length)text(64,firstTop+40,t.empty,16);
  out.push('</g></svg>');
  return {svg:out.join(''),width,height,page,pageCount,firstBar:bars[0]?.number??null,lastBar:lastBar?.number??null,barCount:bars.length,start:pageStart,end:pageEnd};
 }
 // create keeps the original single-image contract for existing integrations.
 function create(project={},options={}){const context=prepare(project,options);return render(context,context.bars);}
 function pagination(project={},options={}){
  const context=prepare(project,options),layout=layoutOptions(options);
  return {...layout,barCount:context.bars.length,pageCount:Math.max(1,Math.ceil(context.bars.length/(layout.barsPerRow*layout.rowsPerPage)))};
 }
 function createPages(project={},options={}){
  const context=prepare(project,options),layout=layoutOptions(options),pageSize=layout.barsPerRow*layout.rowsPerPage;
  const pageCount=Math.max(1,Math.ceil(context.bars.length/pageSize)),pages=[];
  for(let page=0;page<pageCount;page++)pages.push(render(context,context.bars.slice(page*pageSize,(page+1)*pageSize),page+1,pageCount));
  return pages;
 }
 return {create,createPages,pagination};
});
