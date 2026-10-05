"""Every number the revised paper states about the 2026 text, as LaTeX macros (PAPER-247).

The paper does not type a number by hand: it \\input's the file this writes,
and every macro is computed here from data/metodyka. The 2002 audit's
numbers (v1 of the paper) come from figdata.py and are not repeated here.

    python3 paper_numbers.py --out ../../../papers/stanford-metodyka-audit/numbers.tex
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import pathlib
import statistics

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "metodyka"


def load(name):
    return json.loads((DATA / name).read_text())


def lines(path):
    return [json.loads(l) for l in (DATA / path).read_text().splitlines() if l.strip()]


def fisher_two_sided(a, b, c, d):
    """Fisher's exact test on [[a, b], [c, d]], two-sided by summing tables no likelier than the observed."""
    n, r1, c1 = a + b + c + d, a + b, a + c
    def p(x):
        return math.comb(c1, x) * math.comb(n - c1, r1 - x) / math.comb(n, r1)
    obs = p(a)
    lo, hi = max(0, r1 + c1 - n), min(r1, c1)
    return sum(p(x) for x in range(lo, hi + 1) if p(x) <= obs * (1 + 1e-9))


def agreement(folder, key="answer"):
    ident = (lambda r: r["id"]) if key != "type" else (lambda r: (r["version"], r["pid"]))
    c = {ident(r): r[key] for r in lines(f"{folder}/claude-opus.jsonl") if r.get(key)}
    g = {ident(r): r[key] for r in lines(f"{folder}/gemini-3.1-pro.jsonl") if r.get(key)}
    both = set(c) & set(g)
    return len(both), sum(c[i] == g[i] for i in both)


# One line of English for each norm the table names; everything else in a row is data.
GLOSS = {
    "V.7": "stages of distribution are not one market",
    "V.8": "complementary goods may widen the market",
    "V.14": "obstacles to substitution, switching costs",
    "VI.7": "imports do not widen the geographic market",
    "VIII.6": "which measure market shares are computed on",
    "VIII.8": "concentration indices, HHI thresholds",
    "IX.6": "countervailing buyer power",
}
COURT = {"court": "court", "amcu": "AMCU"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=pathlib.Path, required=True)
    args = ap.parse_args()
    m: dict[str, str] = {}

    # the two texts, typed
    ty = load("typology_ua.json")["types"]
    for v, tag in (("2002", "A"), ("2026", "B")):
        cnt = collections.Counter(r["type"] for r in ty if r["version"] == v)
        m[f"Typ{tag}N"] = sum(cnt.values())
        for t in ("norm", "definition", "scope", "rationale", "housekeeping"):
            m[f"Typ{tag}{t.capitalize()}"] = cnt.get(t, 0)
    n, agree = agreement("typology", key="type")
    m["TypPairs"], m["TypAgree"] = n, agree
    m["TypReader"] = len(load("human_labels_typology_ua.json")["labels"])

    # alignment and fates
    al = load("alignment_2002_2026.json")
    fate = collections.Counter(r["fate"] for r in al["old"])
    m["FateKept"], m["FateModified"], m["FateDropped"] = fate["kept"], fate["modified"], fate["dropped"]
    orig = collections.Counter(r["origin"] for r in al["new"])
    m["OrigSame"], m["OrigModified"], m["OrigNew"] = orig["same"], orig["modified"], orig["new"]
    m["AlignPairs"] = len(load("align_pairs.json"))
    n, agree = agreement("align")
    m["AlignAgree"], m["AlignSplit"] = agree, n - agree
    m["AlignReader"] = len(load("human_labels_align.json")["labels"])
    m["AlignTied"] = sum(len(r["from_2002_all"]) > 1 for r in al["new"])

    fp = load("fates_2002_2026.json")["provisions"]
    applied = [r for r in fp if r["use"] == "applied"]
    unapplied = [r for r in fp if r["use"] != "applied"]
    a, b = sum(r["fate"] == "dropped" for r in applied), sum(r["fate"] != "dropped" for r in applied)
    c, d = sum(r["fate"] == "dropped" for r in unapplied), sum(r["fate"] != "dropped" for r in unapplied)
    m["UseApplied"], m["UseUnapplied"] = len(applied), len(unapplied)
    m["DropApplied"], m["DropUnapplied"] = a, c
    m["DropAppliedPct"] = round(100 * a / len(applied))
    m["DropUnappliedPct"] = round(100 * c / len(unapplied))
    m["DropFisherP"] = f"{fisher_two_sided(a, b, c, d):.2f}"
    never = [r for r in fp if r["use"] == "never cited"]
    m["NeverCitedKept"] = sum(r["fate"] != "dropped" for r in never)
    m["NeverCitedN"] = len(never)

    # codification before the text
    cod = load("codify_2026.json")
    rows = cod["norms"]
    m["CodN"] = len(rows)
    m["CodNewN"] = sum(r["origin"] == "new" for r in rows)
    m["CodModN"] = sum(r["origin"] == "modified" for r in rows)
    yes = [r for r in rows if r["verdict"] == "codifies"]
    m["CodYes"], m["CodAnn"] = len(yes), len(rows) - len(yes)
    m["CodYesNew"] = sum(r["origin"] == "new" for r in yes)
    m["CodYesMod"] = sum(r["origin"] == "modified" for r in yes)
    lags = sorted(r["text_lag_years"] for r in yes)
    m["LagMin"], m["LagMax"], m["LagMedian"] = lags[0], lags[-1], statistics.median(lags)
    m["CodFirstYear"] = min(r["first_applied"]["date"][:4] for r in yes)
    m["CodLastYear"] = max(r["first_applied"]["date"][:4] for r in yes)
    eu = {r["number"]: r["eu_2024"] for r in load("eu_codify_2026.json")["norms"]}
    tab = []
    for r in sorted(yes, key=lambda r: r["first_applied"]["date"]):
        f = r["first_applied"]
        who = COURT[f["doc_id"].split(":")[0]]
        ref = (f["doc_ref"] or f["doc_id"]).replace("_", "\\_")
        tab.append(f"{r['number']} & {GLOSS[r['number']]} & {f['date'][:4]} & {who} {ref} & {r['text_lag_years']:.1f} & {eu[r['number']]} \\\\")
    assert set(GLOSS) == {r["number"] for r in yes}, "the gloss list and the codified norms differ"
    m["CodRows"] = "\n".join(tab)
    m["CodContradicted"] = sum(bool(r["contradicted"]) for r in rows)
    m["CodOldPartOnly"] = sum(r["verdict"] == "announces" and r["applied_old_part"] > 0 for r in rows)
    pk = {"first": lines("judges2026/claude-opus.jsonl"), "exh": lines("judges2026_exh/claude-opus.jsonl"),
          "ext": lines("judges2026_ext/claude-opus.jsonl")}
    m["ReadFirst"], m["ReadExh"], m["ReadExt"] = len(pk["first"]), len(pk["exh"]), len(pk["ext"])
    m["ReadTotal"] = sum(len(v) for v in pk.values())
    for tag, folder in (("First", "judges2026"), ("Exh", "judges2026_exh"), ("Ext", "judges2026_ext")):
        c = {(r["number"], r["doc_id"], r["ord"]): r["label"] for r in lines(f"{folder}/claude-opus.jsonl")}
        g = {(r["number"], r["doc_id"], r["ord"]): r["label"] for r in lines(f"{folder}/gemini-3.1-pro.jsonl")}
        m[f"Agree{tag}"] = sum(c[k] == g[k] for k in c)
    m["ReaderPractice"] = len(load("human_labels_practice2026.json")["labels"])
    m["Rejudged"] = len(lines("judges2026_rejudge/claude-opus.jsonl"))
    fs = load("fullsearch2026.json")
    hits = {d for v in fs["norms"].values() for d in v["outside"]}
    m["FullHits"] = len(fs["dates"])
    m["FullOutside"] = len(hits)
    m["FullNoHit"] = sum(1 for r in rows if r["edrsr_term_hits"] == 0)

    # EU provenance
    pv = load("eu_provenance.json")
    for run, tag in (("2002>1997", "AOld"), ("2026>2024", "BNew"), ("2026>1997", "BOld"), ("2002>stateaid2016", "Ctl")):
        cnt = collections.Counter(r["answer"] for r in pv[run])
        m[f"Eu{tag}Rendered"], m[f"Eu{tag}Same"], m[f"Eu{tag}Diff"] = cnt["rendered"], cnt["same rule"], cnt["different"]
        m[f"Eu{tag}N"] = len(pv[run])
    m["EuPairs"] = len(load("eu_pairs.json"))
    n, agree = agreement("eu")
    m["EuAgree"], m["EuSplit"] = agree, n - agree
    m["EuDecisive"] = len(load("eu_disputes_decisive.json"))
    m["EuReader"] = len(load("human_labels_eu.json")["labels"])
    ec = load("eu_codify_2026.json")["norms"]
    t = collections.Counter((r["verdict"], r["eu_2024"]) for r in ec)
    for v, vt in (("codifies", "Cod"), ("announces", "Ann")):
        for a_, at in (("rendered", "Rendered"), ("same rule", "Same"), ("different", "Diff")):
            m[f"X{vt}{at}"] = t[(v, a_)]
    m["XAnnEu"] = t[("announces", "rendered")] + t[("announces", "same rule")]
    m["XRenderedNotOld"] = sum(r["eu_2024"] == "rendered" and r["eu_1997"] != "rendered" for r in ec)
    m["XEuRule"] = sum(r["eu_2024"] != "different" for r in ec)
    m["XEuRendered"] = sum(r["eu_2024"] == "rendered" for r in ec)

    out = ["% Generated by scripts/metodyka/paper_numbers.py in the secondlayer repository. Do not edit."]
    for k, v in m.items():
        assert k.isalpha(), k
        out.append(f"\\newcommand{{\\{k}}}{{%\n{v}}}" if k.endswith("Rows") else f"\\newcommand{{\\{k}}}{{{v}}}")
    args.out.write_text("\n".join(out) + "\n")
    print(f"{len(m)} macros -> {args.out}")
    print(m["CodRows"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
