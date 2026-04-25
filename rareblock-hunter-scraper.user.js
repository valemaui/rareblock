// ==UserScript==
// @name         RareBlock Hunter Scraper
// @namespace    https://www.rareblock.eu
// @version      1.1
// @description  Raccoglie inserzioni da eBay, Subito, Vinted, Catawiki e le invia al backend RareBlock Hunter (v1.1: supporto modalità scan-assisted con postMessage)
// @author       RareBlock
// @match        https://www.ebay.it/sch/*
// @match        https://www.ebay.com/sch/*
// @match        https://www.subito.it/annunci*
// @match        https://www.vinted.it/catalog*
// @match        https://www.catawiki.com/*/s*
// @match        https://www.catawiki.com/*/s/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      rbjaaeyjeeqfpbzyavag.supabase.co
// @run-at       document-idle
// ==/UserScript==

(function(){
  'use strict';

  var SUPA_URL = 'https://rbjaaeyjeeqfpbzyavag.supabase.co';
  var ENDPOINT = SUPA_URL + '/functions/v1/hunt-ingest';

  // ── Config: il token JWT utente deve essere salvato in localStorage
  //    dall'app principale (pokemon-db.html) dopo il login.
  //    Chiave: rbJWT
  function getToken(){
    try{ return localStorage.getItem('rbJWT') || GM_getValue('rbJWT', null); }
    catch(e){ return null; }
  }

  function parsePrice(s){
    if(!s) return null;
    var c = String(s).replace(/[€\s$£]/g,'').trim();
    // 1.234,56 → 1234.56
    if(/^\d{1,3}(\.\d{3})+,\d{2}$/.test(c)) return parseFloat(c.replace(/\./g,'').replace(',','.'));
    // 1,234.56 (EN)
    if(/^\d{1,3}(,\d{3})+\.\d{2}$/.test(c)) return parseFloat(c.replace(/,/g,''));
    // 19,99
    if(/^\d+,\d{2}$/.test(c)) return parseFloat(c.replace(',','.'));
    var n = parseFloat(c.replace(',','.'));
    return isNaN(n) || n <= 0 ? null : n;
  }

  // ═══════ PARSER eBay ═══════
  function scrapeEbay(){
    var items = [];
    var rows = document.querySelectorAll('li.s-item, .srp-results li');
    rows.forEach(function(row){
      var linkEl = row.querySelector('a.s-item__link, a[href*="/itm/"]');
      if(!linkEl) return;
      var url = linkEl.href;
      var idMatch = url.match(/\/itm\/(?:[^\/]+\/)?(\d{8,15})/);
      var externalId = idMatch ? idMatch[1] : null;
      if(!externalId) return;

      var title = (row.querySelector('.s-item__title, h3.s-item__title')||{}).textContent || '';
      if(!title || /Shop on eBay|Risultati corrispondenti/i.test(title)) return;

      var priceEl = row.querySelector('.s-item__price, .s-card__price');
      var price = parsePrice(priceEl ? priceEl.textContent : '');

      var shipEl = row.querySelector('.s-item__shipping, .s-item__logisticsCost');
      var ship = parsePrice(shipEl ? shipEl.textContent : '');

      var img = (row.querySelector('img.s-item__image-img, .s-item__image img')||{}).src || null;

      // Tipo: se c'è "bids" è asta
      var bidsEl = row.querySelector('.s-item__bids, .s-item__bidCount');
      var bidCount = bidsEl ? parseInt((bidsEl.textContent.match(/\d+/)||['0'])[0]) : null;
      var type = bidsEl ? 'auction' : 'fixed';

      // Time left
      var timeEl = row.querySelector('.s-item__time-left, .s-item__time-end');
      var timeLeft = timeEl ? timeEl.textContent.trim() : null;
      var endsAt = parseEbayTimeLeft(timeLeft);

      var sellerEl = row.querySelector('.s-item__seller-info-text');
      var sellerText = sellerEl ? sellerEl.textContent : '';
      var fbMatch = sellerText.match(/(\d+[\.,]?\d*)\s*%/);
      var rating = fbMatch ? parseFloat(fbMatch[1].replace(',','.')) : null;
      var fbCountMatch = sellerText.match(/\((\d+)\)/);
      var fbCount = fbCountMatch ? parseInt(fbCountMatch[1]) : null;

      items.push({
        platform: 'ebay',
        listing_url: url.split('?')[0],
        external_id: externalId,
        title: title.trim(),
        price: price,
        shipping_cost: ship,
        currency: 'EUR',
        listing_type: type,
        bid_count: bidCount,
        auction_ends_at: endsAt,
        seller_rating: rating,
        seller_feedbacks: fbCount,
        image_url: img
      });
    });
    return items;
  }

  function parseEbayTimeLeft(s){
    if(!s) return null;
    // "Termina tra 2g 5h", "3h 12min left"
    var m = s.match(/(\d+)\s*g(?:iorn)?/i);
    var h = s.match(/(\d+)\s*h/i);
    var min = s.match(/(\d+)\s*min/i);
    if(!m && !h && !min) return null;
    var total = 0;
    if(m) total += parseInt(m[1]) * 86400000;
    if(h) total += parseInt(h[1]) * 3600000;
    if(min) total += parseInt(min[1]) * 60000;
    return new Date(Date.now() + total).toISOString();
  }

  // ═══════ PARSER Subito ═══════
  function scrapeSubito(){
    var items = [];
    var rows = document.querySelectorAll('[class*="items-list"] > div, [class*="ItemsList"] article');
    rows.forEach(function(row){
      var linkEl = row.querySelector('a[href*="/annunci/"], a[href*="/vendita/"]');
      if(!linkEl) return;
      var url = linkEl.href;
      var idMatch = url.match(/-(\d{7,12})\.htm/);
      var externalId = idMatch ? idMatch[1] : url;

      var title = (row.querySelector('h2, [class*="ItemTitle"]')||{}).textContent || '';
      var priceEl = row.querySelector('[class*="price"], [class*="Price"]');
      var price = parsePrice(priceEl ? priceEl.textContent : '');
      var img = (row.querySelector('img')||{}).src || null;
      var locEl = row.querySelector('[class*="town"], [class*="Location"]');

      if(title && price){
        items.push({
          platform: 'subito',
          listing_url: url,
          external_id: externalId,
          title: title.trim(),
          price: price,
          currency: 'EUR',
          listing_type: 'fixed',
          image_url: img,
          seller_country: locEl ? locEl.textContent.trim() : null
        });
      }
    });
    return items;
  }

  // ═══════ PARSER Vinted ═══════
  function scrapeVinted(){
    var items = [];
    var rows = document.querySelectorAll('[data-testid*="product-item"], .feed-grid > div');
    rows.forEach(function(row){
      var linkEl = row.querySelector('a[href*="/items/"]');
      if(!linkEl) return;
      var url = linkEl.href;
      var idMatch = url.match(/\/items\/(\d+)/);
      var externalId = idMatch ? idMatch[1] : null;
      if(!externalId) return;

      var title = (row.querySelector('[data-testid*="title"], h2')||{}).textContent
               || (row.querySelector('img')||{}).alt || '';
      var priceEl = row.querySelector('[data-testid*="price"], [class*="price"]');
      var price = parsePrice(priceEl ? priceEl.textContent : '');
      var img = (row.querySelector('img')||{}).src || null;

      if(title && price){
        items.push({
          platform: 'vinted',
          listing_url: url.split('?')[0],
          external_id: externalId,
          title: title.trim(),
          price: price,
          currency: 'EUR',
          listing_type: 'fixed',
          image_url: img
        });
      }
    });
    return items;
  }

  // ═══════ PARSER Catawiki ═══════
  function scrapeCatawiki(){
    var items = [];
    // Selettori più robusti per Catawiki (cambia spesso classnames)
    var rows = document.querySelectorAll('[data-testid*="lot-card"], article[class*="lot"], [class*="LotCard"], a[href*="/l/"][class*="card"]');
    if(!rows.length){
      // Fallback: tutti gli anchor che puntano a /l/
      rows = document.querySelectorAll('a[href*="/l/"]');
    }
    var processed = {};
    rows.forEach(function(row){
      // Se il selector ha matchato direttamente l'anchor, usa quello
      var linkEl = (row.tagName === 'A') ? row : row.querySelector('a[href*="/l/"]');
      if(!linkEl) return;
      var url = linkEl.href;
      if(processed[url]) return;
      processed[url] = true;
      var idMatch = url.match(/\/l\/([^\/\?#]+)/);
      var externalId = idMatch ? idMatch[1] : null;
      if(!externalId) return;

      // Risali al container "card" se siamo partiti dall'anchor
      var card = (row.tagName === 'A') ? (row.closest('article, [data-testid], [class*="LotCard"], li, div[class*="card"]') || row) : row;

      var titleEl = card.querySelector('h3, h2, [class*="title"], [data-testid*="title"]');
      var title = titleEl ? titleEl.textContent.trim() : (linkEl.textContent || '').trim();

      var priceEl = card.querySelector('[class*="bid"], [class*="price"], [data-testid*="bid"], [data-testid*="price"]');
      var price = parsePrice(priceEl ? priceEl.textContent : '');

      var imgEl = card.querySelector('img');
      var img = imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || imgEl.getAttribute('srcset')||'').split(' ')[0] : null;

      var endEl = card.querySelector('[class*="time-left"], [class*="countdown"], [class*="ends"], time');
      var endsAt = endEl ? parseCatawikiCountdown(endEl.textContent) : null;

      if(title){
        items.push({
          platform: 'catawiki',
          listing_url: url.split('?')[0].split('#')[0],
          external_id: externalId,
          title: title.slice(0, 300),
          price: price,
          currency: 'EUR',
          listing_type: 'auction',
          auction_ends_at: endsAt,
          image_url: img
        });
      }
    });
    return items;
  }

  function parseCatawikiCountdown(s){
    if(!s) return null;
    // "Ends in 2d 5h" / "Termina in 1g 12h" / "5h 30m"
    var m = s.match(/(\d+)\s*(g|d|day|giorno|giorni)/i);
    var h = s.match(/(\d+)\s*h/i);
    var min = s.match(/(\d+)\s*m\b/i);
    if(!m && !h && !min) return null;
    var ms = 0;
    if(m) ms += parseInt(m[1]) * 86400000;
    if(h) ms += parseInt(h[1]) * 3600000;
    if(min) ms += parseInt(min[1]) * 60000;
    if(ms === 0) return null;
    return new Date(Date.now() + ms).toISOString();
  }

  // ═══════ ROUTER ═══════
  function detectAndScrape(){
    var host = location.host;
    if(/ebay\.(it|com)/.test(host))   return {platform:'ebay',     items:scrapeEbay()};
    if(/subito\.it/.test(host))       return {platform:'subito',   items:scrapeSubito()};
    if(/vinted\.it/.test(host))       return {platform:'vinted',   items:scrapeVinted()};
    if(/catawiki\.com/.test(host))    return {platform:'catawiki', items:scrapeCatawiki()};
    return null;
  }

  // ═══════ INVIA AL BACKEND ═══════
  function sendToBackend(items){
    var token = getToken();
    if(!token){
      console.warn('[RB Hunter] Nessun JWT — apri prima RareBlock loggato e salva il token.');
      showBanner(items.length+' inserzioni trovate — ACCEDI a RareBlock per inviarle', 'warn');
      return;
    }
    GM_xmlhttpRequest({
      method: 'POST',
      url: ENDPOINT,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      data: JSON.stringify({ source_url: location.href, listings: items }),
      onload: function(r){
        if(r.status>=200 && r.status<300){
          showBanner('✅ '+items.length+' inserzioni inviate a RareBlock', 'ok');
        } else {
          showBanner('❌ Errore '+r.status+': '+r.responseText.slice(0,120), 'err');
        }
      },
      onerror: function(e){ showBanner('❌ Errore rete', 'err'); }
    });
  }

  function showBanner(msg, kind){
    var b = document.createElement('div');
    b.textContent = msg;
    var color = kind==='ok' ? '#00c853' : (kind==='warn' ? '#ff9500' : '#ff4444');
    b.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:'+color+';color:#fff;padding:10px 16px;border-radius:8px;font:13px system-ui;box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:360px';
    document.body.appendChild(b);
    setTimeout(function(){ b.remove(); }, 5000);
  }

  function addFloatingButton(count){
    var btn = document.createElement('button');
    btn.id = 'rb-hunt-btn';
    btn.textContent = '🎯 Invia '+count+' a RareBlock';
    btn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99998;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;padding:12px 18px;border-radius:999px;font:600 13px system-ui;cursor:pointer;box-shadow:0 6px 20px rgba(99,102,241,.5)';
    btn.onclick = function(){
      var res = detectAndScrape();
      if(!res || !res.items.length){ showBanner('Nessuna inserzione rilevata', 'warn'); return; }
      sendToBackend(res.items);
    };
    document.body.appendChild(btn);
  }

  // Avvio: aspetta caricamento
  function init(){
    var res = detectAndScrape();
    if(!res || !res.items || !res.items.length){
      // Riprova ancora dopo 3 secondi (lazy loading)
      setTimeout(function(){
        var r2 = detectAndScrape();
        if(r2 && r2.items && r2.items.length) handleScrapedItems(r2);
      }, 3000);
      return;
    }
    handleScrapedItems(res);
  }

  function handleScrapedItems(res){
    console.log('[RB Hunter] '+res.platform+' — '+res.items.length+' inserzioni trovate');

    // ── Modalità ASSIST: scan triggerato dal main app via #rbScan=jobId ──
    // Posta i risultati a window.opener tramite postMessage (no backend roundtrip)
    var hash = location.hash || '';
    var jobMatch = hash.match(/[#&]rbScan=([^&]+)/);
    if(jobMatch && window.opener && !window.opener.closed){
      try{
        var jobId = decodeURIComponent(jobMatch[1]);
        // Invia a tutti gli origin RareBlock noti (claude.ai per dev, rareblock.eu per prod)
        var payload = {
          type: 'rbScanResult',
          jobId: jobId,
          platform: res.platform,
          source_url: location.href,
          items: res.items
        };
        try{ window.opener.postMessage(payload, '*'); }
        catch(_){ /* alcune CSP restrictive bloccano postMessage */ }
        showBanner('🔄 '+res.items.length+' inserzioni inviate al main RareBlock', 'ok');
        // Chiudi automaticamente dopo 4s (utile per scheduled scans)
        setTimeout(function(){ try{ window.close(); }catch(_){} }, 4000);
        return;
      }catch(e){ console.warn('[RB Hunter] assist mode error:', e); }
    }

    // ── Modalità normale: pulsante invia-a-backend ───────────────────────
    addFloatingButton(res.items.length);
  }

  if(document.readyState === 'complete') setTimeout(init, 1500);
  else window.addEventListener('load', function(){ setTimeout(init, 1500); });
})();
