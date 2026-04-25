// Popup script — mostra versione, capabilities, ultime esecuzioni

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

// Capabilities (siti supportati): le hardcodiamo qui per evitare round-trip
var CAPS = ['catawiki', 'ebay', 'subito'];
var capsEl = document.getElementById('caps');
capsEl.innerHTML = CAPS.map(function (c) {
  return '<span class="cap">' + c + '</span>';
}).join('');

// Render runs
function renderRuns() {
  chrome.storage.local.get(['runs']).then(function (res) {
    var runs = res.runs || [];
    var box = document.getElementById('runs');
    if (!runs.length) {
      box.innerHTML = '<div class="empty">Nessuna esecuzione ancora.</div>';
      return;
    }
    box.innerHTML = runs.map(function (r) {
      var cls = r.error ? 'err' : 'ok';
      var t = new Date(r.timestamp).toLocaleString();
      var dur = r.duration_ms ? ' · ' + (r.duration_ms / 1000).toFixed(1) + 's' : '';
      var count = r.error
        ? '<span class="run-count">' + (r.error.length > 30 ? r.error.slice(0, 30) + '…' : r.error) + '</span>'
        : '<span class="run-count">' + r.items_count + ' items</span>';
      return (
        '<div class="run ' + cls + '">' +
          '<div class="run-info">' +
            '<div class="run-site">' + r.site + '</div>' +
            '<div class="run-time">' + t + dur + '</div>' +
          '</div>' +
          count +
        '</div>'
      );
    }).join('');
  });
}

document.getElementById('clearBtn').addEventListener('click', function () {
  chrome.storage.local.set({ runs: [] }).then(renderRuns);
});

renderRuns();
// Refresh ogni 2s mentre il popup è aperto (potrebbe esserci uno scrape in corso)
setInterval(renderRuns, 2000);
