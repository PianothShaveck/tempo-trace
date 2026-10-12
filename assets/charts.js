/* Tempo Trace — responsive, dependency-free SVG timelines. */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const palette = {bg:'#101820',grid:'#243341',muted:'#91a1b3',text:'#eaf3f8',teal:'#69e1cb',violet:'#b1a1ff',amber:'#ffbf69',lavender:'#d5b4ff'};
  let chartSerial = 0;
  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const isAutomatic = beat => beat && beat.source === 'auto';
  const isLowAutomatic = beat => isAutomatic(beat) && finite(beat.confidence) && Number(beat.confidence) < .45;
  const isHold = interval => interval && (interval.expressive === 'fermata' || interval.expressive === 'possible-fermata');
  const expressionNames = {accelerando:'Accelerando',rallentando:'Rallentando',fermata:'Fermata', 'possible-fermata':'Possibile fermata'};
  function node(tag, attrs, text) {
    const element = document.createElementNS(NS, tag);
    if (attrs) for (const [key, value] of Object.entries(attrs)) if (value != null) element.setAttribute(key, String(value));
    if (text != null) element.textContent = text;
    return element;
  }
  function timeLabel(seconds, precise) {
    const raw = Math.max(0, Number(seconds) || 0);
    const value = precise ? Math.round(raw * 1000) / 1000 : raw;
    const minutes = Math.floor(value / 60);
    const sec = precise ? (value % 60).toFixed(3).padStart(6, '0') : Math.floor(value % 60).toString().padStart(2, '0');
    return `${minutes}:${sec}`;
  }
  function stepSize(span, target) {
    const rough = span / Math.max(1, target);
    if (!(rough > 0)) return 1;
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const part = rough / power;
    return (part <= 1 ? 1 : part <= 2 ? 2 : part <= 2.5 ? 2.5 : part <= 5 ? 5 : 10) * power;
  }
  function timeStep(span, target) {
    const rough = span / Math.max(1,target);
    return [.1,.2,.5,1,2,5,10,15,30,60,120,300,600,900,1800,3600].find(value => value >= rough) || stepSize(span,target);
  }
  function nearestIndex(items, value, getTime) {
    let low = 0, high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (getTime(items[middle]) < value) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return 0;
    if (low === items.length) return items.length - 1;
    return Math.abs(getTime(items[low]) - value) < Math.abs(getTime(items[low - 1]) - value) ? low : low - 1;
  }
  function tempoScale(intervals, limits) {
    const values=intervals.flatMap(p=>[p.bpm,p.smoothed]).filter(v=>finite(v)&&Number(v)>0).map(Number).sort((a,b)=>a-b);
    let low=values[0]??60, high=values.at(-1)??120;
    if(values.length>=12){
      const q10=values[Math.floor((values.length-1)*.1)],q90=values[Math.ceil((values.length-1)*.9)];
      const margin=Math.max((q90-q10)*2,q90*.25,8);
      low=Math.max(low,q10-margin);high=Math.min(high,q90+margin);
    }
    const pad=Math.max((high-low)*.16,high*.035,4),step=stepSize(high-low+2*pad,5);
    let min=Math.max(0,Math.floor((low-pad)/step)*step),max=Math.ceil((high+pad)/step)*step;
    if(limits&&finite(limits.min)&&finite(limits.max)&&limits.max>limits.min){min=Number(limits.min);max=Number(limits.max);}
    return {min,max,step:stepSize(max-min,5),clipped:intervals.filter(p=>p.bpm<min||p.bpm>max).length};
  }
  function create(svg, callbacks, waveform) {
    callbacks = callbacks || {};
    const serial = ++chartSerial;
    let state = {}, geometry = null, points = [], anchors = [], visibleBeats = [], intervalsByBeat = new Map(), beatsById = new Map(), drag = null, panDrag = null, disposed = false;
    let playhead = null, playheadDot = null, tooltip = null, tooltipText = null, tooltipBox = null, dragGhost = null;
    let resizeFrame = null, lastWidth = 0;
    const titleId = `tempo-chart-title-${serial}`, descriptionId = `tempo-chart-desc-${serial}`;
    svg.setAttribute('xmlns', NS);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-labelledby', `${titleId} ${descriptionId}`);
    svg.style.touchAction = waveform?'pan-y':'none';
    svg.style.userSelect = 'none';

    function localPoint(event) {
      // Fixed CSS heights can letterbox an SVG; the inverse CTM includes that offset.
      const matrix = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
      if (matrix && typeof matrix.inverse === 'function') {
        const inverse = matrix.inverse();
        return {x: inverse.a * event.clientX + inverse.c * event.clientY + inverse.e, y: inverse.b * event.clientX + inverse.d * event.clientY + inverse.f};
      }
      const rect = svg.getBoundingClientRect();
      const scale = Math.min((rect.width || geometry.width) / geometry.width, (rect.height || geometry.height) / geometry.height);
      return {x: (event.clientX - rect.left - (rect.width - geometry.width * scale) / 2) / scale, y: (event.clientY - rect.top - (rect.height - geometry.height * scale) / 2) / scale};
    }
    function label(x,y,text,attrs) {
      return node('text',Object.assign({x,y,fill:palette.muted,'font-size':11,'font-family':'system-ui, sans-serif','font-variant-numeric':'tabular-nums'},attrs),text);
    }
    function showTooltip(x,y,text,detail) {
      if (!tooltip || !geometry) return;
      const width = clamp(Math.max(text.length, (detail || '').length) * 6.6 + 20,90,geometry.width - 12);
      const left = clamp(x - width / 2,6,geometry.width - width - 6);
      const maxCharacters = Math.max(10, Math.floor((width - 20) / 6.6));
      const lines=[text.length > maxCharacters ? text.slice(0, maxCharacters - 1) + '…' : text];
      if (detail) {
        let line='';
        for (const word of detail.split(' ')) {
          if (line && (line+' '+word).length>maxCharacters) { lines.push(line);line=word; }
          else line+=(line?' ':'')+word;
        }
        if(line) lines.push(line);
      }
      const height=13+lines.length*16;
      const top = y > height+26 ? y-height-12 : y+18;
      tooltip.setAttribute('transform', `translate(${left} ${clamp(top,4,Math.max(4,geometry.height-height-4))})`);
      tooltipBox.setAttribute('width',width);tooltipBox.setAttribute('height',height);
      tooltipText.replaceChildren();
      lines.forEach((line,index)=>tooltipText.append(node('tspan',{x:10,y:19+index*16,fill:index?palette.violet:palette.text},line)));
      tooltip.setAttribute('visibility','visible');
    }
    function hideTooltip() { if (tooltip) tooltip.setAttribute('visibility','hidden'); }
    function updatePlayhead(time) {
      if (!geometry || !playhead) return;
      const visible = finite(time) && Number(time) >= geometry.start && Number(time) <= geometry.end;
      playhead.setAttribute('visibility',visible ? 'visible':'hidden');
      if (playheadDot) playheadDot.setAttribute('visibility',visible ? 'visible':'hidden');
      if (!visible) return;
      const x = geometry.x(Number(time));
      playhead.setAttribute('x1',x); playhead.setAttribute('x2',x);
      if (playheadDot) playheadDot.setAttribute('cx',x);
    }
    function render(nextState) {
      if (disposed) return;
      state = nextState || {};
      beatsById = waveform ? new Map() : new Map((state.beats || []).map(beat => [String(beat.id),beat]));
      const rect = svg.getBoundingClientRect();
      const width = Math.max(waveform ? 120 : 320, Math.round(rect.width || svg.clientWidth || 1100));
      lastWidth = Math.round(rect.width);
      const height = waveform ? Math.max(56, Math.round(rect.height || 112)) : (width < 560 ? 350 : 420);
      if(!waveform)svg.style.height=height+'px';
      const left = waveform ? 14 : 49, right = 18, top = waveform ? 9 : 34, bottom = waveform ? 23 : 90;
      const start = Math.max(0, Number(state.viewStart) || 0);
      const end = Math.max(start + .05, Number(state.viewEnd) || Number(state.duration) || 30);
      const plotWidth = width-left-right, plotHeight = height-top-bottom;
      const x = value => left + (value-start)/(end-start)*plotWidth;
      let rawPoints = (state.analysis && state.analysis.intervals || []).filter(item => finite(item.bpm) && Number(item.bpm)>0 && finite(item.end));
      const inView = rawPoints.filter(item => Number(item.end)>=start && Number(item.end)<=end);
      intervalsByBeat = new Map(rawPoints.map(interval => [String(interval.beatId), interval]));
      const beatsByTime=new Map((state.beats||[]).map(b=>[b.time,b]));
      anchors=waveform?[]:rawPoints.filter(p=>p.breakBefore&&p.start>=start&&p.start<=end).map(p=>({beat:beatsByTime.get(p.start),next:p,time:p.start})).filter(a=>a.beat&&!intervalsByBeat.has(String(a.beat.id)));
      const scale=tempoScale([...new Set([...inView,...anchors.map(a=>a.next)])],state.yRange),min=scale.min,max=scale.max,yStep=scale.step;
      const y = value => top + (max-value)/(max-min)*plotHeight;
      geometry = {width,height,left,right,top,bottom,start,end,plotWidth,plotHeight,x,y,min,max,laneY:height-50};
      if(!waveform&&callbacks.onScale)callbacks.onScale(scale);
      svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
      svg.setAttribute('preserveAspectRatio','xMidYMid meet');
      svg.replaceChildren();
      svg.append(node('title',{id:titleId},waveform ? 'Forma d’onda e posizione di ascolto' : 'Andamento dei BPM nel tempo'));
      svg.append(node('desc',{id:descriptionId},waveform ? 'Clicca sulla traccia per spostare la riproduzione. Questa traccia non modifica i beat.' : 'BPM grezzi in viola, andamento smussato in verde, anomalie in arancione. Le fermate sono rombi lilla: pieni se confermati, vuoti se possibili. I cerchi vuoti viola indicano beat automatici da rivedere. La riga Beat rende visibili tutte le posizioni. I quadrati di ripresa usano il BPM del beat successivo. Trascina lo sfondo per spostare la vista orizzontalmente e verticalmente. Seleziona un beat, poi trascinalo per correggerlo. Se i punti sono ravvicinati, il clic li ingrandisce. Le correzioni sono disponibili anche nei controlli numerici.'));
      svg.append(node('rect',{width,height,fill:palette.bg,rx:12}));
      const defs = node('defs');
      const clip = node('clipPath',{id:`tempo-clip-${serial}`});
      clip.append(node('rect',{x:left,y:top-9,width:plotWidth,height:plotHeight+10})); defs.append(clip);
      const gradient = node('linearGradient',{id:`tempo-gradient-${serial}`,x1:'0%',y1:'0%',x2:'100%',y2:'0%'});
      gradient.append(node('stop',{offset:'0%','stop-color':'#93eedc'}),node('stop',{offset:'100%','stop-color':'#49bfc3'})); defs.append(gradient); svg.append(defs);
      if (!waveform) {
        const sections = state.analysis && state.analysis.sections || [];
        sections.forEach((section,index) => {
          const a=Math.max(start,Number(section.start)), b=Math.min(end,Number(section.end));
          if (b<=a) return;
          const sectionWidth=x(b)-x(a);
          svg.append(node('rect',{x:x(a),y:top,width:sectionWidth,height:plotHeight,fill:index%2 ? palette.violet:palette.teal,opacity:.035}));
          if (Number(section.start)>start) svg.append(node('line',{x1:x(a),x2:x(a),y1:top-5,y2:height-bottom,stroke:palette.muted,'stroke-opacity':.25,'stroke-dasharray':'3 5'}));
          if (sectionWidth>52) {
            const number = String(index+1);
            svg.append(node('rect',{x:x(a)+7,y:8,width:number.length>1 ? 24:20,height:18,rx:6,fill:palette.grid}));
            svg.append(label(x(a)+7+(number.length>1 ? 12:10),21,number,{'text-anchor':'middle',fill:palette.text,'font-size':10}));
          }
        });
        for (let tick=0;tick<=6;tick++) {
          const value=min+tick*yStep;if(value>max+yStep*.001)break;
          svg.append(node('line',{x1:left,x2:width-right,y1:y(value),y2:y(value),stroke:palette.grid,'stroke-width':1}));
          svg.append(label(left-10,y(value)+4,String(Math.round(value*10)/10),{'text-anchor':'end'}));
        }
        svg.append(label(left-10,18,'BPM',{'text-anchor':'end','font-size':10}));
      }
      const xStep=timeStep(end-start,Math.floor(plotWidth/95));
      let lastLabelX=-Infinity;
      for (let value=Math.ceil((start-1e-8)/xStep)*xStep;value<=end+1e-8;value+=xStep) {
        const pos=x(value);
        if (!waveform) svg.append(node('line',{x1:pos,x2:pos,y1:top,y2:height-bottom,stroke:palette.grid,'stroke-opacity':.45}));
        if (pos-lastLabelX>55 && pos<width-27) {
          const rounded = Math.round(value * 10) / 10;
          const text = xStep < 1 ? timeLabel(rounded,false) + '.' + (Math.round(rounded * 10) % 10) : timeLabel(Math.round(value),false);
          svg.append(label(pos,height-9,text,{'text-anchor':'middle','font-size':10})); lastLabelX=pos;
        }
      }
      const plot=node('g',{'clip-path':`url(#tempo-clip-${serial})`}); svg.append(plot);
      visibleBeats=(state.beats || []).filter(beat => finite(beat.time) && Number(beat.time)>=start && Number(beat.time)<=end);
      points=inView;
      if (waveform) drawWaveform(plot);
      else {drawTempo(plot,rawPoints);drawBeatLane();}
      playhead=node('line',{x1:0,x2:0,y1:top-6,y2:waveform?height-bottom:height-29,stroke:palette.text,'stroke-opacity':.75,'stroke-width':1.4,'pointer-events':'none'});
      playheadDot=node('circle',{cx:0,cy:top-5,r:3,fill:palette.text,'pointer-events':'none'});
      svg.append(playhead,playheadDot);
      dragGhost=node('g',{visibility:'hidden','pointer-events':'none'});
      dragGhost.append(node('line',{y1:top-5,y2:waveform?height-bottom:height-29,stroke:palette.text,'stroke-width':1.5,'stroke-dasharray':'3 3'})); svg.append(dragGhost);
      tooltip=node('g',{visibility:'hidden','pointer-events':'none','aria-hidden':'true'});
      tooltipBox=node('rect',{height:29,rx:7,fill:'#1b2a36',stroke:'#3a5061','stroke-width':1});
      tooltipText=label(10,19,'',{fill:palette.text,'font-size':11}); tooltip.append(tooltipBox,tooltipText); svg.append(tooltip);
      updatePlayhead(state.currentTime || 0);
    }
    function drawTempo(plot,allPoints) {
      const g=geometry;
      // Include one point on either side to avoid clipping the visible line at zoom edges.
      const before=allPoints.filter(p => Number(p.end)<g.start).slice(-1);
      const after=allPoints.filter(p => Number(p.end)>g.end).slice(0,1);
      const candidates=before.concat(points,after);
      // Keep first/last and each column's extrema so narrow tempo spikes survive decimation.
      const limit=Math.max(250,Math.floor(g.plotWidth*2));
      let retained=candidates;
      if (candidates.length>limit) {
        const result=new Set([0,candidates.length-1]);
        const bucketSize=Math.ceil(candidates.length/(limit/4));
        for(let start=0;start<candidates.length;start+=bucketSize) {
          let low=start,high=start;
          const last=Math.min(candidates.length,start+bucketSize);
          for(let i=start;i<last;i++) {
            if(candidates[i].bpm<candidates[low].bpm) low=i;
            if(candidates[i].bpm>candidates[high].bpm) high=i;
            if(candidates[i].anomaly || isHold(candidates[i]) || candidates[i].breakBefore) result.add(i);
            if(i>0 && Number(candidates[i].start)>Number(candidates[i-1].end)+1e-5) {result.add(i);result.add(i-1);}
          }
          result.add(start);result.add(last-1);result.add(low);result.add(high);
        }
        retained=Array.from(result).sort((a,b)=>a-b).map(i=>candidates[i]);
      }
      function pathFor(key) {
        let path='',previous=null;
        for(const p of retained) {
          const value=Number(p[key]);
          if (!finite(p[key]) || value<=0) {previous=null;continue;}
          // breakBefore comes from analysis; the adjacency check handles imported/older data.
          const broken=!previous || p.breakBefore || (Number(p.start)>Number(previous.end)+1e-5 && !retained._decimated);
          const command=broken?'M':'L';
          path+=`${command}${g.x(Number(p.end)).toFixed(2)},${g.y(value).toFixed(2)} `;
          previous=p;
        }
        return path;
      }
      // A skipped point is not a musical break: annotate decimated data, then use explicit gap markers.
      if(retained!==candidates) {
        let previousFull=null;
        const gapEnds=new Set();
        for(const p of candidates) {
          if(p.breakBefore || previousFull && Number(p.start)>Number(previousFull.end)+1e-5) gapEnds.add(p);
          previousFull=p;
        }
        retained=retained.map(p=>gapEnds.has(p)&&!p.breakBefore?Object.assign({},p,{breakBefore:true}):p);
        retained._decimated=true;
      }
      if(state.showRaw!==false) plot.append(node('path',{d:pathFor('bpm'),fill:'none',stroke:palette.violet,'stroke-opacity':.73,'stroke-width':1.5,'stroke-linecap':'round','stroke-linejoin':'round'}));
      if(state.showSmooth!==false) plot.append(node('path',{d:pathFor('smoothed'),fill:'none',stroke:`url(#tempo-gradient-${serial})`,'stroke-width':2.7,'stroke-linecap':'round','stroke-linejoin':'round'}));
      if(state.showRaw!==false){
        const marks=[],seen=new Set();
        for(const p of points){
          if(p.anomaly||isHold(p)||isLowAutomatic(beatsById.get(String(p.beatId))))continue;
          const px=g.x(p.end),py=markerY(p.bpm),key=Math.round(px)+','+Math.round(py);
          if(seen.has(key))continue;seen.add(key);
          const r=points.length>g.plotWidth/7?2:3.5;
          marks.push(`M${px+r},${py}a${r},${r} 0 1,0 ${-2*r},0a${r},${r} 0 1,0 ${2*r},0Z`);
        }
        if(marks.length)plot.append(node('path',{d:marks.join(' '),fill:palette.violet,stroke:palette.bg,'stroke-width':1}));
      }
      // Review markers use every original point, independently of line decimation.
      // One compound path avoids thousands of DOM nodes on dense automatic tracks.
      const reviewGlyphs=[],reviewPixels=new Set();
      for (const p of points) {
        if (p.anomaly || isHold(p) || String(p.beatId)===String(state.selectedId) || !isLowAutomatic(beatsById.get(String(p.beatId)))) continue;
        const px=g.x(Number(p.end)),py=markerY(Number(p.bpm)),pixel=Math.round(px)+','+Math.round(py);
        if(reviewPixels.has(pixel)) continue; reviewPixels.add(pixel);
        reviewGlyphs.push(`M${(px+4.1).toFixed(2)},${py.toFixed(2)}a4.1,4.1 0 1,0 -8.2,0a4.1,4.1 0 1,0 8.2,0Z`);
      }
      if(reviewGlyphs.length) {
        const reviews=node('path',{d:reviewGlyphs.join(' '),fill:palette.bg,stroke:palette.violet,'stroke-width':1.5});
        reviews.append(node('title',null,'Automatico · da rivedere'));plot.append(reviews);
      }
      const anomalies=points.filter(p=>p.anomaly && !isHold(p));
      for(const p of anomalies) {
        const px=g.x(Number(p.end)), py=markerY(Number(p.bpm));
        plot.append(node('circle',{cx:px,cy:py,r:5.3,fill:palette.bg,stroke:palette.amber,'stroke-width':1.8}));
        plot.append(node('circle',{cx:px,cy:py,r:1.6,fill:palette.amber}));
      }
      for (const p of points.filter(isHold)) {
        const px=g.x(Number(p.end)), py=markerY(Number(p.bpm)), confirmed=p.expressive==='fermata';
        const diamond=node('path',{d:`M${px},${py-6}L${px+6},${py}L${px},${py+6}L${px-6},${py}Z`,fill:confirmed?palette.lavender:palette.bg,stroke:palette.lavender,'stroke-width':1.8});
        diamond.append(node('title',null,expressionNames[p.expressive])); plot.append(diamond);
      }
      // Only sustained holds receive a small span annotation; ramps stay uncluttered.
      // Keep it inside the plot, below the separate numbered-section strip.
      for (const p of allPoints.filter(isHold)) {
        const a=Math.max(g.start,Number(p.start)), b=Math.min(g.end,Number(p.end));
        if (!(b>a)) continue;
        const span=g.x(b)-g.x(a), confirmed=p.expressive==='fermata';
        if (span<(confirmed?72:88)) continue;
        const group=node('g',{'pointer-events':'none'});
        group.append(node('path',{d:`M${g.x(a)},${g.top+11}V${g.top+16}H${g.x(b)}V${g.top+11}`,fill:'none',stroke:palette.lavender,'stroke-opacity':.65,'stroke-width':1,'stroke-dasharray':'3 4'}));
        group.append(label((g.x(a)+g.x(b))/2,g.top+8,confirmed?'Fermata':'Fermata?',{'text-anchor':'middle',fill:palette.lavender,'font-size':10}));
        plot.append(group);
      }
      for(const p of points.filter(p=>p.bpm<g.min||p.bpm>g.max)){
        const px=g.x(p.end),py=markerY(p.bpm),direction=p.bpm>g.max?-1:1;
        plot.append(node('path',{d:`M${px},${py+direction*5}L${px-5},${py-direction*3}H${px+5}Z`,fill:palette.amber}));
      }
      const selected=points.find(p=>String(p.beatId)===String(state.selectedId));
      if(selected) {
        const px=g.x(Number(selected.end)),py=markerY(Number(selected.bpm));
        plot.append(node('line',{x1:px,x2:px,y1:g.top,y2:g.height-g.bottom,stroke:palette.teal,'stroke-opacity':.4,'stroke-dasharray':'3 4'}));
        plot.append(node('circle',{cx:px,cy:py,r:7,fill:palette.bg,stroke:palette.teal,'stroke-width':2.3}));
        plot.append(node('circle',{cx:px,cy:py,r:2.5,fill:palette.text}));
      }
      for(const anchor of anchors){
        const px=g.x(anchor.time),py=markerY(anchor.next.bpm),selected=String(anchor.beat.id)===String(state.selectedId);
        const marker=node('rect',{x:px-5,y:py-5,width:10,height:10,rx:2,fill:palette.bg,stroke:selected?palette.teal:palette.violet,'stroke-width':selected?2.5:1.8,'data-anchor-beat':anchor.beat.id});
        marker.append(node('title',null,'Ripresa · BPM dal beat successivo'));plot.append(marker);
      }
    }
    function markerY(bpm){return clamp(geometry.y(bpm),geometry.top+7,geometry.height-geometry.bottom-7);}
    function drawBeatLane(){
      const g=geometry,lane=node('g',{'data-beat-lane':'true'});
      lane.append(node('rect',{x:g.left,y:g.laneY-20,width:g.plotWidth,height:44,rx:6,fill:'#192735'}));
      lane.append(label(g.left-8,g.laneY+4,'Beat',{'text-anchor':'end','font-size':10}));
      const marks={normal:[],review:[]},seen=new Set();
      const all=state.beats||[],first=all.findIndex(b=>b===visibleBeats[0]);
      for(let i=0;i<visibleBeats.length;i++){
        const beat=visibleBeats[i],px=g.x(beat.time),selected=String(beat.id)===String(state.selectedId),pixel=Math.round(px);
        if(seen.has(pixel)&&!selected)continue;seen.add(pixel);
        if(selected)lane.append(node('rect',{x:px-5,y:g.laneY-10,width:10,height:20,rx:3,fill:palette.teal,stroke:palette.text,'stroke-width':1,'data-selected-beat':beat.id}));
        else marks[isLowAutomatic(beat)?'review':'normal'].push(`M${px},${g.laneY-7}V${g.laneY+7}`);
        const gap=Math.min(i?px-g.x(visibleBeats[i-1].time):Infinity,i+1<visibleBeats.length?g.x(visibleBeats[i+1].time)-px:Infinity);
        if(gap>34)lane.append(label(px,g.laneY+20,String(first+i+1),{'text-anchor':'middle','font-size':9,fill:selected?palette.teal:palette.muted}));
      }
      for(const kind of ['normal','review'])if(marks[kind].length)lane.append(node('path',{d:marks[kind].join(' '),stroke:palette.violet,'stroke-width':2,'stroke-dasharray':kind==='review'?'2 2':null,fill:'none'}));
      svg.append(lane);
    }
    function drawWaveform(plot) {
      const g=geometry, center=g.top+g.plotHeight/2;
      plot.append(node('line',{x1:g.left,x2:g.width-g.right,y1:center,y2:center,stroke:palette.grid}));
      const peaks=state.peaks;
      if (peaks && peaks.length && Number(state.duration)>0) {
        const count=Math.max(1,Math.floor(g.plotWidth/2));
        const fullDuration=Number(state.duration);
        let path='';
        for(let i=0;i<count;i++) {
          const fromTime=g.start+i/count*(g.end-g.start), toTime=g.start+(i+1)/count*(g.end-g.start);
          const a=clamp(Math.floor(fromTime/fullDuration*peaks.length),0,peaks.length-1);
          const b=clamp(Math.ceil(toTime/fullDuration*peaks.length),a+1,peaks.length);
          let low=0,high=0;
          for(let j=a;j<b;j++) {
            const peak=peaks[j];
            if(Array.isArray(peak) || ArrayBuffer.isView(peak)) { low=Math.min(low,Number(peak[0])||0);high=Math.max(high,Number(peak[1])||0); }
            else {const amplitude=Math.abs(Number(peak)||0);low=Math.min(low,-amplitude);high=Math.max(high,amplitude);}
          }
          const px=g.left+(i+.5)/count*g.plotWidth, scale=g.plotHeight*.45;
          path+=`M${px.toFixed(1)},${(center-clamp(high,0,1)*scale).toFixed(1)}V${(center-clamp(low,-1,0)*scale).toFixed(1)} `;
        }
        plot.append(node('path',{d:path,stroke:'#668d9a','stroke-width':1.2,'stroke-opacity':.78,fill:'none'}));
      }
      if(finite(state.detailStart)&&finite(state.detailEnd)&&state.detailEnd-state.detailStart<g.end-g.start-.01){
        plot.append(node('rect',{x:g.x(state.detailStart),y:g.top,width:Math.max(1,g.x(state.detailEnd)-g.x(state.detailStart)),height:g.plotHeight,fill:palette.teal,'fill-opacity':.08,stroke:palette.teal,'stroke-opacity':.5,'pointer-events':'none'}));
      }
    }
    function hit(point) {
      if(!geometry || point.x<geometry.left-8 || point.x>geometry.width-geometry.right+8) return null;
      const time=geometry.start+(point.x-geometry.left)/geometry.plotWidth*(geometry.end-geometry.start);
      if(waveform)return null;
      let chosen=null,best=14;
      if(visibleBeats.length&&Math.abs(point.y-geometry.laneY)<22){
        const beat=visibleBeats[nearestIndex(visibleBeats,time,p=>Number(p.time))];
        if(Math.abs(geometry.x(beat.time)-point.x)<12)return {id:beat.id,time:beat.time,y:geometry.laneY,beat,interval:intervalsByBeat.get(String(beat.id)),anchor:anchors.find(a=>String(a.beat.id)===String(beat.id))};
      }
      for(const anchor of anchors){
        const py=markerY(anchor.next.bpm),distance=Math.hypot(geometry.x(anchor.time)-point.x,py-point.y);
        if(distance<best){best=distance;chosen={id:anchor.beat.id,beat:anchor.beat,time:anchor.time,y:py,anchor};}
      }
      if(!points.length) return chosen;
      const index=nearestIndex(points,time,p=>Number(p.end));
      for(let i=Math.max(0,index-2);i<=Math.min(points.length-1,index+2);i++) {
        const item=points[i], px=geometry.x(Number(item.end));
        const rawY=markerY(Number(item.bpm));
        const distance=state.showRaw===false?Infinity:Math.hypot(px-point.x,rawY-point.y);
        if(distance<best) {best=distance;chosen={id:item.beatId,time:Number(item.end),y:rawY,interval:item};}
      }
      return chosen;
    }
    function pointerDown(event) {
      if(!geometry || event.button!==0 || !Number(state.duration)) return;
      const point=localPoint(event);
      if(point.x<geometry.left || point.x>geometry.width-geometry.right || point.y<geometry.top-10 || point.y>(waveform?geometry.height-geometry.bottom+5:geometry.laneY+23)) return;
      const found=waveform?null:hit(point);
      if(found) {
        callbacks.onEditStart?.();
        const beats=state.beats||[],index=beats.findIndex(b=>String(b.id)===String(found.id));
        const previous=index>0?Number(beats[index-1].time):0;
        const next=index>=0&&index<beats.length-1?Number(beats[index+1].time):Number(state.duration);
        const gap=Math.min(index>0?geometry.x(found.time)-geometry.x(previous):Infinity,index<beats.length-1?geometry.x(next)-geometry.x(found.time):Infinity);
        const safety=Math.min(.08,Math.min(index>0?found.time-previous:Infinity,index<beats.length-1?next-found.time:Infinity)*.25);
        drag={canMove:String(found.id)===String(state.selectedId)&&gap>=14,dense:gap<14,id:found.id,originalTime:found.time,time:found.time,y:found.y,startX:point.x,startY:point.y,moved:false,pointerId:event.pointerId,min:previous+(index>0?safety:0),max:next-(index>=0&&index<beats.length-1?safety:0)};
        svg.setPointerCapture(event.pointerId);
        event.preventDefault();
      } else {
        const time=clamp(geometry.start+(point.x-geometry.left)/geometry.plotWidth*(geometry.end-geometry.start),0,Number(state.duration));
        if(waveform){if(callbacks.onSeek)callbacks.onSeek(time);}
        else{
          panDrag={x:point.x,y:point.y,start:geometry.start,end:geometry.end,min:geometry.min,max:geometry.max,time,moved:false,pointerId:event.pointerId};
          svg.setPointerCapture(event.pointerId);event.preventDefault();
        }
      }
    }
    function pointerMove(event) {
      if(!geometry) return;
      const point=localPoint(event);
      if(panDrag){
        if(event.pointerId!==panDrag.pointerId)return;
        const dx=point.x-panDrag.x,dy=point.y-panDrag.y;
        if(!panDrag.moved&&Math.hypot(dx,dy)<=6)return;
        if(!panDrag.moved)callbacks.onEditStart?.();panDrag.moved=true;
        const dt=-dx/geometry.plotWidth*(panDrag.end-panDrag.start),db=dy/geometry.plotHeight*(panDrag.max-panDrag.min);
        callbacks.onPan?.({start:panDrag.start+dt,end:panDrag.end+dt,min:panDrag.min+db,max:panDrag.max+db,vertical:Math.abs(dy)>6});
        svg.style.cursor='grabbing';hideTooltip();
      }else if(drag) {
        if(!drag.canMove)return;
        if(Math.abs(point.x-drag.startX)>6) drag.moved=true;
        drag.time=clamp(geometry.start+(point.x-geometry.left)/geometry.plotWidth*(geometry.end-geometry.start),drag.min,drag.max);
        const px=geometry.x(drag.time);
        if(drag.moved) {dragGhost.setAttribute('visibility','visible');dragGhost.setAttribute('transform',`translate(${px},0)`);}
        showTooltip(px,drag.y,timeLabel(drag.time,true)+' · '+Math.round((drag.time-drag.originalTime)*1000)+' ms');
        svg.style.cursor='ew-resize';
      } else {
        if(waveform){const time=clamp(geometry.start+(point.x-geometry.left)/geometry.plotWidth*(geometry.end-geometry.start),0,Number(state.duration));svg.style.cursor='pointer';showTooltip(point.x,geometry.top,timeLabel(time,true));return;}
        const found=hit(point);
        svg.style.cursor=found?(String(found.id)===String(state.selectedId)?'ew-resize':'pointer'):'grab';
        if(found) {
          const interval=found.interval || (waveform ? intervalsByBeat.get(String(found.id)) : null);
          const expression=interval && expressionNames[interval.expressive] || (found.beat && found.beat.fermataBefore ? 'Fermata' : '');
          const suspicious=interval && interval.anomaly && !isHold(interval) ? interval.anomaly : '';
          const annotation=[suspicious,expression,found.anchor ? 'Ripresa' : ''].filter(Boolean).join(' · ');
          const text=`${timeLabel(found.time,true)}${annotation ? ' · '+annotation : ''}${found.interval ? ' · '+Number(found.interval.bpm).toFixed(1)+' BPM' : ''}`;
          const beat=found.beat || beatsById.get(String(found.id));
          const automatic=isAutomatic(beat) ? (isLowAutomatic(beat) ? 'Automatico · da rivedere' : 'Automatico') : '';
          showTooltip(geometry.x(found.time),found.y,text,[found.anchor?'BPM dal beat successivo: '+Number(found.anchor.next.bpm).toFixed(1):automatic,String(found.id)===String(state.selectedId)?'Trascina per correggere':'Clic per selezionare'].filter(Boolean).join(' · '));
        } else hideTooltip();
      }
    }
    function finishDrag(event,cancelled) {
      if(panDrag&&event.pointerId===panDrag.pointerId){
        const completed=panDrag;panDrag=null;
        try{if(svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);}catch(_){}
        svg.style.cursor='grab';if(!cancelled&&!completed.moved)callbacks.onSeek?.(completed.time);return;
      }
      if(!drag || event.pointerId!==drag.pointerId) return;
      const completed=drag; drag=null;
      try {if(svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);}catch(_){}
      if(dragGhost) dragGhost.setAttribute('visibility','hidden');
      hideTooltip();svg.style.cursor='grab';
      if(!cancelled) {
        if(callbacks.onSelectBeat) callbacks.onSelectBeat(completed.id);
        if(completed.dense&&callbacks.onInspectBeat)callbacks.onInspectBeat(completed.id);
        if(completed.canMove&&completed.moved && Math.abs(completed.time-completed.originalTime)>.0001 && callbacks.onMoveBeat) callbacks.onMoveBeat(completed.id,completed.time);
      }
    }
    const up=event=>finishDrag(event,false), cancel=event=>finishDrag(event,true), leave=()=>{if(!drag&&!panDrag)hideTooltip();};
    svg.addEventListener('pointerdown',pointerDown);svg.addEventListener('pointermove',pointerMove);svg.addEventListener('pointerup',up);svg.addEventListener('pointercancel',cancel);svg.addEventListener('pointerleave',leave);
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(entries=>{
      const width=Math.round(entries[0].contentRect.width);
      if(!disposed && width>0 && width!==lastWidth && !resizeFrame) resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;render(state);});
    }):null;
    if(observer) observer.observe(svg);
    return {
      render,
      getScale(){return geometry?{min:geometry.min,max:geometry.max}:null;},
      setPlayhead(time) {state.currentTime=time;updatePlayhead(time);},
      exportSVG() {
        if(!geometry) render(state);
        const clone=svg.cloneNode(true);
        clone.setAttribute('width',geometry.width);clone.setAttribute('height',geometry.height);
        clone.removeAttribute('style');
        clone.querySelectorAll('[visibility="hidden"]').forEach(element=>element.remove());
        if(tooltip) {const groups=clone.querySelectorAll('g[aria-hidden="true"]');groups.forEach(element=>element.remove());}
        return '<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(clone);
      },
      destroy() {
        disposed=true;if(observer)observer.disconnect();if(resizeFrame)cancelAnimationFrame(resizeFrame);
        svg.removeEventListener('pointerdown',pointerDown);svg.removeEventListener('pointermove',pointerMove);svg.removeEventListener('pointerup',up);svg.removeEventListener('pointercancel',cancel);svg.removeEventListener('pointerleave',leave);
      }
    };
  }
  global.TempoCharts={tempoScale,createTempoChart:(svg,callbacks)=>create(svg,callbacks,false),createWaveform:(svg,callbacks)=>create(svg,callbacks,true)};
})(globalThis);
