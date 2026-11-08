# lawrider.ch on cthulhu

The Swiss product (static site on `lawrider.ch`, MCP API on `mcp.lawrider.ch`,
`ch_*` tools only) runs on cthulhu (local.lex), the same machine as
legal.org.ua. It moved here from the GCP VM `lawrider-gcp` on 2026-09-18.
The UK corpus did **not** move: it stays on GCP (`deployment/lawrider-gcp`).

Since 2026-11-07 the same stack also serves **lawrider.pl**: `lawrider.pl` /
`www.lawrider.pl` show the same static site, and `mcp.lawrider.pl` is a second
instance of the backend image (`app-pl`, container `lawrider-app-pl`) with
`MCP_TOOLSET=all`, i.e. the full tool registry. The Polish corpus (`pl_acts`,
`pl_act_articles`, `pl_act_units`, `pl_court_decisions`, ... restored from the
AWS prod archive) lives in this stack's Postgres, deliberately apart from the
Ukrainian data in `secondlayer_local`. The three hostnames are extra ingress
rules on the same Cloudflare tunnel and CNAMEs in the `lawrider.pl` zone
(account shepherdvovkes, next to `lawrider.ch`). `mcp.lawrider.ch` keeps its
Swiss-only gate; the deploy job asserts both: `ch_*` only on the CH container,
the full registry on the PL one.

## Isolation from legal.org.ua

The whole point of this layout is that nothing here can take legal.org.ua down.

| | legal.org.ua | lawrider.ch |
|---|---|---|
| workflow | `ci-local-deploy.yml` → `deploy-local` | `deploy-lawrider-cthulhu.yml` |
| runner label | `cthulhu` | `cthulhu-lawrider` (`~/actions-runner-lawrider`) |
| checkout | `~/SecondLayer` | `~/lawrider/repo` |
| compose project / network | `deployment` / `deployment_secondlayer-local` | `lawrider` / `lawrider` |
| ingress | `nginx-local` on 80/443 | Cloudflare tunnel `lawrider-on-cthulhu` → `lawrider-edge:80` |
| host ports | many | only `127.0.0.1:5448` (pg, for the crons) |

- Every service has a memory cap (about 48G in total) and the heavy ones a CPU cap.
  The image build and the crons run under `nice -n 10 ionice -c3`.
- `.github/actions/detect-changes` ignores `deployment/lawrider*/`, so a change
  here does not rebuild legal.org.ua.
- The workflow checks `https://legal.org.ua/health` before and after the deploy and
  fails if it went from 200 to anything else.

## Box state (not in git)

- `~/lawrider/.env.lawrider` also carries `ATTORNEY_CRM_PL_SESSION_SECRET` (random 48 bytes hex) and `PL_PROXY_HOST` (public IP of the GCP VM `pl-proxy`).
- `~/lawrider/pl-egress.key` (+ `.pub`): ed25519 key the `pl-egress` sidecar uses as user `egress` on `pl-proxy`. Create it before the first deploy of the CRM: a missing file makes docker bind-mount an empty directory of that name.

- `~/lawrider/.env.lawrider` (mode 600): the GCP `.env.prod` plus `LAWRIDER_TUNNEL_TOKEN`.
- `/data/lawrider/{pg,redis,qdrant,site}`, `/data/ch-corpus` (pipeline raw files and logs), `/data/echr`.
- `~/lawrider/ch-pipeline-venv`: `python3 -m venv` + `pip install -e ~/lawrider/repo/services/ch-pipeline`.
- `~/lawrider/migrate/`: the one-off GCP → cthulhu sync script and its logs.

## Polish attorney CRM (attorney.lawrider.pl, 2026-11-08)

The same `attorney_crm/` app as attorney.legal.org.ua, started with
`ATTORNEY_CRM_TENANT=pl`: English UI, lawrider branding, Warsaw time, the
register is `public.pl_lawyers` (adwokaci from rejestradwokatow.pl, radcowie
prawni from rejestrradcow.pl, radcowie contacts from szukajradcy.pl) and the CRM
tables live in schema `attorney_crm_pl` of `secondlayer_prod`. Separate users and
passwords from the Ukrainian CRM. Design and source rules:
`docs/superpowers/specs/2026-11-08-attorney-crm-pl-design.md`.

Containers: `attorney-crm-pl` (web, :3020 inside the network, reached as
attorney.lawrider.pl through lawrider-edge), `attorney-crm-pl-collector`
(daemon: both lists weekly Sun 02:00, adwokat profiles continuously at one
request per 10 s, szukajradcy monthly) and `pl-egress` (autossh tunnel to the GCP
VM `pl-proxy` in europe-central2; the collector's `HTTPS_PROXY` is
`http://pl-egress:8118`, so the registers see a Polish address).

```bash
# users (passwords are printed once, only scrypt hashes are stored)
docker exec -e ATTORNEY_CRM_TENANT=pl attorney-crm-pl node dist/cli.js set-password vladimir@lawrider.pl 'Vladimir'

# collector by hand (--no-proxy only for a probe from cthulhu itself)
docker compose -p lawrider --env-file ~/lawrider/.env.lawrider run --rm attorney-crm-pl-collector node dist/collector/cli.js once probe
docker compose -p lawrider --env-file ~/lawrider/.env.lawrider run --rm attorney-crm-pl-collector node dist/collector/cli.js once adwokaci-details --limit 50
docker logs -f attorney-crm-pl-collector

# progress
docker exec pg-lawrider psql -U secondlayer -d secondlayer_prod -c "select profession, status, count(*), count(phone) phones, count(email) emails from public.pl_lawyers group by 1,2 order by 1,2"
docker exec pg-lawrider psql -U secondlayer -d secondlayer_prod -c "select source, cursor, updated_at from public.pl_lawyers_crawl"
```

If a register starts answering 403/429 the collector stops after five
consecutive failures and the daemon retries a minute later; check
`docker logs attorney-crm-pl-collector` before touching the delays (they are the
sites' own robots.txt values or stricter).

## Crons

`cron/crontab.fragment` holds the CH pipeline schedule, in Kyiv local time
(Debian cron ignores `CRON_TZ`). Install it by appending it to the end of
`crontab -l` of `vovkes`. Its `PATH=` and `CHPIPE_*` lines apply to every entry
below them, so it must stay at the end.
The scripts read `CHPIPE_REPO`, `CHPIPE_ENV_FILE` and `CHPIPE_PG_PORT`. Their
defaults are the old GCP values, so the same scripts still work there.

## Rollback to GCP (first 7 days)

1. Cloudflare DNS: point `lawrider.ch`, `www`, `mcp` back to A `34.65.12.234` (proxied).
2. On GCP: `cd ~/SecondLayer/deployment/lawrider-gcp && docker compose --env-file ../.env.prod up -d`
   and uncomment the `#MIGRATED-TO-CTHULHU` lines in `crontab -l`.
3. Here: `docker compose -p lawrider down` and remove the cron block. legal.org.ua
   is not affected by either step.

Anything written on cthulhu after the cutover (new decisions, users, API keys) is
not on GCP. A rollback after the first delta needs a reverse sync.
