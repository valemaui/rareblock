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

  // ── Bridge verso funzioni del parent (pokemon-db.html) ────────────────
  // Alcune funzioni globali (rbSearchCards, fetchCards, rbMountSetPicker,
  // rbResolveSetFromInput, ...) sono definite SOLO nel parent perché
  // dipendono da set traduzioni / cache / TCG client che vivono lì.
  // Gli iframe le chiamano via parent. Helper centralizzato.
  window.rbParentFn = function(name){
    try {
      if(window.parent && window.parent !== window && typeof window.parent[name] === 'function'){
        return window.parent[name];
      }
    } catch(e){ /* cross-origin: ignore */ }
    if(typeof window[name] === 'function') return window[name];
    return null;
  };

  // ── API helpers ───────────────────────────────────────────────────────
  // getHDR rilegge la sessione SEMPRE da localStorage per non usare
  // un JWT stale dopo refresh token avvenuto nel parent.
  window.getHDR = function(prefer){
    window._rbSession = rbLoadSession();
    var token = (window._rbSession && window._rbSession.access_token) || window.SUPA_KEY;
    var h = {
      'Content-Type':  'application/json',
      'apikey':        window.SUPA_KEY,
      'Authorization': 'Bearer ' + token
    };
    // Prefer ha senso solo su scritture; sulle GET PostgREST può interpretarlo
    // come precondizione (412) o rifiutarlo (400). prefer===null → ometti.
    if(prefer !== null) h['Prefer'] = prefer || 'return=representation';
    return h;
  };

  window.getCurrentUserId = function(){
    if(!window._rbSession) window._rbSession = rbLoadSession();
    return (window._rbSession && window._rbSession.user && window._rbSession.user.id) || null;
  };

  window.supa = async function(method, path, body){
    // Prefer solo su scritture; su GET lo omettiamo (evita 412/400 PostgREST).
    var prefer = (method==='PATCH'||method==='DELETE') ? 'return=minimal'
               : (method==='GET') ? null
               : 'return=representation';
    var r = await fetch(window.SUPA_URL + '/rest/v1/' + path, {
      method:  method,
      headers: window.getHDR(prefer),
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

  // ── HUNT URL BUILDERS — condiviso tra Radar e Wishlist ─────────────────
  // Ogni builder accetta un target {card_name, card_number, language, variant,
  // first_edition, shadowless, grading_house, min_grade, extra_keywords}
  // e ritorna una query URL pre-compilata. Era duplicato nel radar.html,
  // ora condiviso così la nuova wishlist può usare gli stessi builder
  // per il bottone "Apri portali" senza dipendere dall'iframe radar.
  window.HUNT_URL_BUILDERS = {

    ebay: function(t){
      var terms = [];
      terms.push(t.card_name);
      if(t.card_number) terms.push(String(t.card_number).replace(/\/.*$/,''));
      if(t.grading_house) terms.push(t.grading_house);
      if(t.min_grade) terms.push(String(t.min_grade));
      if(t.first_edition) terms.push('1st edition');
      if(t.shadowless) terms.push('shadowless');
      if(t.language === 'ITA') terms.push('italiano');
      if(t.language === 'JPN') terms.push('japanese');
      if(t.extra_keywords && t.extra_keywords.forEach){
        t.extra_keywords.forEach(function(k){ terms.push(k); });
      }
      var q = terms.filter(Boolean).join(' ');
      // Pokémon category eBay EU = 2611, sop=10 = time ending soonest
      return 'https://www.ebay.it/sch/i.html?_nkw=' + encodeURIComponent(q)
           + '&_sacat=2611&LH_TitleDesc=0&_sop=10';
    },

    ebay_sold: function(t){
      var u = window.HUNT_URL_BUILDERS.ebay(t);
      return u + '&LH_Sold=1&LH_Complete=1';
    },

    catawiki: function(t){
      var terms = [t.card_name];
      if(t.card_number) terms.push(String(t.card_number).replace(/\/.*$/,''));
      if(t.grading_house) terms.push(t.grading_house);
      if(t.first_edition) terms.push('1st edition');
      if(t.shadowless) terms.push('shadowless');
      return 'https://www.catawiki.com/it/s?q=' + encodeURIComponent(terms.filter(Boolean).join(' '))
           + '&category_id=321'; // 321 = Carte collezionabili singole
    },

    subito: function(t){
      var terms = [t.card_name];
      if(t.card_number) terms.push(String(t.card_number).replace(/\/.*$/,''));
      if(t.grading_house) terms.push(t.grading_house);
      if(t.first_edition) terms.push('prima edizione');
      if(t.shadowless) terms.push('shadowless');
      var q = terms.filter(Boolean).join(' ');
      return 'https://www.subito.it/annunci-italia/vendita/hobby-collezionismo/?q='
           + encodeURIComponent(q);
    },

    vinted: function(t){
      var terms = [t.card_name, 'pokemon'];
      if(t.card_number) terms.push(String(t.card_number).replace(/\/.*$/,''));
      if(t.grading_house) terms.push(t.grading_house);
      if(t.first_edition) terms.push('1st edition');
      return 'https://www.vinted.it/catalog?search_text='
           + encodeURIComponent(terms.filter(Boolean).join(' '))
           + '&order=newest_first';
    },

    tcgplayer: function(t){
      var terms = [t.card_name];
      if(t.card_number) terms.push(String(t.card_number).replace(/\/.*$/,''));
      return 'https://www.tcgplayer.com/search/pokemon/product?q='
           + encodeURIComponent(terms.filter(Boolean).join(' '))
           + '&view=grid&productLineName=pokemon';
    },

    // Tutte le piattaforme in parallelo (subset usato dalla wishlist)
    all: function(t){
      return {
        ebay:      window.HUNT_URL_BUILDERS.ebay(t),
        catawiki:  window.HUNT_URL_BUILDERS.catawiki(t),
        subito:    window.HUNT_URL_BUILDERS.subito(t),
        vinted:    window.HUNT_URL_BUILDERS.vinted(t),
        tcgplayer: window.HUNT_URL_BUILDERS.tcgplayer(t)
      };
    },

    // Sottoinsieme delle 4 piattaforme richieste dalla wishlist:
    // eBay + Vinted + Subito + Catawiki (senza tcgplayer)
    wishlist_4: function(t){
      return {
        ebay:     window.HUNT_URL_BUILDERS.ebay(t),
        vinted:   window.HUNT_URL_BUILDERS.vinted(t),
        subito:   window.HUNT_URL_BUILDERS.subito(t),
        catawiki: window.HUNT_URL_BUILDERS.catawiki(t)
      };
    }
  };

  window.HUNT_PLATFORMS = [
    { id:'ebay',      label:'eBay',      color:'#e53238', icon:'<span class="rb-i rb-i-cart"></span>' },
    { id:'vinted',    label:'Vinted',    color:'#007782', icon:'<span class="rb-i rb-i-tag"></span>' },
    { id:'subito',    label:'Subito',    color:'#ff6700', icon:'<span class="rb-i rb-i-package"></span>' },
    { id:'catawiki',  label:'Catawiki',  color:'#144b9c', icon:'<span class="rb-i rb-i-arch"></span>' },
    { id:'tcgplayer', label:'TCGPlayer', color:'#EB7D1B', icon:'<span class="rb-i rb-i-card"></span>' }
  ];

  // ── Deal score engine — condiviso (era window.huntCalcDealScore in radar) ─
  // Stessa formula del radar (allineata 1:1) così wishlist e radar mostrano
  // gli stessi numeri. Se aggiorni la formula, aggiornala QUI sola.
  window.rbCalcDealScore = function(listing, target){
    var score = 0;
    var reasons = [];
    var ref = target && target.ref_price_cm;

    // 1) Sconto vs prezzo CM (max 50 pt)
    if(ref && listing.price){
      var disc = (ref - listing.price) / ref;
      if(disc >= 0.50){ score += 50; reasons.push('below_cm_50pct'); }
      else if(disc >= 0.35){ score += 40; reasons.push('below_cm_35pct'); }
      else if(disc >= 0.20){ score += 25; reasons.push('below_cm_20pct'); }
      else if(disc >= 0.10){ score += 12; reasons.push('below_cm_10pct'); }
      else if(disc > 0){ score += 5; }
      else if(disc < -0.15){ reasons.push('above_cm_overpriced'); }
    }

    // 2) Asta in scadenza (max 25 pt)
    if(listing.listing_type === 'auction' && listing.auction_ends_at){
      var hoursLeft = (new Date(listing.auction_ends_at) - new Date()) / 3600000;
      if(hoursLeft > 0 && hoursLeft < 24){
        if((listing.bid_count || 0) === 0){ score += 25; reasons.push('auction_no_bids_ending'); }
        else if(hoursLeft < 6){ score += 15; reasons.push('auction_ending_6h'); }
        else { score += 8; reasons.push('auction_ending_24h'); }
      }
    }

    // 3) Venditore reputato (max 10 pt)
    if(listing.seller_rating && listing.seller_rating >= 99){ score += 5; reasons.push('top_seller'); }
    if(listing.seller_feedbacks && listing.seller_feedbacks >= 1000){ score += 5; reasons.push('high_volume_seller'); }

    // 4) Match attributi (max 15 pt)
    if(target){
      if(target.grading_house && listing.parsed_grader === target.grading_house){ score += 5; reasons.push('grader_match'); }
      if(target.min_grade && listing.parsed_grade && listing.parsed_grade >= target.min_grade){ score += 5; reasons.push('grade_match'); }
      if(target.first_edition && listing.parsed_is_1st){ score += 5; reasons.push('1st_ed_match'); }
    }

    return { score: Math.min(100, Math.max(0, Math.round(score))), reasons: reasons };
  };

})();
