"""Detector-first gate for chpipe/pdf_text.py: the PDF split of an edition
against the HTML parse of the SAME edition (Lexwork show_as_json, stage
'parsed'), on versions the host serves in both forms.

Never trust an extractor before measuring it on records with known-good
text -- the rule this repo learnt on the decisions corpus. Here the known
good text is lexwork.parse_edition's articles for the same version_id, and
the PDF is the host's own rendering of that version (pdf_link_tol).

Usage (from services/ch-pipeline, .venv python):

  1. candidates: run the SQL in CANDIDATES_SQL below on the prod DB
     (read-only) -> candidates.txt (psql -A -F'|')
  2. articles:   run ARTICLES_SQL with the chosen version ids -> html.jsonl
                 (psql -t -A, one JSON object per line)
  3. python scripts/pdf_gate.py pull candidates.txt pdfs/      (<=2 req/s per host)
  4. python scripts/pdf_gate.py compare html.jsonl pdfs/ [--dump]

Metrics per version: article count (HTML vs PDF), per-article text
similarity (difflib.SequenceMatcher ratio on whitespace-normalised text,
matched by article number), e_id agreement (Lexwork uid reproduced from the
PDF's heading chain), full_text length ratio (PDF/HTML). Reported per host.

Measured 2026-08-27, 60 versions, pdftotext 25.07 (macOS; prod has 22.02):

  host                         n  arts=   median    p25   e_id   len
  ai.clex.ch                   6   6/6    1.000   1.000   1.00  1.00
  bdlf.fr.ch (6 de, 4 fr)     10  10/10   1.000   1.000   1.00  0.99
  bgs.so.ch                    6   6/6    1.000   1.000   1.00  1.00
  bgs.zg.ch                    3   3/3    1.000   1.000   1.00  1.01
  lex.vs.ch (4 de, 4 fr)       8   8/8    1.000   1.000   0.99  1.00
  srl.lu.ch                    6   6/6    1.000   1.000   1.00  1.00
  www.belex.sites.be.ch (fr)   3   3/3    1.000   0.998   0.99  1.00
  www.gesetzessammlung.bs.ch   6   6/6    1.000   1.000   1.00  0.99
  www.gr-lex.gr.ch (4/4/4)    12  12/12   1.000   1.000   1.00  1.00
  ALL                         60  60/60   1.000   1.000   1.00  1.00

  arts=  editions whose PDF article count equals the HTML one
  median/p25  per-article text ratio (927 articles), e_id  share of
  articles whose reproduced Lexwork uid equals the HTML one, len  median
  PDF/HTML full_text length ratio.

Articles below 0.9 after the last round (6 of 927): a table inside the
provision (FR 112.51 annex art. 1-1..1-4, VS 172.13 art. A1-1 --
pdftotext -layout emits the columns row by row, the HTML text walks the
cells) and LU 185 art. 9, whose enactment line follows the text with no
blank line. The first round measured 0/3 BE editions at the right count,
LU e_id 0.47 and VS/SO last articles at 0.0-0.3; every rule in
pdf_text.py that names a host was added for a failure seen here, so
re-run this before touching one.
"""
from __future__ import annotations

import asyncio
import collections
import difflib
import json
import pathlib
import re
import statistics
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from chpipe import pdf_text  # noqa: E402

CANDIDATES_SQL = """
-- one host per branch; version_id % 11 spreads the pick over the collection
SELECT v.version_id, v.act_id, v.lang, v.article_count, length(v.full_text) AS text_len,
       v.date_applicability, v.date_end_applicability, v.xml_url,
       substring(v.akn_xml from '"pdf_link_tol":"([^"]+)"') AS pdf_link,
       substring(v.akn_xml from '"pdf_link_tol_size":([0-9]+)') AS pdf_size
FROM ch_act_version v
WHERE v.version_id IN (
  SELECT version_id FROM ch_act_version
  WHERE source='lexwork' AND stage='parsed' AND xml_url LIKE 'https://bdlf.fr.ch/%'
    AND lang='fr' AND article_count BETWEEN 5 AND 40 AND version_id % 11 = 0
  ORDER BY version_id LIMIT 4)
ORDER BY v.xml_url, v.lang;
"""

ARTICLES_SQL = """
\\t on
\\a
SELECT json_build_object('version_id', v.version_id, 'lang', v.lang,
  'host', split_part(v.xml_url,'/',3), 'act_id', v.act_id, 'full_text', v.full_text,
  'articles', (SELECT json_agg(json_build_object('e_id', a.e_id, 'n', a.article_number,
                 'm', a.marginal_note, 't', a.text) ORDER BY a.ordinal)
               FROM ch_act_article a WHERE a.version_id = v.version_id))
FROM ch_act_version v WHERE v.version_id IN (...) ORDER BY v.version_id;
"""

_WS = re.compile(r"\s+")
_MARKER = re.compile(r"\[\d+\]")


def norm(text: str | None) -> str:
    return _WS.sub(" ", _MARKER.sub("", (text or "").replace("\xa0", " "))).strip()


def ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, norm(a), norm(b), autojunk=False).ratio()


async def pull(candidates: pathlib.Path, out_dir: pathlib.Path) -> None:
    """Download each candidate's PDF in the row's language, one host at a
    time at 2 req/s; rows whose file exists are skipped."""
    import httpx
    from chpipe.http import USER_AGENT
    by_host: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
    for line in candidates.read_text().splitlines():
        parts = line.split("|")
        if len(parts) < 10 or parts[0] == "version_id":
            continue
        vid, lang, pdf = parts[0], parts[2], parts[8]
        url = pdf.replace("/api/de/", f"/api/{lang}/")
        by_host[url.split("/")[2]].append((vid, url))
    out_dir.mkdir(parents=True, exist_ok=True)

    async def host_loop(client, items):
        for vid, url in items:
            path = out_dir / f"{vid}.pdf"
            if path.exists():
                continue
            started = time.monotonic()
            response = await client.get(url)
            ok = response.status_code == 200 and response.content[:4] == b"%PDF"
            print(vid, response.status_code, len(response.content), "OK" if ok else "NOT A PDF")
            if ok:
                path.write_bytes(response.content)
            await asyncio.sleep(max(0.0, 0.5 - (time.monotonic() - started)))

    async with httpx.AsyncClient(timeout=60, follow_redirects=True,
                                 headers={"User-Agent": USER_AGENT}) as client:
        await asyncio.gather(*(host_loop(client, items) for items in by_host.values()))


def compare_one(record: dict, pdf_path: pathlib.Path) -> dict:
    extraction = pdf_text.extract(pdf_path)
    html = record["articles"] or []
    by_number: dict[str, dict] = {}
    for article in html:
        by_number.setdefault(article["n"], article)
    ratios: list[tuple[float, str]] = []
    e_id_hits = 0
    for article in extraction.articles:
        ref = by_number.get(article.article_number)
        if ref is None:
            ratios.append((0.0, article.article_number or "?"))
            continue
        ratios.append((ratio(ref["t"], article.text), article.article_number or "?"))
        if ref["e_id"] == article.e_id:
            e_id_hits += 1
    missing = [a["n"] for a in html if a["n"] not in {x.article_number for x in extraction.articles}]
    return {
        "version_id": record["version_id"], "host": record["host"], "lang": record["lang"],
        "html_articles": len(html), "pdf_articles": len(extraction.articles),
        "ratios": ratios, "missing": missing,
        "e_id_rate": e_id_hits / len(html) if html else 0.0,
        "len_ratio": len(norm(extraction.full_text)) / max(1, len(norm(record["full_text"]))),
        "extraction": extraction,
    }


def compare(jsonl: pathlib.Path, pdf_dir: pathlib.Path, dump: bool) -> None:
    per_host: dict[str, list[dict]] = collections.defaultdict(list)
    for line in jsonl.read_text().splitlines():
        if not line.strip().startswith("{"):
            continue
        record = json.loads(line)
        path = pdf_dir / f"{record['version_id']}.pdf"
        if not path.exists():
            continue
        result = compare_one(record, path)
        per_host[record["host"]].append(result)
        low = [(round(r, 2), n) for r, n in result["ratios"] if r < 0.9]
        print(f"{result['version_id']} {record['host']} {record['lang']} "
              f"arts {result['html_articles']}/{result['pdf_articles']} "
              f"median {statistics.median([r for r, _ in result['ratios']] or [0]):.3f} "
              f"e_id {result['e_id_rate']:.2f} len {result['len_ratio']:.2f} "
              f"low {low} missing {result['missing']}")
        if dump:
            for article in result["extraction"].articles:
                print("   ", article.e_id, article.article_number, repr(article.marginal_note),
                      article.text[:120])
    print()
    print(f"{'host':28s} {'n':>3s} {'arts=':>6s} {'median':>7s} {'p25':>6s} {'e_id':>5s} {'len':>5s}")
    everything: list[dict] = []
    for host, results in sorted(per_host.items()):
        _print_row(host, results)
        everything.extend(results)
    _print_row("ALL", everything)


def _print_row(label: str, results: list[dict]) -> None:
    ratios = [r for x in results for r, _ in x["ratios"]] or [0.0]
    same = sum(1 for x in results if x["html_articles"] == x["pdf_articles"])
    p25 = statistics.quantiles(ratios, n=4)[0] if len(ratios) > 1 else ratios[0]
    print(f"{label:28s} {len(results):3d} {same:3d}/{len(results):<2d} "
          f"{statistics.median(ratios):7.3f} {p25:6.3f} "
          f"{statistics.mean(x['e_id_rate'] for x in results):5.2f} "
          f"{statistics.median(x['len_ratio'] for x in results):5.2f}")


def main(argv: list[str]) -> None:
    if len(argv) >= 3 and argv[0] == "pull":
        asyncio.run(pull(pathlib.Path(argv[1]), pathlib.Path(argv[2])))
    elif len(argv) >= 3 and argv[0] == "compare":
        compare(pathlib.Path(argv[1]), pathlib.Path(argv[2]), "--dump" in argv)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv[1:])
