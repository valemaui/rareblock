#!/usr/bin/env python3
"""
RareBlock Memorandum — Image Optimization Script

Ottimizza le 4 immagini del memorandum per il web:
- Versione desktop @1600px lato lungo (per viewport grandi e retina)
- Versione mobile  @800px lato lungo (per device piccoli)
- Compressione JPG quality 85 con progressive encoding
- Strip dei metadati EXIF (privacy + size)

USO:
    python optimize-memorandum-images.py /path/to/folder/with/originals

La cartella di input deve contenere i 4 file con questi nomi esatti:
    hero-marble.jpg     (o .png)
    vault-trunks.jpg
    vault-corridor.jpg
    founder-studio.jpg

OUTPUT:
    Crea una sottocartella `optimized/` con 8 file pronti per upload:
    hero-marble.jpg, hero-marble@2x.jpg, vault-trunks.jpg, ...
    
PREREQUISITI:
    pip install Pillow

UPLOAD SU ARUBA:
    Carica TUTTI i file della cartella optimized/ in
    /img/memorandum/ del sito.
"""

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("ERRORE: serve Pillow. Installa con: pip install Pillow")
    sys.exit(1)

EXPECTED_FILES = [
    "hero-marble",
    "vault-trunks",
    "vault-corridor",
    "founder-studio",
]

DESKTOP_LONG_SIDE = 1600   # @2x retina-friendly per layout fino a 800px CSS
MOBILE_LONG_SIDE  = 800    # baseline per device piccoli
QUALITY = 85               # sweet spot JPG: indistinguibile a occhio, ~30% size del 100

def find_source(folder: Path, name: str) -> Path | None:
    """Trova il file qualunque sia l'estensione (jpg/jpeg/png/webp)"""
    for ext in (".jpg", ".jpeg", ".png", ".webp", ".JPG", ".JPEG", ".PNG"):
        p = folder / f"{name}{ext}"
        if p.exists():
            return p
    return None

def resize_keeping_aspect(img: Image.Image, long_side: int) -> Image.Image:
    """Ridimensiona mantenendo proporzioni, lato lungo target = long_side"""
    w, h = img.size
    if max(w, h) <= long_side:
        return img.copy()  # già più piccola, non upscalare
    if w >= h:
        new_w = long_side
        new_h = round(h * long_side / w)
    else:
        new_h = long_side
        new_w = round(w * long_side / h)
    return img.resize((new_w, new_h), Image.LANCZOS)

def save_optimized(img: Image.Image, output_path: Path):
    """Salva con compressione progressive, strip metadata"""
    # Converte in RGB se necessario (PNG con alpha → JPG senza)
    if img.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", img.size, (10, 10, 10))  # bg nero RareBlock
        if img.mode == "P":
            img = img.convert("RGBA")
        bg.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")

    img.save(
        output_path,
        format="JPEG",
        quality=QUALITY,
        optimize=True,
        progressive=True,
    )

def fmt_size(p: Path) -> str:
    kb = p.stat().st_size / 1024
    return f"{kb:.0f} KB" if kb < 1024 else f"{kb/1024:.2f} MB"

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    src_folder = Path(sys.argv[1]).expanduser().resolve()
    if not src_folder.is_dir():
        print(f"ERRORE: cartella non trovata: {src_folder}")
        sys.exit(1)

    out_folder = src_folder / "optimized"
    out_folder.mkdir(exist_ok=True)

    print(f"\nRareBlock — Image Optimizer")
    print(f"Sorgente: {src_folder}")
    print(f"Output:   {out_folder}\n")
    print("─" * 70)

    missing = []
    total_in = 0
    total_out = 0

    for name in EXPECTED_FILES:
        src = find_source(src_folder, name)
        if not src:
            missing.append(name)
            print(f"✗ {name:<22} NON TROVATO")
            continue

        in_size = src.stat().st_size
        total_in += in_size

        with Image.open(src) as img:
            # versione mobile (800px) → file principale {name}.jpg
            mobile = resize_keeping_aspect(img, MOBILE_LONG_SIDE)
            mobile_path = out_folder / f"{name}.jpg"
            save_optimized(mobile, mobile_path)

            # versione desktop/retina (1600px) → file @2x {name}@2x.jpg
            desktop = resize_keeping_aspect(img, DESKTOP_LONG_SIDE)
            desktop_path = out_folder / f"{name}@2x.jpg"
            save_optimized(desktop, desktop_path)

        out_a = mobile_path.stat().st_size
        out_b = desktop_path.stat().st_size
        total_out += out_a + out_b

        print(f"✓ {name:<22} in: {fmt_size(src):>9}  →  "
              f"mobile: {fmt_size(mobile_path):>8}  retina: {fmt_size(desktop_path):>8}")

    print("─" * 70)
    if missing:
        print(f"\n⚠  File mancanti: {', '.join(missing)}")
        print("   Verifica i nomi esatti nella cartella sorgente.\n")
        sys.exit(1)

    saved_kb = (total_in - total_out) / 1024
    saved_pct = (1 - total_out / total_in) * 100 if total_in > 0 else 0
    print(f"\nTotale input:  {total_in/1024/1024:.2f} MB")
    print(f"Totale output: {total_out/1024/1024:.2f} MB ({len(EXPECTED_FILES)*2} file)")
    print(f"Risparmio:     {saved_kb:.0f} KB ({saved_pct:.0f}%)")
    print(f"\n✓ File pronti in: {out_folder}")
    print(f"  Carica TUTTI gli 8 file in /img/memorandum/ su Aruba.\n")

if __name__ == "__main__":
    main()
