"""A judge through the Azure Batch API, for models offered only as batch (gpt-5.4).

Same prompt, same protocol and same answer handling as judge.py; only the
transport differs. The sponsored subscription allows 200K enqueued tokens
per model, so the packet goes in parts (--parts), each its own batch.

    python3 batch.py submit --model gpt-5.4-batch --parts 2      # writes batches.json
    python3 batch.py status
    python3 batch.py collect --out judges/gpt-5.4.jsonl          # when all completed
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.request
import uuid

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import judge  # noqa: E402

BASE = "https://lexai-foundry-swc.openai.azure.com/openai/v1"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")
STATE = DIR / "judges" / "batches.json"


def key() -> str:
    return pathlib.Path(os.environ.get("AZURE_FOUNDRY_KEY_FILE",
                                       pathlib.Path.home() / ".azure_foundry_key")).read_text().strip()


def api(method: str, path: str, body: bytes | None = None, ctype: str = "application/json") -> dict | bytes:
    req = urllib.request.Request(BASE + path, data=body, method=method,
                                 headers={"api-key": key(), "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def upload(lines: list[str]) -> str:
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nbatch\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"judge.jsonl\"\r\n"
            f"Content-Type: application/jsonl\r\n\r\n").encode() + "\n".join(lines).encode() \
        + f"\r\n--{boundary}--\r\n".encode()
    return api("POST", "/files", body, f"multipart/form-data; boundary={boundary}")["id"]


def submit(args) -> None:
    protocol = args.protocol.read_text(encoding="utf-8")
    items = json.loads(args.packet.read_text(encoding="utf-8"))
    size = -(-len(items) // args.parts)
    state = {"model": args.model, "packet_sha256": hashlib.sha256(args.packet.read_bytes()).hexdigest(),
             "batches": []}
    for i in range(0, len(items), size):
        lines = []
        for it in items[i:i + size]:
            system, user = judge.prompt(protocol, it, list(range(len(it["evidence"]))))
            lines.append(json.dumps({
                "custom_id": f"{it['version']}|{it['pid']}", "method": "POST", "url": "/chat/completions",
                "body": {"model": args.model, "max_completion_tokens": 6000,
                         "messages": [{"role": "system", "content": system},
                                      {"role": "user", "content": user}]}}, ensure_ascii=False))
        file_id = upload(lines)
        b = api("POST", "/batches", json.dumps({"input_file_id": file_id, "endpoint": "/chat/completions",
                                                "completion_window": "24h"}).encode())
        state["batches"].append({"id": b["id"], "file": file_id, "items": len(lines)})
        print(f"batch {b['id']}: {len(lines)} items, status {b.get('status')}")
    STATE.write_text(json.dumps(state, indent=1))


def status(_args) -> list[dict]:
    state = json.loads(STATE.read_text())
    out = []
    for b in state["batches"]:
        d = api("GET", f"/batches/{b['id']}")
        out.append(d)
        print(f"{b['id']}: {d.get('status')} {d.get('request_counts')}")
    return out


def collect(args) -> None:
    protocol = args.protocol.read_text(encoding="utf-8")
    items = {(it["version"], it["pid"]): it for it in json.loads(args.packet.read_text(encoding="utf-8"))}
    state = json.loads(STATE.read_text())
    rows = []
    for d in status(args):
        if d.get("status") != "completed" or not d.get("output_file_id"):
            raise SystemExit(f"{d['id']} is {d.get('status')}; collect when all are completed")
        for line in api("GET", f"/files/{d['output_file_id']}/content").decode().splitlines():
            r = json.loads(line)
            version, pid = r["custom_id"].split("|", 1)
            it = items[(version, pid)]
            body = (r.get("response") or {}).get("body") or {}
            text = ((body.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            system, _ = judge.prompt(protocol, it, list(range(len(it["evidence"]))))
            rows.append(judge.answer_row(it, text, body.get("usage", {}), "azure-batch", state["model"],
                                         None, list(range(len(it["evidence"]))), system,
                                         0.0, r.get("error") and str(r["error"])))
    with args.out.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"{len(rows)} answers -> {args.out}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["submit", "status", "collect"])
    ap.add_argument("--model", default="gpt-5.4-batch")
    ap.add_argument("--parts", type=int, default=2)
    ap.add_argument("--packet", type=pathlib.Path, default=DIR / "packet.json")
    ap.add_argument("--protocol", type=pathlib.Path, default=HERE / "protocol.md")
    ap.add_argument("--out", type=pathlib.Path, default=DIR / "judges" / "gpt-5.4.jsonl")
    args = ap.parse_args()
    {"submit": submit, "status": status, "collect": collect}[args.command](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
