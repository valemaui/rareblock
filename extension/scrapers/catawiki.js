// Scraper Catawiki — iniettato nella tab di catawiki.com via executeScript.
// IMPORTANTE: la funzione viene serializzata via toString(), quindi:
//   - niente closure su variabili esterne
//   - niente import dinamici
//   - tutti gli helper devono essere DENTRO la funzione

export function scrapeCatawiki(job) {
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
        if (typeof lot.image === 'string') image = lot.image;
        else if (lot.image && typeof lot.image === 'object') image = lot.image.url || lot.image.large;
        else if (Array.isArray(lot.images) && lot.images.length) {
          var first = lot.images[0];
          image = typeof first === 'string' ? first : (first.url || first.large);
        }

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

      var imgEl = card.querySelector('img');
      var img = null;
      if (imgEl) {
        img = imgEl.src || imgEl.getAttribute('data-src');
        if (!img && imgEl.srcset) img = imgEl.srcset.split(' ')[0];
      }

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

  // Provo prima NEXT_DATA, poi DOM
  var fromJson = tryNextData();
  if (fromJson && fromJson.length) return fromJson;
  return tryDom();
}
