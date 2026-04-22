// ==UserScript==
// @name         RareBlock CM Price Scraper
// @namespace    https://www.rareblock.eu
// @version      1.3
// @description  Legge prezzi e condizioni dalla pagina Cardmarket e li invia a RareBlock via postMessage
// @author       RareBlock
// @match        https://www.cardmarket.com/*/Pokemon/Products/*
// @match        https://www.cardmarket.com/*/Pokemon/Products/Search*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── 1. Attendi che la pagina sia pronta ──────────────────────────────────
  function waitForListings(cb, attempts) {
    attempts = attempts || 0;
    if (attempts > 30) { cb([]); return; }
    var rows = scrapeListings();
    if (rows.length > 0) { cb(rows); return; }
    setTimeout(function () { waitForListings(cb, attempts + 1); }, 500);
  }

  // ── 2. Estrai listing dalla pagina CM ────────────────────────────────────
  function parsePrice(str) {
    if (!str) return null;
    var s = str.replace(/[^\d,\.]/g, '').trim();
    // Formato IT: 1.234,56 → europeo
    if (/^\d{1,3}(\.\d{3})*(,\d{1,2})$/.test(s))
      return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    if (/^\d+,\d{1,2}$/.test(s))
      return parseFloat(s.replace(',', '.'));
    var n = parseFloat(s.replace(',', '.'));
    return isNaN(n) ? null : n;
  }

  var COND_ORDER = {
    'Mint': 1, 'Near Mint': 2, 'Excellent': 3, 'Good': 4,
    'Light Played': 5, 'Played': 6, 'Poor': 7
  };

  function scrapeListings() {
    var listings = [];

    // ── Strategia A: article-row (struttura principale CM) ───────────────
    var rows = document.querySelectorAll(
      '.article-row, .article-table-body .row, [class*="article-row"]'
    );

    rows.forEach(function (row) {
      // Condizione
      var condEl = row.querySelector(
        '[class*="badge"], [class*="condition"], .icon-condition, span[title]'
      );
      var condText = condEl ? (condEl.textContent || condEl.getAttribute('title') || '').trim() : '';

      // Normalizza condizione
      var condMap = {
        'MT': 'Mint', 'NM': 'Near Mint', 'EX': 'Excellent',
        'GD': 'Good', 'LP': 'Light Played', 'PL': 'Played', 'PO': 'Poor',
        'Mint': 'Mint', 'Near Mint': 'Near Mint', 'Excellent': 'Excellent',
        'Good': 'Good', 'Light Played': 'Light Played', 'Played': 'Played', 'Poor': 'Poor'
      };
      var cond = condMap[condText] || null;

      // Prezzo
      var priceEl = row.querySelector(
        '.price-container, [class*="price-container"], .color-primary, [class*="price"]'
      );
      if (!priceEl) return;
      var price = parsePrice(priceEl.textContent);
      if (!price || price < 0.1) return;

      // Quantità disponibile
      var qtyEl = row.querySelector('[class*="quantity"], [class*="count"]');
      var qty = qtyEl ? (parseInt(qtyEl.textContent) || 1) : 1;

      listings.push({
        price: price,
        condition: cond || 'Unknown',
        condRank: COND_ORDER[cond] || 5,
        qty: qty
      });
    });

    if (listings.length > 0) return listings;

    // ── Strategia B: table rows ──────────────────────────────────────────
    var trs = document.querySelectorAll('table tbody tr, .table tbody tr');
    trs.forEach(function (tr) {
      var tds = tr.querySelectorAll('td');
      if (tds.length < 3) return;
      var price = null, cond = null;
      tds.forEach(function (td) {
        var t = td.textContent.trim();
        var p = parsePrice(t);
        if (p && p >= 0.1 && p < 99999 && !price) price = p;
        if (!cond) {
          var c = condMap2(t);
          if (c) cond = c;
          var badge = td.querySelector('[class*="badge"],[class*="condition"]');
          if (badge && !cond) cond = condMap2(badge.textContent.trim());
        }
      });
      if (price) listings.push({
        price: price,
        condition: cond || 'Unknown',
        condRank: COND_ORDER[cond] || 5,
        qty: 1
      });
    });

    return listings;
  }

  function condMap2(t) {
    var m = {
      'MT': 'Mint', 'NM': 'Near Mint', 'EX': 'Excellent',
      'GD': 'Good', 'LP': 'Light Played', 'PL': 'Played', 'PO': 'Poor'
    };
    return m[t] || null;
  }

  // ── 3. Costruisce overlay UI nella pagina CM ──────────────────────────
  function showOverlay(listings) {
    var existing = document.getElementById('rb-overlay');
    if (existing) existing.remove();

    var div = document.createElement('div');
    div.id = 'rb-overlay';
    div.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:999999',
      'background:#0d1117', 'border:1px solid #30363d', 'border-radius:10px',
      'padding:14px 18px', 'min-width:260px', 'max-width:340px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",monospace',
      'font-size:13px', 'color:#e6edf3', 'box-shadow:0 8px 32px rgba(0,0,0,.6)',
      'line-height:1.5'
    ].join(';');

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:14px;color:#58a6ff;margin-bottom:10px;display:flex;align-items:center;gap:8px';
    title.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> RareBlock — '
      + listings.length + ' prezzi trovati';
    div.appendChild(title);

    // Lista listing (max 7)
    var shown = listings.slice(0, 7);
    shown.forEach(function (l) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #21262d';
      var condColor = { 1: '#3fb950', 2: '#3fb950', 3: '#a8f0a8', 4: '#d29922', 5: '#f0883e', 6: '#f47068', 7: '#f47068' };
      var short = { 'Mint': 'MT', 'Near Mint': 'NM', 'Excellent': 'EX', 'Good': 'GD', 'Light Played': 'LP', 'Played': 'PL', 'Poor': 'PO' };
      row.innerHTML = '<span style="color:' + (condColor[l.condRank] || '#8b949e') + '">' + (short[l.condition] || '?') + '</span>'
        + '<span>€ ' + l.price.toFixed(2) + '</span>';
      div.appendChild(row);
    });

    // Bottone invia
    var btn = document.createElement('button');
    btn.textContent = '↩ Invia a RareBlock';
    btn.style.cssText = [
      'margin-top:12px', 'width:100%', 'padding:8px', 'background:#238636',
      'color:#fff', 'border:none', 'border-radius:6px', 'cursor:pointer',
      'font-size:13px', 'font-weight:600'
    ].join(';');
    btn.onclick = function () { sendPrices(listings); };
    div.appendChild(btn);

    // Bottone chiudi
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:8px;right:10px;background:none;border:none;color:#8b949e;cursor:pointer;font-size:16px';
    closeBtn.onclick = function () { div.remove(); };
    div.appendChild(closeBtn);
    div.style.position = 'fixed'; // needed for absolute child

    document.body.appendChild(div);
  }

  // ── 4. Invia prezzi all'opener (RareBlock tab) ────────────────────────
  function sendPrices(listings) {
    var payload = {
      type: 'rareblock_cm_prices',
      prices: listings.map(function (l) { return l.price; }),
      listings: listings,
      url: location.href
    };

    var sent = false;

    // Prova window.opener (tab aperto da RareBlock)
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(payload, '*');
        sent = true;
        document.getElementById('rb-overlay').innerHTML =
          '<div style="color:#3fb950;font-weight:600;padding:8px">✓ Prezzi inviati a RareBlock!</div>';
        setTimeout(function () { window.close(); }, 1500);
      } catch (e) { }
    }

    // Prova parent (iframe, non dovrebbe succedere su CM ma per sicurezza)
    if (!sent && window.parent !== window) {
      try { window.parent.postMessage(payload, '*'); sent = true; } catch (e) { }
    }

    // Broadcast a tutti i tab dello stesso origin (BroadcastChannel)
    if (!sent && typeof BroadcastChannel !== 'undefined') {
      try {
        var bc = new BroadcastChannel('rareblock_prices');
        bc.postMessage(payload);
        bc.close();
        sent = true;
      } catch (e) { }
    }

    if (!sent) {
      alert('Prezzi: ' + listings.slice(0, 5).map(function (l) {
        return l.condition + ' €' + l.price.toFixed(2);
      }).join(', '));
    }
  }

  // ── 5. Main ──────────────────────────────────────────────────────────
  waitForListings(function (listings) {
    if (!listings.length) {
      console.log('[RareBlock] Nessun listing trovato su questa pagina');
      return;
    }
    listings.sort(function (a, b) { return a.price - b.price; });
    console.log('[RareBlock] Trovati ' + listings.length + ' listing');
    showOverlay(listings);

    // Auto-invia se la pagina è stata aperta da RareBlock
    if (window.opener && !window.opener.closed) {
      // Aspetta 1.5s per render completo della pagina
      setTimeout(function () { sendPrices(listings); }, 1500);
    }
  });

})();
