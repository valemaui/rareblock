/* ============================================================================
 * RareBlock — RB Card Search Engine  (shared/rb-card-search.js)
 * ----------------------------------------------------------------------------
 * MODULO ISOLATO — Livello "ricerca dati carte" del Card Engine.
 * Unifica due fonti e le normalizza nella stessa forma (TCG API shape):
 *   • Pokémon TCG API (api.pokemontcg.io) via proxy Supabase hyper-endpoint
 *   • TCGdex (api.tcgdex.net) per JP/KO/ZH e come fallback automatico
 * Entry pubblica: rbSearchCards(name, number, setId, lang) → Card[] normalizzate.
 * Estratto verbatim da pokemon-db.html (righe 4199–5126) — NON riscritto.
 * Vedi docs/REFACTOR-CARD-ENGINE.md (Fase 2).
 *
 * VINCOLI CODEBASE (hard):
 *  - NIENTE IIFE: simboli top-level (const/function) nel global lexical env
 *    condiviso → i call-site esistenti (rbSearchCards, ...) restano invariati.
 *  - Caricare DOPO rb-cm-url.js e PRIMA dello <script> inline di pokemon-db.html.
 *  - Le const estratte NON vanno ridichiarate altrove (redeclare = SyntaxError).
 *
 * DIPENDENZE A RUNTIME (risolte a call-time dai global del monolite; in Fase 4
 * diventeranno parametri di init() per il riuso nei frames/):
 *   SUPA_URL, SUPA_KEY, TCG_URL, TCG_KEY, window._rbSession, calcPrice, document
 *
 * API pubblica (namespace RBSearch, oltre ai nomi globali retro-compatibili):
 *   RBSearch.search(name, number, setId, lang)   → alias di rbSearchCards
 *   RBSearch.searchTCGdex(name, number, langCode) → alias di rbSearchTCGdex
 *   RBSearch.fetchTCGDirect(query, pageSize)
 *   RBSearch.itToEn(name)
 *   RBSearch.toTCGShape(card, langCode)           → alias di tcgdexToTCGShape
 * ==========================================================================*/

// Nomi italiani non standard (quelli identici all'inglese non servono)
const IT_EN_MAP = {
  // Gen 1
  'bulbasauro':'bulbasaur','ivysaur':'ivysaur','venusaur':'venusaur',
  'charmander':'charmander','charmeleon':'charmeleon','charizard':'charizard',
  'squirtle':'squirtle','wartortle':'wartortle','blastoise':'blastoise',
  'caterpie':'caterpie','metapod':'metapod','butterfree':'butterfree',
  'weedle':'weedle','kakuna':'kakuna','beedrill':'beedrill',
  'pidgey':'pidgey','pidgeotto':'pidgeotto','pidgeot':'pidgeot',
  'rattata':'rattata','raticate':'raticate',
  'spearow':'spearow','fearow':'fearow',
  'ekans':'ekans','arbok':'arbok',
  'pikachu':'pikachu','raichu':'raichu',
  'sandshrew':'sandshrew','sandslash':'sandslash',
  'nidoran♀':'nidoran♀','nidorina':'nidorina','nidoqueen':'nidoqueen',
  'nidoran♂':'nidoran♂','nidorino':'nidorino','nidoking':'nidoking',
  'clefairy':'clefairy','clefable':'clefable',
  'vulpix':'vulpix','ninetales':'ninetales',
  'jigglypuff':'jigglypuff','wigglytuff':'wigglytuff',
  'zubat':'zubat','golbat':'golbat',
  'oddish':'oddish','gloom':'gloom','vileplume':'vileplume',
  'paras':'paras','parasect':'parasect',
  'venonat':'venonat','venomoth':'venomoth',
  'diglett':'diglett','dugtrio':'dugtrio',
  'meowth':'meowth','persian':'persian',
  'psyduck':'psyduck','golduck':'golduck',
  'mankey':'mankey','primeape':'primeape',
  'growlithe':'growlithe','arcanine':'arcanine',
  'poliwag':'poliwag','poliwhirl':'poliwhirl','poliwrath':'poliwrath',
  'abra':'abra','kadabra':'kadabra','alakazam':'alakazam',
  'machop':'machop','machoke':'machoke','machamp':'machamp',
  'bellsprout':'bellsprout','weepinbell':'weepinbell','victreebel':'victreebel',
  'tentacool':'tentacool','tentacruel':'tentacruel',
  'geodude':'geodude','graveler':'graveler','golem':'golem',
  'ponyta':'ponyta','rapidash':'rapidash',
  'slowpoke':'slowpoke','slowbro':'slowbro',
  'magnemite':'magnemite','magneton':'magneton',
  "farfetch'd":"farfetch'd",
  'doduo':'doduo','dodrio':'dodrio',
  'seel':'seel','dewgong':'dewgong',
  'grimer':'grimer','muk':'muk',
  'shellder':'shellder','cloyster':'cloyster',
  'gastly':'gastly','haunter':'haunter','gengar':'gengar',
  'onix':'onix',
  'drowzee':'drowzee','hypno':'hypno',
  'krabby':'krabby','kingler':'kingler',
  'voltorb':'voltorb','electrode':'electrode',
  'exeggcute':'exeggcute','exeggutor':'exeggutor',
  'cubone':'cubone','marowak':'marowak',
  'hitmonlee':'hitmonlee','hitmonchan':'hitmonchan',
  'lickitung':'lickitung',
  'koffing':'koffing','weezing':'weezing',
  'rhyhorn':'rhyhorn','rhydon':'rhydon',
  'chansey':'chansey',
  'tangela':'tangela',
  'kangaskhan':'kangaskhan',
  'horsea':'horsea','seadra':'seadra',
  'goldeen':'goldeen','seaking':'seaking',
  'staryu':'staryu','starmie':'starmie',
  "mr. mime":"mr. mime",
  'scyther':'scyther','jynx':'jynx','electabuzz':'electabuzz','magmar':'magmar',
  'pinsir':'pinsir','tauros':'tauros',
  'magikarp':'magikarp','gyarados':'gyarados',
  'lapras':'lapras','ditto':'ditto','eevee':'eevee',
  'vaporeon':'vaporeon','jolteon':'jolteon','flareon':'flareon',
  'porygon':'porygon',
  'omanyte':'omanyte','omastar':'omastar',
  'kabuto':'kabuto','kabutops':'kabutops',
  'aerodactyl':'aerodactyl','snorlax':'snorlax',
  'articuno':'articuno','zapdos':'zapdos','moltres':'moltres',
  'dratini':'dratini','dragonair':'dragonair','dragonite':'dragonite',
  'mewtwo':'mewtwo','mew':'mew',
  // Gen 2
  'chikorita':'chikorita','bayleef':'bayleef','meganium':'meganium',
  'cyndaquil':'cyndaquil','quilava':'quilava','typhlosion':'typhlosion',
  'totodile':'totodile','croconaw':'croconaw','feraligatr':'feraligatr',
  'sentret':'sentret','furret':'furret',
  'hoothoot':'hoothoot','noctowl':'noctowl',
  'ledyba':'ledyba','ledian':'ledian',
  'spinarak':'spinarak','ariados':'ariados',
  'crobat':'crobat','chinchou':'chinchou','lanturn':'lanturn',
  'pichu':'pichu','cleffa':'cleffa','igglybuff':'igglybuff','togepi':'togepi','togetic':'togetic',
  'natu':'natu','xatu':'xatu',
  'mareep':'mareep','flaaffy':'flaaffy','ampharos':'ampharos',
  'bellossom':'bellossom','marill':'marill','azumarill':'azumarill',
  'sudowoodo':'sudowoodo','politoed':'politoed',
  'hoppip':'hoppip','skiploom':'skiploom','jumpluff':'jumpluff',
  'aipom':'aipom','sunkern':'sunkern','sunflora':'sunflora',
  'yanma':'yanma','wooper':'wooper','quagsire':'quagsire',
  'espeon':'espeon','umbreon':'umbreon',
  'murkrow':'murkrow','slowking':'slowking','misdreavus':'misdreavus',
  "unown":"unown",'wobbuffet':'wobbuffet',
  'girafarig':'girafarig','pineco':'pineco','forretress':'forretress',
  'dunsparce':'dunsparce','gligar':'gligar',
  'steelix':'steelix','snubbull':'snubbull','granbull':'granbull',
  'qwilfish':'qwilfish','scizor':'scizor','shuckle':'shuckle',
  'heracross':'heracross','sneasel':'sneasel',
  'teddiursa':'teddiursa','ursaring':'ursaring',
  'slugma':'slugma','magcargo':'magcargo',
  'swinub':'swinub','piloswine':'piloswine',
  'corsola':'corsola','remoraid':'remoraid','octillery':'octillery',
  'delibird':'delibird','mantine':'mantine',
  'skarmory':'skarmory','houndour':'houndour','houndoom':'houndoom',
  'kingdra':'kingdra','phanpy':'phanpy','donphan':'donphan',
  'porygon2':'porygon2','stantler':'stantler','smeargle':'smeargle',
  'tyrogue':'tyrogue','hitmontop':'hitmontop',
  'smoochum':'smoochum','elekid':'elekid','magby':'magby',
  'miltank':'miltank','blissey':'blissey',
  'raikou':'raikou','entei':'entei','suicune':'suicune',
  'larvitar':'larvitar','pupitar':'pupitar','tyranitar':'tyranitar',
  'lugia':'lugia','ho-oh':'ho-oh','celebi':'celebi',
  // Gen 3
  'treecko':'treecko','grovyle':'grovyle','sceptile':'sceptile',
  'torchic':'torchic','combusken':'combusken','blaziken':'blaziken',
  'mudkip':'mudkip','marshtomp':'marshtomp','swampert':'swampert',
  'poochyena':'poochyena','mightyena':'mightyena',
  'zigzagoon':'zigzagoon','linoone':'linoone',
  'wurmple':'wurmple','silcoon':'silcoon','beautifly':'beautifly',
  'cascoon':'cascoon','dustox':'dustox',
  'lotad':'lotad','lombre':'lombre','ludicolo':'ludicolo',
  'seedot':'seedot','nuzleaf':'nuzleaf','shiftry':'shiftry',
  'taillow':'taillow','swellow':'swellow',
  'wingull':'wingull','pelipper':'pelipper',
  'ralts':'ralts','kirlia':'kirlia','gardevoir':'gardevoir','gallade':'gallade',
  'surskit':'surskit','masquerain':'masquerain',
  'shroomish':'shroomish','breloom':'breloom',
  'slakoth':'slakoth','vigoroth':'vigoroth','slaking':'slaking',
  'nincada':'nincada','ninjask':'ninjask','shedinja':'shedinja',
  'whismur':'whismur','loudred':'loudred','exploud':'exploud',
  'makuhita':'makuhita','hariyama':'hariyama',
  'azurill':'azurill','nosepass':'nosepass','probopass':'probopass',
  'skitty':'skitty','delcatty':'delcatty',
  'sableye':'sableye','mawile':'mawile',
  'aron':'aron','lairon':'lairon','aggron':'aggron',
  'meditite':'meditite','medicham':'medicham',
  'electrike':'electrike','manectric':'manectric',
  'plusle':'plusle','minun':'minun',
  'volbeat':'volbeat','illumise':'illumise',
  'roselia':'roselia','roserade':'roserade',
  'gulpin':'gulpin','swalot':'swalot',
  'carvanha':'carvanha','sharpedo':'sharpedo',
  'wailmer':'wailmer','wailord':'wailord',
  'numel':'numel','camerupt':'camerupt',
  'torkoal':'torkoal',
  'spoink':'spoink','grumpig':'grumpig',
  'spinda':'spinda',
  'trapinch':'trapinch','vibrava':'vibrava','flygon':'flygon',
  'cacnea':'cacnea','cacturne':'cacturne',
  'swablu':'swablu','altaria':'altaria',
  'zangoose':'zangoose','seviper':'seviper',
  'lunatone':'lunatone','solrock':'solrock',
  'barboach':'barboach','whiscash':'whiscash',
  'corphish':'corphish','crawdaunt':'crawdaunt',
  'baltoy':'baltoy','claydol':'claydol',
  'lileep':'lileep','cradily':'cradily',
  'anorith':'anorith','armaldo':'armaldo',
  'feebas':'feebas','milotic':'milotic',
  'castform':'castform',
  'kecleon':'kecleon',
  'shuppet':'shuppet','banette':'banette',
  'duskull':'duskull','dusclops':'dusclops','dusknoir':'dusknoir',
  'tropius':'tropius',
  'chimecho':'chimecho',
  'absol':'absol',
  'wynaut':'wynaut',
  'snorunt':'snorunt','glalie':'glalie','froslass':'froslass',
  'spheal':'spheal','sealeo':'sealeo','walrein':'walrein',
  'clamperl':'clamperl','huntail':'huntail','gorebyss':'gorebyss',
  'relicanth':'relicanth',
  'luvdisc':'luvdisc',
  'bagon':'bagon','shelgon':'shelgon','salamence':'salamence',
  'beldum':'beldum','metang':'metang','metagross':'metagross',
  'regirock':'regirock','regice':'regice','registeel':'registeel','regigigas':'regigigas',
  'latias':'latias','latios':'latios',
  'kyogre':'kyogre','groudon':'groudon','rayquaza':'rayquaza',
  'jirachi':'jirachi','deoxys':'deoxys',
  // Gen 4
  'turtwig':'turtwig','grotle':'grotle','torterra':'torterra',
  'chimchar':'chimchar','monferno':'monferno','infernape':'infernape',
  'piplup':'piplup','prinplup':'prinplup','empoleon':'empoleon',
  'starly':'starly','staravia':'staravia','staraptor':'staraptor',
  'bidoof':'bidoof','bibarel':'bibarel',
  'kricketot':'kricketot','kricketune':'kricketune',
  'shinx':'shinx','luxio':'luxio','luxray':'luxray',
  'budew':'budew','cherubi':'cherubi','cherrim':'cherrim',
  'buizel':'buizel','floatzel':'floatzel',
  'ambipom':'ambipom',
  'drifloon':'drifloon','drifblim':'drifblim',
  'buneary':'buneary','lopunny':'lopunny',
  'mismagius':'mismagius',
  'honchkrow':'honchkrow',
  'glameow':'glameow','purugly':'purugly',
  'chingling':'chingling',
  'stunky':'stunky','skuntank':'skuntank',
  'bronzor':'bronzor','bronzong':'bronzong',
  'bonsly':'bonsly',
  'mime jr.':'mime jr.',
  'happiny':'happiny',
  'chatot':'chatot',
  'spiritomb':'spiritomb',
  'gible':'gible','gabite':'gabite','garchomp':'garchomp',
  'munchlax':'munchlax',
  'riolu':'riolu','lucario':'lucario',
  'hippopotas':'hippopotas','hippowdon':'hippowdon',
  'skorupi':'skorupi','drapion':'drapion',
  'croagunk':'croagunk','toxicroak':'toxicroak',
  'carnivine':'carnivine',
  'finneon':'finneon','lumineon':'lumineon',
  'mantyke':'mantyke',
  'snover':'snover','abomasnow':'abomasnow',
  'weavile':'weavile',
  'magnezone':'magnezone',
  'lickilicky':'lickilicky',
  'rhyperior':'rhyperior',
  'tangrowth':'tangrowth',
  'electivire':'electivire',
  'magmortar':'magmortar',
  'togekiss':'togekiss',
  'yanmega':'yanmega',
  'leafeon':'leafeon','glaceon':'glaceon','sylveon':'sylveon',
  'gliscor':'gliscor',
  'mamoswine':'mamoswine',
  'porygon-z':'porygon-z',
  'froslass':'froslass',
  'rotom':'rotom',
  'uxie':'uxie','mesprit':'mesprit','azelf':'azelf',
  'dialga':'dialga','palkia':'palkia','giratina':'giratina',
  'cresselia':'cresselia',
  'phione':'phione','manaphy':'manaphy',
  'darkrai':'darkrai',
  'shaymin':'shaymin',
  'arceus':'arceus',
  // Gen 5
  'snivy':'snivy','servine':'servine','serperior':'serperior',
  'tepig':'tepig','pignite':'pignite','emboar':'emboar',
  'oshawott':'oshawott','dewott':'dewott','samurott':'samurott',
  'patrat':'patrat','watchog':'watchog',
  'lillipup':'lillipup','herdier':'herdier','stoutland':'stoutland',
  'purrloin':'purrloin','liepard':'liepard',
  'pansage':'pansage','simisage':'simisage',
  'pansear':'pansear','simisear':'simisear',
  'panpour':'panpour','simipour':'simipour',
  'munna':'munna','musharna':'musharna',
  'pidove':'pidove','tranquill':'tranquill','unfezant':'unfezant',
  'blitzle':'blitzle','zebstrika':'zebstrika',
  'roggenrola':'roggenrola','boldore':'boldore','gigalith':'gigalith',
  'woobat':'woobat','swoobat':'swoobat',
  'drilbur':'drilbur','excadrill':'excadrill',
  'audino':'audino',
  'timburr':'timburr','gurdurr':'gurdurr','conkeldurr':'conkeldurr',
  'tympole':'tympole','palpitoad':'palpitoad','seismitoad':'seismitoad',
  'throh':'throh','sawk':'sawk',
  'sewaddle':'sewaddle','swadloon':'swadloon','leavanny':'leavanny',
  'venipede':'venipede','whirlipede':'whirlipede','scolipede':'scolipede',
  'cottonee':'cottonee','whimsicott':'whimsicott',
  'petilil':'petilil','lilligant':'lilligant',
  'basculin':'basculin',
  'sandile':'sandile','krokorok':'krokorok','krookodile':'krookodile',
  'darumaka':'darumaka','darmanitan':'darmanitan',
  'maractus':'maractus',
  'dwebble':'dwebble','crustle':'crustle',
  'scraggy':'scraggy','scrafty':'scrafty',
  'sigilyph':'sigilyph',
  'yamask':'yamask','cofagrigus':'cofagrigus',
  'tirtouga':'tirtouga','carracosta':'carracosta',
  'archen':'archen','archeops':'archeops',
  'trubbish':'trubbish','garbodor':'garbodor',
  'zorua':'zorua','zoroark':'zoroark',
  'minccino':'minccino','cinccino':'cinccino',
  'gothita':'gothita','gothorita':'gothorita','gothitelle':'gothitelle',
  'solosis':'solosis','duosion':'duosion','reuniclus':'reuniclus',
  'ducklett':'ducklett','swanna':'swanna',
  'vanillite':'vanillite','vanillish':'vanillish','vanilluxe':'vanilluxe',
  'deerling':'deerling','sawsbuck':'sawsbuck',
  'emolga':'emolga',
  'karrablast':'karrablast','escavalier':'escavalier',
  'foongus':'foongus','amoonguss':'amoonguss',
  'frillish':'frillish','jellicent':'jellicent',
  'alomomola':'alomomola',
  'joltik':'joltik','galvantula':'galvantula',
  'ferroseed':'ferroseed','ferrothorn':'ferrothorn',
  'klink':'klink','klang':'klang','klinklang':'klinklang',
  'tynamo':'tynamo','eelektrik':'eelektrik','eelektross':'eelektross',
  'elgyem':'elgyem','beheeyem':'beheeyem',
  'litwick':'litwick','lampent':'lampent','chandelure':'chandelure',
  'axew':'axew','fraxure':'fraxure','haxorus':'haxorus',
  'cubchoo':'cubchoo','beartic':'beartic',
  'cryogonal':'cryogonal',
  'shelmet':'shelmet','accelgor':'accelgor',
  'stunfisk':'stunfisk',
  'mienfoo':'mienfoo','mienshao':'mienshao',
  'druddigon':'druddigon',
  'golett':'golett','golurk':'golurk',
  'pawniard':'pawniard','bisharp':'bisharp',
  'bouffalant':'bouffalant',
  'rufflet':'rufflet','braviary':'braviary',
  'vullaby':'vullaby','mandibuzz':'mandibuzz',
  'heatmor':'heatmor',
  'durant':'durant',
  'deino':'deino','zweilous':'zweilous','hydreigon':'hydreigon',
  'larvesta':'larvesta','volcarona':'volcarona',
  'cobalion':'cobalion','terrakion':'terrakion','virizion':'virizion',
  'tornadus':'tornadus','thundurus':'thundurus','landorus':'landorus',
  'reshiram':'reshiram','zekrom':'zekrom','kyurem':'kyurem',
  'keldeo':'keldeo','meloetta':'meloetta','genesect':'genesect',
  // Gen 6
  'chespin':'chespin','quilladin':'quilladin','chesnaught':'chesnaught',
  'fennekin':'fennekin','braixen':'braixen','delphox':'delphox',
  'froakie':'froakie','frogadier':'frogadier','greninja':'greninja',
  'bunnelby':'bunnelby','diggersby':'diggersby',
  'fletchling':'fletchling','fletchinder':'fletchinder','talonflame':'talonflame',
  'scatterbug':'scatterbug','spewpa':'spewpa','vivillon':'vivillon',
  'litleo':'litleo','pyroar':'pyroar',
  'flabébé':'flabebe','floette':'floette','florges':'florges',
  'skiddo':'skiddo','gogoat':'gogoat',
  'pancham':'pancham','pangoro':'pangoro',
  'furfrou':'furfrou',
  'espurr':'espurr','meowstic':'meowstic',
  'honedge':'honedge','doublade':'doublade','aegislash':'aegislash',
  'spritzee':'spritzee','aromatisse':'aromatisse',
  'swirlix':'swirlix','slurpuff':'slurpuff',
  'inkay':'inkay','malamar':'malamar',
  'binacle':'binacle','barbaracle':'barbaracle',
  'skrelp':'skrelp','dragalge':'dragalge',
  'clauncher':'clauncher','clawitzer':'clawitzer',
  'helioptile':'helioptile','heliolisk':'heliolisk',
  'tyrunt':'tyrunt','tyrantrum':'tyrantrum',
  'amaura':'amaura','aurorus':'aurorus',
  'hawlucha':'hawlucha',
  'dedenne':'dedenne',
  'carbink':'carbink',
  'goomy':'goomy','sliggoo':'sliggoo','goodra':'goodra',
  'klefki':'klefki',
  'phantump':'phantump','trevenant':'trevenant',
  'pumpkaboo':'pumpkaboo','gourgeist':'gourgeist',
  'bergmite':'bergmite','avalugg':'avalugg',
  'noibat':'noibat','noivern':'noivern',
  'xerneas':'xerneas','yveltal':'yveltal','zygarde':'zygarde',
  'diancie':'diancie','hoopa':'hoopa','volcanion':'volcanion',
  // Gen 7
  'rowlet':'rowlet','dartrix':'dartrix','decidueye':'decidueye',
  'litten':'litten','torracat':'torracat','incineroar':'incineroar',
  'popplio':'popplio','brionne':'brionne','primarina':'primarina',
  'pikipek':'pikipek','trumbeak':'trumbeak','toucannon':'toucannon',
  'yungoos':'yungoos','gumshoos':'gumshoos',
  'grubbin':'grubbin','charjabug':'charjabug','vikavolt':'vikavolt',
  'crabrawler':'crabrawler','crabominable':'crabominable',
  'oricorio':'oricorio',
  'cutiefly':'cutiefly','ribombee':'ribombee',
  'rockruff':'rockruff','lycanroc':'lycanroc',
  'wishiwashi':'wishiwashi',
  'mareanie':'mareanie','toxapex':'toxapex',
  'mudbray':'mudbray','mudsdale':'mudsdale',
  'dewpider':'dewpider','araquanid':'araquanid',
  'fomantis':'fomantis','lurantis':'lurantis',
  'morelull':'morelull','shiinotic':'shiinotic',
  'salandit':'salandit','salazzle':'salazzle',
  'stufful':'stufful','bewear':'bewear',
  'bounsweet':'bounsweet','steenee':'steenee','tsareena':'tsareena',
  'comfey':'comfey',
  'oranguru':'oranguru',
  'passimian':'passimian',
  'wimpod':'wimpod','golisopod':'golisopod',
  'sandygast':'sandygast','palossand':'palossand',
  'pyukumuku':'pyukumuku',
  'type: null':'type: null','silvally':'silvally',
  'minior':'minior',
  'komala':'komala',
  'turtonator':'turtonator',
  'togedemaru':'togedemaru',
  'mimikyu':'mimikyu',
  'bruxish':'bruxish',
  'drampa':'drampa',
  'dhelmise':'dhelmise',
  'jangmo-o':'jangmo-o','hakamo-o':'hakamo-o','kommo-o':'kommo-o',
  'tapu koko':'tapu koko','tapu lele':'tapu lele','tapu bulu':'tapu bulu','tapu fini':'tapu fini',
  'cosmog':'cosmog','cosmoem':'cosmoem','solgaleo':'solgaleo','lunala':'lunala',
  'nihilego':'nihilego','buzzwole':'buzzwole','pheromosa':'pheromosa',
  'xurkitree':'xurkitree','celesteela':'celesteela','kartana':'kartana',
  'guzzlord':'guzzlord',
  'necrozma':'necrozma',
  'magearna':'magearna','marshadow':'marshadow',
  'poipole':'poipole','naganadel':'naganadel',
  'stakataka':'stakataka','blacephalon':'blacephalon',
  'zeraora':'zeraora','meltan':'meltan','melmetal':'melmetal',
  // Gen 8
  'grookey':'grookey','thwackey':'thwackey','rillaboom':'rillaboom',
  'scorbunny':'scorbunny','raboot':'raboot','cinderace':'cinderace',
  'sobble':'sobble','drizzile':'drizzile','inteleon':'inteleon',
  'skwovet':'skwovet','greedent':'greedent',
  'rookidee':'rookidee','corvisquire':'corvisquire','corviknight':'corviknight',
  'blipbug':'blipbug','dottler':'dottler','orbeetle':'orbeetle',
  'nickit':'nickit','thievul':'thievul',
  'gossifleur':'gossifleur','eldegoss':'eldegoss',
  'wooloo':'wooloo','dubwool':'dubwool',
  'chewtle':'chewtle','drednaw':'drednaw',
  'yamper':'yamper','boltund':'boltund',
  'rolycoly':'rolycoly','carkol':'carkol','coalossal':'coalossal',
  'applin':'applin','flapple':'flapple','appletun':'appletun',
  'silicobra':'silicobra','sandaconda':'sandaconda',
  'cramorant':'cramorant',
  'arrokuda':'arrokuda','barraskewda':'barraskewda',
  'toxel':'toxel','toxtricity':'toxtricity',
  'sizzlipede':'sizzlipede','centiskorch':'centiskorch',
  'clobbopus':'clobbopus','grapploct':'grapploct',
  'sinistea':'sinistea','polteageist':'polteageist',
  'hatenna':'hatenna','hattrem':'hattrem','hatterene':'hatterene',
  'impidimp':'impidimp','morgrem':'morgrem','grimmsnarl':'grimmsnarl',
  'obstagoon':'obstagoon',
  'perrserker':'perrserker',
  'cursola':'cursola',
  'sirfetch\'d':'sirfetch\'d',
  'mr. rime':'mr. rime',
  'runerigus':'runerigus',
  'milcery':'milcery','alcremie':'alcremie',
  'falinks':'falinks',
  'pincurchin':'pincurchin',
  'snom':'snom','frosmoth':'frosmoth',
  'stonjourner':'stonjourner',
  'eiscue':'eiscue',
  'indeedee':'indeedee',
  'morpeko':'morpeko',
  'cufant':'cufant','copperajah':'copperajah',
  'dracozolt':'dracozolt','arctozolt':'arctozolt',
  'dracovish':'dracovish','arctovish':'arctovish',
  'duraludon':'duraludon',
  'dreepy':'dreepy','drakloak':'drakloak','dragapult':'dragapult',
  'zacian':'zacian','zamazenta':'zamazenta','eternatus':'eternatus',
  'kubfu':'kubfu','urshifu':'urshifu',
  'zarude':'zarude',
  'regieleki':'regieleki','regidrago':'regidrago',
  'glastrier':'glastrier','spectrier':'spectrier','calyrex':'calyrex',
  'enamorus':'enamorus',
  // Gen 9
  'sprigatito':'sprigatito','floragato':'floragato','meowscarada':'meowscarada',
  'fuecoco':'fuecoco','crocalor':'crocalor','skeledirge':'skeledirge',
  'quaxly':'quaxly','quaxwell':'quaxwell','quaquaval':'quaquaval',
  'lechonk':'lechonk','oinkologne':'oinkologne',
  'tarountula':'tarountula','spidops':'spidops',
  'nymble':'nymble','lokix':'lokix',
  'pawmi':'pawmi','pawmo':'pawmo','pawmot':'pawmot',
  'tandemaus':'tandemaus','maushold':'maushold',
  'fidough':'fidough','dachsbun':'dachsbun',
  'smoliv':'smoliv','dolliv':'dolliv','arboliva':'arboliva',
  'squawkabilly':'squawkabilly',
  'nacli':'nacli','naclstack':'naclstack','garganacl':'garganacl',
  'charcadet':'charcadet','armarouge':'armarouge','ceruledge':'ceruledge',
  'tadbulb':'tadbulb','bellibolt':'bellibolt',
  'wattrel':'wattrel','kilowattrel':'kilowattrel',
  'maschiff':'maschiff','mabosstiff':'mabosstiff',
  'shroodle':'shroodle','grafaiai':'grafaiai',
  'bramblin':'bramblin','brambleghast':'brambleghast',
  'toedscool':'toedscool','toedscruel':'toedscruel',
  'klawf':'klawf',
  'capsakid':'capsakid','scovillain':'scovillain',
  'rellor':'rellor','rabsca':'rabsca',
  'flittle':'flittle','espathra':'espathra',
  'tinkatink':'tinkatink','tinkatuff':'tinkatuff','tinkaton':'tinkaton',
  'wiglett':'wiglett','wugtrio':'wugtrio',
  'bombirdier':'bombirdier',
  'finizen':'finizen','palafin':'palafin',
  'varoom':'varoom','revavroom':'revavroom',
  'cyclizar':'cyclizar',
  'orthworm':'orthworm',
  'glimmet':'glimmet','glimmora':'glimmora',
  'greavard':'greavard','houndstone':'houndstone',
  'flamigo':'flamigo',
  'cetoddle':'cetoddle','cetitan':'cetitan',
  'veluza':'veluza',
  'dondozo':'dondozo',
  'tatsugiri':'tatsugiri',
  'annihilape':'annihilape',
  'clodsire':'clodsire',
  'farigiraf':'farigiraf',
  'dudunsparce':'dudunsparce',
  'kingambit':'kingambit',
  'great tusk':'great tusk','scream tail':'scream tail',
  'brute bonnet':'brute bonnet','flutter mane':'flutter mane',
  'slither wing':'slither wing','sandy shocks':'sandy shocks',
  'iron treads':'iron treads','iron bundle':'iron bundle',
  'iron hands':'iron hands','iron jugulis':'iron jugulis',
  'iron moth':'iron moth','iron thorns':'iron thorns',
  'frigibax':'frigibax','arctibax':'arctibax','baxcalibur':'baxcalibur',
  'gimmighoul':'gimmighoul','gholdengo':'gholdengo',
  'wo-chien':'wo-chien','chien-pao':'chien-pao',
  'ting-lu':'ting-lu','chi-yu':'chi-yu',
  'roaring moon':'roaring moon','iron valiant':'iron valiant',
  'koraidon':'koraidon','miraidon':'miraidon',
  'walking wake':'walking wake','iron leaves':'iron leaves',
  'dipplin':'dipplin','poltchageist':'poltchageist','sinistcha':'sinistcha',
  'okidogi':'okidogi','munkidori':'munkidori','fezandipiti':'fezandipiti','ogerpon':'ogerpon',
  'archaludon':'archaludon','hydrapple':'hydrapple',
  'gouging fire':'gouging fire','raging bolt':'raging bolt',
  'iron boulder':'iron boulder','iron crown':'iron crown',
  'terapagos':'terapagos','pecharunt':'pecharunt',
  // Nomi italiani non standard
  'lucertank':'charizard','tartaruga':'blastoise','erbastoro':'bulbasaur',
  // Nomi di trainer/supporter comuni ricercati in italiano
  "lancia's charizard":'lance\'s charizard',
  "professor oak":'professor oak',
  "bill":'bill',
  "misty":'misty',
  "brock":'brock',
  "team rocket":'team rocket',
};

function itToEn(name){
  const n = name.toLowerCase().trim()
    .replace(/[''`]/g,"'")          // normalizza apostrofi
    .normalize('NFC');               // normalizza unicode
  // Match esatto
  if(IT_EN_MAP[n]) return IT_EN_MAP[n];
  // Match senza accenti
  const noAccent = n.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(IT_EN_MAP[noAccent]) return IT_EN_MAP[noAccent];
  // Match con apostrofi unificati
  const noApos = n.replace(/[''`']/g,'');
  for(const key of Object.keys(IT_EN_MAP)){
    if(key.replace(/[''`']/g,'') === noApos) return IT_EN_MAP[key];
  }
  return name; // non trovato: restituisce il nome originale
}

// Cerca direttamente via TCG API (fallback quando Edge Function non trova)
async function _fetchTCGDirect(query, pageSize){
  pageSize = pageSize||30;
  // PRIMARIO: proxy hyper-endpoint (evita CORS di api.pokemontcg.io dal browser).
  // Passiamo la query grezza come ?q=; il proxy inoltra alla TCG API server-side.
  try{
    const pUrl = SUPA_URL+'/functions/v1/hyper-endpoint?q='+encodeURIComponent(query)
               +'&pageSize='+pageSize+'&orderBy=-set.releaseDate';
    const pr = await fetch(pUrl, {headers:{'Authorization':'Bearer '+(window._rbSession&&window._rbSession.access_token||SUPA_KEY)}});
    if(pr.ok){ const pd = await pr.json(); if(pd && pd.data) return pd.data; }
  }catch(e){ /* proxy non disponibile/non supporta q → fallback diretto sotto */ }
  // FALLBACK: chiamata diretta (puo' fallire per CORS su alcuni domini; in tal
  // caso il chiamante ha gia' i propri catch e degrada).
  const r = await fetch(
    TCG_URL+'?q='+encodeURIComponent(query)+'&pageSize='+pageSize+'&orderBy=-set.releaseDate',
    {headers:{'X-Api-Key':TCG_KEY}}
  );
  if(!r.ok) throw new Error('TCG API '+r.status);
  const d = await r.json();
  return d.data||[];
}

// ══════════════════════════════════════════════════════════════════════════
// TCGDEX · fonte dati multilingua (giapponese, coreano, cinese, ...)
// ──────────────────────────────────────────────────────────────────────────
// La Pokémon TCG API (api.pokemontcg.io) copre SOLO le lingue occidentali
// (EN/IT/FR/DE/ES): le carte giapponesi e molti set asiatici NON esistono nel
// suo database, quindi NESSUNA query li trova (era questo il motivo per cui le
// carte JP non comparivano nei risultati). TCGdex (api.tcgdex.net) e' gratuito,
// senza key, open-source, ~130k carte, supporta ja/ko/zh e fornisce gia' il
// pricing Cardmarket in EUR. Lo usiamo in due modi:
//   • fonte ESPLICITA quando l'utente cerca in lingua JPN/KOR/ZH/...
//   • FALLBACK automatico quando pokemontcg.io non trova nulla
// Tutte le carte TCGdex vengono normalizzate nella STESSA forma di
// pokemontcg.io (tcgdexToTCGShape) cosi' il resto dell'app — calcPrice,
// renderResultsGrid, showQuickMatch, salvataggio Supabase — funziona invariato.
//
// NOTA prezzi: molte carte JP di nicchia non hanno pricing CM su TCGdex; in quel
// caso calcPrice resta silente (nessun prezzo mostrato) e l'utente puo' comunque
// catalogare la carta e verificare manualmente via il link ↗ CM.
const TCGDEX_BASE='https://api.tcgdex.net/v2';

// Lingue presenti SOLO su TCGdex (assenti su pokemontcg.io). Le occidentali
// (en/it/fr/de/es/pt) restano sul motore classico; queste forzano TCGdex.
const TCGDEX_ONLY_LANGS={'ja':1,'ko':1,'zh-tw':1,'zh-cn':1,'th':1,'id':1};

// UI lingua (valore dropdown ITA/ENG/JPN/...) → codice lingua TCGdex.
// Mappa locale auto-contenuta (non dipende da CM_LANG, definita piu' in basso:
// evita fragilita' di ordine fra const cross-script, cfr. ban IIFE).
const TCGDEX_LANG_MAP={'ITA':'it','ENG':'en','JPN':'ja','DEU':'de','FRA':'fr','ESP':'es','KOR':'ko','POR':'pt'};
function tcgdexLangCode(uiLang){ return (uiLang&&TCGDEX_LANG_MAP[uiLang])||'en'; }
// Reverse: codice lingua TCGdex (ja/ko/...) → valore dropdown UI (JPN/KOR/...).
function tcgdexUiLangFromCode(code){
  for(var k in TCGDEX_LANG_MAP){ if(TCGDEX_LANG_MAP[k]===code) return k; }
  return null;
}
// Imposta il dropdown lingua sul valore corretto se la carta proviene da TCGdex.
// Best-effort: non fa nulla per carte pokemontcg.io o se il select non esiste.
function tcgdexSyncLangSelect(card, selectId){
  if(!card || card._source!=='tcgdex') return;
  var ui=tcgdexUiLangFromCode(card._tcgdexLang||'ja');
  var el=document.getElementById(selectId);
  if(el && ui) el.value=ui;
}

// Costruisce l'URL immagine: il campo `image` di TCGdex e' un base URL SENZA
// estensione (es. https://assets.tcgdex.net/ja/sv/sv1/25). Va appeso
// /{quality}.{format}. quality: high|low ; format: png|webp|jpg.
function tcgdexImg(baseImage, quality){
  if(!baseImage) return '';
  return baseImage+'/'+(quality||'high')+'.webp';
}

// URL ricerca Cardmarket (per verifica manuale ↗) filtrato per lingua. I set
// JP non hanno URL prodotto deterministico → usiamo sempre la ricerca generica.
function tcgdexCmSearchUrl(card, langCode){
  var name=(card&&card.name)||'';
  var cmLangId=({'en':1,'fr':2,'de':3,'es':4,'it':5,'ja':7,'pt':8,'ko':10})[langCode||'ja']||7;
  return 'https://www.cardmarket.com/it/Pokemon/Products/Search?searchString='
       +encodeURIComponent(name)+'&language='+cmLangId;
}

// Mappa pricing.cardmarket di TCGdex nelle chiavi lette da calcBaseNMPrice.
// TCGdex: avg/low/trend/avg1/avg7/avg30 (non-foil) + *-holo (foil).
// pokemontcg.io: trendPrice/lowPrice/avg1/avg7/avg30/averageSellPrice
//                + reverseHoloTrend/Low/Avg7/Avg30 (foil → ramo reverse).
function tcgdexPricesToTCG(cm){
  if(!cm) return null;
  var out={};
  if(cm.trend!=null)  out.trendPrice      =cm.trend;
  if(cm.low!=null)    out.lowPrice         =cm.low;
  if(cm.avg!=null)    out.averageSellPrice =cm.avg;
  if(cm.avg1!=null)   out.avg1             =cm.avg1;
  if(cm.avg7!=null)   out.avg7             =cm.avg7;
  if(cm.avg30!=null)  out.avg30            =cm.avg30;
  if(cm['trend-holo']!=null) out.reverseHoloTrend=cm['trend-holo'];
  if(cm['low-holo']!=null)   out.reverseHoloLow  =cm['low-holo'];
  if(cm['avg7-holo']!=null)  out.reverseHoloAvg7 =cm['avg7-holo'];
  if(cm['avg30-holo']!=null) out.reverseHoloAvg30=cm['avg30-holo'];
  return Object.keys(out).length?out:null;
}

// Normalizza una carta TCGdex (full o brief) nella forma pokemontcg.io.
function tcgdexToTCGShape(card, langCode){
  if(!card) return null;
  var setObj=card.set||{};
  var prices=(card.pricing&&card.pricing.cardmarket)?tcgdexPricesToTCG(card.pricing.cardmarket):null;
  var shaped={
    id:card.id,
    name:card.name||'',
    number:(card.localId!=null?String(card.localId):''),
    rarity:card.rarity||'',
    set:{
      id:setObj.id||'',
      name:setObj.name||'',
      series:(setObj.serie&&setObj.serie.name)?setObj.serie.name:''
    },
    images:{
      small:tcgdexImg(card.image,'low'),
      large:tcgdexImg(card.image,'high')
    },
    _source:'tcgdex',
    _tcgdexLang:langCode||'ja'
  };
  // cardmarket.url sempre presente (verifica manuale); prices solo se disponibili.
  shaped.cardmarket=prices
    ? {prices:prices, url:tcgdexCmSearchUrl(card, langCode)}
    : {url:tcgdexCmSearchUrl(card, langCode)};
  return shaped;
}

// Fetch grezzo verso TCGdex (ritorna array di brief o singolo oggetto).
async function _fetchTCGdex(path){
  var r=await fetch(TCGDEX_BASE+path,{headers:{'Accept':'application/json'}});
  if(!r.ok) throw new Error('TCGdex '+r.status);
  return await r.json();
}

// Idrata un brief in carta completa (per ottenere il pricing). Best-effort:
// se l'idratazione fallisce, ritorna la forma normalizzata dal solo brief.
async function _tcgdexHydrate(brief, langCode){
  try{
    var full=await _fetchTCGdex('/'+langCode+'/cards/'+encodeURIComponent(brief.id));
    return tcgdexToTCGShape(full, langCode);
  }catch(e){
    return tcgdexToTCGShape(brief, langCode);
  }
}

// Risolve nome (in inglese/romaji) → dexId Pokédex via endpoint EN di TCGdex.
// Il dexId e' indipendente dalla lingua, quindi permette di trovare le carte
// giapponesi anche se l'utente digita il nome in inglese (l'endpoint ja filtra
// invece sul nome GIAPPONESE). Best-effort: ritorna [] se non risolvibile.
async function _tcgdexResolveDexIds(name){
  try{
    var en=null;
    // 1) match esatto (pinna il Pokemon giusto, es. "Pikachu")
    try{ en=await _fetchTCGdex('/en/cards?category=Pokemon&name=eq:'+encodeURIComponent(name)); }catch(e){}
    // 2) fallback contains (es. "Charizard ex" → trova Charizard)
    if(!Array.isArray(en)||!en.length){
      try{ en=await _fetchTCGdex('/en/cards?category=Pokemon&name='+encodeURIComponent(name)); }catch(e){}
    }
    if(!Array.isArray(en)||!en.length) return [];
    // I brief non includono dexId → idrata il primo risultato per leggerlo.
    var full=await _fetchTCGdex('/en/cards/'+encodeURIComponent(en[0].id));
    return Array.isArray(full.dexId)?full.dexId:[];
  }catch(e){ return []; }
}

// Recupera i brief delle carte JP per uno o piu' dexId (di norma 1). Dedup per id.
async function _tcgdexCardsByDexIds(dexIds, langCode){
  var ids=(dexIds||[]).slice(0,3); // di norma 1 dexId; cap difensivo
  var all=[];
  for(var i=0;i<ids.length;i++){
    try{
      // pageSize=30: Pikachu ha >1000 stampe JP — senza limite blocca la UI.
      // Ritorna le carte più recenti (default sort TCGdex: releaseDate desc).
      var part=await _fetchTCGdex('/'+langCode+'/cards?dexId='+encodeURIComponent(ids[i])+'&pageSize=30');
      if(Array.isArray(part)) all=all.concat(part);
    }catch(e){}
  }
  var seen={},out=[];
  all.forEach(function(b){ if(b&&b.id&&!seen[b.id]){ seen[b.id]=1; out.push(b); } });
  return out;
}

// Ricerca per nome su TCGdex in una lingua specifica → carte normalizzate.
// La ricerca ritorna SOLO briefs (id/localId/name/image); idratiamo i primi N
// per popolare i prezzi (TCGdex e' veloce, rate limit generoso). Cap a 8 idratazioni
// e 60 risultati totali. Per le lingue asiatiche usa il bridge dexId (vedi sopra).
async function rbSearchTCGdex(name, number, langCode){
  langCode=langCode||'ja';
  if(!name) return [];
  var isAsian=!!TCGDEX_ONLY_LANGS[langCode];
  var briefs=[];

  if(isAsian){
    // Bridge dexId: nome inglese → dexId → carte JP più recenti (max 30).
    var dexIds=await _tcgdexResolveDexIds(name);
    if(dexIds.length){
      briefs=await _tcgdexCardsByDexIds(dexIds, langCode);
      console.log('[tcgdex] JP via dexId', dexIds, '→', briefs.length, 'carte');
    }
    // Fallback solo se dexId non ha trovato nulla (es. l'utente digita in giapponese).
    if(!briefs.length){
      try{ briefs=await _fetchTCGdex('/'+langCode+'/cards?name='+encodeURIComponent(name)+'&pageSize=30'); }
      catch(e){ briefs=[]; }
      console.log('[tcgdex] JP via nome diretto →', (briefs&&briefs.length)||0, 'carte');
    }
  } else {
    try{ briefs=await _fetchTCGdex('/'+langCode+'/cards?name='+encodeURIComponent(name)+'&pageSize=30'); }
    catch(e){ return []; }
    console.log('[tcgdex]', langCode, 'via nome →', (briefs&&briefs.length)||0, 'carte');
  }
  if(!Array.isArray(briefs)||!briefs.length) return [];

  // Se ho un numero, porta in cima i briefs con localId esatto.
  if(number){
    var num=String(number);
    briefs=briefs.slice().sort(function(a,b){
      var am=String(a.localId)===num?0:1;
      var bm=String(b.localId)===num?0:1;
      return am-bm;
    });
  }

  // Idrata i primi 8 per ottenere i prezzi CM; il resto rimane brief.
  var HYDRATE_CAP=8;
  var hydrated=await Promise.all(briefs.slice(0,HYDRATE_CAP).map(function(b){ return _tcgdexHydrate(b, langCode); }));
  var rest=briefs.slice(HYDRATE_CAP).map(function(b){ return tcgdexToTCGShape(b, langCode); });
  var out=hydrated.concat(rest).filter(Boolean);

  out.sort(function(a,b){
    var na=parseInt((a.number||'').replace(/\D/g,''),10)||0;
    var nb=parseInt((b.number||'').replace(/\D/g,''),10)||0;
    if(na!==nb) return na-nb;
    return (a.number||'').localeCompare(b.number||'');
  });
  return out;
}


// ── SEARCH ENGINE ──
const cache={};

function nameVariants(name){
  const n=name.trim();
  const v=new Set();
  v.add(n.replace(/(.)\1+/g,'$1'));
  v.add(n.replace(/(.)\1/g,'$11'));
  if(n.length>3){v.add(n.slice(0,-1));v.add(n+n[n.length-1]);}
  v.add(n.normalize('NFD').replace(/[\u0300-\u036f]/g,''));
  v.add(n.replace(/[-'\u2019\s]/g,''));
  v.add(n.replace(/[-'\u2019]/g,' ').trim());
  v.add(n.replace(/\u2640/g,'F').replace(/\u2642/g,'M'));
  v.add(n.replace(/\s*\(.*\)/g,'').trim());
  const fw=n.split(/\s+/)[0];
  if(fw!==n&&fw.length>2) v.add(fw);
  v.delete(n);v.delete('');
  return[...v];
}

async function _fetchRaw(name,attempt=1){
  const key=name.toLowerCase().trim();
  if(cache[key]) return cache[key];
  setLed('checking',attempt===1?'Ricerca in corso…':'Nuovo tentativo…');
  const start=Date.now();
  try{
    const proxyUrl=`${SUPA_URL}/functions/v1/hyper-endpoint?name=${encodeURIComponent(name)}`;
    const r=await fetch(proxyUrl,{headers:{'Authorization':'Bearer '+(window._rbSession?.access_token||SUPA_KEY)}});
    if((r.status===500||r.status===503)&&attempt===1){
      setLed('yellow','Avvio server in corso…');
      await new Promise(res=>setTimeout(res,3000));
      return _fetchRaw(name,2);
    }
    if(!r.ok) throw new Error('HTTP '+r.status);
    const d=await r.json();
    const cards=d.data||[];
    cache[key]=cards;
    setLed('green','Online ('+(Date.now()-start)+'ms)');
    clearTimeout(apiCheckTimer);
    apiCheckTimer=setTimeout(checkApiStatus,API_CHECK_INTERVAL);
    return cards;
  }catch(e){setLed('red','Errore: '+e.message);throw e;}
}

async function fetchCards(name, number){
  // 1. Traduzione italiano → inglese
  const enName = itToEn(name);
  const nameToSearch = enName !== name ? enName : name;

  // 2. Ricerca via Edge Function (cacheata)
  let results = [];
  try {
    results = await _fetchRaw(nameToSearch);
  } catch(e) {
    // Edge Function non disponibile → vai diretto
  }

  // 3. Se Edge Function non trova o non disponibile → TCG API diretta
  if(!results.length){
    try {
      results = await _fetchTCGDirect('name:"'+nameToSearch.replace(/"/g,'')+'"');
    } catch(e) {}
  }

  // 4. Se ho un numero di carta, prova ricerca combinata nome+numero (molto precisa)
  if(number && (!results.length || results.length > 5)){
    try {
      const byNum = await _fetchTCGDirect('name:"'+nameToSearch.replace(/"/g,'')+'" number:'+number);
      if(byNum.length > 0){
        // Merge: metti quelli col numero corretto in cima
        const ids = new Set(byNum.map(c=>c.id));
        const rest = results.filter(c=>!ids.has(c.id));
        results = byNum.concat(rest);
      }
    } catch(e) {}
  }

  // 5. Fuzzy fallback se ancora vuoto
  if(!results.length){
    setLed('checking','Ricerca avanzata…');
    for(const v of nameVariants(nameToSearch)){
      if(!v||v.toLowerCase()===nameToSearch.toLowerCase()) continue;
      try{
        const res = await _fetchRaw(v,1);
        if(res.length>0){ results=res; break; }
      }catch(e){}
      // Prova anche TCG diretta in fuzzy
      try{
        const res2 = await _fetchTCGDirect('name:*'+v.split(' ')[0]+'*');
        if(res2.length>0){ results=res2; break; }
      }catch(e){}
    }
  }

  // 6. Se nome italiano fallisce con mappa, prova traduzione AI-assisted
  //    (solo se nome non trovato e sembra italiano)
  if(!results.length && enName === name){
    // Wildcard sul primo token come ultima risorsa
    try {
      const firstWord = name.split(' ')[0];
      if(firstWord.length > 3){
        results = await _fetchTCGDirect('name:*'+firstWord+'*');
      }
    } catch(e) {}
  }

  if(results.length) cache[nameToSearch.toLowerCase().trim()] = results;
  return results;
}

// ══════════════════════════════════════════════════════════════
// RB-CARD-SEARCH · modulo riusabile (estratto da auDoSearch)
// Espone:
//   rbSearchCards(name, number, setId)   → Promise<cards[]>
//   rbMountSetPicker(opts)               → attacca set picker a input
//   rbResolveSetFromInput(inputEl)       → {id,name,unresolved?}|null
// ══════════════════════════════════════════════════════════════
window.rbSearchCards = async function(name, number, setId, lang){
  // lang (opzionale): valore dropdown UI (ITA/ENG/JPN/...). Se e' una lingua
  // presente SOLO su TCGdex (ja/ko/zh/...), bypassiamo pokemontcg.io e cerchiamo
  // direttamente su TCGdex. I set picker usano ID pokemontcg.io che NON mappano
  // sui set TCGdex giapponesi, quindi in questa modalita' il filtro set viene
  // ignorato (ricerca per nome su tutti i set della lingua).
  var langCode=tcgdexLangCode(lang);
  if(lang && TCGDEX_ONLY_LANGS[langCode]){
    try{ return await rbSearchTCGdex(name, number||null, langCode); }
    catch(e){ console.warn('[rbSearchCards] TCGdex JP search error:', e); return []; }
  }

  // Con setId: TCG API diretta, molto precisa, bypass Edge Function
  if(setId){
    var parts=['set.id:'+setId];
    if(name) parts.push('name:"'+String(name).replace(/"/g,'')+'"');
    if(number) parts.push('number:'+number);
    var cards=[];
    try{ cards=await _fetchTCGDirect(parts.join(' '),250); }catch(e){}
    if(!cards.length && name){
      // Fallback wildcard primo token
      try{
        var p2=['set.id:'+setId,'name:*'+String(name).split(/\s+/)[0].replace(/"/g,'')+'*'];
        if(number) p2.push('number:'+number);
        cards=await _fetchTCGDirect(p2.join(' '),250);
      }catch(e){}
    }
    // Ordina per numero (utile con filtro set)
    cards.sort(function(a,b){
      var na=parseInt((a.number||'').replace(/\D/g,''),10)||0;
      var nb=parseInt((b.number||'').replace(/\D/g,''),10)||0;
      if(na!==nb) return na-nb;
      return (a.number||'').localeCompare(b.number||'');
    });
    return cards;
  }
  // Senza setId: usa fetchCards (engine classico con fuzzy+translate+cache)
  if(!name) return [];
  var all = await fetchCards(name, number||null);
  if(number && all.length){
    var ex=all.filter(function(c){return c.number===number;});
    var pa=all.filter(function(c){return c.number&&c.number.startsWith(number+'/');});
    return ex.length?ex:(pa.length?pa:all);
  }
  return all;
};

/* ── Namespace pulito (API nuova, non-breaking) ───────────────────────────── */
var RBSearch = (typeof RBSearch !== 'undefined' && RBSearch) || {};
RBSearch.search         = (typeof window!=='undefined' ? window.rbSearchCards : rbSearchCards);
RBSearch.searchTCGdex   = rbSearchTCGdex;
RBSearch.fetchTCGDirect = _fetchTCGDirect;
RBSearch.itToEn         = itToEn;
RBSearch.toTCGShape     = tcgdexToTCGShape;
if (typeof window !== 'undefined') window.RBSearch = RBSearch;

/* ── Cross-script globals ─────────────────────────────────────────────────
 * I const top-level NON sono condivisi tra <script> classici diversi (a
 * differenza di var/function/window.x). Il monolite (pokemon-db.html) legge
 * `cache` in rbCardSearch.run → va esposto su window come riferimento condiviso
 * (stessa istanza: le scritture del modulo restano visibili al monolite).
 * Vedi regola codebase: niente const/let per simboli cross-script. */
if (typeof window !== 'undefined') {
  window.cache     = cache;
  window.IT_EN_MAP = IT_EN_MAP;
}
