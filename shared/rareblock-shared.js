/* ═══════════════════════════════════════════════════════════════════════════
   RAREBLOCK · SHARED RUNTIME
   ─────────────────────────────────────────────────────────────────────────
   Modulo runtime condiviso da tutte le pagine sub-feature del portale
   Collector. Espone su `window` (script "classico", non ES module per
   compatibilità con HTML inline):

     • Costanti backend     SUPA_URL, SUPA_KEY, TCG_URL, TCG_KEY
     • Sessione             rbLoadSession(), rbSaveSession(), rbClearSession()
     • Auth                 getHDR(), getCurrentUserId(), supa(method,path,body)
     • Profilo              loadUserProfile(), isAdminUser(), applyProfileToUI()
     • Bootstrap            rbRequireAuth(returnPath) — gate per pagine sub
     • Header dinamico      rbRenderHeader({active}) — rende l'header standard
     • Utility              esc(s), fmtEur(n), fmtDate(iso)

   Caricamento (PRIMA di qualunque script specifico di pagina):

       <script src="shared/rareblock-shared.js" defer></script>
       <script defer>
         document.addEventListener('DOMContentLoaded', async () => {
           if(!await rbRequireAuth(location.pathname.split('/').pop())) return;
           rbRenderHeader({active:'wishlist'});
           // … inizializzazione del modulo specifico
         });
       </script>

   Single source of truth — i valori qui presenti vanno mantenuti in sync
   con `pokemon-db.html` (per ora il pokemon-db.html mantiene la sua copia
   inline; il refactoring finale lo farà puntare anche lui a questo file).
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  // ── 1. Costanti backend ───────────────────────────────────────────────
  window.SUPA_URL = 'https://rbjaaeyjeeqfpbzyavag.supabase.co';
  window.SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJiamFhZXlqZWVxZnBienlhdmFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NDUxMzUsImV4cCI6MjA4OTQyMTEzNX0.NyIKfc4cR93WrCERoT1FURWGo--vHD7Bbs3fS8OaE6E';
  window.TCG_URL  = 'https://api.pokemontcg.io/v2/cards';
  window.TCG_KEY  = 'ca385a14-d149-4a9f-a275-3bda5b7b1555';

  // Lista email founder/admin — failsafe se la colonna profiles.role non c'è
  window.ADMIN_EMAILS = ['admin@rareblock.eu', 'valemaui@gmail.com'];


  // ── 2. Sessione (compatibile con rareblock-login.html) ────────────────
  // La chiave 'rb_auth_session' è l'unica sorgente di verità sulla sessione
  // utente. Il login la scrive in localStorage o sessionStorage a seconda
  // del flag "Ricorda accesso". Qui leggiamo entrambi (priorità local).
  var RB_SESSION_KEY = 'rb_auth_session';

  window.rbLoadSession = function(){
    try{
      var raw = localStorage.getItem(RB_SESSION_KEY);
      if(raw) return JSON.parse(raw);
      raw = sessionStorage.getItem(RB_SESSION_KEY);
      if(raw) return JSON.parse(raw);
    }catch(e){}
    return null;
  };

  window.rbSaveSession = function(s){
    try{ localStorage.setItem(RB_SESSION_KEY, JSON.stringify(s)); }catch(e){}
    try{ if(s && s.access_token) localStorage.setItem('rbJWT', s.access_token); }catch(e){}
    window._rbSession = s;
  };

  window.rbClearSession = function(){
    try{ localStorage.removeItem(RB_SESSION_KEY); localStorage.removeItem('rbJWT'); }catch(e){}
    try{ sessionStorage.removeItem(RB_SESSION_KEY); sessionStorage.removeItem('rbJWT'); }catch(e){}
    // Pulisci anche le chiavi SDK Supabase (sb-<ref>-auth-token)
    try{
      var rm=[];
      for(var i=0;i<localStorage.length;i++){
        var k=localStorage.key(i);
        if(k && k.indexOf('sb-')===0) rm.push(k);
      }
      rm.forEach(function(k){ try{ localStorage.removeItem(k); }catch(e){} });
    }catch(e){}
    window._rbSession = null;
  };

  // Carica la sessione esistente al boot (così supa() la trova subito)
  window._rbSession = window.rbLoadSession();


  // ── 3. Auth headers / supa() helper ───────────────────────────────────
  // Usa il JWT utente (RLS enforcement) quando disponibile; fallback anon.
  window.getHDR = function(){
    var token = (window._rbSession && window._rbSession.access_token) || window.SUPA_KEY;
    return {
      'Content-Type':  'application/json',
      'apikey':        window.SUPA_KEY,
      'Authorization': 'Bearer ' + token,
      'Prefer':        'return=representation'
    };
  };
  // Compat: codice legacy che usa HDR direttamente
  Object.defineProperty(window, 'HDR', { get: window.getHDR, configurable: true });

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


  // ── 4. Profilo utente (ruolo, permessi, status) ───────────────────────
  // Scritto come nel pokemon-db.html: tentativo schema completo, fallback
  // se la colonna `status` non esiste ancora (compat pre-015).
  window._rbProfile = null;

  window.loadUserProfile = async function(){
    var s = window._rbSession;
    var u = s && s.user;
    if(!u){ window._rbProfile = null; return null; }

    var prof = {
      id: u.id,
      email: u.email,
      role: (window.ADMIN_EMAILS.indexOf(u.email) > -1 ? 'admin' : 'investor'),
      can_collector: true,
      can_investor: true,
      status: 'active',
      kyc_level: 0,
      kyc_status: 'pending'
    };

    try{
      var r = await fetch(window.SUPA_URL + '/rest/v1/profiles?id=eq.' + u.id +
        '&select=id,role,can_collector,can_investor,full_name,email,status,suspension_reason,kyc_level,kyc_status',
        { headers: window.getHDR() });
      if(!r.ok && r.status === 400){
        // Probabile colonna status mancante → fallback senza
        r = await fetch(window.SUPA_URL + '/rest/v1/profiles?id=eq.' + u.id +
          '&select=id,role,can_collector,can_investor,full_name,email',
          { headers: window.getHDR() });
      }
      if(r.ok){
        var arr = await r.json();
        if(arr && arr[0]){
          var p = arr[0];
          prof.role = p.role || prof.role;
          if(typeof p.can_collector === 'boolean') prof.can_collector = p.can_collector;
          if(typeof p.can_investor  === 'boolean') prof.can_investor  = p.can_investor;
          if(p.full_name)         prof.full_name         = p.full_name;
          if(p.status)            prof.status            = p.status;
          if(p.suspension_reason) prof.suspension_reason = p.suspension_reason;
          if(typeof p.kyc_level === 'number') prof.kyc_level = p.kyc_level;
          if(p.kyc_status)        prof.kyc_status        = p.kyc_status;
        }
      }
    }catch(e){ console.warn('[shared.profile] load fallback:', e.message); }

    // Failsafe: email founder → admin sempre attivo
    if(window.ADMIN_EMAILS.indexOf(u.email) > -1){
      prof.role = 'admin';
      prof.status = 'active';
    }
    if(prof.role === 'admin'){
      prof.can_collector = true;
      prof.can_investor  = true;
    }

    window._rbProfile = prof;
    return prof;
  };

  window.isAdminUser = function(){
    var p = window._rbProfile;
    return !!(p && p.role === 'admin');
  };

  window.applyProfileToUI = function(){
    var p = window._rbProfile;
    if(!p) return;
    var invBtn   = document.getElementById('modeInvestorBtn');
    if(invBtn) invBtn.style.display = p.can_investor ? '' : 'none';
    var adminLnk = document.getElementById('userAdminLink');
    if(adminLnk) adminLnk.style.display = (p.role === 'admin') ? '' : 'none';
    var emailEl  = document.getElementById('userEmail');
    if(emailEl) emailEl.textContent = p.email || '';
    var badge    = document.getElementById('userBadge');
    if(badge) badge.style.display = 'flex';
  };


  // ── 5. Bootstrap: rbRequireAuth(returnPath) ───────────────────────────
  // Da chiamare in cima a ogni pagina sub-feature. Se l'utente non è
  // autenticato, redirige a rareblock-login.html?return=<returnPath> e
  // ritorna false (la pagina dovrebbe interrompersi). Se autenticato,
  // carica il profilo e ritorna true.
  window.rbRequireAuth = async function(returnPath){
    if(!window._rbSession || !window._rbSession.access_token){
      var ret = encodeURIComponent(returnPath || (location.pathname.split('/').pop() || 'pokemon-db.html'));
      location.replace('rareblock-login.html?return=' + ret);
      return false;
    }
    try{ await window.loadUserProfile(); }catch(e){}
    var p = window._rbProfile;
    if(p && p.status && p.status !== 'active'){
      // Account sospeso/disattivato → kick a login con messaggio
      window.rbClearSession();
      location.replace('rareblock-login.html?suspended=1');
      return false;
    }
    if(p && p.can_collector === false && p.role !== 'admin'){
      // Niente accesso Collector → manda all'Investor se ce l'ha, altrimenti login
      location.replace(p.can_investor ? 'rareblock-dashboard.html' : 'rareblock-login.html');
      return false;
    }
    return true;
  };


  // ── 6. Header standard per pagine sub ─────────────────────────────────
  // Cerca un <header id="rbHeader"> e ci inietta il markup standard:
  // breadcrumb "← Collezione" + titolo modulo + mode switch + user badge.
  // Uso:
  //     <header id="rbHeader" class="header"></header>
  //     rbRenderHeader({title:'Wishlist', icon:'rb-i-star'});
  window.rbRenderHeader = function(opts){
    opts = opts || {};
    var hdr = document.getElementById('rbHeader');
    if(!hdr) return;
    hdr.classList.add('header');

    var p = window._rbProfile || {};
    var title = opts.title || '';
    var icon  = opts.icon  || '';

    hdr.innerHTML =
      '<a href="pokemon-db.html" class="logo">' +
        '<span style="color:var(--text)">Rare</span><span class="logo-gold">Block</span>' +
      '</a>' +
      '<a href="pokemon-db.html" class="subpage-back" title="Torna alla Collezione">' +
        '<span class="rb-i rb-i-x" style="transform:rotate(45deg)"></span> Collezione' +
      '</a>' +
      (title
        ? '<div class="subpage-title">' +
            (icon ? '<span class="rb-i ' + icon + '"></span>' : '') +
            '<span>' + window.esc(title) + '</span>' +
          '</div>'
        : '') +
      '<div style="flex:1"></div>' +
      '<div class="mode-switch" id="modeSwitch">' +
        '<button class="mode-btn" id="modeInvestorBtn" onclick="window.location.href=\'rareblock-dashboard.html\'">Investor</button>' +
        '<button class="mode-btn active">Collector</button>' +
      '</div>' +
      '<div class="user-badge" id="userBadge" style="display:none">' +
        (p.role === 'admin'
          ? '<a href="rareblock-admin-users.html" class="user-admin-link" id="userAdminLink" title="Pannello gestione utenti">Utenti</a>'
          : '') +
        '<span class="user-email" id="userEmail">' + window.esc(p.email || '') + '</span>' +
        '<button class="user-logout" onclick="rbLogout()">Esci</button>' +
      '</div>';

    // Mostra Investor switch solo se permesso
    var invBtn = document.getElementById('modeInvestorBtn');
    if(invBtn) invBtn.style.display = (p.can_investor !== false || p.role === 'admin') ? '' : 'none';
    var badge = document.getElementById('userBadge');
    if(badge) badge.style.display = 'flex';
  };

  window.rbLogout = async function(){
    try{
      if(window._rbSession && window._rbSession.access_token){
        await fetch(window.SUPA_URL + '/auth/v1/logout', {
          method: 'POST',
          headers: {
            'apikey': window.SUPA_KEY,
            'Authorization': 'Bearer ' + window._rbSession.access_token
          }
        });
      }
    }catch(e){}
    window.rbClearSession();
    location.replace('rareblock-login.html');
  };


  // ── 7. Utility ────────────────────────────────────────────────────────
  // esc — escape HTML per rendering sicuro di stringhe utente.
  window.esc = function(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  // fmtEur — formattazione importi euro consistente (es. "€1.250,30").
  window.fmtEur = function(n){
    if(n == null || isNaN(n)) return '—';
    return '€' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // fmtDate — formattazione data ISO → italiano breve "06/05/2026".
  window.fmtDate = function(iso){
    if(!iso) return '—';
    try{
      var d = new Date(iso);
      return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }catch(e){ return '—'; }
  };

})();
