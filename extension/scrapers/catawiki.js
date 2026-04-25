// Scraper Catawiki — iniettato nella tab di catawiki.com via executeScript.
// IMPORTANTE: la funzione viene serializzata via toString(), quindi:
//   - niente closure su variabili esterne
//   - niente import dinamici
//   - tutti gli helper devono essere DENTRO la funzione
// La funzione è async: chrome.scripting.executeScript la awaitarà.

export async function scrapeCatawiki(job) {
  function parsePrice(s) {
    if (!s) return null;
    var c = String(s).replace(/[€\s$£]/g, '').trim();
    if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(c)) return parseFloat(c.replace(/\./g, '').replace(',', '.'));
    if (/^\d{1,3}(,\d{3})+\.\d{2}$/.test(c)) return parseFloat(c.replace(/,/g, ''));
    if (/^\d+,\d{2}$/.test(c)) return parseFloat(c.replace(',', '.'));
    var n = parseFloat(c.replace(',', '.'));
    return isFinite(n) && n > 0 ? n : null;
  }

  function parseCountdown(s) {
    if (!s) return null;
    var m = s.match(/(\d+)\s*(g|d|day|giorno|giorni)/i);
    var h = s.match(/(\d+)\s*h/i);
    var min = s.match(/(\d+)\s*m\b/i);
    if (!m && !h && !min) return null;
    var ms = 0;
    if (m) ms += parseInt(m[1]) * 86400000;
    if (h) ms += parseInt(h[1]) * 3600000;
    if (min) ms += parseInt(min[1]) * 60000;
    if (ms === 0) return null;
    return new Date(Date.now() + ms).toISOString();
  }

  // ── Extract real image URL from a card, handling lazy-load + <picture> ──
  // Catawiki usa <picture><source srcset="..."><img src="placeholder"></picture>
  // Inoltre il loading è lazy: tab in background → src può essere vuoto.
  // Cerchiamo in ordine: <source srcset> nel <picture>, srcset/data-srcset
  // dell'<img>, src, attributi data-* vari.
  function extractImageUrl(card) {
    if (!card) return null;

    function pickFromSrcset(srcset) {
      if (!srcset) return null;
      // srcset format: "url1 1x, url2 2x" oppure "url1 480w, url2 800w"
      // Vogliamo l'URL più grande (ultimo in genere)
      var parts = srcset.split(',').map(function (s) { return s.trim(); });
      if (!parts.length) return null;
      // Prendiamo l'ultimo (di solito a risoluzione maggiore)
      var last = parts[parts.length - 1];
      var url = last.split(/\s+/)[0];
      return url || null;
    }

    function isValidImageUrl(u) {
      if (!u) return false;
      if (u.indexOf('data:image/') === 0 && u.length < 200) return false; // tiny placeholder
      if (u.indexOf('blank.') >= 0 || u.indexOf('placeholder') >= 0) return false;
      if (/^data:image\/svg\+xml/.test(u)) return false; // svg placeholders
      return /^https?:\/\//.test(u) || u.indexOf('//') === 0;
    }

    // 1. Cerca <picture> e leggi <source srcset>
    var picture = card.querySelector('picture');
    if (picture) {
      var sources = picture.querySelectorAll('source');
      for (var i = 0; i < sources.length; i++) {
        var srcset = sources[i].getAttribute('srcset') || sources[i].getAttribute('data-srcset');
        var u = pickFromSrcset(srcset);
        if (isValidImageUrl(u)) return u.indexOf('//') === 0 ? 'https:' + u : u;
      }
    }

    // 2. Cerca <img> con tutti gli attributi possibili (per lazy loading)
    var imgs = card.querySelectorAll('img');
    for (var j = 0; j < imgs.length; j++) {
      var imgEl = imgs[j];
      // Ordine: data-src (lazy lib più comuni), data-lazy-src, srcset, data-srcset, src
      var attrs = ['data-src', 'data-lazy-src', 'data-original', 'data-defer-src'];
      for (var k = 0; k < attrs.length; k++) {
        var v = imgEl.getAttribute(attrs[k]);
        if (isValidImageUrl(v)) return v.indexOf('//') === 0 ? 'https:' + v : v;
      }
      // currentSrc è quello che il browser ha effettivamente caricato (gestisce <picture>)
      if (imgEl.currentSrc && isValidImageUrl(imgEl.currentSrc)) {
        return imgEl.currentSrc;
      }
      var ss = imgEl.getAttribute('srcset') || imgEl.getAttribute('data-srcset');
      var fromSs = pickFromSrcset(ss);
      if (isValidImageUrl(fromSs)) return fromSs.indexOf('//') === 0 ? 'https:' + fromSs : fromSs;
      if (isValidImageUrl(imgEl.src)) return imgEl.src;
    }

    // 3. Background-image inline (alcuni siti usano div con bg)
    var bgEls = card.querySelectorAll('[style*="background-image"]');
    for (var b = 0; b < bgEls.length; b++) {
      var st = bgEls[b].getAttribute('style') || '';
      var m = st.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/);
      if (m && isValidImageUrl(m[1])) return m[1];
    }

    return null;
  }

  // ── Forza il lazy-load di tutte le immagini visibili o no ───────────
  // Quando la tab è caricata in background, Chrome non triggera Intersection
  // Observer per le immagini fuori viewport. Forziamo lo scroll virtuale.
  function triggerLazyLoad() {
    try {
      // Strategy 1: scrolla in fondo per triggerare IntersectionObserver
      window.scrollTo(0, document.body.scrollHeight);
      window.scrollTo(0, 0);
      // Strategy 2: per ogni img con data-src, copialo in src
      document.querySelectorAll('img[data-src]').forEach(function (img) {
        var ds = img.getAttribute('data-src');
        if (ds && !img.src.startsWith(ds)) {
          try { img.src = ds; } catch (_) {}
        }
      });
      // Strategy 3: rimuovi loading=lazy (forza eager)
      document.querySelectorAll('img[loading="lazy"]').forEach(function (img) {
        try { img.loading = 'eager'; } catch (_) {}
      });
    } catch (_) {}
  }

  function parsePrice2(s) { return parsePrice(s); } // alias

  // ── Strategia 1: __NEXT_DATA__ (più affidabile, dati strutturati) ────
  function tryNextData() {
    var nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return null;
    try {
      var data = JSON.parse(nd.textContent);
      var lots = findLotsInJson(data);
      if (!lots || !lots.length) return null;
      return lots.map(function (lot) {
        var u = lot.url || (lot.id ? '/it/l/' + lot.id : null);
        if (!u) return null;
        var fullUrl = u.indexOf('http') === 0 ? u : ('https://www.catawiki.com' + u);

        var price = null;
        var currency = 'EUR';
        var bidObj = lot.current_bid || lot.minimum_bid || lot.starting_bid;
        if (bidObj && typeof bidObj === 'object') {
          if (typeof bidObj.amount === 'number') price = bidObj.amount;
          else if (typeof bidObj.value === 'number') price = bidObj.value;
          if (bidObj.currency) currency = bidObj.currency;
        }
        if (price === null && typeof lot.price === 'number') price = lot.price;
        if (price !== null && price > 100000) price = price / 100;

        var image = null;
        // Catawiki ha vari shape per le immagini in JSON:
        // - lot.image_url: string diretto
        // - lot.image: string oppure {url, large, src, thumbnails:[{url}]}
        // - lot.images: [{url, large, src, secureuri}, ...]
        // - lot.thumbnail / lot.cover_image
        if (typeof lot.image_url === 'string') image = lot.image_url;
        else if (typeof lot.image === 'string') image = lot.image;
        else if (lot.image && typeof lot.image === 'object') {
          image = lot.image.url || lot.image.large || lot.image.src || lot.image.secureuri;
          // Thumbnails array
          if (!image && Array.isArray(lot.image.thumbnails) && lot.image.thumbnails.length) {
            // Prendi la più grande (di solito ultima)
            var tlast = lot.image.thumbnails[lot.image.thumbnails.length - 1];
            image = (typeof tlast === 'string') ? tlast : (tlast.url || tlast.src);
          }
        }
        else if (Array.isArray(lot.images) && lot.images.length) {
          var first = lot.images[0];
          if (typeof first === 'string') image = first;
          else if (first && typeof first === 'object') {
            image = first.url || first.large || first.src || first.secureuri;
            // Stesso pattern thumbnails dentro images[0]
            if (!image && Array.isArray(first.thumbnails) && first.thumbnails.length) {
              var t2 = first.thumbnails[first.thumbnails.length - 1];
              image = (typeof t2 === 'string') ? t2 : (t2.url || t2.src);
            }
          }
        }
        if (!image && typeof lot.thumbnail === 'string') image = lot.thumbnail;
        if (!image && typeof lot.cover_image === 'string') image = lot.cover_image;
        // Normalizza protocol-relative
        if (image && image.indexOf('//') === 0) image = 'https:' + image;

        return {
          title: String(lot.title || lot.name || '').slice(0, 300),
          price: price,
          currency: currency,
          image_url: image,
          url: fullUrl.split('?')[0].split('#')[0],
          end_time: lot.end_time || lot.bidding_end_time || lot.closing_at || null,
          location: lot.location || lot.seller_country || null,
          seller: lot.seller_name || null,
          is_auction: true,
          source: 'catawiki',
          lot_id: lot.id ? String(lot.id) : null,
          bids: typeof lot.bid_count === 'number' ? lot.bid_count : null,
          shipping: null,
        };
      }).filter(Boolean);
    } catch (e) {
      console.warn('[RB Catawiki] NEXT_DATA parse:', e);
      return null;
    }
  }

  function findLotsInJson(node, depth) {
    depth = depth || 0;
    if (!node || depth > 12) return null;
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object') {
        var first = node[0];
        if (first.id && (first.title || first.name) && (first.url || first.image || first.current_bid || first.price)) {
          return node;
        }
      }
      for (var i = 0; i < node.length; i++) {
        var r = findLotsInJson(node[i], depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof node === 'object') {
      var keys = ['lots', 'results', 'searchResults', 'items', 'products'];
      for (var k = 0; k < keys.length; k++) {
        var arr = node[keys[k]];
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

  // ── Strategia 2: DOM scrape ──────────────────────────────────────────
  function tryDom() {
    var items = [];
    var processed = {};

    var rows = document.querySelectorAll('[data-testid*="lot-card"], article[class*="lot"], [class*="LotCard"]');
    if (!rows.length) {
      rows = document.querySelectorAll('a[href*="/l/"]');
    }

    rows.forEach(function (row) {
      var linkEl = row.tagName === 'A' ? row : row.querySelector('a[href*="/l/"]');
      if (!linkEl) return;
      var url = linkEl.href;
      if (processed[url]) return;
      processed[url] = true;
      var idMatch = url.match(/\/l\/([^\/?#]+)/);
      if (!idMatch) return;

      var card = row.tagName === 'A'
        ? (row.closest('article, [data-testid], [class*="LotCard"], li, div[class*="card"]') || row)
        : row;

      var titleEl = card.querySelector('h3, h2, [class*="title"], [data-testid*="title"]');
      var title = titleEl ? titleEl.textContent.trim() : (linkEl.textContent || '').trim();
      if (!title) return;

      var priceEl = card.querySelector('[class*="bid"], [class*="price"], [data-testid*="bid"], [data-testid*="price"]');
      var price = parsePrice(priceEl ? priceEl.textContent : '');

      var img = extractImageUrl(card);

      var endEl = card.querySelector('[class*="time-left"], [class*="countdown"], [class*="ends"], time');
      var endsAt = endEl ? parseCountdown(endEl.textContent) : null;

      items.push({
        title: title.slice(0, 300),
        price: price,
        currency: 'EUR',
        image_url: img,
        url: url.split('?')[0].split('#')[0],
        end_time: endsAt,
        location: null,
        seller: null,
        is_auction: true,
        source: 'catawiki',
        lot_id: idMatch[1],
        bids: null,
        shipping: null,
      });
    });

    return items;
  }

  // Cerca un'immagine per un lot identificato da lotId nel DOM corrente
  function findImageInDomByLotId(lotId) {
    if (!lotId) return null;
    // Trova un anchor che linki a /l/<lotId> e risali al card
    var anchor = document.querySelector('a[href*="/l/' + lotId + '"]');
    if (!anchor) {
      // Catawiki a volte usa ID diversi nel DOM, prova match parziale
      var anchors = document.querySelectorAll('a[href*="/l/"]');
      for (var i = 0; i < anchors.length; i++) {
        if (anchors[i].href.indexOf(lotId) >= 0) { anchor = anchors[i]; break; }
      }
    }
    if (!anchor) return null;
    var card = anchor.closest('article, [data-testid], [class*="LotCard"], li, div[class*="card"]') || anchor;
    return extractImageUrl(card);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Triggera lazy-loading e aspetta che le immagini si carichino
  async function ensureImagesLoaded(maxWaitMs) {
    triggerLazyLoad();
    await sleep(300);                    // dai tempo all'observer
    triggerLazyLoad();                   // secondo passaggio per sicurezza
    var deadline = Date.now() + (maxWaitMs || 4000);
    // Loop finché ci sono img non ancora caricate (naturalWidth==0) o passa il timeout
    while (Date.now() < deadline) {
      var imgs = Array.from(document.querySelectorAll('img'));
      var pending = imgs.filter(function (img) {
        // skip placeholder e già caricate
        if (img.naturalWidth > 0) return false;
        if (!img.src && !img.getAttribute('data-src')) return false;
        return true;
      });
      if (pending.length === 0) break;
      // Forza data-src → src per quelli ancora pendenti
      pending.forEach(function (img) {
        var ds = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (ds && img.src !== ds) {
          try { img.src = ds; } catch (_) {}
        }
      });
      await sleep(250);
    }
  }

  // Provo prima NEXT_DATA, poi DOM. Aspetta carico immagini prima di ritornare.
  var fromJson = tryNextData();
  if (fromJson && fromJson.length) {
    var missingImages = fromJson.filter(function (it) { return !it.image_url; }).length;
    if (missingImages > 0) {
      // Se mancano immagini, attiva lazy-load e aspetta async
      await ensureImagesLoaded(4000);
      fromJson.forEach(function (it) {
        if (!it.image_url && it.lot_id) {
          var img = findImageInDomByLotId(it.lot_id);
          if (img) it.image_url = img;
        }
      });
    }
    // Tag debug sul primo item per visibilità
    if (fromJson[0]) fromJson[0]._debug = { strategy: 'next_data', missing_images_initially: missingImages };
    return fromJson;
  }
  // Path DOM: triggera lazy + aspetta carico
  await ensureImagesLoaded(4000);
  var domItems = tryDom();
  if (domItems[0]) domItems[0]._debug = { strategy: 'dom' };
  return domItems;
}
