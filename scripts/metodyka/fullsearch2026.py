"""Is the court record the audit reads complete for the 2026 norms? (PAPER-244)

The record holds the 2,159 court judgments that cite the 2002 Methodology.
A court that applied a rule the 2026 text later wrote down -- a SSNIP test,
HHI, supply-side substitution -- without citing the 2002 Methodology is not
in it, so "no application found" would rest on a partial sample. This
searches the full EDRSR (edrsr_fulltext, ~135M judgments, one GIN index per
year partition) for the terms of each new or modified norm, inside a
competition context, and counts what lies outside the record.

One worker per year partition. Judgments dated on or after 1 August 2026 are
dropped through edrsr_documents.

    python3 fullsearch2026.py --workers 6 --out /data/amcu/fullsearch2026.json
"""
from __future__ import annotations

import argparse
import collections
import json
import multiprocessing as mp
import pathlib
import time

import psycopg2

import retrieve

CUTOFF = "2026-08-01"
YEARS = list(range(2006, 2027))
CONTEXT = "монопол:* | антимонопол:* | конкуренц:*"

# norm -> tsqueries (to_tsquery, 'simple' config). Words with an apostrophe
# are avoided: the record spells it four ways.
TERMS = {
    "I.4.17": ["надає <-> йому <-> ринкову <-> владу"],
    "II.3": ["етапи <-> визначення <-> монопольного <-> домінуючого <-> становища"],
    "II.4": ["вужчих <-> межах & ширш:* <-> ринк:*", "більш <-> вузьких & більш <-> широких & меж:*"],
    "IV.1": ["ознаки <-> замінності <-> чи <-> взаємозамінності"],
    "V.1": ["замінн:* & з <-> боку <-> попиту & з <-> боку <-> пропозиції"],
    "V.2": ["готовност:* <-> замовник:* <-> замінити", "можливост:* <-> та <-> готовност:* <-> замовник:*"],
    "V.3": ["замінн:* <-> з <-> боку <-> пропозиції", "взаємозамінн:* <-> з <-> боку <-> пропозиції"],
    "V.5": ["вирішальн:* <-> для <-> заміни"],
    "V.6": ["жодного <-> замінника", "межі <-> ринку <-> визначаються <-> цільовим <-> товаром"],
    "V.7": ["стаді:* <-> обороту <-> товару", "функціональн:* <-> рів:* & ринк:*"],
    "V.8": ["допоміжн:* <-> товар:* & основн:* <-> товар:*"],
    "V.9": ["системний <-> ринок", "множинний <-> ринок", "подвійний <-> ринок"],
    "V.10": ["ланцюг:* <-> замінності", "непрям:* <-> замінник:*"],
    "V.11": ["диференційован:* <-> товар:*"],
    "V.12": ["дискримінован:* <-> груп:* & замовник:*", "недискримінован:* <-> груп:*"],
    "V.13": ["рів:* <-> новизни"],
    "V.14": ["витрат:* <-> на <-> перехід", "витрат:* <-> переключення", "мережев:* <-> ефект:*"],
    "V.15": ["замінн:* <-> товару <-> з <-> боку <-> пропозиції", "впродовж <-> короткого <-> періоду <-> часу"],
    "V.16": ["товару <-> замінника & потужност:*", "безповоротн:* <-> витрат:*"],
    "V.17": ["замінн:* <-> з <-> боку <-> пропозиції & фактичн:* <-> учасник:*"],
    "V.18": ["обрано <-> як <-> цільовий", "обрано <-> цільовим"],
    "VI.2": ["однорідн:* <-> умов <-> конкуренції"],
    "VI.3": ["фактичн:* <-> перех:* <-> замовник:*"],
    "VI.4": ["однорідн:* <-> умов <-> конкуренції & кожному <-> окремому <-> випадку"],
    "VI.5": ["сусідн:* <-> територі:* & постачальник:* <-> цільового"],
    "VI.6": ["ознакою <-> місця <-> розташування", "місц:* <-> розташування <-> замовника"],
    "VI.7": ["потенційн:* <-> імпорт:*", "наявність <-> імпорту"],
    "VI.8": ["територіальні <-> географічні <-> межі <-> ринку <-> можуть <-> змінюватися", "межі <-> ринку <-> можуть <-> змінюватися"],
    "VI.9": ["гіпотетичн:* <-> монополіст:*", "ssnip", "відчутн:* & невелик:* & тривал:* <-> зростання <-> цін"],
    "VII.2": ["часов:* <-> меж:* & сезонн:* <-> коливан:*", "часов:* <-> меж:* & пікових"],
    "VIII.6": ["натуральному <-> вимірі & ринков:* <-> частк:*", "ціновою <-> диференціацією"],
    "VIII.7": ["відповіда:* <-> часовим <-> межам"],
    "VIII.8": ["герфіндал:*", "hhi", "індекс:* <-> ринкової <-> концентрації", "висококонцентрован:*"],
    "IX.2": ["інвестиційн:* <-> цикл:*", "вірогідност:* <-> своєчасност:*"],
    "IX.4": ["не <-> є <-> потенційним <-> конкурентом"],
    "IX.6": ["врівноважу:* <-> ринков:* <-> влад:*", "переговорн:* <-> можливост:* & замовник:*", "компенсуюч:* <-> ринков:* <-> влад:*"],
    "X.3": ["диктувати <-> свої <-> умови"],
    "X.4": ["додатков:* <-> ознак:* & ринков:* <-> влад:*", "вертикально <-> суміжн:* <-> ринк:*"],
    "XI.1": ["адміністративн:* <-> дан:* & джерел:* <-> інформації"],
}


def year_worker(year: int) -> tuple[int, dict, float]:
    t0 = time.time()
    conn = psycopg2.connect(retrieve.dsn())
    conn.autocommit = True
    out: dict = {}
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '20min'")
        for norm, queries in TERMS.items():
            for q in queries:
                cur.execute(
                    f"SELECT doc_id FROM edrsr_fulltext_p_{year} "
                    "WHERE tsv @@ to_tsquery('simple', %s) AND tsv @@ to_tsquery('simple', %s)",
                    (q, CONTEXT))
                out[f"{norm}\t{q}"] = [r[0] for r in cur.fetchall()]
    conn.close()
    return year, out, time.time() - t0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--out", default="/data/amcu/fullsearch2026.json")
    args = ap.parse_args()
    record = {int(x) for x in open("/data/amcu/court_ids.txt")}
    hits: dict[str, set[int]] = collections.defaultdict(set)
    with mp.Pool(args.workers) as pool:
        for year, out, secs in pool.imap_unordered(year_worker, YEARS):
            n = len({d for v in out.values() for d in v})
            print(f"  {year}: {n} judgments in {secs:.0f}s", flush=True)
            for k, v in out.items():
                hits[k].update(v)
    every = {d for v in hits.values() for d in v}
    conn = psycopg2.connect(retrieve.dsn())
    with conn.cursor() as cur:
        cur.execute("SELECT doc_id, adjudication_date FROM edrsr_documents WHERE doc_id = ANY(%s)", (list(every),))
        dates = {r[0]: str(r[1]) if r[1] else "" for r in cur.fetchall()}
    late = {d for d in every if dates.get(d, "") >= CUTOFF}
    rows, by_norm = [], collections.defaultdict(set)
    for k, v in sorted(hits.items()):
        norm, q = k.split("\t")
        v = v - late
        by_norm[norm] |= v
        rows.append({"norm": norm, "query": q, "hits": len(v), "in_record": len(v & record), "outside": len(v - record)})
    norms = {n: {"hits": len(v), "in_record": len(v & record), "outside": sorted(v - record)} for n, v in by_norm.items()}
    pathlib.Path(args.out).write_text(json.dumps({"cutoff": CUTOFF, "context": CONTEXT, "queries": rows,
                                                  "norms": norms, "dates": {str(d): dates.get(d, "") for d in every - late}},
                                                 ensure_ascii=False, indent=1))
    outside = set().union(*(set(v["outside"]) for v in norms.values()))
    print(f"{len(every - late)} judgments before {CUTOFF}, {len(outside)} outside the record ({len(late)} later dropped)")
    for n in TERMS:
        v = norms.get(n, {"hits": 0, "in_record": 0, "outside": []})
        print(f"  {n:<8} {v['hits']:>7} hits  {v['in_record']:>5} in record  {len(v['outside']):>7} outside")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
