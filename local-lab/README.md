# RareBlock Local Lab

Setup e asset per la generazione locale di immagini brand-coerenti su PC desktop con NVIDIA RTX 3060 12GB + 32-64GB RAM.

## Struttura

```
local-lab/
├── SETUP.md                       ← guida installazione step-by-step
├── workflows/
│   └── rareblock-flux-base.json   ← workflow ComfyUI da importare
└── prompts/
    ├── 01-hero-atmospheric.txt    ← per backdrop hero memorandum
    ├── 02-vault-interior.txt      ← per sezione "Custodia"
    └── 03-founder-studio.txt      ← per sezione "Il Club"
```

## Quick start (in ordine)

1. **Leggi `SETUP.md`** dall'inizio alla fine. Tempo lettura: 15 min.
2. **Installa ComfyUI** seguendo gli step 1-4. Tempo: 30-45 min.
3. **Scarica i 4 modelli** allo step 5. Tempo: 60-90 min (puoi fare altro).
4. **Trascina `rareblock-flux-base.json`** sul canvas ComfyUI per caricare il workflow.
5. **Apri `prompts/01-hero-atmospheric.txt`**, copia il "PROMPT POSITIVO", incollalo nel nodo verde "Prompt POSITIVO" del canvas.
6. **Click "Queue Prompt"**. Prima generazione: ~2 minuti. Successive: ~75 secondi.
7. **Itera**: cambia il seed (dado nel KSampler), genera 8 varianti, scegli le migliori.
8. **Ripeti** con i prompt 02 e 03.

## Output finale atteso

Dopo una sessione di 4-5 ore avrai 6-10 immagini RareBlock coerenti, in 1024×1280 o 1344×768, salvate in `C:\AI\ComfyUI\output\`.

Le importi nel memorandum sostituendo i placeholder CSS, oppure le passi prima per Lightroom/Capture One per il color grading finale (split-toning ombre→ciano, luci→oro, saturazione globale -15) e poi nel memorandum.

## Roadmap futura

Quando avrai familiarità con ComfyUI (1-2 settimane d'uso):

- **Training LoRA RareBlock** custom — il vero asset di lungo termine. Ogni futura immagine del brand avrà coerenza visiva automatica.
- **ControlNet per composizione** — generi una bozza in Photoshop, Flux la interpreta mantenendo la composizione esatta.
- **Inpainting per ritocchi** — modifichi solo parti specifiche di un'immagine già generata.
- **Upscaling 4K** — porti le immagini a 4096×5120 senza perdita di dettaglio.

Quando arrivi a uno di questi punti, scrivimi e prepariamo la guida dedicata.
