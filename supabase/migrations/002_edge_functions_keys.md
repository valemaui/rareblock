# Chiavi API nelle Edge Functions

Le chiamate ad Anthropic e OpenRouter passano già dalle Edge Functions Supabase
(`smooth-endpoint`, `scan-cards`, `hyper-endpoint`).

Per aggiungere le chiavi lì (invece che nel client):

1. Vai su Supabase Dashboard → Edge Functions → Secrets
2. Aggiungi:
   - `ANTHROPIC_API_KEY` = sk-ant-api03-...
   - `OPENROUTER_API_KEY` = sk-or-v1-...

3. Nelle Edge Functions usa:
   ```ts
   const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
   ```

In questo modo le chiavi non escono MAI dal server Supabase.
Le chiavi iniettate nel client HTML (via GitHub Secrets) servono come
fallback per chiamate dirette al browser quando le Edge Functions non sono disponibili.
