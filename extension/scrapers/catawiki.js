// Scraper Catawiki — versione 2 con field mapping verificato
//
// Schema reale dei lots in __NEXT_DATA__ / API JSON Catawiki (verificato Apr 2026):
//   id, title, subtitle
//   thumbImageUrl, originalImageUrl
//   url (relativo, /it/l/<id>-...)
//   auctionId, biddingStartTime, biddingEndTime, expiresAt, closingAt
//   biddingHistory: [{amount, currency_code, ...}, ...]   (l'ultimo è il bid corrente)
//   currentBid: {amount, currency_code} (alcune varianti)
//   buyNow: number|null
//   reservePriceSet: bool
//   favoriteCount, isContentExplicit
//
// La funzione viene serializzata via toString() per executeScript: tutto inline.

export async function scrapeCatawiki(job) {

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── Helper: parsing prezzo da stringa visibile (€ 1.234,56) ─────────
  function parsePriceText(s) {
    if (!s) return null;
    var c = String(s).replace(/[€\s$£EURURO]/gi, '').trim();
    if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(c)) return parseFloat(c.replace(/\./g, '').replace(',', '.'));
    if (/^\d{1,3}(,\d{3})+\.\d{2}$/.test(c)) return parseFloat(c.replace(/,/g, ''));
    if (/^\d+,\d{2}$/.test(c)) return parseFloat(c.replace(',', '.'));
    var n = parseFloat(c.replace(',', '.'));
    return isFinite(n) && n > 0 ? n : null;
  }

  // ── Helper: estrai prezzo dal lot JSON con tutti i fallback noti ────
  function extractPriceFromLot(lot) {
    var price = null;
    var currency = 'EUR';
    if (!lot) return { price: null, currency: currency };

    // 1. live.bid: il path più affidabile per lots IN CORSO (real-time)
    //    Es: lot.live = { bid: { EUR: 50, USD: 54, GBP: 42 } }
    if (lot.live && lot.live.bid && typeof lot.live.bid === 'object') {
      // Preferiamo EUR, fallback a USD, GBP, qualsiasi altro numero
      if (typeof lot.live.bid.EUR === 'number') { price = lot.live.bid.EUR; currency = 'EUR'; }
      else if (typeof lot.live.bid.USD === 'number') { price = lot.live.bid.USD; currency = 'USD'; }
      else if (typeof lot.live.bid.GBP === 'number') { price = lot.live.bid.GBP; currency = 'GBP'; }
      else {
        var keys = Object.keys(lot.live.bid);
        for (var i = 0; i < keys.length; i++) {
          if (typeof lot.live.bid[keys[i]] === 'number') {
            price = lot.live.bid[keys[i]];
            currency = keys[i];
            break;
          }
        }
      }
    }

    // 2. biddingHistory: l'ultimo elemento è il bid più recente (più alto)
    if (price === null && Array.isArray(lot.biddingHistory) && lot.biddingHistory.length) {
      var last = lot.biddingHistory[lot.biddingHistory.length - 1];
      if (last && typeof last.amount === 'number') {
        price = last.amount;
        if (last.currency_code) currency = last.currency_code;
      }
    }
    // 3. bidding_history (snake_case alt)
    if (price === null && Array.isArray(lot.bidding_history) && lot.bidding_history.length) {
      var last2 = lot.bidding_history[lot.bidding_history.length - 1];
      if (last2 && typeof last2.amount === 'number') {
        price = last2.amount;
        if (last2.currency_code) currency = last2.currency_code;
      }
    }
    // 4. currentBid object
    if (price === null && lot.currentBid && typeof lot.currentBid === 'object') {
      if (typeof lot.currentBid.amount === 'number') {
        price = lot.currentBid.amount;
        if (lot.currentBid.currency_code) currency = lot.currentBid.currency_code;
        else if (lot.currentBid.currency) currency = lot.currentBid.currency;
      }
    }
    // 5. current_bid object snake_case
    if (price === null && lot.current_bid && typeof lot.current_bid === 'object') {
      if (typeof lot.current_bid.amount === 'number') {
        price = lot.current_bid.amount;
        if (lot.current_bid.currency_code) currency = lot.current_bid.currency_code;
        else if (lot.current_bid.currency) currency = lot.current_bid.currency;
      }
    }
    // 6. minimum_bid / starting_bid (per lots senza offerte ancora)
    if (price === null) {
      var mbid = lot.minimumBid || lot.minimum_bid || lot.startingBid || lot.starting_bid;
      if (mbid && typeof mbid === 'object' && typeof mbid.amount === 'number') {
        price = mbid.amount;
        if (mbid.currency_code) currency = mbid.currency_code;
        else if (mbid.currency) currency = mbid.currency;
      } else if (typeof mbid === 'number') {
        price = mbid;
      }
    }
    // 7. buyNow (compra subito) — se non c'è altro
    if (price === null && typeof lot.buyNow === 'number') price = lot.buyNow;
    if (price === null && lot.buyNow && typeof lot.buyNow === 'object' && typeof lot.buyNow.amount === 'number') {
      price = lot.buyNow.amount;
      if (lot.buyNow.currency_code) currency = lot.buyNow.currency_code;
    }
    // 8. price plain
    if (price === null && typeof lot.price === 'number') price = lot.price;
    if (price === null && lot.price && typeof lot.price === 'object' && typeof lot.price.amount === 'number') {
      price = lot.price.amount;
      if (lot.price.currency_code) currency = lot.price.currency_code;
    }

    return { price: price, currency: currency || 'EUR' };
  }

  // ── Fallback ricorsivo: scan generico di tutti i campi numerici che ──
  // potrebbero rappresentare un prezzo (Catawiki cambia spesso schema).
  // Strategia: traccia il massimo valore PER currency, poi preferisce
  // EUR > USD > GBP > prima trovata (max valori delle stesse unità =
  // offerta corrente più alta = quella che vediamo sul sito).
  function extractPriceFromLotDeep(lot) {
    if (!lot || typeof lot !== 'object') return { price: null, currency: 'EUR' };
    var byCurrency = {};   // { EUR: maxAmount, USD: maxAmount, ... }
    var keyRe = /^(bid|price|amount|value|current|live|highest|leading|reserve|buy_?now|min(?:imum)?_?bid|start(?:ing)?_?bid)$/i;
    var skipRe = /^(buyer_?fee|shipping|tax|vat|commission|fee)$/i;

    function record(value, currency) {
      if (!isFinite(value) || value <= 0 || value >= 10000000) return;
      var v = value > 100000 ? value / 100 : value;
      var c = currency || 'EUR';
      if (byCurrency[c] === undefined || v > byCurrency[c]) {
        byCurrency[c] = v;
      }
    }

    function walk(node, parentKeyMatched, currCurrency) {
      if (node === null || node === undefined) return;
      if (typeof node === 'number') {
        if (parentKeyMatched) record(node, currCurrency);
        return;
      }
      if (typeof node !== 'object') return;
      var ccy = currCurrency;
      if (typeof node.currency_code === 'string') ccy = node.currency_code;
      else if (typeof node.currency === 'string') ccy = node.currency;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], parentKeyMatched, ccy);
        return;
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (skipRe.test(key)) continue;
        var matched = parentKeyMatched || keyRe.test(key);
        // chiavi tipo EUR/USD/GBP indicano una currency value diretta
        if (parentKeyMatched && /^[A-Z]{3}$/.test(key)) {
          walk(node[key], true, key);
        } else {
          walk(node[key], matched, ccy);
        }
      }
    }
    walk(lot, false, 'EUR');
    // Priorità: EUR > USD > GBP > prima trovata
    var preferOrder = ['EUR', 'USD', 'GBP'];
    for (var i = 0; i < preferOrder.length; i++) {
      if (byCurrency[preferOrder[i]] !== undefined) {
        return { price: byCurrency[preferOrder[i]], currency: preferOrder[i] };
      }
    }
    var firstK = Object.keys(byCurrency)[0];
    if (firstK) return { price: byCurrency[firstK], currency: firstK };
    return { price: null, currency: 'EUR' };
  }

  // ── Helper: estrai end_time dal lot JSON ────────────────────────────
  function extractEndTimeFromLot(lot) {
    if (!lot) return null;
    var candidates = [
      'expiresAt', 'expires_at',
      'closingAt', 'closing_at',
      'biddingEndTime', 'bidding_end_time',
      'endTime', 'end_time',
      'endsAt', 'ends_at',
    ];
    for (var i = 0; i < candidates.length; i++) {
      var k = candidates[i];
      if (lot[k]) {
        // Già ISO string?
        if (typeof lot[k] === 'string') return lot[k];
        if (typeof lot[k] === 'number') {
          // timestamp seconds o millis?
          var ms = lot[k] > 1e12 ? lot[k] : lot[k] * 1000;
          return new Date(ms).toISOString();
        }
      }
    }
    return null;
  }

  // ── Helper: estrai immagine dal lot JSON ────────────────────────────
  function extractImageFromLot(lot) {
    if (!lot) return null;
    // Catawiki mette spesso originalImageUrl + thumbImageUrl. Preferiamo thumb (più
    // veloce da caricare e basta come preview).
    if (typeof lot.thumbImageUrl === 'string') return lot.thumbImageUrl;
    if (typeof lot.thumb_image_url === 'string') return lot.thumb_image_url;
    if (typeof lot.originalImageUrl === 'string') return lot.originalImageUrl;
    if (typeof lot.original_image_url === 'string') return lot.original_image_url;
    if (typeof lot.imageUrl === 'string') return lot.imageUrl;
    if (typeof lot.image_url === 'string') return lot.image_url;
    if (typeof lot.image === 'string') return lot.image;
    if (lot.image && typeof lot.image === 'object') {
      return lot.image.url || lot.image.large || lot.image.thumb || lot.image.src || null;
    }
    if (Array.isArray(lot.images) && lot.images.length) {
      var first = lot.images[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object') {
        return first.url || first.large || first.thumbImageUrl || first.thumb || first.src || null;
      }
    }
    return null;
  }

  // ── Trova ricorsivamente l'array dei lots in qualsiasi nodo JSON ────
  function findLotsInJson(node, depth) {
    depth = depth || 0;
    if (!node || depth > 14) return null;
    if (Array.isArray(node)) {
      // Heuristic: array di oggetti con id+title+(url|originalImageUrl|thumbImageUrl)
      if (node.length && node[0] && typeof node[0] === 'object') {
        var first = node[0];
        var hasIdent = first.id && (first.title || first.name);
        var hasShape = first.url || first.thumbImageUrl || first.originalImageUrl
                    || first.image || first.images || first.biddingHistory
                    || first.biddingStartTime || first.auctionId;
        if (hasIdent && hasShape) return node;
      }
      for (var i = 0; i < node.length; i++) {
        var r = findLotsInJson(node[i], depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof node === 'object') {
      // Chiavi note dirette
      var preferredKeys = ['lots', 'results', 'searchResults', 'items', 'products', 'hits', 'data'];
      for (var k = 0; k < preferredKeys.length; k++) {
        var arr = node[preferredKeys[k]];
        if (Array.isArray(arr) && arr.length && arr[0] && (arr[0].id || arr[0].title)) {
          var c = findLotsInJson(arr, depth + 1);
          if (c) return c;
        }
      }
      var vals = Object.values(node);
      for (var v = 0; v < vals.length; v++) {
        var r2 = findLotsInJson(vals[v], depth + 1);
        if (r2) return r2;
      }
    }
    return null;
  }

  // ── STRATEGIA 1: __NEXT_DATA__ con i nuovi field name ────────────────
  function tryNextData() {
    var nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return null;
    try {
      var data = JSON.parse(nd.textContent);
      var lots = findLotsInJson(data);
      if (!lots || !lots.length) return null;
      return lots.map(function (lot) {
        var u = lot.url || lot.web_url || (lot.id ? '/it/l/' + lot.id : null) || (lot.slug ? '/it/l/' + lot.slug : null);
        if (!u) return null;
        var fullUrl = u.indexOf('http') === 0 ? u : ('https://www.catawiki.com' + u);

        // lot_id robusto: prova lot.id → lot.lot_id → estrai da URL
        var lotId = null;
        if (lot.id) lotId = String(lot.id);
        else if (lot.lot_id) lotId = String(lot.lot_id);
        else {
          var idMatch = fullUrl.match(/\/l\/([0-9]+)(?:[\-\/?#]|$)/);
          if (idMatch) lotId = idMatch[1];
        }

        var pp = extractPriceFromLot(lot);
        var image = extractImageFromLot(lot);
        var endT = extractEndTimeFromLot(lot);

        return {
          title: String(lot.title || lot.name || '').slice(0, 300),
          subtitle: String(lot.subtitle || '').slice(0, 200),
          price: pp.price,
          currency: pp.currency,
          image_url: image,
          url: fullUrl.split('?')[0].split('#')[0],
          end_time: endT,
          location: (lot.seller && (lot.seller.country_code || lot.seller.country)) || null,
          seller: (lot.seller && (lot.seller.shop_name || lot.seller.name)) || null,
          is_auction: true,
          source: 'catawiki',
          lot_id: lotId,
          bids: Array.isArray(lot.biddingHistory) ? lot.biddingHistory.length :
                (Array.isArray(lot.bidding_history) ? lot.bidding_history.length : null),
          shipping: null,
          favorite_count: typeof lot.favoriteCount === 'number' ? lot.favoriteCount : null,
        };
      }).filter(Boolean);
    } catch (e) {
      console.warn('[RB Catawiki] NEXT_DATA parse:', e);
      return null;
    }
  }

  // ── DOM helpers per fallback strategy ───────────────────────────────
  function pickFromSrcset(srcset) {
    if (!srcset) return null;
    var parts = srcset.split(',').map(function (s) { return s.trim(); });
    if (!parts.length) return null;
    var last = parts[parts.length - 1];
    return last.split(/\s+/)[0] || null;
  }

  function isValidImageUrl(u) {
    if (!u) return false;
    if (u.indexOf('data:image/') === 0 && u.length < 200) return false;
    if (u.indexOf('blank.') >= 0 || u.indexOf('placeholder') >= 0) return false;
    if (/^data:image\/svg\+xml/.test(u)) return false;
    return /^https?:\/\//.test(u) || u.indexOf('//') === 0;
  }

  function extractImageUrlDom(card) {
    if (!card) return null;
    var picture = card.querySelector('picture');
    if (picture) {
      var sources = picture.querySelectorAll('source');
      for (var i = 0; i < sources.length; i++) {
        var ss = sources[i].getAttribute('srcset') || sources[i].getAttribute('data-srcset');
        var u = pickFromSrcset(ss);
        if (isValidImageUrl(u)) return u.indexOf('//') === 0 ? 'https:' + u : u;
      }
    }
    var imgs = card.querySelectorAll('img');
    for (var j = 0; j < imgs.length; j++) {
      var imgEl = imgs[j];
      var attrs = ['data-src', 'data-lazy-src', 'data-original', 'data-defer-src'];
      for (var k = 0; k < attrs.length; k++) {
        var v = imgEl.getAttribute(attrs[k]);
        if (isValidImageUrl(v)) return v.indexOf('//') === 0 ? 'https:' + v : v;
      }
      if (imgEl.currentSrc && isValidImageUrl(imgEl.currentSrc)) return imgEl.currentSrc;
      var ss2 = imgEl.getAttribute('srcset') || imgEl.getAttribute('data-srcset');
      var fromSs = pickFromSrcset(ss2);
      if (isValidImageUrl(fromSs)) return fromSs.indexOf('//') === 0 ? 'https:' + fromSs : fromSs;
      if (isValidImageUrl(imgEl.src)) return imgEl.src;
    }
    return null;
  }

  function triggerLazyLoad() {
    try {
      window.scrollTo(0, document.body.scrollHeight);
      window.scrollTo(0, 0);
      document.querySelectorAll('img[data-src]').forEach(function (img) {
        var ds = img.getAttribute('data-src');
        if (ds) { try { img.src = ds; } catch (_) {} }
      });
      document.querySelectorAll('img[loading="lazy"]').forEach(function (img) {
        try { img.loading = 'eager'; } catch (_) {}
      });
    } catch (_) {}
  }

  async function ensureImagesLoaded(maxWaitMs) {
    triggerLazyLoad();
    await sleep(300);
    triggerLazyLoad();
    var deadline = Date.now() + (maxWaitMs || 4000);
    while (Date.now() < deadline) {
      var pending = Array.from(document.querySelectorAll('img')).filter(function (img) {
        if (img.naturalWidth > 0) return false;
        if (!img.src && !img.getAttribute('data-src')) return false;
        return true;
      });
      if (pending.length === 0) break;
      pending.forEach(function (img) {
        var ds = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (ds && img.src !== ds) { try { img.src = ds; } catch (_) {} }
      });
      await sleep(250);
    }
  }

  function parseCountdownText(s) {
    if (!s) return null;
    var d = s.match(/(\d+)\s*(g|d|day|giorni|giorno)/i);
    var h = s.match(/(\d+)\s*h/i);
    var min = s.match(/(\d+)\s*m\b/i);
    if (!d && !h && !min) return null;
    var ms = 0;
    if (d) ms += parseInt(d[1]) * 86400000;
    if (h) ms += parseInt(h[1]) * 3600000;
    if (min) ms += parseInt(min[1]) * 60000;
    return ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
  }

  // ── STRATEGIA 2: DOM scrape ─────────────────────────────────────────
  function tryDom() {
    var items = [];
    var processed = {};
    var rows = document.querySelectorAll('[data-testid*="lot-card"], article[class*="lot"], [class*="LotCard"]');
    if (!rows.length) rows = document.querySelectorAll('a[href*="/l/"]');

    rows.forEach(function (row) {
      var linkEl = row.tagName === 'A' ? row : row.querySelector('a[href*="/l/"]');
      if (!linkEl) return;
      var url = linkEl.href;
      if (processed[url]) return;
      processed[url] = true;
      // Estrai lot_id NUMERICO dall'URL (es. /it/l/12345-charizard → "12345")
      // Lo slug puro non funziona per l'API enrichment.
      var idMatch = url.match(/\/l\/([0-9]+)(?:[\-\/?#]|$)/);
      var lotId = idMatch ? idMatch[1] : null;

      var card = row.tagName === 'A'
        ? (row.closest('article, [data-testid], [class*="LotCard"], li, div[class*="card"]') || row)
        : row;

      var titleEl = card.querySelector('h3, h2, [class*="title"], [data-testid*="title"]');
      var title = titleEl ? titleEl.textContent.trim() : (linkEl.textContent || '').trim();
      if (!title) return;

      var priceEl = card.querySelector('[class*="bid"], [class*="price"], [data-testid*="bid"], [data-testid*="price"]');
      var price = parsePriceText(priceEl ? priceEl.textContent : '');

      var img = extractImageUrlDom(card);
      var endEl = card.querySelector('[class*="time-left"], [class*="countdown"], [class*="ends"], time');
      var endsAt = endEl ? parseCountdownText(endEl.textContent) : null;
      // Time element a volte ha datetime attribute direttamente ISO
      if (!endsAt && endEl && endEl.getAttribute) {
        var dtAttr = endEl.getAttribute('datetime');
        if (dtAttr) {
          var d = new Date(dtAttr);
          if (!isNaN(d.getTime())) endsAt = d.toISOString();
        }
      }

      items.push({
        title: title.slice(0, 300),
        price: price,
        currency: 'EUR',
        image_url: img,
        url: url.split('?')[0].split('#')[0],
        end_time: endsAt,
        location: null, seller: null,
        is_auction: true, source: 'catawiki',
        lot_id: lotId,
        bids: null, shipping: null,
      });
    });
    return items;
  }

  // ── STRATEGIA 3: enrichment via API per TUTTI i lots ────────────────
  // Catawiki spesso serializza nel NEXT_DATA della pagina di SEARCH una
  // versione "scarna" dei lot (senza prezzo o solo con minimum_bid). L'API
  // /buyer/api/v3/lots/<id> dal browser dell'utente (residenziale, niente CF)
  // è la sorgente canonica.
  //
  // Strategia: fetch in parallelo (concurrency 6, max 30) per ogni lot con
  // lot_id. Override price/end_time/image se l'API ritorna dati validi.
  // Per lots senza price NEMMENO dopo enrichment, prova extractPriceFromLotDeep
  // come ultima spiaggia.
  async function enrichMissing(items) {
    var withId = items.filter(function (it) { return it.lot_id; });
    if (!withId.length) return items;
    // Limita a 30 max per rispettare il sito (concurrency 6 = ~6 req/s)
    var batch = withId.slice(0, 30);
    var byId = {};
    items.forEach(function (it) { if (it.lot_id) byId[it.lot_id] = it; });

    async function fetchOne(id) {
      try {
        // v3 è il path canonico, fallback a v2 e a /it/api/v1 in ordine
        var endpoints = [
          'https://www.catawiki.com/buyer/api/v3/lots/' + encodeURIComponent(id),
          'https://www.catawiki.com/buyer/api/v2/lots/' + encodeURIComponent(id),
          'https://www.catawiki.com/it/api/v1/lots/' + encodeURIComponent(id),
        ];
        var lastStatus = null;
        for (var i = 0; i < endpoints.length; i++) {
          try {
            var r = await fetch(endpoints[i], {
              headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-Application-Type': 'web',
              },
              credentials: 'include',
            });
            lastStatus = r.status;
            // 403 (Akamai), 404 (lot rimosso), 410 (gone): tutti irrecuperabili.
            // Il lot è probabilmente CHIUSO / SCADUTO / RIMOSSO. Non perdere
            // tempo con gli altri endpoint, ritorna marker di stato così
            // chi chiama lo può loggare.
            if (r.status === 403 || r.status === 404 || r.status === 410) {
              return { __unavailable: true, __status: r.status };
            }
            if (!r.ok) continue;
            var data = await r.json();
            return data.lot || data.data || data;
          } catch (_) { /* prova endpoint successivo */ }
        }
        return lastStatus ? { __unavailable: true, __status: lastStatus } : null;
      } catch (e) { return null; }
    }
    async function runQueue(ids, concurrency) {
      var i = 0;
      var results = [];
      async function worker() {
        while (i < ids.length) {
          var idx = i++;
          var d = await fetchOne(ids[idx]);
          results[idx] = d;
        }
      }
      var workers = [];
      for (var w = 0; w < concurrency; w++) workers.push(worker());
      await Promise.all(workers);
      return results;
    }
    var ids = batch.map(function (it) { return it.lot_id; });
    var enriched = await runQueue(ids, 6);
    var enrichedCount = 0;
    var stillMissing = 0;
    var expiredCount = 0;
    enriched.forEach(function (lot, idx) {
      var origItem = byId[ids[idx]];
      if (!origItem) return;
      if (!lot) { stillMissing++; return; }
      // Lot rimosso/scaduto/chiuso → marca così l'UI può nasconderlo o
      // mostrare etichetta "non più disponibile"
      if (lot.__unavailable) {
        expiredCount++;
        origItem.is_unavailable = true;
        origItem.unavailable_status = lot.__status;
        return;
      }
      enrichedCount++;
      // Override (l'API è source of truth) — ma solo se ritorna valori validi
      var pp = extractPriceFromLot(lot);
      if (pp.price !== null) {
        origItem.price = pp.price;
        origItem.currency = pp.currency;
      } else {
        // Ultima spiaggia: scan ricorsivo deep
        var deep = extractPriceFromLotDeep(lot);
        if (deep.price !== null) {
          origItem.price = deep.price;
          origItem.currency = deep.currency;
        }
      }
      var et = extractEndTimeFromLot(lot);
      if (et) origItem.end_time = et;
      if (!origItem.image_url) {
        var img = extractImageFromLot(lot);
        if (img) origItem.image_url = img;
      }
      // Bids count se manca
      if (origItem.bids === null && Array.isArray(lot.biddingHistory)) {
        origItem.bids = lot.biddingHistory.length;
      }

      // Lot CHIUSO/TERMINATO: l'API ritorna ancora l'oggetto (è in catalogo
      // come storico), ma:
      //  - lot.status / lot.state contiene 'closed'/'ended'/'expired' ecc.
      //  - oppure end_time è già nel passato di >0
      // Catawiki rimuove l'URL pubblico dopo X giorni dalla chiusura → Akamai
      // 403. Marchiamo come unavailable per disabilitare il link "Apri" e il
      // monitoraggio.
      var statusStr = String(
        lot.status || lot.state || lot.lifecycle_state || lot.bidding_state || ''
      ).toLowerCase();
      var endedByStatus = /\b(closed|ended|expired|finished|sold|unsold|withdrawn|cancelled|removed)\b/.test(statusStr);
      var endedByTime = false;
      if (et) {
        try { endedByTime = (new Date(et).getTime() < Date.now() - 60000); } catch (_) {}
      }
      if (endedByStatus || endedByTime) {
        origItem.is_unavailable = true;
        origItem.unavailable_status = endedByStatus ? ('lot_'+statusStr) : 'ended_by_time';
        expiredCount++;
        // Salviamo comunque il prezzo (utile per storico) ma lockiamo monitor/open
      }
    });
    // Diagnostica in console: sempre visibile da DevTools della tab Catawiki
    var stats = {
      total: items.length,
      with_id: withId.length,
      api_fetched: enrichedCount,
      api_failed: stillMissing,
      api_unavailable: expiredCount,
      missing_price_after: items.filter(function(x){return x.price===null && !x.is_unavailable;}).length,
      missing_endtime_after: items.filter(function(x){return x.end_time===null && !x.is_unavailable;}).length,
    };
    try { console.log('[RB Catawiki Scraper] enrichment stats:', stats); } catch(_){}
    return items;
  }

  // ── DISPATCH: NEXT_DATA prima, poi DOM con lazy-load wait ───────────
  var fromJson = tryNextData();
  if (fromJson && fromJson.length) {
    // Arricchisci items con dati mancanti via API
    fromJson = await enrichMissing(fromJson);
    return fromJson;
  }

  await ensureImagesLoaded(4000);
  var domItems = tryDom();
  // Anche per items DOM proviamo enrichment se hanno lot_id
  if (domItems.length) {
    domItems = await enrichMissing(domItems);
  }
  return domItems;
}
