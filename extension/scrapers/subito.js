// Scraper Subito — usa __NEXT_DATA__ se disponibile, fallback DOM
// Con ensureImagesLoaded async per gestire lazy loading in tab background.
export async function scrapeSubito(job) {
  function parsePrice(s) {
    if (!s) return null;
    var c = String(s).replace(/[€\s$£]/g, '').trim();
    if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(c)) return parseFloat(c.replace(/\./g, '').replace(',', '.'));
    if (/^\d+,\d{2}$/.test(c)) return parseFloat(c.replace(',', '.'));
    var n = parseFloat(c.replace(',', '.').replace(/\./g, ''));
    return isFinite(n) && n > 0 ? n : null;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

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

  function extractImageUrl(card) {
    if (!card) return null;
    var picture = card.querySelector('picture');
    if (picture) {
      var sources = picture.querySelectorAll('source');
      for (var i = 0; i < sources.length; i++) {
        var srcset = sources[i].getAttribute('srcset') || sources[i].getAttribute('data-srcset');
        var u = pickFromSrcset(srcset);
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
      var ss = imgEl.getAttribute('srcset') || imgEl.getAttribute('data-srcset');
      var fromSs = pickFromSrcset(ss);
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
        if (Array.isArray(arr) && arr.length && (arr[0]?.subject || arr[0]?.title)) return arr;
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
        if (img && img.indexOf('//') === 0) img = 'https:' + img;

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

      var img = extractImageUrl(card);

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
  if (fromJson && fromJson.length) {
    var missing = fromJson.filter(function (it) { return !it.image_url; }).length;
    if (missing > 0) await ensureImagesLoaded(3500);
    return fromJson;
  }
  await ensureImagesLoaded(3500);
  return tryDom();
}
