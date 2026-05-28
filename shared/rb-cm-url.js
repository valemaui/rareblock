/* ============================================================================
 * RareBlock — RB CardMarket URL Engine  (shared/rb-cm-url.js)
 * ----------------------------------------------------------------------------
 * MODULO ISOLATO — Livello "URL CardMarket" del Card Engine.
 * Funzioni PURE (solo stringhe): nessun DOM, nessuna rete, nessun Supabase.
 * Estratto verbatim da pokemon-db.html (righe 9092–9570) — logica empirica
 * verificata su CM, NON riscritta. Vedi docs/REFACTOR-CARD-ENGINE.md.
 *
 * VINCOLI CODEBASE (hard):
 *  - NIENTE IIFE: i simboli sono dichiarati top-level (const/function) così
 *    restano nel global lexical environment condiviso tra <script> classici
 *    e i ~30 call-site esistenti continuano a funzionare senza modifiche.
 *  - Caricare QUESTO file PRIMA dello <script> inline di pokemon-db.html.
 *    Le stesse const NON devono essere ridichiarate altrove (redeclare di un
 *    const top-level = SyntaxError che uccide l'intero contesto JS).
 *
 * API pubblica (namespace RBCM, oltre ai nomi globali retro-compatibili):
 *   RBCM.buildCMDirectUrl(name,setId,number,cond,lang,variant,first1st,setName,rarity,cmUrlOverride)
 *   RBCM.buildCMSearchUrl(...)            → solo URL livello 2 (browse+searchString)
 *   RBCM.buildCMDirectUrlVariants(...)    → varianti no-V/V1/V2 per set ambigui
 *   RBCM.cmAuthoritativeUrl(card)         → URL autoritativo TCG API (cardmarket.com only)
 *   RBCM.cmAppendParams(url,cond,lang,variant,first1st)
 *   RBCM.buildCardmarketSlug(name)
 *   RBCM.maps = { SET_SLUG, SET_ABBREV, SET_NAME_TO_ID, LANG_ID, COND_ID,
 *                 DIRECT_SETS, AMBIGUOUS_VERSION_SETS }
 * ==========================================================================*/

const CM_SET_SLUG={
  // Base sets
  'base1':'Base-Set','base2':'Jungle','base3':'Fossil','base4':'Base-Set-2',
  'base5':'Team-Rocket','base6':'Legendary-Collection',
  'gym1':'Gym-Heroes','gym2':'Gym-Challenge',
  'neo1':'Neo-Genesis','neo2':'Neo-Discovery','neo3':'Neo-Revelation','neo4':'Neo-Destiny',
  'si1':'Southern-Islands',
  // E-Card
  'ecard1':'Expedition-Base-Set','ecard2':'Aquapolis','ecard3':'Skyridge',
  // EX series
  'ex1':'EX-Ruby-Sapphire','ex2':'EX-Sandstorm','ex3':'EX-Dragon',
  'ex4':'EX-Team-Magma-vs-Team-Aqua','ex5':'EX-Hidden-Legends',
  'ex6':'EX-FireRed-LeafGreen','ex7':'EX-Team-Rocket-Returns',
  'ex8':'EX-Deoxys','ex9':'EX-Emerald','ex10':'EX-Unseen-Forces',
  'ex11':'EX-Delta-Species','ex12':'EX-Legend-Maker',
  'ex13':'EX-Holon-Phantoms','ex14':'EX-Crystal-Guardians',
  'ex15':'EX-Dragon-Frontiers','ex16':'EX-Power-Keepers',
  // DP
  'dp1':'Diamond-Pearl','dp2':'Mysterious-Treasures','dp3':'Secret-Wonders',
  'dp4':'Great-Encounters','dp5':'Majestic-Dawn','dp6':'Legends-Awakened',
  'dp7':'Stormfront',
  // Platinum
  'pl1':'Platinum','pl2':'Rising-Rivals','pl3':'Supreme-Victors','pl4':'Arceus',
  // HGSS
  'hgss1':'HeartGold-SoulSilver','hgss2':'Unleashed','hgss3':'Undaunted','hgss4':'Triumphant',
  'col1':'Call-of-Legends',
  // BW
  'bw1':'Black-White','bw2':'Emerging-Powers','bw3':'Noble-Victories',
  'bw4':'Next-Destinies','bw5':'Dark-Explorers','bw6':'Dragons-Exalted',
  'bw7':'Boundaries-Crossed','bw8':'Plasma-Storm','bw9':'Plasma-Freeze',
  'bw10':'Plasma-Blast','bw11':'Legendary-Treasures',
  // XY
  'xy1':'XY','xy2':'Flashfire','xy3':'Furious-Fists','xy4':'Phantom-Forces',
  'xy5':'Primal-Clash','xy6':'Roaring-Skies','xy7':'Ancient-Origins',
  'xy8':'BREAKthrough','xy9':'BREAKpoint','xy10':'Fates-Collide',
  'xy11':'Steam-Siege','xy12':'Evolutions',
  // SM
  'sm1':'Sun-Moon','sm2':'Guardians-Rising','sm3':'Burning-Shadows',
  'sm4':'Crimson-Invasion','sm5':'Ultra-Prism','sm6':'Forbidden-Light',
  'sm7':'Celestial-Storm','sm8':'Lost-Thunder','sm9':'Team-Up',
  'sm10':'Unbroken-Bonds','sm11':'Unified-Minds','sm12':'Cosmic-Eclipse',
  // SWSH
  'swsh1':'Sword-Shield','swsh2':'Rebel-Clash','swsh3':'Darkness-Ablaze',
  'swsh4':'Vivid-Voltage','swsh5':'Battle-Styles','swsh6':'Chilling-Reign',
  'swsh7':'Evolving-Skies','swsh8':'Fusion-Strike','swsh9':'Brilliant-Stars',
  'swsh10':'Astral-Radiance','swsh11':'Lost-Origin','swsh12':'Silver-Tempest',
  'swsh12pt5':'Crown-Zenith',
  // SV
  'sv1':'Scarlet-Violet','sv2':'Paldea-Evolved','sv3':'Obsidian-Flames',
  'sv3pt5':'151','sv4':'Paradox-Rift','sv4pt5':'Paldean-Fates',
  'sv5':'Temporal-Forces','sv6':'Twilight-Masquerade','sv6pt5':'Shrouded-Fable',
  'sv7':'Stellar-Crown','sv7pt5':'Surging-Sparks','sv8':'Prismatic-Evolutions',
  // Promos
  'basep':'Wizards-Black-Star-Promos','np':'Nintendo-Black-Star-Promos',
  'dp':'DP-Black-Star-Promos','pl':'Platinum-Black-Star-Promos',
  'hsp':'HGSS-Black-Star-Promos','bwp':'BW-Black-Star-Promos',
  'xyp':'XY-Black-Star-Promos','smp':'SM-Black-Star-Promos',
  'swshp':'SWSH-Black-Star-Promos','svp':'SV-Black-Star-Promos',
};

function buildCardmarketSlug(name){
  return name
    .replace(/♀/g,'F').replace(/♂/g,'M')
    .replace(/[àáâãä]/g,'a').replace(/[èéêëẽ]/g,'e')
    .replace(/[ìíîï]/g,'i').replace(/[òóôõöø]/g,'o')
    .replace(/[ùúûü]/g,'u').replace(/[ñ]/g,'n').replace(/[ç]/g,'c')
    .replace(/[^a-zA-Z0-9\s-]/g,'')
    .trim().replace(/\s+/g,'-');
}

// ID lingua Cardmarket (?language=N)
// 1=EN 2=FR 3=DE 4=ES 5=IT 7=JA 8=PT 10=KO
const CM_LANG_ID={'ENG':1,'FRA':2,'DEU':3,'ESP':4,'ITA':5,'JPN':7,'POR':8,'KOR':10};

// ID condizione minima Cardmarket (?minCondition=N)
// 1=MT 2=NM 3=EX 4=GD 5=LP 6=PL 7=PO
const CM_COND_ID={'MINT':1,'NM':2,'EX':3,'GD':4,'LP':5,'PL':6,'PO':7,'INK/ALT':7};

// ─── Risoluzione versione cardSlug primaria per set ambigui ──────────────────
// Una stessa carta in un set "ambiguo" può esistere su CM con 3 prodotti distinti:
//   {Name}-{Abbrev}{N}     (no-V)  → versione standard non-holo
//   {Name}-V1-{Abbrev}{N}  (V1)    → variante "shadowless" o "holo tribute"
//   {Name}-V2-{Abbrev}{N}  (V2)    → variante "Reverse Holo" / "Crystal" / "foil reprint"
//
// Per i set e-Card (Expedition/Aquapolis/Skyridge), CM separa la versione
// non-holo (base) dalla versione Reverse Holo (V2). Su Aquapolis es:
//   Octillery-AQ26    → ~€0.10 (non-holo, poco richiesta)
//   Octillery-V2-AQ26 → €X.XX  (Reverse Holo, quella di mercato)
// Tutte le carte di rarity "Rare" (inclusa Rare Holo) hanno una controparte
// Reverse Holo che è la versione standard di interesse collezionistico.
//
// Discriminiamo in base a rarity (TCG API) + variant (input utente) per
// portare dritti alla pagina corretta senza chiamate edge extra.
function _cmPrimaryVersionFor(setId, variant, rarity, name){
  if(!setId) return '';
  var r = (rarity||'').toLowerCase();
  var v = (variant||'').toLowerCase();
  var n = (name||'').toLowerCase();

  // ── e-Card sets (Expedition / Aquapolis / Skyridge) ────────────────────
  // Verificato empiricamente su CM (2026-05-15) per Charizard #39 Expedition:
  //   - /Charizard-EX39    = Rare (versione foil normale)        \u2190 PRINCIPALE
  //   - /Charizard-V2-EX39 = Reverse Holo (variante con foil-on-base) \u2190 SECONDARIA
  // Pokemon TCG API ritorna rarity="Rare" per #39 (anche se la stessa carta
  // ha la sua Reverse Holo come variante). La V2 \u00e8 sempre la versione
  // Reverse Holo, mai la principale. Listings a \u20ac0.10 su V2-EX39 sono
  // venditori-spam, non outlier da analizzare.
  //
  // Strategia conservativa: SEMPRE no-V come default. V2 solo se l'utente
  // specifica esplicitamente variant=Reverse Holo. I fallback variants
  // (buildCMDirectUrlVariants) gestiscono i casi dove no-V non ha listings
  // e bisogna tentare V1/V2 alternative.
  if(setId === 'ecard1' || setId === 'ecard2' || setId === 'ecard3'){
    // Variant esplicito \u2192 rispetta scelta utente
    if(v === 'reverse holo') return 'V2';
    if(v === 'holo') return 'V2';
    if(v === 'shadowless') return 'V1';
    // Default per TUTTI: no-V (versione principale/base della carta)
    return '';
  }

  // xy12 Evolutions: V1 \u00e8 la holo reprint stile Base Set
  if(setId === 'xy12'){
    if(v === 'holo' || v === 'reverse holo') return 'V1';
    if(r.indexOf('rare holo') >= 0) return 'V1';
    return '';
  }

  // Base Set: V1 = Shadowless (raro), no-V = Unlimited (default)
  if(setId === 'base1'){
    if(v === 'shadowless') return 'V1';
    return '';
  }

  // ── WotC non-Base (Jungle, Fossil, Team Rocket, Legendary Coll, Gym H&C) ──
  // Verificato empiricamente su CM (2026-05-15):
  //   Gengar #5 Fossil Rare Holo  \u2192 /Fossil/Gengar-V1-FO5  (256 listings, trend \u20ac157)
  //   Gengar #20 Fossil Rare      \u2192 /Fossil/Gengar-V2-FO20 (391 listings, trend \u20ac33)
  // Pattern: in questi set CM separa la versione "holo principale" (V1) dalla
  // versione "non-holo" / "reverse" (V2). Le Common e Uncommon stanno sotto
  // no-V (URL diretto senza prefix).
  //
  // Discriminazione rarity:
  //   Rare Holo / Rare Holo LV.X / Rare Holo ex   \u2192 V1
  //   Rare (no holo) / Rare Secret / Rare Shining \u2192 V2
  //   Common / Uncommon                            \u2192 no-V
  if(setId === 'base2' || setId === 'base3' || setId === 'base5' || setId === 'base6'
     || setId === 'gym1' || setId === 'gym2'){
    if(v === 'holo' || v === 'reverse holo') return 'V1';
    if(r.indexOf('rare holo') >= 0) return 'V1';
    if(r === 'rare' || (r.indexOf('rare') >= 0 && r.indexOf('holo') < 0)) return 'V2';
    return '';  // Common/Uncommon
  }

  return '';
}

// Formato slug carta varia per set:
//   Base Set:  Charizard-V1-BS4   (shadowless vs unlimited → CM usa versioni)
//   Tutti gli altri: Zubat-FO57, Dark-Charizard-TR4, Lugia-NG9, ecc.
// Codici abbreviazione Cardmarket VERIFICATI navigando le pagine reali
// Formato slug: {NameSlug}-{Code}{Number} es. Zubat-FO57, Reshiram-BLW26
// Nota: DP (dp1-dp7) e Platinum (pl1-pl4) hanno "Lv.XX" nello slug → non costruibili
// SWSH e SV usano versioni V1/V2/V3 → non costruibili
const CM_SET_ABBREV={
  // WotC Base — verificati
  'base1':'BS','base2':'JU','base3':'FO','base4':'B2','base5':'TR','base6':'LC',
  'gym1':'GH','gym2':'GC',
  'neo1':'NG','neo2':'ND','neo3':'NR','neo4':'NDE',
  'si1':'SI',
  // E-Card — verificati. Aquapolis e Skyridge usano pattern V1/V2/no-V
  // imprevedibile (dipende dalla carta specifica). Expedition usa EX (non EXP)
  // e ha lo stesso problema V1/V2. Per questo li teniamo OUT da CM_DIRECT_SETS:
  // l'abbrev serve comunque per il livello 2 (browse + searchString).
  'ecard1':'EX','ecard2':'AQ','ecard3':'SK',
  // EX series — verificati
  'ex1':'RS','ex2':'SS','ex3':'DR','ex4':'MA','ex5':'HL',
  'ex6':'FL','ex7':'TRR','ex8':'DX','ex9':'EM','ex10':'UF',
  'ex11':'DS','ex12':'LM','ex13':'HP','ex14':'CG','ex15':'DF','ex16':'PK',
  // HGSS — verificati
  'hgss1':'HS','hgss2':'UL','hgss3':'UD','hgss4':'TM','col1':'CL',
  // BW — verificati
  'bw1':'BLW','bw2':'EPO','bw3':'NVI','bw4':'NXD','bw5':'DEX','bw6':'DRX',
  'bw7':'BCR','bw8':'PLS','bw9':'PLF','bw10':'PLB','bw11':'LTR',
  // XY — slug tipo: Charizard-EX-FlashXY11 → non affidabile, usiamo livello 2
  // SM — slug tipo: Charizard-GX-BurnSM35 → non affidabile, usiamo livello 2
  // SWSH e SV — versioni V1/V2/V3 → non costruibili deterministicamente
  // MA i codici servono per il livello 2 (browse set)
  'xy1':'XY','xy2':'FLF','xy3':'FFI','xy4':'PHF','xy5':'PRC','xy6':'ROS',
  'xy7':'AOR','xy8':'BKT','xy9':'BKP','xy10':'FCO','xy11':'STS','xy12':'EVO',
  'sm1':'SUM','sm2':'GRI','sm3':'BUS','sm4':'CIN','sm5':'UPR','sm6':'FLI',
  'sm7':'CES','sm8':'LOT','sm9':'TEU','sm10':'UNB','sm11':'UNM','sm12':'CEC',
  'swsh1':'SSH','swsh2':'RCL','swsh3':'DAA','swsh4':'VIV','swsh5':'BST',
  'swsh6':'CRE','swsh7':'EVS','swsh8':'FST','swsh9':'BRS','swsh10':'ASR',
  'swsh11':'LOR','swsh12':'SIT','swsh12pt5':'CRZ',
  'sv1':'SVI','sv2':'PAL','sv3':'OBF','sv3pt5':'MEW','sv4':'PAR','sv4pt5':'PAF',
  'sv5':'TEF','sv6':'TWM','sv6pt5':'SFA','sv7':'SCR','sv7pt5':'SSP',
  'sv8':'PRE','sv9':'DRI',
  // Promos — solo np ha pattern URL diretto stabile e prevedibile (numero puramente numerico)
  // Altri promo (basep/dp/pl/hsp/bwp/xyp/smp/swshp/svp) hanno pattern inconsistenti
  // o varianti V1/V2/V3 → restano su livello 2 (browse + searchString)
  'np':'NP',
};

// Set per cui possiamo costruire URL diretto affidabile
// Esclusi: DP (livelli), Platinum (livelli), XY-SV (versioni V1/V2/V3)
// Inclusi con fallback livello 2 in fetchCmPriceLive: ecard1/ecard2/ecard3
// (Expedition, Aquapolis, Skyridge). La maggior parte delle carte usa pattern
// semplice {NameSlug}-{EX|AQ|SK}{N} (es. Dual-Ball-EX139, Primeape-AQ29).
// Le poche carte holo con V1/V2 irregolare vengono recuperate via retry L2
// (browse + searchString) dentro fetchCmPriceLive.
const CM_DIRECT_SETS = new Set([
  // WotC
  'base1','base2','base3','base4','base5','base6',
  'gym1','gym2',
  'neo1','neo2','neo3','neo4','si1',
  // E-Card
  'ecard1','ecard2','ecard3',
  // EX
  'ex1','ex2','ex3','ex4','ex5','ex6','ex7','ex8',
  'ex9','ex10','ex11','ex12','ex13','ex14','ex15','ex16',
  // HGSS
  'hgss1','hgss2','hgss3','hgss4','col1',
  // BW
  'bw1','bw2','bw3','bw4','bw5','bw6',
  'bw7','bw8','bw9','bw10','bw11',
  // XY — solo Evolutions (xy12) ha pattern V1 stabile (tribute set di Base):
  //  • Charizard EVO11 → Charizard-V1-EVO11
  //  Le altre carte XY (EX/Mega/etc.) hanno suffissi imprevedibili, restano L2.
  'xy12',
  // Promos
  'np',
]);

// Reverse mapping: nome set (da TCG API/item salvato) → set ID
// Usato per costruire URL CM da item OLD senza set_id salvato
const CM_SET_NAME_TO_ID={
  'Base Set':'base1','Jungle':'base2','Fossil':'base3','Base Set 2':'base4',
  'Team Rocket':'base5','Legendary Collection':'base6',
  'Gym Heroes':'gym1','Gym Challenge':'gym2',
  'Neo Genesis':'neo1','Neo Discovery':'neo2','Neo Revelation':'neo3','Neo Destiny':'neo4',
  'Southern Islands':'si1',
  'Expedition Base Set':'ecard1','Aquapolis':'ecard2','Skyridge':'ecard3',
  'EX Ruby & Sapphire':'ex1','EX Sandstorm':'ex2','EX Dragon':'ex3',
  'EX Team Magma vs Team Aqua':'ex4','EX Hidden Legends':'ex5',
  'EX FireRed & LeafGreen':'ex6','EX Team Rocket Returns':'ex7',
  'EX Deoxys':'ex8','EX Emerald':'ex9','EX Unseen Forces':'ex10',
  'EX Delta Species':'ex11','EX Legend Maker':'ex12','EX Holon Phantoms':'ex13',
  'EX Crystal Guardians':'ex14','EX Dragon Frontiers':'ex15','EX Power Keepers':'ex16',
  'Diamond & Pearl':'dp1','Mysterious Treasures':'dp2','Secret Wonders':'dp3',
  'Great Encounters':'dp4','Majestic Dawn':'dp5','Legends Awakened':'dp6','Stormfront':'dp7',
  'Platinum':'pl1','Rising Rivals':'pl2','Supreme Victors':'pl3','Arceus':'pl4',
  'HeartGold & SoulSilver':'hgss1','Unleashed':'hgss2','Undaunted':'hgss3',
  'Triumphant':'hgss4','Call of Legends':'col1',
  'Black & White':'bw1','Emerging Powers':'bw2','Noble Victories':'bw3',
  'Next Destinies':'bw4','Dark Explorers':'bw5','Dragons Exalted':'bw6',
  'Boundaries Crossed':'bw7','Plasma Storm':'bw8','Plasma Freeze':'bw9',
  'Plasma Blast':'bw10','Legendary Treasures':'bw11',
  'XY':'xy1','Flashfire':'xy2','Furious Fists':'xy3','Phantom Forces':'xy4',
  'Primal Clash':'xy5','Roaring Skies':'xy6','Ancient Origins':'xy7',
  'BREAKthrough':'xy8','BREAKpoint':'xy9','Fates Collide':'xy10',
  'Steam Siege':'xy11','Evolutions':'xy12',
  'Sun & Moon':'sm1','Guardians Rising':'sm2','Burning Shadows':'sm3',
  'Crimson Invasion':'sm4','Ultra Prism':'sm5','Forbidden Light':'sm6',
  'Celestial Storm':'sm7','Lost Thunder':'sm8','Team Up':'sm9',
  'Unbroken Bonds':'sm10','Unified Minds':'sm11','Cosmic Eclipse':'sm12',
  'Sword & Shield':'swsh1','Rebel Clash':'swsh2','Darkness Ablaze':'swsh3',
  'Vivid Voltage':'swsh4','Battle Styles':'swsh5','Chilling Reign':'swsh6',
  'Evolving Skies':'swsh7','Fusion Strike':'swsh8','Brilliant Stars':'swsh9',
  'Astral Radiance':'swsh10','Lost Origin':'swsh11','Silver Tempest':'swsh12',
  'Crown Zenith':'swsh12pt5',
  'Scarlet & Violet':'sv1','Paldea Evolved':'sv2','Obsidian Flames':'sv3',
  '151':'sv3pt5','Paradox Rift':'sv4','Paldean Fates':'sv4pt5',
  'Temporal Forces':'sv5','Twilight Masquerade':'sv6','Shrouded Fable':'sv6pt5',
  'Stellar Crown':'sv7','Surging Sparks':'sv7pt5','Prismatic Evolutions':'sv8',
};

// ── SOLUZIONE DEFINITIVA: URL Cardmarket autoritativo dalla TCG API ──
// La Pokémon TCG API restituisce per ogni carta il campo cardmarket.url, che
// è l'URL ESATTO del prodotto su cardmarket.com (es. .../Singles/Expedition-Base-Set/
// Venusaur-V2-EX68). Questo elimina ogni guessing di slug/abbreviazione/versione.
// Quando disponibile, lo usiamo direttamente appendendo solo i parametri filtro
// (lingua / condizione minima / prima edizione / reverse holo).
//
// Appende i parametri filtro a un URL prodotto Cardmarket già valido.
// Gestisce sia URL puliti che URL che già contengono query string.
function cmAppendParams(baseUrl, cond, lang, variant, first1st){
  if(!baseUrl) return null;
  try{
    // Forza il dominio italiano (la TCG API può restituire /en/). Manteniamo il path.
    var u=baseUrl.replace(/cardmarket\.com\/[a-z]{2}\//i,'cardmarket.com/it/');
    var hasQ=u.indexOf('?')>=0;
    var params=new URLSearchParams();
    params.set('language',     CM_LANG_ID[lang||'ITA'] || 5);
    params.set('minCondition', CM_COND_ID[cond||'NM']  || 2);
    if(variant==='Reverse Holo') params.set('isReverseHolo','Y');
    params.set('isFirstEd', first1st ? 'Y' : 'N');
    return u + (hasQ?'&':'?') + params.toString();
  }catch(e){ return baseUrl; }
}

// Estrae l'URL autoritativo da un oggetto carta (TCG API) o da un record salvato.
// Cerca in: card.cardmarket.url (TCG API live), card.cm_url (record salvato),
// card.cardmarketUrl (alias). Ritorna null se non disponibile.
//
// FILTRO 'cardmarket.com only': la TCG API ritorna spesso card.cardmarket.url
// come URL mirror su prices.pokemontcg.io (es. https://prices.pokemontcg.io/
// cardmarket/ecard1-103). Quel dominio è dietro Cloudflare strict e blocca
// sistematicamente le richieste server-side → smooth-endpoint fa 4 retry da
// ~8s ciascuno = 33s totali per fallire. Accettiamo come autoritativo SOLO
// gli URL diretti cardmarket.com (in qualunque lingua /it/, /en/, /de/, ...):
// per gli altri torniamo null e si cade sulla cascata di ricostruzione client-
// side (buildCMDirectUrl livelli 1/2/3) che storicamente funziona meglio per
// lo scraping su www.cardmarket.com.
// Effetto secondario benefico: i nuovi insert col cm_url salvato via questa
// funzione conterranno solo URL veri cardmarket.com — il DB non si sporca più
// con URL mirror inutili.
function _isAuthoritativeCMUrl(u){
  if(!u || typeof u !== 'string') return false;
  return /^https?:\/\/(?:www\.)?cardmarket\.com\//i.test(u);
}
function cmAuthoritativeUrl(card){
  if(!card) return null;
  var u = (card.cardmarket && card.cardmarket.url)
       || card.cm_url
       || card.cardmarketUrl
       || null;
  return _isAuthoritativeCMUrl(u) ? u : null;
}

// Costruisce URL alla pagina prodotto Cardmarket con filtri lingua/condizione/ed.
// Accetta sia setId (TCG API ID) che setName (nome del set) come fallback per item vecchi
// L'ultimo parametro `rarity` è opzionale (retro-compat): permette di scegliere
// la versione corretta dei set ambigui (V1/V2/no-V) senza ricorrere alla cascata.
// Il parametro `cmUrlOverride` (se passato) ha PRECEDENZA ASSOLUTA: è l'URL
// autoritativo dalla TCG API, quindi salta tutto il guessing.
// Strategia a cascata:
//  0. URL autoritativo TCG API (cmUrlOverride) → usato direttamente
//  1. Pagina prodotto diretta: /Singles/{SetSlug}/{NameSlug}[-V1|V2-]{SetAbbrev}{Number}
//  2. Browse set filtrato per nome: /Singles/{SetSlug}?searchString={Name}
//  3. Ricerca generica: /Products/Search?searchString={Name}
function buildCMDirectUrl(name, setId, number, cond, lang, variant, first1st, setName, rarity, cmUrlOverride){
  // Livello 0: URL autoritativo dalla TCG API → precedenza assoluta.
  // NB: filtriamo cmUrlOverride con _isAuthoritativeCMUrl (cardmarket.com only)
  // anche qui, oltre che in cmAuthoritativeUrl. Difesa-in-profondità: alcuni
  // call site passano direttamente c.cm_url (record salvato) e in DB ci sono
  // ancora URL mirror prices.pokemontcg.io scritti dai primi insert post-fix
  // del 24 mag. Senza questo controllo entreremmo nel ramo override con un URL
  // che server-side dà 33s di retry+403 (vedi note in _isAuthoritativeCMUrl).
  if(cmUrlOverride && _isAuthoritativeCMUrl(cmUrlOverride)){
    var authUrl=cmAppendParams(cmUrlOverride, cond, lang, variant, first1st);
    if(authUrl) return authUrl;
  }
  // Risolvi setId: usa quello fornito, poi prova dal nome del set
  const resolvedSetId = setId || CM_SET_NAME_TO_ID[setName||''] || null;
  const setSlug   = CM_SET_SLUG[resolvedSetId]   || null;
  const setAbbrev = CM_SET_ABBREV[resolvedSetId] || null;
  const nameSlug  = buildCardmarketSlug(name || '');

  const params = new URLSearchParams();
  params.set('language',     CM_LANG_ID[lang||'ITA'] || 5);
  params.set('minCondition', CM_COND_ID[cond||'NM']  || 2);
  if(variant==='Reverse Holo') params.set('isReverseHolo','Y');
  params.set('isFirstEd', first1st ? 'Y' : 'N');
  const qs = params.toString();

  // Livello 1: URL diretto SOLO per set con codici verificati su CM
  if(setSlug && setAbbrev && nameSlug && number && CM_DIRECT_SETS.has(resolvedSetId)){
    // Numero ripulito: rimuovi suffisso "/totale" e zeri leading
    // Es: "26" → "26", "01" → "1", "26/40" → "26", "001" → "1"
    const numClean = (number+'').split('/')[0].replace(/^0+/, '') || '0';
    // Versione primaria basata su rarity + variant + name (es. ecard2 Rare Holo \u2192 V2,
    // ecard1 Darkness Energy \u2192 no-V perch\u00e9 energie sono caso speciale)
    const primaryV = _cmPrimaryVersionFor(resolvedSetId, variant, rarity, name);
    const versionPrefix = primaryV ? '-'+primaryV+'-' : '-';
    const cardSlug = nameSlug + versionPrefix + setAbbrev + numClean;
    return 'https://www.cardmarket.com/it/Pokemon/Products/Singles/'+setSlug+'/'+cardSlug+'?'+qs;
  }

  // Livello 2: browse set + ricerca per nome
  // Se abbiamo il numero, cercarlo nel nome migliora la precisione (es "Charizard 4/102")
  if(setSlug && nameSlug){
    const searchStr = number
      ? name + ' ' + (number+'').split('/')[0]  // "Charizard 4" → trova più facilmente
      : name;
    return 'https://www.cardmarket.com/it/Pokemon/Products/Singles/'+setSlug
      +'?searchString='+encodeURIComponent(searchStr)+'&'+qs;
  }

  // Livello 3: ricerca globale con nome e numero
  const globalSearch = number ? name+' '+(number+'').split('/')[0] : name;
  return 'https://www.cardmarket.com/it/Pokemon/Products/Search?category=-1'
    +'&searchString='+encodeURIComponent(globalSearch)+'&searchMode=v2&'+qs;
}

// Costruisce SOLO l'URL livello 2 (browse set + searchString).
// Usato come fallback quando il livello 1 (URL diretto) ritorna 0 listings:
// es. carte e-Card con pattern V1/V2 imprevedibile dove il /Singles/{SetSlug}/{cardSlug}
// è 404 ma /Singles/{SetSlug}?searchString= trova comunque la carta.
function buildCMSearchUrl(name, setId, number, cond, lang, variant, first1st, setName){
  const resolvedSetId = setId || CM_SET_NAME_TO_ID[setName||''] || null;
  const setSlug   = CM_SET_SLUG[resolvedSetId] || null;
  const nameSlug  = buildCardmarketSlug(name || '');
  if(!setSlug || !nameSlug) return null;

  const params = new URLSearchParams();
  params.set('language',     CM_LANG_ID[lang||'ITA'] || 5);
  params.set('minCondition', CM_COND_ID[cond||'NM']  || 2);
  if(variant==='Reverse Holo') params.set('isReverseHolo','Y');
  params.set('isFirstEd', first1st ? 'Y' : 'N');

  const searchStr = number ? name+' '+(number+'').split('/')[0] : name;
  return 'https://www.cardmarket.com/it/Pokemon/Products/Singles/'+setSlug
    +'?searchString='+encodeURIComponent(searchStr)+'&'+params.toString();
}

// Set in cui le carte possono avere pattern slug irregolare V1/V2/no-V mescolati:
// es. Expedition ha "Venusaur-EX67" (no-V) accanto a "Venusaur-V1-EX30" e "Venusaur-V2-EX68".
// Per questi set, fetchCmPriceLive ritenta in cascata se il primo URL fallisce.
// Gli altri set in CM_DIRECT_SETS hanno pattern stabile → un solo tentativo basta.
const CM_AMBIGUOUS_VERSION_SETS = new Set([
  'base1',                              // Base Set (Shadowless vs Unlimited via V1/V2)
  'ecard1','ecard2','ecard3',           // Expedition, Aquapolis, Skyridge (holo reprint via V1/V2)
  'xy12',                               // Evolutions (Base tribute, alcune holo V1)
  // Neo sets: alcune Common hanno V1/V2 quando hanno pi\u00f9 versioni nel set
  //   (es. Totodile-V1-NG81 vs Totodile-NG80, entrambi Totodile in Neo Genesis).
  //   La numerazione TCG API corrisponde al print order; su CM la stessa carta
  //   pu\u00f2 essere a "no-V" (versione primaria) o "V1" (variante).
  'neo1','neo2','neo3','neo4',          // Neo Genesis, Discovery, Revelation, Destiny
  // WotC altri set con varianti note: Jungle/Fossil/Team Rocket usano "V1" per
  //   tutte le carte (verificato empiricamente). Aggiunto anche Gym Heroes/Challenge.
  'base2','base3','base5','base6',      // Jungle, Fossil, Team Rocket, Legendary Coll
  'gym1','gym2',                        // Gym Heroes, Gym Challenge
  // EX series: pattern stabile in maggioranza ma qualche edge case con V1/V2
  //   per le carte ristampate. Safe-add al fallback.
  'ex1','ex2','ex3','ex4','ex5','ex6','ex7','ex8',
  'ex9','ex10','ex11','ex12','ex13','ex14','ex15','ex16',
  // HGSS series: stessa logica
  'hgss1','hgss2','hgss3','hgss4','col1',
]);

// Costruisce TUTTE le varianti di URL diretto (no-V, V1, V2) per set ambigui.
// Ritorna [] se il set non è ambiguo o mancano dati: in quel caso basta un solo
// tentativo via buildCMDirectUrl. Le varianti sono ordinate con primary first
// in base a _cmPrimaryVersionFor (rarity+variant), così il primo retry è
// quello statisticamente più probabile dato il contesto.
function buildCMDirectUrlVariants(name, setId, number, cond, lang, variant, first1st, setName, rarity){
  const resolvedSetId = setId || CM_SET_NAME_TO_ID[setName||''] || null;
  const setSlug   = CM_SET_SLUG[resolvedSetId]   || null;
  const setAbbrev = CM_SET_ABBREV[resolvedSetId] || null;
  const nameSlug  = buildCardmarketSlug(name || '');

  if(!setSlug || !setAbbrev || !nameSlug || !number || !CM_DIRECT_SETS.has(resolvedSetId)) return [];
  if(!CM_AMBIGUOUS_VERSION_SETS.has(resolvedSetId)) return [];

  const numClean = (number+'').split('/')[0].replace(/^0+/, '') || '0';
  const params = new URLSearchParams();
  params.set('language',     CM_LANG_ID[lang||'ITA'] || 5);
  params.set('minCondition', CM_COND_ID[cond||'NM']  || 2);
  if(variant==='Reverse Holo') params.set('isReverseHolo','Y');
  params.set('isFirstEd', first1st ? 'Y' : 'N');
  const qs = params.toString();

  const slugByVer = {
    '':   nameSlug + '-'    + setAbbrev + numClean,
    'V1': nameSlug + '-V1-' + setAbbrev + numClean,
    'V2': nameSlug + '-V2-' + setAbbrev + numClean,
  };

  // Ordina primary first in base a _cmPrimaryVersionFor, poi le altre due
  const primary = _cmPrimaryVersionFor(resolvedSetId, variant, rarity, name);
  const order = primary === 'V2' ? ['V2', '',   'V1']
              : primary === 'V1' ? ['V1', '',   'V2']
              :                    ['',   'V2', 'V1'];

  return order.map(function(v){
    return 'https://www.cardmarket.com/it/Pokemon/Products/Singles/'+setSlug+'/'+slugByVer[v]+'?'+qs;
  });
}

/* ── Namespace pulito (API nuova, non-breaking) ───────────────────────────── */
var RBCM = (typeof RBCM !== 'undefined' && RBCM) || {};
RBCM.buildCardmarketSlug     = buildCardmarketSlug;
RBCM._cmPrimaryVersionFor    = _cmPrimaryVersionFor;
RBCM.cmAppendParams          = cmAppendParams;
RBCM._isAuthoritativeCMUrl   = _isAuthoritativeCMUrl;
RBCM.cmAuthoritativeUrl      = cmAuthoritativeUrl;
RBCM.buildCMDirectUrl        = buildCMDirectUrl;
RBCM.buildCMSearchUrl        = buildCMSearchUrl;
RBCM.buildCMDirectUrlVariants= buildCMDirectUrlVariants;
RBCM.maps = {
  SET_SLUG:               CM_SET_SLUG,
  SET_ABBREV:             CM_SET_ABBREV,
  SET_NAME_TO_ID:         CM_SET_NAME_TO_ID,
  LANG_ID:                CM_LANG_ID,
  COND_ID:                CM_COND_ID,
  DIRECT_SETS:            CM_DIRECT_SETS,
  AMBIGUOUS_VERSION_SETS: CM_AMBIGUOUS_VERSION_SETS,
};
if (typeof window !== 'undefined') window.RBCM = RBCM;
