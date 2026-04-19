# RareBlock Collector

App single-page per gestione collezione carte Pokémon e preventivi acquisto.

## Stack

| Layer | Tecnologia |
|-------|-----------|
| Frontend | HTML/CSS/JS single file (`pokemon-db.html`) |
| Database | [Supabase](https://supabase.com) (PostgreSQL + RLS) |
| Auth | Supabase Auth (email/password) |
| Card API | Pokémon TCG API |
| AI | Anthropic Claude + OpenRouter (tramite Edge Functions) |
| Deploy | GitHub Actions → FTP |

## Setup iniziale (una tantum)

### 1. Supabase — RLS e user_id

Vai su **Supabase Dashboard → SQL Editor** e incolla il contenuto di:
```
supabase/migrations/001_auth_and_rls.sql
```
Poi segui le istruzioni nel file per migrare i dati esistenti.

### 2. GitHub Secrets

Vai su **GitHub → Settings → Secrets and variables → Actions** e aggiungi:

| Secret | Valore |
|--------|--------|
| `ANTHROPIC_KEY` | `sk-ant-api03-...` |
| `OPENROUTER_KEY` | `sk-or-v1-...` |
| `FTP_HOST` | hostname FTP |
| `FTP_USERNAME` | utente FTP |
| `FTP_PASSWORD` | password FTP |
| `FTP_PATH` | percorso sul server |

Le chiavi vengono iniettate nel file HTML solo al momento del deploy — **mai nel repo**.

### 3. Primo utente

Vai su **Supabase → Authentication → Users → Invite User** e invita te stesso.  
Oppure abilita la self-registration in **Auth → Settings** (sconsigliato in produzione).

### 4. Migra dati esistenti

Dopo aver eseguito la migration SQL, assegna i tuoi dati esistenti al tuo user_id:
```sql
-- Sostituisci 'YOUR-UUID' con il tuo UUID da Authentication > Users
UPDATE cards      SET user_id = 'YOUR-UUID' WHERE user_id IS NULL;
UPDATE preventivi SET user_id = 'YOUR-UUID' WHERE user_id IS NULL;
```

## Workflow sviluppo

```bash
# Ogni push su main con pokemon-db.html modificato triggera il deploy automatico
git add pokemon-db.html
git commit -m "feat: descrizione modifica"
git push
# → GitHub Actions inietta le chiavi → FTP deploy → live in ~30s
```

## Architettura multi-utente

- Ogni record in `cards` e `preventivi` ha `user_id` (UUID Supabase Auth)
- **RLS** enforced server-side: impossibile leggere dati altrui anche con richieste dirette
- Il JWT dell'utente sostituisce l'anon key nelle chiamate API
- Belt-and-suspenders: filtro `user_id` anche lato client nelle query

## Per il prossimo sviluppatore

- Leggi questo README completamente
- Esegui la migration SQL se è la prima installazione
- Configura i GitHub Secrets
- Non committare mai chiavi API — usa i Secrets
- Le chiavi Anthropic/OpenRouter sono `PLACEHOLDER` nel repo: vengono sostituite al deploy
