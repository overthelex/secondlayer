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

## Cutover to lawrider.uk

Not done yet — the domain did not resolve at all when this was written, and the
deploy is built to work anyway: its health checks pin the address with
`curl --resolve`, so they test this origin with or without DNS.

To go live: register `lawrider.uk`, add the zone to Cloudflare, and point
`lawrider.uk`, `www` and `mcp` at the VM's static IP (proxied).

⚠ Then replace the origin certificate. `/home/ubuntu/certs-lawrider.ch` covers
`*.lawrider.ch` and does **not** match the new names. Behind Cloudflare in Full
mode that is invisible, and the deploy's own check passes `-k`, so nothing will
tell you — until the zone is set to Full (strict) and every request becomes a
526. Issue a Cloudflare Origin CA cert for `lawrider.uk` + `*.lawrider.uk`,
mount it, and repoint every `ssl_certificate` / `ssl_certificate_key` pair in
`nginx/edge.conf` — there are four server blocks, not one.
