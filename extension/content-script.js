// ═══════════════════════════════════════════════════════════════════════
// RareBlock Hunter — Content Script
//
// Iniettato nelle pagine RareBlock (rareblock.eu, claude.ai per dev,
// localhost, file://). Fa da ponte tra:
//   - la pagina (window.postMessage)
//   - il background service worker (chrome.runtime.sendMessage)
//
// Protocollo:
//   Page → CS:  {type:'rb-scrape-request', requestId, site, url, job}
//   CS → Page:  {type:'rb-scrape-response', requestId, items, error, ...}
//   Page → CS:  {type:'rb-ext-ping'}
//   CS → Page:  {type:'rb-extension-ready', version, capabilities}
// ═══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  if (window.__rbExtBridgeInstalled) return;
  window.__rbExtBridgeInstalled = true;

  var EXT_VERSION = chrome.runtime.getManifest().version;

  function announce() {
    chrome.runtime.sendMessage({ type: 'rb-ping' }, function (response) {
      if (chrome.runtime.lastError) return; // SW spento, riproviamo dopo
      window.postMessage({
        type: 'rb-extension-ready',
        version: response?.version || EXT_VERSION,
        capabilities: response?.capabilities || ['catawiki', 'ebay', 'subito'],
      }, '*');
    });
  }

  // Listener per richieste della pagina
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || typeof d !== 'object') return;

    // Ping della pagina → annunciamo presenza
    if (d.type === 'rb-ext-ping') {
      announce();
      return;
    }

    // Scrape request
    if (d.type === 'rb-scrape-request' && d.requestId && d.site && d.url) {
      chrome.runtime.sendMessage({
        type: 'rb-scrape',
        site: d.site,
        url: d.url,
        job: d.job || null,
      }, function (response) {
        if (chrome.runtime.lastError) {
          window.postMessage({
            type: 'rb-scrape-response',
            requestId: d.requestId,
            items: [],
            error: 'extension service worker non raggiungibile: ' + chrome.runtime.lastError.message,
          }, '*');
          return;
        }
        window.postMessage({
          type: 'rb-scrape-response',
          requestId: d.requestId,
          items: response?.items || [],
          error: response?.error || null,
          source: response?.source || null,
          search_url: response?.search_url || d.url,
          duration_ms: response?.duration_ms || null,
        }, '*');
      });
      return;
    }
  });

  // Annuncia all'avvio + dopo 1s + dopo load completo
  announce();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announce);
  }
  setTimeout(announce, 1000);
  setTimeout(announce, 3000); // ulteriore retry per pagine lente
})();
