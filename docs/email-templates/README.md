# Email Templates RareBlock

Template HTML brand-aligned (gold + dark luxury) per le 5 email transazionali di Supabase Auth.

## File

| File | Template Supabase | Variabili |
|---|---|---|
| `01-confirm-signup.html` | Confirm signup | `{{ .ConfirmationURL }}`, `{{ .Email }}` |
| `02-magic-link.html` | Magic Link | `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .Token }}` |
| `03-reset-password.html` | Reset Password | `{{ .ConfirmationURL }}`, `{{ .Email }}` |
| `04-change-email.html` | Change Email Address | `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}` |
| `05-invite.html` | Invite User | `{{ .ConfirmationURL }}`, `{{ .Email }}` |

## Come applicarli su Supabase

1. Vai su https://supabase.com/dashboard/project/rbjaaeyjeeqfpbzyavag/auth/templates
2. Per ogni template (5 in totale), seleziona l'item nel menu sinistro
3. Apri il file `.html` corrispondente in un editor di testo
4. Copia tutto il contenuto
5. Incollalo nell'editor "Message body" della pagina Supabase
6. Modifica anche il "Subject heading" (vedi tabella sotto)
7. Click "Save changes"

### Subject suggeriti

| Template | Subject (italiano) |
|---|---|
| Confirm signup | `Conferma il tuo account RareBlock` |
| Magic Link | `Il tuo accesso a RareBlock` |
| Reset Password | `Reimposta la tua password RareBlock` |
| Change Email | `Conferma il tuo nuovo indirizzo email` |
| Invite User | `Sei stato invitato in RareBlock` |

## Caratteristiche tecniche

- **Width**: max 600px (compatibile mobile + desktop)
- **CSS**: solo inline (necessario per email client come Outlook)
- **Layout**: tabelle nidificate (compatibilità universale)
- **Font fallback**: -apple-system, Segoe UI, Roboto, sans-serif
- **Headlines**: Georgia serif italic (richiama l'estetica luxury del brand)
- **Mono**: IBM Plex Mono / Consolas / monospace (per token, link, eyebrow)
- **Palette**:
  - Background: `#0d1117` (bg principale), `#161b22` (card)
  - Bordi: `#30363d`, `#21262d` (separatori interni)
  - Testo: `#c9d1d9` (body), `#f0ead8` (highlight), `#8b949e` (secondario), `#6e7681` (footer)
  - Gold accent: `#c9a84c`
  - Stati: `#3fb950` (success), `#d29922` (warning), `#f85149` (danger)

## Preheader

Ogni template ha un `preheader` invisibile (display:none) con un breve testo che appare nelle anteprime delle inbox (Gmail, Outlook, Apple Mail). Personalizzabile per ogni template.

## Test before deployment

Per testare un template prima di applicarlo in produzione:

1. Apri il file `.html` in un browser locale (sostituisci manualmente `{{ .ConfirmationURL }}` con un URL fittizio)
2. Verifica visual su Chrome + Safari + Firefox
3. Per test email reali, copia il contenuto in un servizio come [putsmail.com](https://putsmail.com) o invia a te stesso via Gmail

## Note di compatibilità

- Outlook 2016+: alcuni gradienti potrebbero apparire piatti (fallback al colore solido)
- Apple Mail: rendering perfetto
- Gmail (web/mobile): rendering perfetto
- Yahoo Mail: rendering perfetto
- Dark mode: i client moderni applicano automaticamente `prefers-color-scheme`. Il design è già scuro nativo, quindi il dark mode dei client non lo inverte male (test fatto su Apple Mail dark)

## Aggiornamenti futuri

- Logo SVG inline (oggi è solo testo "RareBlock"): considera embed di un'immagine PNG ospitata su CDN
- Icone Pokemon-themed se vuoi rinforzare il vertical
- Template per "comunicazione fractional vote" (post-MVP) — già pronto in DB outbox
