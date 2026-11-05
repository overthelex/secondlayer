#!/usr/bin/env bash
set -euo pipefail

# ─── Ephemeral Analytics Replica ─────────────────────────────────────────────
# Spins up a temporary EC2 Spot Instance from an EBS snapshot of prod,
# runs compute-judge-analytics on it, copies results back to prod, tears down.
#
# Usage:
#   ./scripts/ephemeral-analytics-replica.sh              # full run
#   ./scripts/ephemeral-analytics-replica.sh --dry-run    # show plan only
#   ./scripts/ephemeral-analytics-replica.sh --cleanup    # force cleanup orphaned resources
#
# Prerequisites:
#   - AWS CLI configured with eu-central-1 credentials
#   - SSH key ~/.ssh/secondlayer-prod at hand
#   - jq installed
# ─────────────────────────────────────────────────────────────────────────────

# ── Config ───────────────────────────────────────────────────────────────────
REGION="eu-central-1"
AZ="eu-central-1a"
PROD_VOLUME_ID="vol-052feab2cc72e9b30"
PROD_INSTANCE_ID="i-04e39a795576e33f0"
PROD_SG="sg-02cce7a00ae2890d1"
# Subnets per AZ for fallback
SUBNET_AZ_A="subnet-0006cea700b3d9b8b"
SUBNET_AZ_B="subnet-06c16ab9432c13d83"
SUBNET_AZ_C="subnet-02538f24c2f3cf08f"
KEY_NAME="secondlayer-prod"
SSH_KEY="$HOME/.ssh/secondlayer-prod"

# Replica instance: r6i.large (2 vCPU, 16GB) — enough for analytics
INSTANCE_TYPE="r6i.large"
# AMI: Ubuntu 22.04 LTS in eu-central-1
AMI_ID="ami-027066fb16fc18634"

# PostgreSQL config (matches prod)
PG_USER="secondlayer"
PG_PASS="${PGPASSWORD:?set PGPASSWORD}"
PG_DB="secondlayer_prod"

# Tags for tracking ephemeral resources
TAG_KEY="ephemeral-analytics"
TAG_VALUE="true"

DRY_RUN=false
CLEANUP_ONLY=false

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --cleanup) CLEANUP_ONLY=true ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────
log() { echo "[$(date '+%H:%M:%S')] $*"; }
err() { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }

cleanup_resources() {
  log "Cleaning up ephemeral resources..."

  # Find and terminate tagged instances
  local instances
  instances=$(aws ec2 describe-instances \
    --filters "Name=tag:${TAG_KEY},Values=${TAG_VALUE}" "Name=instance-state-name,Values=running,pending,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text --region "$REGION" 2>/dev/null || true)

  for iid in $instances; do
    log "  Terminating instance $iid"
    aws ec2 terminate-instances --instance-ids "$iid" --region "$REGION" > /dev/null
  done

  # Wait for termination
  if [ -n "$instances" ]; then
    log "  Waiting for instances to terminate..."
    aws ec2 wait instance-terminated --instance-ids $instances --region "$REGION" 2>/dev/null || true
  fi

  # Find and delete tagged volumes (available only — attached ones deleted with instance)
  local volumes
  volumes=$(aws ec2 describe-volumes \
    --filters "Name=tag:${TAG_KEY},Values=${TAG_VALUE}" "Name=status,Values=available" \
    --query 'Volumes[].VolumeId' --output text --region "$REGION" 2>/dev/null || true)

  for vid in $volumes; do
    log "  Deleting volume $vid"
    aws ec2 delete-volume --volume-id "$vid" --region "$REGION" 2>/dev/null || true
  done

  # Find and delete tagged snapshots older than 1 day
  local snapshots
  snapshots=$(aws ec2 describe-snapshots \
    --owner-ids self \
    --filters "Name=tag:${TAG_KEY},Values=${TAG_VALUE}" \
    --query 'Snapshots[].SnapshotId' --output text --region "$REGION" 2>/dev/null || true)

  for sid in $snapshots; do
    log "  Deleting snapshot $sid"
    aws ec2 delete-snapshot --snapshot-id "$sid" --region "$REGION" 2>/dev/null || true
  done

  log "Cleanup complete"
}

if $CLEANUP_ONLY; then
  cleanup_resources
  exit 0
fi

# ── Trap: cleanup on failure ────────────────────────────────────────────────
SNAPSHOT_ID=""
VOLUME_ID=""
INSTANCE_ID=""

trap_cleanup() {
  err "Script failed — cleaning up..."
  [ -n "$INSTANCE_ID" ] && aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION" > /dev/null 2>&1 || true
  [ -n "$VOLUME_ID" ] && sleep 30 && aws ec2 delete-volume --volume-id "$VOLUME_ID" --region "$REGION" 2>/dev/null || true
  [ -n "$SNAPSHOT_ID" ] && aws ec2 delete-snapshot --snapshot-id "$SNAPSHOT_ID" --region "$REGION" 2>/dev/null || true
}
trap trap_cleanup ERR

# ── Step 1: Create EBS Snapshot ─────────────────────────────────────────────
log "Step 1: Creating EBS snapshot of $PROD_VOLUME_ID..."

if $DRY_RUN; then
  log "  DRY RUN: would create snapshot of $PROD_VOLUME_ID"
  log "  DRY RUN: would launch $INSTANCE_TYPE spot instance"
  log "  DRY RUN: would run compute-judge-analytics"
  log "  DRY RUN: would copy judge_analytics back to prod"
  log "  DRY RUN: would terminate instance and delete snapshot"
  exit 0
fi

SNAPSHOT_ID=$(aws ec2 create-snapshot \
  --volume-id "$PROD_VOLUME_ID" \
  --description "ephemeral-analytics-$(date +%Y%m%d-%H%M)" \
  --tag-specifications "ResourceType=snapshot,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=Name,Value=ephemeral-analytics}]" \
  --query 'SnapshotId' --output text --region "$REGION")

log "  Snapshot: $SNAPSHOT_ID — waiting for completion..."
aws ec2 wait snapshot-completed --snapshot-ids "$SNAPSHOT_ID" --region "$REGION"
log "  Snapshot ready"

# ── Step 2: Launch Spot Instance ─────────────────────────────────────────────
log "Step 2: Launching $INSTANCE_TYPE spot instance..."

# Read SSH public key to inject into user-data
[ ! -f "${SSH_KEY}.pub" ] && ssh-keygen -y -f "$SSH_KEY" > "${SSH_KEY}.pub" 2>/dev/null
SSH_PUB_KEY=$(cat "${SSH_KEY}.pub")

# Build user-data script with embedded SSH key
USER_DATA=$(cat <<EOF
#!/bin/bash
set -ex
exec > /var/log/user-data.log 2>&1

# Inject permanent SSH key for prod → replica access
mkdir -p /home/ubuntu/.ssh
echo "${SSH_PUB_KEY}" >> /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys
chown -R ubuntu:ubuntu /home/ubuntu/.ssh

# Fix docker directory permissions for postgres user
chmod o+x /mnt/data/var/lib/docker /mnt/data/var/lib/docker/volumes /mnt/data/var/lib/docker/volumes/deployment_postgres_prod_data 2>/dev/null || true
EOF
# Append literal portion (no variable expansion)
cat <<'USERDATA'

# Wait for the EBS volume to appear
for i in $(seq 1 60); do
  [ -b /dev/nvme1n1 ] && break
  [ -b /dev/xvdf ] && break
  sleep 2
done

DEV=""
[ -b /dev/nvme1n1p1 ] && DEV=/dev/nvme1n1p1
[ -b /dev/nvme1n1 ] && [ -z "$DEV" ] && DEV=/dev/nvme1n1
[ -b /dev/xvdf1 ] && [ -z "$DEV" ] && DEV=/dev/xvdf1
[ -b /dev/xvdf ] && [ -z "$DEV" ] && DEV=/dev/xvdf

if [ -z "$DEV" ]; then echo "FATAL: No EBS volume device found"; exit 1; fi

mkdir -p /mnt/data
mount "$DEV" /mnt/data
echo "Mounted $DEV to /mnt/data"

PG_DATA="/mnt/data/var/lib/docker/volumes/deployment_postgres_prod_data/_data"
if [ ! -d "$PG_DATA" ]; then
  PG_DATA=$(find /mnt/data/var/lib/docker/volumes -name "PG_VERSION" -exec dirname {} \; 2>/dev/null | head -1)
fi
if [ ! -f "$PG_DATA/PG_VERSION" ]; then echo "FATAL: Cannot find PG data"; exit 1; fi
echo "PG data at: $PG_DATA"

# Install PostgreSQL 15
sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc | tee /etc/apt/trusted.gpg.d/pgdg.asc > /dev/null
apt-get update -qq && apt-get install -y -qq postgresql-15 > /dev/null 2>&1
systemctl stop postgresql

# Fix permissions: docker dirs need o+x for postgres to traverse
chmod o+x /mnt/data/var/lib/docker /mnt/data/var/lib/docker/volumes /mnt/data/var/lib/docker/volumes/deployment_postgres_prod_data 2>/dev/null || true
chown -R postgres:postgres "$PG_DATA"

cat > "$PG_DATA/pg_hba.conf" <<'HBA'
local all all trust
host all all 127.0.0.1/32 md5
host all all ::1/128 md5
HBA

cat > "$PG_DATA/postgresql.auto.conf" <<'CONF'
port = 5432
listen_addresses = 'localhost'
shared_buffers = 4GB
effective_cache_size = 12GB
work_mem = 1GB
maintenance_work_mem = 2GB
max_parallel_workers_per_gather = 2
statement_timeout = 0
lock_timeout = 0
CONF

rm -f "$PG_DATA/postmaster.pid" "$PG_DATA/recovery.signal" "$PG_DATA/standby.signal"
mkdir -p /var/log/postgresql && chown postgres:postgres /var/log/postgresql
sudo -u postgres /usr/lib/postgresql/15/bin/pg_ctl -D "$PG_DATA" -l /var/log/postgresql/analytics.log start

for i in $(seq 1 60); do
  sudo -u postgres psql -p 5432 -c "SELECT 1" > /dev/null 2>&1 && break
  sleep 2
done

touch /tmp/pg-analytics-ready
echo "PostgreSQL analytics replica ready"
USERDATA
)

# Try each AZ until spot capacity is found
INSTANCE_ID=""
for SUBNET in "$SUBNET_AZ_A" "$SUBNET_AZ_B" "$SUBNET_AZ_C"; do
  INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$PROD_SG" \
    --subnet-id "$SUBNET" \
    --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}' \
    --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":30,\"VolumeType\":\"gp3\"}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=Name,Value=ephemeral-analytics-replica}]" \
    --user-data "$USER_DATA" \
    --query 'Instances[0].InstanceId' --output text --region "$REGION" 2>/dev/null) && break
  log "  No spot capacity in subnet $SUBNET, trying next..."
done

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  err "No spot capacity in any AZ"
  exit 1
fi

log "  Instance: $INSTANCE_ID — waiting for running state..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

REPLICA_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text --region "$REGION")
INSTANCE_AZ=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text --region "$REGION")
log "  Instance running at $REPLICA_IP (AZ: $INSTANCE_AZ)"

# ── Step 3: Attach snapshot volume ──────────────────────────────────────────
log "Step 3: Creating volume from snapshot and attaching..."

VOLUME_ID=$(aws ec2 create-volume \
  --snapshot-id "$SNAPSHOT_ID" \
  --availability-zone "$INSTANCE_AZ" \
  --volume-type gp3 \
  --iops 6000 \
  --throughput 500 \
  --tag-specifications "ResourceType=volume,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=Name,Value=ephemeral-analytics-vol}]" \
  --query 'VolumeId' --output text --region "$REGION")

log "  Volume: $VOLUME_ID — waiting for available state..."
aws ec2 wait volume-available --volume-ids "$VOLUME_ID" --region "$REGION"

aws ec2 attach-volume \
  --volume-id "$VOLUME_ID" \
  --instance-id "$INSTANCE_ID" \
  --device "/dev/xvdf" \
  --region "$REGION" > /dev/null

log "  Volume attached"

# ── Step 4: Wait for PostgreSQL to be ready ─────────────────────────────────
log "Step 4: Waiting for PostgreSQL to start on replica..."

# Helper: SSH to replica (key injected via user-data, persistent)
replica_ssh() {
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=30 \
    -i "$SSH_KEY" "ubuntu@$REPLICA_IP" "$@"
}

# Wait for SSH
for i in $(seq 1 30); do
  replica_ssh "true" 2>/dev/null && break
  sleep 10
done

# Wait for pg-analytics-ready signal (up to 20 minutes for PG install + chown)
for i in $(seq 1 120); do
  if replica_ssh "test -f /tmp/pg-analytics-ready" 2>/dev/null; then
    log "  PostgreSQL ready on replica"
    break
  fi
  if [ "$i" -eq 120 ]; then
    err "PostgreSQL did not start within 20 minutes"
    replica_ssh "cat /var/log/user-data.log 2>/dev/null || cat /var/log/cloud-init-output.log" 2>/dev/null | tail -30
    exit 1
  fi
  sleep 10
done

# ── Step 5: Run compute-judge-analytics on replica ──────────────────────────
log "Step 5: Setting up and running compute-judge-analytics..."

ANALYTICS_START=$(date +%s)

# 5a: Install Node.js and minimal deps (repo + dist already on snapshot volume)
log "  Installing Node.js..."
replica_ssh "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1 && sudo apt-get install -y -qq nodejs > /dev/null 2>&1 && node --version"
log "  Node.js ready"

# Install pg + dotenv in temp dir (monorepo workspace hoisting prevents normal npm ci)
log "  Installing minimal deps (pg, dotenv)..."
replica_ssh "mkdir -p /tmp/deps && cd /tmp/deps && npm init -y > /dev/null 2>&1 && npm install pg dotenv > /dev/null 2>&1 && echo DEPS_OK"
log "  Deps ready"

# 5b: Launch analytics in background via nohup (returns immediately)
REPO_PATH="/mnt/data/home/ubuntu/SecondLayer/mcp_backend"
DB_URL="postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:5432/${PG_DB}"
log "  Launching analytics in background..."
replica_ssh "cd ${REPO_PATH} && \
  NODE_PATH=/tmp/deps/node_modules \
  DATABASE_URL='${DB_URL}' \
  EDRSR_SHARD_1_URL='${DB_URL}' \
  EDRSR_SHARD_2_URL='${DB_URL}' \
  EDRSR_SHARD_3_URL='${DB_URL}' \
  EDRSR_SHARD_4_URL='${DB_URL}' \
  nohup node dist/scripts/compute-judge-analytics.js > /tmp/analytics.log 2>&1 &
  echo 'analytics PID:' \$!"

# 5c: Poll for completion (check if process still running + result file)
log "  Waiting for analytics to complete..."
while true; do
  # Check if analytics process is still running
  RUNNING=$(replica_ssh "pgrep -f compute-judge-analytics 2>/dev/null | head -1" 2>/dev/null || true)
  if [ -z "$RUNNING" ]; then
    # Process finished — check exit status
    LAST_LINE=$(replica_ssh "tail -3 /tmp/analytics.log 2>/dev/null" 2>/dev/null || true)
    log "  Analytics finished: $LAST_LINE"
    break
  fi
  # Show progress
  PROGRESS=$(replica_ssh "tail -1 /tmp/analytics.log 2>/dev/null" 2>/dev/null || true)
  log "  ... $PROGRESS"
  sleep 30
done

ANALYTICS_END=$(date +%s)
ANALYTICS_DURATION=$(( ANALYTICS_END - ANALYTICS_START ))
log "  Analytics completed in ${ANALYTICS_DURATION}s"

# ── Step 6: Copy results back to prod ───────────────────────────────────────
log "Step 6: Copying judge_analytics results to prod..."

# Dump judge_analytics from replica to prod via pipe
# Push key for this SSH session (Instance Connect keys expire in 60s)
replica_ssh \
  "sudo -u postgres pg_dump -p 5432 --data-only --table=judge_analytics ${PG_DB} | gzip" \
  > /tmp/judge_analytics_dump.sql.gz

# Restore to prod
docker exec -i secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod \
  -c "TRUNCATE judge_analytics;"
gunzip -c /tmp/judge_analytics_dump.sql.gz | \
  docker exec -i secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod
rm -f /tmp/judge_analytics_dump.sql.gz
log "  Results copied to prod"

# ── Step 7: Tear down ──────────────────────────────────────────────────────
log "Step 7: Tearing down ephemeral resources..."

aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION" > /dev/null
log "  Instance $INSTANCE_ID terminating"

# Wait for termination before deleting volume
aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" --region "$REGION"

aws ec2 delete-volume --volume-id "$VOLUME_ID" --region "$REGION" 2>/dev/null || true
log "  Volume $VOLUME_ID deleted"

aws ec2 delete-snapshot --snapshot-id "$SNAPSHOT_ID" --region "$REGION" 2>/dev/null || true
log "  Snapshot $SNAPSHOT_ID deleted"

INSTANCE_ID=""
VOLUME_ID=""
SNAPSHOT_ID=""

# ── Done ─────────────────────────────────────────────────────────────────────
TOTAL_END=$(date +%s)
log "=== Ephemeral analytics complete ==="
log "  Analytics runtime: ${ANALYTICS_DURATION}s"
log "  Total wall time: $(( TOTAL_END - $(date -d "$(aws ec2 describe-snapshots --snapshot-ids "$SNAPSHOT_ID" --query 'Snapshots[0].StartTime' --output text --region "$REGION" 2>/dev/null || echo "now")" +%s 2>/dev/null || echo $ANALYTICS_START) ))s"
log "  Estimated cost: ~\$$(echo "scale=2; $ANALYTICS_DURATION / 3600 * 0.1" | bc) (spot r6i.large)"
