// Supabase Edge Function: admin-create-user
// Crea un nuovo utente Auth via service_role key.
// Usata principalmente per creare account "vendor" dall'UI admin.
//
// SICUREZZA:
// - Verifica che il chiamante sia loggato e abbia ruolo admin
// - Service role key resta SOLO nell'edge function (mai esposta al client)
// - Validazione input lato server
//
// Deploy: supabase functions deploy admin-create-user
// Variabili necessarie nel progetto:
//   SUPABASE_URL              (auto-injected)
//   SUPABASE_ANON_KEY         (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY (auto-injected)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

interface CreateUserInput {
  email: string;
  password?: string;          // opzionale: se assente, manda invito via email
  full_name?: string;         // pre-popola profiles.full_name
  initial_role?: 'investor' | 'collector';
  send_invite?: boolean;      // se true e password assente → invito via email
  metadata?: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const supaUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    if (!supaUrl || !anonKey || !serviceKey) {
      return json({ error: 'Missing Supabase environment variables' }, 500);
    }

    // 1. Verifica che il chiamante sia un admin autenticato
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Authentication required' }, 401);

    const userClient = createClient(supaUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: 'Invalid session' }, 401);
    }

    // Check ruolo admin nel profilo
    const { data: profile, error: profErr } = await userClient
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single();

    if (profErr || !profile || profile.role !== 'admin') {
      return json({ error: 'Admin role required' }, 403);
    }

    // 2. Parse e validazione input
    let body: CreateUserInput;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Email non valida' }, 400);
    }

    const password = body.password ? String(body.password) : undefined;
    if (password && password.length < 8) {
      return json({ error: 'Password troppo corta (min 8 caratteri)' }, 400);
    }

    const initialRole = body.initial_role === 'collector' ? 'collector' : 'investor';
    const fullName = body.full_name ? String(body.full_name).trim() : null;

    // 3. Service-role client per operazioni admin
    const adminClient = createClient(supaUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 4. Verifica che l'email non esista già
    const { data: existingList, error: listErr } = await adminClient.auth.admin.listUsers();
    if (listErr) {
      return json({ error: 'Errore verifica utente esistente: ' + listErr.message }, 500);
    }
    const existing = existingList?.users?.find(u => u.email?.toLowerCase() === email);
    if (existing) {
      return json({
        error: 'Esiste già un account con questa email',
        existing_user_id: existing.id,
      }, 409);
    }

    // 5. Crea l'utente
    let createdUser;
    if (password) {
      // Crea con password fornita, email auto-confermata (l'admin si fida)
      const { data, error } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
          ...(body.metadata || {}),
        },
      });
      if (error) return json({ error: 'Errore creazione utente: ' + error.message }, 500);
      createdUser = data.user;
    } else {
      // Senza password → invio link invito (l'utente sceglie la password)
      const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
        data: {
          full_name: fullName,
          ...(body.metadata || {}),
        },
      });
      if (error) return json({ error: 'Errore invio invito: ' + error.message }, 500);
      createdUser = data.user;
    }

    if (!createdUser) {
      return json({ error: 'Creazione utente fallita (nessun utente restituito)' }, 500);
    }

    // 6. Crea/aggiorna il profile (la trigger handle_new_user dovrebbe già farlo,
    //    ma garantiamo full_name e ruolo iniziale)
    try {
      await adminClient.from('profiles').upsert({
        id: createdUser.id,
        full_name: fullName,
        role: initialRole,
      }, { onConflict: 'id' });
    } catch (e) {
      // Non fatale: l'utente è creato, il profilo si auto-crea al primo login
      console.warn('profile upsert non-fatal:', e);
    }

    return json({
      user_id: createdUser.id,
      email: createdUser.email,
      created_via: password ? 'password' : 'invite',
      message: password
        ? 'Account creato. L\'utente può accedere subito con email + password.'
        : 'Invito inviato via email. L\'utente riceverà un link per impostare la password.',
    });

  } catch (e) {
    return json({
      error: 'Internal error: ' + (e instanceof Error ? e.message : String(e)),
    }, 500);
  }
});
