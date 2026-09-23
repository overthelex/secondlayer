#!/usr/bin/env bash
# Startup script for the embedding VM: it embeds the audit's passages with
# bge-m3 on the L4 and deletes itself when done.
#
# Nothing here depends on a laptop, or on the machine that created the VM.
# Input and output both go through the bucket; the DONE marker is what the
# watcher on cthulhu waits for, and the FAILED marker is what stops it
# waiting forever.
set -euo pipefail

BUCKET="${BUCKET:-gs://secondlayer-ch-vectors/weko-audit}"
MODEL="BAAI/bge-m3"
LOG=/var/log/weko-embed.log
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date -Is) start on $(hostname)"

fail() { echo "FAILED: $*"; echo "$*" | gsutil cp - "$BUCKET/FAILED"; gsutil cp "$LOG" "$BUCKET/embed.log" || true; shutdown -h now; }
trap 'fail "startup script died at line $LINENO"' ERR

nvidia-smi || fail "no GPU visible"
gsutil cp "$BUCKET/passages.jsonl.gz" /tmp/passages.jsonl.gz || fail "no input in the bucket"

# No TEI container here: the image carries the driver and PyTorch but no
# docker. The pooling is written out by hand instead -- the CLS token of the
# last hidden state, normalised -- which is exactly what TEI's `--pooling cls`
# does and what the CH corpus was embedded with, so the vectors stay
# comparable with ch_corpus_bge_cls.
# The image ships a torchaudio built against another torch, and transformers
# imports it on the way to any model ("Could not load this library:
# _torchaudio.abi3.so"). Nothing here needs audio.
# `pip` on this image is not the interpreter that runs the job, so uninstall
# through python3 and then take the directory out by hand -- the first
# attempt left the package in place and the import failed again.
python3 -m pip uninstall --quiet -y torchaudio 2>&1 | tail -1 || true
rm -rf /usr/local/lib/python3.*/dist-packages/torchaudio* || true
python3 -m pip install --quiet --no-input "transformers>=4.40" 2>&1 | tail -2 || fail "pip install failed"
# Fail in seconds rather than after the model download if the stack is broken.
python3 -c "import torch, transformers; assert torch.cuda.is_available(); print('torch', torch.__version__, 'transformers', transformers.__version__, 'cuda ok', flush=True)" || fail "torch/transformers stack unusable"

python3 - <<'EMBED' || fail "embedding failed"
import gzip, json, time
import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

MODEL = "BAAI/bge-m3"
BATCH = 64
MAXLEN = 512          # a 1,200-character passage sits well under this

rows = [json.loads(l) for l in gzip.open("/tmp/passages.jsonl.gz", "rt", encoding="utf-8")]
print(f"passages: {len(rows)}", flush=True)

tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModel.from_pretrained(MODEL, torch_dtype=torch.float16).cuda().eval()

# Longest first: batches of similar length waste the least padding.
order = sorted(range(len(rows)), key=lambda i: -len(rows[i]["text"]))
vectors = np.zeros((len(rows), 1024), dtype=np.float16)
t0 = time.time()
with torch.inference_mode():
    for b in range(0, len(order), BATCH):
        idx = order[b:b + BATCH]
        batch = tok([rows[i]["text"] for i in idx], padding=True, truncation=True,
                    max_length=MAXLEN, return_tensors="pt").to("cuda")
        out = model(**batch).last_hidden_state[:, 0]          # CLS
        out = torch.nn.functional.normalize(out, dim=-1)
        vectors[idx] = out.cpu().numpy().astype(np.float16)
        if b % (BATCH * 100) == 0:
            done = b + len(idx)
            rate = done / max(time.time() - t0, 1e-9)
            print(f"  {done}/{len(rows)} {rate:.0f}/s "
                  f"eta {(len(rows) - done) / max(rate, 1e-9) / 60:.1f} min", flush=True)

np.savez_compressed("/tmp/vectors.npz", vectors=vectors,
                    ecli=np.array([r["ecli"] for r in rows]),
                    ord=np.array([r["ord"] for r in rows], dtype=np.int32))
print(f"done in {(time.time() - t0) / 60:.1f} min", flush=True)
EMBED

gsutil cp /tmp/vectors.npz "$BUCKET/vectors.npz" || fail "upload failed"
gsutil cp "$LOG" "$BUCKET/embed.log" || true
date -Is | gsutil cp - "$BUCKET/DONE"
echo "=== $(date -Is) done, deleting the instance"

# Self-delete: the run is minutes, and an instance left running is the only
# way this job can cost real money.
NAME=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/name)
ZONE=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/zone | awk -F/ '{print $NF}')
gcloud --quiet compute instances delete "$NAME" --zone "$ZONE"
