# Tempo Trace

Grafici BPM da audio e video, con beat automatici o manuali. File elaborati sul dispositivo, senza dipendenze esterne.

## Uso

1. Apri `index.html` o il sito e importa un file.
2. Premi **Rileva beat**. Puoi limitare il tratto, indicare il tempo o guidare il rilevamento con 4–8 tap consecutivi.
3. Premi **Applica**, ascolta con il **click** e correggi i punti trascinandoli o nell’editor. **Conferma** approva un beat automatico; **Annulla** ripristina i dati precedenti.
4. Esporta il progetto JSON per riprenderlo; CSV e SVG per dati e grafico. Conserva separatamente l’audio.

| Tasto | Azione |
| --- | --- |
| `P` | Riproduci / pausa |
| `Spazio` | Marca beat |
| `← →` / `Maiusc ← →` | Sposta ±1 / ±5 s |
| `Ctrl/⌘ Z` / `Ctrl/⌘ Maiusc Z` | Annulla / ripristina |
| `Canc` | Elimina beat |

La velocità d’ascolto non cambia i BPM misurati. In **Analisi**, scegli il valore musicale della pulsazione: i BPM del grafico sono espressi in semiminime. L’intervallo e il tempo indicativo del rilevatore, invece, sono pulsazioni al minuto.

Rubato, legato e suddivisioni possono rendere ambigua la pulsazione: controlla i punti segnalati e, se necessario, usa un tempo indicativo o i tap manuali.

**Fermata prima** distingue una fermata intenzionale; **Interruzione prima** esclude un tratto non marcato. Le medie includono le fermate, la tendenza e il rilevamento delle sezioni ne escludono l’effetto. Le sezioni indicano cambi persistenti di tempo, non la forma musicale.

Rilevamento: massimo 30 minuti / 128 MB; formati secondo i codec del browser. I tap manuali restano disponibili per i file più lunghi.

## GitHub Pages

Carica il contenuto della cartella, con `index.html` alla radice. Seleziona **Settings → Pages → Deploy from a branch → main → /(root) → Save**.

Aggiornamenti:

```sh
git add .
git commit -m "Update Tempo Trace"
git push
```

Test, con Node.js:

```sh
node --test tests/*.test.cjs
```

I test usano audio sintetico e un DOM simulato.

## Riferimenti

Implementazione originale: [programmazione dinamica](https://www.ee.columbia.edu/~dpwe/LabROSA/matlab/beat_simple/), [periodicità locale per pianoforte espressivo](https://arxiv.org/abs/2308.10355). Licenza MIT: `LICENSE`.
