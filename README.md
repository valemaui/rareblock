# RareBlock Collector

App per gestione collezione carte Pokémon + preventivi acquisto.

## File principali

- `pokemon-db.html` — App frontend completa (single-file, apri nel browser)
- `rareblock-cardmarket.user.js` — Userscript Tampermonkey per prezzi CM
- `cm-price.ts` — Supabase Edge Function (deploy come `smooth-endpoint`)

## Stack

- **Frontend**: HTML/CSS/JS single file
- **Backend**: Supabase (`rbjaaeyjeeqfpbzyavag.supabase.co`)
- **APIs**: Pokémon TCG API, Cardmarket (via browser/bookmarklet)

## Setup prezzi CM

Il segnalibro per estrarre prezzi da Cardmarket va creato manualmente:
1. Apri `installa-segnalibro.html` nel browser
2. Trascina il pulsante verde nella barra segnalibri
3. Usa il segnalibro sulla pagina CM aperta dall'app

## Supabase Edge Functions

```bash
supabase functions deploy smooth-endpoint --no-verify-jwt
```

## Note sviluppo

- `set_id` salvato in ogni item preventivo per URL CM precisi
- CM_SET_ABBREV contiene solo codici verificati navigando CM reale
- Set DP/Platinum/XY+ usano livello 2 (browse set + searchString)

<!-- deploy test: 2026-04-15 10:08:57 UTC -->
