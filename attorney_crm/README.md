# attorney_crm

Internal CRM at https://attorney.legal.org.ua/ for selling legal.org.ua to advocates.
Lists active advocates from the НААУ registry (`opendata_advocates`), shows practice
areas derived from ЄДРСР plus manual tags, keeps call/letter notes and a "today" page.

- Design: `docs/superpowers/specs/2026-11-07-attorney-crm-design.md`
- Runs as `attorney-crm-local` in `deployment/docker-compose.local.yml` on cthulhu,
  behind nginx (`deployment/nginx/conf.d/aws-migrated.conf`).
- Tables `attorney_crm_*` are created by the service on boot from `sql/*.sql`.
- Secret: `ATTORNEY_CRM_SESSION_SECRET` in `.env.local` on the host.

## Operate

```bash
# create or reset a user (inside the container)
docker exec attorney-crm-local node dist/cli.js set-password vladimir@legal.org.ua '<password>' 'Володимир'

# one-off ЄДРСР practice backfill (tmux on cthulhu), resumable
scripts/attorney-crm/derive-practices.sh 2024 2025 2026
SELECT * FROM attorney_crm_practice_progress;
```

## Develop

```bash
cd attorney_crm && npm ci && npm test && npm run build
DATABASE_URL=postgres://... ATTORNEY_CRM_SESSION_SECRET=dev npm run dev
```

## Tenants

One image, two deployments, chosen by `ATTORNEY_CRM_TENANT` (`ua` default, `pl`):

| | `ua` (attorney.legal.org.ua) | `pl` (attorney.lawrider.pl) |
|---|---|---|
| register | `opendata_advocates` (НААУ) | `public.pl_lawyers` (adwokaci + radcowie prawni) |
| practices | derived from ЄДРСР mentions + manual tags | declared on the register profile / szukajradcy tags, mapped to the 27 NRA categories |
| UI | Ukrainian, Europe/Kyiv | English, Europe/Warsaw |
| CRM tables | `public` | schema `attorney_crm_pl` (search_path) |
| schema files | 001–004 | 002, 004, `pl/001_pl_lawyers.sql` |

Everything tenant-specific lives in `src/tenant/` (strings in `src/i18n/`, the
`RegistryAdapter` SQL fragments in `src/advocates/registry-*.ts`). Views, routes
and repos read `tenant()` and never name a register table directly.

## Collector (pl)

`src/collector/`: `http.ts` (one request at a time, per-host spacing 10 s /
1 s / 2 s, back-off on 429/5xx, hard stop after 5 failures, optional HTTP proxy),
`parse-*.ts` (pure HTML parsers, fixtures in `src/__tests__/fixtures/pl/`),
`store.ts` (fill-never-erase upserts into `public.pl_lawyers`, cursors in
`public.pl_lawyers_crawl`), `jobs.ts` (probe, adwokaci-list, adwokaci-details,
radcowie-list, szukajradcy, daemon), `cli.ts`.

```bash
node dist/collector/cli.js daemon
node dist/collector/cli.js once probe|adwokaci-list|adwokaci-details|radcowie-list|szukajradcy [--no-proxy] [--limit N]
```

Env: `DATABASE_URL`, `HTTPS_PROXY` (ignored with `--no-proxy`), `COLLECTOR_UA`.
Never uses the registers' search forms, never touches `szukajradcy.pl/search`
(robots.txt), never bypasses a CAPTCHA.

## Outbound mail: unsubscribe, suppression, bounces

Every campaign message goes through `src/mail/sender.ts`, which refuses addresses
on `attorney_crm_suppression` (and leads ticked "do not contact"), adds
`List-Unsubscribe` (mailto + https) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
(RFC 2369 / 8058), and writes every attempt to `attorney_crm_mail_log` so a campaign
can be resumed without double sends and the failure rate is measurable. The link
`https://attorney.<domain>/u/<token>` is public: GET shows a confirmation, POST (the
page button or a mailbox provider's one-click POST) records the unsubscribe. The token
is `base64url(email).hmac(session secret)`, so no token table exists and a link stays
valid while the secret does. The mailto target `unsubscribe@<domain>` lands in the team
mailbox through the mail2 catch-all; add such requests with `mail suppress`.

Env (all optional): `ATTORNEY_CRM_SMTP_URL` (`smtp://user:pass@smtp.azurecomm.net:587`,
straight to Azure Communication Services with the Entra app login, so a throttle or a
refusal comes back to the sender and lands in the mail log instead of sitting in a
Postfix queue; user and password percent-encoded; unset = dry runs only), `ATTORNEY_CRM_MAIL_FROM` (default `<brand> <vladimir@<domain>>`, must be an
allowed MailFrom on the ACS domain), `ATTORNEY_CRM_REPLY_TO`,
`ATTORNEY_CRM_PUBLIC_URL` (default `https://attorney.<domain>`),
`ATTORNEY_CRM_UNSUBSCRIBE_MAILBOX` (default `unsubscribe@<domain>`).

```bash
C="docker exec -i attorney-crm-local node dist/cli.js mail"
$C check a@b.ua c@d.ua                       # which are blocked, and why
$C suppress a@b.ua manual "asked by phone"   # reasons: unsubscribe|bounce|complaint|manual
$C link a@b.ua                               # the unsubscribe URL for a footer
$C send --to a@b.ua --subject "..." --text body.txt --advocate 12345 --campaign nov-2026 --dry-run
$C stats nov-2026                            # sent / suppressed / failed / dry-run per campaign
# bounces: pipe mail2's log (status=bounced|expired) or an address list / CSV from the Azure portal
ssh mail2 "grep -h 'status=bounced\|status=expired' /var/log/mail.log*" | $C import-bounces
```

**Bounces arrive by webhook.** ACS answers `250` to every submission and reports the
real outcome later through Event Grid, so `POST /hooks/acs-events` is the only place a
hard bounce shows up. `Bounced` and `Suppressed` become `bounce`, `FilteredSpam` and
`Quarantined` become `complaint` (source `acs-event`); `Delivered`, `Expanded` and
`Failed` (possibly transient) suppress nothing. Reports for other sender domains on the
same ACS resource are ignored. The endpoint is public and authenticated by a key derived
from the session secret, sent as the `x-acs-hook-key` header (or `?key=`). Wire it once
per tenant, after the route is deployed (Event Grid validates the endpoint on creation):

```bash
KEY=$(ssh local.lex docker exec attorney-crm-local node dist/cli.js mail hook-key)
ACS=$(az communication show -n lexai-acs -g mail-relay --query id -o tsv)
az eventgrid system-topic create -g mail-relay -n lexai-acs-events --location global \
  --topic-type Microsoft.Communication.CommunicationServices --source "$ACS"
az eventgrid system-topic event-subscription create -g mail-relay --system-topic-name lexai-acs-events \
  -n attorney-crm-ua --endpoint https://attorney.legal.org.ua/hooks/acs-events \
  --included-event-types Microsoft.Communication.EmailDeliveryReportReceived \
  --delivery-attribute-mapping x-acs-hook-key static "$KEY" true
```

Azure quota ticket 2611080050001034 (08.11.2026) was filed on the promise of exactly
this: unsubscribe link, suppression list, bounce handling, failure rate under 1%.
