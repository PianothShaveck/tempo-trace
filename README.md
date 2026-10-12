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
- `beat-detection.js`, `detection-client.js`: spectral onsets, local periodicity, tracking, decoding and cancellation.
- `charts.js`, `click-track.js`: SVG interaction and audition clicks.
- `report-export.js`, `audio-export.js`, `export-client.js`: SVG/PNG reports and WAV rendering.

All modules live in `assets/`.

## Invariants

- Store original recording seconds, independent of playback speed. Keep JSON v1 compatibility and undo.
- Bulk offsets preserve detection confidence, fermatas and gaps, move matching manual section boundaries, and reject invalid positions atomically.
- `sectionBoundaries`: `null` for automatic detection; seconds array for manual boundaries (`[]` means one section). Means exclude gaps.
- Fermatas, gaps and inferred beats are distinct. Missing onsets do not prove a fermata; the current detector may split sustained, regularly measured notes.
- Heuristic support is not measured accuracy. Evaluation requires annotated beats; synthetic tests and the simulated DOM do not replace audio/browser checks.
- Keep controls accessible, text minimal, and audio on the device.

## References

[Dynamic programming beat tracking](https://www.ee.columbia.edu/~dpwe/LabROSA/matlab/beat_simple/) · [Local periodicity for expressive piano](https://arxiv.org/abs/2308.10355). Original implementation; MIT license.
