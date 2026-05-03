// chain/supabase-functions/_shared/storage-adapter.js
//
// Adapter Supabase Storage per upload PDF certificato.
// Bucket dedicato 'certificates' (privato), signed URLs validi 1 anno.
"use strict";

const BUCKET   = "certificates";
const SIGN_TTL = 60 * 60 * 24 * 365;  // 1 anno (rigenerabili a ogni accesso)

function makeStorageAdapter(sb) {
  return {
    async uploadPdf(serial, buffer) {
      // Path: certs/RB-2026-000042.pdf
      const path = `certs/${serial}.pdf`;
      // Upload (upsert true: ri-emissioni dello stesso certificato si sovrascrivono)
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, buffer, {
        contentType:    "application/pdf",
        upsert:         true,
        cacheControl:   "3600",
      });
      if (upErr) throw new Error(`storage upload: ${upErr.message}`);

      // Signed URL (1 anno; il client potrà rigenerarli on-demand)
      const { data: signed, error: signErr } = await sb.storage
        .from(BUCKET)
        .createSignedUrl(path, SIGN_TTL);
      if (signErr) throw new Error(`storage signed url: ${signErr.message}`);

      return {
        storagePath: path,
        signedUrl:   signed.signedUrl,
      };
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { makeStorageAdapter };
}
