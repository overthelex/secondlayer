#!/usr/bin/env python3
"""Rebuild the article-amendment metric from Rada's inline `{…}` annotations.

Counts CLAUSE-LEVEL amendment operations per article (what a lawyer sees in the
text), not editions. Each `{…}` note cites one or more acts; each act-reference
in a note is one operation, classified by its verb:
  доповнено  -> added      в редакції -> modified      виключено -> removed

Output: SQL (CREATE TABLE legislation_article_amendments + DELETE + INSERTs) so it
can be applied to prod, plus a per-article report. Source = the law's CURRENT
edition print page (the consolidated text that still carries surviving notes).

Usage:
  python3 scripts/rada/build-amendment-metric.py <rada_id> <legislation_id> [edition_YYYYMMDD]
  e.g. python3 scripts/rada/build-amendment-metric.py 2778-17 298 20241006
"""
import re, sys, subprocess
from collections import Counter

RADA = sys.argv[1] if len(sys.argv) > 1 else "2778-17"
LEG_ID = int(sys.argv[2]) if len(sys.argv) > 2 else 298
EDITION = sys.argv[3] if len(sys.argv) > 3 else "20241006"
BASE = "https://zakon.rada.gov.ua"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
SQL_OUT = "/tmp/amend_metric.sql"

def fetch(url, tries=7):
    txt = ""
    for i in range(tries):
        try:
            o = subprocess.run(["curl", "-s", "-m", "45", "--compressed",
                "-A", UA, "-H", "Accept-Language: uk,en;q=0.9", url],
                capture_output=True, timeout=70)
            txt = o.stdout.decode("utf-8", "replace")
            if len(txt) >= 3000:
                return txt
        except Exception:
            pass
        import time; time.sleep(3 + 4 * i)
    return txt

RVTS = re.compile(
    r'<span\s+class=["\']?rvts9["\']?>\s*Стаття\s+(\d+(?:-\d+)?)\.?\s*([^<]*)</span>\s*'
    r'(.*?)(?=<span\s+class=["\']?rvts9["\']?>\s*Стаття\s+\d|$)', re.S)

def to_text(htmlfrag):
    t = re.sub(r"<[^>]+>", " ", htmlfrag)
    t = (t.replace("&nbsp;", " ").replace("&mdash;", "—")
          .replace("&laquo;", "«").replace("&raquo;", "»").replace("&amp;", "&"))
    return re.sub(r"[ \t]+", " ", t)

# Handles «№ 1432-IX» and old «N 244/94-ВР ( 2342-14 ) від 05.04.2001» formats.
ACT = re.compile(
    r"Закон[а-яіїєґ']*\s*(?:№|N)\s*"
    r"([0-9]+(?:[/-][0-9A-Za-zА-Яа-яІЇЄҐ]+)+)"
    r"(?:\s*\([^)]*\))?"
    r"(?:\s+від\s+(\d{1,2})\.(\d{1,2})\.(\d{2,4}))?", re.I)

def norm_year(y):
    return y if len(y) == 4 else (("19" + y) if int(y) >= 30 else ("20" + y))

def valid_date(dt):
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", dt) if dt else None
    if not m:
        return None
    y, mo, d = map(int, m.groups())
    return dt if (1900 <= y <= 2100 and 1 <= mo <= 12 and 1 <= d <= 31) else None

def classify(ctx):
    ctx = ctx.lower()
    if "виключ" in ctx:                 return "removed"
    if "в редакці" in ctx:              return "modified"
    if "доповн" in ctx:                 return "added"
    if "замін" in ctx or "змін" in ctx: return "modified"
    return "modified"

def parse_notes(text):
    """Yield (change_type, act, act_date_iso|None, note_text) for each act-ref in each {…}."""
    for note in re.findall(r"\{[^}]*\}", text):
        inner = note.strip("{}").strip()
        prev = 0
        for m in ACT.finditer(inner):
            ctx = inner[prev:m.start()] or inner[:m.end()]
            act = m.group(1)
            date_iso = (valid_date(f"{norm_year(m.group(4))}-{m.group(3).zfill(2)}-{m.group(2).zfill(2)}")
                        if m.group(2) else None)
            yield classify(ctx), act, date_iso, note
            prev = m.end()

def sql_str(s):
    return "'" + (s or "").replace("'", "''") + "'"

# ── Fetch + parse ────────────────────────────────────────────────────────────
html = fetch(f"{BASE}/laws/show/{RADA}/ed{EDITION}/print")
rows = []                       # (article, change_type, act, date_iso, note)
per_article = Counter()
for m in RVTS.finditer(html):
    art = m.group(1).strip()
    body = to_text(m.group(3))
    for ct, act, dt, note in parse_notes(body):
        rows.append((art, ct, act, dt, note))
        per_article[art] += 1

src_iso = f"{EDITION[:4]}-{EDITION[4:6]}-{EDITION[6:8]}"

# ── Emit SQL ─────────────────────────────────────────────────────────────────
with open(SQL_OUT, "w") as f:
    f.write("""\\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS legislation_article_amendments (
  id SERIAL PRIMARY KEY,
  legislation_id INTEGER NOT NULL REFERENCES legislation(id) ON DELETE CASCADE,
  rada_id VARCHAR(100) NOT NULL,
  article_number VARCHAR(50) NOT NULL,
  change_type VARCHAR(20) NOT NULL CHECK (change_type IN ('added','modified','removed')),
  basis_act VARCHAR(50),
  act_date DATE,
  note_text TEXT,
  source_edition DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_law_art_amend
  ON legislation_article_amendments(legislation_id, article_number);
-- Must match migration 188 and prod exactly. A plain UNIQUE(... note_text) is
-- wrong twice: note_text is TEXT and can overflow a btree key, and it treats
-- NULL and '' as different rows while the live index folds them together.
CREATE UNIQUE INDEX IF NOT EXISTS uq_law_art_amend ON legislation_article_amendments
  (legislation_id, article_number, change_type, basis_act, md5(coalesce(note_text, '')));
""")
    f.write(f"DELETE FROM legislation_article_amendments WHERE legislation_id={LEG_ID};\n")
    for art, ct, act, dt, note in rows:
        dt_sql = sql_str(dt) if dt else "NULL"
        f.write(
            "INSERT INTO legislation_article_amendments "
            "(legislation_id,rada_id,article_number,change_type,basis_act,act_date,note_text,source_edition) VALUES ("
            f"{LEG_ID},{sql_str(RADA)},{sql_str(art)},{sql_str(ct)},{sql_str(act)},{dt_sql},"
            f"{sql_str(note)},{sql_str(src_iso)}) ON CONFLICT DO NOTHING;\n")
    f.write("SELECT article_number, count(*) AS amendments FROM legislation_article_amendments "
            f"WHERE legislation_id={LEG_ID} GROUP BY article_number ORDER BY amendments DESC, article_number LIMIT 12;\n")
    f.write("COMMIT;\n")

# ── Report ───────────────────────────────────────────────────────────────────
print(f"Law {RADA} (id {LEG_ID}), edition {src_iso}")
print(f"Total clause-level operations parsed: {len(rows)}")
print(f"Distinct acts: {len(set(r[2] for r in rows))}")
print(f"\nArticle 1 operations: {per_article.get('1',0)}")
for art, ct, act, dt, note in rows:
    if art == "1":
        print(f"  {ct:9} {act} {dt or ''}")
print("\nTop articles by clause-level amendments:")
for art, n in per_article.most_common(10):
    print(f"  ст.{art}: {n}")
print(f"\nSQL written to {SQL_OUT}")
