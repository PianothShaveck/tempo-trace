# Tempo Trace

Analisi del tempo musicale da audio/video. HTML, CSS e JavaScript senza dipendenze runtime o build; elaborazione sul dispositivo.

## Sviluppo

Aprire `index.html` in un browser moderno. Test con Node.js:

```sh
node --test tests/*.test.cjs
```

Prima di distribuire modifiche agli asset, aggiornare gli URL per invalidare la cache:

```sh
node scripts/version-assets.cjs
```

Committare anche i file aggiornati dal comando. L’hosting serve direttamente la radice del repository.

## Codice

- `assets/app.js`: stato, interfaccia, cronologia, import/export.
- `assets/analysis.js`: BPM, sezioni, agogica; `analysis-worker.js` esegue le analisi più lunghe.
- `assets/beat-detection.js`: attacchi spettrali, periodicità locale e tracciamento dei beat.
- `assets/detection-client.js`: decodifica, cache PCM, Worker e annullamento.
- `assets/charts.js`, `click-track.js`: grafici SVG e click di verifica.
- `assets/report-export.js`: riepilogo SVG; `export-client.js` gestisce PNG, decodifica stereo e annullamento.
- `assets/audio-export.js`: rendering WAV a blocchi in Worker. Il mix conserva velocità e intonazione originali; solo i click possono cambiare velocità.

## Vincoli

- Usare secondi della registrazione originale, indipendenti dalla velocità d’ascolto.
- Conservare la compatibilità JSON v1, le correzioni manuali e l’annullamento.
- Distinguere fermate, interruzioni e beat interpolati. L’assenza di attacchi non prova una fermata: il rilevatore attuale può interrompere note lunghe regolarmente misurate.
- Non equiparare il supporto euristico all’accuratezza. Per valutarla servono beat annotati; i test sintetici e il DOM simulato non sostituiscono il collaudo audio/browser.
- Mantenere controlli accessibili, testi essenziali e nessun caricamento dell’audio su server.

## Riferimenti

[Dynamic programming beat tracking](https://www.ee.columbia.edu/~dpwe/LabROSA/matlab/beat_simple/) · [Local periodicity for expressive piano](https://arxiv.org/abs/2308.10355). Implementazione originale; licenza MIT.
