/* Tempo Trace — musical coordinates over measured beat anchors.
 *
 * Quarters are score positions, seconds remain original media time. The first
 * active anchor is quarter 0. Optional beat.quarter coordinates must be present
 * on every anchor, strictly increasing, and are rebased to that origin.
 * breakBefore preserves a structural step but leaves its time span unmeasured.
 * Bars have nominal quarter bounds and clipped measured start/end timestamps.
 * meanBpm is null across any unmeasured gap; partial, continuous bars still have
 * an exact measured mean. No tempo is extrapolated beyond the last anchor.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TempoMusical = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A resource guard, not a meter whitelist: 100,000 complete bar records are
  // already far beyond a useful interactive score. Check before allocating.
  const MAX_BARS = 100000;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const integer = value => Number.isSafeInteger(value);
  const precision = (...values) => Number.EPSILON * Math.max(1, ...values.map(Math.abs)) * 8;
  const barLength = meter => 4 * (meter.numerator / meter.denominator);

  function validate(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Impostazioni delle battute non valide.');
    const firstBar = input.firstBar === undefined ? 1 : input.firstBar;
    if (!integer(firstBar)) throw new Error('La battuta iniziale deve essere un numero intero valido.');
    const pickup = input.pickup === undefined ? 0 : input.pickup;
    if (!finite(pickup) || pickup < 0) throw new Error('La durata del levare non è valida.');
    const rows = input.meters === undefined ? [{bar: firstBar, numerator: 4, denominator: 4}] : input.meters;
    if (!Array.isArray(rows) || !rows.length) throw new Error('Indica almeno un metro.');
    const meters = rows.map(row => {
      if (!row || !integer(row.bar) || row.bar < firstBar) throw new Error('La battuta del cambio di metro non è valida.');
      if (!integer(row.numerator) || row.numerator <= 0 || !integer(row.denominator) || row.denominator <= 0) {
        throw new Error('Numeratore e denominatore devono essere interi positivi.');
      }
      return {bar: row.bar, numerator: row.numerator, denominator: row.denominator};
    }).sort((a, b) => a.bar - b.bar);
    if (meters[0].bar !== firstBar) throw new Error('Il primo metro deve iniziare alla battuta iniziale.');
    for (let i = 1; i < meters.length; i++) {
      if (meters[i].bar === meters[i - 1].bar) throw new Error('Due cambi di metro non possono iniziare nella stessa battuta.');
    }
    if (pickup >= barLength(meters[0])) throw new Error('Il levare deve essere più corto di una battuta completa.');
    if (pickup > 0 && !integer(firstBar - 1)) throw new Error('Il numero della battuta in levare non è rappresentabile.');
    return {enabled: input.enabled === true, firstBar, pickup, meters};
  }

  function normalizeAnchors(input, beatUnit) {
    if (!finite(beatUnit) || beatUnit <= 0) throw new Error('Il valore del beat non è valido.');
    const beats = (Array.isArray(input) ? input : []).filter(beat => beat && finite(beat.time) && beat.time >= 0)
      .map((beat, index) => ({id: beat.id == null ? 'beat-' + index : beat.id, time: beat.time,
        breakBefore: beat.breakBefore === true, quarter: beat.quarter})).sort((a, b) => a.time - b.time);
    const explicit = beats.some(beat => beat.quarter !== undefined);
    if (explicit && beats.some(beat => !finite(beat.quarter))) throw new Error('Le posizioni musicali devono essere presenti su tutti i beat.');
    const unique = [];
    for (const beat of beats) {
      const previous = unique[unique.length - 1];
      if (previous && previous.time === beat.time) {
        if (explicit && previous.quarter !== beat.quarter) throw new Error('Due posizioni musicali non possono avere lo stesso istante.');
        previous.breakBefore = previous.breakBefore || beat.breakBefore;
      } else unique.push({...beat});
    }
    const origin = explicit && unique.length ? unique[0].quarter : 0;
    for (let i = 0; i < unique.length; i++) {
      const anchor = unique[i];
      anchor.quarter = explicit ? anchor.quarter - origin : i * beatUnit;
      if (!finite(anchor.quarter) || (i && anchor.quarter - unique[i - 1].quarter <= precision(anchor.quarter, unique[i - 1].quarter))) {
        throw new Error('Le posizioni musicali devono crescere con precisione sufficiente.');
      }
    }
    return unique;
  }

  const anchorsOf = timeline => Array.isArray(timeline) ? timeline : timeline && Array.isArray(timeline.anchors) ? timeline.anchors : [];
  function lowerBound(array, value, key) {
    let low = 0, high = array.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (array[mid][key] < value) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  function interpolate(timeline, value, source, target) {
    const anchors = anchorsOf(timeline);
    if (!finite(value) || !anchors.length) return null;
    const index = lowerBound(anchors, value, source);
    if (index < anchors.length && anchors[index][source] === value) return anchors[index][target];
    if (index === 0 || index === anchors.length || anchors[index].breakBefore) return null;
    const a = anchors[index - 1], b = anchors[index];
    return a[target] + (value - a[source]) / (b[source] - a[source]) * (b[target] - a[target]);
  }
  const quarterAtTime = (timeline, time) => interpolate(timeline, time, 'time', 'quarter');
  const timeAtQuarter = (timeline, quarter) => interpolate(timeline, quarter, 'quarter', 'time');

  function build(beats, options = {}, beatUnit = 1) {
    const config = validate(options);
    const anchors = normalizeAnchors(beats, beatUnit);
    const bars = [], meterEvents = [];
    let meterQuarter = config.pickup;
    for (let i = 0; i < config.meters.length; i++) {
      const meter = config.meters[i];
      if (i) {
        const previous = config.meters[i - 1];
        const next = meterQuarter + (meter.bar - previous.bar) * barLength(previous);
        if (!finite(next) || next <= meterQuarter) throw new Error('I cambi di metro superano la precisione numerica disponibile.');
        meterQuarter = next;
      }
      // A pickup carries the first full bar's meter from the first audible beat.
      meterEvents.push({...meter, quarter: i === 0 ? 0 : meterQuarter});
    }
    const timeline = {config, anchors, bars, meterEvents};
    if (anchors.length < 2) return timeline;
    const lastQuarter = anchors[anchors.length - 1].quarter;

    // Count the bars by meter segment in O(number of meter changes), before an
    // adversarial denominator could create billions of tiny records.
    let count = config.pickup > 0 ? 1 : 0;
    let segmentStart = config.pickup;
    for (let i = 0; i < config.meters.length && segmentStart < lastQuarter; i++) {
      const length = barLength(config.meters[i]);
      const next = i + 1 < config.meters.length ? meterEvents[i + 1].quarter : Infinity;
      count += Math.ceil((Math.min(lastQuarter, next) - segmentStart) / length - 1e-10);
      segmentStart = next;
    }
    if (!Number.isFinite(count) || count > MAX_BARS) throw new Error('Questa combinazione di metro e durata genera troppe battute da visualizzare.');

    let intervalIndex = 1;
    function appendBar(number, pickup, startQuarter, endQuarter, meter) {
      if (!integer(number)) throw new Error('Il contatore delle battute supera la precisione numerica disponibile.');
      const coveredEnd = Math.min(endQuarter, lastQuarter);
      if (coveredEnd <= startQuarter) return;
      while (intervalIndex < anchors.length && anchors[intervalIndex].quarter <= startQuarter) intervalIndex++;
      let index = intervalIndex, measuredQuarters = 0, measuredSeconds = 0, hasGap = false;
      while (index < anchors.length && anchors[index - 1].quarter < coveredEnd) {
        const a = anchors[index - 1], b = anchors[index];
        const overlap = Math.min(b.quarter, coveredEnd) - Math.max(a.quarter, startQuarter);
        if (overlap > 0) {
          if (b.breakBefore) hasGap = true;
          else {
            measuredQuarters += overlap;
            measuredSeconds += (b.time - a.time) * overlap / (b.quarter - a.quarter);
          }
        }
        if (b.quarter <= coveredEnd) { index++; intervalIndex = index; }
        else break;
      }
      const start = timeAtQuarter(anchors, startQuarter);
      const end = timeAtQuarter(anchors, coveredEnd);
      bars.push({number, pickup, startQuarter, endQuarter, start, end,
        numerator: meter.numerator, denominator: meter.denominator,
        complete: !hasGap && endQuarter <= lastQuarter + precision(endQuarter, lastQuarter),
        meanBpm: !hasGap && measuredSeconds > 0 ? 60 * measuredQuarters / measuredSeconds : null,
        hasGap, measuredEndQuarter: coveredEnd});
    }
    if (config.pickup > 0) appendBar(config.firstBar - 1, true, 0, config.pickup, config.meters[0]);
    let quarter = config.pickup, number = config.firstBar, meterIndex = 0;
    while (quarter < lastQuarter - precision(quarter, lastQuarter)) {
      while (meterIndex + 1 < config.meters.length && config.meters[meterIndex + 1].bar <= number) meterIndex++;
      const meter = config.meters[meterIndex];
      const origin = meterIndex === 0 ? config.pickup : meterEvents[meterIndex].quarter;
      // Multiply from the meter origin; repeated addition drifts far enough to
      // invent a tiny extra bar after long runs of thirds or other fractions.
      quarter = origin + (number - meter.bar) * barLength(meter);
      const next = origin + (number - meter.bar + 1) * barLength(meter);
      if (!finite(next) || next - quarter <= precision(quarter, next)) throw new Error('La durata delle battute supera la precisione numerica disponibile.');
      appendBar(number, false, quarter, next, meter);
      if (bars.length > MAX_BARS) throw new Error('Questa combinazione di metro e durata genera troppe battute da visualizzare.');
      quarter = next;
      number++;
    }
    return timeline;
  }

  function barAtQuarter(timeline, quarter) {
    if (!timeline || !Array.isArray(timeline.bars) || !finite(quarter) || !timeline.bars.length) return null;
    const bars = timeline.bars, last = bars[bars.length - 1];
    if (quarter < bars[0].startQuarter || quarter > last.measuredEndQuarter) return null;
    let index = lowerBound(bars, quarter, 'startQuarter');
    if (index === bars.length || bars[index].startQuarter > quarter) index--;
    return bars[Math.max(0, index)] || null;
  }
  const barAtTime = (timeline, time) => {
    const quarter = quarterAtTime(timeline, time);
    return quarter === null ? null : barAtQuarter(timeline, quarter);
  };

  return {validate, build, quarterAtTime, timeAtQuarter, barAtQuarter, barAtTime};
});
