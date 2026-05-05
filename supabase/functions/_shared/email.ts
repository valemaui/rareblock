// ═════════════════════════════════════════════════════════════════════════════
// RareBlock — Shared module: email
// Pattern Transactional Outbox
// ─────────────────────────────────────────────────────────────────────────────
// Wrapper unificato per l'invio (logico) di email dalle edge functions.
//
// STRATEGIA ATTUALE: outbox-only
//   Le email NON vengono inviate immediatamente. Vengono INSERT in
//   public.email_outbox con status='pending'. Un worker futuro processerà
//   la coda con il provider scelto (Resend, SendGrid, SMTP nativo).
//
// MIGRAZIONE FUTURA (TODO bassa priorità):
//   Quando il volume crescerà, si potrà:
//     1. Implementare deliverWithProvider(provider, email) → fetch alla
//        API del provider scelto
//     2. Sostituire il body di sendEmail() per chiamarlo prima dell'INSERT
//        (e settare status='sent' direttamente)
//     3. Oppure mantenere l'INSERT + worker dedicato che pulisce la coda
//
// USAGE:
//   import { sendEmail } from '../_shared/email.ts';
//   await sendEmail(supabaseAdmin, {
//     to: 'user@example.com',
//     toName: 'Mario Rossi',
//     toUserId: 'uuid',
//     subject: 'Esempio',
//     html: '<p>Hello</p>',
//     text: 'Hello',
//     templateCode: 'fractional_vote_open',
//     context: { vote_id: '...' }
//   });
// ═════════════════════════════════════════════════════════════════════════════

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface EmailMessage {
  to: string;
  toName?: string | null;
  toUserId?: string | null;
  subject: string;
  html: string;
  text?: string | null;
  templateCode?: string | null;
  context?: Record<string, unknown>;
  fromEmail?: string | null;
  fromName?: string | null;
}

export interface EmailEnqueueResult {
  ok: boolean;
  email_id?: string;
  error?: string;
}

/**
 * Enqueue una email nella outbox transactional.
 * NON invia realmente: persiste con status='pending'.
 *
 * Richiede un client supabase con service_role per bypassare RLS sull'INSERT
 * (la tabella email_outbox è sealed: solo INSERT da service_role è permesso).
 */
export async function sendEmail(
  sbAdmin: SupabaseClient,
  msg: EmailMessage,
): Promise<EmailEnqueueResult> {
  if (!msg.to || !msg.to.includes('@')) {
    return { ok: false, error: 'invalid_to_email' };
  }
  if (!msg.subject) {
    return { ok: false, error: 'missing_subject' };
  }
  if (!msg.html) {
    return { ok: false, error: 'missing_body_html' };
  }

  try {
    const { data, error } = await sbAdmin.rpc('enqueue_email', {
      p_to_email:      msg.to,
      p_subject:       msg.subject,
      p_body_html:     msg.html,
      p_to_name:       msg.toName ?? null,
      p_to_user_id:    msg.toUserId ?? null,
      p_body_text:     msg.text ?? null,
      p_template_code: msg.templateCode ?? null,
      p_context:       msg.context ?? {},
      p_from_email:    msg.fromEmail ?? null,
      p_from_name:     msg.fromName ?? null,
    });

    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true, email_id: data as string };
  } catch (e: unknown) {
    const msgErr = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msgErr };
  }
}

/**
 * Enqueue email "vote open" a tutti i comproprietari di un voto.
 * Wrapper della RPC enqueue_fractional_vote_open_emails(p_vote_id).
 *
 * Ritorna il numero di email enqueued.
 */
export async function enqueueFractionalVoteOpenEmails(
  sbAdmin: SupabaseClient,
  voteId: string,
): Promise<{ ok: boolean; emails_count: number; error?: string }> {
  try {
    const { data, error } = await sbAdmin.rpc('enqueue_fractional_vote_open_emails', {
      p_vote_id: voteId,
    });
    if (error) {
      return { ok: false, emails_count: 0, error: error.message };
    }
    return { ok: true, emails_count: Number(data) || 0 };
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, emails_count: 0, error: m };
  }
}
