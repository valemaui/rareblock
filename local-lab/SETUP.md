# RareBlock Local Lab — Setup Guide

Setup di **ComfyUI + Flux.1 Dev quantizzato** per generare immagini brand-coerenti su RTX 3060 12GB. Tempo stimato: 2-3 ore (di cui 60-90 min di solo download dei modelli).

> **Hardware verificato**: NVIDIA RTX 3060 12GB desktop · 32-64GB RAM · Windows 10/11

---

## 1. Prerequisiti software

Apri PowerShell **come amministratore** e installa queste dipendenze. Se ne hai già qualcuna salta il comando relativo.

### 1.1 — Python 3.11
Scarica da [python.org/downloads/release/python-3119](https://www.python.org/downloads/release/python-3119/) la versione **Windows installer (64-bit)**.

In fase di installazione:
- ✅ Spunta **"Add Python 3.11 to PATH"** (CRITICO, altrimenti non funziona nulla)
- Click "Customize installation" → spunta tutto → "Install for all users"

Verifica:
```powershell
python --version
# deve stampare: Python 3.11.x
```

> ⚠️ **Non usare Python 3.12 o 3.13**. Alcuni nodi ComfyUI cruciali (ComfyUI-GGUF in particolare) hanno problemi di compatibilità con 3.12+ ad oggi. Resta su 3.11.

### 1.2 — Git
Se non l'hai già: [git-scm.com/download/win](https://git-scm.com/download/win) → installer default → next-next-finish.

Verifica: `git --version`

### 1.3 — CUDA drivers NVIDIA
Apri GeForce Experience (lo hai già) → tab "Drivers" → installa l'ultimo Game Ready Driver. PyTorch con CUDA 12.1 è quello supportato meglio dai modelli che useremo.

Se non hai GeForce Experience: scarica [studio drivers da nvidia.com](https://www.nvidia.com/Download/index.aspx) selezionando RTX 3060.

Verifica:
```powershell
nvidia-smi
# Deve mostrare: GeForce RTX 3060, CUDA Version: 12.x, Memory 12288 MiB
```

### 1.4 — 7-Zip (per scompattare i modelli)
[7-zip.org](https://7-zip.org/) — installer standard.

---

## 2. Installazione ComfyUI

ComfyUI è il backend: motore di inferenza con interfaccia node-based via browser. Installazione manuale (NON usare l'installer "Desktop" fornito da ComfyUI: quello è limitato e non supporta il workflow GGUF che ci serve).

### 2.1 — Clone del repository

Scegli una cartella con **almeno 80GB liberi** (i modelli pesano). Consiglio: `C:\AI\` oppure `D:\AI\` se hai un secondo disco.

```powershell
cd C:\
mkdir AI
cd AI
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
```

### 2.2 — Virtual environment Python (importante)

Isola le dipendenze dal Python di sistema. Eviterai conflitti per sempre.

```powershell
python -m venv venv
.\venv\Scripts\activate
```

Dopo aver attivato il venv, vedrai `(venv)` davanti al prompt. **Da ora in poi tutti i comandi vanno dati con il venv attivo.**

### 2.3 — Installazione PyTorch con CUDA

```powershell
pip install --upgrade pip
pip install torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cu121
```

Download ~2.5GB, ci mette 5-10 minuti. Verifica:

```powershell
python -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
# Deve stampare:
# True
# NVIDIA GeForce RTX 3060
```

Se stampa `False`: i driver NVIDIA non sono installati correttamente, torna allo step 1.3.

### 2.4 — Installazione dipendenze ComfyUI

```powershell
pip install -r requirements.txt
```

Altri 3-5 minuti.

### 2.5 — Test di avvio

```powershell
python main.py
```

Apre il server locale. Se vedi:
```
To see the GUI go to: http://127.0.0.1:8188
```

Apri quel link nel browser. Vedi un canvas vuoto con qualche nodo. **ComfyUI funziona.** Chiudi il server con `Ctrl+C` per ora.

---

## 3. ComfyUI-Manager (gestione plugin)

Senza Manager devi installare manualmente ogni custom node. Con Manager fai tutto da UI.

```powershell
cd custom_nodes
git clone https://github.com/ltdrdata/ComfyUI-Manager.git
cd ..
```

Riavvia ComfyUI: `python main.py`. Adesso nel canvas vedi un bottone **"Manager"** in alto a destra.

---

## 4. ComfyUI-GGUF (quantizzazione Flux)

Questo è il plugin che permette di caricare modelli quantizzati Q5/Q6/Q8. È quello che fa girare Flux su 12GB.

Da ComfyUI Manager: clicca **Manager** → **Custom Nodes Manager** → cerca `gguf` → installa **"ComfyUI-GGUF"** (autore: city96) → Restart.

Verifica al riavvio: nel menu di destra cerca tra i nodi disponibili `Unet Loader (GGUF)` e `DualCLIPLoader (GGUF)`. Se ci sono, è installato.

---

## 5. Download dei modelli

**5 file da scaricare, 22GB totali.** Scaricali in parallelo mentre fai altro, poi spostali nelle cartelle giuste.

### 5.1 — Flux.1 Dev quantizzato Q6_K (main checkpoint, ~9GB)

Il sweet spot per la tua 3060. Q6_K è quasi indistinguibile da FP16 e lascia margine VRAM per LoRA.

**Download**: [huggingface.co/city96/FLUX.1-dev-gguf/resolve/main/flux1-dev-Q6_K.gguf](https://huggingface.co/city96/FLUX.1-dev-gguf/resolve/main/flux1-dev-Q6_K.gguf)

**Dove metterlo**: `C:\AI\ComfyUI\models\unet\flux1-dev-Q6_K.gguf`

### 5.2 — T5XXL text encoder fp8 (~5GB)

Encoder per i prompt lunghi/articolati. La versione fp8 occupa metà VRAM rispetto a fp16 senza degradazione percettibile.

**Download**: [huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors)

**Dove**: `C:\AI\ComfyUI\models\clip\t5xxl_fp8_e4m3fn.safetensors`

### 5.3 — CLIP-L (~250MB)

Secondo encoder, gestisce tag e parole chiave brevi.

**Download**: [huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors)

**Dove**: `C:\AI\ComfyUI\models\clip\clip_l.safetensors`

### 5.4 — VAE Flux (~330MB)

Decoder finale immagine.

**Download**: [huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors](https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors)

> ⚠️ Per scaricare quest'ultimo devi avere un account Hugging Face e accettare la licenza Black Forest Labs (1 click). Se non l'hai mai fatto: registrati [qui](https://huggingface.co/join), poi vai sulla pagina del modello [FLUX.1-dev](https://huggingface.co/black-forest-labs/FLUX.1-dev), clicca "Agree and access repository". Da quel momento il download diretto funziona.

**Dove**: `C:\AI\ComfyUI\models\vae\ae.safetensors`

### 5.5 — Verifica struttura

A download completato, la struttura deve essere:

```
C:\AI\ComfyUI\models\
├── unet\
│   └── flux1-dev-Q6_K.gguf       (~9 GB)
├── clip\
│   ├── t5xxl_fp8_e4m3fn.safetensors  (~5 GB)
│   └── clip_l.safetensors        (~250 MB)
├── vae\
│   └── ae.safetensors            (~330 MB)
```

---

## 6. Importa i workflow RareBlock

Nel repo `rareblock` ci sono 3 workflow pre-configurati per il tuo brand, sotto `local-lab/workflows/`:

- `01-hero-atmospheric.json` — Vault interiors, archive halls, luce calda direzionale
- `02-still-life-luxury.json` — Macro foglia oro, marmo nero, dettaglio tipografico
- `03-founder-studio.json` — Scrivania notturna, brass desk lamp, leather notebook

### 6.1 — Carica un workflow

Avvia ComfyUI (`python main.py`) e apri http://127.0.0.1:8188.

Trascina il file `01-hero-atmospheric.json` (o aprilo con menu **Load**) direttamente sul canvas. Vedi una catena di nodi precaricata con il prompt RareBlock già scritto.

### 6.2 — Generazione test

Click su **Queue Prompt** in alto a destra.

Prima generazione: 90-120 secondi (caricamento modelli). Le successive: 60-90 secondi a immagine.

Output salvato in `C:\AI\ComfyUI\output\` con nome `rareblock_hero_00001_.png`.

---

## 7. Parametri ottimali per RTX 3060 12GB

I workflow sono già configurati con questi valori, ma se vuoi capire/modificare:

| Parametro | Valore | Perché |
|---|---|---|
| **Resolution** | 1024×1280 (4:5) o 1344×768 (16:9) | Sweet spot Flux per qualità/VRAM |
| **Sampler** | `euler` | Più stabile su Flux, meno artefatti |
| **Scheduler** | `simple` | Combo standard con euler per Flux |
| **Steps** | 20 | Sotto i 18 vedi mancanze; sopra i 25 stai sprecando tempo |
| **CFG** | 1.0 | Flux è guidance-distilled, NON usare valori alti |
| **Flux Guidance** | 3.5 | Il vero parametro di "aderenza" del prompt su Flux |

### Se vai in OOM (Out Of Memory)

Errore tipico al primo run: `CUDA out of memory`. Soluzioni in ordine di efficacia:

1. **Riduci risoluzione** a 896×1152 invece di 1024×1280
2. **Lancia ComfyUI con argomenti VRAM-saving**:
   ```powershell
   python main.py --lowvram --use-split-cross-attention
   ```
3. **Chiudi tutto** il resto sul PC: browser pesanti, Discord con accelerazione GPU, OBS, VSCode con estensioni che usano GPU
4. **In ultima istanza** scendi a Q5_K_S (~7GB invece di 9GB), scarica `flux1-dev-Q5_K_S.gguf` dalla stessa repo HuggingFace

---

## 8. Workflow consigliato per il memorandum

Generazione asset RareBlock in 4-5 ore di sessione singola:

1. **Carica workflow `01-hero-atmospheric.json`** → genera 8 varianti cambiando il `seed` (campo nel nodo "KSampler") → tieni le 2 migliori
2. **Stesso processo per `02-still-life-luxury.json`** → 6 varianti → tieni 2
3. **Stesso processo per `03-founder-studio.json`** → 6 varianti → tieni 2
4. **Upscaling** delle 6 immagini selezionate: usa nodo `Ultimate SD Upscale` (installa via Manager) per portarle a 2048×2560
5. **Color grading finale** in Lightroom o Capture One: split-toning ombre→ciano, luci→oro, saturazione globale -15

Output finale: 6 immagini 4K-ready, perfettamente coerenti con il brand, pronte per il memorandum.

---

## 9. Prossimo step strategico — LoRA RareBlock

Quando avrai familiarità con ComfyUI (1-2 settimane d'uso), il vero salto di qualità sta nel **training di un LoRA custom** sull'estetica RareBlock. Procedura separata, file `local-lab/lora-training-guide.md` (lo preparo quando sei pronto). Anteprima:

1. Raccogli 30-50 immagini di riferimento (campagne luxury, archivi storici, fotografia da Architectural Digest)
2. Tagging automatico via WD14 Tagger
3. Training su 3060 con kohya_ss: 6-10 ore (lasci girare di notte), output 150-300MB
4. Da quel momento ogni immagine generata con `<lora:rareblock:0.8>` ha coerenza visiva automatica con tutto il pregresso

Questo è il momento in cui locale batte cloud su tutta la linea: nessun servizio commerciale ti permette di addestrare un LoRA proprietario sull'estetica del tuo brand.

---

## Risoluzione problemi comuni

**ComfyUI non parte / errore Python**
→ Verifica che il venv sia attivo (`(venv)` davanti al prompt). Se no: `cd C:\AI\ComfyUI` e `.\venv\Scripts\activate`.

**Manager non appare**
→ Riavvia ComfyUI completamente (chiudi terminale, riapri, riattiva venv, rilancia `python main.py`). Se ancora niente, verifica che la cartella `custom_nodes\ComfyUI-Manager` esista.

**Errore "model not found"**
→ I file modello vanno nelle cartelle ESATTE indicate (case-sensitive). Verifica: `dir C:\AI\ComfyUI\models\unet` deve mostrare `flux1-dev-Q6_K.gguf`.

**Download Hugging Face si interrompe**
→ Per file >5GB usa il CLI ufficiale invece del browser:
```powershell
pip install -U "huggingface_hub[cli]"
huggingface-cli download city96/FLUX.1-dev-gguf flux1-dev-Q6_K.gguf --local-dir C:\AI\ComfyUI\models\unet
```

**Generazione lenta (>3 minuti per immagine)**
→ Verifica che il venv abbia PyTorch CUDA: `python -c "import torch; print(torch.cuda.is_available())"`. Deve dire `True`. Se dice `False`, hai installato la versione CPU per errore — disinstalla (`pip uninstall torch torchvision torchaudio`) e reinstalla con il comando di step 2.3.

---

Quando arrivi al punto in cui ComfyUI gira e i 3 workflow sono caricati, mandami screenshot della prima generazione e iteriamo i prompt insieme. Buon setup.
