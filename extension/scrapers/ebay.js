// Scraper eBay — funzionante su ebay.it / .com / .de / .co.uk / .fr / .es
export async function scrapeEbay(job) {
  function parsePrice(s) {
    if (!s) return null;
    var c = String(s).replace(/[€\s$£]/g, '').trim();
    if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(c)) return parseFloat(c.replace(/\./g, '').replace(',', '.'));
    if (/^\d{1,3}(,\d{3})+\.\d{2}$/.test(c)) return parseFloat(c.replace(/,/g, ''));
    if (/^\d+,\d{2}$/.test(c)) return parseFloat(c.replace(',', '.'));
    var n = parseFloat(c.replace(',', '.'));
    return isFinite(n) && n > 0 ? n : null;
  }

  function parseTimeLeft(s) {
    if (!s) return null;
    var d = s.match(/(\d+)\s*(g|d)/i);
    var h = s.match(/(\d+)\s*h/i);
    var m = s.match(/(\d+)\s*m\b/i);
    if (!d && !h && !m) return null;
    var ms = 0;
    if (d) ms += parseInt(d[1]) * 86400000;
    if (h) ms += parseInt(h[1]) * 3600000;
    if (m) ms += parseInt(m[1]) * 60000;
    return ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
  }

  function getCurrency() {
    var host = location.hostname;
    if (host.indexOf('ebay.com') >= 0 && host.indexOf('co.uk') < 0) return 'USD';
    if (host.indexOf('ebay.co.uk') >= 0) return 'GBP';
    return 'EUR';
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
      var attrs = ['data-src', 'data-lazy-src', 'data-original', 'data-defer-src', 'data-img-src'];
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

  await ensureImagesLoaded(3500);

  var items = [];
  var processed = {};
  var currency = getCurrency();
  var rows = document.querySelectorAll('li.s-item, .srp-results li');

  rows.forEach(function (row) {
    if (row.classList && (row.classList.contains('s-item--placeholder') ||
                          row.querySelector('.s-item__title--tagblock'))) return;

    var linkEl = row.querySelector('a.s-item__link, a[href*="/itm/"]');
    if (!linkEl) return;
    var url = linkEl.href;
    var idMatch = url.match(/\/itm\/(?:[^\/]+\/)?(\d{8,15})/);
    if (!idMatch) return;
    var externalId = idMatch[1];
    if (processed[externalId]) return;
    processed[externalId] = true;

    var titleEl = row.querySelector('.s-item__title, h3.s-item__title');
    var title = titleEl ? titleEl.textContent.trim() : '';
    if (!title || /^Shop on eBay$/i.test(title) || /^Risultati corrispondenti/i.test(title)) return;

    var priceEl = row.querySelector('.s-item__price, .s-card__price');
    var price = parsePrice(priceEl ? priceEl.textContent : '');

    var img = extractImageUrl(row);

    var bidsEl = row.querySelector('.s-item__bids, .s-item__bidCount');
    var bidCount = null;
    if (bidsEl) {
      var m = bidsEl.textContent.match(/\d+/);
      bidCount = m ? parseInt(m[0]) : null;
    }
    var isAuction = !!bidsEl;

    var timeEl = row.querySelector('.s-item__time-left, .s-item__time-end');
    var endsAt = timeEl ? parseTimeLeft(timeEl.textContent) : null;

    var locEl = row.querySelector('.s-item__location, .s-item__itemLocation');
    var location = locEl ? locEl.textContent.trim() : null;

    var shipEl = row.querySelector('.s-item__shipping, .s-item__logisticsCost');
    var shipping = shipEl ? shipEl.textContent.trim() : null;

    items.push({
      title: title.slice(0, 300),
      price: price,
      currency: currency,
      image_url: img,
      url: url.split('?')[0],
      end_time: endsAt,
      location: location,
      seller: null,
      is_auction: isAuction,
      source: 'ebay',
      lot_id: externalId,
      bids: bidCount,
      shipping: shipping,
    });
  });

  return items;
}
