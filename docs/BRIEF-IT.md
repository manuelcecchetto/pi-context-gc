# Brief: Garbage Context Collection semantica per Pi

> Historical design record for the original Pi 0.84.x abort/resume implementation. The current unreleased design requires atomic `requestCompaction`; see [ARCHITECTURE.md](ARCHITECTURE.md) and [COMPATIBILITY.md](COMPATIBILITY.md). The lifecycle descriptions below are not current implementation guidance.

## Conclusione esecutiva

La via migliore, oggi, è **un'estensione separata che decide quando compattare**, senza implementare un nuovo compactor e senza sostituire i meccanismi di sicurezza di Pi.

Il sistema è diviso così:

```text
MODELLO / SCHEDULER     decide QUANDO una fase è semanticamente morta
OPENAI NATIVE COMPACT  decide COME preservare lo stato compattato
PI                     conserva sessione, threshold, overflow e fallback
```

L'estensione espone al modello `compact_context`. Il modello lo chiama soltanto quando una fase coerente è conclusa, registra un piccolo task/search ledger e dichiara il prossimo working set. L'estensione attende il confine sicuro dopo l'intero batch di tool result, invoca il normale lifecycle `ctx.compact()` di Pi e riprende dal checkpoint.

La distribuzione standard carica anche `@lll9p/pi-better-compaction`, così i modelli OpenAI Responses/Codex usano `/responses/compact` e il relativo stato opaco. Se il percorso nativo non è disponibile, il backend lascia a Pi la sua compaction testuale. La normale auto-compaction threshold/overflow di Pi resta attiva e passa dallo stesso backend.

## Problema

Una sessione agentica append-only accumula materiale con vite semantiche molto diverse:

```text
raw read / grep / test output   minuti o un singolo step
working hypothesis              una fase
verified decision               molte fasi
user constraint                 intera task
```

Trattare tutto come contesto permanente produce:

- **haystack:** i vincoli vivi competono con centinaia di migliaia di token già consumati;
- **context rot:** vecchie ipotesi e snapshot superati continuano a influenzare il modello;
- **state ambiguity:** più letture dello stesso file sembrano tutte plausibili, anche se solo l'ultima è canonica;
- **epistemic amnesia dopo una summary povera:** il modello dimentica cosa ha già escluso e ripete l'esplorazione;
- **costo e latenza ripetuti:** il prefisso cached è più economico, ma non gratuito e non qualitativamente neutro.

L'obiettivo non è imporre una context window piccola. È mantenere il **minimo working set sufficiente per la prossima decisione**, lasciando una window grande quando una singola fase ne ha davvero bisogno.

```text
session/event history != live model context
```

## Perché non usare pruning deterministico

Non viene introdotto un classificatore del tipo:

```text
if tokens > 100k: compact
if topic changed: compact
```

Una soglia resta indispensabile come protezione hard dall'overflow, ma è un segnale debole per la vita semantica del contesto. Il modello che sta eseguendo il lavoro possiede invece il segnale migliore: sa se una pista è chiusa, quali decisioni sono diventate invarianti e quale sarà la prossima fase.

Il trigger anticipato è quindi **agentico e opportunistico**. Il trigger threshold/overflow resta **automatico e obbligatorio**.

## Due trigger, un backend

```text
A. PHASE BOUNDARY
   model -> compact_context(...)

B. SAFETY
   Pi threshold / context overflow

              entrambi
                 |
                 v
      session_before_compact
                 |
       OpenAI native compact
                 |
       fallback Pi se necessario
```

Questo evita due errori opposti:

1. eliminare il safety path e rischiare un input oltre la context window;
2. aspettare sempre la pressione della window, anche quando 200k token della fase precedente sono già semanticamente morti.

## Stato da preservare

`compact_context` non chiede una summary libera. Richiede un checkpoint strutturato:

```text
TASK STATE
- fase completata e outcome
- prossimo focus

DECISION LEDGER
- decisioni, invarianti e contratti
- file, simboli e identificatori rilevanti

SEARCH LEDGER
- piste investigate
- ipotesi escluse
- ragioni per non riesplorarle senza nuova evidenza

COMPLETION LEDGER
- verifiche e acceptance criteria soddisfatti
- failure e open loop ancora vivi
```

La `verification` è obbligatoria. Questo è intenzionale: il tool deve rappresentare anche un **completion contract**, non soltanto un modo elegante per liberare token.

## Context GC e stopping criterion

Un context sempre pulito può rimuovere la pressione che normalmente spinge l'agent a chiudere la task. Un modello forte potrebbe continuare a trovare miglioramenti, refactor ed edge case indefinitamente.

Per questo il checkpoint deve affermare non soltanto “cosa ricordo”, ma anche “perché questa fase è sufficientemente finita”. La policy è:

```text
non continuare perché esiste ancora qualcosa di migliorabile;
continuare soltanto se esiste evidenza che un acceptance criterion non è soddisfatto.
```

Dopo la compaction, il resume message rende canonici `next_focus`, stato durevole, open loop, piste escluse e verification state. La fase chiusa non deve essere riaperta senza nuova evidenza.

## Perché Pi sembrava aspettare la fine

Nel coding-agent corrente di Pi, il low-level `agent.prompt()` possiede l'intero loop:

```text
model -> tool batch -> model -> tool batch -> ...
```

La normale verifica di auto-compaction viene eseguita principalmente nel percorso post-run, dopo che quel loop ha restituito il controllo, oppure prima di un prompt successivo. Non significa “fine della conversazione”, ma **fine dell'agent run corrente**. Se il run comprende molti round tool/model, il check può arrivare molto tardi.

Pi espone però l'evento extension `context` prima di ogni nuova chiamata al modello. È il confine disponibile per interrompere il run dopo un batch completo e prima della successiva inference.

## Differenza con Codex

Codex implementa la compaction dentro il sampling loop. Quando il follow-up deve continuare e la soglia è raggiunta, può:

1. eseguire remote compaction inline;
2. costruire la replacement history;
3. installarla atomicamente;
4. continuare lo stesso run.

La versione remota v2 conserva selettivamente messaggi user/developer/system e alcuni agent messages, mentre i raw tool artifact non vengono mantenuti come tail ordinaria. Il compaction item opaco rappresenta il resto dello stato.

Pi 0.84.x non espone a una extension la stessa operazione atomica. `ctx.compact()` entra nel percorso manuale: abortisce il low-level run e non lo continua automaticamente. Questa estensione implementa quindi il miglior equivalente disponibile senza forkare Pi:

```text
compact_context tool
      |
complete tool batch
      |
context hook
      |
Pi manual/native compaction
      |
hidden checkpoint resume
```

Non è bit-for-bit identico al rollover inline di Codex, ma usa il lifecycle pubblico di Pi e mantiene i suoi fallback.

## Perché usare la compaction nativa OpenAI

Una summary esterna ricostruisce lo stato soltanto dai messaggi visibili. Può perdere relazioni, priorità implicite e reasoning state non serializzato dall'harness.

`/responses/compact` restituisce invece un item opaco destinato alla continuazione. Il scheduler non prova a interpretarlo o riscriverlo; fornisce soltanto istruzioni di handoff e un ledger esplicito.

La gerarchia è:

```text
provider-native opaque state      continuità più ampia
explicit task/search checkpoint   stato operativo canonico
filesystem / test runner          fonte esatta e corrente
session JSONL                     audit trail completo
```

La compaction è loss-aware, non lossless. Il modello deve rileggere un file quando serve un dettaglio esatto e corrente.

## Esempio su una window da 350k

```text
350k live context

  30k  istruzioni, goal, vincoli globali
  45k  stato utile per la prossima fase
  60k  decisioni e conversazione ancora rilevanti
 215k  vecchi read, grep, log, test, snapshot, piste concluse
```

Dopo una fase coerente:

```text
215k raw history
      |
      | native compact + task/search checkpoint
      v
opaque provider state + piccolo ledger + tail rilevante
```

Il risultato non è garantito a 10–20k: il formato e la quantità di tail trattenuta sono controllati dal provider. Il vantaggio atteso è soprattutto rimuovere i tool artifact raw e le rappresentazioni obsolete dal live set, non ottenere una dimensione numerica fissa.

Compattare a 100k invece che aspettare 320k dovrebbe ridurre il lavoro della singola compaction e il contesto medio dei turni successivi, ma la relazione di latenza non è garantita lineare. Va misurato sul workload reale.

## Lifecycle implementato

```text
IDLE
  |
  | compact_context
  v
PENDING CHECKPOINT
  |
  | trailing assistant/tool-result batch completo
  v
COMPACTING
  |
  | OpenAI native oppure fallback Pi
  v
RESUME PENDING
  |
  | Pi idle, nessuna continuation già in coda
  v
HIDDEN TASK-STATE RESUME
  |
  v
IDLE / NEXT PHASE
```

Guardrail:

- il tool è sequenziale e viene richiesto da solo quando possibile;
- la compaction parte soltanto se ogni tool call dell'ultimo batch ha esattamente un result;
- un input utente reale prima del boundary cancella il checkpoint;
- callback stale sono bloccati da generation, session ID e checkpoint ID;
- nessun retry automatico infinito dopo failure;
- se un altro turn possiede già la continuation, non viene creato un secondo turn;
- con `autoResume=false`, il checkpoint resta in `resume-pending` e può essere ripreso con `/context-gc resume`.

## Ipotesi da benchmarkare

Non si assume che la compaction anticipata sia sempre qualitativamente migliore. I modelli sono spesso ottimizzati per task one-shot e un contesto lungo può contenere traiettorie utili. Il benchmark deve quindi misurare:

- task success e regressioni;
- richiami corretti di decisioni e invarianti;
- ripetizione di read, test e ipotesi già escluse;
- scope creep e overengineering;
- numero di tool call dopo ogni phase boundary;
- active context tokens per provider call;
- latenza di compaction, TTFT e wall-clock totale;
- costo complessivo, non soltanto cache-read price;
- capacità di fermarsi quando gli acceptance criteria sono soddisfatti.

La tesi da testare non è “meno token è sempre meglio”. È:

> un live context task-scoped, con latent continuity nativa e ledger esplicito, produce meno interferenza senza perdere lo stato necessario alla fase successiva.

## Decisione finale

La soluzione implementata è una extension separata perché:

- non richiede un fork di Pi;
- non duplica la logica del compactor;
- non modifica le soglie o l'overflow recovery;
- usa l'API extension pubblica;
- può essere rimossa o benchmarkata isolatamente;
- può in futuro adottare un backend Codex-v2 più fedele senza cambiare il tool o il task ledger.

Il miglioramento core ideale resta un'API Pi di **inline replace-and-continue**, equivalente al percorso Codex. Fino a quel momento, tool agentico + safe context boundary + native backend + guarded resume è il compromesso più solido.
