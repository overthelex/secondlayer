# lawrider.ch on cthulhu

The Swiss product (static site on `lawrider.ch`, MCP API on `mcp.lawrider.ch`,
`ch_*` tools only) runs on cthulhu (local.lex), the same machine as
legal.org.ua. It moved here from the GCP VM `lawrider-gcp` on 2026-09-18.
The UK corpus did **not** move: it stays on GCP (`deployment/lawrider-gcp`).

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

- `~/lawrider/.env.lawrider` (mode 600): the GCP `.env.prod` plus `LAWRIDER_TUNNEL_TOKEN`.
- `/data/lawrider/{pg,redis,qdrant,site}`, `/data/ch-corpus` (pipeline raw files and logs), `/data/echr`.
- `~/lawrider/ch-pipeline-venv`: `python3 -m venv` + `pip install -e ~/lawrider/repo/services/ch-pipeline`.
- `~/lawrider/migrate/`: the one-off GCP → cthulhu sync script and its logs.

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
