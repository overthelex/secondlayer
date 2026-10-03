"""The VertBek audit as a Hugging Face dataset: overthelex/ch-vertbek-audit.

Same layout as the Ukrainian Metodyka audit: one parquet per config under
data/, the files they were built from under raw/ (a repo mixing CSV and JSON
at the top breaks load_dataset).

What is redistributed and what is not:
  - The notice and its explanatory notes, cut into propositions, in full:
    official texts of an authority, not protected by copyright (Art. 5 para. 1
    lit. a and c URG).
  - The decisions are NOT redistributed. They are public at their sources;
    the dataset keys every passage (ECLI + ordinal) and carries the SHA-256 of
    its text, so a rebuild can be checked passage by passage. The judges'
    one-line reasons and the short quotes they and the reader cite are kept.

    python3 export_hf.py --dsn ... --out /data/ch-corpus/weko-bek/hf
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import sys

import pandas as pd

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
DATA = REPO / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")

VERSION_NAME = {
    "2002-02-18": "Vertikalbekanntmachung 2002",
    "2007-07-02": "Vertikalbekanntmachung 2007",
    "2010-06-28": "Vertikalbekanntmachung 2010",
    "2017-05-22": "Vertikalbekanntmachung 2010, Stand 22.05.2017",
    # The key is a misnomer kept as an identifier: the text is the Stand of
    # 9 April 2018 of the Erläuterungen first issued on 12 June 2017.
    "2019-04-09": "Erläuterungen vom 12.06.2017, Stand 09.04.2018",
    "2022-12-12": "Vertikalbekanntmachung 2022",
    "2022-12-12-erl": "Erläuterungen 2022",
}
TIER = {"CH_WEKO": "agency", "CH_WEKO_RPW": "agency", "CH_BGE": "federal_court", "CH_BGer": "federal_court",
        "CH_BVGer": "federal_court", "CH_BSTG": "federal_court"}


def tier(spider: str) -> str:
    if spider in TIER:
        return TIER[spider]
    if not spider.startswith("CH_") and spider[:2].isalpha() and spider[2:3] == "_":
        return "cantonal"
    return "other_federal"


def sha(text: str | None) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def jsonl(path: pathlib.Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--out", type=pathlib.Path, default=DIR / "hf")
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    (out / "data").mkdir(parents=True)
    (out / "raw").mkdir()

    review = [r for r in json.loads((DATA / "review_full.json").read_text()) if r["status"] != "control"]
    labels = {(r["version"], r["pid"]): r for r in json.loads((DATA / "labels_full_2026-10-03.json").read_text())["labels"]}
    m1 = json.loads((DATA / "measure1_final.json").read_text())
    track_of = {(v, d["pid"]): t["track"] for t in m1 for v, d in t["versions"].items()}
    prov = json.loads((DATA / "provenance.json").read_text())
    pc = {}
    for p in prov["propositions"]:
        pid = "E" + p["pid"] if p["part"] == "preamble" and p["pid"].isdigit() else p["pid"]
        pc[(p["version"], pid)] = p
    assert len(review) == len(labels) == 328, (len(review), len(labels))

    # 1. propositions
    rows = []
    for r in review:
        k = (r["version"], r["pid"])
        lab, pr = labels[k], pc.get(k, {})
        rows.append({"version": r["version"], "version_name": VERSION_NAME[r["version"]], "pid": r["pid"],
                     "part": r["part"], "heading": r.get("heading") or "", "lead": r.get("lead") or "",
                     "text": r["text"], "track": track_of.get(k), "label": lab["label"],
                     "label_source": lab["source"], "label_claude": lab["claude"], "label_gemini": lab["gemini"],
                     "provenance": pr.get("class"), "eu_containment": pr.get("containment")})
    props = pd.DataFrame(rows)

    # 2. evidence: the eight passages each proposition was read against, keyed, not quoted
    ptext = {}
    for e in {(e["ecli"], e["ord"]) for r in review for e in r["evidence"]}:
        ptext[e] = None
    for row in conn.execute("SELECT ecli, ord, text FROM ch_weko_audit_passages_v2 WHERE ecli = ANY(%s)",
                            ([e for e, _ in ptext],)).fetchall():
        if (row["ecli"], row["ord"]) in ptext:
            ptext[(row["ecli"], row["ord"])] = row["text"]
    missing = [k for k, v in ptext.items() if v is None]
    assert not missing, f"{len(missing)} evidence passages not in ch_weko_audit_passages_v2"
    ev = []
    for r in review:
        for rank, e in enumerate(r["evidence"], 1):
            ev.append({"version": r["version"], "pid": r["pid"], "rank": rank, "ecli": e["ecli"], "ord": e["ord"],
                       "docket": e.get("docket"), "spider": e["spider"], "tier": tier(e["spider"]),
                       "date": e.get("date"), "date_upper_bound": e.get("date_upper_bound"),
                       "date_source": e.get("date_source"), "lang": e.get("lang"),
                       "recital_share": e.get("recital_share"), "cites_this": e.get("cites_this"),
                       "passage_chars": len(ptext[(e["ecli"], e["ord"])]),
                       "passage_sha256": sha(ptext[(e["ecli"], e["ord"])])})
    evidence = pd.DataFrame(ev)

    # 3. judgements: every model answer, passage by passage
    ev_ecli = {(r["version"], r["pid"]): [e["ecli"] for e in r["evidence"]] for r in review}
    runs = [("full", DATA / "judges-full"), ("before", DATA / "judges-before"),
            ("before-erl", DATA / "judges-before-erl"), ("gold", DATA / "judges-gold")]
    jrows = []
    for run, d in runs:
        for f in sorted(d.glob("*.jsonl")):
            for a in jsonl(f):
                if a.get("kind") == "control" and run != "full":
                    continue
                for p in a.get("passages") or []:
                    jrows.append({"run": run, "judge": f.stem, "model": a["model"], "version": a["version"],
                                  "pid": a["pid"], "kind": a.get("kind"), "proposition_label": a["label"],
                                  "ecli": p.get("ecli"), "passage_label": p.get("label"),
                                  "why": p.get("why") or "", "quote": p.get("quote") or "",
                                  "quote_found": p.get("quote_found"), "system_sha256": a["system_sha256"],
                                  "error": a.get("error")})
    judgements = pd.DataFrame(jrows)

    # 4. reader: every human label, with the reasons written at the time
    hrows = []
    gold = json.loads((HERE / "gold_set_2026-10-02.json").read_text())["labels"]
    dev = {(r["version"], r["pid"]) for r in json.loads((HERE / "human_labels_2026-10-02.json").read_text())["labels"]}
    for r in gold:
        hrows.append({"round": "gold-development" if (r["version"], r["pid"]) in dev else "gold-test",
                      "version": r["version"], "pid": r["pid"], "before": None,
                      "label": r["label"], "note": r.get("note") or ""})
    for r in labels.values():
        if r["source"] == "human_disputed":
            hrows.append({"round": "disputed", "version": r["version"], "pid": r["pid"], "before": None,
                          "label": r["label"], "note": r.get("note") or ""})
    for f, rnd in (("human_labels_before_2026-10-03.json", "before"),
                   ("human_labels_before_erl_2026-10-03.json", "before-erl")):
        for r in json.loads((DATA / f).read_text())["labels"]:
            hrows.append({"round": rnd, "version": r["version"], "pid": r["pid"], "before": r.get("before"),
                          "label": r["label"], "note": r.get("note") or ""})
    reader = pd.DataFrame(hrows)

    # 5. measurement 1
    mrows = []
    for t in m1:
        v = t["first_version"]
        mrows.append({"track": t["track"], "first_version": v, "first_pid": t["versions"][v]["pid"],
                      "first_date": t["first_date"], "class": t["final_class"], "decided_by": t["decided_by"],
                      "step2_before": t.get("step2_before") or None, "lag_years": t["lag_years"],
                      "best_label": t["best_label"],
                      "versions": json.dumps(t["versions"], ensure_ascii=False),
                      "support": json.dumps(t["support"], ensure_ascii=False)})
    measure1 = pd.DataFrame(mrows)

    # 6. provenance
    prov_df = pd.DataFrame([{"version": p["version"], "pid": k[1], "class": p["class"],
                             "containment": p["containment"], "null_containment": p.get("null"),
                             "eu_instruments": json.dumps(p.get("instrument"), ensure_ascii=False),
                             "eu_window": p.get("eu_window") or ""} for k, p in pc.items()])

    # 7. corpus manifest
    crow = conn.execute("""SELECT c.ecli, c.spider, c.docket_number, c.date_exact, c.date_upper_bound, c.date_source,
                                  c.rpw_chapter, length(c.full_text) AS chars, md5(c.full_text) AS md5,
                                  (SELECT count(*) FROM ch_weko_audit_passages_v2 p WHERE p.ecli = c.ecli) AS passages
                             FROM ch_weko_audit_corpus c
                            WHERE c.rpw_chapter IS DISTINCT FROM 'D1' ORDER BY c.ecli""").fetchall()
    corpus = pd.DataFrame([{"ecli": r["ecli"], "spider": r["spider"], "tier": tier(r["spider"]),
                            "docket": r["docket_number"], "date_exact": r["date_exact"],
                            "date_upper_bound": r["date_upper_bound"], "date_source": r["date_source"],
                            "rpw_chapter": r["rpw_chapter"], "chars": r["chars"], "text_md5": r["md5"],
                            "passages": r["passages"]} for r in crow])

    for name, df in (("propositions", props), ("evidence", evidence), ("judgements", judgements),
                     ("reader", reader), ("measure1", measure1), ("provenance", prov_df), ("corpus", corpus)):
        df.to_parquet(out / "data" / f"{name}.parquet", index=False)
        print(f"{name:13} {len(df):6} rows")

    # raw: what the configs were built from, plus the protocols and the figures
    shutil.copy(HERE / "protocol.md", out / "raw" / "protocol_v2.md")
    shutil.copy(DIR / "protocol_v1.md", out / "raw" / "protocol_v1.md")
    for f in ("figures.json", "labels_full_2026-10-03.json", "measure1_final.json", "provenance.json"):
        shutil.copy(DATA / f, out / "raw" / f)
    shutil.copy(HERE / "gold_set_2026-10-02.json", out / "raw" / "gold_set_2026-10-02.json")
    import subprocess
    sums = subprocess.run("sha256sum data/* raw/*", shell=True, cwd=out, capture_output=True, text=True).stdout
    (out / "raw" / "checksums.txt").write_text(sums)
    return 0


if __name__ == "__main__":
    sys.exit(main())
