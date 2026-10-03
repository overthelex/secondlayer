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
    labels = json.loads((DATA / "labels_full_2026-10-03.json").read_text())["labels"]
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
    lab = {(r["version"], r["pid"]): r["label"] for r in labels}
    F["full_run"] = {"items": len(rev), "status": dict(collections.Counter(r["status"] for r in rev)),
                     "disputed_reader_with_claude": sum(lab[(r["version"], r["pid"])] == r["judges"]["claude-opus"] for r in dis),
                     "disputed_pairs": {f"{a}|{b}": n for (a, b), n in collections.Counter(
                         (r["judges"]["claude-opus"], r["judges"]["gemini-3.1-pro"]) for r in dis).items()},
                     "disputed_reader_with_gemini": sum(lab[(r["version"], r["pid"])] == r["judges"]["gemini-3.1-pro"] for r in dis),
                     "controls": {r["pid"]: r["judges"] for r in rev if r["status"] == "control"}}

    # --- measurement 1
    m1 = json.loads((DATA / "measure1_final.json").read_text())
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

    # --- provenance and its cross with measurement 1
    prov = json.loads((DATA / "provenance.json").read_text())
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

    args.out.write_text(json.dumps(F, ensure_ascii=False, indent=1, default=str))
    args.out.with_suffix(".tex").write_text(macros(F))
    import csv
    with open(args.out.with_name("tracks.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["track", "first_version", "final_class", "lag_years", "decided_by", "provenance", "containment"])
        for f in m1:
            v = f["first_version"]
            pr = pcf.get((v, f["versions"][v]["pid"]), {})
            w.writerow([f["track"], v, f["final_class"], f["lag_years"] if f["lag_years"] is not None else "",
                        f["decided_by"], pr.get("class", ""), pr.get("containment", "")])
    with open(args.out.with_name("labels.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["version", "pid", "label", "source"])
        for r in labels:
            w.writerow([r["version"], r["pid"], r["label"], r["source"]])
    print(json.dumps(F, ensure_ascii=False, indent=1, default=str)[:6000])
    return 0



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
    rs = F["record"]["rpw_date_source"]
    out["RPWText"], out["RPWIssue"], out["RPWSame"] = num(rs.get("text", 0)), num(rs.get("issue", 0)), num(rs.get("same_as", 0))
    out["NNotices"] = num(F["record"]["notices_excluded"])
    out["DisputedFragSup"] = num(F["full_run"]["disputed_pairs"].get("fragment|supported", 0))
    out["ProvShort"] = num(F["labels"]["n"] - F["provenance"]["n"])
    out["CrossTotal"] = num(sum(F["cross"].values()))
    early = [m["by_version"][v] for v in ("2002-02-18", "2007-07-02")]
    out["EarlyAnn"] = str(sum(x.get("announcement", 0) for x in early))
    out["EarlyCod"] = str(sum(x.get("codification", 0) for x in early))
    lines = ["% generated by paper_figures.py from figures.json -- do not edit"]
    lines += ["\\newcommand{\\InstRows}{" + inst + "}", "\\newcommand{\\MoneRows}{" + m1 + "}",
              "\\newcommand{\\CrossRows}{" + cross + "}"]
    lines += [f"\\newcommand{{\\{k}}}{{{v}}}" for k, v in sorted(out.items())]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.exit(main())
