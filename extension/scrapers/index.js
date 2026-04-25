// ═══════════════════════════════════════════════════════════════════════
// Scrapers — funzioni iniettate nelle tab di destinazione tramite
// chrome.scripting.executeScript({func, args}). Devono essere SELF-CONTAINED:
// niente closure su variabili esterne, niente import, niente var globali.
// Il valore di ritorno deve essere serializzabile (no DOM nodes / classes).
//
// Output uniforme per tutti i siti: array di items con il seguente shape:
//   {
//     title: string,
//     price: number | null,
//     currency: string,
//     image_url: string | null,
//     url: string,
//     end_time: string | null,    // ISO timestamp
//     location: string | null,
//     seller: string | null,
//     is_auction: boolean,
//     source: string,             // 'catawiki' | 'ebay' | 'subito'
//     bids: number | null,
//     shipping: string | null,
//     lot_id: string | null
//   }
// ═══════════════════════════════════════════════════════════════════════

import { scrapeCatawiki } from './catawiki.js';
import { scrapeEbay } from './ebay.js';
import { scrapeSubito } from './subito.js';

export const SCRAPERS = {
  catawiki: scrapeCatawiki,
  ebay: scrapeEbay,
  subito: scrapeSubito,
};
