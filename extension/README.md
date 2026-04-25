# RareBlock Hunter — Chrome Extension

Estensione Chrome (Manifest V3) che fa da **bridge di scraping** per la web app
RareBlock Collector. Risolve il problema del 403 Cloudflare su Catawiki facendo
girare lo scraping nel browser dell'utente — IP residenziale, cookie, TLS
fingerprint nativi → Cloudflare non distingue da un utente umano.

## Cosa fa

Quando RareBlock vuole eseguire una scansione (es. cercare nuove aste Charizard
PSA 10 su Catawiki):

1. RareBlock manda una richiesta all'estensione via `window.postMessage`
2. L'estensione apre una **tab nascosta** sul sito target (es. catawiki.com/it/s?q=...)
3. Aspetta il caricamento della pagina + 2.5s per il lazy-load JS
4. Inietta uno scraper DOM-based che estrae titolo, prezzo, immagine, link, etc.
5. Chiude la tab e restituisce i risultati a RareBlock

L'utente vede una tab che si apre per ~5-10s e si chiude da sola.

## Siti supportati

| Sito | Strategia | Note |
|---|---|---|
| **Catawiki** | `__NEXT_DATA__` JSON + DOM fallback | Bypassa Cloudflare ✓ |
| **eBay** (it/com/de/uk/fr/es) | DOM `li.s-item` | Funziona sempre |
| **Subito** | `__NEXT_DATA__` JSON + DOM | Funziona sempre |

## Installazione (sviluppo / unpacked)

1. Vai su `chrome://extensions`
2. Attiva **Developer mode** (toggle in alto a destra)
3. **Load unpacked** → seleziona la cartella `extension/` di questo repo
4. L'estensione "RareBlock Hunter" appare nella lista
5. (Opzionale, solo se usi RareBlock da `file://`) Clicca sui dettagli
   dell'estensione e abilita **Allow access to file URLs**

## Verifica funzionamento

1. Apri RareBlock (claude.ai dev / rareblock.eu / file:// locale)
2. Vai al tab **Radar → 📅 Scansioni**
3. Crea un job (es. "Pokemon" su Catawiki, manuale)
4. Click **▶ Esegui ora**
5. Vedrai una tab Catawiki aprirsi e chiudersi in ~7s
6. I risultati appariranno nel pannello a destra

Per debug: il popup dell'estensione (icona "RB" nella barra) mostra le ultime
30 esecuzioni con timestamp, durata e numero di risultati.

## Architettura interna

```
extension/
├── manifest.json           # MV3 manifest, permissions, content_scripts
├── background.js           # Service worker: orchestrazione tab + scrape
├── content-script.js       # Bridge postMessage ↔ chrome.runtime.sendMessage
├── popup.html / popup.js   # UI con ultime esecuzioni
├── scrapers/               # DOM scraper per ogni sito (modulari)
│   ├── index.js
│   ├── catawiki.js
│   ├── ebay.js
│   └── subito.js
└── icons/                  # Icone 16/48/128
```

### Protocollo di comunicazione

**Pagina RareBlock → Content Script** (via `window.postMessage`):
```js
{
  type: 'rb-scrape-request',
  requestId: 'ext_abc123',
  site: 'catawiki',           // 'catawiki' | 'ebay' | 'subito'
  url: 'https://www.catawiki.com/it/s?q=pokemon',
  job: { ... }                 // opzionale, passato allo scraper
}
```

**Content Script → Pagina** (risposta):
```js
{
  type: 'rb-scrape-response',
  requestId: 'ext_abc123',
  items: [ {title, price, currency, image_url, url, ...}, ... ],
  error: null,                 // o stringa errore
  source: 'extension/catawiki',
  duration_ms: 6420
}
```

**Pagina → Content Script** (detection):
```js
{ type: 'rb-ext-ping' }
```

**Content Script → Pagina** (auto-annuncio):
```js
{
  type: 'rb-extension-ready',
  version: '2.0.0',
  capabilities: ['catawiki', 'ebay', 'subito']
}
```

## Aggiungere un nuovo sito

1. Crea `scrapers/<sitename>.js` con la function `scrape<Site>(job)` che
   ritorna un array di items normalizzati (vedi `catawiki.js` per esempio)
2. Importa e aggiungi a `scrapers/index.js`:
   ```js
   import { scrapeNewsite } from './newsite.js';
   export const SCRAPERS = { ..., newsite: scrapeNewsite };
   ```
3. Aggiungi `host_permissions` per il dominio nel `manifest.json`
4. Bump version in `manifest.json`
5. Reload extension in `chrome://extensions`

## Privacy

- L'estensione **non raccoglie dati** né li manda a server esterni
- Non legge cookie di terze parti
- Apre solo le tab esplicitamente richieste dalla web app RareBlock
- Tutto lo storico è locale (`chrome.storage.local`)

## Distribuzione futura

Per pubblicare su Chrome Web Store servirà:
1. Account dev ($5 una tantum)
2. Bump del manifest a versione di release
3. Zip della cartella → upload
4. Review (3-7 giorni)

Per ora distribuita unpacked solo per uso interno RareBlock.
