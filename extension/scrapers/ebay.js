// Scraper eBay — funzionante su ebay.it / .com / .de / .co.uk / .fr / .es
export function scrapeEbay(job) {
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

    var imgEl = row.querySelector('img.s-item__image-img, .s-item__image img, .s-item__image-wrapper img');
    var img = null;
    if (imgEl) img = imgEl.src || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src');

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
