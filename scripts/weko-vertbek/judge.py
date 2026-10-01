"""The judges: every proposition of the packet with its eight passages.

Each judge sees what the reader sees and no more: the proposition, its
version, the eight passages with court, docket, date and regime. Whether a
decision cites the notice, the formal recitation share and the item kind
(control or sample) stay out of the prompt.

One call per proposition; the judge labels every passage (protocol.md) and
quotes the words that show an application. The proposition's label is
derived in code from the passage labels, never taken from the model. A quote
that is not in the passage is recorded as such: it is the judge inventing.

Providers:
    azure   any deployment on the Foundry resource (OpenAI-compatible);
            key from AZURE_FOUNDRY_KEY_FILE (default ~/.azure_foundry_key)
    claude  Claude Code headless (`claude -p`): the subscription token in
            CLAUDE_CODE_OAUTH_TOKEN, or the machine's own `claude` login

Resumable: answers are appended as they arrive and a rerun skips what is in
the output file. --shuffle N presents the passages in a seeded random order
(the order-sensitivity control).

    python3 judge.py --provider azure --model DeepSeek-V4-Pro --out judge-deepseek.jsonl
    python3 judge.py --provider claude --model opus --out judge-claude.jsonl
    python3 judge.py ... --limit 2 --out /tmp/smoke.jsonl     # shape check first
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import pathlib
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
DIR = pathlib.Path("/data/ch-corpus/weko-bek")
AZURE = "https://lexai-foundry-swc.openai.azure.com/openai/v1/chat/completions"
LABELS = ("applies", "partial", "contradicts", "recites", "unrelated")

TASK = """You label how the Swiss record uses one proposition of the Swiss
Competition Commission's notice on vertical agreements. The protocol below is
binding. Then come the proposition and eight numbered passages from eight
different decisions.

Label every passage. Answer with ONE JSON object and nothing else:
{"passages": [{"n": <1-8>, "label": "applies|partial|contradicts|recites|unrelated",
  "quote": "<verbatim words from the passage that show it, or empty>",
  "why": "<one short sentence>"} ...]}
Quotes must be copied exactly from the passage (German, French or Italian as
printed); give a quote for every passage labelled applies, partial or
contradicts."""


def proposition_label(labels: list[str]) -> str:
    if "applies" in labels:
        return "supported"
    if "partial" in labels:
        return "fragment"
    if "recites" in labels:
        return "recites"
    return "absent"


def prompt(protocol: str, item: dict, order: list[int]) -> tuple[str, str]:
    where = ("" if item["version"] == "control"
             else f"Version {item['version'][:10]}"
             + (" (Erläuterungen)" if item["version"].endswith("erl") else " (Bekanntmachung)"))
    head = f"PROPOSITION {item['pid']} {where}\n" + (f"{item['heading']}\n" if item["heading"] else "")
    parts = [head + item["text"], ""]
    for n, i in enumerate(order, 1):
        e = item["evidence"][i]
        when = e["date"] or (f"no later than {e['date_upper_bound']}" if e["date_upper_bound"] else "undated")
        parts.append(f"--- PASSAGE {n} --- {e['spider']} · {e['docket'] or e['ecli']} · {when}"
                     + (f" · {e['regime']}" if e["regime"] else "") + f"\n{e['text']}\n")
    return TASK + "\n\n=== PROTOCOL ===\n" + protocol, "\n".join(parts)


def ask_azure(model: str, system: str, user: str, key: str, tries: int = 5) -> tuple[str, dict]:
    body = json.dumps({"model": model, "max_completion_tokens": 6000,
                       "messages": [{"role": "system", "content": system},
                                    {"role": "user", "content": user}]}).encode()
    last = ""
    for attempt in range(tries):
        req = urllib.request.Request(AZURE, data=body, headers={
            "api-key": key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                d = json.loads(r.read())
                return d["choices"][0]["message"]["content"] or "", d.get("usage", {})
        except urllib.error.HTTPError as e:
            last = e.read().decode("utf-8", "replace")[:300]
            if e.code in (408, 429, 500, 502, 503, 504):
                time.sleep(10 * (attempt + 1))
                continue
            raise SystemExit(f"azure HTTP {e.code}: {last}")
        except Exception as e:  # noqa: BLE001 - the network
            last = repr(e)
            time.sleep(10 * (attempt + 1))
    raise SystemExit(f"azure: out of retries: {last}")


def ask_claude(model: str, system: str, user: str, tries: int = 3) -> tuple[str, dict]:
    # Headless on a box: CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
    # On a machine where `claude` is logged in, its own login is used.
    last = ""
    for attempt in range(tries):
        p = subprocess.run(
            ["claude", "-p", "--model", model, "--output-format", "json",
             "--system-prompt", system, "--tools", ""],
            input=user, capture_output=True, text=True, timeout=900)
        if p.returncode == 0:
            d = json.loads(p.stdout)
            if not d.get("is_error"):
                return d.get("result", ""), d.get("usage", {})
            last = d.get("result", "")[:300]
        else:
            last = (p.stderr or p.stdout)[:300]
        time.sleep(30 * (attempt + 1))
    raise SystemExit(f"claude: out of retries: {last}")


def parse(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON object")
    return json.loads(m.group(0))


def _norm(t: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"-\s*\n\s*", "", t)).strip().lower()


def judge_one(item: dict, args, protocol: str, key: str | None) -> dict:
    order = list(range(len(item["evidence"])))
    if args.shuffle is not None:
        random.Random(f"{args.shuffle}:{item['version']}:{item['pid']}").shuffle(order)
    system, user = prompt(protocol, item, order)
    t0 = time.time()
    if args.provider == "azure":
        text, usage = ask_azure(args.model, system, user, key)
    else:
        text, usage = ask_claude(args.model, system, user)
    try:
        got = {int(p["n"]): p for p in parse(text)["passages"]}
        error = None
    except Exception as e:  # noqa: BLE001 - a malformed answer is recorded, not fatal
        got, error = {}, f"{type(e).__name__}: {e}"
    passages = []
    for n, i in enumerate(order, 1):
        e = item["evidence"][i]
        p = got.get(n, {})
        label = p.get("label") if p.get("label") in LABELS else None
        quote = (p.get("quote") or "").strip()
        passages.append({"ecli": e["ecli"], "label": label, "quote": quote,
                         "quote_found": bool(quote) and _norm(quote) in _norm(e["text"]),
                         "why": p.get("why", "")})
    labels = [p["label"] for p in passages]
    return {"version": item["version"], "pid": item["pid"], "kind": item["kind"],
            "provider": args.provider, "model": args.model, "shuffle": args.shuffle,
            "label": None if None in labels else proposition_label(labels),
            "passages": passages, "error": error, "usage": usage,
            "seconds": round(time.time() - t0, 1), "raw": text if error else ""}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", choices=["azure", "claude"], required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--packet", type=pathlib.Path, default=DIR / "packet.json")
    ap.add_argument("--protocol", type=pathlib.Path, default=HERE / "protocol.md")
    ap.add_argument("--out", type=pathlib.Path, required=True)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--shuffle", type=int)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    protocol = args.protocol.read_text(encoding="utf-8")
    items = json.loads(args.packet.read_text(encoding="utf-8"))
    done = set()
    if args.out.exists():
        for line in args.out.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if not r.get("error"):
                done.add((r["version"], r["pid"]))
    todo = [it for it in items if (it["version"], it["pid"]) not in done][: args.limit]
    key = None
    if args.provider == "azure":
        key = pathlib.Path(os.environ.get("AZURE_FOUNDRY_KEY_FILE",
                                          pathlib.Path.home() / ".azure_foundry_key")).read_text().strip()
    print(f"{len(todo)} to judge ({len(done)} already done) with {args.provider}:{args.model}", flush=True)

    with cf.ThreadPoolExecutor(args.workers) as pool, args.out.open("a", encoding="utf-8") as fh:
        futures = {pool.submit(judge_one, it, args, protocol, key): it for it in todo}
        for f in cf.as_completed(futures):
            r = f.result()
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
            fh.flush()
            u = r["usage"]
            print(f"  {r['version']:15} {r['pid']:8} {r['label'] or 'ERROR':10} "
                  f"in={u.get('prompt_tokens', u.get('input_tokens', '?'))} "
                  f"out={u.get('completion_tokens', u.get('output_tokens', '?'))} "
                  f"{r['seconds']}s" + (f"  {r['error']}" if r["error"] else ""), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
