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
    vertex  Vertex AI's OpenAI-compatible endpoint (Gemini as "google/<name>"),
            token from `gcloud auth print-access-token`, project VERTEX_PROJECT
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
import hashlib
import json
import os
import pathlib
import random
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
DIR = pathlib.Path("/data/ch-corpus/weko-bek")
AZURE = "https://lexai-foundry-swc.openai.azure.com/openai/v1/chat/completions"
# Vertex AI's OpenAI-compatible endpoint; models as "google/<name>".
VERTEX_PROJECT = os.environ.get("VERTEX_PROJECT", "secondlayer-gpu")
VERTEX = (f"https://aiplatform.googleapis.com/v1/projects/{VERTEX_PROJECT}"
          "/locations/global/endpoints/openapi/chat/completions")
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
    if item.get("lead"):
        # the opening of the sentence a lettered point continues: context, not the proposition
        head += f"[opening of the sentence, for context only:] {item['lead']}\n[the proposition:] "
    parts = [head + item["text"], ""]
    for n, i in enumerate(order, 1):
        e = item["evidence"][i]
        when = e["date"] or (f"no later than {e['date_upper_bound']}" if e["date_upper_bound"] else "undated")
        parts.append(f"--- PASSAGE {n} --- {e['spider']} · {e['docket'] or e['ecli']} · {when}"
                     + (f" · {e['regime']}" if e["regime"] else "") + f"\n{e['text']}\n")
    return TASK + "\n\n=== PROTOCOL ===\n" + protocol, "\n".join(parts)


class JudgeFailed(Exception):
    """One proposition could not be judged; recorded as an error row, the run goes on."""


_VERTEX_TOKEN = {"value": "", "at": 0.0}


def vertex_token() -> str:
    """An access token from gcloud, renewed before its hour runs out."""
    if time.time() - _VERTEX_TOKEN["at"] > 1800:
        _VERTEX_TOKEN["value"] = subprocess.run(["gcloud", "auth", "print-access-token"],
                                                capture_output=True, text=True, check=True).stdout.strip()
        _VERTEX_TOKEN["at"] = time.time()
    return _VERTEX_TOKEN["value"]


def ask_azure(model: str, system: str, user: str, key: str | None, tries: int = 10,
              vertex: bool = False) -> tuple[str, dict]:
    # Mistral's endpoint refuses max_completion_tokens (HTTP 422); the
    # reasoning models need it, since max_tokens would cap their thinking.
    limit = "max_tokens" if model.lower().startswith("mistral") or vertex else "max_completion_tokens"
    # Gemini counts its thinking inside max_tokens
    body = json.dumps({"model": model, limit: 16000 if vertex else 6000,
                       "messages": [{"role": "system", "content": system},
                                    {"role": "user", "content": user}]}).encode()
    last = ""
    for attempt in range(tries):
        headers = ({"Authorization": f"Bearer {vertex_token()}"} if vertex else {"api-key": key})
        req = urllib.request.Request(VERTEX if vertex else AZURE, data=body,
                                     headers={**headers, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                d = json.loads(r.read())
                return d["choices"][0]["message"]["content"] or "", d.get("usage", {})
        except urllib.error.HTTPError as e:
            last = e.read().decode("utf-8", "replace")[:300]
            if e.code in (408, 429, 500, 502, 503, 504):
                # a 429 says how long to wait; the token-rate limit of a small
                # deployment ended the first DeepSeek run at 17 of 58
                wait = e.headers.get("retry-after") if e.headers else None
                time.sleep(max(float(wait) if wait and wait.isdigit() else 0, 15 * (attempt + 1)))
                continue
            raise JudgeFailed(f"azure HTTP {e.code}: {last}")
        except Exception as e:  # noqa: BLE001 - the network
            last = repr(e)
            time.sleep(15 * (attempt + 1))
    raise JudgeFailed(f"azure: out of retries: {last}")


# A bare `claude -p` is not a bare model call. Measured 2026-10-01: with only
# --system-prompt and --tools "" each judge call still carried ~100K tokens of
# context -- a plugin's SessionStart hook ("You have superpowers ..."), ~250
# MCP tool definitions, skills. Without settings, MCP, skills and session
# persistence, and from an empty directory (no CLAUDE.md, no auto-memory), what
# remains is ~400 tokens of neutral environment lines (date, OS, model name).
CLAUDE_CLEAN = ["--tools", "", "--setting-sources", "", "--strict-mcp-config",
                "--disable-slash-commands", "--no-session-persistence"]
# Allowed overhead above our own prompt before an answer counts as contaminated.
CLAUDE_OVERHEAD_TOKENS = 1500


def ask_claude(model: str, system: str, user: str, tries: int = 3) -> tuple[str, dict]:
    # Headless on a box: CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
    # On a machine where `claude` is logged in, its own login is used.
    last = ""
    for attempt in range(tries):
        with tempfile.TemporaryDirectory(prefix="vbjudge-") as cwd:
            p = subprocess.run(
                ["claude", "-p", "--model", model, "--output-format", "json",
                 "--system-prompt", system, *CLAUDE_CLEAN],
                input=user, capture_output=True, text=True, timeout=900, cwd=cwd)
        if p.returncode == 0:
            d = json.loads(p.stdout)
            if not d.get("is_error"):
                u = d.get("usage", {})
                seen = (u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                        + u.get("cache_read_input_tokens", 0))
                ours = int((len(system) + len(user)) / 2.5)    # German legal text: ~2.5-3 chars a token
                if seen > ours + CLAUDE_OVERHEAD_TOKENS:
                    raise SystemExit(f"claude: {seen} input tokens for a ~{ours}-token prompt: "
                                     "context was injected; refusing the answer")
                return d.get("result", ""), u
            last = d.get("result", "")[:300]
        else:
            last = (p.stderr or p.stdout)[:300]
        time.sleep(30 * (attempt + 1))
    raise JudgeFailed(f"claude: out of retries: {last}")


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
    assert "=== PROTOCOL ===" in system and protocol in system
    t0 = time.time()
    try:
        if args.provider in ("azure", "vertex"):
            text, usage = ask_azure(args.model, system, user, key, vertex=args.provider == "vertex")
        else:
            text, usage = ask_claude(args.model, system, user)
    except JudgeFailed as e:
        # no labels: written as an error row, which a rerun picks up again
        return {"version": item["version"], "pid": item["pid"], "kind": item["kind"],
                "provider": args.provider, "model": args.model, "shuffle": args.shuffle,
                "label": None, "passages": [], "error": str(e), "usage": {},
                "seconds": round(time.time() - t0, 1), "raw": ""}
    return answer_row(item, text, usage, args.provider, args.model, args.shuffle, order, system,
                      time.time() - t0)


def answer_row(item: dict, text: str, usage: dict, provider: str, model: str, shuffle,
               order: list[int], system: str, seconds: float, error: str | None = None) -> dict:
    """One judge answer as a row: passage labels mapped back to the packet's
    passages, quotes checked against the passage, the proposition's label
    derived. Shared by the realtime judges and batch.py."""
    got = {}
    if not error:
        try:
            got = {int(p["n"]): p for p in parse(text)["passages"]}
        except Exception as e:  # noqa: BLE001 - a malformed answer is recorded, not fatal
            error = f"{type(e).__name__}: {e}"
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
            "provider": provider, "model": model, "shuffle": shuffle,
            "label": None if None in labels else proposition_label(labels),
            "system_sha256": hashlib.sha256(system.encode()).hexdigest(),
            "passages": passages, "error": error, "usage": usage,
            "seconds": round(seconds, 1), "raw": text if error else ""}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", choices=["azure", "vertex", "claude"], required=True)
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
