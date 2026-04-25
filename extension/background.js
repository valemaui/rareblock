// ═══════════════════════════════════════════════════════════════════════
// RareBlock Hunter — Background Service Worker (Manifest V3)
//
// Riceve richieste di scraping dal content-script (che a sua volta riceve
// dalla pagina RareBlock via window.postMessage), apre una tab nascosta sul
// sito target, inietta uno scraper DOM, raccoglie i risultati, chiude la
// tab e risponde al content-script.
//
// Strategia di ottimizzazione: il fetch diretto dal SW usa il TLS stack di
// Chrome quindi NON viene bloccato da Cloudflare come l'edge function. Ma
// il fetch SW non manda automaticamente i cookie utente. Per Catawiki la
// presenza dei cookie può aiutare → strada A: tab nascosta (DOM scrape) è
// la più affidabile in tutti i casi.
// ═══════════════════════════════════════════════════════════════════════

import { SCRAPERS } from './scrapers/index.js';

const TAB_TIMEOUT_MS = 30000;        // max attesa caricamento pagina
const POST_LOAD_DELAY_MS = 2500;     // attesa per JS lazy-load dopo onLoad
const BATCH_DELAY_MS = 800;          // pausa tra job concorrenti per non spam

// Coda semplice per evitare di aprire troppe tab in parallelo
let _queue = Promise.resolve();
function enqueue(fn) {
  const p = _queue.then(fn).catch(e => ({ error: String(e?.message || e) }));
  _queue = p.then(() => new Promise(r => setTimeout(r, BATCH_DELAY_MS))).catch(()=>{});
  return p;
}

// ─── Listener principale ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rb-scrape') return false;

  // Validazione minima
  if (!msg.site || !SCRAPERS[msg.site]) {
    sendResponse({ error: 'sito non supportato: ' + msg.site, items: [] });
    return false;
  }
  if (!msg.url || !/^https:\/\//.test(msg.url)) {
    sendResponse({ error: 'URL non valido', items: [] });
    return false;
  }

  enqueue(() => scrapeViaTab(msg.site, msg.url, msg.job || {}))
    .then(result => sendResponse(result))
    .catch(err => sendResponse({ error: String(err?.message || err), items: [] }));

  return true; // async response
});

// ─── Risposta a "ping" per detection lato pagina ──────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rb-ping') return false;
  sendResponse({
    type: 'rb-pong',
    version: chrome.runtime.getManifest().version,
    capabilities: Object.keys(SCRAPERS),
  });
  return false;
});

// ─── Apertura tab + scrape ────────────────────────────────────────────
async function scrapeViaTab(site, url, job) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  const startedAt = Date.now();

  try {
    // Aspetta che la tab sia caricata (status === 'complete')
    await waitForTabComplete(tabId, TAB_TIMEOUT_MS);
    // Lascia tempo al JS lazy-load (Catawiki carica i lot via JS)
    await sleep(POST_LOAD_DELAY_MS);

    // Inietta scraper specifico per il sito
    const scraperFn = SCRAPERS[site];
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: scraperFn,
      args: [job || {}],
    });

    const items = (injectionResults && injectionResults[0] && injectionResults[0].result) || [];
    return {
      items,
      error: null,
      search_url: url,
      source: 'extension/' + site,
      duration_ms: Date.now() - startedAt,
    };
  } catch (e) {
    return {
      items: [],
      error: String(e?.message || e),
      search_url: url,
      source: 'extension/error',
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    // Chiudi sempre la tab
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('timeout caricamento (' + timeoutMs + 'ms)'));
    }, timeoutMs);

    function onUpdated(changedTabId, info) {
      if (changedTabId !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Verifica subito stato corrente (tab già completa?)
    chrome.tabs.get(tabId).then(t => {
      if (t && t.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }).catch(() => {});
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Storage delle ultime esecuzioni (per popup.html) ─────────────────
async function logRun(entry) {
  try {
    const { runs = [] } = await chrome.storage.local.get('runs');
    runs.unshift({ ...entry, timestamp: new Date().toISOString() });
    await chrome.storage.local.set({ runs: runs.slice(0, 30) });
  } catch (_) {}
}

// Wrap del listener per loggare
const _originalScrape = scrapeViaTab;
async function scrapeViaTabLogged(site, url, job) {
  const r = await _originalScrape(site, url, job);
  logRun({
    site,
    url,
    items_count: (r.items || []).length,
    error: r.error,
    duration_ms: r.duration_ms,
  });
  return r;
}
// rimpiazza riferimento
self.scrapeViaTab = scrapeViaTabLogged;
