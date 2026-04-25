// ═══════════════════════════════════════════════════════════════════════
// Shared utilities per gli scraper. Questi helper vengono COPIATI dentro
// ogni scraper function (perché executeScript serializza la function via
// toString() e non può seguire import). Qui li teniamo come testo da
// inlineare manualmente o per riferimento. Vedi commento "INLINE" nei
// singoli scraper file.
//
// Oggi li lasciamo duplicati nei singoli file per chiarezza:
// - extractImageUrl(card)
// - triggerLazyLoad()
// - ensureImagesLoaded(maxWaitMs)
// - parsePrice(s)
// ═══════════════════════════════════════════════════════════════════════

// (placeholder - i veri helper sono dentro i file scraper per essere
// inclusi nel func.toString() di executeScript)
