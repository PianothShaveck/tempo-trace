/* Tempo Trace — original, dependency-free offline beat tracker.
 * Spectral-flux novelty, a local autocorrelation tempo path, and adaptive
 * dynamic programming. Conceptual references (no copied implementation):
 * Ellis, 2007, Beat Tracking by Dynamic Programming; Chiu et al., 2023,
 * Local Periodicity-Based Beat Tracking for Expressive Classical Piano Music.
 * No score or trained model: metrical level and sustained notes stay ambiguous.
 *
 * analyze(monoFloat32, sampleRate, options, onProgress) -> {beats, summary,
 * alternatives, diagnostics}. Beat times are original audio seconds. Progress
 * is {stage, progress} in [0,1]. Run in a Worker for long recordings.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  api.createWorkerSource = () => '"use strict";const detector=(' + factory.toString() + ')();' +
    'self.onmessage=function(event){try{const input=event.data;const result=detector.analyze(input.samples,input.sampleRate,input.options,' +
    'function(progress){self.postMessage(Object.assign({type:"progress"},progress));});self.postMessage({type:"result",result:result});}' +
    'catch(error){self.postMessage({type:"error",message:error&&error.message?error.message:"Analisi non riuscita."});}};';
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TempoDetector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '1.0.0';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const median = values => {
    if (!values.length) return 0;
    const s = Array.from(values).sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const option = (n, fallback, lo, hi) => typeof n === 'number' && Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
  function percentile(values, q) {
    if (!values.length) return 0;
    const a = Array.from(values).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor((a.length - 1) * q))];
  }
  function meanWindow(input, radius) {
    const prefix = new Float64Array(input.length + 1), out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) prefix[i + 1] = prefix[i] + input[i];
    for (let i = 0; i < input.length; i++) {
      const a = Math.max(0, i - radius), b = Math.min(input.length, i + radius + 1);
      out[i] = (prefix[b] - prefix[a]) / (b - a);
    }
    return out;
  }
  function makeFFT(size) {
    const bits = Math.log2(size), reversal = new Uint32Array(size);
    const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
    for (let i = 0; i < size; i++) {
      let r = 0, v = i;
      for (let j = 0; j < bits; j++) { r = (r << 1) | (v & 1); v >>>= 1; }
      reversal[i] = r;
    }
    for (let i = 0; i < size / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / size); sin[i] = -Math.sin(2 * Math.PI * i / size); }
    return (real, imag) => {
      for (let i = 0; i < size; i++) {
        const j = reversal[i];
        if (j > i) { const v = real[i]; real[i] = real[j]; real[j] = v; }
        imag[i] = 0;
      }
      for (let len = 2; len <= size; len *= 2) {
        const half = len / 2, step = size / len;
        for (let start = 0; start < size; start += len) {
          for (let j = 0; j < half; j++) {
            const k = j * step, a = start + j, b = a + half;
            const tr = real[b] * cos[k] - imag[b] * sin[k];
            const ti = real[b] * sin[k] + imag[b] * cos[k];
            real[b] = real[a] - tr; imag[b] = imag[a] - ti;
            real[a] += tr; imag[a] += ti;
          }
        }
      }
    };
  }
  function extractFeatures(samples, sampleRate, report) {
    const hop = Math.max(1, Math.round(sampleRate / 100)), rate = sampleRate / hop;
    const size = 2 ** Math.round(Math.log2(sampleRate * .093));
    const frames = Math.ceil(samples.length / hop), bins = size / 2;
    const window = new Float64Array(size), real = new Float64Array(size), imag = new Float64Array(size);
    const previous = new Float32Array(bins), current = new Float32Array(bins), fft = makeFFT(size);
    const bands = Array.from({length: 4}, () => new Float32Array(frames));
    const mass = Array.from({length: 4}, () => new Float32Array(frames));
    const energy = new Float32Array(frames), bandFor = new Uint8Array(bins), counts = new Uint32Array(4);
    for (let i = 0; i < size; i++) window[i] = .5 - .5 * Math.cos(2 * Math.PI * i / size);
    for (let i = 0; i < bins; i++) {
      const hz = i * sampleRate / size;
      bandFor[i] = hz < 180 ? 0 : hz < 700 ? 1 : hz < 2400 ? 2 : 3;
      counts[bandFor[i]]++;
    }
    for (let frame = 0; frame < frames; frame++) {
      const start = frame * hop - size / 2;
      let sum = 0;
      for (let i = 0; i < size; i++) {
        const idx = start + i, v = idx >= 0 && idx < samples.length ? samples[idx] : 0;
        real[i] = (Number.isFinite(v) ? v : 0) * window[i];
        sum += real[i] * real[i];
      }
      energy[frame] = Math.sqrt(sum / size);
      fft(real, imag);
      for (let i = 1; i < bins; i++) current[i] = Math.log1p(Math.hypot(real[i], imag[i]) * 500 / size);
      for (let i = 2; i < bins - 1; i++) {
        // Neighbouring-bin suppression reduces spectral drift on sustained piano.
        const prev = Math.max(previous[i], .8 * previous[i - 1], .8 * previous[i + 1]);
        bands[bandFor[i]][frame] += Math.max(0, current[i] - prev);
        mass[bandFor[i]][frame] += current[i];
      }
      previous.set(current);
      if (report && frame % 600 === 0) report({stage: 'features', progress: .02 + .44 * frame / frames});
    }
    const novelty = new Float32Array(frames), quiet = percentile(energy, .9) * .015;
    const weights = [.3, .36, .27, .07];
    for (let band = 0; band < bands.length; band++) {
      const raw = bands[band], local = meanWindow(raw, Math.round(rate * 1.2));
      const floor = percentile(raw, .75) * .06 + percentile(raw, .95) * .015 + 1e-9;
      for (let i = 0; i < frames; i++) {
        const positive = Math.max(0, raw[i] - local[i] * .55);
        // Relative spectral change must be real; temporal whitening alone
        // would promote FFT leakage in a sustained tone into fake attacks.
        const gate = Math.min(1, (raw[i] / (mass[band][i] * .008 + 1e-10)) ** 2);
        novelty[i] += weights[band] * Math.min(5, positive / (local[i] + floor)) * gate;
      }
    }
    // A narrow kernel keeps the autocorrelation tolerant of expressive attacks.
    const smooth = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      smooth[i] = (.5 * novelty[i] + .22 * (novelty[i - 1] || 0) + .22 * (novelty[i + 1] || 0) +
        .03 * (novelty[i - 2] || 0) + .03 * (novelty[i + 2] || 0)) * clamp(energy[i] / (quiet + 1e-10), 0, 1);
    }
    const peaks = [], minDistance = Math.round(rate * .055);
    for (let i = 1; i < frames - 1; i++) {
      if (smooth[i] < .18 || energy[i] < quiet || smooth[i] < smooth[i - 1] || smooth[i] <= smooth[i + 1]) continue;
      const last = peaks[peaks.length - 1];
      if (last && i - last.frame < minDistance) {
        if (smooth[i] > last.strength) peaks[peaks.length - 1] = {frame: i, strength: smooth[i]};
      } else peaks.push({frame: i, strength: smooth[i]});
    }
    return {novelty: smooth, energy, peaks, rate, hop, fftSize: size, quiet};
  }
  function tempoPath(features, minBpm, maxBpm, preferredBpm, anchors, report) {
    const {novelty, rate} = features;
    const step = Math.max(1, Math.round(rate * .5)), radius = Math.round(rate * 3.5);
    const count = Math.max(1, Math.ceil(novelty.length / step));
    const nStates = Math.max(2, Math.ceil(Math.log(maxBpm / minBpm) / Math.log(1.018)) + 1);
    const bpms = Float64Array.from({length: nStates}, (_, i) => minBpm * (maxBpm / minBpm) ** (i / (nStates - 1)));
    const raw = new Float32Array(count * nStates), totals = new Float64Array(nStates);
    const blur = meanWindow(novelty, 1);
    const lagMin = Math.max(1, Math.floor(60 * rate / maxBpm) - 1), lagMax = Math.ceil(180 * rate / minBpm) + 1;
    const ac = new Float64Array(lagMax + 1);
    for (let w = 0; w < count; w++) {
      const center = w * step, a = Math.max(0, center - radius), b = Math.min(blur.length, center + radius);
      for (let lag = lagMin; lag <= lagMax; lag++) {
        let cross = 0, e1 = 0, e2 = 0;
        for (let j = a; j + lag < b; j += 2) {
          const x = blur[j], y = blur[j + lag];
          cross += x * y; e1 += x * x; e2 += y * y;
        }
        ac[lag] = e1 > 1e-10 && e2 > 1e-10 ? cross / Math.sqrt(e1 * e2) : 0;
      }
      const value = lag => {
        const base = Math.floor(lag), f = lag - base;
        return (ac[base] || 0) * (1 - f) + (ac[base + 1] || 0) * f;
      };
      for (let k = 0; k < nStates; k++) {
        const lag = 60 * rate / bpms[k];
        // The first lag is dominant; multiples improve weak-beat robustness.
        const score = value(lag) + .35 * value(2 * lag) + .12 * value(3 * lag);
        raw[w * nStates + k] = score;
        totals[k] += score;
      }
      if (report && w % 20 === 0) report({stage: 'tempo', progress: .47 + .25 * w / count});
    }
    const reference = preferredBpm || 105;
    const priorWeight = preferredBpm ? 3.0 : .32;
    const prior = Float64Array.from(bpms, bpm => -priorWeight * Math.log(bpm / reference) ** 2);
    const alternatives = Array.from(bpms, (bpm, i) => ({bpm, score: totals[i] / count}));
    const candidates = alternatives.filter((v, i) => (i === 0 || v.score >= alternatives[i - 1].score) &&
      (i === alternatives.length - 1 || v.score >= alternatives[i + 1].score)).sort((a, b) => b.score - a.score).slice(0, 5);
    const transition = new Float64Array(nStates * nStates);
    for (let k = 0; k < nStates; k++) for (let j = 0; j < nStates; j++) {
      const diff = Math.log(bpms[k] / bpms[j]);
      transition[k * nStates + j] = Math.min(4.5 + 2 * Math.abs(diff), 95 * diff * diff);
    }
    let prev = new Float64Array(nStates), curr = new Float64Array(nStates);
    const back = new Uint16Array(count * nStates);
    for (let k = 0; k < nStates; k++) prev[k] = 5 * raw[k] + prior[k];
    for (let w = 1; w < count; w++) {
      for (let k = 0; k < nStates; k++) {
        let best = -Infinity, arg = 0;
        for (let j = 0; j < nStates; j++) {
          const score = prev[j] - transition[k * nStates + j];
          if (score > best) { best = score; arg = j; }
        }
        curr[k] = best + 5 * raw[w * nStates + k] + prior[k];
        back[w * nStates + k] = arg;
      }
      const tmp = prev; prev = curr; curr = tmp;
    }
    let arg = 0;
    for (let i = 1; i < nStates; i++) if (prev[i] > prev[arg]) arg = i;
    const path = new Float32Array(count), certainty = new Float32Array(count);
    for (let w = count - 1; w >= 0; w--) {
      path[w] = bpms[arg]; certainty[w] = clamp(raw[w * nStates + arg] / 1.25, 0, 1);
      arg = back[w * nStates + arg];
    }
    const local = new Float32Array(novelty.length), confidence = new Float32Array(novelty.length);
    for (let i = 0; i < novelty.length; i++) {
      const w = Math.min(count - 1, Math.floor(i / step)), v = Math.min(count - 1, w + 1), f = i / step - w;
      local[i] = path[w] * (1 - f) + path[v] * f;
      confidence[i] = certainty[w] * (1 - f) + certainty[v] * f;
    }
    return {local, confidence, candidates, samples: Array.from(path, (bpm, i) => ({time: i * step / rate, bpm, confidence: certainty[i]}))};
  }
  function track(features, tempo, anchors, report) {
    const {peaks, rate, novelty} = features;
    if (!peaks.length) return [];
    const groups = [[]];
    for (const peak of peaks) {
      const group = groups[groups.length - 1], previous = group[group.length - 1];
      if (previous && peak.frame - previous.frame > Math.max(rate * 2.4, 180 * rate / tempo.local[previous.frame])) groups.push([peak]);
      else group.push(peak);
    }
    const result = [];
    for (const group of groups) {
      // Isolated noises separated by long rests do not establish a pulse.
      if (group.length < 3 && !anchors.some(a => a.time * rate >= group[0].frame - rate * .1 &&
        a.time * rate <= group[group.length - 1].frame + rate * .1)) continue;
      const start = Math.max(0, group[0].frame - Math.round(rate * .1));
      const end = Math.min(novelty.length, group[group.length - 1].frame + Math.round(rate * .1) + 1);
      const part = Object.assign({}, features, {
        novelty: novelty.subarray(start, end), energy: features.energy.subarray(start, end),
        peaks: group.map(p => ({frame: p.frame - start, strength: p.strength}))
      });
      const localTempo = {local: tempo.local.subarray(start, end), confidence: tempo.confidence.subarray(start, end)};
      const localAnchors = anchors.filter(a => a.time * rate >= start && a.time * rate < end).map(a => ({time: a.time - start / rate}));
      const found = trackRange(part, localTempo, localAnchors, report ? update => report({stage: update.stage,
        progress: .73 + .22 * (start + (update.progress - .73) / .22 * (end - start)) / novelty.length}) : null);
      if (result.length && found.length) found[0].breakBefore = true;
      for (const beat of found) { beat.time += start / rate; result.push(beat); }
    }
    return result;
  }
  function trackRange(features, tempo, anchors, report) {
    const {novelty, energy, peaks, rate, quiet} = features;
    if (!peaks.length) return [];
    const n = novelty.length, dp = new Float64Array(n), back = new Int32Array(n);
    const evidence = new Float32Array(n), nearPeak = new Int32Array(n); nearPeak.fill(-1); back.fill(-1);
    const peakMedian = median(peaks.map(p => p.strength)) || 1;
    for (const peak of peaks) {
      const radius = Math.round(rate * .045);
      for (let i = Math.max(0, peak.frame - radius); i <= Math.min(n - 1, peak.frame + radius); i++) {
        const value = Math.min(3, peak.strength / peakMedian) * Math.exp(-.5 * ((i - peak.frame) / (rate * .025)) ** 2);
        if (value > evidence[i]) { evidence[i] = value; nearPeak[i] = peak.frame; }
      }
    }
    // Manual taps also supply a phase reference, without assuming a score.
    for (const anchor of anchors) {
      const frame = Math.round(anchor.time * rate);
      if (frame >= 0 && frame < n) {
        evidence[frame] += 5; nearPeak[frame] = frame;
      }
    }
    let bestFrame = peaks[0].frame, bestValue = 0;
    for (let i = 0; i < n; i++) {
      const period = 60 * rate / tempo.local[i], low = Math.max(1, Math.round(period * .55)), high = Math.round(period * 1.85);
      let best = 0, predecessor = -1;
      for (let lag = low; lag <= high && lag <= i; lag++) {
        const candidate = i - lag;
        const ratio = lag / period;
        const score = dp[candidate] * .97 - 7 * Math.log(ratio) ** 2;
        if (score > best) { best = score; predecessor = candidate; }
      }
      dp[i] = best + evidence[i] - .12;
      back[i] = predecessor;
      if (evidence[i] > .22 && dp[i] > bestValue) { bestValue = dp[i]; bestFrame = i; }
      if (report && i % 2500 === 0) report({stage: 'beats', progress: .73 + .22 * i / n});
    }
    // Trace backwards from the latest supported beat, not a loud middle section.
    const end = peaks[peaks.length - 1].frame;
    const tailPeriod = 60 * rate / tempo.local[end];
    let tailScore = -Infinity;
    for (let i = Math.max(0, end - Math.round(tailPeriod * 1.25)); i <= end; i++) {
      if (evidence[i] < .22) continue;
      const score = dp[i] + .01 * (i - end);
      if (score > tailScore) { tailScore = score; bestFrame = i; }
    }
    const frames = [];
    for (let i = bestFrame, guard = 0; i >= 0 && guard++ < n;) {
      frames.push(i);
      const prev = back[i];
      if (prev < 0 || prev >= i) break;
      i = prev;
    }
    frames.reverse();
    const beats = [];
    let missing = 0, breakNext = false;
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index], peak = nearPeak[frame];
      const supported = peak >= 0 && evidence[frame] > .24 && energy[frame] > quiet;
      if (!supported) { missing++; continue; }
      const previous = beats[beats.length - 1];
      const nextFrame = peak;
      const localPeriod = 60 / tempo.local[frame];
      let time = nextFrame / rate;
      // Local quadratic interpolation removes frame-grid jitter from attacks.
      if (peak > 0 && peak < n - 1 && !anchors.some(a => Math.abs(a.time - time) < .02)) {
        const y0 = novelty[peak - 1], y1 = novelty[peak], y2 = novelty[peak + 1];
        const denom = y0 - 2 * y1 + y2;
        if (Math.abs(denom) > 1e-8) time += clamp(.5 * (y0 - y2) / denom, -.5, .5) / rate;
      }
      if (previous && time - previous.time < localPeriod * .4) continue;
      if (previous && (missing >= 2 || time - previous.time > localPeriod * 2.6)) breakNext = true;
      // A single missing onset can be a tie. Keep it explicitly low-confidence;
      // never propagate an unobserved pulse over a sustained note or silence.
      if (previous && missing === 1 && !breakNext && time - previous.time < localPeriod * 2.6) {
        const mid = (previous.time + time) / 2, mf = Math.round(mid * rate);
        if (energy[mf] > quiet * 2) beats.push({time: mid, confidence: .16, inferred: true});
        else breakNext = true;
      }
      const strength = clamp(evidence[frame] / 2, 0, 1);
      const consistency = previous ? Math.exp(-2 * Math.abs(Math.log((time - previous.time) / localPeriod))) : .6;
      const confidence = clamp((.15 + .48 * strength + .22 * tempo.confidence[frame] + .15 * consistency) *
        (.45 + .55 * consistency), .1, .95);
      const beat = {time: Math.max(0, time), confidence};
      if (breakNext) beat.breakBefore = true;
      beats.push(beat); missing = 0; breakNext = false;
    }
    return beats;
  }
  function analyze(samples, sampleRate, options, onProgress) {
    options = options || {};
    if (!samples || !Number.isFinite(samples.length) || !Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 96000) throw new Error('Audio non valido.');
    if (samples.length > sampleRate * 3600) throw new Error('Durata massima: 60 minuti.');
    const report = typeof onProgress === 'function' ? onProgress : () => {};
    report({stage: 'features', progress: 0});
    const duration = samples.length / sampleRate;
    let minBpm = option(options.minBpm, 40, 25, 280), maxBpm = option(options.maxBpm, 200, 30, 320);
    if (maxBpm <= minBpm) maxBpm = minBpm + 10;
    const anchors = Array.isArray(options.anchors) ? options.anchors.filter(a => a && Number.isFinite(a.time) && a.time >= 0 && a.time < duration).sort((a, b) => a.time - b.time) : [];
    const anchorPeriods = [];
    for (let i = 1; i < anchors.length; i++) {
      const d = anchors[i].time - anchors[i - 1].time;
      if (d >= 60 / maxBpm && d <= 60 / minBpm && !anchors[i].breakBefore && !anchors[i].fermataBefore) anchorPeriods.push(d);
    }
    const preferredBpm = option(options.preferredBpm, anchorPeriods.length >= 2 ? 60 / median(anchorPeriods) : null, minBpm, maxBpm);
    const empty = {beats: [], summary: {bpm: null, confidence: 0}, alternatives: [], diagnostics: {duration, onsetCount: 0, localTempo: [], version: VERSION}};
    if (duration < .5) { report({stage: 'done', progress: 1}); return empty; }
    const features = extractFeatures(samples, sampleRate, report);
    if (features.peaks.length < 3 || percentile(features.energy, .9) < 1e-7) { report({stage: 'done', progress: 1}); return empty; }
    const tempo = tempoPath(features, minBpm, maxBpm, preferredBpm, anchors, report);
    const beats = track(features, tempo, anchors, report).filter(b => b.time < duration);
    const periods = [];
    for (let i = 1; i < beats.length; i++) if (!beats[i].breakBefore) periods.push(beats[i].time - beats[i - 1].time);
    // Sudden metrical jumps require a review even when both attacks are strong.
    // Gradual accelerandi/rallentandi do not trigger this interval-ratio check.
    for (let i = 2; i < beats.length; i++) {
      if (beats[i].breakBefore || beats[i - 1].breakBefore || beats[i].inferred || beats[i - 1].inferred) continue;
      const previous = beats[i - 1].time - beats[i - 2].time, current = beats[i].time - beats[i - 1].time;
      if (Math.abs(Math.log(current / previous)) > Math.log(1.55)) beats[i].confidence = Math.min(.34, beats[i].confidence);
    }
    const competing = tempo.candidates.filter(c => !periods.length || Math.abs(Math.log(c.bpm / (60 / median(periods)))) > .2);
    const topScore = tempo.candidates.length ? tempo.candidates[0].score : 0;
    const ambiguity = preferredBpm ? .15 : competing.length && topScore ? clamp(competing[0].score / topScore, 0, 1) : 0;
    const confidence = beats.length ? beats.reduce((sum, b) => sum + b.confidence, 0) / beats.length * (1 - .35 * ambiguity) : 0;
    report({stage: 'done', progress: 1});
    return {
      beats,
      summary: {bpm: periods.length ? 60 / median(periods) : null, confidence},
      alternatives: tempo.candidates,
      diagnostics: {duration, onsetCount: features.peaks.length, localTempo: tempo.samples,
        preferredBpm, metricalAmbiguity: ambiguity, frameRate: features.rate, inferredCount: beats.filter(b => b.inferred).length,
        breakCount: beats.filter(b => b.breakBefore).length, version: VERSION}
    };
  }
  return {analyze, version: VERSION};
});
