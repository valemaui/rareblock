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

const TAB_TIMEOUT_MS = 45000;        // max attesa caricamento pagina + scrape async
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

// ─── Handler rb-fetch-html: fetch HTML grezzo via service worker ──────
// Strategia leggera: zero tab, fetch diretto con credentials:'include'.
// Il SW eredita i cookie dell'utente per quel dominio (se ha mai visitato
// CM/eBay loggato, i suoi cookie passano). eBay/CM vedono richiesta
// indistinguibile da una navigazione normale → no blocco.
//
// Whitelist ferrea: solo domini definiti in host_permissions per cui
// Chrome darà accesso CORS al SW. Throttle 1.5s/dominio per essere civili.
const FETCH_DOMAINS = [
  'cardmarket.com',
  'ebay.it', 'ebay.com', 'ebay.de', 'ebay.co.uk', 'ebay.fr', 'ebay.es',
  'pricecharting.com',
];
const FETCH_THROTTLE_MS = 1500;
const _lastFetchByHost = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rb-fetch-html') return false;

  if (!msg.url || !/^https:\/\//.test(msg.url)) {
    sendResponse({ ok: false, error: 'URL non valido' });
    return false;
  }
  let parsed;
  try { parsed = new URL(msg.url); } catch (_) {
    sendResponse({ ok: false, error: 'URL malformato' });
    return false;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const allowed = FETCH_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  if (!allowed) {
    sendResponse({ ok: false, error: 'dominio non whitelisted: ' + host });
    return false;
  }

  fetchHtmlThrottled(msg.url, host, msg.headers || {})
    .then(result => sendResponse(result))
    .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true; // async response
});

async function fetchHtmlThrottled(url, host, customHeaders) {
  // Throttle per dominio (anti-burst, evita di sembrare bot)
  const now = Date.now();
  const last = _lastFetchByHost[host] || 0;
  const wait = Math.max(0, FETCH_THROTTLE_MS - (now - last));
  if (wait > 0) await sleep(wait);
  _lastFetchByHost[host] = Date.now();

  // Headers: il SW imposta automaticamente User-Agent corretto del browser.
  // Aggiungiamo Accept-Language coerente con tab utente.
  const headers = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': customHeaders['Accept-Language'] || 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    ...customHeaders,
  };

  const startedAt = Date.now();
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',  // chiave: passa i cookie utente per quel dominio
      redirect: 'follow',
      mode: 'cors',
    });
    const html = await r.text();
    return {
      ok: r.ok,
      status: r.status,
      html,
      url: r.url,                 // finale (post-redirects)
      length: html.length,
      duration_ms: Date.now() - startedAt,
      source: 'extension/fetch',
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e),
      duration_ms: Date.now() - startedAt,
    };
  }
}

// ─── Risposta a "ping" per detection lato pagina ──────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rb-ping') return false;
  sendResponse({
    type: 'rb-pong',
    version: chrome.runtime.getManifest().version,
    capabilities: [
      ...Object.keys(SCRAPERS),
      'fetch-html',  // novità v2.5: fetch HTML grezzo da CM/eBay/PC
    ],
    fetch_domains: FETCH_DOMAINS,
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

// ═══════════════════════════════════════════════════════════════════════
// JOB SETTIMANALE — sweep prezzi collezione
//
// Una volta a settimana (quando Chrome è aperto), apre RareBlock in una tab,
// attende che la sessione sia pronta, e invoca window.rbWeeklyPriceSweep()
// sulla pagina (che ha la sessione autenticata e tutta la logica prezzi).
// La pagina cicla le carte con delay anti-bot e popola cm_price_by_condition,
// poi fa lo snapshot del valore collezione.
//
// Nota: gli alarm MV3 sopravvivono al riavvio del SW ma NON girano a browser
// chiuso. È il modello "gira di notte se il browser è acceso" — coerente con
// l'approccio cookie-utente (serve comunque una sessione Chrome attiva).
// ═══════════════════════════════════════════════════════════════════════
const SWEEP_ALARM = 'rb-weekly-price-sweep';
const SWEEP_PERIOD_MIN = 7 * 24 * 60;        // 7 giorni
const RAREBLOCK_URL = 'https://www.rareblock.eu/pokemon-db.html';
const SWEEP_TAB_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max (collezioni grandi + delay)
const SWEEP_SESSION_WAIT_MS = 20000;         // attesa che la sessione sia pronta

// Crea/riallinea l'alarm all'install e all'avvio del browser
chrome.runtime.onInstalled.addListener(() => ensureSweepAlarm());
chrome.runtime.onStartup.addListener(() => ensureSweepAlarm());

async function ensureSweepAlarm() {
  try {
    const existing = await chrome.alarms.get(SWEEP_ALARM);
    if (!existing) {
      // Prima esecuzione tra ~6h (così non parte subito all'install), poi settimanale
      chrome.alarms.create(SWEEP_ALARM, {
        delayInMinutes: 6 * 60,
        periodInMinutes: SWEEP_PERIOD_MIN,
      });
    }
  } catch (_) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) {
    runWeeklySweep().catch(() => {});
  }
});

// Permette di lanciarlo a mano dal popup ({type:'rb-run-sweep-now'})
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rb-run-sweep-now') return false;
  runWeeklySweep()
    .then(r => sendResponse({ ok: true, result: r }))
    .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function runWeeklySweep() {
  const startedAt = Date.now();
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: RAREBLOCK_URL, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId, 60000);
    await sleep(3000); // lascia bootare l'app + sessione GoTrue

    // Attendi che window.rbWeeklyPriceSweep esista E che ci sia una sessione
    const ready = await pollPageReady(tabId, SWEEP_SESSION_WAIT_MS);
    if (!ready) {
      await logSweep({ ok: false, error: 'pagina/sessione non pronta', duration_ms: Date.now() - startedAt });
      return { ok: false, error: 'pagina/sessione non pronta' };
    }

    // Esegui lo sweep SULLA pagina (sessione autenticata). executeScript con
    // func async: ritorna la Promise risolta come result.
    const exec = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        if (typeof window.rbWeeklyPriceSweep !== 'function') return { error: 'rbWeeklyPriceSweep assente' };
        try {
          // delay gestiti lato pagina (anti-bot). Nessun onProgress qui (cross-context).
          return await window.rbWeeklyPriceSweep({ force: true, snapshot: true });
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
      },
    });

    const result = (exec && exec[0] && exec[0].result) || { error: 'nessun risultato' };
    await logSweep({
      ok: !result.error,
      total: result.total, scraped_ok: result.ok, failed: result.failed,
      skipped: result.skipped, error: result.error || null,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (e) {
    await logSweep({ ok: false, error: String(e?.message || e), duration_ms: Date.now() - startedAt });
    return { ok: false, error: String(e?.message || e) };
  } finally {
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// Polla la pagina finché rbWeeklyPriceSweep esiste e c'è una sessione utente
async function pollPageReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const hasFn = typeof window.rbWeeklyPriceSweep === 'function';
          let hasSession = false;
          try {
            hasSession = (typeof getCurrentUserId === 'function' && !!getCurrentUserId())
                      || (typeof getHDR === 'function' && !!(getHDR().Authorization));
          } catch (_) {}
          return hasFn && hasSession;
        },
      });
      if (r && r[0] && r[0].result === true) return true;
    } catch (_) {}
    await sleep(1500);
  }
  return false;
}

async function logSweep(entry) {
  try {
    const { sweeps = [] } = await chrome.storage.local.get('sweeps');
    sweeps.unshift({ ...entry, timestamp: new Date().toISOString() });
    await chrome.storage.local.set({ sweeps: sweeps.slice(0, 20) });
  } catch (_) {}
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
