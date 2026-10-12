# Tempo Trace

Local audio/video tempo analysis. Static HTML, CSS and JavaScript; no build or runtime dependencies.

## Development

Open `index.html` in a modern browser. Run tests and refresh asset cache keys before committing:

```sh
node --test tests/*.test.cjs
node scripts/version-assets.cjs
```

Commit the generated URL changes. Hosting serves the repository root.

## Code

- `app.js`: state, history, UI and project import/export.
- `i18n.js`: English/Italian UI and report messages. Italian source keys also translate worker errors; language preferences stay outside project data.
- `analysis.js`, `analysis-worker.js`: BPM, sections and expression.
- `musical.js`, `bar-report.js`, `archive.js`: musical positions, meter map, pickups, paginated reports and ZIP packaging.
- `midi.js`, `midi-audio.js`: SMF parsing/retiming and worker-based synthesized audition.
- `beat-detection.js`, `detection-client.js`: spectral onsets, local periodicity, tracking, decoding and cancellation.
- `charts.js`, `click-track.js`: SVG interaction and audition clicks.
- `report-export.js`, `audio-export.js`, `export-client.js`: SVG/PNG reports and WAV rendering.

All modules live in `assets/`.

## Invariants

- Store original recording seconds, independent of playback speed. Keep JSON v1 compatibility and undo.
- Bulk offsets preserve detection confidence, fermatas and gaps, move matching manual section boundaries, and reject invalid positions atomically.
- `musicStart` defaults to zero. Earlier beats remain in the project but are excluded from analysis, detection, clicks and media/data exports. Times stay relative to the original recording.
- `expressionBefore` optionally overrides the preceding interval: `fermata`, `accelerando`, `rallentando`, or `none` (suppress detection). Omit it for automatic analysis; keep legacy `fermataBefore` compatibility.
- `sectionBoundaries`: `null` for automatic detection; seconds array for manual boundaries (`[]` means one section). Means exclude gaps.
- `stats.perceived` and `section.perceived` estimate basic tempo from recurring beat intervals, excluding holds/anomalies and reducing ramp weight. Keep count/time averages unchanged. `variable` means no single supported base; `insufficient` means too few usable intervals. `support` is concentration, not confidence.
- Fermatas, gaps and inferred beats are distinct. Missing onsets do not prove a fermata; the current detector may split sustained, regularly measured notes.
- Heuristic support is not measured accuracy. Evaluation requires annotated beats; synthetic tests and the simulated DOM do not replace audio/browser checks.
- `advanced` stores `{enabled, firstBar, pickup, meters: [{bar, numerator, denominator}]}`. `firstBar` labels the first full bar; the pickup precedes it and its length is in quarter notes. Positive integer meters are unrestricted; number precision and generated bar count remain bounded.
- Optional `beat.quarter` positions must be present on every beat and strictly increase. Analysis sums covered quarters; a musical timeline rebases its first active beat to quarter zero. `tempoAnchor` preserves off-grid MIDI tempo changes without adding click beats.
- MIDI formats 0/1 retain tracks, note ticks, controllers and unrelated metadata when converted. Tempo replacement starts at the chosen MIDI quarter position; the last project tempo continues through the file. Undefined gaps cannot be exported as a tempo map.
- SMF cannot represent every app meter or arbitrary bar numbering. Compatible pickups get a short initial MIDI measure; exact notation is also stored in a noncommercial `0x7D` sequencer-specific `TempoTrace:1:` JSON event. Format 2 is rejected; SMPTE supports playback/import, not tempo conversion. The synth is a piano-like timing preview, not a General MIDI soundfont renderer.
- The advanced inspector edits the live meter map; keep selection and drafts local to the session. Validate each edit before checkpointing. Multi-page reports share one BPM scale and retain original bar numbers.
- Keep controls accessible, text minimal, and audio on the device.

## References

[Dynamic programming beat tracking](https://www.ee.columbia.edu/~dpwe/LabROSA/matlab/beat_simple/) · [Local periodicity for expressive piano](https://arxiv.org/abs/2308.10355). Original implementation; MIT license.
