// ==UserScript==
// @name         RareBlock CM Price Scraper
// @namespace    https://www.rareblock.eu
// @version      2.0
// @description  Legge prezzi listing da Cardmarket e li invia a RareBlock
// @author       RareBlock
// @match        https://www.cardmarket.com/*/Pokemon/Products/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var COND_RANK = {'Mint':1,'Near Mint':2,'Excellent':3,'Good':4,'Light Played':5,'Played':6,'Poor':7,'MT':1,'NM':2,'EX':3,'GD':4,'LP':5,'PL':6,'PO':7};

  function normCond(s) {
    var map = {'mt':'Mint','nm':'Near Mint','ex':'Excellent','gd':'Good','lp':'Light Played','pl':'Played','po':'Poor','mint':'Mint','near mint':'Near Mint','excellent':'Excellent','good':'Good','light played':'Light Played','played':'Played','poor':'Poor'};
    return map[(s||'').toLowerCase().trim()] || null;
  }

  function parsePrice(s) {
    if (!s) return null;
    var c = s.replace(/[€\s]/g,'').trim();
    if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(c)) return parseFloat(c.replace(/\./g,'').replace(',','.'));
    if (/^\d+,\d{2}$/.test(c)) return parseFloat(c.replace(',','.'));
    var n = parseFloat(c.replace(',','.'));
    return isNaN(n) || n <= 0 ? null : n;
  }

  function scrapeListings() {
    var listings = [];

    // Strategia 1: __NEXT_DATA__ JSON (piu affidabile)
    var nd = document.getElementById('__NEXT_DATA__');
    if (nd) {
      try {
        listings = extractFromNextData(JSON.parse(nd.textContent), 0);
        if (listings.length) return listings.sort(function(a,b){return a.price-b.price;}).slice(0,20);
      } catch(e) {}
    }

    // Strategia 2: article-row con selettori specifici CM
    var rows = document.querySelectorAll('.article-row, [class*="articleRow"]');
    rows.forEach(function(row) {
      // Prezzo: ultimo elemento testuale che matcha pattern prezzo
      var priceText = '';
      var allEls = row.querySelectorAll('span, div, td');
      for (var i = allEls.length - 1; i >= 0; i--) {
        var t = (allEls[i].childNodes.length === 1 && allEls[i].childNodes[0].nodeType === 3)
          ? allEls[i].textContent.trim() : '';
        if (/^\d{1,4}[,.]\d{2}\s*€?$/.test(t)) { priceText = t; break; }
      }
      var price = parsePrice(priceText);
      if (!price || price < 0.1) return;

      // Condizione: badge
      var condEl = row.querySelector('[class*="badge"], abbr, [title*="Mint"],[title*="Played"],[title*="Poor"],[title*="Good"],[title*="Excellent"]');
      var condRaw = condEl ? (condEl.getAttribute('title') || condEl.textContent || '').trim() : '';
      var cond = normCond(condRaw) || 'Unknown';
      listings.push({price: Math.round(price*100)/100, condition: cond, condRank: COND_RANK[cond]||5});
    });
    if (listings.length) return listings.sort(function(a,b){return a.price-b.price;}).slice(0,20);

    // Strategia 3: TreeWalker su testo "592,53 €" nell'area principale
    var main = document.querySelector('main, #main, [class*="ProductDetail"], [class*="article-table"]') || document.body;
    var seen = {};
    var walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var t2 = node.textContent.trim();
      if (/^\d{1,4}[,.]\d{2}\s*€?$/.test(t2)) {
        var p = parsePrice(t2);
        if (p && p >= 0.5 && !seen[p]) {
          var par = node.parentElement, skip = false;
          while(par && par !== main){ if(['nav','header','footer'].indexOf(par.tagName.toLowerCase())>=0){skip=true;break;} par=par.parentElement; }
          if(!skip){ seen[p]=true; listings.push({price:p, condition:'Unknown', condRank:5}); }
        }
      }
    }
    return listings.sort(function(a,b){return a.price-b.price;}).slice(0,20);
  }

  function extractFromNextData(obj, depth) {
    if (depth > 12 || !obj || typeof obj !== 'object') return [];
    if (Array.isArray(obj) && obj.length > 0) {
      var first = obj[0];
      if (first && typeof first === 'object' && ('price' in first || 'priceGross' in first || 'sellPrice' in first)) {
        return obj.map(function(a) {
          var raw = a.price || a.priceGross || a.sellPrice || a.minPrice;
          var p = typeof raw === 'number' ? raw : parsePrice(String(raw||''));
          if (!p || p < 0.1) return null;
          var cond = 'Unknown';
          var cs = a.condition || a.cardCondition || a.minCondition;
          if (cs) { var s = typeof cs==='object'?(cs.label||cs.abbreviation||cs.name||''):String(cs); cond = normCond(s)||cond; }
          return {price: Math.round(p*100)/100, condition: cond, condRank: COND_RANK[cond]||5};
        }).filter(Boolean);
      }
      for (var i=0;i<obj.length;i++){var r=extractFromNextData(obj[i],depth+1);if(r.length)return r;}
    } else {
      var keys=Object.keys(obj);
      for(var k=0;k<keys.length;k++){var r2=extractFromNextData(obj[keys[k]],depth+1);if(r2.length)return r2;}
    }
    return [];
  }

  function showOverlay(listings) {
    var el = document.getElementById('rb-overlay');
    if (el) el.remove();
    var div = document.createElement('div');
    div.id = 'rb-overlay';
    div.style.cssText='position:fixed;bottom:20px;right:20px;z-index:999999;background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:14px 18px;min-width:240px;font-family:monospace;font-size:13px;color:#e6edf3;box-shadow:0 8px 32px rgba(0,0,0,.6)';
    div.innerHTML='<div style="font-weight:700;color:#58a6ff;margin-bottom:8px">🟦 RareBlock · '+listings.length+' listing</div>';
    var condShort={'Mint':'MT','Near Mint':'NM','Excellent':'EX','Good':'GD','Light Played':'LP','Played':'PL','Poor':'PO','Unknown':'?'};
    var condColor={1:'#3fb950',2:'#3fb950',3:'#a8f0a8',4:'#d29922',5:'#f0883e',6:'#f47068',7:'#f47068'};
    listings.slice(0,8).forEach(function(l){
      var row=document.createElement('div');
      row.style.cssText='display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #21262d';
      row.innerHTML='<span style="color:'+(condColor[l.condRank]||'#8b949e')+';font-weight:600">'+( condShort[l.condition]||'?')+'</span><span>€ '+l.price.toFixed(2)+'</span>';
      div.appendChild(row);
    });
    var st=document.createElement('div');st.id='rb-st';st.style.cssText='margin-top:8px;font-size:11px;color:#8b949e;text-align:center';st.textContent='Invio...';
    div.appendChild(st);
    document.body.appendChild(div);
    return st;
  }

  function sendPrices(listings, st) {
    var payload={type:'rareblock_cm_prices',prices:listings.map(function(l){return l.price;}),listings:listings,url:location.href};
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(payload,'*');
        if(st){st.textContent='✓ Inviato!';st.style.color='#3fb950';}
        setTimeout(function(){try{window.close();}catch(e){}},1200);
        return;
      } catch(e){}
    }
    if (typeof BroadcastChannel !== 'undefined') {
      try{var bc=new BroadcastChannel('rareblock_prices');bc.postMessage(payload);bc.close();if(st){st.textContent='✓ Broadcast inviato';st.style.color='#3fb950';}}catch(e){}
    }
  }

  function init(attempt) {
    attempt = attempt||0;
    if (attempt>25) return;
    var listings = scrapeListings().filter(function(l){return l.price>=0.5;});
    if (!listings.length) { setTimeout(function(){init(attempt+1);},600); return; }
    console.log('[RareBlock] '+listings.length+' listing trovati:', listings.slice(0,3).map(function(l){return l.condition+' €'+l.price;}));
    var st = showOverlay(listings);
    setTimeout(function(){sendPrices(listings,st);}, 800);
  }

  if(document.readyState==='complete'||document.readyState==='interactive'){setTimeout(init,1200);}
  else{window.addEventListener('load',function(){setTimeout(init,1200);});}

})();
