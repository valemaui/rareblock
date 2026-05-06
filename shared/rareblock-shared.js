/* ═══════════════════════════════════════════════════════════════════════════
   RAREBLOCK · SHARED RUNTIME
   ─────────────────────────────────────────────────────────────────────────
   Modulo condiviso da tutte le pagine sub-feature del portale Collector.
   Espone su `window` (script "classico" per compat con HTML inline).

     • Costanti       SUPA_URL, SUPA_KEY, TCG_URL, TCG_KEY, ADMIN_EMAILS
     • Sessione       rbLoadSession, rbSaveSession, rbClearSession
     • Auth           getHDR, getCurrentUserId, supa(method,path,body)
     • Profilo        loadUserProfile, isAdminUser, applyProfileToUI
     • Bootstrap      rbRequireAuth(returnPath)
     • Header         rbRenderHeader({active})  — nav COMPLETA identica
                                                  alla shell pokemon-db.html
     • API status     rbCheckApiStatus()  — popola il LED #apiLed
     • Fade           rbInitPageFade()    — fade-in al load + fade-out al click
     • Logout         rbLogout, authLogout (alias)
     • Utility        esc, fmtEur, fmtDate

   Pattern d'uso in una pagina sub-feature:

       <script src="shared/rareblock-shared.js" defer></script>
       <script defer>
         document.addEventListener('DOMContentLoaded', async () => {
           if(!await rbRequireAuth(location.pathname.split('/').pop())) return;
           rbRenderHeader({active:'wish'});
           rbCheckApiStatus();
           rbInitPageFade();
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
  window.ADMIN_EMAILS = ['admin@rareblock.eu', 'valemaui@gmail.com'];


  // ── 2. Sessione (compat con rareblock-login.html) ─────────────────────
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

  // Carica subito la sessione al boot così supa() la trova senza attese
  window._rbSession = window.rbLoadSession();


  // ── 3. Auth headers + supa() helper ───────────────────────────────────
  window.getHDR = function(){
    var token = (window._rbSession && window._rbSession.access_token) || window.SUPA_KEY;
    return {
      'Content-Type':  'application/json',
      'apikey':        window.SUPA_KEY,
      'Authorization': 'Bearer ' + token,
      'Prefer':        'return=representation'
    };
  };
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


  // ── 4. Profilo utente ─────────────────────────────────────────────────
  window._rbProfile = null;

  window.loadUserProfile = async function(){
    var s = window._rbSession;
    var u = s && s.user;
    if(!u){ window._rbProfile = null; return null; }

    var prof = {
      id: u.id, email: u.email,
      role: (window.ADMIN_EMAILS.indexOf(u.email) > -1 ? 'admin' : 'investor'),
      can_collector: true, can_investor: true,
      status: 'active', kyc_level: 0, kyc_status: 'pending'
    };

    try{
      var r = await fetch(window.SUPA_URL + '/rest/v1/profiles?id=eq.' + u.id +
        '&select=id,role,can_collector,can_investor,full_name,email,status,suspension_reason,kyc_level,kyc_status',
        { headers: window.getHDR() });
      if(!r.ok && r.status === 400){
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

    if(window.ADMIN_EMAILS.indexOf(u.email) > -1){ prof.role = 'admin'; prof.status = 'active'; }
    if(prof.role === 'admin'){ prof.can_collector = true; prof.can_investor = true; }
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


  // ── 5. Bootstrap auth gate ────────────────────────────────────────────
  window.rbRequireAuth = async function(returnPath){
    if(!window._rbSession || !window._rbSession.access_token){
      var ret = encodeURIComponent(returnPath || (location.pathname.split('/').pop() || 'pokemon-db.html'));
      location.replace('rareblock-login.html?return=' + ret);
      return false;
    }
    try{ await window.loadUserProfile(); }catch(e){}
    var p = window._rbProfile;
    if(p && p.status && p.status !== 'active'){
      window.rbClearSession();
      location.replace('rareblock-login.html?suspended=1');
      return false;
    }
    if(p && p.can_collector === false && p.role !== 'admin'){
      location.replace(p.can_investor ? 'rareblock-dashboard.html' : 'rareblock-login.html');
      return false;
    }
    return true;
  };


  // ── 6. Header con NAV COMPLETA ────────────────────────────────────────
  // Replica esattamente l'header del pokemon-db.html: stesso logo, mode-
  // switch, 9 voci di nav, LED API e user-badge. La differenza è che le
  // voci che puntano a tab interni del Collector usano <a href="...#tab=…">
  // mentre la voce "Wishlist" è <a href="rareblock-wishlist.html">.
  // L'opzione `active` evidenzia la voce corrente; le voci che puntano a
  // sé stesse sono non-cliccabili (preventDefault).
  //
  // Tab key → label/icon/href map. Mantenere in sync con pokemon-db.html.
  var NAV_TABS = [
    { key:'col',  label:'Collezione',  icon:'',                href:'pokemon-db.html#tab=col'  },
    { key:'prev', label:'Preventivi',  icon:'',                href:'pokemon-db.html#tab=prev' },
    { key:'ms',   label:'Masterset',   icon:'',                href:'pokemon-db.html#tab=ms'   },
    { key:'auth', label:'Autentica',   icon:'',                href:'pokemon-db.html#tab=auth' },
    { key:'anl',  label:'Analizza',    icon:'',                href:'pokemon-db.html#tab=anl'  },
    { key:'dash', label:'Dashboard',   icon:'rb-i-chart',      href:'pokemon-db.html#tab=dash' },
    { key:'vend', label:'Vendite',     icon:'rb-i-banknote',   href:'pokemon-db.html#tab=vend' },
    { key:'wish', label:'Wishlist',    icon:'rb-i-star',       href:'rareblock-wishlist.html'  },
    { key:'hunt', label:'Radar',       icon:'rb-i-radar',      href:'pokemon-db.html#tab=hunt' }
  ];

  window.rbRenderHeader = function(opts){
    opts = opts || {};
    var active = opts.active || '';
    var hdr = document.getElementById('rbHeader');
    if(!hdr) return;
    hdr.classList.add('header');

    var p = window._rbProfile || {};

    var navHtml = NAV_TABS.map(function(t){
      var iconHtml = t.icon ? '<span class="rb-i ' + t.icon + '"></span> ' : '';
      var cls = 'nav-btn' + (t.key === active ? ' active' : '');
      // La voce attiva linka a sé stessa ma il click viene preventDefault
      // dal global handler in rbInitPageFade per evitare reload inutili.
      return '<a class="' + cls + '" href="' + t.href + '" data-nav-key="' + t.key + '">' +
                iconHtml + t.label +
             '</a>';
    }).join('');

    hdr.innerHTML =
      '<a href="index.html" class="logo">' +
        '<span style="color:var(--text)">Rare</span><span class="logo-gold">Block</span>' +
      '</a>' +
      '<div class="mode-switch" id="modeSwitch">' +
        '<button class="mode-btn" id="modeInvestorBtn" onclick="window.location.href=\'rareblock-dashboard.html\'">Investor</button>' +
        '<button class="mode-btn active" id="modeCollectorBtn">Collector</button>' +
      '</div>' +
      '<nav class="nav">' + navHtml + '</nav>' +
      '<div class="led-wrap">' +
        '<div class="led checking" id="apiLed"></div>' +
        '<span class="led-label" id="apiLabel">verifica…</span>' +
      '</div>' +
      '<div class="user-badge" id="userBadge" style="display:none">' +
        '<a href="rareblock-admin-users.html" class="user-admin-link" id="userAdminLink" style="display:none" title="Pannello gestione utenti">Utenti</a>' +
        '<span class="user-email" id="userEmail"></span>' +
        '<button class="user-logout" onclick="rbLogout()">Esci</button>' +
      '</div>';

    // Applica permessi profilo (mostra/nasconde mode-switch Investor e link admin)
    window.applyProfileToUI();
  };


  // ── 7. LED stato API (popola #apiLed e #apiLabel) ─────────────────────
  // Usa la edge function smooth-endpoint come ping (latenza Supabase + funzione).
  function setLed(state, label){
    var led = document.getElementById('apiLed');
    var lbl = document.getElementById('apiLabel');
    if(!led || !lbl) return;
    led.className = 'led ' + state;
    lbl.textContent = label;
  }

  window.rbCheckApiStatus = async function(){
    setLed('checking', 'verifica…');
    var start = Date.now();
    try{
      var ctrl = new AbortController();
      var t = setTimeout(function(){ ctrl.abort(); }, 6000);
      var token = (window._rbSession && window._rbSession.access_token) || window.SUPA_KEY;
      var r = await fetch(window.SUPA_URL + '/functions/v1/hyper-endpoint?name=Pikachu', {
        headers: { 'Authorization': 'Bearer ' + token },
        signal:  ctrl.signal
      });
      clearTimeout(t);
      var elapsed = Date.now() - start;
      if(!r.ok) throw new Error('HTTP ' + r.status);
      if(elapsed > 1500){
        setLed('yellow', 'lento (' + Math.round(elapsed/1000) + 's)');
      }else{
        setLed('green', 'online (' + elapsed + 'ms)');
      }
    }catch(e){
      var el = Date.now() - start;
      if(e.name === 'AbortError' || el >= 5500){
        setLed('yellow', 'timeout — cold start');
      }else{
        setLed('red', 'offline');
      }
    }
  };


  // ── 8. Page-fade transitions ──────────────────────────────────────────
  // Fade-in al DOMContentLoaded (180ms) e fade-out (140ms) prima di seguire
  // un click su link `<a class="nav-btn">` o `.subpage-back`. La transizione
  // usa CSS opacity — niente scroll-jank, niente layout shift.
  window.rbInitPageFade = function(){
    // Fade-in: aggiunge .rb-loaded al body al prossimo frame, dopo che il
    // browser ha completato il primo paint (così l'opacity:0 iniziale
    // è effettivamente applicato e la transizione parte da 0).
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        document.body.classList.add('rb-loaded');
      });
    });

    // Fade-out: intercetta click su link nav esterni (sub-page o tab via
    // fragment) e applica .rb-fading prima del navigate. Skip se modifier
    // keys (cmd/ctrl/shift/middle-click → l'utente vuole nuova tab).
    document.addEventListener('click', function(e){
      var a = e.target.closest('a.nav-btn, .subpage-back, a.logo');
      if(!a) return;
      if(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
      if(a.target === '_blank') return;
      var href = a.getAttribute('href') || '';
      if(!href || href.charAt(0) === '#' && href.length > 1) return;

      // Active nav-btn → click su sé stessa, niente da fare
      if(a.classList.contains('active') && a.classList.contains('nav-btn')){
        e.preventDefault();
        return;
      }

      // Same-page hash navigation (es. #tab=col sulla stessa pagina) →
      // fragment-handler già gestisce internamente, niente fade
      try{
        var u = new URL(href, location.href);
        if(u.pathname === location.pathname && u.hash){ return; }
      }catch(_){}

      e.preventDefault();
      document.body.classList.remove('rb-loaded');
      document.body.classList.add('rb-fading');
      setTimeout(function(){ location.href = href; }, 140);
    }, false);

    // Fallback: se l'utente usa back/forward, ripristina lo stato visibile
    window.addEventListener('pageshow', function(ev){
      if(ev.persisted){
        document.body.classList.remove('rb-fading');
        document.body.classList.add('rb-loaded');
      }
    });
  };


  // ── 9. Logout ─────────────────────────────────────────────────────────
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
  // Alias per compat con pokemon-db.html legacy
  window.authLogout = window.rbLogout;


  // ── 10. Utility ───────────────────────────────────────────────────────
  window.esc = function(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  };

  window.fmtEur = function(n){
    if(n == null || isNaN(n)) return '—';
    return '€' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  window.fmtDate = function(iso){
    if(!iso) return '—';
    try{
      return new Date(iso).toLocaleDateString('it-IT', { day:'2-digit', month:'2-digit', year:'numeric' });
    }catch(e){ return '—'; }
  };

})();
