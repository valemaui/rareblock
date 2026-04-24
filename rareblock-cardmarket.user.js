// ==UserScript==
// @name         RareBlock · CM Price Bridge
// @namespace    https://rareblock.app
// @version      2.1
// @description  Legge prezzi + condizioni da Cardmarket e li invia a RareBlock via postMessage + BroadcastChannel
// @author       RareBlock
// @match        https://www.cardmarket.com/*/Pokemon/Products/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var COND_RANK = {
    'Mint':1,'Near Mint':2,'Excellent':3,'Good':4,
    'Light Played':5,'Played':6,'Poor':7,
    'MT':1,'NM':2,'EX':3,'GD':4,'LP':5,'PL':6,'PO':7
  };

  function normCond(s) {
    var map = {
      'mt':'Mint','nm':'Near Mint','ex':'Excellent','gd':'Good',
      'lp':'Light Played','pl':'Played','po':'Poor',
      'mint':'Mint','near mint':'Near Mint','excellent':'Excellent',
      'good':'Good','light played':'Light Played','played':'Played','poor':'Poor'
    };
    return map[(s||'').toLowerCase().trim()] || null;
  }

  function parsePrice(s) {
    if (!s) return null;
    var c = String(s).replace(/[€\s]/g, '').trim();
    // Formato EU con migliaia: "1.234,56"
    if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(c)) return parseFloat(c.replace(/\./g, '').replace(',', '.'));
    // Formato semplice: "12,34"
    if (/^\d+,\d{2}$/.test(c)) return parseFloat(c.replace(',', '.'));
    var n = parseFloat(c.replace(',', '.'));
    return (isNaN(n) || n <= 0) ? null : n;
  }

  // ── STRATEGIA 1: __NEXT_DATA__ (SSR payload, più affidabile) ─────────────────
  function extractFromNextData(obj, depth) {
    if (depth > 12 || !obj || typeof obj !== 'object') return [];
    if (Array.isArray(obj) && obj.length > 0) {
      var first = obj[0];
      if (first && typeof first === 'object' &&
          ('price' in first || 'priceGross' in first || 'sellPrice' in first)) {
        return obj.map(function (a) {
          var raw = a.price || a.priceGross || a.sellPrice || a.minPrice;
          var p = typeof raw === 'number' ? raw : parsePrice(String(raw || ''));
          if (!p || p < 0.1) return null;
          var cond = 'Unknown';
          var cs = a.condition || a.cardCondition || a.minCondition;
          if (cs) {
            var s = typeof cs === 'object'
              ? (cs.label || cs.abbreviation || cs.name || '')
              : String(cs);
            cond = normCond(s) || cond;
          }
          return { price: Math.round(p * 100) / 100, condition: cond, condRank: COND_RANK[cond] || 5 };
        }).filter(Boolean);
      }
      for (var i = 0; i < obj.length; i++) {
        var r = extractFromNextData(obj[i], depth + 1);
        if (r.length) return r;
      }
    } else {
      var keys = Object.keys(obj);
      for (var k = 0; k < keys.length; k++) {
        var r2 = extractFromNextData(obj[keys[k]], depth + 1);
        if (r2.length) return r2;
      }
    }
    return [];
  }

  // ── STRATEGIA 2: DOM selectors su article rows ───────────────────────────────
  function scrapeArticleRows() {
    var listings = [];
    var rows = document.querySelectorAll('.article-row, [class*="articleRow"]');
    rows.forEach(function (row) {
      // Prezzo: ultimo elemento testuale che matcha pattern prezzo
      var priceText = '';
      var allEls = row.querySelectorAll('span, div, td');
      for (var i = allEls.length - 1; i >= 0; i--) {
        var t = (allEls[i].childNodes.length === 1 && allEls[i].childNodes[0].nodeType === 3)
          ? allEls[i].textContent.trim() : '';
        if (/^\d{1,4}[,.]\d{2}\s*€?$/.test(t)) { priceText = t; break; }
      }
      var price = parsePrice(priceText);
      if (!price || price < 0.1) return;

      // Condizione: badge/abbr con title
      var condEl = row.querySelector('[class*="badge"], abbr, [title*="Mint"],[title*="Played"],[title*="Poor"],[title*="Good"],[title*="Excellent"]');
      var condRaw = condEl ? (condEl.getAttribute('title') || condEl.textContent || '').trim() : '';
      var cond = normCond(condRaw) || 'Unknown';
      listings.push({ price: Math.round(price * 100) / 100, condition: cond, condRank: COND_RANK[cond] || 5 });
    });
    return listings;
  }

  // ── STRATEGIA 3: TreeWalker su area offerte ──────────────────────────────────
  function scrapeTreeWalker() {
    var main = document.querySelector('main, #main, [class*="ProductDetail"], [class*="article-table"]')
            || document.body;
    var seen = {};
    var listings = [];
    var walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var t = node.textContent.trim();
      if (/^\d{1,4}[,.]\d{2}\s*€?$/.test(t)) {
        var p = parsePrice(t);
        if (p && p >= 0.5 && !seen[p]) {
          // Escludi nav/header/footer
          var par = node.parentElement, skip = false;
          while (par && par !== main) {
            if (['nav','header','footer'].indexOf(par.tagName.toLowerCase()) >= 0) { skip = true; break; }
            par = par.parentElement;
          }
          if (!skip) { seen[p] = true; listings.push({ price: p, condition: 'Unknown', condRank: 5 }); }
        }
      }
    }
    return listings;
  }

  // ── Scrape con cascata di strategie ──────────────────────────────────────────
  function scrapeListings() {
    // 1) __NEXT_DATA__ — payload SSR, il più affidabile
    var nd = document.getElementById('__NEXT_DATA__');
    if (nd) {
      try {
        var fromNd = extractFromNextData(JSON.parse(nd.textContent), 0);
        if (fromNd.length) {
          return fromNd.sort(function (a, b) { return a.price - b.price; }).slice(0, 20);
        }
      } catch (e) {}
    }

    // 2) Article rows via DOM
    var fromRows = scrapeArticleRows();
    if (fromRows.length) {
      return fromRows.sort(function (a, b) { return a.price - b.price; }).slice(0, 20);
    }

    // 3) Fallback: TreeWalker sull'area principale
    var fromTw = scrapeTreeWalker();
    return fromTw.sort(function (a, b) { return a.price - b.price; }).slice(0, 20);
  }

  // ── Invio messaggi: opener + BroadcastChannel (dual channel per robustezza) ──
  function sendPayload(payload) {
    var sentOpener = false, sentBroadcast = false;

    if (window.opener && !window.opener.closed) {
      try { window.opener.postMessage(payload, '*'); sentOpener = true; } catch (e) {}
    }

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        var bc = new BroadcastChannel('rareblock_prices');
        bc.postMessage(payload);
        bc.close();
        sentBroadcast = true;
      } catch (e) {}
    }

    return { sentOpener: sentOpener, sentBroadcast: sentBroadcast };
  }

  function sendPrices(listings) {
    return sendPayload({
      type: 'rareblock_cm_prices',
      prices: listings.map(function (l) { return l.price; }),
      listings: listings,
      url: location.href,
      timestamp: Date.now()
    });
  }

  function sendNoPrices(reason) {
    return sendPayload({
      type: 'rareblock_cm_prices',
      prices: [],
      listings: [],
      status: 'no_prices',
      reason: reason || 'no listings found',
      url: location.href,
      timestamp: Date.now()
    });
  }

  // ── UI: banner in cima pagina con chip cliccabili (invio singolo prezzo) ─────
  function injectBanner(listings, sent) {
    var existing = document.getElementById('rareblock-bridge');
    if (existing) existing.remove();

    var banner = document.createElement('div');
    banner.id = 'rareblock-bridge';
    banner.style.cssText = [
      'position:fixed','top:0','left:0','right:0','z-index:99999',
      'background:#161b22','border-bottom:2px solid #58a6ff',
      'color:#e6edf3','font-family:system-ui,sans-serif',
      'font-size:13px','padding:10px 16px',
      'display:flex','align-items:center','gap:10px','flex-wrap:wrap'
    ].join(';');

    var logo = document.createElement('span');
    logo.style.cssText = 'font-weight:700;color:#c9a84c;letter-spacing:.1em';
    logo.textContent = 'RARE·BLOCK';
    banner.appendChild(logo);

    if (listings.length > 0) {
      var count = document.createElement('span');
      count.style.cssText = 'font-size:11px;color:#7d8590;text-transform:uppercase;letter-spacing:.5px';
      count.textContent = listings.length + ' listing';
      banner.appendChild(count);

      var condShort = { 'Mint':'MT','Near Mint':'NM','Excellent':'EX','Good':'GD','Light Played':'LP','Played':'PL','Poor':'PO','Unknown':'?' };
      var condColor = { 1:'#3fb950',2:'#3fb950',3:'#a8f0a8',4:'#d29922',5:'#f0883e',6:'#f47068',7:'#f47068' };

      // Mostra prime 7 offerte come chip cliccabili
      listings.slice(0, 7).forEach(function (l, i) {
        var chip = document.createElement('span');
        var color = condColor[l.condRank] || '#8b949e';
        chip.style.cssText = [
          'padding:4px 10px','border-radius:5px','font-weight:600',
          'font-family:monospace','cursor:pointer',
          'border:1px solid ' + color,
          'background:' + (i === 0 ? color : 'rgba(88,166,255,.06)'),
          'color:' + (i === 0 ? '#0d1117' : '#e6edf3'),
          'display:inline-flex','align-items:center','gap:6px'
        ].join(';');
        var cs = condShort[l.condition] || '?';
        chip.innerHTML = '<span style="font-size:10px;opacity:.85">' + cs + '</span>'
                      + '<span>€' + l.price.toFixed(2) + '</span>';
        chip.title = 'Clicca per inviare SOLO questo prezzo a RareBlock';
        chip.onclick = function () {
          sendPayload({
            type: 'rareblock_cm_prices',
            prices: [l.price],
            listings: [l],
            url: location.href,
            timestamp: Date.now(),
            single: true
          });
          chip.style.background = '#3fb950';
          chip.style.color = '#0d1117';
          chip.style.borderColor = '#3fb950';
          setTimeout(function () { try { window.close(); } catch (e) {} }, 400);
        };
        banner.appendChild(chip);
      });

      var status = document.createElement('span');
      status.style.cssText = 'margin-left:auto;font-size:11px;color:#3fb950';
      if (sent.sentOpener || sent.sentBroadcast) {
        status.textContent = '✓ Inviati a RareBlock (' +
          (sent.sentOpener ? 'opener' : '') +
          (sent.sentOpener && sent.sentBroadcast ? ' + ' : '') +
          (sent.sentBroadcast ? 'broadcast' : '') +
          ') — chiusura automatica…';
        // Retry close: Chrome a volte blocca il primo tentativo
        var n = 0, t = setInterval(function () {
          try { window.close(); } catch (e) {}
          if (++n >= 6) clearInterval(t);
        }, 300);
      } else {
        status.style.color = '#f85149';
        status.textContent = '⚠ RareBlock non raggiungibile — clicca un chip per provare invio manuale';
      }
      banner.appendChild(status);
    } else {
      var noPrice = document.createElement('span');
      noPrice.style.color = '#f85149';
      noPrice.style.marginLeft = '4px';
      noPrice.textContent = 'Nessuna offerta trovata su questa pagina';
      banner.appendChild(noPrice);

      var status2 = document.createElement('span');
      status2.style.cssText = 'margin-left:auto;font-size:11px;color:#7d8590';
      status2.textContent = sent.sentOpener || sent.sentBroadcast
        ? '✓ Notificato RareBlock'
        : '⚠ RareBlock non raggiungibile';
      banner.appendChild(status2);
    }

    // Close button
    var closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:#7d8590;cursor:pointer;font-size:16px;padding:0 4px;margin-left:8px';
    closeBtn.textContent = '✕';
    closeBtn.onclick = function () { banner.remove(); };
    banner.appendChild(closeBtn);

    document.body.insertBefore(banner, document.body.firstChild);
    // Padding per non coprire il contenuto
    document.body.style.paddingTop = (banner.offsetHeight + 4) + 'px';
  }

  // ── Main init con retry ──────────────────────────────────────────────────────
  var MAX_ATTEMPTS = 25;
  var ATTEMPT_DELAY_MS = 500;

  function init(attempt) {
    attempt = attempt || 0;
    var listings = scrapeListings().filter(function (l) { return l.price >= 0.5; });

    if (!listings.length && attempt < MAX_ATTEMPTS) {
      setTimeout(function () { init(attempt + 1); }, ATTEMPT_DELAY_MS);
      return;
    }

    if (listings.length) {
      console.log('[RareBlock] ' + listings.length + ' listing trovati:',
        listings.slice(0, 3).map(function (l) { return l.condition + ' €' + l.price; }));
      var sent = sendPrices(listings);
      injectBanner(listings, sent);
    } else {
      // Dopo MAX_ATTEMPTS senza prezzi: notifica comunque il main app per sbloccare il timeout
      console.log('[RareBlock] nessun listing trovato dopo ' + MAX_ATTEMPTS + ' tentativi');
      var sent2 = sendNoPrices('no_listings_after_' + MAX_ATTEMPTS + '_attempts');
      injectBanner([], sent2);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(init, 800);
  } else {
    window.addEventListener('load', function () { setTimeout(init, 800); });
  }
})();
