# Tempo Trace

Traccia il tempo di un'esecuzione segnando le pulsazioni su audio e video. Il grafico mostra le oscillazioni dei BPM, individua cambiamenti persistenti, accelerandi e rallentandi, e aiuta a controllare fermate e tap irregolari.

Applicazione statica, senza account, dipendenze, installazione o compilazione. I file multimediali restano nel browser.

## Avvio

Estrai lo ZIP e apri `index.html` in un browser moderno. Mantieni insieme tutti i file e le cartelle del progetto. Puoi anche servirlo da un normale server statico o da GitHub Pages.

## Utilizzo

1. Premi **Apri** o trascina un audio/video nella pagina. **Prova un esempio** apre una breve registrazione sintetica già marcata.
2. Avvia con **P**, poi premi **Spazio** oppure **TAP** a ogni pulsazione. Usa sempre la stessa unità musicale. In **Analisi → Valore di un tap** puoi scegliere croma, semiminima, semiminima puntata o minima.
3. Regola **Velocità** da 0,25× a 2×: i BPM rimangono riferiti all'esecuzione originale. Il browser mantiene l'altezza del suono dove supportato.
4. Seleziona o trascina un beat sul grafico o sulla forma d'onda. Nell'editor puoi inserire i secondi con tre decimali, spostarlo di ±1/±10 ms, riascoltarlo o eliminarlo. **Elenco beat** offre gli stessi punti senza doverli selezionare sul grafico.
5. In **Esporta**, salva il progetto **JSON**, i beat o le sezioni in **CSV**, oppure la vista corrente del grafico in **SVG**. **Progetto** riapre il JSON.

Per inserire un tap mancante, metti in pausa, posiziona il cursore e premi **TAP**. Per escludere un tratto non marcato dal calcolo, seleziona il primo beat dopo il tratto e attiva **Interruzione prima**. Un salto in avanti durante una sequenza di tap crea un'interruzione alla ripresa, se i nuovi tap seguono tutti quelli esistenti. Puoi sempre correggerla nell'editor.

Il pannello **Agogica** raccoglie accelerandi, rallentandi e possibili fermate. Per confermare una fermata, seleziona il beat che conclude l'intervallo prolungato e attiva **Fermata prima** nell'editor. L'intervallo resta nei dati e nelle medie; il marcatore aiuta a non interpretarlo come un cambio del tempo di base.

| Azione | Scorciatoia |
| --- | --- |
| Riproduci / pausa | `P` |
| Aggiungi beat alla posizione corrente | `Spazio` |
| Sposta l'ascolto di ±1 secondo | `←` / `→` |
| Sposta l'ascolto di ±5 secondi | `Maiusc` + `←` / `→` |
| Annulla / ripristina | `Ctrl` o `⌘` + `Z` / `Maiusc` + `Z` |
| Elimina il beat selezionato | `Canc` o `Backspace` |

Le scorciatoie rispettano i campi di testo e i dialoghi. Quando un pulsante ha il fuoco, Spazio attiva quel pulsante. La pagina mette in pausa l'ascolto quando passa in secondo piano.

La compatibilità dei formati dipende dal browser e dai codec. Se un video non viene letto, prova un MP4 compatibile o estrai l'audio in MP3/WAV. La forma d'onda è facoltativa e viene omessa oltre 100 MB o 30 minuti; alcuni formati riproducibili non sono decodificabili per visualizzarla. Riproduzione, tap e analisi restano disponibili.

### Come leggere l'analisi

- **BPM:** sono sempre espressi in semiminime. La formula è `60 × valore del tap / intervallo fra due tap`, in secondi originali; il valore è 0,5 per la croma, 1 per la semiminima, 1,5 per la puntata e 2 per la minima. Ogni punto rappresenta l'intervallo che termina in quel beat.
- **Medio e medie delle sezioni:** `60 × valore del tap × numero di intervalli / durata coperta`. Includono i tap segnalati e le fermate; escludono gli intervalli attraversati da un'interruzione. Non sono medie aritmetiche dei BPM istantanei.
- **Iniziale e Finale:** mediana di un massimo di cinque intervalli non segnalati, cercati fra i sette più vicini all'inizio del primo tratto continuo o alla fine dell'ultimo. Le fermate, confermate o candidate, restano escluse; se necessario vengono ammesse le altre anomalie. Quando non resta nessun intervallo utilizzabile, il valore è assente.
- **Intervallo:** BPM minimo e massimo dei dati grezzi, incluse le anomalie.
- **Tendenza:** mediana mobile dei BPM non segnalati; le fermate confermate o candidate sono escluse dal calcolo del tempo di base. Scegli una finestra di 3, 5, 9 o 15 intervalli in Analisi. Il filtro modifica la curva, non i tap o le medie.
- **Sezioni:** tratti con un cambiamento persistente di tempo, considerando anche la variabilità locale. I valori iniziali sono **12%** di cambio minimo e **8 secondi** di persistenza, verificata da entrambi i lati del cambio. Accelerandi e rallentandi riconosciuti non vengono spezzati internamente in sezioni a tempo stabile. Se collegano due tempi stabili abbastanza diversi, il nuovo confine può cadere alla fine della transizione; la media della sezione precedente include la transizione. Non è un riconoscimento della forma musicale: due sezioni allo stesso tempo possono restare unite. Le interruzioni separano comunque i tratti.
- **Accelerando e rallentando:** aumenti o diminuzioni graduali del tempo lungo più intervalli. Il rilevamento descrive l'andamento dei tap: non legge le indicazioni della partitura né determina l'intenzione dell'interprete.
- **Fermate:** dai soli tempi dei tap, un intervallo lungo può essere una fermata oppure contenere pulsazioni non marcate. **Fermata o tap mancanti?** è quindi un suggerimento da riascoltare. Conferma manualmente una fermata oppure aggiungi i tap mancanti. L'app non corregge automaticamente i dati; le fermate confermate o candidate non guidano il rilevamento dei cambi di tempo.
- **Anomalie:** punti da ascoltare e verificare, non errori certi. Rubato e cambi intenzionali possono essere corretti pur essendo segnalati. Le correzioni sono sempre una scelta dell'utente.
- **Precisione:** dipende dai tap, dal dispositivo e dalla latenza audio; 1 ms è il passo dell'editor, non una garanzia di accuratezza. Il rallentamento facilita il posizionamento; il rilevamento delle pulsazioni rimane manuale.

Per le sessioni lunghe, il calcolo viene spostato in un worker quando il browser lo consente; altrimenti resta disponibile il calcolo ordinario.

Il salvataggio nel browser conserva i tap e le impostazioni, non l'audio/video. Per continuare dopo una riapertura, seleziona nuovamente il file originale. Esporta un JSON per conservare una copia indipendente dai dati del browser.

## Pubblicazione su GitHub Pages

### Dal sito GitHub

1. Crea un repository **Public**, per esempio `tempo-trace`; per semplicità inizializzalo con un README.
2. Apri **Add file → Upload files**. Trascina il **contenuto estratto** del progetto, comprese le cartelle, e conferma il commit su `main`. `index.html` deve essere alla radice: non caricare soltanto lo ZIP o la cartella esterna.
3. Apri **Settings → Pages**. In **Build and deployment**, imposta **Source → Deploy from a branch**.
4. Scegli **main** e **/(root)**, quindi **Save**.
5. Attendi il completamento della pubblicazione: nella stessa pagina trovi l'indirizzo, normalmente `https://TUO-UTENTE.github.io/tempo-trace/`.

Gli aggiornamenti dei file sul branch scelto vengono pubblicati automaticamente. Se il sito non appare, controlla l'esito nella scheda **Actions** e che `index.html` sia nella cartella selezionata.

### In alternativa, con Git

Crea un repository vuoto su GitHub, senza README generato. Dal terminale, entra nella cartella estratta del progetto ed esegui, sostituendo `TUO-UTENTE`:

```sh
git init
git add .
git commit -m "Add Tempo Trace"
git branch -M main
git remote add origin https://github.com/TUO-UTENTE/tempo-trace.git
git push -u origin main
```

Poi imposta **Settings → Pages** come nei punti 3–5. Non serve `npm`, un build o un workflow personalizzato.

Carica il codice dell'applicazione. Gli audio, i video e i progetti personali si aprono dal sito e non devono essere aggiunti al repository.

Documentazione ufficiale: [caricare file](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository) · [configurare GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Verifica del codice

I test non richiedono pacchetti esterni. Con Node.js installato, esegui dalla cartella del progetto:

```sh
node --test tests/*.test.cjs
```

Coprono analisi musicale, importazione, correzioni, cronologia e calcolo in background. I test dell’interfaccia simulano DOM e player; non sostituiscono una prova con un file reale nel browser.

## Licenza

MIT. Vedi `LICENSE`.
