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

// ── Listino settimanale (sweep prezzi) ──
function renderSweeps() {
  chrome.storage.local.get(['sweeps']).then(function (res) {
    var sweeps = res.sweeps || [];
    var box = document.getElementById('sweeps');
    if (!box) return;
    if (!sweeps.length) {
      box.innerHTML = '<div class="empty">Mai eseguito.</div>';
      return;
    }
    box.innerHTML = sweeps.map(function (s) {
      var cls = s.error ? 'err' : 'ok';
      var t = new Date(s.timestamp).toLocaleString();
      var dur = s.duration_ms ? ' · ' + (s.duration_ms / 1000).toFixed(0) + 's' : '';
      var info = s.error
        ? '<span class="run-count">' + (s.error.length > 28 ? s.error.slice(0, 28) + '…' : s.error) + '</span>'
        : '<span class="run-count">' + (s.scraped_ok || 0) + '/' + (s.total || 0) + '</span>';
      return '<div class="run ' + cls + '">' +
        '<div class="run-info"><div class="run-site">Sweep</div>' +
        '<div class="run-time">' + t + dur + '</div></div>' + info + '</div>';
    }).join('');
  });
}

var sweepBtn = document.getElementById('sweepBtn');
if (sweepBtn) {
  sweepBtn.addEventListener('click', function () {
    sweepBtn.disabled = true;
    var orig = sweepBtn.textContent;
    sweepBtn.textContent = '⏳ In corso… (non chiudere Chrome)';
    chrome.runtime.sendMessage({ type: 'rb-run-sweep-now' }, function (resp) {
      sweepBtn.disabled = false;
      sweepBtn.textContent = orig;
      renderSweeps();
      if (chrome.runtime.lastError) {
        alert('Errore: ' + chrome.runtime.lastError.message);
      } else if (resp && !resp.ok) {
        alert('Sweep: ' + (resp.error || 'errore'));
      }
    });
  });
}

renderRuns();
renderSweeps();
// Refresh ogni 2s mentre il popup è aperto (potrebbe esserci uno scrape in corso)
setInterval(function () { renderRuns(); renderSweeps(); }, 2000);
