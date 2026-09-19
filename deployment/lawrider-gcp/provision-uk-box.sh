#!/bin/bash
# Create the lawrider.uk VM in London.
#
# Driven by .github/workflows/provision-lawrider-uk.yml, and runnable by hand
# with gcloud if you would rather watch it. The logic lives here so the two
# cannot drift: the workflow authenticates and calls this file.
#
# ⚠ The workflow needs a GCP credential the repository did not have — every
# other lawrider workflow only ever needed SSH to a box that already existed.
# See the workflow header for the service account and the three roles.
#
# Everything after this is a pipeline: deploy-lawrider-uk.yml builds the image on
# the box and runs the migrations (MIGRATION_SET=uk, 134 of 220 — the schema is
# built here, not copied), and migrate-uk-data.yml moves the ~7 GB of uk_* rows
# and verifies them table by table.
#
# Why this size: the corpus is 6.9 GB across 16 tables, and the vectors to come
# are 1.3M points (~3 GB). The Zurich box it replaces is a 6 vCPU / 48 GB machine
# because it once held the Swiss corpus with qdrant on a 14 GB limit and an
# embedder on 10 GB; none of that is moving.
#
# Usage:
#   ./provision-uk-box.sh              # create
#   ./provision-uk-box.sh --dry-run    # print what it would do
#
# Environment: GCP_PROJECT, GCP_ZONE, VM_NAME, VM_MACHINE, VM_DISK_GB override
# the defaults; PROVISION_SSH_KEY names a private key to configure the box with
# instead of `gcloud compute ssh`.
set -euo pipefail

PROJECT="${GCP_PROJECT:-secondlayer-gpu}"
ZONE="${GCP_ZONE:-europe-west2-a}"        # London
REGION="${ZONE%-*}"
NAME="${VM_NAME:-lawrider-uk}"
MACHINE="${VM_MACHINE:-e2-standard-4}"    # 4 vCPU / 16 GB
DISK_GB="${VM_DISK_GB:-200}"
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="echo [dry-run]"

say() { echo "==> $*"; }

say "project $PROJECT, zone $ZONE, $MACHINE, ${DISK_GB}GB"

# A static address, so DNS and the LAWRIDER_GCP_HOST secret survive a VM rebuild.
if ! gcloud compute addresses describe "${NAME}-ip" --region="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  say "reserving static IP ${NAME}-ip"
  $DRY gcloud compute addresses create "${NAME}-ip" --region="$REGION" --project="$PROJECT"
else
  say "static IP ${NAME}-ip already reserved"
fi
IP=$(gcloud compute addresses describe "${NAME}-ip" --region="$REGION" --project="$PROJECT" --format='value(address)' 2>/dev/null || echo "<pending>")
say "address: $IP"

SSH_USER_NAME="${SSH_USER:-ubuntu}"

# The deploy key has to be on the box before the first ssh, and a new instance
# inherits only the project-wide keys — which are personal keys for `vovkes`,
# not the `ubuntu` key CI logs in with. That one lives in the Zurich box's own
# instance metadata, so it would not have followed us to London: the ssh loop
# further down would have retried for five minutes and failed with a timeout
# that reads like a machine which never booted.
#
# Derived from the private key rather than kept as a second secret, so the two
# halves cannot disagree. Instance-level ssh-keys are additive here — the
# project keys keep working, because nothing sets block-project-ssh-keys.
SSH_META=()
if [ -n "${PROVISION_SSH_KEY:-}" ]; then
  KEYFILE=$(mktemp)
  trap 'rm -f "$KEYFILE"' EXIT
  printf '%s:%s\n' "$SSH_USER_NAME" "$(ssh-keygen -y -f "$PROVISION_SSH_KEY")" > "$KEYFILE"
  SSH_META=(--metadata-from-file "ssh-keys=$KEYFILE")
  say "deploy key for ${SSH_USER_NAME} will be placed in the instance metadata"
fi

if gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$PROJECT" >/dev/null 2>&1; then
  say "instance $NAME already exists — nothing to create"
  # Re-running after the key changed should fix the box, not skip past it.
  # An `if` rather than `[ ... ] && ...`: the latter is the whole branch's exit
  # status, so under `set -e` the no-key case would end the script with a
  # failure precisely when nothing was wrong.
  if [ ${#SSH_META[@]} -gt 0 ]; then
    $DRY gcloud compute instances add-metadata "$NAME" \
      --zone="$ZONE" --project="$PROJECT" ${SSH_META[@]+"${SSH_META[@]}"}
  fi
else
  say "creating $NAME"
  $DRY gcloud compute instances create "$NAME" \
    --project="$PROJECT" --zone="$ZONE" \
    --machine-type="$MACHINE" \
    --image-family=ubuntu-2404-lts --image-project=ubuntu-os-cloud \
    --boot-disk-size="${DISK_GB}GB" --boot-disk-type=pd-balanced \
    --address="$IP" --network-tier=PREMIUM \
    --scopes=devstorage.read_write,logging.write,monitoring.write,trace \
    --labels=product=lawrider-uk,jurisdiction=uk \
    ${SSH_META[@]+"${SSH_META[@]}"}
fi

say "installing docker and the directories the stack expects"
# Everything below is idempotent: re-running this script on a live box is safe.
#
# Two ways in. From a workstation, `gcloud compute ssh` is simplest — it pushes a
# key into project metadata for you. From CI that is the wrong move: the runner
# would leave a fresh key in the project's metadata on every run, so when
# PROVISION_SSH_KEY names the deploy key we already have, use it directly and
# leave the project's metadata alone.
SETUP='

  set -e
  if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
  fi
  sudo mkdir -p /data/pg /data/redis /data/uk /home/ubuntu/lawrider/site
  sudo chown -R "$USER":"$USER" /data /home/ubuntu/lawrider
  # python for the refresh and export scripts (psycopg2, no build toolchain)
  if [ ! -x /home/ubuntu/uk-venv/bin/python3 ]; then
    sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv >/dev/null
    python3 -m venv /home/ubuntu/uk-venv
    /home/ubuntu/uk-venv/bin/pip -q install psycopg2-binary
  fi
  echo "box ready: $(docker --version), python $(/home/ubuntu/uk-venv/bin/python3 -V)"
'

if [ -n "${PROVISION_SSH_KEY:-}" ]; then
  say "configuring over ssh with the deploy key"
  # Not under dry run: there is no machine to answer, and the wait is five
  # minutes of a job that is supposed to print and exit.
  if [ -z "$DRY" ]; then
    for i in $(seq 1 30); do
      ssh -i "$PROVISION_SSH_KEY" -o StrictHostKeyChecking=accept-new \
          -o ConnectTimeout=10 "${SSH_USER_NAME}@${IP}" true 2>/dev/null && break
      [ "$i" = 30 ] && { echo "!!! no ssh after 5 minutes — check the deploy key is in the instance metadata" >&2; exit 1; }
      sleep 10
    done
  fi
  $DRY ssh -i "$PROVISION_SSH_KEY" -o StrictHostKeyChecking=accept-new \
      "${SSH_USER_NAME}@${IP}" "$SETUP"
else
  say "configuring over gcloud compute ssh"
  $DRY gcloud compute ssh "$NAME" --zone="$ZONE" --project="$PROJECT" --command="$SETUP"
fi

cat <<EOF

Next, by hand because they are secrets and DNS:

  1. deployment/.env.prod on the box  — pg/redis passwords, JWT_SECRET, LLM keys.
     The deploy refuses to run without it and does not rsync it.
  2. /data/uk/db.env and /data/uk/research.env, both 0600 — the DSN and the
     research.legislation.gov.uk login the weekly refresh reads. Outside the repo
     tree so that rsync --delete on a deploy cannot remove them.
  3. Cloudflare: point lawrider.uk, www and mcp at $IP (proxied). The zone is in
     the mcvovkes@gmail.com account; the scoped token is on cthulhu at
     /home/vovkes/SecondLayer/.env.cloudflare.lawrider-uk.
  4. An origin certificate for this box, or set the zone back to Full while the
     old one is still in place. Full (strict) with a certificate for the other
     box's name is a 526 on every request.
  5. Repository secret LAWRIDER_GCP_HOST -> $IP, which is what points every
     workflow at the new machine.

Then: run deploy-lawrider-uk.yml, then migrate-uk-data.yml.
EOF
