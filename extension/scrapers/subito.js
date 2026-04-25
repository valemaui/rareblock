// Scraper Subito — usa __NEXT_DATA__ se disponibile, fallback DOM
export function scrapeSubito(job) {
  function parsePrice(s) {
    if (!s) return null;
    var c = String(s).replace(/[€\s$£]/g, '').trim();
    if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(c)) return parseFloat(c.replace(/\./g, '').replace(',', '.'));
    if (/^\d+,\d{2}$/.test(c)) return parseFloat(c.replace(',', '.'));
    var n = parseFloat(c.replace(',', '.').replace(/\./g, ''));
    return isFinite(n) && n > 0 ? n : null;
  }

  function findAds(node, depth) {
    depth = depth || 0;
    if (!node || depth > 12) return null;
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object' &&
          (node[0].subject || node[0].title) && (node[0].urls || node[0].url)) {
        return node;
      }
      for (var i = 0; i < node.length; i++) {
        var r = findAds(node[i], depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof node === 'object') {
      var keys = ['ads', 'list', 'items', 'results'];
      for (var k = 0; k < keys.length; k++) {
        var arr = node[keys[k]];
        if (Array.isArray(arr) && arr.length && (arr[0]?.subject || arr[0]?.title)) {
          return arr;
        }
      }
      var vals = Object.values(node);
      for (var v = 0; v < vals.length; v++) {
        var r2 = findAds(vals[v], depth + 1);
        if (r2) return r2;
      }
    }
    return null;
  }

  function tryNextData() {
    var nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return null;
    try {
      var data = JSON.parse(nd.textContent);
      var ads = findAds(data);
      if (!ads || !ads.length) return null;
      return ads.map(function (ad) {
        var u = ad.urls?.default || ad.url || (ad.id ? '/annunci/' + ad.id : null);
        if (!u) return null;
        var fullUrl = u.indexOf('http') === 0 ? u : ('https://www.subito.it' + u);

        var price = null;
        if (ad.features?.['/price']?.values?.[0]?.value) {
          price = parsePrice(String(ad.features['/price'].values[0].value));
        } else if (typeof ad.price === 'number') {
          price = ad.price;
        }

        var img = ad.images?.[0]?.scale?.[ad.images[0].scale.length - 1]?.secureuri
               || ad.images?.[0]?.uri
               || ad.image?.url
               || null;

        return {
          title: String(ad.subject || ad.title || '').slice(0, 300),
          price: price,
          currency: 'EUR',
          image_url: img,
          url: fullUrl.split('?')[0],
          end_time: null,
          location: ad.geo?.city?.value || ad.geo?.town?.value || null,
          seller: null,
          is_auction: false,
          source: 'subito',
          lot_id: ad.id ? String(ad.id) : null,
          bids: null,
          shipping: null,
        };
      }).filter(Boolean);
    } catch (e) {
      console.warn('[RB Subito] NEXT_DATA parse:', e);
      return null;
    }
  }

  function tryDom() {
    var items = [];
    var processed = {};
    var rows = document.querySelectorAll('a[href*="subito.it/"], div.items__item, [class*="item-card"]');
    rows.forEach(function (el) {
      var linkEl = el.tagName === 'A' ? el : el.querySelector('a');
      if (!linkEl) return;
      var url = linkEl.href;
      if (!/\/v\/|\/annunci\//.test(url)) return;
      url = url.split('?')[0];
      if (processed[url]) return;
      processed[url] = true;

      var card = el.tagName === 'A' ? (el.closest('[class*="item"]') || el) : el;
      var titleEl = card.querySelector('h2, h3, [class*="title"]');
      var title = titleEl ? titleEl.textContent.trim() : '';
      if (!title) return;

      var priceEl = card.querySelector('[class*="price"]');
      var price = parsePrice(priceEl ? priceEl.textContent : '');

      var imgEl = card.querySelector('img');
      var img = imgEl ? (imgEl.src || imgEl.getAttribute('data-src')) : null;

      var locEl = card.querySelector('[class*="town"], [class*="city"], [class*="location"]');
      var location = locEl ? locEl.textContent.trim() : null;

      items.push({
        title: title.slice(0, 300),
        price: price,
        currency: 'EUR',
        image_url: img,
        url: url,
        end_time: null,
        location: location,
        seller: null,
        is_auction: false,
        source: 'subito',
        lot_id: null,
        bids: null,
        shipping: null,
      });
    });
    return items;
  }

  var fromJson = tryNextData();
  if (fromJson && fromJson.length) return fromJson;
  return tryDom();
}
