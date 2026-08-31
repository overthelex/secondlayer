#!/usr/bin/env python3
"""Stage 2: embed the АМКУ chunks with one SageMaker job.

Reuses `scripts/legislation/sagemaker/embed_entry.py` verbatim — it is already generic: it walks
the data channel for *.jsonl.gz, reads the "text" field, CLS-pools bge-m3 in fp16 and writes one
.f16.npy per shard to whatever --out-prefix it is given.

**Pooling must stay CLS.** Prod's `tei-bge-m3` serves CLS for every user query. The 2026-07
legislation pilot used MEAN and its documents ended up in a different space from the queries
searching them — self-similarity 0.70-0.77 instead of 1.0. That is why the target collection is
named `amcu_bge_cls`.

One instance is enough: the 174 382 chunks this corpus produced ran in about seven minutes on a
single A10G, so the fleet-splitting machinery the НПА run needed is pointless here.

**S3 prefix.** Everything lives under `rada-npa/amcu-decisions/` rather than a top-level `amcu/`
because the prod EC2 role's inline policy grants object actions only under `rada-npa/*`.
Verified both ways on 2026-08-12: a PutObject to `amcu/_probe.txt` returned AccessDenied while
the same write under `rada-npa/` succeeded. Moving to a cleaner prefix means adding an
`amcu-embed-s3` inline policy first, following the existing `rada-npa-s3` / `nl-embed-s3` shape.

  python3 02_launch_amcu_embed.py --dry-run
  python3 02_launch_amcu_embed.py
"""
import argparse
import tarfile
import time

import boto3

REGION = "eu-central-1"
BUCKET = "secondlayer-ml-data-euc1"
CHUNKS_PREFIX = "rada-npa/amcu-decisions/chunks"
VECTORS_PREFIX = "rada-npa/amcu-decisions/vectors"
CODE_PREFIX = "rada-npa/amcu-decisions/code"
ROLE = "arn:aws:iam::272594900302:role/SageMakerDPOExecutionRole"
IMAGE = (f"763104351884.dkr.ecr.{REGION}.amazonaws.com/"
         "pytorch-training:2.1.0-gpu-py310-cu121-ubuntu20.04-sagemaker")
# A10G measured at 307 chunks/s against L4's ~230 on this exact workload, and it is also the
# cheapest per GPU-hour of the types with a non-zero quota.
INSTANCE = "ml.g5.2xlarge"
USD_H = 1.890
ENTRY = "../legislation/sagemaker/embed_entry.py"
# Must ship alongside the entry script: SageMaker pip-installs requirements.txt from the source
# directory before running it. Leaving it out fails the job at import with
# "ModuleNotFoundError: No module named 'transformers'" — the DLC image has torch but not
# transformers. The file's upper bound (<4.41) is load-bearing against this image's torch 2.1.0.
REQS = "../legislation/sagemaker/requirements.txt"


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def pack_code(s3, key):
    """SageMaker wants the entry script inside a tar.gz, together with the requirements.txt it
    pip-installs before running it. embed_entry.py has no local imports, so those two files are
    the whole payload."""
    tmp = "/tmp/amcu_source.tar.gz"
    with tarfile.open(tmp, "w:gz") as t:
        t.add(ENTRY, arcname="embed_entry.py")
        t.add(REQS, arcname="requirements.txt")
    s3.upload_file(tmp, BUCKET, key)
    return f"s3://{BUCKET}/{key}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--batch-size", type=int, default=32)
    a = ap.parse_args()

    s3 = boto3.client("s3", region_name=REGION)
    shards = [o["Key"] for o in
              s3.list_objects_v2(Bucket=BUCKET, Prefix=CHUNKS_PREFIX + "/").get("Contents", [])
              if o["Key"].endswith(".jsonl.gz")]
    if not shards:
        raise SystemExit(f"no shards under s3://{BUCKET}/{CHUNKS_PREFIX}/ — run 01_chunk_amcu.py first")
    log(f"{len(shards)} shards, instance {INSTANCE} at ${USD_H}/h")

    job = f"amcu-bge-cls-{time.strftime('%Y%m%d-%H%M%S')}"
    if a.dry_run:
        log(f"dry run — would launch {job} over {len(shards)} shards")
        for s in shards:
            log(f"  {s}")
        return

    code_uri = pack_code(s3, f"{CODE_PREFIX}/source.tar.gz")
    sm = boto3.client("sagemaker", region_name=REGION)
    sm.create_training_job(
        TrainingJobName=job,
        AlgorithmSpecification={"TrainingImage": IMAGE, "TrainingInputMode": "File"},
        RoleArn=ROLE,
        InputDataConfig=[{
            "ChannelName": "data",
            "DataSource": {"S3DataSource": {
                "S3DataType": "S3Prefix",
                "S3Uri": f"s3://{BUCKET}/{CHUNKS_PREFIX}/",
                "S3DataDistributionType": "FullyReplicated",
            }},
        }],
        OutputDataConfig={"S3OutputPath": f"s3://{BUCKET}/{CODE_PREFIX}/output"},
        ResourceConfig={"InstanceType": INSTANCE, "InstanceCount": 1, "VolumeSizeInGB": 100},
        StoppingCondition={"MaxRuntimeInSeconds": 7200},
        HyperParameters={
            "sagemaker_program": '"embed_entry.py"',
            "sagemaker_submit_directory": f'"{code_uri}"',
            "out-bucket": f'"{BUCKET}"',
            "out-prefix": f'"{VECTORS_PREFIX}"',
            "batch-size": str(a.batch_size),
        },
    )
    log(f"launched {job}")
    log(f"  aws sagemaker describe-training-job --training-job-name {job} "
        f"--region {REGION} --query TrainingJobStatus")


if __name__ == "__main__":
    main()
