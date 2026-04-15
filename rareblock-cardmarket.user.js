// ==UserScript==
// @name         RareBlock · CM Price Bridge
// @namespace    https://rareblock.app
// @version      1.0
// @description  Legge i prezzi dalla pagina Cardmarket e li invia a RareBlock tramite postMessage
// @author       RareBlock
// @match        https://www.cardmarket.com/*/Pokemon/Products/Singles/*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Aspetta che la pagina sia completamente caricata
  function waitForPrices(callback, retries) {
    retries = retries || 0;
    if (retries > 20) { callback([]); return; }

    // La pagina CM è SSR: cerca il testo "Articoli disponibili" come segnale
    // che la tabella offerte è caricata
    const text = document.body.innerText || '';
    const hasOffers = text.includes('Articoli disponibili') || text.includes('Articles available');

    if (!hasOffers) {
      setTimeout(function () { waitForPrices(callback, retries + 1); }, 500);
      return;
    }
    callback([]);
  }

  function extractPrices() {
    // Formato innerText di CM: ogni offerta ha "{prezzo} €\n{quantità}\n"
    // Verificato funzionante sulla pagina reale: regex cerca prezzo seguito da newline+numero
    var text = document.body.innerText || '';
    var re = new RegExp('(\\d{1,4}[,.]\\d{2})\\s*\u20ac\\s*[\\r\\n]+\\s*(\\d+)\\s*[\\r\\n]', 'g');
    var prices = [];
    var seen = {};
    var m;
    while ((m = re.exec(text)) !== null) {
      var v = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      if (v >= 0.01 && v <= 50000 && !seen[v]) {
        seen[v] = true;
        prices.push({ price: v, condition: '?' });
      }
    }
    prices.sort(function (a, b) { return a.price - b.price; });
    return prices.slice(0, 7);
  }

  function sendToRareBlock(prices) {
    if (!window.opener) return false;

    try {
      window.opener.postMessage({
        type: 'rareblock_cm_prices',
        prices: prices.map(function (p) { return p.price; }),
        pricesDetail: prices,
        url: window.location.href,
        timestamp: Date.now()
      }, '*'); // wildcard: funziona cross-origin (file://, localhost, qualsiasi host)
      return true;
    } catch (e) {
      return false;
    }
  }

  function injectUI(prices, sentOk) {
    // Crea un banner fisso in cima alla pagina
    const existing = document.getElementById('rareblock-bridge');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'rareblock-bridge';
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
      'background:#161b22', 'border-bottom:2px solid #58a6ff',
      'color:#e6edf3', 'font-family:system-ui,sans-serif',
      'font-size:13px', 'padding:10px 16px',
      'display:flex', 'align-items:center', 'gap:12px', 'flex-wrap:wrap'
    ].join(';');

    const logo = document.createElement('span');
    logo.style.cssText = 'font-weight:700;color:#c9a84c;letter-spacing:.1em';
    logo.textContent = 'RARE·BLOCK';
    banner.appendChild(logo);

    if (prices.length > 0) {
      const label = document.createElement('span');
      label.style.cssText = 'font-size:11px;color:#7d8590;text-transform:uppercase;letter-spacing:.5px';
      label.textContent = prices[0].condition !== '?' ? prices[0].condition : '';
      banner.appendChild(label);

      prices.forEach(function (p, i) {
        const chip = document.createElement('span');
        chip.style.cssText = [
          'padding:3px 10px', 'border-radius:5px', 'font-weight:600',
          'font-family:monospace', 'cursor:pointer',
          'border:1px solid',
          i === 0
            ? 'background:#3fb950;color:#0d1117;border-color:#3fb950'
            : 'background:rgba(63,185,80,.1);color:#3fb950;border-color:rgba(63,185,80,.3)'
        ].join(';');
        chip.textContent = '€' + p.price.toFixed(2);
        chip.title = 'Clicca per inviare questo prezzo a RareBlock';
        chip.onclick = function () {
          if (window.opener) {
            window.opener.postMessage({
              type: 'rareblock_cm_prices',
              prices: [p.price],
              pricesDetail: [p],
              url: window.location.href,
              timestamp: Date.now(),
              single: true
            }, '*');
          }
          window.close();
        };
        banner.appendChild(chip);
      });

      // Bottone "Invia tutti a RareBlock"
      if (sentOk) {
        const sent = document.createElement('span');
        sent.style.cssText = 'margin-left:auto;font-size:11px;color:#3fb950';
        sent.textContent = '✓ Inviati a RareBlock — puoi chiudere questa tab';
        banner.appendChild(sent);
        setTimeout(function () { window.close(); }, 1200);
      } else {
        const sendBtn = document.createElement('button');
        sendBtn.style.cssText = [
          'margin-left:auto', 'padding:5px 14px',
          'background:#58a6ff', 'color:#0d1117',
          'border:none', 'border-radius:5px',
          'font-weight:600', 'cursor:pointer', 'font-size:12px'
        ].join(';');
        sendBtn.textContent = '→ Invia a RareBlock';
        sendBtn.onclick = function () {
          if (sendToRareBlock(prices)) {
            sendBtn.textContent = '✓ Inviati!';
            sendBtn.style.background = '#3fb950';
            setTimeout(function () { window.close(); }, 800);
          } else {
            sendBtn.textContent = 'Apri RareBlock prima';
            sendBtn.style.background = '#f85149';
          }
        };
        banner.appendChild(sendBtn);
      }
    } else {
      const noPrice = document.createElement('span');
      noPrice.style.color = '#f85149';
      noPrice.textContent = 'Nessun prezzo trovato su questa pagina';
      banner.appendChild(noPrice);
    }

    // Bottone chiudi
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:#7d8590;cursor:pointer;font-size:16px;padding:0 4px';
    closeBtn.textContent = '✕';
    closeBtn.onclick = function () { banner.remove(); };
    banner.appendChild(closeBtn);

    document.body.insertBefore(banner, document.body.firstChild);
    // Sposta la pagina giù per non nascondere il contenuto
    document.body.style.paddingTop = (banner.offsetHeight + 4) + 'px';
  }

  // ── Main ──────────────────────────────────────────────────────────────────

  waitForPrices(function (rows) {
    const prices = extractPrices(rows);

    // Tenta invio automatico a RareBlock (se la tab è stata aperta dall'app)
    const sentOk = sendToRareBlock(prices);

    // Mostra sempre il banner UI con i prezzi trovati
    injectUI(prices, sentOk);
  });

})();
