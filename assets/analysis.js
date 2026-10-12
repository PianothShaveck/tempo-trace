/* Tempo Trace — zero-dependency analysis of taps in original media seconds.
 *
 * TempoAnalysis.analyze(beats, options, sectionBoundaries = null) (also CommonJS).
 * sectionBoundaries: optional manual starting times, snapped to existing beats.
 * null keeps automatic segmentation; [] merges all measured coverage.
 * beats: [{id, time, breakBefore?, fermataBefore?}]; invalid/negative times are ignored,
 * duplicate times are merged, and input is never mutated. A breakBefore on a
 * beat prevents an interval from the preceding beat and starts a new group.
 * options: beatUnit (quarter notes per tap, default 1), sectionThreshold
 * (relative change, .12), minSectionSeconds (8), smoothing (odd median window, 5).
 *
 * Returns {intervals, sections, stats, anomalies, events}. Intervals have {index, start,
 * end, time, bpm, smoothed, anomaly, expressive, beatId, breakBefore}; time is the midpoint,
 * beatId is the ENDING tap's id, and breakBefore begins a continuous group.
 * Sections have {id, start, end, bpm, count}; count is the number of intervals.
 * stats: {mean, start, end, min, max}; empty values are null. mean and section
 * bpm are exact tap-count / original-duration means, INCLUDING flagged taps and
 * held intervals. fermataBefore marks the interval ENDING at that tap as held.
 * expressive is null, 'accelerando', 'rallentando', 'fermata', or 'possible-fermata'.
 * Events: {type, label, start, end, beatId?, confidence:'manual'|'candidate'|'detected'}.
 * Held intervals (manual or candidate) do not influence trend, segmentation, or
 * representative start/end BPM; raw BPM and count/time means remain unchanged.
 * If no usable edge intervals remain, start/end are null. Gradual expressive
 * spans are not split internally into stable-tempo sections. These are heuristics,
 * not score-based recognition: a hold and a missed tap cannot be distinguished.
 * Anomalies are suggestions only: this engine NEVER inserts, moves or deletes
 * taps. Median smoothing / robust segmentation do not change measured means.
 * Playback rate is intentionally not an input: currentTime is media time.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TempoAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const median = values => {
    if (!values.length) return null;
    const a = values.slice().sort((a, b) => a - b);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const finiteOption = (value, fallback, min, max) =>
    typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
  const isHold = interval => interval.expressive === 'fermata' || interval.expressive === 'possible-fermata';
  const isRamp = interval => interval.expressive === 'accelerando' || interval.expressive === 'rallentando';

  function normalizeBeats(input) {
    if (!Array.isArray(input)) return [];
    const sorted = input.filter(b => b && typeof b.time === 'number' &&
      Number.isFinite(b.time) && b.time >= 0).map((b, index) => ({
      id: b.id == null ? 'beat-' + index : b.id,
      time: b.time,
      breakBefore: b.breakBefore === true,
      fermataBefore: b.fermataBefore === true
    })).sort((a, b) => a.time - b.time);
    const result = [];
    for (const beat of sorted) {
      const previous = result[result.length - 1];
      if (previous && previous.time === beat.time) {
        previous.breakBefore = previous.breakBefore || beat.breakBefore;
        previous.fermataBefore = previous.fermataBefore || beat.fermataBefore;
      } else result.push(beat);
    }
    return result;
  }

  function neighboringDurations(group, from, to) {
    const values = [];
    for (let j = Math.max(0, from - 4); j < Math.min(group.length, to + 5); j++) {
      if ((j < from || j > to) && !isHold(group[j])) values.push(group[j].end - group[j].start);
    }
    return values;
  }

  // Both sides must return to the same pulse. This avoids declaring the first
  // beat of a real tempo change an outlier. At an edge, require three neighbors.
  function returnsToPulse(group, from, to, baseline) {
    const close = i => Math.abs(Math.log((group[i].end - group[i].start) / baseline)) < .25;
    const hasLeft = from > 0;
    const hasRight = to + 1 < group.length;
    if (hasLeft && hasRight) return close(from - 1) && close(to + 1);
    if (hasRight && group.length - to - 1 >= 3) return close(to + 1) && close(to + 2) && close(to + 3);
    if (hasLeft && from >= 3) return close(from - 1) && close(from - 2) && close(from - 3);
    return false;
  }

  function markAnomalies(group) {
    // One accidental extra tap splits a normal interval into TWO short ones.
    for (let i = 0; i < group.length - 1; i++) {
      if (isHold(group[i]) || isHold(group[i + 1])) continue;
      const neighbors = neighboringDurations(group, i, i + 1);
      if (neighbors.length < 3) continue;
      const base = median(neighbors);
      const a = group[i].end - group[i].start;
      const b = group[i + 1].end - group[i + 1].start;
      if (Math.min(a, b) < .8 * base && Math.max(a, b) < .98 * base &&
          Math.abs((a + b) / base - 1) <= .16 && returnsToPulse(group, i, i + 1, base)) {
        group[i].anomaly = 'Tap in più?';
        group[i + 1].anomaly = 'Tap in più?';
        i++;
      }
    }
    for (let i = 0; i < group.length; i++) {
      if (group[i].anomaly || isHold(group[i])) continue;
      const neighbors = neighboringDurations(group, i, i);
      if (neighbors.length < 3) continue;
      const base = median(neighbors);
      const logBase = Math.log(base);
      const spread = median(neighbors.map(n => Math.abs(Math.log(n) - logBase)));
      const ratio = (group[i].end - group[i].start) / base;
      if (Math.abs(Math.log(ratio)) <= Math.max(Math.log(1.4), 4 * spread) ||
          !returnsToPulse(group, i, i, base)) continue;
      // A long pulse is acoustically ambiguous: fermata, expressive hold, or
      // missing tap(s). Surface one candidate event, never a duplicate warning.
      if (ratio > 1) group[i].expressive = 'possible-fermata';
      else if (ratio <= .7) group[i].anomaly = 'Tap ravvicinato?';
      else group[i].anomaly = 'Intervallo insolito';
    }
  }

  function detectRamps(group) {
    const events = [];
    const usable = interval => !interval.anomaly && !isHold(interval);
    const trend = group.map((interval, i) => usable(interval) ? median(group
      .slice(Math.max(0, i - 2), Math.min(group.length, i + 3))
      .filter(usable).map(sample => Math.log(sample.bpm))) : null);
    let start = -1, direction = 0, quiet = 0, contrary = 0;
    function finish(end) {
      if (start < 0 || end - start + 1 < 6) return;
      const duration = group[end].end - group[start].start;
      const change = trend[end] - trend[start];
      let variation = 0, maximumStep = 0, movingSteps = 0;
      for (let j = start + 1; j <= end; j++) {
        const step = Math.abs(trend[j] - trend[j - 1]);
        variation += step; maximumStep = Math.max(maximumStep, step);
        if (step > .0015) movingSteps++;
      }
      if (duration < 3 || Math.abs(change) < Math.log(1.1) || movingSteps < 4 ||
          Math.abs(change) < .72 * variation || maximumStep > .45 * Math.abs(change)) return;
      const type = change > 0 ? 'accelerando' : 'rallentando';
      for (let j = start; j <= end; j++) if (usable(group[j])) group[j].expressive = type;
      events.push({type, label: type === 'accelerando' ? 'Accelerando' : 'Rallentando',
        start: group[start].start, end: group[end].end, confidence: 'detected'});
    }
    for (let i = 1; i < group.length; i++) {
      if (trend[i] == null || trend[i - 1] == null) {
        finish(i - 1); start = -1; direction = 0; quiet = 0; contrary = 0; continue;
      }
      const delta = trend[i] - trend[i - 1];
      if (Math.abs(delta) > .12) {
        finish(i - 1); start = -1; direction = 0; quiet = 0; contrary = 0; continue;
      }
      if (Math.abs(delta) <= .0015) {
        quiet++;
        if (quiet > 2) { finish(i - quiet); start = -1; direction = 0; contrary = 0; }
        continue;
      }
      quiet = 0;
      const sign = Math.sign(delta);
      if (!direction) { start = i - 1; direction = sign; contrary = 0; }
      else if (sign !== direction) {
        contrary++;
        if (contrary >= 2 || Math.abs(delta) > .025) {
          finish(i - contrary); start = i - contrary; direction = sign; contrary = 0;
        }
      } else contrary = 0;
    }
    finish(group.length - 1 - quiet);
    return events;
  }

  function smoothGroup(group, windowSize) {
    const radius = Math.floor(windowSize / 2);
    for (let i = 0; i < group.length; i++) {
      const values = group.slice(Math.max(0, i - radius), Math.min(group.length, i + radius + 1))
        .filter(interval => !interval.anomaly && !isHold(interval)).map(interval => interval.bpm);
      group[i].smoothed = median(values) ?? (isHold(group[i]) ? null : group[i].bpm);
    }
  }

  function windowSummary(group, from, to) {
    const values = [];
    let duration = 0;
    for (let i = from; i < to; i++) {
      if (group[i].anomaly || isHold(group[i])) continue;
      const weight = group[i].end - group[i].start;
      values.push({value: Math.log(group[i].bpm), weight});
      duration += weight;
    }
    if (values.length < 3 || !duration) return null;
    values.sort((a, b) => a.value - b.value);
    let running = 0;
    let center = values[values.length - 1].value;
    for (const sample of values) {
      running += sample.weight;
      if (running >= duration / 2) { center = sample.value; break; }
    }
    let deviation = 0;
    for (const sample of values) deviation += sample.weight * Math.abs(sample.value - center);
    return {center, deviation: deviation / duration, count: values.length};
  }

  // A gradual transition can connect two stable tempos without presenting a
  // local step. Compare stable evidence BEFORE the whole ramp with the stable
  // plateau AFTER it; retain the ramp in the preceding section's measured mean.
  // Each side must provide the configured duration of actual non-held evidence.
  function plateauAroundRamp(group, split, from, to, minSeconds) {
    const type = group[split - 1].expressive;
    if (!isRamp(group[split - 1]) || group[split].expressive === type) return null;
    let rampStart = split - 1;
    while (rampStart > from && group[rampStart - 1].expressive === type) rampStart--;
    let left = rampStart, right = split, beforeDuration = 0, afterDuration = 0;
    let beforeCount = 0, afterCount = 0;
    while (left > from && (beforeDuration + 1e-9 < minSeconds || beforeCount < 3)) {
      const interval = group[left - 1];
      if (isRamp(interval)) break;
      left--;
      if (!interval.anomaly && !isHold(interval)) {
        beforeDuration += interval.end - interval.start; beforeCount++;
      }
    }
    while (right < to && (afterDuration + 1e-9 < minSeconds || afterCount < 3)) {
      const interval = group[right];
      if (isRamp(interval)) break;
      right++;
      if (!interval.anomaly && !isHold(interval)) {
        afterDuration += interval.end - interval.start; afterCount++;
      }
    }
    if (beforeDuration + 1e-9 < minSeconds || afterDuration + 1e-9 < minSeconds ||
        beforeCount < 3 || afterCount < 3) return null;
    return {before: windowSummary(group, left, rampStart), after: windowSummary(group, split, right)};
  }

  // Greedy binary change-point segmentation. Each candidate has a complete
  // time window on BOTH sides. Robust centers reject isolated taps; weighted
  // absolute deviations favor the actual transition over an anticipatory split.
  // The dispersion gate avoids carving ordinary smooth rubato into sections.
  function segmentGroup(group, options, unit) {
    const output = [];
    const minSeconds = options.minSectionSeconds;
    const threshold = Math.log1p(options.sectionThreshold);
    const stack = [[0, group.length]];
    while (stack.length) {
      const [from, to] = stack.pop();
      let best = -1;
      let bestScore = 0;
      let left = from;
      let right = from + 1;
      if (group[to - 1].end - group[from].start + 1e-9 >= 2 * minSeconds && to - from >= 6) {
        for (let split = from + 3; split <= to - 3; split++) {
          const boundary = group[split].start;
          if (isHold(group[split]) || isHold(group[split - 1]) ||
              (isRamp(group[split]) && group[split].expressive === group[split - 1].expressive)) continue;
          if (boundary - group[from].start + 1e-9 < minSeconds ||
              group[to - 1].end - boundary + 1e-9 < minSeconds) continue;
          while (left + 1 < split && boundary - group[left + 1].start >= minSeconds) left++;
          right = Math.max(right, split + 1);
          while (right < to && group[right - 1].end - boundary < minSeconds) right++;
          const plateaus = plateauAroundRamp(group, split, from, to, minSeconds);
          const before = plateaus ? plateaus.before : windowSummary(group, left, split);
          const after = plateaus ? plateaus.after : windowSummary(group, split, right);
          if (!before || !after) continue;
          const change = Math.abs(after.center - before.center);
          const dispersion = before.deviation + after.deviation;
          if (change + 1e-9 < threshold || change <= 2.2 * dispersion) continue;
          const score = change - 2 * dispersion;
          const midpoint = (group[from].start + group[to - 1].end) / 2;
          if (score > bestScore + 1e-10 || (best !== -1 && Math.abs(score - bestScore) <= 1e-10 &&
              Math.abs(boundary - midpoint) < Math.abs(group[best].start - midpoint))) { bestScore = score; best = split; }
        }
      }
      if (best !== -1) {
        stack.push([best, to], [from, best]);
      } else {
        let duration = 0;
        for (let i = from; i < to; i++) duration += group[i].end - group[i].start;
        output.push({start: group[from].start, end: group[to - 1].end,
          bpm: (to - from) * 60 * unit / duration, count: to - from});
      }
    }
    return output;
  }

  function edgeTempo(group, fromStart) {
    const ordered = fromStart ? group : group.slice().reverse();
    // Limit the sampling to the edge, even when it contains many bad taps.
    const nearEdge = ordered.slice(0, 7);
    const values = nearEdge.filter(interval => !interval.anomaly && !isHold(interval)).slice(0, 5).map(interval => interval.bpm);
    return median(values);
  }

  // Missing coverage is not evidence of a new tempo. A boundary at a gap
  // requires a persistent tempo change supported by both measured sides.
  function mergeAcrossGaps(sections, intervals, config, unit) {
    const byStart=new Map(intervals.map((p,i)=>[p.start,i])),byEnd=new Map(intervals.map((p,i)=>[p.end,i]));
    function evidence(section,fromEnd){
      const from=byStart.get(section.start),to=byEnd.get(section.end)+1;
      let a=fromEnd?to:from,b=a,duration=0,count=0;
      while((fromEnd?a>from:b<to)&&(duration<config.minSectionSeconds||count<3)){
        const p=intervals[fromEnd?--a:b++];
        if(!p.anomaly&&!isHold(p)){duration+=p.end-p.start;count++;}
      }
      return {duration,summary:windowSummary(intervals,a,b)};
    }
    const output=[];
    for(const section of sections){
      const previous=output.at(-1);
      if(previous&&section.start>previous.end+.00001){
        const a=evidence(previous,true),b=evidence(section,false),left=a.summary,right=b.summary;
        const change=left&&right?Math.abs(left.center-right.center):0;
        const distinct=a.duration+1e-9>=config.minSectionSeconds&&b.duration+1e-9>=config.minSectionSeconds&&left&&right&&change>=Math.log1p(config.sectionThreshold)&&change>2.2*(left.deviation+right.deviation);
        if(!distinct){
          const duration=previous.count*60*unit/previous.bpm+section.count*60*unit/section.bpm;
          previous.end=section.end;previous.count+=section.count;previous.bpm=previous.count*60*unit/duration;continue;
        }
      }
      output.push({...section});
    }
    return output;
  }

  // Manual boundaries snap to starting beats. Means use measured coverage,
  // excluding the silent/unmarked duration of a gap even after a merge.
  function sectionsAtBoundaries(intervals,boundaries,unit=1){
    if(!intervals.length)return [];
    const cuts=new Set([0,intervals.length]);
    for(const time of boundaries||[]){
      if(!Number.isFinite(time)||time<=intervals[0].start||time>=intervals.at(-1).end)continue;
      let low=0,high=intervals.length;
      while(low<high){const mid=(low+high)>>>1;if(intervals[mid].start<time)low=mid+1;else high=mid;}
      if(low===intervals.length)low--;
      else if(low>0&&time-intervals[low-1].start<intervals[low].start-time)low--;
      if(low>0)cuts.add(low);
    }
    const indices=[...cuts].sort((a,b)=>a-b),result=[];
    for(let n=1;n<indices.length;n++){
      const from=indices[n-1],to=indices[n];let duration=0;
      for(let i=from;i<to;i++)duration+=intervals[i].end-intervals[i].start;
      result.push({start:intervals[from].start,end:intervals[to-1].end,count:to-from,bpm:(to-from)*60*unit/duration,id:'section-'+n});
    }
    return result;
  }

  function analyze(input, settings, sectionBoundaries=null) {
    const options = settings && typeof settings === 'object' ? settings : {};
    const unit = typeof options.beatUnit === 'number' && Number.isFinite(options.beatUnit) &&
      options.beatUnit > 0 && options.beatUnit <= 16 ? options.beatUnit : 1;
    const config = {
      sectionThreshold: finiteOption(options.sectionThreshold, .12, .02, 1),
      minSectionSeconds: finiteOption(options.minSectionSeconds, 8, 2, 120),
      smoothing: Math.floor(finiteOption(options.smoothing, 5, 1, 31))
    };
    if (config.smoothing % 2 === 0) config.smoothing++;
    const beats = normalizeBeats(input);
    const intervals = [];
    const groups = [];
    let current = [];
    for (let i = 1; i < beats.length; i++) {
      if (beats[i].breakBefore) {
        if (current.length) groups.push(current);
        current = [];
        continue;
      }
      const start = beats[i - 1].time;
      const end = beats[i].time;
      const bpm = 60 * unit / (end - start);
      if (!(end > start) || !Number.isFinite(bpm) || bpm <= 0) continue;
      const interval = {index: intervals.length, start, end, time: start + (end - start) / 2,
        bpm, smoothed: bpm, anomaly: null, expressive: beats[i].fermataBefore ? 'fermata' : null,
        beatId: beats[i].id, breakBefore: current.length === 0};
      intervals.push(interval);
      current.push(interval);
    }
    if (current.length) groups.push(current);
    if (!intervals.length) return {intervals: [], sections: [],
      stats: {mean: null, start: null, end: null, min: null, max: null}, anomalies: [], events: []};
    let sections = [];
    let events = [];
    for (const group of groups) {
      markAnomalies(group);
      events = events.concat(detectRamps(group));
      for (const interval of group) if (isHold(interval)) events.push({
        type: interval.expressive,
        label: interval.expressive === 'fermata' ? 'Fermata' : 'Fermata o tap mancanti?',
        start: interval.start, end: interval.end, beatId: interval.beatId,
        confidence: interval.expressive === 'fermata' ? 'manual' : 'candidate'
      });
      smoothGroup(group, config.smoothing);
      sections = sections.concat(segmentGroup(group, config, unit));
    }
    sections.sort((a, b) => a.start - b.start);
    sections=Array.isArray(sectionBoundaries)?sectionsAtBoundaries(intervals,sectionBoundaries,unit):mergeAcrossGaps(sections,intervals,config,unit);
    sections.forEach((section,i)=>{section.id='section-'+(i+1);});
    let duration = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const interval of intervals) {
      duration += interval.end - interval.start;
      min = Math.min(min, interval.bpm);
      max = Math.max(max, interval.bpm);
    }
    return {intervals, sections, stats: {
      mean: intervals.length * 60 * unit / duration,
      start: edgeTempo(groups[0], true), end: edgeTempo(groups[groups.length - 1], false), min, max
    }, anomalies: intervals.filter(interval => interval.anomaly), events: events.sort((a, b) => a.start - b.start)};
  }

  return Object.freeze({analyze, normalizeBeats, sectionsAtBoundaries});
});
