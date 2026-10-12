/* Standalone SVG report; no DOM, fonts or external resources required. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./i18n.js'):root.TempoI18n);if(typeof module==='object'&&module.exports)module.exports=api;else root.TempoReport=api;})(globalThis,function(I18n){
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 const time=(value,precise=false)=>{const factor=precise?100:1,s=Math.max(0,Math.round((value||0)*factor));return Math.floor(s/(60*factor))+':'+(s%(60*factor)/factor).toFixed(precise?2:0).padStart(precise?5:2,'0');};
 function create(project,options={}){
  const language=options.language==='it'?'it':'en',t=(key,...values)=>I18n.translate(key,language,...values);
  const number=value=>Number.isFinite(value)?value.toLocaleString(language==='it'?'it-IT':'en-US',{maximumFractionDigits:1}):'—';
  const showBeats=options.showBeats===true;
  const perceived=estimate=>Number.isFinite(estimate?.bpm)?'≈ '+number(Math.round(estimate.bpm)):estimate?.status==='variable'?t('Variabile'):'—';
  const colors={trend:'#088d7c',accelerando:'#b75b12',rallentando:'#515fbd',fermata:'#9467a4'};
  const analysis=project.analysis||{},stats=analysis.stats||{},sections=analysis.sections||[],intervals=analysis.intervals||[],beats=project.beats||[];
  const width=1440,height=818+Math.max(1,Math.ceil(sections.length/3))*84,start=options.start||0,end=Math.max(start+.1,options.end||project.duration||30);
  const scale=options.scale||{min:0,max:Math.max(160,...intervals.map(p=>p.bpm))},min=scale.min,max=Math.max(min+1,scale.max);
  const left=94,right=1376,top=294,bottom=showBeats?618:652,plotWidth=right-left,plotHeight=bottom-top;
  const x=t=>left+(t-start)/(end-start)*plotWidth,y=bpm=>top+(max-bpm)/(max-min)*plotHeight;
  const out=[];
  const text=(x,y,value,size=14,fill='#526475',extra='')=>out.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escape(value)}</text>`);
  const rect=(x,y,w,h,fill,rx=0,extra='')=>out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`);
  out.push(`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escape(project.title||'Tempo Trace')}</title><desc>${escape(t('Andamento BPM, riepilogo e medie delle sezioni. Le interruzioni sono escluse dalle medie.'))}</desc><g font-family="DejaVu Sans,Arial,sans-serif">`);
  rect(0,0,width,height,'#f3f6fa');rect(32,32,width-64,height-64,'white',18);
  text(64,70,'TEMPO TRACE',14,'#0c8279','font-weight="700" letter-spacing="2"');
  text(1376,70,time(start,end-start<10)+' — '+time(end,end-start<10),14,'#526475','text-anchor="end"');
  const title=String(project.title||t('Esecuzione'));text(64,117,title.length>81?title.slice(0,80)+'…':title,27,'#172d3b','font-weight="700"');
  text(64,148,t('{0} beat · BPM in semiminime',beats.length),13);
  const cards=[['TEMPO DI BASE',perceived(stats.perceived)],['MEDIO',number(stats.mean)],['INIZIALE',number(stats.start)],['FINALE',number(stats.end)],['INTERVALLO',number(stats.min)+'–'+number(stats.max)]];
  cards.forEach(([name,value],i)=>{const px=64+i*265,cardWidth=252;rect(px,175,cardWidth,88,i===0?'#e8f7f3':'#f3f6fa',10);text(px+16,200,t(name),11,'#526475','letter-spacing="1"');text(px+16,239,value,i===4?24:i===0&&stats.perceived?.status==='variable'?23:29,i===0?'#087c6e':'#172d3b','font-weight="700"');if(i!==0||Number.isFinite(stats.perceived?.bpm))text(px+cardWidth-16,252,'BPM',10,'#526475','text-anchor="end"');});
  out.push(`<defs><clipPath id="reportPlot"><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/></clipPath></defs>`);
  sections.forEach((s,i)=>{const a=Math.max(start,s.start),b=Math.min(end,s.end);if(b>a)rect(x(a),top,x(b)-x(a),plotHeight,i%2?'#f7f5fc':'#f2faf8');});
  for(let i=0;i<=5;i++){const v=min+(max-min)*i/5,py=y(v);out.push(`<path d="M${left} ${py}H${right}" stroke="#dce5ec" fill="none"/>`);text(left-14,py+5,number(v),12,'#526475','text-anchor="end"');}
  text(64,280,'BPM',11);
  for(let i=0;i<=8;i++){const t=start+(end-start)*i/8,px=x(t);out.push(`<path d="M${px} ${top}V${bottom}" stroke="#e6ecf1" fill="none"/>`);text(px,681,time(t,end-start<10),12,'#526475','text-anchor="middle"');}
  function line(key){let d='',previous=null;for(const p of intervals){const value=p[key];if(!Number.isFinite(value)){previous=null;continue;}const broken=!previous||p.breakBefore||p.start>previous.end+.0001;d+=(broken?'M':'L')+x(p.end).toFixed(2)+' '+y(value).toFixed(2)+' ';previous=p;}return d;}
  out.push('<g clip-path="url(#reportPlot)">');
  // The trend alone is the default. Each segment inherits the expression of
  // its measured interval; starting a new group never bridges a recording gap.
  const paths=new Map(),present=new Set();
  let previous=null;
  for(const p of intervals){
   if(!Number.isFinite(p.smoothed)){previous=null;continue;}
   const broken=!previous||p.breakBefore||p.start>previous.end+.0001;
   const a=broken?{time:p.start,value:p.smoothed}:{time:previous.end,value:previous.smoothed};
   const kind=p.expressive==='accelerando'||p.expressive==='rallentando'?p.expressive:'trend';
   if(p.end>=start&&a.time<=end)present.add(kind);
   const segment=`M${x(a.time).toFixed(2)} ${y(a.value).toFixed(2)}L${x(p.end).toFixed(2)} ${y(p.smoothed).toFixed(2)} `;
   paths.set(kind,(paths.get(kind)||'')+segment);previous=p;
  }
  const holds=intervals.filter(p=>(p.expressive==='fermata'||p.expressive==='possible-fermata')&&p.end>=start&&p.start<=end);
  for(const p of holds){const a=x(Math.max(start,p.start)),b=x(Math.min(end,p.end));
   rect(a,top,b-a,plotHeight,colors.fermata,0,'opacity=".07"');
   out.push(`<path d="M${a} ${top+3}H${b}" fill="none" stroke="${colors.fermata}" stroke-width="3"${p.expressive==='possible-fermata'?' stroke-dasharray="4 4"':''}/>`);
  }
  if(showBeats)out.push(`<path data-raw-beats="true" d="${line('bpm')}" fill="none" stroke="#9175cc" stroke-width="1" opacity=".65"/>`);
  for(const [kind,d] of paths)out.push(`<path data-expression="${kind}" d="${d}" fill="none" stroke="${colors[kind]}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>`);
  if(showBeats){
  const seen=new Set();
  for(const p of intervals){const px=x(p.end),py=Math.max(top+6,Math.min(bottom-6,y(p.bpm))),pixel=Math.round(px)+','+Math.round(py);if(seen.has(pixel))continue;seen.add(pixel);
   if(p.bpm<min||p.bpm>max){const dir=p.bpm>max?-1:1;out.push(`<path d="M${px} ${py+dir*5}L${px-5} ${py-dir*3}H${px+5}Z" fill="#bb7324"><title>${escape(number(p.bpm)+' BPM')}</title></path>`);}
   else if(p.expressive==='fermata'||p.expressive==='possible-fermata')out.push(`<path d="M${px} ${py-5}L${px+5} ${py}L${px} ${py+5}L${px-5} ${py}Z" fill="${p.expressive==='fermata'?'#a77cb7':'white'}" stroke="#a77cb7" stroke-width="1.5"/>`);
   else out.push(`<circle cx="${px}" cy="${py}" r="${intervals.length<160?3:1.6}" fill="${p.anomaly?'#bd7523':'#9175cc'}"/>`);
  }
  const starts=new Set(beats.map(b=>b.time)),measured=new Set(intervals.map(p=>p.end));
  for(const p of intervals.filter(p=>p.breakBefore&&starts.has(p.start)&&!measured.has(p.start))){
    const px=x(p.start),py=Math.max(top+6,Math.min(bottom-6,y(p.bpm)));
    out.push(`<rect x="${px-4}" y="${py-4}" width="8" height="8" rx="1.5" fill="white" stroke="#9175cc" stroke-width="1.5"><title>${escape(t('Ripresa: BPM dal beat successivo'))}</title></rect>`);
  }
  }
  out.push('</g>');
  if(showBeats){rect(left,635,plotWidth,23,'#eef2f7',4);text(left-12,651,'Beat',10,'#526475','text-anchor="end"');
  const ticks=[],pixels=new Set();for(const b of beats){const px=Math.round(x(b.time));if(px<left||px>right||pixels.has(px))continue;pixels.add(px);ticks.push(`M${px} 641V652`);}out.push(`<path d="${ticks.join(' ')}" stroke="#9175cc"/>`);
  }
  let legendX=64;
  const legend=(label,color,width,dashed=false)=>{out.push(`<path d="M${legendX} 716h22" stroke="${color}" stroke-width="3"${dashed?' stroke-dasharray="4 4"':''}/>`);text(legendX+30,720,t(label),12,color);legendX+=width;};
  legend('Tendenza',colors.trend,130);
  if(present.has('accelerando'))legend('Accelerando',colors.accelerando,172);
  if(present.has('rallentando'))legend('Rallentando',colors.rallentando,172);
  if(holds.some(p=>p.expressive==='fermata'))legend('Fermata',colors.fermata,130);
  if(holds.some(p=>p.expressive==='possible-fermata'))legend('Possibile fermata',colors.fermata,192,true);
  if(showBeats){legend('Beat','#8064b5',105);if(intervals.some(p=>p.anomaly))legend('Da verificare','#a76722',130);}
  const clipped=intervals.filter(p=>{const value=showBeats?p.bpm:p.smoothed;return p.end>=start&&p.end<=end&&(value<min||value>max);}).length;
  if(clipped)text(1376,744,t('{0} valori fuori scala · statistiche complete',clipped),11,'#a76722','text-anchor="end"');
  text(64,751,t('SEZIONI'),12,'#172d3b','font-weight="700" letter-spacing="1"');
  sections.forEach((s,i)=>{const px=64+(i%3)*444,py=770+Math.floor(i/3)*84,precise=s.end-s.start<10;rect(px,py,428,71,'#f3f6fa',7);text(px+14,py+20,String(i+1),12,'#0c8279','font-weight="700"');text(px+45,py+20,time(s.start,precise)+' — '+time(s.end,precise),12);text(px+14,py+48,t('Base'),10);text(px+67,py+50,perceived(s.perceived),s.perceived?.status==='variable'?13:18,'#087c6e','font-weight="700"');text(px+237,py+48,t('Medio'),10);text(px+410,py+50,number(s.bpm)+' BPM',18,'#172d3b','text-anchor="end" font-weight="700"');});
  if(!sections.length)text(64,779,'—',14);
  out.push('</g></svg>');return {svg:out.join(''),width,height};
 }
 return {create};
});
