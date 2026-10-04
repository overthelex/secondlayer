"""Every number the VertBek paper states, recomputed from the artifacts.

Spec, control 10: no figure is carried over from notes. Run this, and the
paper's numbers come from figures.json and nowhere else.

    python3 paper_figures.py --dsn ... --out data/weko-vertbek/figures.json
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import re
import statistics
import sys
from datetime import date

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from propositions import SOURCES, parse, read_text  # noqa: E402

REPO = HERE.parents[1]
DATA = REPO / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")
ORDER = ["2002-02-18", "2007-07-02", "2010-06-28", "2017-05-22", "2022-12-12", "2019-04-09", "2022-12-12-erl"]
CITE = re.compile(r"\bBGE\s+\d{2,3}\s+[IV]+[ab]?\s+\d+|\b\d[A-Z][_.]\d{1,4}/\d{4}|\bB-\d{1,4}/\d{4}|\bRPW\s+\d{4}/\d")


def kappa(pairs):
    po = sum(a == b for a, b in pairs) / len(pairs)
    ca = collections.Counter(a for a, _ in pairs)
    cb = collections.Counter(b for _, b in pairs)
    pe = sum(ca[x] * cb[x] for x in set(ca) | set(cb)) / len(pairs) ** 2
    return round(po, 3), round((po - pe) / (1 - pe), 3)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--out", type=pathlib.Path, default=DATA / "figures.json")
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    F: dict = {}

    # --- the record
    rows = conn.execute("SELECT spider, docket_number, rpw_chapter, date_exact, date_upper_bound, date_source "
                        "FROM ch_weko_audit_corpus").fetchall()
    rec = [r for r in rows if r["rpw_chapter"] != "D1"]
    tier = lambda s: ("agency" if s in ("CH_WEKO", "CH_WEKO_RPW") else
                      "federal_courts" if s in ("CH_BGE", "CH_BGer", "CH_BVGer", "CH_BSTG") else
                      "cantonal" if re.fullmatch(r"[A-Z]{2}_.+", s) and not s.startswith("CH_") else "other")
    years = [ (r["date_exact"] or r["date_upper_bound"]).year for r in rec if (r["date_exact"] or r["date_upper_bound"])]
    F["record"] = {
        "decisions": len(rec),
        "by_tier": dict(collections.Counter(tier(r["spider"]) for r in rec)),
        "by_spider_top": dict(collections.Counter(r["spider"] for r in rec).most_common(8)),
        "journal_items": sum(r["spider"] == "CH_WEKO_RPW" for r in rec),
        "entscheidsuche_weko": sum(r["spider"] == "CH_WEKO" for r in rec),
        "date_sources": dict(collections.Counter(r["date_source"] for r in rec)),
        "years": [min(years), max(years)],
        # one judgment can sit in several sources and languages; packet.families
        # collapses them for reading, this is the count the paper states
        "distinct_docket_date": len({((r["docket_number"] or "").strip().lower(),
                                      r["date_exact"] or r["date_upper_bound"]) for r in rec}),
        "before_kg1995_docs": sum(1 for r in rec if (r["date_exact"] or r["date_upper_bound"])
                                  and (r["date_exact"] or r["date_upper_bound"]).year < 1996),
        "notices_excluded": conn.execute("SELECT count(*) n FROM ch_weko_audit_corpus "
                                         "WHERE rpw_chapter = 'D1'").fetchone()["n"],
        "rpw_date_source": dict(collections.Counter(r["date_source"] for r in rec if r["spider"] == "CH_WEKO_RPW")),
        "passages_v1": conn.execute("SELECT count(*) n FROM ch_weko_audit_passages").fetchone()["n"],
        "passages_v2": conn.execute("SELECT count(*) n FROM ch_weko_audit_passages_v2").fetchone()["n"],
    }
    recut = json.loads((DIR / "recut_rpw.json").read_text())
    F["recut"] = {"decisions": len(recut), "reading_order": sum(x["used"] == "reading" for x in recut),
                  "coverage_median": statistics.median(x["coverage"] for x in recut)}

    # --- the instrument: propositions and the citations it carries (footnotes included)
    inst = {}
    for v in ORDER:
        name, journal = SOURCES[v]
        text = read_text(DIR / name, journal)
        props = [p for p in parse(text, v) if len(p.text) > 40]
        with_notes = parse(text, v, keep_notes=True)
        cites = sum(len(CITE.findall(p.text)) for p in with_notes)
        inst[v] = {"propositions": len(props), "case_citations_incl_footnotes": cites}
    F["instrument"] = inst

    # --- labels of the full run
    # v3: after the parser fix of 2026-10-03 (PAPER-232); the first full run
    # (labels_full_2026-10-03.json) is kept for the statistics of that run
    labels = json.loads((DATA / "labels_full_v3.json").read_text())["labels"]
    labels_run1 = json.loads((DATA / "labels_full_2026-10-03.json").read_text())["labels"]
    typ = json.loads((DATA / "typology_v3.json").read_text())["types"]
    F["typology"] = {"n": len(typ), "types": dict(collections.Counter(t["type"] for t in typ)),
                     "agreed": sum(t["source"] == "judges" for t in typ),
                     "by_version": {v: dict(collections.Counter(t["type"] for t in typ if t["version"] == v)) for v in ORDER}}
    F["labels"] = {
        "n": len(labels),
        "distribution": dict(collections.Counter(r["label"] for r in labels)),
        "source": dict(collections.Counter(r["source"] for r in labels)),
        "by_version": {v: dict(collections.Counter(r["label"] for r in labels if r["version"] == v)) for v in ORDER},
    }

    # --- gold set and the judges
    gold = json.loads((HERE / "gold_set_2026-10-02.json").read_text())["labels"]
    dev = {(r["version"], r["pid"]) for r in json.loads((HERE / "human_labels_2026-10-02.json").read_text())["labels"]}
    H = {(r["version"], r["pid"]): r["label"] for r in gold}
    F["gold"] = {"n": len(gold), "development": len(dev), "test": len(gold) - len(dev),
                 "distribution": dict(collections.Counter(H.values()))}
    J = {}
    for n in ("claude-opus", "gemini-3.1-pro", "deepseek-v4-pro"):
        p = DIR / "judges" / f"{n}.jsonl"
        J[n] = {(json.loads(l)["version"], json.loads(l)["pid"]): json.loads(l)["label"] for l in p.read_text().splitlines()}
    test = [k for k in H if k not in dev]
    F["judges_v2_test"] = {n: {"agreement_kappa": kappa([(J[n][k], H[k]) for k in test]),
                               "supported_or_not": sum((J[n][k] == "supported") == (H[k] == "supported") for k in test)}
                           for n in J}
    pre = [k for k in test if (J["claude-opus"][k] == "supported") == (J["gemini-3.1-pro"][k] == "supported")]
    F["rule_binary_check_test"] = {"covered": len(pre), "of": len(test),
                                   "four_way_right": sum(J["claude-opus"][k] == H[k] for k in pre),
                                   "supported_or_not_right": sum((J["claude-opus"][k] == "supported") == (H[k] == "supported") for k in pre)}

    # --- disputes of the full run
    rev = json.loads((DATA / "review_full.json").read_text())
    dis = [r for r in rev if r["status"] == "disputed"]
    lab = {(r["version"], r["pid"]): r["label"] for r in labels_run1}
    F["full_run"] = {"items": len(rev), "status": dict(collections.Counter(r["status"] for r in rev)),
                     "disputed_reader_with_claude": sum(lab[(r["version"], r["pid"])] == r["judges"]["claude-opus"] for r in dis),
                     "disputed_pairs": {f"{a}|{b}": n for (a, b), n in collections.Counter(
                         (r["judges"]["claude-opus"], r["judges"]["gemini-3.1-pro"]) for r in dis).items()},
                     "disputed_reader_with_gemini": sum(lab[(r["version"], r["pid"])] == r["judges"]["gemini-3.1-pro"] for r in dis),
                     "controls": {r["pid"]: r["judges"] for r in rev if r["status"] == "control"}}

    # --- measurement 1
    # v5: chains from the verified links between versions (PAPER-239, links_v4.json)
    m1_all = json.loads((DATA / "measure1_final_v9.json").read_text())
    links = json.loads((DATA / "links_v4.json").read_text())["links"]
    # only a norm can be codified or announced (typology_v3.json)
    m1 = [f for f in m1_all if f["type"] == "norm"]
    F["measure1_all"] = {"tracks": len(m1_all), "norms": len(m1),
                         "by_type": {f"{a}|{b}": n for (a, b), n in collections.Counter(
                             (f["type"], f["final_class"]) for f in m1_all).items()}}
    tab = {}
    for v in ORDER:
        rs = [f for f in m1 if f["first_version"] == v]
        lags = [f["lag_years"] for f in rs if f["final_class"] == "announcement" and f["lag_years"] is not None]
        tab[v] = dict(collections.Counter(f["final_class"] for f in rs)) | {
            "lag_median": statistics.median(lags) if lags else None}
    lags = [f["lag_years"] for f in m1 if f["final_class"] == "announcement" and f["lag_years"] is not None]
    F["measure1"] = {"tracks": len(m1), "classes": dict(collections.Counter(f["final_class"] for f in m1)),
                     "decided_by": {f"{a}|{b}": n for (a, b), n in collections.Counter((f["final_class"], f["decided_by"]) for f in m1).items()},
                     "by_version": tab, "lag_median": statistics.median(lags),
                     "lag_quartiles": statistics.quantiles(lags, n=4)}

    # --- the citation-anchor test (anchors.py, anchors_final.py, PAPER-233)
    anc = json.loads((DATA / "anchors_final.json").read_text())
    cit = json.loads((DATA / "anchors_citations.json").read_text())
    court = lambda d: (d or "").startswith(("BGE", "B-")) or "_" in (d or "")
    full = ("holds", "states")
    F["anchors"] = {
        "pairs": len(anc), "results": dict(collections.Counter(a["result"] for a in anc)),
        "citations": len(cit), "resolved": sum(1 for c in cit if c["resolved"]),
        "footnotes": len({(c["version"], c["footnote"]) for c in cit}),
        "pinpoint": sum(a["pinpoint_found"] for a in anc),
        "by_edition": {v: {"n": sum(a["version"] == v for a in anc),
                           "full": sum(a["version"] == v and a["result"] in full for a in anc)}
                       for v in ("2019-04-09", "2022-12-12-erl")},
        "court_n": sum(court(a["cited"]) for a in anc),
        "court_fragment": sum(court(a["cited"]) and a["result"] == "fragment" for a in anc),
        "by_reader": sum(a["decided_by"].startswith("reader") for a in anc),
    }

    # --- the exhaustive search (exhaustive.py, PAPER-234)
    ex = json.loads((DATA / "exhaustive_result.json").read_text())
    plan = json.loads((DIR / "exhaustive_plan.json").read_text())
    F["exhaustive"] = {
        "rules": len(ex), "per_rule": max(len(p["candidates"]) for p in plan),
        "ext_candidates": sum(c["ext"] for p in plan for c in p["candidates"]),
        "moves": {f"{a}|{b}": n for (a, b), n in collections.Counter((x["old_class"], x["class"]) for x in ex).items()},
        "ann_kept": sum(1 for x in ex if x["old_class"] == "announcement" and x["class"] == "announcement"),
        "ann_in": sum(1 for x in ex if x["old_class"] == "announcement"),
        "ungr_in": sum(1 for x in ex if x["old_class"] == "ungrounded"),
        "ungr_to_cod": sum(1 for x in ex if x["old_class"] == "ungrounded" and x["class"] == "codification"),
        "ungr_to_ann": sum(1 for x in ex if x["old_class"] == "ungrounded" and x["class"] == "announcement"),
        "ungr_left": sum(1 for x in ex if x["old_class"] == "ungrounded" and x["class"] == "ungrounded"),
        "lag_before": statistics.median([x["old_lag"] for x in ex if x["old_class"] == "announcement" and x["old_lag"] is not None]),
        "ext_decisions": 14,
    }
    early = []
    for f in m1:
        if f["first_version"] in ("2002-02-18", "2007-07-02") and f["final_class"] == "announcement":
            exh = f.get("exhaustive") or {}
            e = exh.get("earliest") or min((sp["date"] or sp["bound"]) for sp in f["support"])
            early.append(int(e[:4]))
    F["early_applications"] = {"n": len(early), "2008_2012": sum(2008 <= y <= 2012 for y in early)}
    erl = [f for f in m1 if f["first_version"] in ("2019-04-09", "2022-12-12-erl")]
    F["erl"] = {"norms": len(erl), **collections.Counter(f["final_class"] for f in erl)}

    # --- uptake: decisions citing the notice per year (uptake.py, PAPER-241)
    up = json.loads((DATA / "uptake.json").read_text())["years"]
    cite = {u["year"]: u for u in up}
    F["uptake"] = {
        "total": sum(u["citing"] for u in up),
        "first_year": min(u["year"] for u in up if u["citing"]),
        "to_2010": sum(u["citing"] for u in up if u["year"] <= 2010),
        "since_2011": sum(u["citing"] for u in up if u["year"] >= 2011),
        "max_to_2010": max(u["citing"] for u in up if u["year"] <= 2010),
        "courts": sum(u["citing_by_tier"].get("federal_court", 0) + u["citing_by_tier"].get("cantonal", 0) for u in up),
        "first_court_year": min(u["year"] for u in up if u["citing_by_tier"].get("federal_court") or u["citing_by_tier"].get("cantonal")),
        "federal_peak": max(up, key=lambda u: u["citing_by_tier"].get("federal_court", 0))["year"],
    }

    # --- what happens to a norm in the later versions (PAPER-239)
    chains = [["2002-02-18", "2007-07-02", "2010-06-28", "2017-05-22", "2022-12-12"], ["2019-04-09", "2022-12-12-erl"]]
    modified = {tuple(l["b"]) for l in links if l["relation"] == "modified"}

    def fate(f):
        chain = next(c for c in chains if f["first_version"] in c)
        if max(f["versions"], key=chain.index) != chain[-1]:
            return "dropped"
        return "modified" if any((v, d["pid"]) in modified for v, d in f["versions"].items()) else "kept"
    F["fates"] = {cls: dict(collections.Counter(fate(f) for f in m1 if f["final_class"] == cls))
                  for cls in ("codification", "announcement", "ungrounded")}
    F["links"] = {"n": len(links), "relations": dict(collections.Counter(l["relation"] for l in links))}

    # --- provenance and its cross with measurement 1
    prov = json.loads((DATA / "provenance_v3.json").read_text())
    pc, pcf = {}, {}
    for p in prov["propositions"]:
        pid = "E" + p["pid"] if p["part"] == "preamble" and p["pid"].isdigit() else p["pid"]
        pc[(p["version"], pid)] = p["class"]
        pcf[(p["version"], pid)] = p
    F["provenance"] = {"n": len(prov["propositions"]), "null_p99": prov["method"]["null_p99"],
                       "by_version": {v: dict(collections.Counter(p["class"] for p in prov["propositions"] if p["version"] == v)) for v in ORDER}}
    cross = collections.Counter()
    for f in m1:
        v = f["first_version"]
        c = pc.get((v, f["versions"][v]["pid"]))
        if c:
            cross[f"{c}|{f['final_class']}"] += 1
    F["cross"] = dict(cross)
    # EU wording over time: chains that start in it, and chains that take it later
    later = collections.Counter()
    for f in m1:
        v0 = f["first_version"]
        first_imp = pc.get((v0, f["versions"][v0]["pid"])) == "imported"
        later_imp = any(pc.get((v, d["pid"])) == "imported" for v, d in f["versions"].items() if v != v0)
        if later_imp and not first_imp:
            later[f["final_class"]] += 1
    F["eu_later"] = dict(later)
    F["imported_first_versions"] = dict(collections.Counter(
        f["first_version"] for f in m1 if pc.get((f["first_version"], f["versions"][f["first_version"]]["pid"])) == "imported"))

    # --- survival: time from first statement to first application (PAPER-238)
    # Every norm not a codification at its first statement: an announcement is
    # an event at its lag, an ungrounded norm is censored at the end of the
    # record. Codifications have their event before t0 and are left out.
    end = date(2026, 6, 30)
    surv = []
    for f in m1:
        if f["final_class"] == "announcement" and f["lag_years"] is not None:
            surv.append((f, float(f["lag_years"]), 1))
        elif f["final_class"] == "ungrounded":
            surv.append((f, round((end - date.fromisoformat(f["first_date"])).days / 365.25, 1), 0))
    rows_all = [(t, e) for _, t, e in surv]
    curve = kaplan_meier(rows_all)
    med, med_lo, med_hi = km_median(curve)
    at = lambda c, y: next((s for t, s, _, _ in reversed(c) if t <= y), 1.0)
    prov_of = lambda f: pc.get((f["first_version"], f["versions"][f["first_version"]]["pid"]))
    own = [(t, e) for f, t, e in surv if prov_of(f) == "own"]
    other = [(t, e) for f, t, e in surv if prov_of(f) in ("mixed", "imported")]
    F["survival"] = {"n": len(surv), "events": sum(e for _, e in rows_all), "censored": sum(1 - e for _, e in rows_all),
                     "median": med, "median_ci": [med_lo, med_hi],
                     "applied_by_5": round(1 - at(curve, 5), 3), "applied_by_10": round(1 - at(curve, 10), 3),
                     "own_n": len(own), "other_n": len(other),
                     "own_median": km_median(kaplan_meier(own))[0] if own else None,
                     "other_median": km_median(kaplan_meier(other))[0] if other else None,
                     "logrank_own_vs_other": round(logrank(own, other), 3) if own and other else None,
                     "censored_short": sum(1 for _, t, e in surv if not e and t < 5)}
    import csv as _csv
    with open(args.out.with_name("survival.csv"), "w", newline="") as fh:
        w = _csv.writer(fh)
        w.writerow(["track", "first_version", "provenance", "years", "event"])
        for f, t, e in surv:
            w.writerow([f["track"], f["first_version"], prov_of(f) or "", t, e])

    # --- text lag: earliest application to the version that states the rule (textlag.py, PAPER-240)
    tl = json.loads((DATA / "text_lag.json").read_text())
    tb = {r["track"]: r for r in json.loads((DATA / "text_lag_base.json").read_text())}
    lags = [r["lag_years"] for r in tl]
    moved = [r for r in tl if r["how"].startswith("search")]
    F["text_lag"] = {
        "n": len(tl), "median": statistics.median(lags), "quartiles": statistics.quantiles(lags, n=4),
        "base_median": statistics.median(r["lag_years"] for r in tb.values()),
        "moved": len(moved), "moved_by_reader": sum("(reader)" in r["how"] for r in moved),
        "max_shift": max(round(r["lag_years"] - tb[r["track"]]["lag_years"], 1) for r in moved),
        "over_five": sum(x > 5 for x in lags), "over_ten": sum(x > 10 for x in lags),
        "earliest_year": min(int(r["earliest"][:4]) for r in tl),
    }
    ca = json.loads((DATA / "cited_age.json").read_text())
    F["cited_age"] = {v: {"n": len(xs), "median": statistics.median(xs)} for v in ("2019-04-09", "2022-12-12-erl")
                      for xs in [[r["age_years"] for r in ca if r["version"] == v]]}

    # --- review 4 (PAPER-235): full application only, voice and statute, base rate
    st = json.loads((DATA / "strict.json").read_text())
    sc = collections.Counter((r["class"], r["strict_class"]) for r in st)
    F["strict"] = {f"{a}|{b}": n for (a, b), n in sc.items()}
    F["strict_lag_ann"] = statistics.median(r["full_lag_years"] for r in st
                                            if r["strict_class"] == "announcement" and r["full_lag_years"] is not None)
    F["strict_erl"] = dict(collections.Counter(r["strict_class"] for r in st if r["version"] in ("2019-04-09", "2022-12-12-erl")))
    vo = json.loads((DATA / "voice.json").read_text())
    F["voice"] = {"n": len(vo), **{f"voice_{k}": n for k, n in collections.Counter(r["voice"] for r in vo).items()},
                  **{f"statute_{k}": n for k, n in collections.Counter(r["statute"] for r in vo).items()},
                  "by_reader": sum(r["voice_by"] == "reader" or r["statute_by"] == "reader" for r in vo)}
    F["baserate"] = json.loads((DATA / "baserate.json").read_text())

    # --- how much of each wording the record applies, over all propositions
    # (supported or fragment in the full run), and the depth of the text-lag search
    lab3 = {(r["version"], r["pid"]): r["label"] for r in json.loads((DATA / "labels_full_v3.json").read_text())["labels"]}
    applied = collections.Counter((pc[k], lab3[k] in ("supported", "fragment")) for k in lab3 if k in pc)
    F["prov_applied"] = {c: {"n": applied[(c, True)] + applied[(c, False)], "not_applied": applied[(c, False)]}
                         for c in ("imported", "mixed", "own")}
    import textlag
    F["textlag_top"] = textlag.TOP

    # --- review 5 (PAPER-236): robustness
    rb = json.loads((DATA / "robustness.json").read_text())
    F["rules"] = rb["rules"]; F["bootstrap"] = rb["bootstrap"]
    pc = json.loads((DATA / "poolcheck.json").read_text())
    F["poolcheck"] = {k: pc[k] for k in ("packets_checked", "passages_200", "not_shown_at_100")}
    fs = json.loads((DATA / "frit_selection.json").read_text())
    fr = json.loads((DATA / "frit_rank.json").read_text())
    F["frit"] = {"found": fs["found"], "fr": fs["by_lang"].get("fr", 0), "it": fs["by_lang"].get("it", 0),
                 "vertical": fs["agreement_and_vertical"], "hand_found": fs["hand_picked_found"],
                 "hand": fs["hand_picked_ext"], "new": fr["decisions"],
                 "would_enter": len({h["ecli"] for h in fr["would_enter"]})}
    F["order"] = json.loads((DATA / "order-control" / "order_control.json").read_text())

    args.out.write_text(json.dumps(F, ensure_ascii=False, indent=1, default=str))
    args.out.with_suffix(".tex").write_text(macros(F))
    import csv
    with open(args.out.with_name("tracks.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["track", "first_version", "type", "final_class", "lag_years", "decided_by", "provenance", "containment"])
        for f in m1_all:
            v = f["first_version"]
            pr = pcf.get((v, f["versions"][v]["pid"]), {})
            w.writerow([f["track"], v, f["type"], f["final_class"], f["lag_years"] if f["lag_years"] is not None else "",
                        f["decided_by"], pr.get("class", ""), pr.get("containment", "")])
    with open(args.out.with_name("labels.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["version", "pid", "label", "source"])
        for r in labels:
            w.writerow([r["version"], r["pid"], r["label"], r["source"]])
    print(json.dumps(F, ensure_ascii=False, indent=1, default=str)[:6000])
    return 0



def kaplan_meier(rows: list[tuple[float, int]]) -> list[tuple[float, float, float, float]]:
    """(time, S(t), lower, upper) at each event time; Greenwood variance,
    log-log confidence interval (95%)."""
    import math
    out, s, var = [], 1.0, 0.0
    times = sorted({t for t, e in rows if e})
    for t in times:
        n = sum(1 for x, _ in rows if x >= t)
        d = sum(1 for x, e in rows if x == t and e)
        s *= 1 - d / n
        var += d / (n * (n - d)) if n > d else 0.0
        if 0 < s < 1:
            se = math.sqrt(var) / abs(math.log(s))
            lo, hi = s ** math.exp(1.96 * se), s ** math.exp(-1.96 * se)
        else:
            lo = hi = s
        out.append((t, s, lo, hi))
    return out


def km_median(curve) -> tuple:
    """The first time S(t) falls to 0.5 or below, with the times its 95% band does."""
    # as R's survfit: where S(t) is exactly 0.5 the median is midway to the next event
    med = None
    for i, (t, sv, lo, hi) in enumerate(curve):
        if abs(sv - 0.5) < 1e-12 and i + 1 < len(curve):
            med = (t + curve[i + 1][0]) / 2
            break
        if sv < 0.5:
            med = t
            break
    lo = next((t for t, s, l, h in curve if h <= 0.5), None)   # the upper band crosses last
    hi_t = next((t for t, s, l, h in curve if l <= 0.5), None)  # the lower band crosses first
    return med, hi_t, lo


def logrank(a: list[tuple[float, int]], b: list[tuple[float, int]]) -> float:
    """Two-group log-rank chi-square (1 df) -> p value."""
    import math
    times = sorted({t for t, e in a + b if e})
    o_minus_e, var = 0.0, 0.0
    for t in times:
        na = sum(1 for x, _ in a if x >= t); nb = sum(1 for x, _ in b if x >= t)
        da = sum(1 for x, e in a if x == t and e); db = sum(1 for x, e in b if x == t and e)
        n, d = na + nb, da + db
        if n < 2:
            continue
        o_minus_e += da - d * na / n
        var += d * (na / n) * (nb / n) * (n - d) / (n - 1)
    chi = o_minus_e ** 2 / var if var else 0.0
    return math.erfc(math.sqrt(chi / 2))


def macros(F: dict) -> str:
    """figures.json -> LaTeX macros, so the paper cannot drift from the data."""
    def num(x, digits=None):
        if isinstance(x, float):
            return f"{x:.{digits if digits is not None else 1}f}"
        return f"{x:,}".replace(",", "{,}")
    m, out = F["measure1"], {}
    rec = F["record"]
    out.update({
        "NDecisions": num(rec["decisions"]), "NDistinct": num(rec["distinct_docket_date"]), "NPreKG": num(rec["before_kg1995_docs"]), "NAgency": num(rec["by_tier"]["agency"]),
        "NJournal": num(rec["journal_items"]), "NEntscheidsuche": num(rec["entscheidsuche_weko"]),
        "NFederal": num(rec["by_tier"]["federal_courts"]), "NCantonal": num(rec["by_tier"]["cantonal"]),
        "NOther": num(rec["by_tier"]["other"]), "NPassages": num(rec["passages_v2"]),
        "YearFrom": str(rec["years"][0]), "YearTo": str(rec["years"][1]),
        "NRecutReading": num(F["recut"]["reading_order"]), "NRecut": num(F["recut"]["decisions"]),
        "NProps": num(F["labels"]["n"]),
        "NSupported": num(F["labels"]["distribution"]["supported"]),
        "NFragment": num(F["labels"]["distribution"]["fragment"]),
        "NRecites": num(F["labels"]["distribution"]["recites"]),
        "NAbsent": num(F["labels"]["distribution"]["absent"]),
        "NByJudges": num(F["labels"]["source"]["judges"]),
        "NByGold": num(F["labels"]["source"]["human_gold"]),
        "NByDisputed": num(F["labels"]["source"]["human_disputed"]),
        "NGold": num(F["gold"]["n"]), "NDev": num(F["gold"]["development"]), "NTest": num(F["gold"]["test"]),
        "NTracks": num(m["tracks"]), "NCodif": num(m["classes"].get("codification", 0)),
        "NAnnounce": num(m["classes"].get("announcement", 0)), "NUngrounded": num(m["classes"].get("ungrounded", 0)),
        "LagMedian": num(float(m["lag_median"])), "LagQone": num(float(m["lag_quartiles"][0])),
        "LagQthree": num(float(m["lag_quartiles"][2])),
        "DisputedClaude": num(F["full_run"]["disputed_reader_with_claude"]),
        "DisputedGemini": num(F["full_run"]["disputed_reader_with_gemini"]),
        "NDisputed": num(F["full_run"]["status"]["disputed"]),
        "RuleCovered": num(F["rule_binary_check_test"]["covered"]),
        "RuleFour": num(F["rule_binary_check_test"]["four_way_right"]),
        "RuleBin": num(F["rule_binary_check_test"]["supported_or_not_right"]),
        "ProvN": num(F["provenance"]["n"]), "ProvNull": f"{F['provenance']['null_p99']:.3f}",
    })
    for n, short in (("claude-opus", "Claude"), ("gemini-3.1-pro", "Gemini"), ("deepseek-v4-pro", "Deepseek")):
        a, k = F["judges_v2_test"][n]["agreement_kappa"]
        out[f"Acc{short}"] = f"{100 * a:.0f}"
        out[f"Kappa{short}"] = f"{k:.2f}"
        out[f"Bin{short}"] = num(F["judges_v2_test"][n]["supported_or_not"])
    names = {"2002-02-18": "\\de{Bekanntmachung} 2002", "2007-07-02": "\\de{Bekanntmachung} 2007",
             "2010-06-28": "\\de{Bekanntmachung} 2010", "2017-05-22": "\\de{Bekanntmachung} 2010, \\de{Stand} 2017",
             "2022-12-12": "\\de{Bekanntmachung} 2022", "2019-04-09": "\\de{Erläuterungen} 2017, \\de{Stand} 2018",
             "2022-12-12-erl": "\\de{Erläuterungen} 2022"}
    inst = "".join(f"{names[v]} & {x['propositions']} & {x['case_citations_incl_footnotes']} \\\\\n"
                   for v, x in F["instrument"].items())
    m1 = ""
    for v, x in m["by_version"].items():
        lag = "--" if x["lag_median"] is None else f"{x['lag_median']:.1f}"
        m1 += (f"{names[v]} & {x.get('codification', 0)} & {x.get('announcement', 0)} & "
               f"{x.get('ungrounded', 0)} & {lag} \\\\\n")
    cross = ""
    for c, label in (("imported", "Imported from the EU"), ("mixed", "Mixed"), ("own", "WEKO's own")):
        cross += label + "".join(f" & {F['cross'].get(f'{c}|{k}', 0)}" for k in ("codification", "announcement", "ungrounded")) + " \\\\\n"
    for c in ("imported", "mixed", "own"):
        row = [F["cross"].get(f"{c}|{k}", 0) for k in ("codification", "announcement", "ungrounded")]
        key = c.capitalize()
        out[f"Cross{key}N"] = str(sum(row))
        out[f"Cross{key}Ann"], out[f"Cross{key}Ungr"], out[f"Cross{key}Cod"] = str(row[1]), str(row[2]), str(row[0])
    sv = F["survival"]
    out.update({"SurvN": num(sv["n"]), "SurvEvents": num(sv["events"]), "SurvCensored": num(sv["censored"]),
                "SurvMedian": num(float(sv["median"])), "SurvMedianLo": num(float(sv["median_ci"][0] or 0)),
                "SurvMedianHi": num(float(sv["median_ci"][1])) if sv["median_ci"][1] else "n.d.",
                "SurvByFive": f"{100 * sv['applied_by_5']:.0f}", "SurvByTen": f"{100 * sv['applied_by_10']:.0f}",
                "SurvOwnN": num(sv["own_n"]), "SurvOtherN": num(sv["other_n"]),
                "SurvOwnMedian": num(float(sv["own_median"])) if sv["own_median"] else "n.d.",
                "SurvOtherMedian": num(float(sv["other_median"])) if sv["other_median"] else "n.d.",
                "SurvLogrankP": f"{sv['logrank_own_vs_other']:.2f}", "SurvCensoredShort": num(sv["censored_short"])})
    a = F["anchors"]; r = a["results"]
    out.update({"AnchPairs": num(a["pairs"]), "AnchHolds": num(r.get("holds", 0)), "AnchStates": num(r.get("states", 0)),
                "AnchFrag": num(r.get("fragment", 0)), "AnchQuotes": num(r.get("quotes", 0)), "AnchAbsent": num(r.get("absent", 0)),
                "AnchFull": num(r.get("holds", 0) + r.get("states", 0)), "AnchNot": num(r.get("quotes", 0) + r.get("absent", 0)),
                "AnchCitations": num(a["citations"]), "AnchResolved": num(a["resolved"]), "AnchPinpoint": num(a["pinpoint"]),
                "AnchSeventeenN": num(a["by_edition"]["2019-04-09"]["n"]), "AnchSeventeenFull": num(a["by_edition"]["2019-04-09"]["full"]),
                "AnchTwentyTwoN": num(a["by_edition"]["2022-12-12-erl"]["n"]), "AnchTwentyTwoFull": num(a["by_edition"]["2022-12-12-erl"]["full"]),
                "AnchCourtN": num(a["court_n"]), "AnchCourtFrag": num(a["court_fragment"]), "AnchByReader": num(a["by_reader"])})
    e = F["exhaustive"]
    out.update({"ExhRules": num(e["rules"]), "ExhTop": num(e["per_rule"]), "ExhExtCand": num(e["ext_candidates"]),
                "ExhExtDecisions": num(e["ext_decisions"]), "ExhAnnKept": num(e["ann_kept"]), "ExhAnnIn": num(e["ann_in"]),
                "ExhUngrIn": num(e["ungr_in"]), "ExhUngrToCod": num(e["ungr_to_cod"]), "ExhUngrToAnn": num(e["ungr_to_ann"]),
                "ExhUngrLeft": num(e["ungr_left"]), "ExhLagBefore": num(float(e["lag_before"]))})
    out["EarlyAppN"] = num(F["early_applications"]["n"])
    out["EarlyAppCluster"] = num(F["early_applications"]["2008_2012"])
    out["ErlNorms"] = num(F["erl"]["norms"])
    out["ErlAnn"] = num(F["erl"]["announcement"])
    out["ErlCod"] = num(F["erl"]["codification"])
    u = F["uptake"]
    out.update({"UpTotal": num(u["total"]), "UpFirstYear": str(u["first_year"]), "UpToTen": num(u["to_2010"]),
                "UpSinceEleven": num(u["since_2011"]), "UpMaxToTen": num(u["max_to_2010"]), "UpCourts": num(u["courts"]),
                "UpFirstCourtYear": str(u["first_court_year"]), "UpFederalPeak": str(u["federal_peak"])})
    out["EuLaterAnn"] = num(F["eu_later"].get("announcement", 0))
    out["EuLaterAll"] = num(sum(F["eu_later"].values()))
    out["ImportedFirstAll"] = num(sum(F["imported_first_versions"].values()))
    out["ImportedFirstLatest"] = num(F["imported_first_versions"].get("2022-12-12", 0)
                                     + F["imported_first_versions"].get("2022-12-12-erl", 0))
    for cls, short in (("codification", "Cod"), ("announcement", "Ann"), ("ungrounded", "Ungr")):
        for f, fs in (("kept", "Kept"), ("modified", "Mod"), ("dropped", "Drop")):
            out[f"Fate{short}{fs}"] = num(F["fates"][cls].get(f, 0))
    ty = F["typology"]["types"]
    out.update({"NNorm": num(ty.get("norm", 0)), "NDefinition": num(ty.get("definition", 0)),
                "NScope": num(ty.get("scope", 0)), "NRationale": num(ty.get("rationale", 0)),
                "NHousekeeping": num(ty.get("housekeeping", 0)), "TypAgreed": num(F["typology"]["agreed"]),
                "TypN": num(F["typology"]["n"]), "NTracksAll": num(F["measure1_all"]["tracks"]),
                "NTracksNonNorm": num(F["measure1_all"]["tracks"] - F["measure1_all"]["norms"])})
    rs = F["record"]["rpw_date_source"]
    out["RPWText"], out["RPWIssue"], out["RPWSame"] = num(rs.get("text", 0)), num(rs.get("issue", 0)), num(rs.get("same_as", 0))
    out["NNotices"] = num(F["record"]["notices_excluded"])
    out["DisputedFragSup"] = num(F["full_run"]["disputed_pairs"].get("fragment|supported", 0))
    out["ProvShort"] = num(F["labels"]["n"] - F["provenance"]["n"])
    out["CrossTotal"] = num(sum(F["cross"].values()))
    early = [m["by_version"][v] for v in ("2002-02-18", "2007-07-02")]
    out["EarlyAnn"] = str(sum(x.get("announcement", 0) for x in early))
    out["EarlyCod"] = str(sum(x.get("codification", 0) for x in early))
    t = F["text_lag"]
    out.update({"TlN": num(t["n"]), "TlMedian": num(float(t["median"])), "TlQone": num(float(t["quartiles"][0])),
                "TlQthree": num(float(t["quartiles"][2])), "TlBaseMedian": num(float(t["base_median"])),
                "TlMoved": num(t["moved"]), "TlMovedReader": num(t["moved_by_reader"]),
                "TlMaxShift": num(float(t["max_shift"])), "TlOverFive": num(t["over_five"]),
                "TlOverTen": num(t["over_ten"]), "TlEarliestYear": str(t["earliest_year"])})
    c = F["cited_age"]
    out.update({"AgeSeventeenN": num(c["2019-04-09"]["n"]), "AgeSeventeen": num(float(c["2019-04-09"]["median"])),
                "AgeTwentyTwoN": num(c["2022-12-12-erl"]["n"]), "AgeTwentyTwo": num(float(c["2022-12-12-erl"]["median"]))})
    S = F["strict"]
    out.update({"StrictCod": num(S.get("codification|codification", 0)), "StrictFragFirst": num(S.get("codification|fragment-first", 0)),
                "StrictAnn": num(S.get("announcement|announcement", 0)), "StrictFragOnly": num(S.get("announcement|fragment-only", 0)),
                "StrictLagAnn": num(float(F["strict_lag_ann"])), "StrictErlCod": num(F["strict_erl"].get("codification", 0)),
                "StrictErlFragFirst": num(F["strict_erl"].get("fragment-first", 0))})
    V = F["voice"]
    out.update({"VoiceN": num(V["n"]), "VoicePrescribes": num(V.get("voice_prescribes", 0)),
                "VoiceDescribes": num(V.get("voice_describes", 0)), "StatuteRestates": num(V.get("statute_restates", 0)),
                "VoiceByReader": num(V["by_reader"])})
    B = F["baserate"]
    out.update({"BaseTwoThousandTwo": num(B["2002-02-18"]["decisions_before"]),
                "BaseTwoThousandTwoSanct": num(B["2002-02-18"]["under_kg2003"]),
                "BaseTwoThousandSeven": num(B["2007-07-02"]["decisions_before"]),
                "BaseTwoThousandSevenSanct": num(B["2007-07-02"]["under_kg2003"]),
                "BaseErlSeventeen": num(B["2019-04-09"]["decisions_before"]),
                "BaseErlSeventeenSanct": num(B["2019-04-09"]["under_kg2003"]),
                "BaseTwentyTwo": num(B["2022-12-12"]["decisions_before"])})
    for c, short in (("imported", "Imp"), ("mixed", "Mix"), ("own", "Own")):
        x = F["prov_applied"][c]
        out[f"ProvApp{short}N"] = num(x["n"])
        out[f"ProvApp{short}Not"] = num(x["not_applied"])
        out[f"ProvApp{short}NotPct"] = f"{100 * x['not_applied'] / x['n']:.0f}"
    out["TlTop"] = num(F["textlag_top"])
    R = F["rules"]
    for r, short in (("both", "Both"), ("either", "Either"), ("claude", "ClaudeOnly"), ("gemini", "GeminiOnly")):
        out[f"Rule{short}Cod"] = num(R[r]["codification"])
        out[f"Rule{short}Ann"] = num(R[r]["announcement"])
        out[f"Rule{short}ErlCod"] = num(R[r]["erl_codification"])
        out[f"Rule{short}EarlyAnn"] = num(R[r]["early_announcement"])
    out["RulePubErlCod"] = num(R["published"]["erl_codification"])
    out["RulePubEarlyAnn"] = num(R["published"]["early_announcement"])
    out["RuleCodMin"] = num(min(R[r]["codification"] for r in R))
    out["RuleCodMax"] = num(max(R[r]["codification"] for r in R))
    out["RuleErlMin"] = num(min(R[r]["erl_codification"] for r in R))
    out["RuleEarlyAnnMin"] = num(min(R[r]["early_announcement"] for r in R))
    bs = F["bootstrap"]
    pct = lambda x: f"{100 * x:.0f}"
    out.update({"BootCodLo": pct(bs["codification"][0]), "BootCodHi": pct(bs["codification"][1]),
                "BootAnnLo": pct(bs["announcement"][0]), "BootAnnHi": pct(bs["announcement"][1]),
                "BootLagLo": num(float(bs["lag_median"][0])), "BootLagHi": num(float(bs["lag_median"][1]))})
    pc = F["poolcheck"]
    out.update({"PoolPackets": num(sum(pc["packets_checked"].values())), "PoolSame": num(pc["packets_checked"].get("same", 0)),
                "PoolPassages": num(pc["passages_200"]), "PoolLost": num(pc["not_shown_at_100"])})
    fr = F["frit"]
    out.update({"FritFound": num(fr["found"]), "FritFr": num(fr["fr"]), "FritIt": num(fr["it"]),
                "FritVertical": num(fr["vertical"]), "FritHandFound": num(fr["hand_found"]), "FritHand": num(fr["hand"]),
                "FritNew": num(fr["new"]), "FritEnter": num(fr["would_enter"])})
    oc = F["order"]
    out.update({"OrdN": num(oc["claude-opus"]["n"]),
                "OrdClaudeRetest": num(oc["claude-opus"]["retest_same_binary"]), "OrdClaudeShuf": num(oc["claude-opus"]["shuffled_same_binary"]),
                "OrdGeminiRetest": num(oc["gemini-3.1-pro"]["retest_same_binary"]), "OrdGeminiShuf": num(oc["gemini-3.1-pro"]["shuffled_same_binary"]),
                "OrdClaudeRetestL": num(oc["claude-opus"]["retest_same_label"]), "OrdClaudeShufL": num(oc["claude-opus"]["shuffled_same_label"]),
                "OrdGeminiRetestL": num(oc["gemini-3.1-pro"]["retest_same_label"]), "OrdGeminiShufL": num(oc["gemini-3.1-pro"]["shuffled_same_label"])})
    lines = ["% generated by paper_figures.py from figures.json -- do not edit"]
    lines += ["\\newcommand{\\InstRows}{" + inst + "}", "\\newcommand{\\MoneRows}{" + m1 + "}",
              "\\newcommand{\\CrossRows}{" + cross + "}"]
    lines += [f"\\newcommand{{\\{k}}}{{{v}}}" for k, v in sorted(out.items())]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.exit(main())
