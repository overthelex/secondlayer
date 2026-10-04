"""Measurement 1: did practice come first, or the text?

For every proposition that the record supports (label supported or
fragment), the earliest decision that applies it -- fully or in part -- is
set against the date of the version that first stated it. Spec 4.4:

    codification   a supporting decision is dated before that version
    announcement   support appears only after it; the lag is reported
    ungrounded     no supporting decision in the passages read

A proposition is tracked across versions (propositions.align): a reworded
proposition keeps its first date; a new one starts its own. The
Bekanntmachung (2002, 2007, 2010, 2017, 2022) and the Erläuterungen (2019,
2022) are two chains.

"Before" uses the decision's date_upper_bound: a journal decision known only
by its issue counts as earlier only when its whole window is, so the
measurement never borrows a later decision (no look-ahead, spec 5.7).

Step 1 reads the passages already labelled in the full run. Its
"announcement" is provisional: the eight passages read for a proposition
come from the whole record, and an earlier supporting decision may sit
outside them. Step 2 (--before-packet) builds, for exactly those
propositions, a packet restricted to decisions before the first date; the
judges then read it under the same protocol.

    python3 measure1.py --dsn ... --out /data/ch-corpus/weko-bek/measure1_step1.json
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys
from datetime import date

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from propositions import SOURCES, align, align_global, parse, read_text  # noqa: E402

DIR = pathlib.Path("/data/ch-corpus/weko-bek")
REPO = HERE.parents[1]
CHAINS = {
    "Bekanntmachung": ["2002-02-18", "2007-07-02", "2010-06-28", "2017-05-22", "2022-12-12"],
    "Erläuterungen": ["2019-04-09", "2022-12-12-erl"],
}
SUPPORTING = {"applies", "partial"}
# The date a version was first published, where it differs from the text we
# hold: the Erläuterungen were issued on 12 June 2017; the text in the
# corpus is their Stand of 9 April 2018. (The version key "2019-04-09" is a
# misnomer from the first download, kept because every artifact is keyed by it.) Dating the chain by the Stand let
# decisions of 2017-2018 count as earlier than the text (3 of 14 codifications).
FIRST_PUBLISHED = {"2019-04-09": date(2017, 6, 12)}


def first_date(version: str) -> date:
    return FIRST_PUBLISHED.get(version, date.fromisoformat(version[:10]))


def full_key(version: str, pid: str, part: str) -> tuple[str, str]:
    return version, ("E" + pid if part == "preamble" and pid.isdigit() else pid)


def tracks_from_links(path: pathlib.Path) -> dict[tuple[str, str], list[dict]]:
    """Chains from the verified links (build_links.py), one per rule.

    A chain starts at a proposition no link leads into and takes everything
    reachable from it forward. Two rules that a later version folds into one
    proposition keep two chains that share that proposition: taking the
    connected component instead joined them, and a rule with no support of
    its own (2002 Ziff. 3(c), sales to end users in a selective system) was
    classed by the support of its neighbour (Ziff. 3(d), cross-supplies),
    because the 2022 notice lists both in Art. 15(c). A proposition can
    therefore belong to more than one chain."""
    data = json.loads(path.read_text())
    nodes: dict[tuple[str, str], str] = {}
    for chain, versions in CHAINS.items():
        for v in versions:
            for p in parse(read_text(DIR / SOURCES[v][0], SOURCES[v][1]), v):
                if len(p.text) > 40:
                    nodes[full_key(v, p.pid, p.part)] = chain
    forward: dict = collections.defaultdict(list)
    has_in: set = set()
    rel: dict[tuple[str, str], str] = {}
    for l in data["links"]:
        a, b = tuple(l["a"]), tuple(l["b"])
        if a in nodes and b in nodes:
            forward[a].append(b)
            has_in.add(b)
            rel[b] = l["relation"]
    out: dict[tuple[str, str], list[dict]] = collections.defaultdict(list)
    sources = sorted((k for k in nodes if k not in has_in), key=lambda k: (CHAINS[nodes[k]].index(k[0]), k))
    for n, src in enumerate(sources):
        chain = nodes[src]
        members, stack = {src}, [src]
        while stack:
            for b in forward[stack.pop()]:
                if b not in members:
                    members.add(b)
                    stack.append(b)
        for k in members:
            out[k].append({"track": f"{chain}:{n}", "first_version": src[0], "first_date": first_date(src[0]),
                           "status": "added" if k == src else rel.get(k, "added"),
                           "cosine": None, "merged_into": None, "members": len(members)})
    return out


def tracks(tei: str | None = None) -> dict[tuple[str, str], dict]:
    """(version, pid) -> {track, first_version, first_date, status}.

    With `tei`, the chains come from align_global (word ratio or bge-m3
    cosine, global assignment): the greedy word-only align() broke chains of
    reworded rules (PAPER-239)."""
    out = {}
    for chain, versions in CHAINS.items():
        by_version = {v: [p for p in parse(read_text(DIR / SOURCES[v][0], SOURCES[v][1]), v)
                          if len(p.text) > 40] for v in versions}
        if tei:
            from retrieve import embed
            texts = sorted({p.text for ps in by_version.values() for p in ps})
            vectors = dict(zip(texts, embed(texts, tei, {})))
            aligned = align_global(by_version, versions, vectors)
        else:
            aligned = align(by_version, versions)
        for n, t in enumerate(aligned):
            first = min(t.per_version, key=versions.index)
            for v, d in t.per_version.items():
                out[full_key(v, d["pid"], t.part)] = {
                    "track": f"{chain}:{n}", "first_version": first,
                    "first_date": first_date(first), "status": d["status"],
                    "cosine": d.get("cosine"), "merged_into": d.get("merged_into")}
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--labels", type=pathlib.Path, default=REPO / "data/weko-vertbek/labels_full_2026-10-03.json")
    ap.add_argument("--claude", type=pathlib.Path, default=REPO / "data/weko-vertbek/judges-full/claude-opus.jsonl")
    ap.add_argument("--gemini", type=pathlib.Path, default=REPO / "data/weko-vertbek/judges-full/gemini-3.1-pro.jsonl")
    ap.add_argument("--typology", type=pathlib.Path, default=REPO / "data/weko-vertbek/typology_v3.json",
                    help="what each proposition does; only a norm can be codified or announced")
    ap.add_argument("--tei", default=None, help="bge-m3 endpoint: chains by align_global (default: greedy align)")
    ap.add_argument("--links", type=pathlib.Path, default=None,
                    help="verified links (build_links.py): chains are their connected components")
    ap.add_argument("--out", type=pathlib.Path, default=DIR / "measure1_step1.json")
    args = ap.parse_args()

    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    dates = {r["ecli"]: r for r in conn.execute(
        "SELECT ecli, spider, date_exact, date_upper_bound FROM ch_weko_audit_corpus").fetchall()}

    labels = {(r["version"], r["pid"]): r for r in json.loads(args.labels.read_text())["labels"]}
    types = {(r["version"], r["pid"]): r["type"] for r in json.loads(args.typology.read_text())["types"]}
    passages = {}
    for path, who in ((args.claude, "claude"), (args.gemini, "gemini")):
        for line in path.read_text().splitlines():
            r = json.loads(line)
            passages.setdefault((r["version"], r["pid"]), {})[who] = r["passages"]

    tr = tracks_from_links(args.links) if args.links else {k: [v] for k, v in tracks(args.tei).items()}
    missing = [k for k in labels if k not in tr]
    print(f"propositions {len(labels)}, tracked {len(labels) - len(missing)}, untracked {missing[:5]}")

    def supporting(key, row) -> list[str]:
        """The decisions that carry this proposition's label: the reader's
        marks where the reader labelled it, else the passages the judge whose
        label stands (Claude) found to apply it fully or in part."""
        if row["source"] != "judges":
            return list(row.get("evidence_marked") or [])
        return [p["ecli"] for p in passages.get(key, {}).get("claude", []) if p["label"] in SUPPORTING]

    # track -> earliest supporting decision over all its versions
    by_track: dict[str, dict] = {}
    for key, row in labels.items():
        for t in tr.get(key, []):
            rec = by_track.setdefault(t["track"], {"first_version": t["first_version"], "first_date": t["first_date"],
                                                   "versions": {}, "support": [], "labels": set(), "split": {}})
            entry = {"pid": key[1], "label": row["label"], "source": row["source"],
                     "status": t["status"], "type": types.get(key), "cosine": t.get("cosine"),
                     "merged_into": t.get("merged_into")}
            if key[0] in rec["versions"] and key[0] != t["first_version"]:
                rec["split"].setdefault(key[0], []).append(entry)      # a rule split in this version
            else:
                rec["versions"][key[0]] = entry
            rec["labels"].add(row["label"])
            if row["label"] in ("supported", "fragment"):
                for e in supporting(key, row):
                    d = dates.get(e)
                    if d:
                        rec["support"].append({"ecli": e, "spider": d["spider"], "via": key[0],
                                               "date": str(d["date_exact"] or ""),
                                               "bound": str(d["date_upper_bound"] or "")})

    result = collections.Counter()
    rows = []
    for tid, rec in by_track.items():
        labels_seen = rec["labels"]
        best = "supported" if "supported" in labels_seen else "fragment" if "fragment" in labels_seen else None
        first = rec["first_date"]
        before = [s for s in rec["support"] if s["bound"] and date.fromisoformat(s["bound"]) < first]
        after = [s for s in rec["support"] if s not in before]
        if best is None or not rec["support"]:
            cls = "ungrounded"
        elif before:
            cls = "codification"
        else:
            cls = "announcement?"          # provisional until step 2
        lag = None
        if cls == "announcement?":
            known = [date.fromisoformat(s["date"] or s["bound"]) for s in after if s["date"] or s["bound"]]
            lag = round((min(known) - first).days / 365.25, 1) if known else None
        # a track is typed by the version that first stated it
        kind = rec["versions"][rec["first_version"]]["type"]
        if kind == "norm":
            result[(rec["first_version"], cls)] += 1
        rows.append({"track": tid, "first_version": rec["first_version"], "first_date": str(first),
                     "type": kind, "best_label": best, "class": cls,
                     "lag_years": lag, "versions": rec["versions"], "split": rec["split"],
                     "earliest_support": min((s["date"] or s["bound"] for s in rec["support"]), default=None),
                     "support": sorted(rec["support"], key=lambda s: s["date"] or s["bound"])})

    args.out.write_text(json.dumps(rows, ensure_ascii=False, indent=1, default=str))
    print(f"{len(rows)} tracked propositions -> {args.out}")
    versions = [v for vs in CHAINS.values() for v in vs]
    print("norms only:")
    print(f"{'first stated in':18} {'codification':>13} {'announcement?':>14} {'ungrounded':>11}")
    for v in versions:
        print(f"{v:18} {result[(v, 'codification')]:13} {result[(v, 'announcement?')]:14} {result[(v, 'ungrounded')]:11}")
    print("norms", dict(collections.Counter(r["class"] for r in rows if r["type"] == "norm")))
    print("by type", dict(collections.Counter((r["type"], r["class"]) for r in rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
