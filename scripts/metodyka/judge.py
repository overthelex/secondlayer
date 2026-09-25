"""The judge: one label per (proposition, passage), on the reader's protocol.

The judge sees exactly what the reader sees and no more. The two flags the page
withholds -- whether the decision cites this пункт, and whether the passage is
recitation by the formal measure -- stay out of the prompt, because they are
what the agreement measurement is for.

Resumable: every answer is appended to the output file as it arrives, and a
rerun skips what is already there. The API is called from local.lex, whose
address is on the key's allowlist.

Usage:
    python3 judge.py --packet /data/amcu/packet.json --out /data/amcu/judge-gpt5.jsonl
    python3 judge.py --limit 3 --out /tmp/smoke.jsonl      # shape check first
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.request

KEY_FILE = pathlib.Path(os.environ.get("OPENAI_KEY_FILE", "/home/vovkes/.openai_key"))
PROTOCOL = pathlib.Path("/data/amcu/protocol.md")
URL = "https://api.openai.com/v1/chat/completions"
# Claude on Bedrock is reached through a regional inference profile, not the
# bare model id: `anthropic.claude-sonnet-4-6` is listed but not invocable.
BEDROCK_REGION = os.environ.get("AWS_REGION", "eu-central-1")

TASK = """Ти розмічаєш, як українська практика застосовує Методику визначення
монопольного (домінуючого) становища (розпорядження АМКУ N 49-р від 05.03.2002).

Нижче протокол розмітки, потім пункт Методики, потім уривок з рішення органу або
суду. Постав рівно одну позначку за протоколом.

Відповідай РІВНО одним рядком JSON і нічим більше: {"label": "<застосовує|суперечить|лише переказує|не про це>",
"why": "<одне коротке речення українською>"}"""


def prompt(protocol: str, number: str, text: str, body: str) -> list[dict]:
    return [
        {"role": "system", "content": TASK + "\n\n--- ПРОТОКОЛ ---\n" + protocol},
        {"role": "user", "content":
            f"ПУНКТ {number} МЕТОДИКИ:\n{text}\n\n--- УРИВОК З РІШЕННЯ ---\n{body}"},
    ]


def ask(key: str, model: str, messages: list[dict], tries: int = 4) -> dict:
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_completion_tokens": 400,
        "response_format": {"type": "json_object"},
    }).encode()
    last = ""
    for attempt in range(tries):
        req = urllib.request.Request(URL, data=body, headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            last = e.read().decode("utf-8", "replace")[:300]
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(3 * (attempt + 1))
                continue
            raise SystemExit(f"HTTP {e.code}: {last}")
        except Exception as e:  # noqa: BLE001 - the network, mostly
            last = repr(e)
            time.sleep(3 * (attempt + 1))
    raise SystemExit(f"вичерпано спроби: {last}")


def ask_bedrock(model: str, messages: list[dict], tries: int = 4) -> dict:
    """The same judgement through Bedrock, with the system turn where it belongs.

    The protocol is the same on every call, so it goes in a cache point: it is
    two thirds of the input and is repeated 528 times.
    """
    import boto3
    from botocore.config import Config

    global _BEDROCK
    if _BEDROCK is None:
        _BEDROCK = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION,
                                config=Config(retries={"max_attempts": 4,
                                                       "mode": "adaptive"},
                                              read_timeout=180))
    body = [{"role": "user", "content": [{"text": messages[1]["content"]}]}]
    # Not every family on Bedrock takes the same fields: Kimi rejects both the
    # cache point and temperature, and the rejection is a ValidationException
    # naming the field. Drop what a model refuses and keep going.
    caps = _CAPS.setdefault(model, {
        "cache": True, "temperature": True,
        "reasoning": any(k in model for k in ("deepseek", "r1", "o1", "thinking",
                                              "gpt-6", "gpt-5.6", "astra")),
    })
    last = ""
    for attempt in range(tries):
        system = [{"text": messages[0]["content"]}]
        if caps["cache"]:
            system.append({"cachePoint": {"type": "default"}})
        # A reasoning model spends its budget thinking before it answers, and
        # at 400 the JSON came back cut in half 72 times.
        config = {"maxTokens": 2000 if caps["reasoning"] else 400}
        if caps["temperature"]:
            config["temperature"] = 0
        try:
            r = _BEDROCK.converse(modelId=model, system=system, messages=body,
                                  inferenceConfig=config)
            usage = r.get("usage", {})
            # A reasoning model puts its thinking in its own block and the
            # answer in a later one, so take the first block that has text
            # rather than the first block.
            blocks = r["output"]["message"]["content"]
            text = next((b["text"] for b in blocks if "text" in b), "")
            return {
                "choices": [{"message": {"content": text}}],
                "usage": {"prompt_tokens": usage.get("inputTokens", 0),
                          "completion_tokens": usage.get("outputTokens", 0),
                          "cache_read": usage.get("cacheReadInputTokens", 0),
                          "cache_write": usage.get("cacheWriteInputTokens", 0)},
            }
        except Exception as e:  # noqa: BLE001 - throttling and field support
            last = repr(e)[:200]
            # The refusal names the field, but not in one wording: Kimi says
            # "doesn't support the cachePoint field", DeepSeek says "your
            # request did not allow prompt caching" and raises AccessDenied.
            if caps["cache"] and ("cachePoint" in last or "caching" in last):
                caps["cache"] = False
                continue
            if caps["temperature"] and "temperature" in last:
                caps["temperature"] = False
                continue
            time.sleep(3 * (attempt + 1))
    raise SystemExit(f"bedrock: вичерпано спроби: {last}")


_BEDROCK = None
_CAPS: dict = {}

LABELS = {"застосовує", "суперечить", "лише переказує", "не про це"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--packet", default="/data/amcu/packet.json")
    ap.add_argument("--out", default="/data/amcu/judge-gpt5.jsonl")
    ap.add_argument("--model", default="gpt-5")
    ap.add_argument("--provider", choices=["openai", "bedrock"], default="openai")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--threads", type=int, default=8)
    args = ap.parse_args()

    key = KEY_FILE.read_text().strip() if args.provider == "openai" else ""
    protocol = PROTOCOL.read_text(encoding="utf-8")
    packet = json.load(open(args.packet, encoding="utf-8"))

    done = set()
    out_path = pathlib.Path(args.out)
    if out_path.exists():
        for line in out_path.open(encoding="utf-8"):
            try:
                r = json.loads(line)
                done.add((r["number"], r["doc_id"], r["ord"]))
            except Exception:  # noqa: BLE001 - a half-written last line
                pass

    jobs: list[tuple] = []
    for p in packet:
        for s in p["passages"]:
            key_ = (p["number"], s["doc_id"], s["ord"])
            if key_ not in done:
                jobs.append((p, s))
    if args.limit:
        jobs = jobs[:args.limit]
    print(f"{len(jobs)} суджень до виконання, {len(done)} вже є", file=sys.stderr)

    work: queue.Queue = queue.Queue()
    for j in jobs:
        work.put(j)
    lock = threading.Lock()
    fh = out_path.open("a", encoding="utf-8")
    stats = {"n": 0, "in": 0, "out": 0, "bad": 0}

    def run():
        # A thread that dies takes its reason with it, and the run then reports
        # zero judgements and no error at all. Say what happened.
        try:
            worker()
        except BaseException as exc:  # noqa: BLE001
            print(f"!!! потік упав: {exc}", file=sys.stderr, flush=True)

    def worker():
        while True:
            try:
                p, s = work.get_nowait()
            except queue.Empty:
                return
            messages = prompt(protocol, p["number"], p["text"], s["body"])
            answer = (ask_bedrock(args.model, messages) if args.provider == "bedrock"
                      else ask(key, args.model, messages))
            content = answer["choices"][0]["message"]["content"]
            try:
                parsed = json.loads(content)
                label = parsed.get("label", "")
            except Exception:  # noqa: BLE001
                # Some models wrap the object in prose or a fence; take the
                # last balanced object rather than giving up on the answer.
                found = re.findall(r"\{[^{}]*\}", content, re.S)
                parsed, label = {"raw": content}, ""
                for chunk in reversed(found):
                    try:
                        maybe = json.loads(chunk)
                    except Exception:  # noqa: BLE001
                        continue
                    if maybe.get("label"):
                        parsed, label = maybe, maybe["label"]
                        break
            row = {
                "number": p["number"], "doc_id": s["doc_id"], "ord": s["ord"],
                "label": label if label in LABELS else None,
                "why": parsed.get("why", ""), "model": args.model,
                "raw": None if label in LABELS else content[:200],
            }
            usage = answer.get("usage", {})
            with lock:
                # Bedrock reports the cached system block outside inputTokens,
                # so the bill is input + cache write + cache read, not input.
                stats["cache_read"] = stats.get("cache_read", 0) + usage.get("cache_read", 0)
                stats["cache_write"] = stats.get("cache_write", 0) + usage.get("cache_write", 0)
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                fh.flush()
                stats["n"] += 1
                stats["in"] += usage.get("prompt_tokens", 0)
                stats["out"] += usage.get("completion_tokens", 0)
                if row["label"] is None:
                    stats["bad"] += 1
                if stats["n"] % 25 == 0:
                    print(f"  {stats['n']}/{len(jobs)}  "
                          f"вхід {stats['in']:,} вихід {stats['out']:,} "
                          f"невпізнаних {stats['bad']}", file=sys.stderr, flush=True)

    threads = [threading.Thread(target=run, daemon=True) for _ in range(args.threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    fh.close()
    print(f"готово: {stats['n']} суджень, вхід {stats['in']:,}, вихід {stats['out']:,}, "
          f"кеш: запис {stats.get('cache_write', 0):,} читання {stats.get('cache_read', 0):,}, "
          f"невпізнаних відповідей {stats['bad']} -> {args.out}")


if __name__ == "__main__":
    main()
