// ═══════════════════════════════════════════════════════════════════════
//  RareBlock — Service Worker per Web Push (Radar Maggiordomo)
//
//  Riceve push da hunt-monitor edge function via VAPID e mostra notifiche
//  anche con il browser chiuso. Same-origin con la pagina principale
//  (https://www.rareblock.eu/sw.js).
//
//  Aggiorna la versione per forzare update del SW lato client:
// ═══════════════════════════════════════════════════════════════════════
const SW_VERSION = '1';

self.addEventListener('install', (event) => {
  // Attiva immediatamente la nuova versione
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Prendi controllo di tutti i client già aperti senza richiedere reload
  event.waitUntil(self.clients.claim());
});

// ── PUSH RECEIVED ───────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'RareBlock', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || '📡 RareBlock Radar';
  const opts = {
    body: data.body || '',
    icon: data.icon || '/favicon.ico',
    badge: data.badge || '/favicon.ico',
    image: data.image || undefined,
    tag: data.tag || ('rb-' + Date.now()),
    renotify: !!data.renotify,
    requireInteraction: data.threshold === '10m' || data.threshold === '1h',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/',
      threshold: data.threshold || null,
      listing_id: data.listing_id || null,
      received_at: Date.now(),
    },
    actions: data.url ? [
      { action: 'open', title: 'Apri inserzione' },
      { action: 'dismiss', title: 'Ignora' },
    ] : [],
  };

  event.waitUntil(self.registration.showNotification(title, opts));
});

// ── CLICK ON NOTIFICATION ───────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Se c'è già una tab RareBlock aperta, focus su quella e naviga al listing
      for (const client of clientList) {
        try {
          const u = new URL(client.url);
          if (u.hostname.includes('rareblock') || u.hostname.includes('serifast')) {
            client.focus();
            // Apri il listing in nuova tab dalla pagina principale
            if (url && url !== '/') {
              return client.postMessage({ type: 'open-url', url });
            }
            return;
          }
        } catch (_) {}
      }
      // Nessuna tab aperta: apri direttamente il listing
      return self.clients.openWindow(url);
    })
  );
});

// ── PUSH SUBSCRIPTION CHANGE ────────────────────────────────────────────
// Quando il browser ruota le keys, devo riportare la nuova subscription
// al backend. Il client invia la nuova endpoint via postMessage al risveglio.
self.addEventListener('pushsubscriptionchange', (event) => {
  // Best effort: notifica i client aperti per re-subscribe
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) c.postMessage({ type: 'resubscribe-needed' });
    })
  );
});
