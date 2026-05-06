/* ═══════════════════════════════════════════════════════════════════════════
   RAREBLOCK · SHARED RUNTIME (subset per frame contents)
   ─────────────────────────────────────────────────────────────────────────
   Caricato dentro le pagine in frames/*.html. Espone le costanti backend
   e gli helper API (supa, getHDR, getCurrentUserId, esc) che il modulo
   estratto si aspetta di trovare globali.

   I frame sono same-origin con il pokemon-db.html, quindi accedono al
   localStorage condiviso (chiave 'rb_auth_session') per leggere il JWT
   utente. Se manca, il parent ha già fatto redirect a login: il frame
   non gestisce auth.
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  window.SUPA_URL = 'https://rbjaaeyjeeqfpbzyavag.supabase.co';
  window.SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJiamFhZXlqZWVxZnBienlhdmFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NDUxMzUsImV4cCI6MjA4OTQyMTEzNX0.NyIKfc4cR93WrCERoT1FURWGo--vHD7Bbs3fS8OaE6E';
  window.TCG_URL  = 'https://api.pokemontcg.io/v2/cards';
  window.TCG_KEY  = 'ca385a14-d149-4a9f-a275-3bda5b7b1555';

  // ── Sessione (compat con rareblock-login.html / pokemon-db.html) ──────
  var RB_SESSION_KEY = 'rb_auth_session';

  function rbLoadSession(){
    try{
      var raw = localStorage.getItem(RB_SESSION_KEY);
      if(raw) return JSON.parse(raw);
      raw = sessionStorage.getItem(RB_SESSION_KEY);
      if(raw) return JSON.parse(raw);
    }catch(e){}
    return null;
  }

  // Carica sessione subito al boot
  window._rbSession = rbLoadSession();

  // ── API helpers ───────────────────────────────────────────────────────
  window.getHDR = function(){
    var token = (window._rbSession && window._rbSession.access_token) || window.SUPA_KEY;
    return {
      'Content-Type':  'application/json',
      'apikey':        window.SUPA_KEY,
      'Authorization': 'Bearer ' + token,
      'Prefer':        'return=representation'
    };
  };

  window.getCurrentUserId = function(){
    return (window._rbSession && window._rbSession.user && window._rbSession.user.id) || null;
  };

  window.supa = async function(method, path, body){
    var r = await fetch(window.SUPA_URL + '/rest/v1/' + path, {
      method:  method,
      headers: window.getHDR(),
      body:    body ? JSON.stringify(body) : undefined
    });
    if(!r.ok){ var e = await r.text(); throw new Error(e); }
    var t = await r.text();
    return t ? JSON.parse(t) : null;
  };

  // ── Utility ───────────────────────────────────────────────────────────
  window.esc = function(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  };

  window.fmtEur = function(n){
    if(n == null || isNaN(n)) return '—';
    return '€' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // ── Cross-frame nav (via postMessage al parent pokemon-db.html) ───────
  // Uso: rbNav('prev', { q: 'Charizard' })  → parent apre tab prev e
  // pre-fill input ricerca con "Charizard". Se non siamo dentro un frame
  // (es. apertura diretta della pagina), fallback a location.href.
  window.rbNav = function(tab, opts){
    opts = opts || {};
    if(window.parent && window.parent !== window){
      try{
        window.parent.postMessage({
          type: 'rb-nav',
          tab:  tab,
          q:    opts.q || null
        }, location.origin);
        return;
      }catch(e){}
    }
    // Fallback standalone
    var hash = '#tab=' + encodeURIComponent(tab);
    if(opts.q) hash += '&q=' + encodeURIComponent(opts.q);
    location.href = 'pokemon-db.html' + hash;
  };

})();
