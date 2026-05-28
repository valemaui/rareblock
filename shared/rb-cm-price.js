/* ============================================================================
 * RareBlock — RB CardMarket Price Engine  (shared/rb-cm-price.js)
 * ----------------------------------------------------------------------------
 * MODULO ISOLATO — Livello "prezzo CM live" del Card Engine.
 * Entry pubblica: fetchCmPriceLive(opts) → { price, currency, listings, source, ... }
 * Esegue lo scrape server-side via Supabase smooth-endpoint con cascata di URL
 * (diretto L1 → varianti V1/V2 → browse L2 → autoritativo TCG API), filtra le
 * inserzioni-spam (_isFakeCmListings) e seleziona il prezzo per condizione.
 * Estratto verbatim da pokemon-db.html — NON riscritto. Vedi docs/REFACTOR-CARD-ENGINE.md (Fase 3).
 *
 * VINCOLI CODEBASE (hard):
 *  - NIENTE IIFE: simboli top-level → call-site esistenti (fetchCmPriceLive,
 *    _vpServerSideCMScrape) invariati. Caricare DOPO rb-cm-url.js (usa buildCM*).
 *  - Le funzioni estratte NON vanno ridichiarate altrove (redeclare = SyntaxError).
 *
 * DIPENDENZE A RUNTIME (call-time; init() in Fase 4 per riuso nei frames/):
 *   da rb-cm-url.js: buildCMDirectUrl, buildCMDirectUrlVariants, buildCMSearchUrl, cmAuthoritativeUrl
 *   dal monolite:    smartCMPrice, SUPA_URL, SUPA_KEY
 *
 * RESTANO nel monolite (Fase 3b/UI): cmLogger, _vpCloseCMTab, _saveCmStash,
 *   replayCmLog, _vpProcessListings, _logCmAttempts, _rbPersistConditionPrices,
 *   verifyPrice/verifyPriceAdd/applyAddPrice (orchestrazione UI/modal/tab/Realtime).
 *
 * API pubblica (namespace RBCMPrice, oltre ai nomi globali retro-compatibili):
 *   RBCMPrice.fetch(opts)        → alias di fetchCmPriceLive
 *   RBCMPrice.serverScrape(url)  → alias di _vpServerSideCMScrape
 * ==========================================================================*/

/* ── scrape server-side (Supabase smooth-endpoint) ───────────────────────── */
async function _vpServerSideCMScrape(cmUrl){
  try{
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, 10000);
    var sessionToken = window._rbSession && window._rbSession.access_token;
    var bearer = sessionToken || SUPA_KEY;
    var res = await fetch(SUPA_URL+'/functions/v1/smooth-endpoint', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+bearer},
      body:JSON.stringify({source:'cardmarket', url:cmUrl, debug:true}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if(!res.ok){
      if(res.status===401 && bearer!==SUPA_KEY){
        res = await fetch(SUPA_URL+'/functions/v1/smooth-endpoint', {
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPA_KEY},
          body:JSON.stringify({source:'cardmarket', url:cmUrl, debug:true}),
        });
      }
      if(!res.ok) return {listings:[], error:'HTTP '+res.status,
                          blocked:(res.status===403||res.status===429||res.status===503)};
    }
    var data = await res.json();
    // "blocked" = pagina NON leggibile (403 Cloudflare / WAF / challenge / rate
    // limit / 5xx). Diverso da "pagina valida ma vuota/sbagliata": un blocco NON
    // implica che lo slug sia errato, quindi il chiamante deve RITENTARE lo
    // stesso URL, MAI sostituirlo con uno slug diverso (V1/V2 = altro prodotto).
    var _st = data.status || 0;
    var _err = data.error || '';
    var _blocked = _st===403 || _st===429 || _st===503
                || /\b(403|429|503)\b|cloudflare|\bwaf\b|challenge|just a moment/i.test(_err);
    if(data.error) return {listings:[], error:data.error, debug:data.debug,
                           wrong_product:data.wrong_product===true, blocked:_blocked, status:_st};
    return {listings: data.listings || [], error: null, debug: data.debug,
            wrong_product:data.wrong_product===true, blocked:false, status:_st||200};
  }catch(e){
    // Timeout / errore di rete: pagina non letta → trattata come "blocked" così
    // non innesca la sostituzione di slug (che porterebbe a un prodotto diverso).
    return {listings:[], error: e.name==='AbortError' ? 'timeout 10s' : (e.message || String(e)), blocked:true};
  }
}

/* ── fetch prezzo CM live con cascata URL + filtro spam ──────────────────── */
async function fetchCmPriceLive(opts){
  var name      = (opts && opts.name) || '';
  var setId     = (opts && opts.setId) || null;
  var number    = (opts && opts.number) || '';
  var cond      = (opts && opts.condition) || 'NM';
  var lang      = (opts && opts.language) || 'ITA';
  var variant   = (opts && opts.variant) || 'Normal';
  var first1st  = !!(opts && opts.first_edition);
  var setName   = (opts && opts.setName) || '';
  var rarity    = (opts && opts.rarity) || '';
  var cmUrlAuth = (opts && (opts.cmUrl || opts.cm_url)) || null;

  if(!name) return {ok:false, error:'nome carta mancante', attempts:[]};

  // Risolvi set_id dalla cache se non fornito (es. carte preventivo legacy)
  if(!setId){
    var _cached = cache[name.toLowerCase().trim()];
    var _hit = _cached ? (_cached.find(function(x){return x.number===number;}) || _cached[0]) : null;
    if(_hit && _hit.set) setId = _hit.set.id;
    // Recupera anche rarity dalla cache se mancante (importante per i set ambigui)
    if(!rarity && _hit && _hit.rarity) rarity = _hit.rarity;
    // Recupera URL autoritativo dalla cache TCG se non fornito esplicitamente
    if(!cmUrlAuth && _hit) cmUrlAuth = cmAuthoritativeUrl(_hit);
  }

  var cmUrl = buildCMDirectUrl(name, setId, number, cond, lang, variant, first1st, setName, rarity, cmUrlAuth);
  // Se l'URL deriva dall'URL autoritativo TCG API, è già esatto: niente cascata di
  // varianti V1/V2 (che genererebbe PRODOTTI DIVERSI). Su 403 si ritenta solo lo
  // stesso URL.
  // NB: 'autoritativo' vale SOLO se il cmUrlAuth ricevuto passa il filtro
  // cardmarket.com-only (vedi _isAuthoritativeCMUrl). Senza questo controllo, un
  // call site che passa direttamente c.cm_url='https://prices.pokemontcg.io/...'
  // (record salvato pre-fix) marcherebbe isAuthoritative=true ANCHE quando
  // buildCMDirectUrl ricostruisce l'URL client-side (e quindi vorremmo proprio
  // la cascata varianti). Risultato del fix: per i set ambigui la cascata V1/V2
  // torna ad attivarsi quando l'URL è effettivamente ricostruito.
  var isAuthoritative = _isAuthoritativeCMUrl(cmUrlAuth);
  var isDirect = cmUrl.indexOf('/Singles/') !== -1 && cmUrl.indexOf('searchString=') === -1;

  // Traccia tutti i tentativi fatti — esposto al caller per logging dettagliato
  var attempts = [];

  // Anti-fake-page guard: mirror dell'euristica server-side. Quando CM non
  // trova la carta a quell'URL (es. /Totodile-NG81 non esiste perch\u00e9 la
  // versione vera \u00e8 /Totodile-V1-NG81), serve una pagina con 1-2 listings
  // dummy o di seller spam, tipicamente a \u20ac0.02\u2013\u20ac0.10.
  //
  // Regole:
  //   - 1-2 listings TUTTI a \u20ac0.10 o sotto \u2192 quasi sicuramente fake/sbagliata
  //   - 3+ listings con maxPrice<\u20ac0.50 e \u226550% a \u20ac0.10 \u2192 vetrina spam
  //
  // Falsi positivi possibili: carte ultracommon (es. Energy basic 1\u00aa edizione)
  // possono avere 1-2 listings legittimi a \u20ac0.10. Il rischio \u00e8 accettabile:
  // il fallback variants tenter\u00e0 comunque V1/V2 e se restituisce listings veri
  // li userà; altrimenti l'utente vede errore esplicito e inserisce manuale.
  function _isFakeCmListings(listings){
    if(!listings || !listings.length) return false;
    var maxP = 0, cents10 = 0, allLow = true;
    for(var i=0; i<listings.length; i++){
      var p = +listings[i].price;
      if(p > maxP) maxP = p;
      if(p > 0.10) allLow = false;
      if(Math.abs(p - 0.10) < 0.01 || p < 0.10) cents10++;
    }
    // Pattern 1: 1-2 listings totali, tutti \u2264 \u20ac0.10 \u2192 fake
    if(listings.length <= 2 && allLow) return true;
    // Pattern 2: 3+ listings, max <\u20ac0.50, almeno 50% a \u20ac0.10 \u2192 vetrina
    if(listings.length >= 3 && maxP < 0.50 && (cents10/listings.length) >= 0.50) return true;
    return false;
  }

  // Espongo i parametri usati per il calcolo dell'URL primary nei tentativi —
  // utile per diagnosticare casi dove la rarity ricevuta dalla TCG API non
  // \u00e8 quella che ci si aspetta e _cmPrimaryVersionFor sceglie la versione
  // sbagliata.
  var primaryV = _cmPrimaryVersionFor(setId, variant, rarity, name);
  attempts.push({
    url:'(meta)',
    kind:'CALC',
    count:0,
    error:'name="'+name+'" setId="'+(setId||'?')+'" rarity="'+(rarity||'\u2205')+'" variant="'+variant+'" \u2192 primaryV="'+(primaryV||'no-V')+'"',
  });

  // Traccia stato dei tentativi: pagina d'errore "Prodotto sbagliato" e blocco
  // Cloudflare sulla pagina PRIMARIA (quella con lo slug corretto).
  var sawWrongProduct = false;
  var primaryBlocked = false;

  var srv = await _vpServerSideCMScrape(cmUrl);

  // Retry SULLO STESSO URL se la pagina corretta è bloccata da Cloudflare (403).
  // Il blocco CM è probabilistico (stesso edge, IP diverso/timing): un retry ha
  // buone chance di passare. NON sostituiamo lo slug — la pagina è quella giusta,
  // è solo bloccata. (Caso Erika's Gloom: no-V 403 → prima si cadeva su V2, un
  // PRODOTTO DIVERSO a €0.10. Ora si ritenta il no-V corretto.)
  var _blkRetry = 0;
  while(srv.blocked && _blkRetry < 2){
    _blkRetry++;
    attempts.push({url:cmUrl, kind:(isDirect?'L1-base':'L2-search')+' retry'+_blkRetry,
                   count:0, error:srv.error||'bloccato', blocked:true});
    await new Promise(function(r){ setTimeout(r, 600*_blkRetry); });
    srv = await _vpServerSideCMScrape(cmUrl);
  }
  if(srv.blocked) primaryBlocked = true;

  if(srv.wrong_product) sawWrongProduct = true;
  if(_isFakeCmListings(srv.listings)){
    srv = {listings:[], error:'pagina CM probabilmente non valida (vetrina \u20ac0.10)', _fake:true};
  }
  attempts.push({url:cmUrl, kind:(isDirect?'L1-base':'L2-search'), count:(srv.listings||[]).length,
                 error:srv.error||null, wrong_product:!!srv.wrong_product, blocked:!!srv.blocked});

  // Fallback A: ritenta le altre varianti dello slug (V1, V2, no-V) SOLO se la
  // pagina primaria è stata LETTA (HTTP 200) ed è vuota / fake / "Prodotto
  // sbagliato". Se la primaria è BLOCCATA (403), NON cascatiamo: un blocco non
  // significa slug errato, e gli slug V1/V2 sono PRODOTTI DIVERSI — accettarne i
  // prezzi darebbe valori sbagliati (bug Erika's Gloom #45 → €0.10 da V2).
  // Si ferma al PRIMO URL che restituisce listing reali (non-fake, non-wrong, non-bloccato).
  if(isDirect && !isAuthoritative && !primaryBlocked && (!srv.listings || !srv.listings.length)){
    var variants = buildCMDirectUrlVariants(name, setId, number, cond, lang, variant, first1st, setName, rarity);
    variants = variants.filter(function(u){ return u !== cmUrl; });
    for(var i=0; i<variants.length; i++){
      var srvV = await _vpServerSideCMScrape(variants[i]);
      if(srvV.wrong_product) sawWrongProduct = true;
      if(_isFakeCmListings(srvV.listings)){
        srvV = {listings:[], error:'pagina CM probabilmente non valida (vetrina \u20ac0.10)', _fake:true};
      }
      var vKind = variants[i].indexOf('-V1-')>=0 ? 'L1-V1'
                : variants[i].indexOf('-V2-')>=0 ? 'L1-V2'
                : 'L1-noV';
      attempts.push({url:variants[i], kind:vKind, count:(srvV.listings||[]).length,
                     error:srvV.error||null, wrong_product:!!srvV.wrong_product, blocked:!!srvV.blocked});
      // Accetta SOLO listing genuini: non vuoti, non fake, non pagina errore, non bloccati.
      if(srvV.listings && srvV.listings.length && !srvV.wrong_product && !srvV.blocked){
        srv = srvV;
        cmUrl = variants[i];
        break;
      }
    }
  }

  // Fallback B: search URL livello 2 (browse set + searchString). Tentato come
  // ultima spiaggia — anche qui solo se la primaria NON era bloccata (stesso
  // ragionamento: su 403 si ritenta lo slug corretto, non si cambia pagina).
  if(isDirect && !primaryBlocked && (!srv.listings || !srv.listings.length)){
    var searchUrl = buildCMSearchUrl(name, setId, number, cond, lang, variant, first1st, setName);
    if(searchUrl && searchUrl !== cmUrl){
      var srv2 = await _vpServerSideCMScrape(searchUrl);
      if(srv2.wrong_product) sawWrongProduct = true;
      if(_isFakeCmListings(srv2.listings)){
        srv2 = {listings:[], error:'pagina CM probabilmente non valida (vetrina \u20ac0.10)', _fake:true};
      }
      attempts.push({url:searchUrl, kind:'L2-search', count:(srv2.listings||[]).length,
                     error:srv2.error||null, wrong_product:!!srv2.wrong_product, blocked:!!srv2.blocked});
      if(srv2.listings && srv2.listings.length && !srv2.wrong_product && !srv2.blocked){
        srv = srv2;
        cmUrl = searchUrl;
        isDirect = false;  // ora siamo su URL ricerca
      }
    }
  }

  if(!srv.listings || !srv.listings.length){
    var finalErr = primaryBlocked
      ? 'Cloudflare ha bloccato la pagina CM corretta (HTTP 403) dopo i retry \u2014 riprova tra poco o usa lo userscript Tampermonkey. Non applico prezzi da slug alternativi per evitare un prodotto sbagliato.'
      : sawWrongProduct
      ? 'tutte le varianti slug danno "Prodotto sbagliato" su CM \u2014 nessuna pagina prodotto valida trovata'
      : (srv.error || (isDirect ? 'nessun listing trovato' : 'set non supportato per CM diretto'));
    return {
      ok: false,
      error: finalErr,
      listings: [],
      isDirect: isDirect,
      cmUrl: cmUrl,
      wrong_product: sawWrongProduct,
      blocked: primaryBlocked,
      debug: srv.debug,
      attempts: attempts,
    };
  }
  var smart = smartCMPrice(srv.listings, cond);
  var price = (smart && smart.price > 0) ? smart.price : srv.listings[0].price;
  return {
    ok: true,
    price: Math.round(price * 100) / 100,
    listings: srv.listings,
    smart: smart,
    isDirect: isDirect,
    cmUrl: cmUrl,
    attempts: attempts,
  };
}

/* ── Namespace pulito (API nuova, non-breaking) ───────────────────────────── */
var RBCMPrice = (typeof RBCMPrice !== 'undefined' && RBCMPrice) || {};
RBCMPrice.fetch        = fetchCmPriceLive;
RBCMPrice.serverScrape = _vpServerSideCMScrape;
if (typeof window !== 'undefined') window.RBCMPrice = RBCMPrice;
