/* Tempo Trace — local media, original-time taps, explicit corrections. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const STORAGE_KEY = 'tempo-trace.session.v1';
  const MAX_BEATS = 50000;
  const DEFAULTS = {beatUnit: 1, sectionThreshold: .12, minSectionSeconds: 8, smoothing: 5};
  const media = $('media');
  let state = {beats: [], sectionBoundaries:null, options: {...DEFAULTS}, media: null, duration: 0, selectedId: null};
  let analysis = TempoAnalysis.analyze([], state.options);
  let sourceURL = null, hasMedia = false, peaks = null, loadToken = 0;
  let yRange=null;
  let followPlayback=true;
  let sectionDraft=[],sectionDraftToken=0;
  let viewStart = 0, viewEnd = 30, clock = 0, pendingBreak = false, lastTapId = null;
  let undoStack = [], redoStack = [], savedTimer = null, toastTimer = null, pulseTimer = null;
  let renderFrame = 0, playbackFrame = 0, previousUiTime = 0, page = 0, relinkRequested = false;
  let confirmation = null, fallbackId = 0, autosaveFailed = false;
  let analysisWorker=null, workerDisabled=false, workerRunning=false, workerPending=null, analysisRevision=0, analysisBusy=false;
  let audioExportController=null,audioExportMode='mix',audioExportGeneration=0;
  let currentFile=null,detectionController=null,detectionResult=null,detectionRunning=false,detectionGeneration=0,editRevision=0;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const number = v => typeof v === 'number' && Number.isFinite(v);
  const bpm = v => number(v) ? v.toLocaleString('it-IT', {maximumFractionDigits: 1}) : '—';
  const uid = () => globalThis.crypto?.randomUUID?.() || `b-${Date.now()}-${++fallbackId}`;
  function formatTime(value, precise = false) {
    const ms = Math.max(0, Math.round((value || 0) * 1000));
    const totalSeconds = Math.floor(ms / 1000);
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}${precise ? '.' + String(ms % 1000).padStart(3, '0') : ''}`;
  }
  function toast(message, error = false) {
    clearTimeout(toastTimer); $('toast').textContent = message;
    $('toast').className = `toast visible${error ? ' error' : ''}`;
    toastTimer = setTimeout(() => $('toast').classList.remove('visible'), error ? 6000 : 3300);
  }
  function showDialog(id) { hideTooltip(); $(id).showModal(); }
  function confirmAction(title, message) {
    return new Promise(resolve => {
      confirmation = resolve; $('confirmTitle').textContent = title; $('confirmMessage').textContent = message;
      showDialog('confirmDialog');
    });
  }
  $('confirmAction').addEventListener('click', () => {
    const resolve = confirmation; confirmation = null; $('confirmDialog').close(); resolve?.(true);
  });
  $('confirmDialog').addEventListener('close', () => { confirmation?.(false); confirmation = null; });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close();
  }));

  function snapshot() { return {beats: state.beats.map(b => ({...b})), options: {...state.options}, sectionBoundaries:state.sectionBoundaries?.slice()??null, selectedId: state.selectedId}; }
  function trimHistory(stack) {
    let count=stack.reduce((sum,item)=>sum+item.beats.length,0);
    while(stack.length>1 && (stack.length>80 || count>200000)) count-=stack.shift().beats.length;
  }
  function checkpoint() { undoStack.push(snapshot()); trimHistory(undoStack); redoStack = []; }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot()); trimHistory(redoStack); Object.assign(state, undoStack.pop()); lastTapId = null; pendingBreak = false; changed();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot()); trimHistory(undoStack); Object.assign(state, redoStack.pop()); lastTapId = null; pendingBreak = false; changed();
  }
  function payload() {
    return {app: 'Tempo Trace', version: 1, savedAt: new Date().toISOString(), media: state.media,
      duration: state.duration, beats: state.beats, options: state.options, sectionBoundaries:state.sectionBoundaries};
  }
  function persist() {
    clearTimeout(savedTimer);
    if (!state.media) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload())); autosaveFailed = false; $('saveStatus').hidden = true; }
    catch { $('saveStatus').hidden = false; $('saveStatus').textContent = 'Esporta il progetto'; if (!autosaveFailed) toast('Salvataggio locale non disponibile. Esporta il progetto JSON.', true); autosaveFailed = true; }
  }
  function scheduleSave() {
    clearTimeout(savedTimer); savedTimer = setTimeout(persist, 350);
  }
  function changed() {
    editRevision++;
    state.beats.sort((a,b) => a.time-b.time);
    clickTrack?.setBeats(state.beats);
    computeAnalysis();
    render(); scheduleSave();
  }
  function computeAnalysis() {
    const revision=++analysisRevision;
    if(state.beats.length<=1200 || workerDisabled || typeof Worker!=='function'){
      workerPending=null; analysisBusy=false; analysis=TempoAnalysis.analyze(state.beats,state.options,state.sectionBoundaries); return;
    }
    function fallback(){
      workerDisabled=true; analysisWorker?.terminate(); analysisWorker=null; workerRunning=false; workerPending=null;
      analysisBusy=false; analysis=TempoAnalysis.analyze(state.beats,state.options,state.sectionBoundaries); render();
    }
    if(!analysisWorker){
      try{
        analysisWorker=new Worker('assets/analysis-worker.js?v=d1fd6a7b2e22');
        analysisWorker.onerror=fallback;
        analysisWorker.onmessage=event=>{
          workerRunning=false;
          if(event.data.error){fallback();return;}
          if(event.data.id===analysisRevision){analysis=event.data.analysis;analysisBusy=false;render();}
          sendAnalysisWork();
        };
      }catch{fallback();return;}
    }
    analysisBusy=true; workerPending={id:revision,beats:state.beats,options:state.options,sectionBoundaries:state.sectionBoundaries}; sendAnalysisWork();
  }
  function sendAnalysisWork(){
    if(!analysisWorker || workerRunning || !workerPending)return;
    const work=workerPending; workerPending=null; workerRunning=true; analysisWorker.postMessage(work);
  }
  function currentTime() { return hasMedia && number(media.currentTime) ? media.currentTime : clock; }
  function extent() { return Math.max(state.duration || 0, state.beats.at(-1)?.time || 0, .1); }
  function graphState() { return {beats: state.beats, analysis, peaks, duration: extent(), currentTime: currentTime(), viewStart, viewEnd, selectedId: state.selectedId, showRaw: $('showRaw').checked, showSmooth: $('showSmooth').checked,yRange}; }
  const callbacks = {onSeek: time => seekTo(time), onSelectBeat: id => selectBeat(id), onMoveBeat: (id,time) => moveBeat(id, time)};
  const chart = TempoCharts.createTempoChart($('tempoChart'), {...callbacks,onPan:panChart,onEditStart:()=>setFollow(false),onInspectBeat:inspectBeat,onScale:scale=>{
    if(document.activeElement!==$('bpmMin'))$('bpmMin').value=String(Math.round(scale.min*100)/100);
    if(document.activeElement!==$('bpmMax'))$('bpmMax').value=String(Math.round(scale.max*100)/100);
    $('yAuto').setAttribute('aria-pressed',String(!yRange));
    $('scaleClipped').hidden=!scale.clipped;$('scaleClipped').textContent=scale.clipped+' fuori scala';
  }});
  const wave = TempoCharts.createWaveform($('waveform'), {onSeek:time=>seekTo(time)});
  const clickTrack=globalThis.TempoClicks?.create(media);

  function renderCharts() { const data = graphState(); chart.render(data); wave.render({...data,viewStart:0,viewEnd:extent(),detailStart:viewStart,detailEnd:viewEnd}); }
  function requestChartRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderCharts(); });
  }
  function render() {
    const active = !!state.media;
    $('welcome').hidden = active; $('workspace').hidden = !active;
    $('exportButton').disabled = !active;
    if (!active) return;
    $('fileName').textContent = state.media.name || 'Esecuzione';
    $('fileName').title = state.media.name || 'Esecuzione';
    $('relinkBanner').hidden = hasMedia;
    $('relinkButton').textContent=state.media.demo?'Riapri esempio':'Collega file';
    $('relinkText').textContent=state.media.demo?'Rigenera l’audio dell’esempio.':'Riapri il file per ascoltare questa sessione.';
    $('playButton').disabled = !hasMedia; $('auditionBeat').disabled = !hasMedia;
    $('detectButton').disabled=!currentFile || detectionRunning;
    $('clickTrackButton').disabled=!hasMedia || !state.beats.length;
    $('tapButton').disabled = !state.duration;
    $('duration').textContent = '/ ' + formatTime(state.duration);
    $('seek').max = String(extent());
    $('beatCount').textContent = `${state.beats.length} beat`;
    const selectedInterval = state.selectedId?analysis.intervals.find(i => i.beatId === state.selectedId):analysis.intervals.at(-1);
    $('lastBpm').replaceChildren(document.createTextNode(bpm(selectedInterval?.bpm) + ' '), Object.assign(document.createElement('small'), {textContent: 'BPM'}));
    $('statStart').textContent = bpm(analysis.stats.start); $('statMean').textContent = bpm(analysis.stats.mean); $('statEnd').textContent = bpm(analysis.stats.end);
    $('statRange').textContent = number(analysis.stats.min) ? `${Math.round(analysis.stats.min)}–${Math.round(analysis.stats.max)}` : '—';
    $('statStart').parentElement.dataset.tip = 'Mediana dei primi intervalli, escluse le fermate.';
    $('statEnd').parentElement.dataset.tip = 'Mediana degli ultimi intervalli, escluse le fermate.';
    $('statMean').parentElement.dataset.tip = 'Pulsazioni totali / tempo coperto. Include i tap segnalati; esclude le interruzioni.';
    $('statRange').parentElement.dataset.tip = 'Minimo e massimo dei BPM grezzi, inclusi i tap segnalati.';
    $('unitBadge').textContent = ({'.5': '♪', '0.5':'♪', '1':'♩', '1.5':'♩.', '2':'𝅗𝅥'}[state.options.beatUnit] || '♩') + ' = 1 tap';
    $('chartEmpty').hidden = analysis.intervals.length > 0;
    if (state.beats.length && !analysis.intervals.length) $('chartEmpty').textContent = 'Aggiungi un altro beat nello stesso tratto.';
    else if (!state.beats.length) $('chartEmpty').innerHTML = 'Rileva i beat o marca con <kbd>spazio</kbd>.';
    $('undoButton').disabled = !undoStack.length; $('redoButton').disabled = !redoStack.length;
    $('clearButton').disabled = !state.beats.length; $('beatListButton').disabled = !state.beats.length;
    $('saveBeats').disabled = !state.beats.length || analysisBusy; $('saveSections').disabled = !analysis.sections.length || analysisBusy; $('saveSvg').disabled = !analysis.intervals.length || analysisBusy;
    $('tempoChart').setAttribute('aria-busy',String(analysisBusy));
    $('editSections').disabled=analysisBusy||!analysis.intervals.length;
    $('sectionMode').hidden=state.sectionBoundaries==null;
    renderSections(); renderAnomalies(); renderExpressions(); renderEditor(); updateViewControls(); renderCharts(); updateClock();
  }
  function renderSections() {
    const list = $('sectionList'); list.replaceChildren();
    if (!analysis.sections.length) { list.append(Object.assign(document.createElement('p'), {className:'empty-note',textContent:'Servono almeno due beat.'})); return; }
    analysis.sections.forEach((section,index) => {
      const row = document.createElement('button'); row.className = 'section-row';
      row.setAttribute('aria-label', `Sezione ${index+1}, da ${formatTime(section.start)} a ${formatTime(section.end)}, ${bpm(section.bpm)} BPM. Mostra e vai all’inizio.`);
      const badge = Object.assign(document.createElement('span'), {className:'section-index',textContent:String(index+1)});
      const range = Object.assign(document.createElement('span'), {className:'section-range',textContent:`${formatTime(section.start)} — ${formatTime(section.end)}`});
      const value = Object.assign(document.createElement('span'), {className:'section-bpm',textContent:bpm(section.bpm)});
      value.append(Object.assign(document.createElement('small'), {textContent:'BPM'})); row.append(badge,range,value);
      row.addEventListener('click', () => { setFollow(false);viewStart = Math.max(0, section.start - .5); viewEnd = Math.min(extent(), section.end + .5); seekTo(section.start); updateViewControls(); renderCharts(); });
      list.append(row);
    });
  }
  function renderAnomalies() {
    const marked=new Set(analysis.anomalies.map(i=>i.beatId));
    const weak=state.beats.filter(b=>b.source==='auto' && b.confidence<.45 && !marked.has(b.id));
    const issues=[...analysis.anomalies,...weak.map(b=>({beatId:b.id,end:b.time,anomaly:b.inferred?'Beat interpolato':'Rilevamento debole',bpm:null}))].sort((a,b)=>a.end-b.end);
    $('anomalyCount').textContent = String(issues.length);
    const list = $('anomalyList'); list.replaceChildren();
    $('anomaliesPanel').hidden = !issues.length;
    if (!issues.length) return;
    issues.slice(0, 250).forEach(interval => {
      const button = Object.assign(document.createElement('button'), {className:'anomaly-row'});
      button.append(Object.assign(document.createElement('strong'), {textContent:formatTime(interval.end,true)}),Object.assign(document.createElement('span'), {textContent:interval.anomaly}),Object.assign(document.createElement('span'), {textContent:number(interval.bpm)?bpm(interval.bpm)+' BPM':''}));
      button.addEventListener('click', () => { selectBeat(interval.beatId, true); seekTo(interval.end); $('beatTime').focus({preventScroll:false}); }); list.append(button);
    });
    if (issues.length > 250) list.append(Object.assign(document.createElement('p'), {className:'empty-note',textContent:'Prime 250 · elenco completo nel CSV.'}));
  }
  function openSections(){
    if(analysisBusy||!analysis.intervals.length)return;
    media.pause();sectionDraftToken=loadToken;sectionDraft=analysis.sections.slice(1).map(s=>s.start);
    $('sectionEditError').hidden=true;$('newSectionTime').value=currentTime().toFixed(2);
    $('newSectionTime').max=String(analysis.intervals.at(-1).start);
    renderSectionDraft();showDialog('sectionsDialog');
  }
  function renderSectionDraft(){
    const list=$('sectionBoundaries');list.replaceChildren();
    [analysis.intervals[0].start,...sectionDraft].forEach((time,index)=>{
      const row=Object.assign(document.createElement('div'),{className:'section-boundary-row'});
      row.append(Object.assign(document.createElement('span'),{className:'section-index',textContent:String(index+1)}));
      const input=document.createElement('input');input.type='number';input.step='0.001';input.min=String(analysis.intervals[0].start);input.max=String(analysis.intervals.at(-1).start);input.value=number(time)?time.toFixed(3):'';input.disabled=index===0;
      input.setAttribute('aria-label','Inizio della sezione '+(index+1)+' in secondi');
      input.addEventListener('input',()=>{sectionDraft[index-1]=input.valueAsNumber;$('sectionEditError').hidden=true;});row.append(input);
      if(index){
        const remove=Object.assign(document.createElement('button'),{className:'icon-button',type:'button',textContent:'×'});
        remove.setAttribute('aria-label','Unisci la sezione '+(index+1)+' alla precedente');remove.dataset.tip='Unisci alla sezione precedente';
        remove.addEventListener('click',()=>{sectionDraft.splice(index-1,1);$('sectionEditError').hidden=true;renderSectionDraft();});row.append(remove);
      }
      list.append(row);
    });
  }
  function sectionError(message){$('sectionEditError').textContent=message;$('sectionEditError').hidden=false;}
  function resolvedSectionCuts(values){
    if(values.some(t=>!number(t)||t<=analysis.intervals[0].start||t>analysis.intervals.at(-1).start))return null;
    const sections=TempoAnalysis.sectionsAtBoundaries(analysis.intervals,values,state.options.beatUnit);
    const cuts=sections.slice(1).map(s=>s.start);
    if(cuts.length!==values.length||values.some((t,i)=>i&&t<=values[i-1]))return null;
    return cuts;
  }
  function addSection(){
    const time=$('newSectionTime').valueAsNumber,values=[...sectionDraft,time].sort((a,b)=>a-b),cuts=resolvedSectionCuts(values);
    if(!cuts)return sectionError('Scegli un beat interno a una sezione, distinto dagli altri confini.');
    sectionDraft=cuts;$('sectionEditError').hidden=true;renderSectionDraft();
  }
  function applySections(){
    if(sectionDraftToken!==loadToken){$('sectionsDialog').close();return;}
    const cuts=resolvedSectionCuts(sectionDraft);
    if(!cuts)return sectionError('Gli inizi devono seguire l’ordine dei beat e lasciare almeno un intervallo per sezione.');
    checkpoint();state.sectionBoundaries=cuts;$('sectionsDialog').close();changed();
  }
  function restoreAutomaticSections(){
    if(sectionDraftToken!==loadToken){$('sectionsDialog').close();return;}
    if(state.sectionBoundaries!==null){checkpoint();state.sectionBoundaries=null;changed();}
    $('sectionsDialog').close();
  }
  function setBeatBreak(value){
    const beat=state.beats.find(b=>b.id===state.selectedId);if(!beat||beat.breakBefore===value)return;
    checkpoint();beat.source='manual';delete beat.confidence;delete beat.inferred;beat.breakBefore=value;
    if(value)beat.fermataBefore=false;changed();
  }
  function renderEditor() {
    const index = state.beats.findIndex(b => b.id === state.selectedId); const beat = state.beats[index];
    $('editorEmpty').hidden = !!beat; $('beatEditor').hidden = !beat; $('selectedNumber').textContent = beat ? String(index+1) : '—';
    $('previousBeat').disabled = index <= 0; $('nextBeat').disabled = !state.beats.length || index >= state.beats.length-1;
    if (!beat) return;
    $('confirmBeat').hidden=beat.source!=='auto';
    $('beatTime').value = beat.time.toFixed(3); $('beatTime').max = String(extent());
    $('connectBeat').hidden=!beat.breakBefore||index===0;
    $('breakBefore').checked = !!beat.breakBefore; $('breakBefore').disabled = index === 0;
    $('fermataBefore').checked=!!beat.fermataBefore; $('fermataBefore').disabled=index===0;
  }
  function renderExpressions() {
    const events=analysis.events || []; $('expressionCount').textContent=String(events.length);
    const list=$('expressionList'); list.replaceChildren();
    $('expressionPanel').hidden = !events.length;
    if (!events.length) return;
    events.slice(0,250).forEach(event=>{
      const button=Object.assign(document.createElement('button'),{className:'anomaly-row expression-row'});
      button.append(Object.assign(document.createElement('strong'),{textContent:formatTime(event.start)}),Object.assign(document.createElement('span'),{className:'event-label',textContent:event.label}),Object.assign(document.createElement('span'),{className:'event-tag',textContent:event.confidence==='manual'?'Confermata':event.confidence==='candidate'?'Da confermare':''}));
      button.addEventListener('click',()=>{
        const beat=event.beatId?state.beats.find(b=>b.id===event.beatId):state.beats.find(b=>b.time>=event.start);
        if(beat)selectBeat(beat.id,true); seekTo(event.start);
        if(event.confidence==='candidate')$('fermataBefore').focus();
      });list.append(button);
    });
    if(events.length>250)list.append(Object.assign(document.createElement('p'),{className:'empty-note',textContent:'Primi 250 eventi. Gli altri restano nel grafico e nel progetto.'}));
  }
  function selectBeat(id, focusView = false) {
    const beat = state.beats.find(b => b.id === id); if (!beat) return;
    setFollow(false);
    state.selectedId = id;
    if (focusView && (beat.time < viewStart || beat.time > viewEnd || viewEnd-viewStart > 20)) {
      const span = Math.min(12,extent()); viewStart=clamp(beat.time-span/2,0,Math.max(0,extent()-span)); viewEnd=viewStart+span;
    }
    const interval=analysis.intervals.find(i=>i.beatId===id);
    $('lastBpm').replaceChildren(document.createTextNode(bpm(interval?.bpm)+' '),Object.assign(document.createElement('small'),{textContent:'BPM'}));
    renderEditor(); updateViewControls(); requestChartRender();
  }
  function updateViewControls() {
    const total = extent(), span = viewEnd-viewStart;
    $('viewLabel').textContent = `${formatTime(viewStart)} — ${formatTime(viewEnd)}`;
    $('pan').max = String(Math.max(0,total-span)); $('pan').value = String(viewStart); $('pan').disabled = span >= total-.001;
    $('zoomOut').disabled = span >= total-.001; $('zoomIn').disabled = span <= Math.min(.25,total)+.001;$('focusBeat').disabled=!state.selectedId;
  }
  function zoom(factor) {
    const total = extent(), span=clamp((viewEnd-viewStart)*factor,Math.min(.25,total),total);
    const selected=state.beats.find(b=>b.id===state.selectedId);
    const center = selected&&selected.time>=viewStart&&selected.time<=viewEnd?selected.time:currentTime() >= viewStart && currentTime() <= viewEnd ? currentTime() : (viewStart+viewEnd)/2;
    viewStart = clamp(center-span/2,0,total-span); viewEnd=viewStart+span; updateViewControls(); renderCharts();
  }
  function inspectBeat(id){
    selectBeat(id);const index=state.beats.findIndex(b=>b.id===id);if(index<0)return;
    const beat=state.beats[index],a=state.beats[Math.max(0,index-4)].time,b=state.beats[Math.min(state.beats.length-1,index+4)].time;
    const span=clamp(b-a+1,Math.min(.5,extent()),Math.min(12,extent()));
    viewStart=clamp(beat.time-span/2,0,extent()-span);viewEnd=viewStart+span;updateViewControls();renderCharts();
  }
  function zoomVertical(factor){
    const scale=chart.getScale();if(!scale)return;
    const center=(scale.min+scale.max)/2,span=clamp((scale.max-scale.min)*factor,2,120000);
    yRange={min:Math.max(0,center-span/2),max:Math.max(span,center+span/2)};renderCharts();
  }
  function setVerticalRange(){
    const min=$('bpmMin').valueAsNumber,max=$('bpmMax').valueAsNumber;
    if(!number(min)||!number(max)||min<0||max<=min){toast('Inserisci un intervallo BPM valido.',true);renderCharts();return;}
    yRange={min,max};renderCharts();
  }
  function fitView() { viewStart=0; viewEnd=extent(); updateViewControls(); renderCharts(); }
  function panChart(view){
    setFollow(false);const span=Math.min(view.end-view.start,extent());
    viewStart=clamp(view.start,0,Math.max(0,extent()-span));viewEnd=viewStart+span;
    if(view.vertical){const range=view.max-view.min;yRange={min:Math.max(0,view.min),max:Math.max(0,view.min)+range};}
    updateViewControls();requestChartRender();
  }
  function setFollow(active){
    followPlayback=active;$('followPlayback').setAttribute('aria-pressed',String(active));
  }
  function followPlayhead(now,force=false){
    const total=extent(),span=viewEnd-viewStart;
    if(!followPlayback||span>=total-.001||!force&&(!hasMedia||media.paused))return false;
    if(now>=viewStart&&now<=viewStart+span*.8)return false;
    const next=clamp(now-span*.5,0,Math.max(0,total-span));
    if(Math.abs(next-viewStart)<.0001)return false;
    viewStart=next;viewEnd=next+span;updateViewControls();renderCharts();return true;
  }
  function updateClock() {
    const now=currentTime(); $('currentTime').textContent=formatTime(now,true); $('seek').value=String(now);
    chart.setPlayhead(now); wave.setPlayhead(now);
  }
  function animatePlayback(timestamp) {
    if (!hasMedia || media.paused) { playbackFrame=0; return; }
    const now=currentTime(); chart.setPlayhead(now); wave.setPlayhead(now);
    if (timestamp-previousUiTime > 60) { followPlayhead(now);$('currentTime').textContent=formatTime(now,true); $('seek').value=String(now); previousUiTime=timestamp; }
    playbackFrame=requestAnimationFrame(animatePlayback);
  }
  async function togglePlay() {
    if (!hasMedia) return toast('Collega il file per avviare l’ascolto.');
    if (!media.paused) { media.pause(); return; }
    if (media.ended || media.currentTime >= state.duration-.01) seekTo(0);
    try { await media.play(); } catch { toast('Riproduzione non disponibile. Prova un altro formato audio/video.',true); }
  }
  function seekTo(time) {
    const next=clamp(time,0,extent());
    const previousBeat=state.beats.at(-1);
    // Mark only a forward skipped span after a tapping run. A paused insert
    // between existing beats always remains connected to its neighbors.
    if (previousBeat && next > previousBeat.time+.05 && Math.abs(next-currentTime())>.05) pendingBreak=true;
    clock=next; if (hasMedia) media.currentTime=next; followPlayhead(next);updateClock();
  }
  media.addEventListener('play', () => { $('playButton').setAttribute('aria-label','Pausa'); $('playButton').querySelector('use').setAttribute('href','#i-pause'); if (!playbackFrame) playbackFrame=requestAnimationFrame(animatePlayback); });
  media.addEventListener('pause', () => { $('playButton').setAttribute('aria-label','Riproduci'); $('playButton').querySelector('use').setAttribute('href','#i-play'); cancelAnimationFrame(playbackFrame); playbackFrame=0; updateClock(); });
  media.addEventListener('timeupdate', () => { if (media.paused) updateClock(); });
  media.addEventListener('ended', () => { lastTapId=null; pendingBreak=false; });
  media.addEventListener('error', () => { if (hasMedia) { media.pause(); toast('Il browser non riesce a riprodurre questo file. I tap restano disponibili.',true); } });

  function tap() {
    if (!state.media || !state.duration) return;
    if (state.beats.length >= MAX_BEATS) return toast('Limite di 50.000 beat raggiunto.',true);
    const time=Math.round(clamp(currentTime(),0,extent())*1000)/1000;
    if (state.beats.some(b=>Math.abs(b.time-time)<.035)) return toast('C’è già un beat qui. Selezionalo per correggerlo.');
    checkpoint();
    const tail=state.beats.at(-1);
    const beat={id:uid(),time,breakBefore:!!(pendingBreak && tail && time>tail.time),source:'manual'};
    state.beats.push(beat); state.selectedId=beat.id; lastTapId=beat.id; pendingBreak=false;
    if (time>viewEnd || time<viewStart) { const span=viewEnd-viewStart; viewStart=clamp(time-span*.65,0,Math.max(0,extent()-span)); viewEnd=viewStart+span; }
    $('tapButton').classList.remove('pulse'); void $('tapButton').offsetWidth; $('tapButton').classList.add('pulse');
    clearTimeout(pulseTimer); pulseTimer=setTimeout(()=>$('tapButton').classList.remove('pulse'),110);
    changed();
  }
  function moveBeat(id, rawTime) {
    const index=state.beats.findIndex(b=>b.id===id); if (index<0 || !number(rawTime)) return;
    const next=Math.round(rawTime*1000)/1000;
    const lower=index ? state.beats[index-1].time+.001 : 0;
    const upper=index<state.beats.length-1 ? state.beats[index+1].time-.001 : extent();
    if (next<lower-.00001 || next>upper+.00001) { toast('Mantieni il beat tra i due vicini e dentro la registrazione.',true); renderEditor(); requestChartRender(); return; }
    if (Math.abs(state.beats[index].time-next)<.000001) return;
    media.pause(); checkpoint();
    if(state.sectionBoundaries)state.sectionBoundaries=state.sectionBoundaries.map(t=>Math.abs(t-state.beats[index].time)<.0005?next:t);
    state.beats[index].time=next; state.beats[index].source='manual'; delete state.beats[index].confidence; delete state.beats[index].inferred; state.selectedId=id; changed();
  }
  function removeSelected() {
    const index=state.beats.findIndex(b=>b.id===state.selectedId); if (index<0) return;
    checkpoint();
    if (state.beats[index].breakBefore && state.beats[index+1]) state.beats[index+1].breakBefore=true;
    if (state.beats[index].fermataBefore && state.beats[index+1]) state.beats[index+1].fermataBefore=true;
    state.beats.splice(index,1); state.selectedId=state.beats[Math.min(index,state.beats.length-1)]?.id || null;
    lastTapId=null; changed();
  }

  function validateProject(data) {
    if (!data || data.app!=='Tempo Trace' || data.version!==1 || !Array.isArray(data.beats) || data.beats.length>MAX_BEATS) throw new Error('Progetto non valido o versione non supportata.');
    if (!number(data.duration) || data.duration<=0 || data.duration>86400) throw new Error('Durata del progetto non valida (massimo 24 ore).');
    if (!data.media || typeof data.media.name!=='string' || data.media.name.length>500) throw new Error('Dati del file non validi.');
    const ids=new Set(), times=new Set();
    const beats=data.beats.map(b=>{
      if (!b || !number(b.time) || b.time<0 || b.time>data.duration+.001 || (b.breakBefore!=null && typeof b.breakBefore!=='boolean') || (b.fermataBefore!=null && typeof b.fermataBefore!=='boolean')) throw new Error('Il progetto contiene posizioni dei beat non valide.');
      const time=Math.round(b.time*1000)/1000;
      if (times.has(time)) throw new Error('Il progetto contiene beat duplicati.'); times.add(time);
      const id=typeof b.id==='string' && b.id.length<100 && !ids.has(b.id) ? b.id : uid(); ids.add(id);
      const beat={id,time,breakBefore:b.breakBefore===true,fermataBefore:b.fermataBefore===true && b.breakBefore!==true};
      if(b.source==='auto'){if(!number(b.confidence)||b.confidence<0||b.confidence>1||(b.inferred!=null&&typeof b.inferred!=='boolean'))throw new Error('Dati del rilevamento non validi.');beat.source='auto';beat.confidence=b.confidence;beat.inferred=b.inferred===true;}
      else if(b.source==='manual')beat.source='manual';
      return beat;
    }).sort((a,b)=>a.time-b.time);
    const options={...DEFAULTS};
    if (data.options!=null && (typeof data.options!=='object' || Array.isArray(data.options))) throw new Error('Impostazioni del progetto non valide.');
    if (data.options) {
      if ([.5,1,1.5,2].includes(data.options.beatUnit)) options.beatUnit=data.options.beatUnit;
      if (number(data.options.sectionThreshold)) options.sectionThreshold=clamp(data.options.sectionThreshold,.05,.6);
      if (number(data.options.minSectionSeconds)) options.minSectionSeconds=clamp(data.options.minSectionSeconds,3,60);
      if ([3,5,9,15].includes(data.options.smoothing)) options.smoothing=data.options.smoothing;
    }
    let sectionBoundaries=null;
    if(data.sectionBoundaries!=null){
      if(!Array.isArray(data.sectionBoundaries)||data.sectionBoundaries.length>MAX_BEATS||data.sectionBoundaries.some(t=>!number(t)||t<=0||t>=data.duration))throw new Error('Confini delle sezioni non validi.');
      sectionBoundaries=data.sectionBoundaries.map(t=>Math.round(t*1000)/1000).sort((a,b)=>a-b);
      if(sectionBoundaries.some(t=>t<=0||t>=data.duration))throw new Error('Confini delle sezioni non validi.');
      if(new Set(sectionBoundaries).size!==sectionBoundaries.length)throw new Error('Confini delle sezioni duplicati.');
    }
    return {beats,options,sectionBoundaries,duration:data.duration,selectedId:null,media:{name:data.media.name,size:number(data.media.size)?data.media.size:0,type:typeof data.media.type==='string'?data.media.type:'',kind:data.media.kind==='video'?'video':'audio',demo:data.media.demo===true}};
  }
  function unloadMedia() {
    if($('beatModeDialog').open)$('beatModeDialog').close();
    cancelAudioExport();cancelDetection(); currentFile=null;globalThis.TempoDetectionClient?.clear();clickTrack?.reset();
    media.pause(); hasMedia=false; media.removeAttribute('src'); media.load(); media.hidden=true;
    if (sourceURL) URL.revokeObjectURL(sourceURL); sourceURL=null; peaks=null;
  }
  function adoptProject(project) {
    ++loadToken; unloadMedia(); state=project; yRange=null;setFollow(true); clock=0; undoStack=[]; redoStack=[]; lastTapId=null; pendingBreak=false;
    analysis=TempoAnalysis.analyze([],state.options);
    viewStart=0; viewEnd=extent(); $('waveStatus').textContent=''; changed();
  }
  function probeFile(url) {
    return new Promise((resolve,reject)=>{
      const probe=document.createElement('video'); probe.preload='metadata';
      const timer=setTimeout(()=>done(new Error('Il file impiega troppo tempo a caricarsi. Prova un formato diverso.')),20000);
      function done(error) { clearTimeout(timer); probe.onloadedmetadata=null; probe.onerror=null; const duration=probe.duration; probe.removeAttribute('src'); probe.load(); error?reject(error):resolve(duration); }
      probe.onloadedmetadata=()=>{ if (!number(probe.duration) || probe.duration<=0 || probe.duration>86400) done(new Error('Durata non supportata. Usa un file finito, entro 24 ore.')); else done(); };
      probe.onerror=()=>done(new Error('Formato o codec non supportato dal browser. Prova MP3, WAV o MP4.'));
      probe.src=url;
    });
  }
  async function loadFile(file, forceRelink=false, demoData=null) {
    if (!file) return;
    if (!file.size) return toast('Il file è vuoto.',true);
    media.pause(); const token=++loadToken;
    const url=URL.createObjectURL(file); toast('Apertura del file…');
    try {
      const duration=await probeFile(url);
      if (token!==loadToken) { URL.revokeObjectURL(url); return; }
      let relink=forceRelink || (!hasMedia && state.media && state.media.name===file.name && (!state.media.size || state.media.size===file.size));
      if (relink && state.media) {
        if (state.beats.some(b=>b.time>duration+.001)) throw new Error('Il file è più corto dei tap salvati. Collega la registrazione originale.');
        if (Math.abs(duration-state.duration)>.1 || (state.media.size && state.media.size!==file.size) || state.media.name!==file.name) {
          const ok=await confirmAction('Registrazione diversa', 'Nome, dimensione o durata non corrispondono. Collegarla mantenendo tutti i tap?');
          if (!ok || token!==loadToken) { URL.revokeObjectURL(url); return; }
        }
      } else if (state.beats.length) {
        const ok=await confirmAction('Apri una nuova esecuzione', 'I tap attuali verranno sostituiti. Esporta prima il progetto se vuoi conservarli.');
        if (!ok || token!==loadToken) { URL.revokeObjectURL(url); return; }
      }
      unloadMedia(); sourceURL=url;currentFile=file;
      const isVideo=file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v)$/i.test(file.name);
      if (!relink) {
        state={beats:demoData?.beats || [],sectionBoundaries:null,options:{...DEFAULTS},duration,selectedId:null,media:null};
        analysis=TempoAnalysis.analyze([],state.options);
        undoStack=[]; redoStack=[]; yRange=null;setFollow(true); viewStart=0; viewEnd=duration;
      }
      state.duration=duration;
      state.media={name:file.name,size:file.size,type:file.type,kind:isVideo?'video':'audio',demo:!!demoData};
      clock=0; lastTapId=null; pendingBreak=false;
      media.src=url; media.hidden=!isVideo; media.volume=Number($('volume').value);
      media.playbackRate=Number($('speed').value); media.preservesPitch=true;
      media.onloadedmetadata=()=>{
        if (token!==loadToken) return;
        hasMedia=true; media.playbackRate=Number($('speed').value); media.currentTime=0; render();
      };
      media.load(); hasMedia=media.readyState>=1;
      if (demoData) { peaks=demoData.peaks; $('waveStatus').textContent=''; }
      else { peaks=null; $('waveStatus').textContent='Lettura della forma d’onda…'; }
      changed(); if(relink)toast('File collegato.');
      // Waveform generation is optional. The original file remains the player source.
      if (!demoData) decodePeaks(file, token, duration);
      if (!relink && !demoData) showDialog('beatModeDialog');
    } catch(error) { URL.revokeObjectURL(url); if (token===loadToken) toast(error.message || 'Impossibile aprire il file.',true); }
  }
  async function decodePeaks(file, token, duration) {
    if (file.size>100*1024*1024 || duration>1800) { $('waveStatus').textContent='Forma d’onda omessa · file lungo'; return; }
    try {
      const decoded=await TempoDetectionClient.decode(file,duration);
      if (token!==loadToken) return;
      const count=Math.min(16000,Math.max(1500,Math.ceil(duration*65))), output=new Float32Array(count);
      const stride=Math.max(1,Math.floor(decoded.samples.length/count)); let maximum=0;
      const channels=[decoded.samples];
      for (let bin=0;bin<count;bin++) {
        let peak=0; const start=bin*stride, end=Math.min(decoded.samples.length,start+stride), sampleStep=Math.max(1,Math.floor(stride/100));
        for (const channel of channels) for (let i=start;i<end;i+=sampleStep) peak=Math.max(peak,Math.abs(channel[i]));
        output[bin]=peak; maximum=Math.max(maximum,peak);
      }
      if (maximum) for(let i=0;i<output.length;i++) output[i]/=maximum;
      peaks=output; $('waveStatus').textContent=''; requestChartRender();
    } catch { if (token===loadToken) $('waveStatus').textContent='Forma d’onda non disponibile · tap attivi'; }
  }

  async function loadProject(file) {
    if (!file) return;
    try {
      if (file.size>12*1024*1024) throw new Error('Progetto troppo grande (massimo 12 MB).');
      const parsed=validateProject(JSON.parse(await file.text()));
      if (state.beats.length && !(await confirmAction('Apri progetto', 'Sostituire la sessione attuale con il progetto selezionato?'))) return;
      adoptProject(parsed); toast('Progetto aperto. Collega il file originale per ascoltarlo.');
    } catch(error) { toast(error instanceof SyntaxError?'Il file non contiene un JSON valido.':error.message,true); }
  }
  function download(content, filename, type) {
    const blob=new Blob([content],{type}); const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  function baseName() { return (state.media?.name || 'tempo-trace').replace(/\.[^.]+$/,'').replace(/[^\p{L}\p{N} _.-]/gu,'_').slice(0,100); }
  function csv(rows) { return '\ufeff'+rows.map(row=>row.map(cell=>'"'+String(cell??'').replaceAll('"','""')+'"').join(';')).join('\r\n'); }
  function exportProject() { persist(); download(JSON.stringify(payload(),null,2),baseName()+'.tempo.json','application/json'); toast('Progetto esportato.'); }
  function exportRange(scope){return scope==='view'?{start:viewStart,end:Math.min(viewEnd,extent())}:{start:0,end:extent()};}
  async function exportGraphic(format){
    const {start,end}=exportRange($('exportScope').value),beats=state.beats.filter(b=>b.time>=start&&b.time<=end).map(b=>({...b}));
    if(!beats.length)return toast('Nessun beat nel tratto scelto.',true);
    const result=TempoAnalysis.analyze(beats,state.options,state.sectionBoundaries),scale=TempoCharts.tempoScale(result.intervals,$('exportScope').value==='view'?yRange:null);
    const report=TempoReport.create({title:state.media?.name,duration:state.duration,beats,analysis:result},{start,end,scale}),filename=baseName()+'.grafico.'+format;
    $('savePng').disabled=true;$('saveSvg').disabled=true;
    try{const content=format==='png'?await TempoExportClient.png(report.svg,report.width,report.height):report.svg;download(content,filename,format==='png'?'image/png':'image/svg+xml');}
    catch(error){toast(error.message||'Esportazione non riuscita.',true);}
    finally{$('savePng').disabled=false;$('saveSvg').disabled=false;}
  }
  function cancelAudioExport(){
    audioExportGeneration++;audioExportController?.abort();audioExportController=null;
    $('audioExportProgress').hidden=true;$('audioExportOptions').hidden=false;$('startAudioExport').disabled=false;
  }
  function openAudioExport(mode){
    audioExportMode=mode;cancelAudioExport();$('audioExportError').hidden=true;
    $('audioExportTitle').textContent=mode==='mix'?'Audio + beat':'Solo beat';
    $('audioExportScope').value=$('exportScope').value;
    $('exportMusicRow').hidden=mode!=='mix';$('exportBalanceRow').hidden=mode!=='mix';$('exportRateRow').hidden=mode==='mix';
    $('exportMusicVolume').value=$('volume').value;$('exportClickVolume').value=String(Number($('clickVolume').value)*Number($('volume').value));
    $('exportBalance').checked=$('clickAuto').checked;$('exportRate').value='1';
    $('exportDialog').close();showDialog('audioExportDialog');
  }
  async function exportAudio(){
    if(audioExportController)return;
    const range=exportRange($('audioExportScope').value),file=currentFile,beats=state.beats.map(b=>({...b})),rate=audioExportMode==='mix'?1:Number($('exportRate').value);
    $('audioExportError').hidden=true;
    if(!beats.some(b=>b.time>=range.start&&b.time<=range.end)){$('audioExportError').textContent='Nessun beat nel tratto scelto.';$('audioExportError').hidden=false;return;}
    const name=baseName()+(audioExportMode==='mix'?'.audio-beat':'.beat')+(rate!==1?'.'+rate+'x':'')+'.wav';
    audioExportController=new AbortController();const generation=++audioExportGeneration;
    $('audioExportOptions').hidden=true;$('audioExportProgress').hidden=false;$('startAudioExport').disabled=true;$('audioExportBar').value=0;
    try{
      const blob=await TempoExportClient.audio(file,{...range,duration:state.duration,beats,mode:audioExportMode,rate,musicVolume:Number($('exportMusicVolume').value),clickVolume:Number($('exportClickVolume').value),autoBalance:$('exportBalance').checked},update=>{
        if(generation!==audioExportGeneration)return;$('audioExportBar').value=update.progress;$('audioExportStage').textContent=update.stage+' · '+Math.round(update.progress*100)+'%';
      },audioExportController.signal);
      if(generation!==audioExportGeneration)return;download(blob,name,'audio/wav');$('audioExportDialog').close();
    }catch(error){if(generation===audioExportGeneration&&error.name!=='AbortError'){$('audioExportError').textContent=error.message||'Esportazione non riuscita.';$('audioExportError').hidden=false;}}
    finally{if(generation===audioExportGeneration){audioExportController=null;$('audioExportOptions').hidden=false;$('audioExportProgress').hidden=true;$('startAudioExport').disabled=false;}}
  }
  function renderBeatTable() {
    const pageSize=80, pageCount=Math.max(1,Math.ceil(state.beats.length/pageSize)); page=clamp(page,0,pageCount-1);
    const intervals=new Map(analysis.intervals.map(i=>[i.beatId,i])); $('beatTable').replaceChildren();
    state.beats.slice(page*pageSize,(page+1)*pageSize).forEach((beat,index)=>{
      const interval=intervals.get(beat.id), row=document.createElement('tr');
      for (const value of [String(page*pageSize+index+1),formatTime(beat.time,true),bpm(interval?.bpm),beat.breakBefore?'Interruzione':interval?.anomaly || (beat.source==='auto'?(beat.confidence<.45?'Auto · da rivedere':'Auto'):'—')]) row.append(Object.assign(document.createElement('td'),{textContent:value}));
      const cell=document.createElement('td'), button=Object.assign(document.createElement('button'),{className:'text-button',textContent:'Modifica'});
      button.setAttribute('aria-label',`Modifica beat ${page*pageSize+index+1}`);
      button.addEventListener('click',()=>{ $('beatListDialog').close(); selectBeat(beat.id,true); $('beatTime').focus(); }); cell.append(button); row.append(cell); $('beatTable').append(row);
    });
    $('prevPage').disabled=page===0; $('nextPage').disabled=page===pageCount-1; $('pageLabel').textContent=`${page+1} / ${pageCount}`;
  }

  function cancelDetection(){
    detectionGeneration++;detectionController?.abort();detectionController=null;detectionRunning=false;detectionResult=null;
    $('detectProgress').hidden=true;$('detectRun').disabled=false;$('detectOptions').hidden=false;
    $('detectApply').hidden=true;$('detectResult').hidden=true;
    $('detectButton').disabled=!currentFile;
  }
  function openDetection(){
    if(!currentFile)return toast('Collega il file originale.');
    media.pause();cancelDetection();$('detectError').hidden=true;$('detectRun').textContent='Rileva';
    const manual=state.beats.filter(b=>b.source!=='auto');
    $('detectAnchors').disabled=!manual.length;$('detectAnchors').checked=!!manual.length;
    $('detectUnitNote').textContent='BPM della pulsazione rilevata · '+$('unitBadge').textContent.replace('tap','beat');
    showDialog('detectDialog');
  }
  async function runDetection(){
    if(!currentFile || detectionRunning)return;
    const minBpm=Number($('detectMin').value),maxBpm=Number($('detectMax').value),hint=$('detectHint').value.trim();
    const preferredBpm=hint?Number(hint):null;
    const start=$('detectScope').value==='view'?viewStart:0,end=$('detectScope').value==='view'?Math.min(viewEnd,state.duration):state.duration;
    const preserveManual=$('detectAnchors').checked&&!$('detectAnchors').disabled;
    const anchors=preserveManual?state.beats.filter(b=>b.source!=='auto' && b.time>=start && b.time<=end):[];
    $('detectError').hidden=true;
    if(!number(minBpm)||!number(maxBpm)||minBpm<25||maxBpm>300||minBpm>=maxBpm || (preferredBpm!==null&&(!number(preferredBpm)||preferredBpm<minBpm||preferredBpm>maxBpm))){
      $('detectError').textContent='Controlla l’intervallo BPM e il tempo indicativo.';$('detectError').hidden=false;return;
    }
    if(end-start<4){$('detectError').textContent='Seleziona almeno 4 secondi.';$('detectError').hidden=false;return;}
    detectionController=new AbortController();const generation=++detectionGeneration,token=loadToken,revision=editRevision;
    detectionRunning=true;detectionResult=null;$('detectOptions').hidden=true;$('detectProgress').hidden=false;
    $('detectRun').disabled=true;$('detectResult').hidden=true;$('detectApply').hidden=true;$('detectButton').disabled=true;
    $('detectionProgress').value=0;$('detectStage').textContent='Decodifica…';
    try {
      const result=await TempoDetectionClient.run(currentFile,state.duration,{minBpm,maxBpm,preferredBpm,anchors,start,end},update=>{
        if(generation!==detectionGeneration)return;
        const progress=clamp(update.progress||0,0,1);$('detectionProgress').value=progress;
        const labels={onsets:'Attacchi',features:'Attacchi',tempo:'Tempo',tracking:'Beat',beats:'Beat',complete:'Completato',done:'Completato'};
        $('detectStage').textContent=(labels[update.stage]||update.stage||'Analisi')+' · '+Math.round(progress*100)+'%';
      },detectionController.signal);
      if(generation!==detectionGeneration || token!==loadToken || revision!==editRevision)return;
      if(!result.beats.length)throw new Error('Nessuna pulsazione rilevata. Prova un altro intervallo BPM o alcuni tap manuali.');
      detectionResult={result,start,end,preserveManual,revision,token};
      $('detectionSummary').textContent=result.beats.length+' beat';
      const weak=result.beats.filter(b=>b.confidence<.45).length;
      $('detectionReview').textContent=weak?weak+' da rivedere':'';$('detectionReview').hidden=!weak;
      drawDetectionPreview(result);$('detectResult').hidden=false;$('detectApply').hidden=false;$('detectRun').textContent='Riprova';
    } catch(error){
      if(generation===detectionGeneration && error.name!=='AbortError'){$('detectError').textContent=error.message||'Rilevamento non riuscito.';$('detectError').hidden=false;}
    } finally {
      if(generation===detectionGeneration){detectionRunning=false;detectionController=null;$('detectProgress').hidden=true;$('detectOptions').hidden=false;$('detectRun').disabled=false;$('detectButton').disabled=!currentFile;}
    }
  }
  function drawDetectionPreview(result){
    const svg=$('detectionPreview'), ns='http://www.w3.org/2000/svg';svg.replaceChildren();
    const points=(result.diagnostics?.localTempo||[]).filter(p=>number(p.bpm)&&p.bpm>0&&number(p.time));
    if(points.length<2){svg.hidden=true;return;}svg.hidden=false;
    let min=Infinity,max=0;for(const p of points){min=Math.min(min,p.bpm);max=Math.max(max,p.bpm);}
    const start=points[0].time,span=Math.max(.1,points.at(-1).time-start),range=Math.max(10,max-min);
    const path=document.createElementNS(ns,'path');
    const stride=Math.max(1,Math.floor(points.length/200));
    path.setAttribute('d',points.filter((_,i)=>i%stride===0||i===points.length-1).map((p,i)=>`${i?'L':'M'}${(36+(p.time-start)/span*316).toFixed(1)} ${(61-(p.bpm-min)/range*48).toFixed(1)}`).join(' '));
    path.setAttribute('fill','none');path.setAttribute('stroke','#69e1cb');path.setAttribute('stroke-width','2');svg.append(path);
    for(const [label,y] of [[Math.round(max),15],[Math.round(min),64]]){const t=document.createElementNS(ns,'text');t.textContent=String(label);t.setAttribute('x','0');t.setAttribute('y',String(y));t.setAttribute('fill','#9daebb');t.setAttribute('font-size','10');svg.append(t);}
  }
  function applyDetection(){
    const proposal=detectionResult;if(!proposal)return;
    if(proposal.token!==loadToken || proposal.revision!==editRevision){cancelDetection();toast('La sessione è cambiata. Ripeti il rilevamento.',true);return;}
    const {start,end,preserveManual,result}=proposal;
    const kept=state.beats.filter(b=>b.time<start || b.time>end || (preserveManual&&b.source!=='auto')).map(b=>({...b}));
    const guides=kept.filter(b=>b.time>=start&&b.time<=end).sort((a,b)=>a.time-b.time);
    const sorted=result.beats.filter(b=>number(b.time)&&number(b.confidence)&&b.time>=start&&b.time<=end).sort((a,b)=>a.time-b.time);
    const occupiedTimes=new Set(kept.map(b=>b.time));
    const generated=[];let guideIndex=0;
    for(const candidate of sorted){
      while(guideIndex<guides.length && guides[guideIndex].time<candidate.time-.09)guideIndex++;
      if(guides[guideIndex] && Math.abs(guides[guideIndex].time-candidate.time)<.09)continue;
      const time=Math.round(candidate.time*1000)/1000;
      if(occupiedTimes.has(time))continue;
      if(generated.length&&time-generated.at(-1).time<.035)continue;
      generated.push({id:uid(),time,source:'auto',confidence:clamp(candidate.confidence,0,1),inferred:!!candidate.inferred,breakBefore:!!candidate.breakBefore});
    }
    const combined=[...kept,...generated].sort((a,b)=>a.time-b.time);
    if(combined.length>MAX_BEATS){$('detectError').textContent='Troppi beat. Restringi il tratto o l’intervallo BPM.';$('detectError').hidden=false;return;}
    if(!generated.length){$('detectError').textContent='Nessun nuovo beat da aggiungere.';$('detectError').hidden=false;return;}
    // A scoped replacement cannot imply continuity across the unanalysed edges.
    if(start>0){const first=combined.findIndex(b=>b.time>=start);if(first>0)combined[first].breakBefore=true;}
    if(end<state.duration){const after=combined.findIndex(b=>b.time>end);if(after>0)combined[after].breakBefore=true;}
    checkpoint();state.beats=combined;state.selectedId=generated[0].id;lastTapId=null;pendingBreak=false;
    $('detectDialog').close();changed();toast(generated.length+' beat aggiunti.');
  }

  function createDemo() {
    const rate=22050, length=60, samples=new Float32Array(rate*length), beats=[];
    let time=1, index=0, held=false, previousWasHold=false;
    while (time<59) {
      beats.push({id:uid(),time:Math.round(time*1000)/1000,breakBefore:false,fermataBefore:previousWasHold});
      previousWasHold=false;
      const frequency=index%4===0?880:660, start=Math.floor(time*rate);
      for(let j=0;j<rate*.09 && start+j<samples.length;j++) samples[start+j]+=Math.sin(2*Math.PI*frequency*j/rate)*Math.exp(-j/(rate*.018))*.46;
      const tempo=time<16?96:time<22?96+(time-16)*5:time<34?126:time<40?126-(time-34)*7:84;
      let interval=60/tempo*(1+Math.sin(index*.52)*.018);
      if(time>47 && !held){interval+=2.3;held=true;previousWasHold=true;}
      time+=interval; index++;
    }
    const buffer=new ArrayBuffer(44+samples.length*2), view=new DataView(buffer);
    const text=(offset,s)=>{ for(let i=0;i<s.length;i++) view.setUint8(offset+i,s.charCodeAt(i)); };
    text(0,'RIFF'); view.setUint32(4,buffer.byteLength-8,true); text(8,'WAVE'); text(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,rate,true); view.setUint32(28,rate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); text(36,'data'); view.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++) view.setInt16(44+i*2,clamp(samples[i],-1,1)*32767,true);
    const output=new Float32Array(5000), stride=Math.ceil(samples.length/output.length);
    for(let i=0;i<output.length;i++) for(let j=i*stride;j<Math.min(samples.length,(i+1)*stride);j++) output[i]=Math.max(output[i],Math.abs(samples[j])/.46);
    // One missing tap and one extra tap make the review workflow visible.
    beats.splice(11,1); const b=beats[49]; beats.push({id:uid(),time:Math.round((b.time+.18)*1000)/1000,breakBefore:false}); beats.sort((a,b)=>a.time-b.time);
    return {file:new File([buffer],'Esempio · rubato e fermata.wav',{type:'audio/wav'}),beats,peaks:output};
  }

  $('openMedia').addEventListener('click',()=>{relinkRequested=false; $('mediaInput').click();});
  $('relinkButton').addEventListener('click',()=>{if(state.media?.demo){const demo=createDemo();loadFile(demo.file,true,demo);}else{relinkRequested=true; $('mediaInput').click();}});
  $('dropZone').addEventListener('click',()=>$('mediaInput').click());
  $('dropZone').addEventListener('keydown',e=>{if(e.code==='Enter'||e.code==='Space'){e.preventDefault();$('mediaInput').click();}});
  $('mediaInput').addEventListener('change',e=>{const file=e.target.files[0]; loadFile(file,relinkRequested); relinkRequested=false; e.target.value='';});
  $('openProject').addEventListener('click',()=>$('projectInput').click());
  $('projectInput').addEventListener('change',e=>{loadProject(e.target.files[0]);e.target.value='';});
  $('demoButton').addEventListener('click',()=>{const demo=createDemo();loadFile(demo.file,false,demo);});
  $('restoreButton').addEventListener('click',()=>{try {adoptProject(validateProject(JSON.parse(localStorage.getItem(STORAGE_KEY))));toast('Sessione ripristinata. Collega la registrazione originale.');} catch {toast('La sessione salvata non è leggibile.',true);}});
  $('helpButton').addEventListener('click',()=>showDialog('helpDialog'));
  $('detectButton').addEventListener('click',openDetection);
  $('chooseAutomatic').addEventListener('click',()=>{$('beatModeDialog').close();openDetection();});
  $('chooseManual').addEventListener('click',()=>{$('beatModeDialog').close();$('playButton').focus();});
  $('detectForm').addEventListener('submit',e=>{e.preventDefault();if($('detectForm').reportValidity())runDetection();});
  $('detectApply').addEventListener('click',applyDetection);
  $('cancelDetection').addEventListener('click',cancelDetection);
  $('detectDialog').addEventListener('close',cancelDetection);
  for(const id of ['detectScope','detectMin','detectMax','detectHint','detectAnchors'])$(id).addEventListener('input',()=>{
    if(detectionRunning)return;detectionResult=null;$('detectResult').hidden=true;$('detectApply').hidden=true;$('detectRun').textContent='Rileva';
  });
  $('clickTrackButton').addEventListener('click',async()=>{
    if(!clickTrack)return toast('Click non disponibile.',true);
    try{const active=await clickTrack.setEnabled(!clickTrack.enabled);$('clickTrackButton').setAttribute('aria-pressed',String(active));$('clickVolume').hidden=!active;$('clickAutoLabel').hidden=!active;$('clickAuto').disabled=!clickTrack.balanceAvailable;if(!clickTrack.balanceAvailable){$('clickAuto').checked=false;toast('Bilanciamento automatico non disponibile. Regola il volume del click.');}}
    catch(error){toast(error.message||'Click non disponibile.',true);}
  });
  $('clickAuto').addEventListener('change',e=>clickTrack?.setAutoBalance(e.target.checked));
  $('clickVolume').addEventListener('input',e=>{const value=Number(e.target.value);clickTrack?.setVolume(value);e.target.setAttribute('aria-valuetext',Math.round(value*100)+'%');});
  $('playButton').addEventListener('click',togglePlay); $('restartButton').addEventListener('click',()=>seekTo(0));
  $('seek').addEventListener('input',e=>seekTo(Number(e.target.value)));
  $('speed').addEventListener('change',e=>{media.playbackRate=Number(e.target.value);media.preservesPitch=true;});
  $('volume').addEventListener('input',e=>{media.volume=Number(e.target.value);});
  $('tapButton').addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();tap();});
  $('tapButton').addEventListener('click',e=>{if(e.detail===0)tap();});
  $('undoButton').addEventListener('click',undo); $('redoButton').addEventListener('click',redo);
  $('zoomIn').addEventListener('click',()=>zoom(.5)); $('zoomOut').addEventListener('click',()=>zoom(2)); $('fitView').addEventListener('click',fitView);
  $('pan').addEventListener('input',e=>{setFollow(false);const span=viewEnd-viewStart;viewStart=Number(e.target.value);viewEnd=viewStart+span;updateViewControls();requestChartRender();});
  $('followPlayback').addEventListener('click',()=>{setFollow(!followPlayback);if(followPlayback)followPlayhead(currentTime(),true);});
  $('focusBeat').addEventListener('click',()=>inspectBeat(state.selectedId));
  $('yZoomIn').addEventListener('click',()=>zoomVertical(.65));$('yZoomOut').addEventListener('click',()=>zoomVertical(1.5));
  $('bpmMin').addEventListener('change',setVerticalRange);$('bpmMax').addEventListener('change',setVerticalRange);
  $('yAuto').addEventListener('click',()=>{yRange=null;renderCharts();});
  $('showRaw').addEventListener('change',requestChartRender); $('showSmooth').addEventListener('change',requestChartRender);
  $('previousBeat').addEventListener('click',()=>{const i=state.beats.findIndex(b=>b.id===state.selectedId);if(i>0)selectBeat(state.beats[i-1].id,true);});
  $('nextBeat').addEventListener('click',()=>{const i=state.beats.findIndex(b=>b.id===state.selectedId);if(i<state.beats.length-1)selectBeat(state.beats[i+1].id,true);});
  $('beatTime').addEventListener('change',e=>{if(!e.target.value.trim()||!number(e.target.valueAsNumber)){toast('Inserisci una posizione valida in secondi.',true);renderEditor();return;}moveBeat(state.selectedId,e.target.valueAsNumber);});
  document.querySelectorAll('[data-nudge]').forEach(button=>button.addEventListener('click',()=>{const beat=state.beats.find(b=>b.id===state.selectedId);if(beat)moveBeat(beat.id,beat.time+Number(button.dataset.nudge));}));
  $('deleteBeat').addEventListener('click',removeSelected);
  $('confirmBeat').addEventListener('click',()=>{const beat=state.beats.find(b=>b.id===state.selectedId);if(beat){checkpoint();beat.source='manual';delete beat.confidence;delete beat.inferred;changed();}});
  $('breakBefore').addEventListener('change',e=>setBeatBreak(e.target.checked));
  $('connectBeat').addEventListener('click',()=>setBeatBreak(false));
  $('editSections').addEventListener('click',openSections);
  $('addSection').addEventListener('click',addSection);
  $('sectionsForm').addEventListener('submit',e=>{e.preventDefault();applySections();});
  $('automaticSections').addEventListener('click',restoreAutomaticSections);
  $('fermataBefore').addEventListener('change',e=>{const beat=state.beats.find(b=>b.id===state.selectedId);if(beat){checkpoint();beat.source='manual';delete beat.confidence;delete beat.inferred;beat.fermataBefore=e.target.checked;if(beat.fermataBefore)beat.breakBefore=false;changed();}});
  $('auditionBeat').addEventListener('click',async()=>{const beat=state.beats.find(b=>b.id===state.selectedId);if(!beat||!hasMedia)return;seekTo(Math.max(0,beat.time-.5));try{await media.play();}catch{toast('Impossibile avviare la riproduzione.',true);}});
  $('settingsButton').addEventListener('click',()=>{for(const id of ['beatUnit','minSectionSeconds','smoothing'])$(id).value=state.options[id];$('sectionThreshold').value=Math.round(state.options.sectionThreshold*100);showDialog('settingsDialog');});
  $('settingsForm').addEventListener('submit',e=>{e.preventDefault();if(!$('settingsForm').reportValidity())return;checkpoint();state.options={beatUnit:Number($('beatUnit').value),sectionThreshold:Number($('sectionThreshold').value)/100,minSectionSeconds:Number($('minSectionSeconds').value),smoothing:Number($('smoothing').value)};$('settingsDialog').close();changed();});
  $('clearButton').addEventListener('click',async()=>{media.pause();if(await confirmAction('Cancella i beat','Rimuovere tutti i beat? Puoi annullare questa operazione.')){checkpoint();state.beats=[];state.sectionBoundaries=null;state.selectedId=null;lastTapId=null;pendingBreak=false;changed();}});
  $('beatListButton').addEventListener('click',()=>{page=0;renderBeatTable();showDialog('beatListDialog');});
  $('prevPage').addEventListener('click',()=>{page--;renderBeatTable();});$('nextPage').addEventListener('click',()=>{page++;renderBeatTable();});
  $('exportButton').addEventListener('click',()=>showDialog('exportDialog'));
  $('saveProject').addEventListener('click',exportProject);
  $('saveBeats').addEventListener('click',()=>{const map=new Map(analysis.intervals.map(i=>[i.beatId,i]));download(csv([['beat','secondi','BPM_semiminima','tendenza_BPM','interruzione_prima','fermata_confermata','agogica','segnalazione','origine','supporto_rilevamento','interpolato'],...state.beats.map((b,i)=>{const interval=map.get(b.id);return[i+1,b.time.toFixed(3),interval?.bpm.toFixed(4),interval?.smoothed?.toFixed(4),b.breakBefore?'si':'no',b.fermataBefore?'si':'no',interval?.expressive||'',interval?.anomaly||'',b.source||'manual',number(b.confidence)?b.confidence.toFixed(4):'',b.inferred?'si':'no'];})]),baseName()+'.beat.csv','text/csv;charset=utf-8');});
  $('saveSections').addEventListener('click',()=>download(csv([['sezione','inizio_secondi','fine_secondi','BPM_medio_semiminima','intervalli'],...analysis.sections.map((s,i)=>[i+1,s.start.toFixed(3),s.end.toFixed(3),s.bpm.toFixed(4),s.count])]),baseName()+'.sezioni.csv','text/csv;charset=utf-8'));
  $('saveSvg').addEventListener('click',()=>exportGraphic('svg'));$('savePng').addEventListener('click',()=>exportGraphic('png'));
  $('saveMix').addEventListener('click',()=>openAudioExport('mix'));$('saveClicks').addEventListener('click',()=>openAudioExport('clicks'));
  $('audioExportForm').addEventListener('submit',e=>{e.preventDefault();if($('audioExportForm').reportValidity())exportAudio();});
  $('cancelAudioExport').addEventListener('click',cancelAudioExport);$('audioExportDialog').addEventListener('close',cancelAudioExport);

  document.addEventListener('keydown',e=>{
    if(e.code==='Escape')hideTooltip();
    if(e.repeat || document.querySelector('dialog[open]'))return;
    const target=e.target;
    if(target.closest('input,select,textarea,[contenteditable="true"]'))return;
    if((e.ctrlKey||e.metaKey)&&e.code==='KeyZ'){e.preventDefault();e.shiftKey?redo():undo();return;}
    if(e.ctrlKey||e.metaKey||e.altKey)return;
    if(e.code==='Space') {if(target.closest('button,a,summary,[role="button"]')&&target.id!=='tapButton')return;e.preventDefault();tap();}
    else if(e.code==='KeyP'){e.preventDefault();togglePlay();}
    else if(e.code==='ArrowLeft'||e.code==='ArrowRight'){if(!state.media)return;e.preventDefault();seekTo(currentTime()+(e.code==='ArrowLeft'?-1:1)*(e.shiftKey?5:1));}
    else if(e.code==='Delete'||e.code==='Backspace'){if(state.selectedId){e.preventDefault();removeSelected();}}
  });
  // A pointer click on Play/zoom must not trap the next Space as a native
  // button activation. Keyboard-focused controls retain native behavior.
  let pointerInteraction=false;
  document.addEventListener('pointerdown',()=>{pointerInteraction=true;},true);
  document.addEventListener('keydown',()=>{pointerInteraction=false;},true);
  document.addEventListener('click',e=>{
    if(e.detail>0 && !e.target.closest('dialog'))e.target.closest('button')?.blur();
  });
  for(const id of ['speed','volume','clickVolume','seek','pan'])$(id).addEventListener('change',e=>{if(pointerInteraction)e.target.blur();});
  let dragDepth=0;
  document.addEventListener('dragenter',e=>{if(!Array.from(e.dataTransfer?.types||[]).includes('Files'))return;e.preventDefault();dragDepth++;document.body.classList.add('dragging-file');$('dropZone').classList.add('drag-over');});
  document.addEventListener('dragover',e=>{if(Array.from(e.dataTransfer?.types||[]).includes('Files'))e.preventDefault();});
  document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;document.body.classList.remove('dragging-file');$('dropZone').classList.remove('drag-over');}});
  document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.body.classList.remove('dragging-file');$('dropZone').classList.remove('drag-over');if(document.querySelector('dialog[open]'))return;const file=e.dataTransfer?.files[0];if(file){/\.json$/i.test(file.name)?loadProject(file):loadFile(file);}});

  let tipTimer=null, tipTarget=null;
  function hideTooltip(){clearTimeout(tipTimer);$('tooltip').hidden=true;if(tipTarget)tipTarget.removeAttribute('aria-describedby');tipTarget=null;}
  function queueTooltip(target){if(!target||!target.dataset.tip)return;hideTooltip();tipTarget=target;tipTimer=setTimeout(()=>{if(tipTarget!==target)return;const tip=$('tooltip');tip.textContent=target.dataset.tip;tip.hidden=false;target.setAttribute('aria-describedby','tooltip');const rect=target.getBoundingClientRect(),size=tip.getBoundingClientRect();tip.style.left=clamp(rect.left+rect.width/2-size.width/2,8,window.innerWidth-size.width-8)+'px';tip.style.top=(rect.top>size.height+16?rect.top-size.height-8:rect.bottom+8)+'px';},450);}
  document.addEventListener('pointerover',e=>{if(e.pointerType!=='touch')queueTooltip(e.target.closest('[data-tip]'));});
  document.addEventListener('pointerout',e=>{if(tipTarget&&!tipTarget.contains(e.relatedTarget))hideTooltip();});
  document.addEventListener('focusin',e=>queueTooltip(e.target.closest('[data-tip]')));
  document.addEventListener('focusout',hideTooltip); document.addEventListener('pointerdown',hideTooltip);window.addEventListener('scroll',hideTooltip,true);
  window.addEventListener('pagehide',()=>{persist();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(hasMedia&&!media.paused){media.pause();toast('Ascolto in pausa: la pagina non è visibile.');}persist();}});
  try { const raw=localStorage.getItem(STORAGE_KEY); if(raw){validateProject(JSON.parse(raw));$('restoreButton').hidden=false;} } catch { /* Corrupt/inaccessible local storage never blocks the app. */ }
  render();
})();
