# lawrider.ch on GCP

Standalone stack for lawrider.ch on the `lawrider-gcp` VM
(`secondlayer-gpu` project, `europe-west6-a`, e2-highmem-4, static IP).
Serves the static site plus the unified-gateway MCP API (`ch_*` / `uk_*`
tools) on `mcp.lawrider.ch`, backed by a Postgres subset: full schema,
data only for `uk_*`/`ch_*` and small service tables (users, api_keys,
billing, …). The multi-TB UA/PL/US corpora stay on AWS as empty tables.

## Pipeline

`.github/workflows/deploy-lawrider-gcp.yml` — GitHub-hosted runner,
independent of the cthulhu/AWS runners.

- **deploy**: overlay core sources → rsync tree to the box → build
  `Dockerfile.mono-backend` on the box → `docker compose up` → health
  checks through the edge for both hosts.
- **migrate** (dispatch with `migrate=true`): one-off — restores the
  directory-format dump pushed from AWS prod into `/data/pgdump`
  (`migrate-from-aws.sh`), verifying row counts of every `uk_*`/`ch_*`
  table against the counts manifest shipped with the dump. The GCP box
  deliberately has no ssh access back to AWS.

Secrets: `LAWRIDER_GCP_HOST`, `LAWRIDER_GCP_SSH_KEY`, `CORE_REPO_SSH_KEY`.

## Box provisioning (already done, for the record)

- docker + compose, dirs `/data/pg`, `/data/redis`, `/data/pgdump`
- `/home/ubuntu/SecondLayer/deployment/.env.prod` — copied from AWS
  (rsync during deploy excludes it)
- `/home/ubuntu/lawrider/site` + Cloudflare Origin CA cert in
  `/home/ubuntu/certs-lawrider.ch` (covers `*.lawrider.ch`, valid to 2041)
- ssh: GitHub Actions deploy key (via instance metadata); the AWS box
  can push to this box, not the reverse

## Cutover

Cloudflare (lawrider.ch is proxied): point `lawrider.ch`, `www`, and add
`mcp` A-records to the VM's static IP. The origin cert is not
host-bound, so no cert work is needed. Roll back = point the records
back at AWS.
