"""The Bedrock baseline system for the CH point-in-time benchmark: asks a
model the same dated question the oracle (run_oracle.py) answers from the
database, but with no retrieval and no ground truth in the prompt -- the
model gets only the act/article/date, exactly as a chat user would type it,
via the `question` field build.py already rendered.

Unlike run_oracle.py, a real LLM run costs real money and can be slow, so
this module adds two things run_oracle.py does not need: a stratified
sample (asking all 5,000+ items per language would be both expensive and
unnecessary for a benchmark number) and a cost gate that prints an estimate
and refuses to spend anything without an explicit confirmation.

Sampling: independently per language, `random.Random(f"{seed}:{lang}:llm")`
draws `sample_per_lang` items from that language's `bench-{lang}.jsonl`,
stratified by `kind` (`before`/`after`) so a systematic bias -- e.g. models
being better at "the version valid before some cutoff" than "the version
valid on the cutoff itself" -- cannot hide inside an unbalanced sample. Pure
function of (seed, lang, the item set); calling run() twice against the same
items produces the same sample.

Cost gate: estimate() prices every item in the sample against the module's
price table (see _PRICES) using a chars/4 token approximation -- no tokenizer
call, no network, so the estimate can be shown before anything is spent.
run() prints that estimate as JSON and returns without calling `client` at
all unless `confirm=True` (the CLI wires this to the CHPIPE_BENCH_CONFIRM=1
environment variable, not a flag, so a bare `python -m
chpipe.bench.run_llm` can never accidentally spend money); main() then
exits 2, distinct from the exit-0 confirmed path and any exit-1 argparse
error.

Client shape: `client.converse(modelId=..., system=[{"text": ...}],
messages=[{"role": "user", "content": [{"text": question}]}],
inferenceConfig={"maxTokens": 2048, "temperature": 0})`, returning the
boto3 bedrock-runtime shape `{"output": {"message": {"content": [{"text":
...}]}}, "usage": {"inputTokens": n, "outputTokens": m}}`. Tests always pass
a fake client; the real one (_bedrock_client()) imports boto3 lazily so this
module -- and every test that imports it -- never requires boto3 to be
installed.
"""
from __future__ import annotations

import argparse
import dataclasses
import datetime
import json
import logging
import math
import os
import pathlib
import random
import time
from typing import Any

from chpipe.bench import score

log = logging.getLogger(__name__)

# Model ids verified against `aws bedrock list-inference-profiles --region
# eu-central-1` on 2026-08-25. Re-verify before a future run -- Bedrock
# inference-profile ids are not guaranteed stable, and this benchmark does
# not import packages/shared's ModelSelector to avoid coupling a one-off
# research script to the product's model-selection config.
HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0"
SONNET = "eu.anthropic.claude-sonnet-4-6"

# Short system-id used in result filenames and the `system` field, so a
# result line reads like run_oracle.py's ("oracle") rather than repeating
# the full inference-profile id on every line.
_MODEL_SHORT: dict[str, str] = {
    HAIKU: "haiku-4-5",
    SONNET: "sonnet-4-6",
}

# USD per 1,000,000 tokens. Prices as of 2026-08, verify before a run --
# both are eu-central-1 Bedrock inference-profile prices, not list price,
# and Bedrock pricing changes without notice to this repo.
_PRICES: dict[str, dict[str, float]] = {
    HAIKU: {"in": 1.00, "out": 5.00},
    SONNET: {"in": 3.00, "out": 15.00},
}

_SYSTEM_PROMPT = (
    "You are a Swiss legal database. Answer with the verbatim text of the "
    "requested article as in force on the given date, in the language of "
    "the question, nothing else."
)

RESULTS_TEMPLATE = "results-llm-{model_short}.jsonl"
REPORT_FILENAME = "llm-run-report.json"

# Retry budget for a Bedrock throttling/overload response -- see
# _is_throttling(). Five attempts, doubling from 1s, tops out at a 16s
# sleep before the fifth (and final) retry.
_MAX_RETRIES = 5
_BACKOFF_SECONDS = (1, 2, 4, 8, 16)

# ≈4 characters per token (no tokenizer call -- see module docstring "Cost
# gate"). Ceilinged, not rounded, so the estimate never undercounts a
# short prompt to zero tokens.
_CHARS_PER_TOKEN = 4

# Flat per-item overhead added to the output-token estimate, covering
# formatting/boilerplate a model's answer carries beyond the bare article
# text (see estimate()'s docstring).
_OUTPUT_TOKEN_OVERHEAD = 50

_KINDS = ("before", "after")


def _tokens(chars: int) -> int:
    return math.ceil(chars / _CHARS_PER_TOKEN)


def _iso(dt: datetime.datetime) -> str:
    return dt.astimezone(datetime.timezone.utc).isoformat()


@dataclasses.dataclass(frozen=True)
class LlmRunReport:
    """run()'s return value.

    `confirmed` is False on the cost-gate path (no client call happened,
    `actual`/`started`/`finished` are all None) and True once a run actually
    called the client. `estimate` is always present -- computed before the
    gate check either way. `sample_size` is the number of items the run
    would answer (gated) or did answer (confirmed), summed across languages
    and independent of `models` (each model answers the same sample).
    """

    confirmed: bool
    estimate: dict[str, Any]
    actual: dict[str, Any] | None
    started: str | None
    finished: str | None
    sample_size: int


def _read_items_by_lang(items_path: pathlib.Path, langs: tuple[str, ...],
                        ) -> dict[str, list[dict[str, Any]]]:
    by_lang: dict[str, list[dict[str, Any]]] = {}
    for lang in langs:
        items: list[dict[str, Any]] = []
        f = items_path / f"bench-{lang}.jsonl"
        if f.exists():
            with f.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        items.append(json.loads(line))
        by_lang[lang] = items
    return by_lang


def _sample_lang(items: list[dict[str, Any]], sample_per_lang: int,
                 rng: random.Random) -> list[dict[str, Any]]:
    """Stratified sample of ITEMS (all belonging to one language) by
    `kind`. `before`/`after` each get roughly half of SAMPLE_PER_LANG (any
    other/missing `kind` value is treated as its own, lower-priority
    bucket, so a malformed item file degrades gracefully instead of
    raising); a bucket that runs short hands its shortfall to the others
    via a shared, RNG-shuffled leftover pool, so the sample size is always
    `min(sample_per_lang, len(items))`.

    Deterministic: every bucket is sorted by id before RNG.shuffle() so the
    result depends only on RNG's seed and the item set, never on the order
    ITEMS arrived in (file iteration order is already id-sorted by
    build.py, but this does not rely on that).
    """
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        by_kind.setdefault(item.get("kind", "unknown"), []).append(item)
    for bucket in by_kind.values():
        bucket.sort(key=lambda it: it["id"])
        rng.shuffle(bucket)

    kinds = [k for k in _KINDS if k in by_kind]
    kinds += sorted(k for k in by_kind if k not in _KINDS)
    if not kinds:
        return []

    total_available = sum(len(by_kind[k]) for k in kinds)
    target = min(sample_per_lang, total_available)

    base = target // len(kinds)
    remainder = target - base * len(kinds)
    quotas = {k: base for k in kinds}
    for k in kinds[:remainder]:
        quotas[k] += 1

    picked: list[dict[str, Any]] = []
    leftover: list[dict[str, Any]] = []
    for k in kinds:
        bucket = by_kind[k]
        take = min(quotas[k], len(bucket))
        picked.extend(bucket[:take])
        leftover.extend(bucket[take:])

    shortfall = target - len(picked)
    if shortfall > 0:
        rng.shuffle(leftover)
        picked.extend(leftover[:shortfall])

    picked.sort(key=lambda it: it["id"])
    return picked


def sample_items(items_dir: str | pathlib.Path, langs: tuple[str, ...],
                 sample_per_lang: int, seed: int) -> list[dict[str, Any]]:
    """Public wrapper: read `{items_dir}/bench-{lang}.jsonl` for every LANG
    and return the concatenated, id-sorted stratified sample -- the exact
    item set run()'s estimate and (if confirmed) the client calls both use.
    """
    items_path = pathlib.Path(items_dir)
    by_lang = _read_items_by_lang(items_path, langs)
    sample: list[dict[str, Any]] = []
    for lang in langs:
        rng = random.Random(f"{seed}:{lang}:llm")
        sample.extend(_sample_lang(by_lang.get(lang, []), sample_per_lang, rng))
    sample.sort(key=lambda it: it["id"])
    return sample


def estimate(items: list[dict[str, Any]], models: tuple[str, ...]) -> dict[str, Any]:
    """Price ITEMS against every model in MODELS, chars/4 as tokens (see
    module docstring "Cost gate").

    Input tokens per item: the system prompt plus the item's `question`.
    Output tokens per item: the gold article's text length (a stand-in for
    "however long the correct answer is") plus a flat
    `_OUTPUT_TOKEN_OVERHEAD` (50) covering the boilerplate a model's answer
    typically carries beyond the bare article text (a leading "Art. 336
    OR:", trailing whitespace, an occasional restated question) -- without
    it, a short article would price as if the model always answered with
    zero overhead, which measurement against real Bedrock responses during
    this benchmark's design did not hold.

    Returns `{model_id: {items, input_tokens, output_tokens, usd}, ...,
    total_usd}` -- `total_usd` sums every model's `usd`, since a run may
    ask more than one model over the same sample and the gate should show
    the combined spend.
    """
    system_chars = len(_SYSTEM_PROMPT)
    result: dict[str, Any] = {}
    total_usd = 0.0
    for model in models:
        input_tokens = 0
        output_tokens = 0
        for item in items:
            input_tokens += _tokens(system_chars + len(item["question"]))
            output_tokens += _tokens(len(item["gold"]["text"])) + _OUTPUT_TOKEN_OVERHEAD
        price = _PRICES[model]
        usd = (input_tokens / 1_000_000 * price["in"]
               + output_tokens / 1_000_000 * price["out"])
        result[model] = {
            "items": len(items),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "usd": usd,
        }
        total_usd += usd
    result["total_usd"] = total_usd
    return result


def _is_throttling(exc: Exception) -> bool:
    """True for an exception whose class name contains "Throttling" or
    "ServiceUnavailable" -- the boto3 convention for these errors (e.g.
    botocore.errorfactory's dynamically-built `ThrottlingException`,
    `ServiceUnavailableException`) is to name the class after the error
    code, so matching on the name avoids importing botocore's exception
    types just to catch them.
    """
    name = type(exc).__name__
    return "Throttling" in name or "ServiceUnavailable" in name


def _call_with_retries(client: Any, model_id: str, question: str) -> dict[str, Any]:
    """Call `client.converse()` for one item's QUESTION, retrying up to
    `_MAX_RETRIES` times with exponential backoff (`_BACKOFF_SECONDS`) when
    the exception looks like Bedrock throttling/overload (see
    _is_throttling()). Any other exception -- or a throttling exception
    that has exhausted its retries -- propagates to the caller, which
    records it on the item rather than aborting the run (see
    _answer_item()).
    """
    attempt = 0
    while True:
        try:
            return client.converse(
                modelId=model_id,
                system=[{"text": _SYSTEM_PROMPT}],
                messages=[{"role": "user", "content": [{"text": question}]}],
                inferenceConfig={"maxTokens": 2048, "temperature": 0},
            )
        except Exception as exc:
            if _is_throttling(exc) and attempt < _MAX_RETRIES:
                time.sleep(_BACKOFF_SECONDS[min(attempt, len(_BACKOFF_SECONDS) - 1)])
                attempt += 1
                continue
            raise


def _answer_item(client: Any, model_id: str, model_short: str,
                 item: dict[str, Any]) -> dict[str, Any]:
    """Answer one ITEM with MODEL_ID via CLIENT and score the result.

    On any exception from `_call_with_retries` (after retries, for a
    throttling-shaped error; immediately for anything else) the item is
    recorded with `answer: ""`, zero tokens, and an `error` field carrying
    the exception's type and message -- and is scored, same as any other
    answer, so an unreachable model shows up as `ungrounded` in report.py's
    tally rather than silently vanishing from the count.
    """
    t0 = time.monotonic()
    error: str | None = None
    answer = ""
    input_tokens = 0
    output_tokens = 0
    try:
        response = _call_with_retries(client, model_id, item["question"])
        answer = response["output"]["message"]["content"][0]["text"]
        usage = response.get("usage") or {}
        input_tokens = usage.get("inputTokens", 0)
        output_tokens = usage.get("outputTokens", 0)
    except Exception as exc:  # noqa: BLE001 -- recorded per item, not fatal (see module docstring)
        error = f"{type(exc).__name__}: {exc}"
    latency_s = time.monotonic() - t0

    verdict = score.score(answer, item["gold"]["text"], item["distractor"]["text"])
    result: dict[str, Any] = {
        "id": item["id"],
        "system": model_short,
        "model": model_id,
        "lang": item["lang"],
        "answer": answer,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "latency_s": latency_s,
        "verdict": {
            "label": verdict.label,
            "gold_coverage": verdict.gold_coverage,
            "distractor_coverage": verdict.distractor_coverage,
            "shared_coverage": verdict.shared_coverage,
        },
    }
    if error is not None:
        result["error"] = error
    return result


def run(items_dir: str | pathlib.Path, out_dir: str | pathlib.Path,
        langs: tuple[str, ...] = ("de", "fr", "it"),
        models: tuple[str, ...] = (HAIKU, SONNET),
        sample_per_lang: int = 300, seed: int = 20260825,
        client: Any = None, confirm: bool = False,
        now: datetime.datetime | None = None) -> LlmRunReport:
    """Sample `sample_per_lang` items per language from
    `{items_dir}/bench-{lang}.jsonl` (see sample_items()), price the sample
    against MODELS (see estimate()), and -- only if `confirm` is True --
    ask every model in MODELS to answer every sampled item via CLIENT,
    writing `{out_dir}/results-llm-{model_short}.jsonl` per model and
    `{out_dir}/llm-run-report.json` once, then return an LlmRunReport.

    Without `confirm=True` this prints the estimate as JSON to stdout and
    returns immediately with `confirmed=False` -- CLIENT is never touched
    at all (see module docstring "Cost gate"); main() turns that into exit
    code 2.

    NOW fixes both `started` and `finished` in the written report when
    given (tests); production callers (main()) leave it None and each
    timestamp is the real wall clock at that point in the run.
    """
    sample = sample_items(items_dir, langs, sample_per_lang, seed)
    est = estimate(sample, models)

    if not confirm:
        print(json.dumps(est, ensure_ascii=False))
        return LlmRunReport(confirmed=False, estimate=est, actual=None,
                             started=None, finished=None, sample_size=len(sample))

    out_path = pathlib.Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    started = _iso(now) if now is not None else _iso(datetime.datetime.now(datetime.timezone.utc))

    actual: dict[str, Any] = {}
    total_usd = 0.0
    for model in models:
        model_short = _MODEL_SHORT.get(model, model)
        results: list[dict[str, Any]] = []
        answered = 0
        errors = 0
        input_tokens_sum = 0
        output_tokens_sum = 0
        for item in sample:
            result = _answer_item(client, model, model_short, item)
            results.append(result)
            input_tokens_sum += result["input_tokens"]
            output_tokens_sum += result["output_tokens"]
            if "error" in result:
                errors += 1
            else:
                answered += 1

        price = _PRICES[model]
        usd = (input_tokens_sum / 1_000_000 * price["in"]
               + output_tokens_sum / 1_000_000 * price["out"])
        total_usd += usd
        actual[model] = {
            "items": len(sample),
            "answered": answered,
            "errors": errors,
            "input_tokens": input_tokens_sum,
            "output_tokens": output_tokens_sum,
            "usd": usd,
        }

        out_file = out_path / RESULTS_TEMPLATE.format(model_short=model_short)
        with out_file.open("w", encoding="utf-8") as f:
            for result in results:
                f.write(json.dumps(result, ensure_ascii=False))
                f.write("\n")

    actual["total_usd"] = total_usd
    finished = _iso(now) if now is not None else _iso(datetime.datetime.now(datetime.timezone.utc))

    report_dict = {
        "estimate": est,
        "actual": actual,
        "started": started,
        "finished": finished,
    }
    (out_path / REPORT_FILENAME).write_text(
        json.dumps(report_dict, ensure_ascii=False, indent=2))

    return LlmRunReport(confirmed=True, estimate=est, actual=actual,
                         started=started, finished=finished, sample_size=len(sample))


def _bedrock_client(region: str = "eu-central-1") -> Any:
    """Build the real boto3 bedrock-runtime client. Imported lazily -- not
    at module load -- so no test (and no `python -m chpipe.bench.run_llm`
    invocation on the cost-estimate-only path) ever requires boto3 to be
    installed; only a confirmed run does.
    """
    import boto3

    return boto3.client("bedrock-runtime", region_name=region)


def main(argv: list[str] | None = None) -> int:
    """Entry point: `python -m chpipe.bench.run_llm --items DIR --out DIR
    [--langs de,fr,it] [--models MODEL_ID,...] [--sample-per-lang 300]
    [--seed 20260825] [--region eu-central-1]`.

    The cost gate is the environment variable CHPIPE_BENCH_CONFIRM=1, not a
    flag -- see module docstring "Cost gate" for why. Returns 2 (and prints
    the estimate, via run()) when unset; 0 on a confirmed run.

    Not a run-stage.sh dispatch target -- see build.main()'s docstring for
    the same reasoning: this is an occasional, costed research run a human
    triggers by hand, not a nightly pipeline stage.
    """
    parser = argparse.ArgumentParser(
        description="Run Bedrock baseline models over the CH point-in-time benchmark items")
    parser.add_argument("--items", required=True,
                        help="directory holding bench-{lang}.jsonl item files")
    parser.add_argument("--out", required=True,
                        help="directory to write results-llm-*.jsonl and the run report into")
    parser.add_argument("--langs", default="de,fr,it",
                        help="comma-separated language codes (default: de,fr,it)")
    parser.add_argument("--models", default=f"{HAIKU},{SONNET}",
                        help="comma-separated Bedrock model/inference-profile ids")
    parser.add_argument("--sample-per-lang", type=int, default=300,
                        help="items sampled per language (default: 300)")
    parser.add_argument("--seed", type=int, default=20260825,
                        help="sampling seed (default: 20260825)")
    parser.add_argument("--region", default="eu-central-1",
                        help="Bedrock region for the real client (default: eu-central-1)")
    args = parser.parse_args(argv)

    langs = tuple(part.strip() for part in args.langs.split(",") if part.strip())
    models = tuple(part.strip() for part in args.models.split(",") if part.strip())
    confirm = os.environ.get("CHPIPE_BENCH_CONFIRM") == "1"

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    client = _bedrock_client(args.region) if confirm else None
    report = run(items_dir=args.items, out_dir=args.out, langs=langs, models=models,
                sample_per_lang=args.sample_per_lang, seed=args.seed,
                client=client, confirm=confirm)

    if not report.confirmed:
        log.info("cost estimate only (set CHPIPE_BENCH_CONFIRM=1 to run for real)")
        return 2

    log.info("llm run: sample=%d models=%s", report.sample_size, ",".join(models))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
