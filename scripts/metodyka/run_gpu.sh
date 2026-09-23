#!/usr/bin/env bash
# The whole GPU pass, driven from cthulhu so that no laptop has to stay on:
# export the passages, hand them to a one-shot L4 instance, wait for the
# bucket to say DONE, load the vectors back, and re-measure the control.
#
#   tmux new -d -s metodyka-gpu /data/amcu/run_gpu.sh
#   tail -f /data/ch-corpus/logs/weko-gpu.log
#
# The instance deletes itself when it finishes (see gpu_startup.sh). This
# script deletes it too if the watch times out, so a failed run cannot leave
# a GPU billing by the hour.
set -euo pipefail

BUCKET="${BUCKET:-gs://secondlayer-ch-vectors/metodyka-audit}"
ZONE="${ZONE:-europe-west1-b}"
NAME="${NAME:-metodyka-embed-$(date +%m%d-%H%M)}"
WORK="${WORK:-/data/amcu}"
LOG=/data/amcu/logs/gpu.log
VENV=/usr/bin/python3
exec >> "$LOG" 2>&1
echo "=== $(date -Is) run_gpu start ($NAME, $ZONE)"

gsutil -q rm "$BUCKET/DONE" "$BUCKET/FAILED" "$BUCKET/vectors.npz" 2>/dev/null || true

echo "--- exporting passages"
"$VENV" "$WORK/gpu_io.py" export --out /tmp/passages.jsonl.gz
gsutil -q cp /tmp/passages.jsonl.gz "$BUCKET/passages.jsonl.gz"
echo "    $(gsutil du -sh "$BUCKET/passages.jsonl.gz")"

echo "--- creating the instance"
# L4 capacity comes and goes per zone: europe-west1-b answered
# "does not have enough resources" on the first try. Walk the zones that
# have L4 at all, on-demand first, then spot (the quota allows 2 spot in
# europe-west1 and 1 on-demand per region).
ZONES="${ZONES:-europe-west4-a europe-west4-b europe-west2-a europe-west2-b europe-west6-b europe-west1-c europe-west1-b}"
create() {
  gcloud --quiet compute instances create "$NAME" \
    --zone "$1" --machine-type g2-standard-4 \
    --accelerator type=nvidia-l4,count=1 --maintenance-policy TERMINATE \
    --image-family pytorch-2-9-cu129-ubuntu-2204-nvidia-580 --image-project deeplearning-platform-release \
    --boot-disk-size 120GB --boot-disk-type pd-balanced \
    --scopes cloud-platform \
    --metadata-from-file startup-script="$WORK/gpu_startup.sh" \
    --metadata="^#^BUCKET=$BUCKET" ${2:-}
}
ZONE=""
for mode in "" "--provisioning-model=SPOT --instance-termination-action=DELETE"; do
  for z in $ZONES; do
    echo "    trying $z ${mode:-on-demand}"
    if create "$z" "$mode"; then ZONE="$z"; break; fi
  done
  [ -n "$ZONE" ] && break
done
[ -n "$ZONE" ] || { echo "!!! no zone had an L4 free"; exit 1; }
echo "    created in $ZONE ${mode:-on-demand}"

echo "--- waiting for the bucket to say DONE (checked every minute, giving up after 2h)"
for i in $(seq 1 120); do
  sleep 60
  if gsutil -q stat "$BUCKET/DONE" 2>/dev/null; then echo "    DONE after ${i} min"; break; fi
  if gsutil -q stat "$BUCKET/FAILED" 2>/dev/null; then
    echo "!!! the instance reported FAILED:"; gsutil cat "$BUCKET/FAILED"
    gcloud --quiet compute instances delete "$NAME" --zone "$ZONE" 2>/dev/null || true
    exit 1
  fi
  # `[ "$i" = 120 ] && { ... }` as the last command of the loop returns 1 on
  # every other iteration, and `set -e` then killed the watcher after the
  # first minute while the instance carried on -- which is how one run ended
  # up embedding the corpus twice.
  if [ "$i" = 120 ]; then
    echo "!!! timed out; deleting the instance"
    gcloud --quiet compute instances delete "$NAME" --zone "$ZONE" 2>/dev/null || true
    exit 1
  fi
done

echo "--- downloading the vectors"
gsutil -q cp "$BUCKET/vectors.npz" /tmp/vectors.npz
gsutil -q cp "$BUCKET/embed.log" /data/amcu/logs/gpu-instance.log 2>/dev/null || true
"$VENV" "$WORK/gpu_io.py" load --npz /tmp/vectors.npz

echo "--- the instance should have deleted itself:"
gcloud compute instances list --filter="name=$NAME" --format="value(name,status)" || true

echo "--- re-measuring the control against dense retrieval"
"$VENV" "$WORK/retrieve.py" control --k 100 --dense || true
echo "=== $(date -Is) run_gpu finished"
