> ⚠ **The UK pipeline lives in `overthelex/lawrider-uk` since 2026-09-22.**
>
> What is still here is what builds and serves the application: `docker-compose.yml`
> (which builds the backend image with `context: ../..` plus the proprietary
> `secondlayer-core` overlay), `nginx/edge.conf`, `known_hosts`, and
> `deploy-lawrider-uk.yml`. Provisioning, the corpus scripts, the repairs and the
> other four workflows moved, because none of them needs this tree.
>
> The rule: building the corpus belongs there, serving it belongs here.

# lawrider.uk on GCP

Standalone stack for **lawrider.uk**, the British product, on the
`lawrider-gcp` VM (`secondlayer-gpu` project, `europe-west6-a`, e2-highmem-4,
static IP). Serves the static site plus the unified-gateway MCP API (`uk_*`
tools, `MCP_TOOLSET=uk`) on `mcp.lawrider.uk`.

The corpus: 238,926 acts, 1.78M provisions of current text, 1.64M point-in-time
intervals across 62,866 acts, 1.21M amendments. Refreshed weekly from
research.legislation.gov.uk, which is OGL v3.0.

⚠ `uk_court_decisions` is on this box but is **not** part of the product: the
Find Case Law licence application is undecided and no tool reaches those
judgments (LEXAI-2056).

## What moved away

This box used to be lawrider.ch. On 2026-09-18 the Swiss product moved to
cthulhu (`deployment/lawrider-cthulhu`, `deploy-lawrider-cthulhu.yml`) — stack,
crons and Cloudflare tunnel. The GCP crontab now holds only the UK refresh.

The `ch_*` tables and `/data/qdrant` (22.3M-point `ch_corpus_bge_cls`) are still
on disk on purpose: cheap to keep, expensive to rebuild, and the fastest
rollback if the move has to be undone. Nothing starts a container against them —
`qdrant` and `tei-bge-m3` were removed from the compose file, which is where
their 14G and 10G memory limits went.

## Pipeline

`.github/workflows/deploy-lawrider-uk.yml` — GitHub-hosted runner, SSH to the
box, independent of the cthulhu runners. Runs on pushes to `main` that touch
this directory, `mcp_backend/`, `packages/shared/` or the backend Dockerfile.

- overlay core sources → rsync the tree to the box → build
  `Dockerfile.mono-backend` there → `docker compose up -d --remove-orphans`
- health checks: the app container must report healthy, the edge must answer
  for `lawrider.uk` and `mcp.lawrider.uk` (via `--resolve`, so this works
  before the domain has DNS), and the advertised tool list must be `uk_*` and
  nothing else
- the weekly data refresh is a separate pipeline:
  `.github/workflows/cron-uk-refresh.yml`

The one-off AWS restore job is gone: `/data/pgdump` was deleted from the box on
2026-09-03 after the data was verified, and the AWS instance was terminated the
same day, so the job could only fail while reading as a recovery path.

## Box provisioning (already done, for the record)

- docker + compose, dirs `/data/pg`, `/data/redis`, `/data/uk`
- `/home/ubuntu/SecondLayer/deployment/.env.prod` (rsync during deploy
  excludes it)
- `/data/uk/db.env` and `/data/uk/research.env`, both `0600` — the DSN and the
  research.legislation.gov.uk login the weekly refresh reads. They live outside
  the repo tree so `rsync --delete` on a deploy cannot remove them.
- `/home/ubuntu/uk-venv` — python with psycopg2 for the refresh scripts
- `/home/ubuntu/lawrider/site` + Cloudflare Origin CA cert in
  `/home/ubuntu/certs-lawrider.ch`
- ssh: GitHub Actions deploy key via instance metadata

## lawrider.uk: live since 2026-09-19

The zone is `lawrider.uk` in the **mcvovkes@gmail.com** Cloudflare account — not
the `shepherdvovkes@icloud.com` one that holds lawrider.ch and legal.org.ua. It
was registered there through Cloudflare Registrar on 18 Sep, which is why its
nameserver pair differs from every other zone in the estate. A duplicate zone
briefly created in the icloud account was deleted; do not recreate it, it can
never activate.

⚠ Two boxes exist while the move is in progress, and the addresses are easy to
mix up. `34.65.12.234` is the ORIGINAL box in europe-west6 (Zurich), which still
serves lawrider.uk today. `8.228.38.154` is the London box in europe-west2,
built 2026-09-19, which holds the corpus and is where every workflow now points
— `LAWRIDER_GCP_HOST`, and the host keys pinned in `known_hosts` here. DNS has
NOT been cut over: doing so before the account tables move would drop 199 users
and 27 API keys. See LEXAI-2059.

`lawrider.uk`, `www` and `mcp` are proxied A records to the Zurich VM's static
IP (34.65.12.234). SSL mode is **Full** and can now be Full (strict): the origin
presents a Cloudflare Origin CA certificate for `lawrider.uk` + `*.lawrider.uk`,
issued 2026-09-19 and valid to 2041-09-15, in `/home/ubuntu/certs-lawrider.uk`.
The private key was generated on the box and has never left it.

API access for the zone is a scoped token on cthulhu at
`/home/vovkes/SecondLayer/.env.cloudflare.lawrider-uk` (0600) — DNS Write, Zone
Read, Zone Settings Write, SSL and Certificates Write, that zone only.
