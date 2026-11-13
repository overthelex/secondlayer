"""Read-only gate for the fedlex_pdf clean text product (split_fedlex_text).

Before full_text is rewritten for every fedlex_pdf edition, the operator runs
this over a prod sample (200 editions) and reads the distribution. For each
version it recomputes split_fedlex_text on the stored RAW text
(COALESCE(akn_xml, full_text), the resplit stage's own source) and measures
the clean text against it:

  word_loss     share of the raw's word types of 6+ letters (wrap-hyphen
                fragments excluded, see raw_word_types) that the clean text
                does not contain, neither as a word nor as the end of a longer
                one (the tail of a wrap the raw cannot see, "papiere" in
                "Wertpapiere"). Footnotes are part of the clean text, so
                an amendment history that goes missing shows up here.
  length_ratio  len(clean) / len(raw with every whitespace run collapsed to
                one space). Running headers, folios and publication lines are
                dropped on purpose, so a healthy edition sits near 0.9, not
                1.0 (see LENGTH_RATIO_MIN).
  hyphen_breaks wrap hyphens left in the clean text ("Wert- papiere",
                "Verwal-" at a line end), per 10,000 words; hyphen_share is
                the share of versions with at least one.
  glued_refs    a footnote number still glued to a word ("Schuld15 ") per
                10,000 words; glued_share is the share of versions with one.

Prints median / p95 / max of each and the five worst version_ids by
word_loss. Exit 1 when the gate fails (median word_loss > WORD_LOSS_MAX,
p95 word_loss > WORD_LOSS_P95_MAX, or median length_ratio <
LENGTH_RATIO_MIN) or any version errors, 2 on usage errors. Never writes
(the connection is read-only).

  CHPIPE_DSN=postgresql://... python scripts/fedlex_clean_check.py \\
      [--limit 200] [--random] [--version-ids 560275,560210] [--json FILE]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from chpipe import fedlex_split, text_clean  # noqa: E402

# Thresholds, from the five pilot editions (SchKG de/fr/it, BV 1874 fr/it;
# version_ids 560210-560213, 560275), before -> after the 2026-11 fix:
#   word_loss     0.012-0.018 -> <= 0.0004   (footnotes were dropped)
#   length_ratio  0.76-0.86   -> 0.965-0.984
# WORD_LOSS_MAX (per edition, and the gate's median) sits well under the
# broken range; the gate also holds p95 to the brief's 2%. LENGTH_RATIO_MIN:
# the furniture the clean text drops on purpose (running headers, folios,
# publication lines, whitespace inside table rows) costs 2-4% of the
# collapsed raw on these prints, so a healthy edition sits near 0.97; 0.90
# leaves room for furniture-heavy prints and is still above every broken
# edition (the highest was 0.856).
WORD_LOSS_MAX = 0.005
WORD_LOSS_P95_MAX = 0.02
LENGTH_RATIO_MIN = 0.90

_WORD = re.compile(r"[^\W\d_]+")
# a wrap hyphen in the raw: a word part, "-", then whitespace (a line end, or
# the gap to the other column in the marginal layout) and a lowercase word
# part. Both parts are fragments, not words of the text.
_RAW_BREAK = re.compile(r"[^\W\d_]*-(?=\s)(?:\s+[a-zäöüßéèàùâêîôûçëïìòáíóú][^\W\d_]*)?")
# the same left in the clean text: "Wert- papiere", "Verwal-\n" -- but not a
# suspended compound ("Kantons- und", "Bundes- oder", "pré- et")
_CONNECTOR = (r"(?:und|oder|bzw|sowie|resp|beziehungsweise|et|ou|ni|e|o|od|ed|"
              r"oppure|and|or|nor|bis|als|wie)\b")
_CLEAN_BREAK = re.compile(
    r"[^\W\d_]{2,}-(?:[ \t]+(?!" + _CONNECTOR + r")[a-zäöüßéèàùâêîôûçëïìòáíóú]|\n|$)")
_GLUED_REF = re.compile(r"[a-zäöüéèàç]\.?\d{2,3}(?=\s)")


def raw_word_types(raw: str) -> set[str]:
    """Word types of 6+ letters in the raw text, with wrap-hyphen fragments
    taken out first ("Aufbewah-" / "rung", "Wert-" / "papiere"). A word only
    ever printed across a break is therefore not counted at all: the raw
    alone cannot tell "Wert-" + "papiere" from "Wert-" + the marginal
    column's "rung" in the marginal layout, so a naive line-end join would
    invent words the clean text rightly lacks."""
    text = _RAW_BREAK.sub(" ", text_clean.normalise_chars(raw))
    return {w for w in _WORD.findall(text) if len(w) >= 6}


def measure(raw: str, clean: str) -> dict:
    raw_types = raw_word_types(raw)
    clean_types = set(_WORD.findall(clean))
    # a type that survives as the END of a longer clean word is not lost: the tail
    # of a break the raw cannot see ("Wert-" / margin line / "papiere")
    # comes back as "Wertpapiere"
    missing = sorted(w for w in raw_types - clean_types
                     if not re.search(r"[^\W\d_]" + re.escape(w) + r"(?![^\W\d_])", clean))
    collapsed = " ".join(raw.split())
    words = max(1, len(clean.split()))
    breaks = len(_CLEAN_BREAK.findall(clean))
    glued = len(_GLUED_REF.findall(clean))
    return {
        "word_loss": len(missing) / len(raw_types) if raw_types else 0.0,
        "missing": missing,
        "length_ratio": len(clean) / len(collapsed) if collapsed else 0.0,
        "hyphen_breaks": breaks * 10000 / words,
        "glued_refs": glued * 10000 / words,
        "hyphen_examples": [m.group(0) for m in _CLEAN_BREAK.finditer(clean)][:5],
    }


def measure_raw(raw: str, lang: str | None) -> dict:
    _, clean = fedlex_split.split_fedlex_text(raw, lang)
    return measure(raw, clean)


def _p95(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))]


def summarise(results: dict[int, dict]) -> dict:
    out: dict = {"n": len(results)}
    if not results:
        return out
    for key in ("word_loss", "length_ratio", "hyphen_breaks", "glued_refs"):
        values = [r[key] for r in results.values()]
        out[key] = {"median": statistics.median(values), "p95": _p95(values),
                    "max": max(values), "min": min(values)}
    out["hyphen_share"] = sum(1 for r in results.values() if r["hyphen_breaks"]) / len(results)
    out["glued_share"] = sum(1 for r in results.values() if r["glued_refs"]) / len(results)
    out["worst"] = sorted(results, key=lambda v: results[v]["word_loss"], reverse=True)[:5]
    return out


def gate_ok(summary: dict) -> bool:
    return (summary.get("n", 0) > 0
            and summary["word_loss"]["median"] <= WORD_LOSS_MAX
            and summary["word_loss"]["p95"] <= WORD_LOSS_P95_MAX
            and summary["length_ratio"]["median"] >= LENGTH_RATIO_MIN)


def _print(summary: dict, results: dict[int, dict]) -> None:
    print(f"versions measured: {summary['n']}")
    if not summary["n"]:
        return
    for key in ("word_loss", "length_ratio", "hyphen_breaks", "glued_refs"):
        s = summary[key]
        print(f"{key:14s} median {s['median']:.4f}  p95 {s['p95']:.4f}  "
              f"max {s['max']:.4f}  min {s['min']:.4f}")
    print(f"hyphen_share   {summary['hyphen_share']:.3f} (versions with >=1 wrap hyphen left)")
    print(f"glued_share    {summary['glued_share']:.3f} (versions with >=1 glued footnote ref)")
    print("worst by word_loss:")
    for vid in summary["worst"]:
        r = results[vid]
        print(f"  {vid}  loss {r['word_loss']:.4f}  ratio {r['length_ratio']:.3f}  "
              f"missing e.g. {r['missing'][:8]}")


_ROWS = ("SELECT version_id, lang, COALESCE(akn_xml, full_text) AS raw_text "
         "FROM ch_act_version WHERE source = 'fedlex_pdf' "
         "AND COALESCE(akn_xml, full_text) IS NOT NULL ")


def _fetch(dsn: str, limit: int, random_order: bool, ids: list[int] | None):
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        conn.read_only = True
        with conn.cursor() as cur:
            if ids:
                cur.execute(_ROWS + "AND version_id = ANY(%s) ORDER BY version_id", (ids,))
            else:
                order = "random()" if random_order else "version_id"
                cur.execute(_ROWS + "AND stage = 'parsed' ORDER BY " + order + " LIMIT %s",
                            (limit,))
            yield from cur


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--random", action="store_true")
    parser.add_argument("--version-ids", default="")
    parser.add_argument("--json", dest="json_out")
    args = parser.parse_args(argv)
    dsn = os.environ.get("CHPIPE_DSN")
    if not dsn:
        print("CHPIPE_DSN is not set", file=sys.stderr)
        return 2
    ids = [int(v) for v in args.version_ids.split(",") if v.strip()] or None
    results: dict[int, dict] = {}
    errors: dict[int, str] = {}
    for row in _fetch(dsn, args.limit, args.random, ids):
        try:
            results[row["version_id"]] = measure_raw(row["raw_text"], row["lang"])
        except Exception as exc:                        # noqa: BLE001
            errors[row["version_id"]] = repr(exc)
    summary = summarise(results)
    _print(summary, results)
    if errors:
        print(f"errors: {len(errors)} {sorted(errors)[:10]}")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(
            {"summary": summary, "results": results, "errors": errors},
            ensure_ascii=False, indent=1, default=str))
    return 0 if gate_ok(summary) and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
