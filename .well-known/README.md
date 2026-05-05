# .well-known/ — domain verification

Questa cartella contiene file di verifica dominio per servizi terzi.

## Apple Pay (Stripe)

Per attivare Apple Pay sulle Checkout Session di Stripe, va hostato qui
il file `apple-developer-merchantid-domain-association` scaricato da
Stripe Dashboard.

### Procedura (PR6d)

1. Vai su https://dashboard.stripe.com/settings/payments/apple_pay
   (assicurati di essere in **Live mode** se per produzione, o **Test mode**
   per sandbox — dovrai ripetere per entrambi)

2. Click "Add a new domain"

3. Inserisci: `www.rareblock.eu`

4. Stripe genera e ti dà da scaricare il file:
   `apple-developer-merchantid-domain-association`
   (file senza estensione, contiene token JSON-like)

5. Carica il file in questa cartella sul server Aruba a:
   ```
   /www.rareblock.eu/.well-known/apple-developer-merchantid-domain-association
   ```

   Comando FTP:
   ```bash
   # Da SSH Aruba:
   ssh -p 2222 -i ~/.ssh/id_rsa e6tabwn-valentino@f3my2t5.zonef3.webhostingaruba.it
   cd /var/www/.../www.rareblock.eu/
   mkdir -p .well-known
   # Upload file via SCP/FTP nella directory .well-known/
   ```

6. Verifica che il file sia raggiungibile:
   ```bash
   curl -i https://www.rareblock.eu/.well-known/apple-developer-merchantid-domain-association
   ```
   Atteso: HTTP 200, Content-Type: text/plain, body con stringa
   "7B22 7665 7273 696F 6E22..." o simile.

7. Su Stripe Dashboard click "Verify". Apple verifica entro pochi
   secondi e marca il dominio come verified.

8. Ripeti per `rareblock.eu` (senza www) se necessario.

## File già presenti nel repo

- `.htaccess` — configurazione Apache per servire correttamente i file
  di verifica (text/plain content-type, no rewrite, accesso aperto)

## File NON da committare

Il file `apple-developer-merchantid-domain-association` di Stripe
contiene un token specifico per il tuo account Stripe. È innocuo
condividerlo, ma non c'è motivo di tenerlo in repo. Va caricato
direttamente sul server FTP/SSH.

## Altri file futuri

Eventuali file Let's Encrypt (`acme-challenge/`) verranno gestiti
automaticamente da Aruba se attivi SSL via pannello.
