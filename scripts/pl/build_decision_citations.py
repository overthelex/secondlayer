#!/usr/bin/env python3
"""Citation graph: Polish court decision -> act (ELI) -> article (LEXAI-2241).

Reads the legal bases the decision sources already carry and loads
pl_decision_citations (migration 272). Nothing is regexed out of full texts.

  hf-pl-nsa, hf-pl-court-raw  metadata_json->'extracted_legal_bases'
      (hf-pl-court-raw names the keys isap_id / art / address instead)
      [{"law": "...", "link": "http://isap.sejm.gov.pl/DetailsServlet?id=WDU20120000270",
        "article": "Art. 199, art. 246 par. 1 pkt 1", "journal": "Dz.U. 2012 poz 270"}]
      ISAP id W<pub><year:4><journal no:3><position:4>, so WDU20040290257 is Dz.U. 2004
      nr 29 poz 257 = ELI DU/2004/257 (the ELI numbers positions per year, not per issue).
  saos  referenced_regulations
      [{"text": "Ustawa ... (Dz. U. z 1964 r. Nr 43, poz. 296 - art. 385; art. 393(19))",
        "journalYear": 1964, "journalEntry": 296, ...}]
      ELI DU/<journalYear>/<journalEntry>; "(M. P." in the text makes it MP. Checked on
      2,120 references of Jan-Feb 2008: every one is in pl_acts under that DU ELI.

The cited ELI is often a consolidated text (obwieszczenie). act_eli folds it onto the base act
through pl_acts.consolidates_eli; cited_eli keeps the edition.

Article numbers take the pl_act_articles form: 415, 145a, 22^1, 18^3a. SAOS writes
superscripts as "393(19)" or run together as "3935" (= 393^5). The run-together form is
resolved only when the plain number is not an article of the act and exactly one split is;
otherwise the number stays as written.

Sharded by source and month of decision_date (plus 'other': no date or outside 1918..next
year). A shard is written in one transaction that first deletes the shard's decisions, so a
shard can be re-run any time; finished shards are listed in pl_decision_citation_shards and
skipped unless --redo. --since re-reads decisions dated on or after a day (the daily cron).

On cthulhu, against pg-lawrider:

  PL_SSH_HOST= PG_CONTAINER=pg-lawrider python3 scripts/pl/build_decision_citations.py --dry-run --source saos --months 2015-03
  PL_SSH_HOST= PG_CONTAINER=pg-lawrider python3 scripts/pl/build_decision_citations.py
  PL_SSH_HOST= PG_CONTAINER=pg-lawrider python3 scripts/pl/build_decision_citations.py --since 2026-10-01
  PL_SSH_HOST= PG_CONTAINER=pg-lawrider python3 scripts/pl/build_decision_citations.py --report
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402

SOURCES = {
    "hf-pl-nsa": "metadata_json->'extracted_legal_bases'",
    "hf-pl-court-raw": "metadata_json->'extracted_legal_bases'",
    "saos": "referenced_regulations",
}
FIRST_YEAR = 1918
STATEMENT_TIMEOUT_MS = int(os.environ.get("STATEMENT_TIMEOUT_MS", "900000"))
RAW_MAX = 400
COLUMNS = ["decision_id", "source", "decision_date", "court_type", "act_eli", "cited_eli",
           "art_no", "raw", "act_resolved", "art_resolved"]

# ---------------------------------------------------------------- parsing

ISAP_ID = re.compile(r"\bW(DU|MP)(\d{4})(\d{3})(\d{4})\b")
JOURNAL = re.compile(r"^\s*(Dz\.\s*U\.|M\.\s*P\.)\s*(?:z\s*)?(\d{4})\b.*?\bpoz\.?\s*(\d+)", re.I)
ART_MARK = re.compile(r"\bart(?:ykuł[a-z]*|\.)?\s*(?=\d)", re.I)
SUP = {"⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9"}
# 415 | 145a | 477(14) | 22^1 | 22¹ | 18^3a ; not followed by a letter or digit
ART_NO = re.compile(r"(\d+)([a-z]{0,8})(?:\s*\^\s*(\d+)|\((\d+)\)|([⁰¹²³⁴⁵⁶⁷⁸⁹]+))?([a-z]{0,3})(?![0-9a-ząćęłńóśźż])")
WS = re.compile(r"\s+")
TRAIL_WORD = re.compile(r"\s+(?:i|oraz|w\s+zw\.\s+z\.?)$", re.I)
LIST_SEP = re.compile(r"\s*(?:,|\bi\b|\boraz\b)\s*")


def isap_eli(link, journal):
    """ELI of an hf legal basis: the ISAP id in the link, else the journal string."""
    m = ISAP_ID.search(link or "")
    if m and int(m.group(4)):  # position 0: ISAP id of an act ISAP could not place
        return f"{m.group(1)}/{m.group(2)}/{int(m.group(4))}"
    j = journal or ""
    if re.search(r"\bUE\b", j):
        return None  # Dz.U.UE.L: EU journal, not an ELI
    m = JOURNAL.search(j)
    if m:
        pub = "MP" if m.group(1).upper().startswith("M") else "DU"
        return f"{pub}/{m.group(2)}/{int(m.group(3))}"
    return None


def saos_eli(ref):
    try:
        y, p = int(ref.get("journalYear") or 0), int(ref.get("journalEntry") or 0)
    except (TypeError, ValueError):
        return None
    if not y or not p:  # SAOS writes position 0 for acts it could not place
        return None
    pub = "MP" if re.search(r"\(M\.\s*P\.", ref.get("text") or "") else "DU"
    return f"{pub}/{y}/{p}"


def trim_fragment(frag):
    """Drop the separators and connectives ('i', 'oraz', 'w zw. z') a fragment ends on.

    A loop, not one regex: an alternation of overlapping whitespace classes under + before $
    backtracks exponentially on a long run of spaces, and hung the first full run.
    """
    prev = None
    while frag != prev:
        prev = frag
        frag = TRAIL_WORD.sub("", frag.rstrip(" \t\n,;"))
    return frag


def _art_token(m):
    base, l1, caret, paren, uni, l2 = m.groups()
    sup = caret or paren or ("".join(SUP[c] for c in uni) if uni else None)
    return base + l1 + (f"^{sup}" if sup else "") + (l2 if sup else ""), bool(sup), (l1 + l2) == ""


def parse_articles(text):
    """[(art_no, explicit_superscript, plain_digits, fragment)] for every 'art. N' in text.

    'art. 7,75,77 par. 1' -> 7, 75, 77; 'art. 51, ust. 5, art. 52' -> 51, 52. A list continues
    over commas and 'i' while the next item is a number; a unit word (ust., §, par., pkt) ends it.
    """
    text = WS.sub(" ", text or "")
    s = text.lower()
    marks = list(ART_MARK.finditer(s))
    out = []
    for i, mk in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(s)
        seg = s[mk.end():end]
        frag = trim_fragment(text[mk.start():end])
        pos = 0
        while True:
            m = ART_NO.match(seg, pos)
            if not m:
                break
            no, has_sup, plain = _art_token(m)
            out.append((no, has_sup, plain and not has_sup, frag))
            sep = LIST_SEP.match(seg, m.end())
            if not sep or not ART_NO.match(seg, sep.end()):
                break
            # 'art. 71 ust. 2 pkt 1, 2': numbers after a unit word were never reached; a bare
            # list after the article number itself is a list of articles.
            pos = sep.end()
    return out


def resolve_runtogether(no, act_articles):
    """'3935' -> '393^5' when 3935 is not an article of the act and exactly one split is."""
    if not act_articles or no in act_articles or not no.isdigit() or len(no) < 2:
        return no
    hits = [f"{no[:k]}^{no[k:]}" for k in range(1, len(no))
            if no[k] != "0" and f"{no[:k]}^{no[k:]}" in act_articles]
    return hits[0] if len(hits) == 1 else no


def saos_article_text(text):
    """The part after 'poz. N - ' inside the reference's closing parenthesis."""
    m = re.search(r"poz\.?\s?\d+\s?-\s?(.*?)\)? ?$", WS.sub(" ", text or "").strip())
    return m.group(1) if m else ""


def references(source, payload):
    """[(cited_eli, article_text, raw_whole)] of one decision's legal-bases JSON."""
    if not isinstance(payload, list):
        return []
    out = []
    for ref in payload:
        if not isinstance(ref, dict):
            continue
        if source == "saos":
            eli = saos_eli(ref)
            arts = saos_article_text(ref.get("text"))
            raw = arts or (ref.get("text") or "")
        else:
            # hf-pl-nsa: link/article/journal; hf-pl-court-raw: isap_id/art/address
            eli = isap_eli(ref.get("link") or ref.get("isap_id"), ref.get("journal") or ref.get("address"))
            arts = ref.get("article") or ref.get("art") or ""
            raw = arts or (ref.get("law") or "")
        out.append((eli, arts, raw.strip()))
    return out


def citation_rows(decision, source, payload, acts, articles, stats):
    """Rows for one decision. acts: eli -> base eli (or itself); articles: base eli -> set."""
    did, ddate, ctype = decision
    rows = {}
    for cited, arts, raw in references(source, payload):
        if not cited:
            stats["no_eli"] += 1
            continue
        act_known = cited in acts
        base = acts.get(cited, cited)
        known = articles.get(base)
        parsed = parse_articles(arts)
        if not parsed:
            rows.setdefault((cited, None), [base, act_known, []])[2].append(raw)
            continue
        for no, _sup, plain, frag in parsed:
            if plain:
                no = resolve_runtogether(no, known)
            rows.setdefault((cited, no), [base, act_known, []])[2].append(frag)
    out = []
    for (cited, no), (base, act_known, frags) in rows.items():
        raw = "; ".join(dict.fromkeys(f for f in frags if f))[:RAW_MAX] or cited
        art_known = bool(no and articles.get(base) and no in articles[base])
        out.append((did, source, ddate, ctype, base, cited, no, raw, act_known, art_known))
    return out


# ---------------------------------------------------------------- database

def _psql_argv(extra=()):
    inner = ["docker", "exec", "-i", "-e", f"PGOPTIONS=-c statement_timeout={STATEMENT_TIMEOUT_MS}",
             plprod.CONTAINER, "psql", "-X", "-q", "-U", plprod.DB_USER, "-d", plprod.DB_NAME,
             "-v", "ON_ERROR_STOP=1", *extra]
    if not plprod.SSH_HOST:
        return inner
    return ["ssh", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30",
            plprod.SSH_HOST, " ".join(shlex.quote(a) for a in inner)]


def run(script):
    r = subprocess.run(_psql_argv(), input=script, capture_output=True, text=True,
                       timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()[:800]}")
    return r.stdout


def query(sql):
    """Rows of a SELECT as lists of strings ('' for NULL), through COPY ... CSV."""
    out = run(f"COPY ({sql}) TO STDOUT WITH (FORMAT csv);\n")
    return list(csv.reader(io.StringIO(out)))


def lit(v):
    return "'" + str(v).replace("'", "''") + "'"


def load_reference_data():
    t = time.time()
    acts = {}
    for eli, cons in query("SELECT eli, CASE WHEN is_consolidation THEN consolidates_eli END FROM pl_acts"):
        acts[eli] = cons or eli
    articles = {}
    for act, no in query("SELECT DISTINCT act_eli, art_no FROM pl_act_articles"):
        articles.setdefault(act, set()).add(no)
    print(f"reference data: {len(acts):,} acts, {sum(map(len, articles.values())):,} articles "
          f"of {len(articles):,} acts ({time.time() - t:.0f}s)", flush=True)
    return acts, articles


def month_shards(source, months_filter):
    lo, hi = query(f"SELECT min(decision_date), max(decision_date) FROM pl_court_decisions "
                   f"WHERE source = {lit(source)} AND decision_date >= '{FIRST_YEAR}-01-01' "
                   f"AND decision_date < '{dt.date.today().year + 1}-01-01'")[0]
    shards = []
    if lo:
        y, m = int(lo[:4]), int(lo[5:7])
        while f"{y:04d}-{m:02d}" <= hi[:7]:
            shards.append(f"{y:04d}-{m:02d}")
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    shards.append("other")
    if months_filter:
        shards = [s for s in shards if any(s.startswith(f) for f in months_filter)]
    return shards


def shard_where(shard, since=None):
    if since:
        return f"decision_date >= {lit(since)}"
    if shard == "other":
        return (f"(decision_date IS NULL OR decision_date < '{FIRST_YEAR}-01-01' "
                f"OR decision_date >= '{dt.date.today().year + 1}-01-01')")
    y, m = int(shard[:4]), int(shard[5:7])
    nxt = f"{y + 1:04d}-01-01" if m == 12 else f"{y:04d}-{m + 1:02d}-01"
    return f"decision_date >= '{shard}-01' AND decision_date < '{nxt}'"


def build_shard(source, shard, acts, articles, since=None):
    col = SOURCES[source]
    rows_in = query(f"SELECT id, decision_date, court_type, {col} FROM pl_court_decisions "
                    f"WHERE source = {lit(source)} AND {shard_where(shard, since)}")
    stats = {"no_eli": 0}
    ids, out, with_cites = [], [], 0
    for did, ddate, ctype, payload in rows_in:
        ids.append(did)
        if not payload:
            continue
        try:
            data = json.loads(payload)
        except ValueError:
            continue
        rows = citation_rows((did, ddate or None, ctype or None), source, data, acts, articles, stats)
        if rows:
            with_cites += 1
            out.extend(rows)
    s = {
        "n_decisions": len(ids), "n_with_cites": with_cites, "n_rows": len(out),
        "n_act_resolved": sum(1 for r in out if r[8]),
        "n_art_rows": sum(1 for r in out if r[6]),
        "n_art_resolved": sum(1 for r in out if r[9]),
        "no_eli": stats["no_eli"],
    }
    return ids, out, s


def write_shard(source, shard, ids, rows, s, record=True):
    esc = plprod.esc
    parts = [
        "BEGIN;\n",
        "CREATE TEMP TABLE _ids (id text) ON COMMIT DROP;\n",
        "COPY _ids (id) FROM STDIN WITH (FORMAT text);\n",
        "".join(esc(i) + "\n" for i in ids), "\\.\n",
        "DELETE FROM pl_decision_citations c USING _ids WHERE c.decision_id = _ids.id;\n",
        f"COPY pl_decision_citations ({', '.join(COLUMNS)}) FROM STDIN WITH (FORMAT text);\n",
        "".join("\t".join(esc(c) for c in r) + "\n" for r in rows), "\\.\n",
    ]
    if record:
        vals = ", ".join(str(s[k]) for k in ("n_decisions", "n_with_cites", "n_rows",
                                              "n_act_resolved", "n_art_rows", "n_art_resolved"))
        parts.append(
            "INSERT INTO pl_decision_citation_shards (source, shard, n_decisions, n_with_cites, n_rows, "
            f"n_act_resolved, n_art_rows, n_art_resolved) VALUES ({lit(source)}, {lit(shard)}, {vals}) "
            "ON CONFLICT (source, shard) DO UPDATE SET n_decisions = EXCLUDED.n_decisions, "
            "n_with_cites = EXCLUDED.n_with_cites, n_rows = EXCLUDED.n_rows, "
            "n_act_resolved = EXCLUDED.n_act_resolved, n_art_rows = EXCLUDED.n_art_rows, "
            "n_art_resolved = EXCLUDED.n_art_resolved, loaded_at = now();\n")
    parts.append("COMMIT;\n")
    run("".join(parts))


def report():
    print(run("""
SELECT source, count(*) AS shards, sum(n_decisions) AS decisions, sum(n_with_cites) AS with_cites,
  round(100.0 * sum(n_with_cites) / nullif(sum(n_decisions), 0), 1) AS pct_with,
  sum(n_rows) AS rows, round(100.0 * sum(n_act_resolved) / nullif(sum(n_rows), 0), 1) AS pct_act,
  sum(n_art_rows) AS art_rows, round(100.0 * sum(n_art_resolved) / nullif(sum(n_art_rows), 0), 1) AS pct_art
FROM pl_decision_citation_shards GROUP BY ROLLUP (source) ORDER BY source;
"""))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--source", choices=list(SOURCES), action="append",
                    help="limit to a source (repeatable); default all three")
    ap.add_argument("--months", nargs="*", help="only shards starting with these prefixes, e.g. 2015 2016-03 other")
    ap.add_argument("--since", help="re-read decisions dated on or after YYYY-MM-DD (daily cron)")
    ap.add_argument("--redo", action="store_true", help="rebuild shards already loaded")
    ap.add_argument("--dry-run", action="store_true", help="parse and print, write nothing")
    ap.add_argument("--report", action="store_true", help="print totals from the shard table and exit")
    a = ap.parse_args()
    if a.report:
        report()
        return
    if a.since and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.since):
        ap.error("--since takes YYYY-MM-DD")

    acts, articles = load_reference_data()
    sources = a.source or list(SOURCES)
    done = set()
    if not a.redo and not a.since and not a.dry_run:
        done = {(s, sh) for s, sh in query("SELECT source, shard FROM pl_decision_citation_shards")}

    for source in sources:
        shards = [None] if a.since else month_shards(source, a.months)
        for shard in shards:
            if shard and (source, shard) in done:
                continue
            t = time.time()
            ids, rows, s = build_shard(source, shard, acts, articles, a.since)
            label = f"since {a.since}" if a.since else shard
            if a.dry_run:
                for r in rows[:15]:
                    print("  ", r)
            else:
                write_shard(source, shard, ids, rows, s, record=not a.since)
            print(f"{source} {label}: {s['n_decisions']} decisions, {s['n_with_cites']} with cites, "
                  f"{s['n_rows']} rows, act {s['n_act_resolved']}, art {s['n_art_resolved']}/{s['n_art_rows']}, "
                  f"no eli {s['no_eli']} ({time.time() - t:.1f}s)", flush=True)
    if not a.dry_run:
        report()


if __name__ == "__main__":
    main()
