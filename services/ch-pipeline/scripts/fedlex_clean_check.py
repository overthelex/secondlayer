"""Read-only gate for the fedlex_pdf clean text product (split_fedlex_text).

Before full_text is rewritten for every fedlex_pdf edition, the operator runs
this over a prod sample (200 editions) and reads the distribution. For each
version it recomputes split_fedlex_text on the stored RAW text
(COALESCE(akn_xml, full_text), the resplit stage's own source) and measures
the clean text against it:

  word_loss     share of the raw's word types of 6+ letters (wrap-hyphen
                fragments and running-header lines excluded, see
                raw_word_types) that the clean text
                does not contain, neither as a word nor as the end of a longer
                one (the tail of a wrap the raw cannot see, "papiere" in
                "Wertpapiere"). Footnotes are part of the clean text, so
                an amendment history that goes missing shows up here.
  token_loss    the same by count: share of the raw's 6+-letter tokens
                (same exclusions) the clean text does not match occurrence
                for occurrence -- a repeated phrase lost once counts.
  footnote_miss share of the raw's footnote heads (raw_footnotes: numbered
                column-0 lines at a page bottom, numbers in sequence) whose
                number and first word do not open a paragraph of the clean
                text.
  content_ratio len(clean) / len(raw minus its furniture lines, collapsed);
                per edition, gated on p5 (CONTENT_RATIO_FLOOR); the editions
                under the floor are listed.
  length_ratio  len(clean) / len(raw with every whitespace run collapsed to
                one space). Running headers, folios and publication lines are
                dropped on purpose, so a healthy edition sits near 0.9, not
                1.0 (see LENGTH_RATIO_MIN).
  hyphen_breaks wrap hyphens left in the clean text ("Wert- papiere",
                "Verwal-" at a line end), per 10,000 words; hyphen_share is
                the share of versions with at least one.
  glued_refs    a footnote number still glued to a word ("Schuld15 ") per
                10,000 words; glued_share is the share of versions with one.

Prints median / p5 / p95 / max / min of each and the five worst
version_ids. Exit 1 when the gate fails (see gate_ok and the thresholds
below) or any version errors, 2 on usage errors. Never writes (the
connection is read-only).

  CHPIPE_DSN=postgresql://... python scripts/fedlex_clean_check.py \\
      [--limit 200] [--ordered] [--version-ids 560275,560210] [--json FILE]

The sample is random by default (--ordered: the first N by version_id).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from chpipe import fedlex_split, text_clean  # noqa: E402

# Thresholds, from the five pilot editions (SchKG de/fr/it, BV 1874 fr/it;
# version_ids 560210-560213, 560275), measured three ways: the rolled-back
# pilot (main) -> 9db131a3 (margins + footnotes, BV 1874 footnote heads still
# lost) -> this version:
#   word_loss      0.012-0.018 -> 0          -> 0
#   token_loss     0.064-0.119 -> 0-0.011    -> 0
#   footnote_miss  0.89-1.00   -> 0-0.185    -> 0
#   length_ratio   0.76-0.86   -> 0.968-0.984 -> 0.968-0.986
#   content_ratio  0.78-0.87   -> 0.981-0.999 -> 0.995-0.999
# word_loss counts TYPES, so a repeated phrase lost in some of its places
# (the BV 1874 footnote heads: identical wording, every head but its number
# gone) leaves it at 0; token_loss and footnote_miss see it. Each gate sits
# well under the broken range and above the healthy one:
#   WORD_LOSS_MAX / _P95_MAX   median 0.5%, p95 the brief's 2%
#   TOKEN_LOSS_P95_MAX 0.5%    9db131a3 reached 0.8-1.1% on two editions
#   FOOTNOTE_MISS_P95_MAX 2%   9db131a3: 14.5% and 18.5%; a few raw heads the
#                              detector misreads (a table row "12   Kantone")
#                              are tolerated
#   LENGTH_RATIO_MIN 0.90      median over the collapsed raw
#   CONTENT_RATIO_FLOOR 0.90   per edition, gated on p5: clean over the raw
#                              WITHOUT its furniture lines (SR number, running
#                              headers, folios), so a short edition that only
#                              drops its SR header passes; the broken pilot
#                              sat at 0.78-0.87
WORD_LOSS_MAX = 0.005
WORD_LOSS_P95_MAX = 0.02
TOKEN_LOSS_P95_MAX = 0.005
FOOTNOTE_MISS_P95_MAX = 0.02
LENGTH_RATIO_MIN = 0.90
CONTENT_RATIO_FLOOR = 0.90

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


def running_header_lines(raw: str) -> set[int]:
    """Indices of the raw's page-furniture lines: the SR number learnt at
    the head, alone or with a title one wide gap away ("281.1   Poursuite
    pour dettes et faillite", "Rheinschifffahrt   747.224.131"); a
    "title   number" line that recurs WHOLE, number included, on two pages or
    more (fedlex_split._header_key, the same definition the clean text
    uses: a footnote head "93   Accepté ..." repeats its wording, never its
    number); and the bare folios. The clean text drops them on purpose, so
    words printed only there are no content loss."""
    lines = raw.splitlines()
    sysnr = fedlex_split._find_sysnr(lines[:8])
    out: set[int] = set()
    counts: dict[str, list[int]] = {}
    for index, line in enumerate(lines):
        stripped = line.strip()
        if sysnr and (stripped == sysnr or (index and fedlex_split._is_running_header(line, sysnr))):
            out.add(index)
            continue
        if fedlex_split._FOLIO.match(stripped):
            out.add(index)
            continue
        key = fedlex_split._header_key(line)
        if key:
            counts.setdefault(key, []).append(index)
    for indices in counts.values():
        if len(indices) >= 2:
            out.update(indices)
    return out


def _content(raw: str) -> str:
    headers = running_header_lines(raw)
    return "\n".join(line for index, line in enumerate(raw.splitlines()) if index not in headers)


def _raw_words(raw: str) -> list[str]:
    text = _RAW_BREAK.sub(" ", text_clean.normalise_chars(_content(raw)))
    return [w for w in _WORD.findall(text) if len(w) >= 6]


def raw_word_types(raw: str) -> set[str]:
    """Word types of 6+ letters in the raw text, furniture lines left out
    (running_header_lines) and wrap-hyphen fragments taken out
    ("Aufbewah-" / "rung", "Wert-" / "papiere"). A word only ever printed
    across a break is therefore not counted at all: the raw alone cannot
    tell "Wert-" + "papiere" from "Wert-" + the marginal column's "rung" in
    the marginal layout, so a naive line-end join would invent words the
    clean text rightly lacks."""
    return set(_raw_words(raw))


# A footnote head in the raw: number at column 0 in the four-character number
# column ("13    Eingefügt", "100 Fassung", "3        Accepté"), text opening
# with a letter, a quote or a bracket.
_RAW_NOTE = re.compile(r"^(\d{1,2}(?=\s{2,})|\d{3}(?=\s))\s+([^\W\d_][^\W_]*|[«»„\"'(\[]\S*)")
_RAW_NOTE_STEP = 5


def raw_footnotes(raw: str) -> list[tuple[int, str]]:
    """(number, first word) of every footnote head in the raw, page by page
    in reading order: a _RAW_NOTE line after a blank line, a publication line
    or another footnote's line, whose number continues the sequence (above
    the last one, at most _RAW_NOTE_STEP above it). Independent of the
    splitter's own strips -- this is what the clean text is checked
    against."""
    lines = text_clean.normalise_chars(raw).splitlines()
    furniture = running_header_lines(raw)
    out: list[tuple[int, str]] = []
    last, in_block = 0, False
    for index, line in enumerate(lines):
        if index in furniture:
            continue
        m = _RAW_NOTE.match(line)
        prev = lines[index - 1] if index else ""
        if m and (not prev.strip() or in_block or fedlex_split._PUBLICATION.match(prev)):
            number = int(m.group(1))
            if last < number <= last + _RAW_NOTE_STEP:
                out.append((number, m.group(2)))
                last, in_block = number, True
                continue
        # a footnote's continuation line keeps the block open
        in_block = in_block and line.startswith(" ") and bool(line.strip())
    return out


def _tail_count(word: str, clean_counts: Counter) -> int:
    """Occurrences of ``word`` as the end of a longer clean word."""
    return sum(n for token, n in clean_counts.items()
               if len(token) > len(word) and token.endswith(word))


def measure(raw: str, clean: str) -> dict:
    words = _raw_words(raw)
    raw_types = set(words)
    clean_words = _WORD.findall(clean)
    all_counts = Counter(clean_words)
    clean_types = set(all_counts)
    # a type that survives as the END of a longer clean word is not lost: the tail
    # of a break the raw cannot see ("Wert-" / margin line / "papiere")
    # comes back as "Wertpapiere"
    missing = sorted(w for w in raw_types - clean_types if not _tail_count(w, all_counts))
    # the same by count: a repeated phrase lost once (a footnote head glued
    # away, one of two identical table rows) leaves the type in place
    raw_counts = Counter(words)
    clean_counts = Counter({w: n for w, n in all_counts.items() if len(w) >= 6})
    short = {w: n - clean_counts.get(w, 0) for w, n in raw_counts.items() if n > clean_counts.get(w, 0)}
    lost_tokens = sum(max(0, deficit - _tail_count(w, all_counts)) for w, deficit in short.items())
    notes = raw_footnotes(raw)
    starts = set(re.findall(r"(?:^|\n\n)(\d{1,3} \S+)", clean))
    notes_missing = [n for n, first in notes
                     if not any(s.startswith(f"{n} {first}") for s in starts)]
    collapsed = " ".join(raw.split())
    content = " ".join(_content(raw).split())
    nwords = max(1, len(clean.split()))
    breaks = len(_CLEAN_BREAK.findall(clean))
    glued = len(_GLUED_REF.findall(clean))
    return {
        "word_loss": len(missing) / len(raw_types) if raw_types else 0.0,
        "missing": missing,
        "token_loss": lost_tokens / len(words) if words else 0.0,
        "footnotes": len(notes),
        "footnote_miss": len(notes_missing) / len(notes) if notes else 0.0,
        "footnotes_missing": notes_missing[:20],
        "length_ratio": len(clean) / len(collapsed) if collapsed else 0.0,
        "content_ratio": len(clean) / len(content) if content else 1.0,
        "hyphen_breaks": breaks * 10000 / nwords,
        "glued_refs": glued * 10000 / nwords,
        "hyphen_examples": [m.group(0) for m in _CLEAN_BREAK.finditer(clean)][:5],
    }


def measure_raw(raw: str, lang: str | None) -> dict:
    _, clean = fedlex_split.split_fedlex_text(raw, lang)
    return measure(raw, clean)


def _pct(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(round(q * (len(ordered) - 1)))))]


_METRICS = ("word_loss", "token_loss", "footnote_miss", "length_ratio", "content_ratio",
            "hyphen_breaks", "glued_refs")


def summarise(results: dict[int, dict]) -> dict:
    out: dict = {"n": len(results)}
    if not results:
        return out
    for key in _METRICS:
        values = [r.get(key, 0.0) for r in results.values()]
        out[key] = {"median": statistics.median(values), "p5": _pct(values, 0.05),
                    "p95": _pct(values, 0.95), "max": max(values), "min": min(values)}
    out["hyphen_share"] = sum(1 for r in results.values() if r["hyphen_breaks"]) / len(results)
    out["glued_share"] = sum(1 for r in results.values() if r["glued_refs"]) / len(results)
    out["worst"] = sorted(results, key=lambda v: (results[v]["word_loss"],
                                                  results[v].get("token_loss", 0.0)),
                          reverse=True)[:5]
    out["below_floor"] = sorted(v for v, r in results.items()
                                if r.get("content_ratio", 1.0) < CONTENT_RATIO_FLOOR)
    return out


def gate_ok(summary: dict) -> bool:
    return (summary.get("n", 0) > 0
            and summary["word_loss"]["median"] <= WORD_LOSS_MAX
            and summary["word_loss"]["p95"] <= WORD_LOSS_P95_MAX
            and summary["token_loss"]["p95"] <= TOKEN_LOSS_P95_MAX
            and summary["footnote_miss"]["p95"] <= FOOTNOTE_MISS_P95_MAX
            and summary["length_ratio"]["median"] >= LENGTH_RATIO_MIN
            and summary["content_ratio"]["p5"] >= CONTENT_RATIO_FLOOR)


def _print(summary: dict, results: dict[int, dict]) -> None:
    print(f"versions measured: {summary['n']}")
    if not summary["n"]:
        return
    for key in _METRICS:
        s = summary[key]
        print(f"{key:14s} median {s['median']:.4f}  p5 {s['p5']:.4f}  p95 {s['p95']:.4f}  "
              f"max {s['max']:.4f}  min {s['min']:.4f}")
    print(f"hyphen_share   {summary['hyphen_share']:.3f} (versions with >=1 wrap hyphen left)")
    print(f"glued_share    {summary['glued_share']:.3f} (versions with >=1 glued footnote ref)")
    print(f"below content floor {CONTENT_RATIO_FLOOR}: {len(summary['below_floor'])} "
          f"{summary['below_floor'][:20]}")
    print("worst by word_loss, token_loss:")
    for vid in summary["worst"]:
        r = results[vid]
        print(f"  {vid}  loss {r['word_loss']:.4f}  tokens {r['token_loss']:.4f}  "
              f"notes {r['footnote_miss']:.3f}/{r['footnotes']}  ratio {r['content_ratio']:.3f}  "
              f"missing e.g. {r['missing'][:8]}  notes e.g. {r['footnotes_missing'][:8]}")


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
    order = parser.add_mutually_exclusive_group()
    order.add_argument("--random", dest="random", action="store_true", default=True,
                       help="a random sample (the default)")
    order.add_argument("--ordered", dest="random", action="store_false",
                       help="the first N by version_id instead")
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
