/* Standalone SVG report; no DOM, fonts or external resources required. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TempoReport=api;})(globalThis,function(){
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 const number=value=>Number.isFinite(value)?value.toLocaleString('it-IT',{maximumFractionDigits:1}):'—';
 const time=(value,precise=false)=>{const factor=precise?100:1,s=Math.max(0,Math.round((value||0)*factor));return Math.floor(s/(60*factor))+':'+(s%(60*factor)/factor).toFixed(precise?2:0).padStart(precise?5:2,'0');};
 function create(project,options={}){
  const analysis=project.analysis||{},stats=analysis.stats||{},sections=analysis.sections||[],intervals=analysis.intervals||[],beats=project.beats||[];
  const width=1440,height=818+Math.max(1,Math.ceil(sections.length/3))*66,start=options.start||0,end=Math.max(start+.1,options.end||project.duration||30);
  const scale=options.scale||{min:0,max:Math.max(160,...intervals.map(p=>p.bpm))},min=scale.min,max=Math.max(min+1,scale.max);
  const left=94,right=1376,top=294,bottom=618,plotWidth=right-left,plotHeight=bottom-top;
  const x=t=>left+(t-start)/(end-start)*plotWidth,y=bpm=>top+(max-bpm)/(max-min)*plotHeight;
  const out=[];
  const text=(x,y,value,size=14,fill='#526475',extra='')=>out.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escape(value)}</text>`);
  const rect=(x,y,w,h,fill,rx=0,extra='')=>out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`);
  out.push(`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escape(project.title||'Tempo Trace')}</title><desc>Andamento BPM, riepilogo e medie delle sezioni. Le interruzioni sono escluse dalle medie.</desc><g font-family="DejaVu Sans,Arial,sans-serif">`);
  rect(0,0,width,height,'#f3f6fa');rect(32,32,width-64,height-64,'white',18);
  text(64,70,'TEMPO TRACE',14,'#0c8279','font-weight="700" letter-spacing="2"');
  text(1376,70,time(start,end-start<10)+' — '+time(end,end-start<10),14,'#526475','text-anchor="end"');
  const title=String(project.title||'Esecuzione');text(64,117,title.length>81?title.slice(0,80)+'…':title,27,'#172d3b','font-weight="700"');
  text(64,148,beats.length+' beat · BPM in semiminime',13);
  const cards=[['INIZIALE',number(stats.start)],['MEDIO',number(stats.mean)],['FINALE',number(stats.end)],['INTERVALLO',number(stats.min)+'–'+number(stats.max)]];
  cards.forEach(([name,value],i)=>{const px=64+i*332;rect(px,175,316,88,i===1?'#e8f7f3':'#f3f6fa',10);text(px+18,200,name,11,'#526475','letter-spacing="1"');text(px+18,239,value,29,i===1?'#087c6e':'#172d3b','font-weight="700"');text(px+288,240,'BPM',11,'#526475','text-anchor="end"');});
  out.push(`<defs><clipPath id="reportPlot"><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/></clipPath></defs>`);
  sections.forEach((s,i)=>{const a=Math.max(start,s.start),b=Math.min(end,s.end);if(b>a)rect(x(a),top,x(b)-x(a),plotHeight,i%2?'#f7f5fc':'#f2faf8');});
  for(let i=0;i<=5;i++){const v=min+(max-min)*i/5,py=y(v);out.push(`<path d="M${left} ${py}H${right}" stroke="#dce5ec" fill="none"/>`);text(left-14,py+5,number(v),12,'#526475','text-anchor="end"');}
  text(64,280,'BPM',11);
  for(let i=0;i<=8;i++){const t=start+(end-start)*i/8,px=x(t);out.push(`<path d="M${px} ${top}V${bottom}" stroke="#e6ecf1" fill="none"/>`);text(px,681,time(t,end-start<10),12,'#526475','text-anchor="middle"');}
  function line(key){let d='',previous=null;for(const p of intervals){const value=p[key];if(!Number.isFinite(value)){previous=null;continue;}const broken=!previous||p.breakBefore||p.start>previous.end+.0001;d+=(broken?'M':'L')+x(p.end).toFixed(2)+' '+y(value).toFixed(2)+' ';previous=p;}return d;}
  out.push('<g clip-path="url(#reportPlot)">');
  out.push(`<path d="${line('bpm')}" fill="none" stroke="#9175cc" stroke-width="1.5"/><path d="${line('smoothed')}" fill="none" stroke="#088d7c" stroke-width="3" stroke-linejoin="round"/>`);
  const seen=new Set();
  for(const p of intervals){const px=x(p.end),py=Math.max(top+6,Math.min(bottom-6,y(p.bpm))),pixel=Math.round(px)+','+Math.round(py);if(seen.has(pixel))continue;seen.add(pixel);
   if(p.bpm<min||p.bpm>max){const dir=p.bpm>max?-1:1;out.push(`<path d="M${px} ${py+dir*5}L${px-5} ${py-dir*3}H${px+5}Z" fill="#bb7324"><title>${escape(number(p.bpm)+' BPM')}</title></path>`);}
   else if(p.expressive==='fermata'||p.expressive==='possible-fermata')out.push(`<path d="M${px} ${py-5}L${px+5} ${py}L${px} ${py+5}L${px-5} ${py}Z" fill="${p.expressive==='fermata'?'#a77cb7':'white'}" stroke="#a77cb7" stroke-width="1.5"/>`);
   else out.push(`<circle cx="${px}" cy="${py}" r="${intervals.length<160?3:1.6}" fill="${p.anomaly?'#bd7523':'#9175cc'}"/>`);
  }
  const starts=new Set(beats.map(b=>b.time)),measured=new Set(intervals.map(p=>p.end));
  for(const p of intervals.filter(p=>p.breakBefore&&starts.has(p.start)&&!measured.has(p.start))){
    const px=x(p.start),py=Math.max(top+6,Math.min(bottom-6,y(p.bpm)));
    out.push(`<rect x="${px-4}" y="${py-4}" width="8" height="8" rx="1.5" fill="white" stroke="#9175cc" stroke-width="1.5"><title>Ripresa: BPM dal beat successivo</title></rect>`);
  }
  out.push('</g>');rect(left,635,plotWidth,23,'#eef2f7',4);text(left-12,651,'Beat',10,'#526475','text-anchor="end"');
  const ticks=[],pixels=new Set();for(const b of beats){const px=Math.round(x(b.time));if(px<left||px>right||pixels.has(px))continue;pixels.add(px);ticks.push(`M${px} 641V652`);}out.push(`<path d="${ticks.join(' ')}" stroke="#9175cc"/>`);
  text(64,720,'● Beat',12,'#8064b5');text(163,720,'━ Tendenza',12,'#088d7c');
  if(intervals.some(p=>p.expressive==='fermata'||p.expressive==='possible-fermata'))text(310,720,'◆ Fermata · ◇ Possibile fermata',12,'#9467a4');
  if(intervals.some(p=>p.anomaly))text(580,720,'● Da verificare',12,'#a76722');
  const clipped=intervals.filter(p=>p.bpm<min||p.bpm>max).length;if(clipped)text(1376,720,clipped+' valori fuori scala · statistiche complete',12,'#a76722','text-anchor="end"');
  text(64,751,'SEZIONI',12,'#172d3b','font-weight="700" letter-spacing="1"');
  sections.forEach((s,i)=>{const px=64+(i%3)*444,py=770+Math.floor(i/3)*66,precise=s.end-s.start<10;rect(px,py,428,53,'#f3f6fa',7);text(px+14,py+22,String(i+1),13,'#0c8279','font-weight="700"');text(px+47,py+22,time(s.start,precise)+' — '+time(s.end,precise),13);text(px+408,py+33,number(s.bpm)+' BPM',19,'#172d3b','text-anchor="end" font-weight="700"');});
  if(!sections.length)text(64,779,'—',14);
  out.push('</g></svg>');return {svg:out.join(''),width,height};
 }
 return {create};
});
