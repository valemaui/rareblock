# RareBlock — AI Image Prompts per il Memorandum

Documento operativo. Ogni prompt è ottimizzato per Midjourney v6 / Flux Pro / DALL-E 3.
Tutte le immagini sono **deliberatamente non-Pokémon**: niente carte, niente booster box, niente loghi. Il posizionamento è "custode di valore", non "rivenditore di TCG". Questa è la scelta che eleva il brand.

---

## Principi di coerenza visiva (validi per ogni prompt)

**Palette obbligata**
- Nero caldo `#0a0a0a` come dominante
- Oro champagne `#c9a961` come unico accento (luce, riflessi, dettagli)
- Crema/avorio `#f5f1e8` per highlight più caldi
- **Mai** blu, rosso, verde saturi. Mai magenta. Mai pastelli.

**Stile fotografico**
- Luce direzionale singola, calda, contrasto alto
- Profondità di campo bassa (sfocato selettivo)
- Grana pellicola sottile (medium format Portra-style)
- Composizioni asimmetriche, vuoto generoso
- Riferimenti: Patek Philippe campaigns, Aston Martin lookbooks, Aesop store photography, monografie di architettura brutalista in luce calda

**Da escludere sempre (negative prompt)**
`no text, no logo, no people faces, no playing cards, no pokemon, no anime, no cartoon, no neon, no saturated colors, no blue tones, no plastic, no cheap lighting, no stock photo aesthetic, no symmetry, no centered composition`

---

## 1. Hero — Backdrop atmosferico (opzionale)
**Slot**: dietro il wordmark in homepage, full-viewport con overlay scuro (opacity 0.35)
**Aspect ratio**: 21:9 oppure 16:9
**Piattaforma consigliata**: Midjourney v6 → `--ar 21:9 --style raw --v 6`

```
ultra-minimal architectural interior, warm black marble walls, single shaft
of golden light entering from upper-left corner, dust particles suspended
in light beam, deep negative space, brutalist cathedral atmosphere,
cinematic chiaroscuro lighting, shot on Hasselblad, kodak portra 800
emulation, ultra-fine grain, no people, atmospheric, contemplative,
museum vault aesthetic, gold and warm black palette only
```

---

## 2. Sezione "Custodia" — Vault interior
**Slot**: tile featured image accanto al testo della sezione III, oppure full-bleed prima di sezione IV
**Aspect ratio**: 4:5 verticale (per layout affianco al testo) oppure 21:9 (per full-bleed)
**Piattaforma consigliata**: Flux Pro per il dettaglio architettonico

```
private archive vault interior, rows of identical unmarked black archival
boxes on dark walnut shelving, warm directional tungsten lighting from
a single brass sconce, deep shadows, polished concrete floor reflecting
the light, cinematic composition with shelves receding into darkness,
no labels visible, no logos, museum-grade storage facility, the kind
of place a private collector keeps what matters, shot on medium format,
Kodak Portra 800, fine grain, gold accent on metal hardware only
```

**Variante alternativa (più astratta)**:
```
extreme close-up of a brass key resting on aged dark leather, single
warm spotlight from upper-right, deep shadow on left side, shallow
depth of field, intricate engraving on the key bow visible, dust motes
in the light, evocative of safe deposit and private custody, still life
photography, museum catalog aesthetic, gold and black palette
```

---

## 3. Sezione "Mercato" (problema) — Caos contenuto
**Slot**: full-bleed o asset di accompagnamento alla sezione II
**Aspect ratio**: 16:9
**Piattaforma consigliata**: Midjourney v6

```
abstract still life: scattered black-and-white auction catalogs and
unopened envelopes spilling across an empty antique desk in a dimly
lit room, single tungsten desk lamp casting a small circle of warm
light, the rest in shadow, suggestion of disorder and overwhelm,
no faces, no readable text, no logos, atmospheric, melancholic,
shot on film, warm black and gold palette, cinematic
```

---

## 4. Sezione "Il Club" — Studio del founder
**Slot**: dietro o accanto al "Founder note" in sezione VII (opacity reduced, integrato come backdrop)
**Aspect ratio**: 4:5 verticale
**Piattaforma consigliata**: Flux Pro per il realismo materico

```
intimate study interior at night, single brass desk lamp on a dark
walnut writing desk, leather-bound notebook open to a blank page,
fountain pen resting beside it, glass of amber whiskey slightly out
of focus in foreground, deep dark room with hint of bookshelf in
shadow, warm tungsten light, no people visible, atmospheric and
contemplative, the office of someone who works in silence, shot on
medium format film, Portra 800 emulation, gold and warm black tones
```

---

## 5. Sezione "Tesi" — Macro evocativo
**Slot**: opzionale tile accanto al testo della sezione I, oppure dopo i 3 stat
**Aspect ratio**: 1:1 quadrato
**Piattaforma consigliata**: Flux Pro per il dettaglio

```
extreme macro of aged cream paper texture with subtle gold leaf
fragment partially embedded, fibers visible, raking warm light from
the left creating long micro-shadows, abstract and minimal, evocative
of permanence and rarity, museum conservation aesthetic, shot with
macro lens at f/2.8, fine grain, gold and warm cream palette only,
no text, no symbols, pure texture
```

---

## 6. Open Graph / Social share image
**Slot**: meta tag `og:image` per quando il link viene condiviso
**Aspect ratio**: 1.91:1 (1200×630px ideale)
**Piattaforma consigliata**: Midjourney + edit testuale finale in Figma

```
ultra-minimal composition: deep warm black background, single thin
gold horizontal line crossing 30% from top, subtle vertical light
gradient from left edge, generous negative space, sophisticated
luxury memorandum aesthetic, magazine cover composition, gold leaf
texture in upper third, cinematic minimalism, no text, no logo
```
*Sopra questa immagine sovrascrivi in post-produzione*: "RAREBLOCK · Private Memorandum" in Montserrat 200, oro `#c9a961`.

---

## 7. Texture per .img-slot generici (CSS-art replacement)
Se vuoi sostituire i placeholder CSS attuali con immagini reali, usa questo prompt come base:

```
abstract architectural detail, dark warm marble surface with single
diagonal beam of golden light cutting across it from upper-left to
lower-right, single brass element catching the light at the
intersection point, ultra minimal, deep negative space, museum
catalog photography, Hasselblad medium format, Portra 800 grain,
gold and black palette only, no text, no figures
```

---

## Workflow consigliato

1. **Genera prima** prompt #1 (hero) e #4 (founder studio) — sono i due asset di maggiore impatto.
2. **Su Midjourney**: usa `--style raw` per evitare il "look AI" patinato. Genera 4 varianti, scegli, fai 2 round di `vary (subtle)` per affinare.
3. **Su Flux Pro**: setting "raw", guidance scale 3.5–4 (più basso = più cinematic), no upscaling artificiale.
4. **Post-produzione obbligatoria**: passaggio in Lightroom/Capture One per:
   - Riduzione saturazione globale -20
   - Curva ad S delicata
   - Split toning: ombre verso ciano-nero, luci verso oro
   - Grana 35mm aggiunta in Filter
5. **Test di coerenza**: affianca le immagini generate. Se una stona, rigenera. Meglio 4 immagini perfettamente coerenti che 8 disomogenee.

---

## Alternative se non vuoi generare nulla

La pagina è progettata per **funzionare benissimo anche senza una sola fotografia**. I placeholder CSS attuali (radial gradient oro su nero) sono volutamente eleganti. Se preferisci una versione "puramente tipografica" come fa per esempio l'Economist nei suoi memorandum di abbonamento Premium, il file è già pronto così com'è — basta non aggiungere immagini.

La scelta è coerente in entrambe le direzioni: il rischio sta solo nel mezzo.
