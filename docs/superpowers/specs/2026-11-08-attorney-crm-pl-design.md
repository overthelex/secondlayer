# Attorney CRM Poland (attorney.lawrider.pl) — design

Date: 2026-11-08. Author: Ватт with Claude. Status: draft for builder check.
Predecessor: `docs/superpowers/specs/2026-11-07-attorney-crm-design.md` (the Ukrainian
CRM at attorney.legal.org.ua, live since 07.11.2026). This document describes only what
differs; everything not mentioned stays as in the predecessor.

## Intent

lawrider.pl wants to sell its Polish legal-research service to practising Polish
lawyers: adwokaci (bar, Naczelna Rada Adwokacka) and radcowie prawni (legal advisers,
Krajowa Izba Radców Prawnych). Three people will phone and e-mail them and need the
same working surface the Ukrainian team has: who to call today, what is known about
the person, what was said last time.

Unlike Ukraine, there is no ready registry table in our database. The data has to be
collected from the two official public registers and one official directory first.

## Goals

- A private web app at https://attorney.lawrider.pl/ on cthulhu, lawrider branding
  (lawrider logo and palette, not the LX mark), **English UI**.
- Login from a dedicated users table. Three accounts seeded: vladimir@lawrider.pl,
  leo@lawrider.pl, vitalii@lawrider.pl. Passwords generated at setup, printed once in
  chat, only scrypt hashes stored.
- One table of lawyers of both professions, default filter **practising**, with a
  Profession column (Adwokat / Radca prawny) and filters by profession, chamber
  (izba / OIRP), city, practice area, stage, surname prefix; sortable like the UA
  table.
- Practice areas: the lawyer's **self-declared** areas as published by the registers
  (27 NRA categories for adwokaci, free tags from szukajradcy.pl for radcowie),
  plus manual tags set by the team. Shown with their source. No court-derived areas:
  Polish judgments anonymise counsel, so the ЄДРСР-style derivation has no analogue.
- Contact log and "Today" page exactly as in the UA CRM.
- A collector that fills and refreshes the lawyers table from the public sources,
  running from cthulhu through a Polish IP (a small GCP VM in Warsaw), politely and
  resumably.

## Non-goals

- No CEIDG (business register) enrichment yet: it needs an API account the owner
  cannot create right now. The schema leaves room for it (`contact_source`).
- No crawling of the 19 OIRP chamber websites.
- No use of the registers' search forms (they carry reCAPTCHA; we never bypass a
  CAPTCHA) and no use of szukajradcy.pl `/search` (disallowed by its robots.txt).
- No shared users, notes or leads with the Ukrainian instance. Same code, separate
  deployment, separate database.
- No e-mail or telephony integration.

## Anti-goals

- Getting the collector's IP blocked or embarrassing lawrider.pl: the collector must
  honour `Crawl-delay: 10` on rejestradwokatow.pl, identify itself with a UA string
  that names lawrider.pl and a contact address, and stop on repeated 429/403.
- Showing radcowie without contacts as if they were unreachable leads. The table
  must make "no public contact" visible (and filterable), not blank.
- Taking lawrider.pl / mcp.lawrider.pl or legal.org.ua down with this deploy. The
  CRM joins the isolated `lawrider` stack and its workflow, never `ci-local-deploy`.
- Losing CRM data on re-collection. Leads and notes key on the register's stable
  identifier, never on a serial id; the collector upserts, never truncates.

## Sources (verified 08.11.2026)

### rejestradwokatow.pl (adwokaci, NRA)
- Public list, GET, no CAPTCHA: `https://rejestradwokatow.pl/adwokat/list/strona/{1..352}`,
  100 rows/page, 35.2K rows of all statuses. Columns: surname, first name, middle name,
  town, chamber (24 izby), status (`Wykonujący zawód` / `Niewykonujący zawodu` /
  `Były adwokat`), link to the profile.
- Profile `https://rejestradwokatow.pl/adwokat/{slug}-{id}` (GET): full name, entry
  number such as `WAW/Adw/4`, status, entry date, old entry number, correspondence
  address (office name, street, postcode town), mobile and landline phone, e-mail
  (field exists, often empty), office block, `PREFEROWANA PRAKTYKA` = 0..27 declared
  practice areas, and the chamber's own contact block (to be ignored).
- robots.txt: `Crawl-delay: 10`. Practising adwokaci: 241 search pages ≈ 24.1K.
  At one request per 10 s: list ≈ 1 h, practising profiles ≈ 67 h, all profiles ≈ 98 h.

### rejestrradcow.pl (radcowie prawni, KIRP)
- ASP.NET MVC list, POST `https://rejestrradcow.pl/Home/GetDataW` with form fields
  `nazwisko, imie, nrwpisu, districts, cities, stan, page`; returns an HTML fragment of
  15 rows. `stan=1` (practising) → 2,959 pages ≈ 44.4K; `stan=0` (all) → 3,835 pages
  ≈ 57.5K. Row: SURNAME, GIVEN NAMES, entry number (e.g. `WR-4293`), chamber
  (`OIRP WROCŁAW`, 19 chambers), town, status (`Wykonuje zawód` / `Nie wykonuje zawodu`).
- **No profile pages, no phones, no e-mails.** No robots.txt (404); we self-impose
  1 request/s.

### szukajradcy.pl (KIRP's official "find a radca" directory)
- WordPress site, 3,371 radcowie who opted in. Profile
  `https://szukajradcy.pl/lawyers/{slug}`: name, town, office name, e-mail, address,
  `tel:` link, website, "Numer uprawnień" (= the register's entry number, join key),
  practice tags (free list, e.g. `cywilne`, `pracy`, `zamówienia publiczne`).
- Enumeration without `/search`: the 241 city pages `/radca-prawny-{city}` from
  `pages-sitemap.xml` (≤24 profiles each, no pagination) and the "Podobni radcowie"
  links on every profile (breadth-first from the city seeds). Measured 08.11: the 241
  city pages alone expose 1,905 distinct profiles (57% of 3,371); the BFS over
  "Podobni radcowie" (2 links per profile) is expected to add most of the rest and the
  final coverage is reported against the 3,371 figure; whatever is unreachable this way stays without
  contact. robots.txt disallows only `/search` and `/wp-admin/`; self-imposed
  1 request/2 s.

### Regional chamber (OIRP) sites (added 09.11.2026)
- Of the 19 chambers, six publish contacts, all opt-in: Kraków (`/radcy/?page=N`, 507 pages of
  cards with the `KR-` entry number and, on ~7% of them, phone/e-mail; `/kancelarie/?page=N`,
  67 pages of firm cards with NIP, phone, e-mail, website), Olsztyn (one TablePress table of
  465 firms), Opole (`/kancelarie?page=N`, 61 pages; e-mail and website on `/kancelarie/{id}`),
  Zielona Góra (one page of cards with the radca's name and number), Szczecin (103 tiles,
  contacts on `/kancelaria/{slug}/`), Rzeszów (`/json/kancelaria.json`, 771 firms, 606 with
  e-mail). Twelve chambers publish names only; Wrocław's robots.txt disallows everything and
  is not fetched. Self-imposed 1 request/3 s per host.
- Matching never leaves the chamber: entry number (exact, then with punctuation removed)
  where printed, else the person's name against the chamber's register rows, with a
  one-person firm name reduced to its two or three name words. Partnerships and firms
  naming several people are never attached to anyone. Expected yield ≈1–1.5K radcowie.

### Numbers to expect
Adwokaci 35.2K (24.1K practising, most with a phone). Radcowie 57.5K (44.4K
practising), of whom at most ~3.4K get contacts from szukajradcy.pl and ≈1–1.5K more
from the chamber sites. The team's
callable universe is therefore ≈27K people; the other 41K radcowie are listed for
completeness and for later CEIDG enrichment.

## Data model (database `secondlayer_prod` in `pg-lawrider`, the lawrider stack)

Registry table in `public`, next to the `pl_*` corpus tables:

```
pl_lawyers (
  lawyer_id      TEXT PRIMARY KEY,   -- 'adw:{numeric id from the profile URL}' | 'radca:{entry number}'
  profession     TEXT NOT NULL CHECK (profession IN ('adwokat','radca')),
  surname        TEXT NOT NULL, given_names TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','inactive','former')),
  status_raw     TEXT NOT NULL,
  chamber        TEXT,               -- 'Izba Adwokacka w Warszawie' | 'OIRP WARSZAWA'
  city           TEXT, postcode TEXT, address TEXT, office_name TEXT,
  phone          TEXT, phone2 TEXT, email TEXT, website TEXT,
  contact_source TEXT,               -- 'register' | 'szukajradcy' | NULL
  entry_number   TEXT, entry_date DATE,
  practices      TEXT[] NOT NULL DEFAULT '{}',  -- declared, canonical codes (see taxonomy)
  practice_tags_raw TEXT[] NOT NULL DEFAULT '{}', -- source wording, for display
  profile_url    TEXT, directory_url TEXT,
  list_seen_at   TIMESTAMPTZ NOT NULL, detail_fetched_at TIMESTAMPTZ,
  raw            JSONB NOT NULL DEFAULT '{}'
)
pl_lawyers_crawl (source TEXT, cursor JSONB, updated_at TIMESTAMPTZ)  -- resume state per source
```

`status`: adwokat `Wykonujący zawód` → active, `Niewykonujący zawodu` → inactive,
`Były adwokat` → former; radca `Wykonuje zawód` → active, else inactive.

CRM tables (`attorney_crm_users`, `_sessions`, `_leads`, `_notes`,
`_schema_version`) are created by the existing `sql/002_crm_core.sql` unchanged, in
schema `attorney_crm_pl` of the same database, by starting the service with
`search_path=attorney_crm_pl,public`. `attorney_crm_leads.advocate_source_id` holds
`pl_lawyers.lawyer_id`. `sql/001` and `sql/003` (ЄДРСР derivation) are not applied
for this tenant. The schema is created with `CREATE SCHEMA IF NOT EXISTS` at start.

**Team corrections survive re-collection (my call, after the builder check).** A new
`sql/004_contact_overrides.sql` (applied for both tenants, harmless for UA) adds to
`attorney_crm_leads`: `do_not_contact BOOLEAN NOT NULL DEFAULT false`,
`do_not_contact_reason TEXT`, `phone_override TEXT`, `email_override TEXT`. The lawyer
page gets a "Do not contact" toggle with a reason, and editable override fields. The
list and lawyer pages show the override when set (marked "manual"), the Today page
never lists a `do_not_contact` lead, and the list shows a visible badge for them. The
collector writes only to `pl_lawyers`; it never reads or touches `attorney_crm_*`, so
overrides and the flag can never be lost by a crawl. Rationale: Polish law requires
prior consent for direct-marketing calls and e-mails (PKE art. 398, UŚUDE art. 10) and a
GDPR art. 21 objection must stick; `stage = declined` is a sales state, not a legal one.

## Practice taxonomy

The 27 NRA categories are the canonical list, each with a code, the Polish label and
an English label (e.g. `civil` = "Prawo i postępowanie cywilne" / "Civil law and
procedure"; `criminal`, `family`, `commercial`, `companies`, `tax`, `labour`,
`real_estate`, `administrative`, `ip`, `public_procurement`, `restructuring`, ...).
szukajradcy tags are mapped onto these codes by a fixed table in code where the
meaning is the same (`cywilne` → `civil`, `pracy` → `labour`, `zamówienia publiczne` →
`public_procurement`, ...); tags with no match are kept in `practice_tags_raw` and
shown as "Other: …". Manual tags use the same 27 codes. The filter matches declared
or manual.

## Application changes (`attorney_crm/`, one codebase, two tenants)

- `ATTORNEY_CRM_TENANT=ua|pl` (default `ua`, so the live UA instance is unchanged).
  A tenant module provides: brand (name, domain, logo file, accent colour), locale
  strings (uk for ua, en for pl), the registry adapter (table, select list, active
  predicate, city/region/chamber expressions, surname column, profession column or
  none), the practice taxonomy and labels, and feature flags: `derivedPractices`
  (ua: on, pl: off), `profession` column (pl only).
- All user-visible strings move from templates into the locale dictionary; the UA
  dictionary reproduces today's Ukrainian text byte for byte (existing tests pin it).
- Table columns for pl: Name / Town / Chamber (sort links), Profession, Contacts
  (phones and e-mail stacked, or "no public contact"), Office, Entry no. + date,
  Practices (declared chips, then manual chips), Stage, Next / last contact.
- Lawyer page: same layout as the UA advocate page, with the declared practices and
  the raw tags, links to `profile_url` and `directory_url`.
- The derivation worker and its SQL files are skipped when `derivedPractices` is off;
  `ATTORNEY_CRM_SCHEMA` (default empty) sets `search_path` on every pool connection.
- Static assets: `logo-lawrider.png` added; the tenant picks the logo.

## Collector (`scripts/pl-lawyers/`, TypeScript, Node 20)

Three commands, each resumable from `pl_lawyers_crawl` and safe to re-run:
1. `adwokaci-list` — walks the 352 list pages, upserts name/town/chamber/status and
   `profile_url`, sets `list_seen_at`. Rows not seen in a full walk are marked
   `status='former'` only after the walk completed without errors.
2. `adwokaci-details [--status active]` — fetches profiles whose `detail_fetched_at`
   is null or older than `--max-age` (default 90 days), practising first; parses the
   blocks listed above; 10 s between requests.
3. `radcowie-list` — POSTs `GetDataW` for `stan=0`, all pages; upserts. Rows not seen
   in a completed full walk are marked `inactive` (the register has no "former").
4. `szukajradcy` — seeds from the 241 city pages, BFS over "Podobni radcowie", parses
   profiles, joins to `pl_lawyers` by entry number (fallback: surname + given names +
   town, unique match only), sets contacts with `contact_source='szukajradcy'`,
   `directory_url`, tags. Reports matched / unmatched / unreachable counts.

Common: `HTTPS_PROXY` honoured (undici `ProxyAgent`); User-Agent
`lawrider.pl attorney-crm collector (+https://lawrider.pl; vladimir@lawrider.pl)`;
exponential back-off on 429/5xx, abort after 5 consecutive failures; every run writes
a one-line summary to `~/lawrider/pl-lawyers.log`. Unit tests with saved HTML fixtures
for each parser (the recon pages under `scripts/pl-lawyers/fixtures/`).

**Where it runs (my call, after the builder check):** inside the `lawrider` compose
stack, not as a host process (the box has no Node toolchain for host jobs and the
deploy rsyncs without `node_modules`). The collector is compiled into the same image
as the CRM (`attorney_crm/src/collector/`), and a second service
`attorney-crm-pl-collector` runs it as a long-lived scheduler process (like the UA
derivation worker): lists weekly (Sunday night), adwokaci details continuously until
caught up and then re-fetch older than 90 days, szukajradcy monthly. One process, so
the per-host crawl delay is enforced in one place. Logs go to the container's stdout
(json-file, capped). A `--once <command>` mode exists for manual runs via
`docker compose -p lawrider run --rm attorney-crm-pl-collector`. Initial load: lists
≈ 2 h, szukajradcy ≈ 3 h, practising adwokaci profiles ≈ 3 days.

## Polish egress (GCP)

VM `pl-proxy`: project `secondlayer-gpu` (gcloud account mcvovkes@gmail.com, i.e.
created from the MacBook), zone `europe-central2-a` (Warsaw), `e2-micro`, Ubuntu
24.04, 10 GB disk, static external IP, no HTTP ports open (the existing
`default-allow-ssh` rule suffices). On it: `tinyproxy` bound to `127.0.0.1:8888`, and
the public key of a dedicated `pl-egress` ed25519 key pair in the instance metadata.

**Tunnel as a sidecar (my call):** service `pl-egress` in the lawrider compose
(`alpine` + `openssh-client` + `autossh`, the private key mounted read-only from
`~/lawrider/pl-egress.key`), running
`autossh -M 0 -N -g -L 0.0.0.0:8118:127.0.0.1:8888 egress@<pl-proxy ip>` with
`ServerAliveInterval 30`. On the `lawrider` network it is reachable as
`http://pl-egress:8118`; the collector gets `HTTPS_PROXY=http://pl-egress:8118`.
No host systemd unit, no host ports. Cost ≈ $7–8/month.

**Order and fallback (my call):** the VM and sidecar come first, and the very first
collector task is a probe that fetches one page from each of the three sites through
the proxy and logs status and latency. Both registers also answer cthulhu directly,
so the proxy is a policy choice (Polish IP for Polish public data), not a technical
need. If a site refuses the GCP address (403/429 on the probe), the collector stops
and the choice between direct egress from cthulhu and another Polish egress is
escalated to the owner; it does not fall back silently. `--no-proxy` exists for that
decision, off by default.

## Hosting and deploy

- Service `attorney-crm-pl` in `deployment/lawrider-cthulhu/docker-compose.yml`:
  image `attorney-crm-pl:latest` built from `deployment/Dockerfile.attorney-crm`
  (context `../..`; a distinct tag so the UA stack's `attorney-crm:latest` is never
  shared), container `attorney-crm-pl`, network `lawrider`, no host ports, env
  `ATTORNEY_CRM_TENANT=pl`,
  `ATTORNEY_CRM_SCHEMA=attorney_crm_pl`, `ATTORNEY_CRM_DERIVATION=off`,
  `DATABASE_URL` → `pg-lawrider`, `ATTORNEY_CRM_SESSION_SECRET` from
  `~/lawrider/.env.lawrider` (new key, set by hand once, `:-` not `:?` so a missing key
  can never block mcp.lawrider.pl), memory cap 512M, healthcheck `/healthz`. The Today
  page's "today" is computed in the tenant's timezone (`Europe/Warsaw`; UA keeps
  `Europe/Kyiv`), not a hard-coded one.
- Ingress: CNAME `attorney.lawrider.pl` → tunnel `4e367b71-…cfargotunnel.com`
  (proxied); tunnel ingress rule `attorney.lawrider.pl → http://lawrider-edge:80`
  added before the 404 catch-all; `edge.conf` server block → `attorney-crm-pl:3020`
  with `X-Forwarded-Proto https` and the Cloudflare real-IP headers (the CRM sets
  `trust proxy`). No origin certificate needed (tunnel).
- `deploy-lawrider-cthulhu.yml`: add `attorney_crm/**` and
  `deployment/Dockerfile.attorney-crm` to `paths`, build the image, and probe
  `Host: attorney.lawrider.pl` `/healthz` through the edge after `nginx -s reload`
  (PR #2651 pattern).
- Users seeded with the existing CLI (`node dist/cli.js set-password`) once the
  container is up; passwords printed in chat once.

## Constraints

- English UI for this tenant (the project's Ukrainian-UI rule applies to the UA
  tenant only); Polish proper names and register wording are shown as in the source.
- No changes to the Ukrainian instance's behaviour, data or URL space.
- Postgres 15 (pg-lawrider), Node 20, same test stack (jest + ts-jest + supertest).
- The collector never runs from the MacBook; it runs on cthulhu under `~/lawrider`.

## Left to the builder

- Exact HTML selectors and the regexes for the profile blocks; the fixture pages from
  the recon are the reference.
- How the tenant module is wired (module per tenant vs. one JSON config); the
  requirement is only that `ATTORNEY_CRM_TENANT` picks it and UA output is unchanged.
- Whether the 27-code taxonomy and the szukajradcy tag map live in one `practices.ts`
  per tenant or a shared file with per-tenant tables.
- Page size, sort defaults and chip styling, as long as they match the UA instance.
