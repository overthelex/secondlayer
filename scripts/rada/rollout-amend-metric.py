#!/usr/bin/env python3
"""Roll out the clause-level amendment metric across ALL laws.

For every law it fetches the current-edition print page from Rada, parses inline
`{…}` amendment notes per article into operations (added/modified/removed + act +
date), and loads them into legislation_article_amendments.

Multi-threaded with a GLOBAL token-bucket rate limiter (politeness toward Rada)
and a JSONL checkpoint so it resumes after interruption. Designed to run ON PROD
(reaches Rada + DB via `docker exec psql`).

Env: WORKERS (default 6), RATE (req/s, default 2.0).
Inputs: ~/amend-rollout/laws.tsv  (lines: id|rada_id|YYYYMMDD)
"""
import re, os, json, time, threading, subprocess
from concurrent.futures import ThreadPoolExecutor

WORK = os.path.expanduser("~/amend-rollout")
LAWS = os.path.join(WORK, "laws.tsv")
DONE = os.path.join(WORK, "done.jsonl")
PG = ["docker", "exec", "-i", "secondlayer-postgres-prod",
      "psql", "-U", "secondlayer", "-d", "secondlayer_prod"]
BASE = "https://zakon.rada.gov.ua"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
WORKERS = int(os.environ.get("WORKERS", "6"))
RATE = float(os.environ.get("RATE", "2.0"))

# ── global token-bucket rate limiter ─────────────────────────────────────────
class Rate:
    def __init__(self, rps):
        self.rps = rps; self.allow = rps; self.last = time.monotonic()
        self.lock = threading.Lock()
    def take(self):
        while True:
            with self.lock:
                now = time.monotonic()
                self.allow = min(self.rps, self.allow + (now - self.last) * self.rps)
                self.last = now
                if self.allow >= 1:
                    self.allow -= 1; return
            time.sleep(0.05)
rate = Rate(RATE)
wlock = threading.Lock()

def fetch(url, tries=6):
    txt = ""
    for i in range(tries):
        rate.take()
        try:
            o = subprocess.run(["curl", "-s", "-m", "45", "--compressed",
                "-A", UA, "-H", "Accept-Language: uk,en;q=0.9", url],
                capture_output=True, timeout=70)
            txt = o.stdout.decode("utf-8", "replace")
            if len(txt) >= 3000:
                return txt
        except Exception:
            pass
        time.sleep(3 + 3 * i)
    return txt

# Act ref: «Закон[ом] № 1432-IX» AND old КУпАП-style «Законом N 244/94-ВР ( 2342-14 ) від 05.04.2001»
# — handles both № and Latin N, slashed/Roman numbers, and 2- or 4-digit years.
ACT = re.compile(
    r"Закон[а-яіїєґ']*\s*(?:№|N)\s*"
    r"([0-9]+(?:[/-][0-9A-Za-zА-Яа-яІЇЄҐ]+)+)"          # 1432-IX, 244/94-ВР, 2342-III
    r"(?:\s*\([^)]*\))?"                                  # optional ( rada-id )
    r"(?:\s+від\s+(\d{1,2})\.(\d{1,2})\.(\d{2,4}))?", re.I)
HDR = re.compile(r"Стаття\s+(\d+(?:-\d+)?)\.")               # article header (capital С + period)
NOTEREF = re.compile(r"статт[іяюеї]\s+(\d+(?:-\d+)?)", re.I)  # note's own article ref
TOK = re.compile(r"(Стаття\s+\d+(?:-\d+)?\.)|(\{[^}]*\})", re.S)
JUNK = re.compile(r"dataLayer|function|https?:|link:|stat:|gtag|push\(")

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
    if "виключ" in ctx: return "removed"
    if "в редакці" in ctx: return "modified"
    if "доповн" in ctx: return "added"
    if "замін" in ctx or "змін" in ctx: return "modified"
    return "modified"

def parse_ops(html):
    """Stream-parse the whole page (format-independent): track the current
    'Стаття N.' header as context and attribute each {…} note to the article it
    names ('статті N') or, failing that, the current header. JS blobs filtered.
    -> list of (article, change_type, act, date_iso|None, note)"""
    t = re.sub(r"<br\s*/?>", " ", html, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = (t.replace("&nbsp;", " ").replace("&mdash;", "—")
          .replace("&laquo;", "«").replace("&raquo;", "»").replace("&amp;", "&"))
    t = re.sub(r"[ \t]+", " ", t)
    ops, cur = [], "0"
    for m in TOK.finditer(t):
        if m.group(1):
            cur = HDR.match(m.group(1)).group(1)
            continue
        note = m.group(2)
        if JUNK.search(note):
            continue
        inner = note.strip("{}").strip()
        if not re.search(r"[А-Яа-яІЇЄҐієїґ]", inner):
            continue
        ref = NOTEREF.search(inner)
        art = ref.group(1) if ref else cur
        prev = 0
        for a in ACT.finditer(inner):
            ctx = inner[prev:a.start()] or inner[:a.end()]
            dt = valid_date(f"{norm_year(a.group(4))}-{a.group(3).zfill(2)}-{a.group(2).zfill(2)}") if a.group(2) else None
            ops.append([art, classify(ctx), a.group(1), dt, note])
            prev = a.end()
    return ops

def process(law):
    lid, rada, ed = law
    # PRINT_MODE (or laws with no edition date) → fetch the current consolidated text.
    if os.environ.get("PRINT_MODE") == "1" or not ed.isdigit():
        html = fetch(f"{BASE}/laws/show/{rada}/print")
        ops = parse_ops(html)
    else:
        html = fetch(f"{BASE}/laws/show/{rada}/ed{ed}/print")
        ops = parse_ops(html)
        if not ops and "Стаття" not in html:  # fallback to current edition
            html = fetch(f"{BASE}/laws/show/{rada}/print")
            ops = parse_ops(html)
    rec = {"id": lid, "rada": rada, "ed": ed, "ops": ops, "bytes": len(html)}
    with wlock:
        with open(DONE, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"  done id={lid} {rada}: {len(ops)} ops ({len(html)}b)", flush=True)
    return rec

# ── load law list + resume set ───────────────────────────────────────────────
laws = []
for ln in open(LAWS):
    ln = ln.strip()
    if not ln: continue
    a = ln.split("|")
    if len(a) == 3 and a[2]:
        laws.append((int(a[0]), a[1], a[2]))

done_ids = set()
if os.path.exists(DONE):
    for ln in open(DONE):
        try: done_ids.add(json.loads(ln)["id"])
        except Exception: pass
SC = int(os.environ.get("SHARD_COUNT", "1"))
SI = int(os.environ.get("SHARD_INDEX", "0"))
todo = [l for l in laws if l[0] % SC == SI and l[0] not in done_ids]
print(f"laws={len(laws)} shard={SI}/{SC} done={len(done_ids)} todo={len(todo)} workers={WORKERS} rate={RATE}/s", flush=True)

# ── fetch + parse (parallel) ─────────────────────────────────────────────────
with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    list(ex.map(process, todo))

if os.environ.get("FETCH_ONLY") == "1":
    recs = [json.loads(l) for l in open(DONE)]
    print(f"FETCH_ONLY done: {len(recs)} laws, {sum(len(x['ops']) for x in recs)} ops in {DONE}", flush=True)
    raise SystemExit(0)

# ── load into DB (single idempotent transaction) ─────────────────────────────
def sq(s): return "'" + (s or "").replace("'", "''") + "'"
recs = [json.loads(l) for l in open(DONE)]
sql = ["""\\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS legislation_article_amendments (
  id SERIAL PRIMARY KEY,
  legislation_id INTEGER NOT NULL REFERENCES legislation(id) ON DELETE CASCADE,
  rada_id VARCHAR(100) NOT NULL,
  article_number VARCHAR(50) NOT NULL,
  change_type VARCHAR(20) NOT NULL CHECK (change_type IN ('added','modified','removed')),
  basis_act VARCHAR(50), act_date DATE, note_text TEXT, source_edition DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_law_art_amend ON legislation_article_amendments(legislation_id, article_number);
-- Must match migration 188 and prod exactly. A plain UNIQUE(... note_text) is
-- wrong twice: note_text is TEXT and can overflow a btree key, and it treats
-- NULL and '' as different rows while the live index folds them together.
CREATE UNIQUE INDEX IF NOT EXISTS uq_law_art_amend ON legislation_article_amendments
  (legislation_id, article_number, change_type, basis_act, md5(coalesce(note_text, '')));
"""]
for r in recs:
    lid = r["id"]; src = f"{r['ed'][:4]}-{r['ed'][4:6]}-{r['ed'][6:8]}"
    sql.append(f"DELETE FROM legislation_article_amendments WHERE legislation_id={lid};")
    for art, ct, act, dt, note in r["ops"]:
        sql.append("INSERT INTO legislation_article_amendments "
            "(legislation_id,rada_id,article_number,change_type,basis_act,act_date,note_text,source_edition) VALUES ("
            f"{lid},{sq(r['rada'])},{sq(art)},{sq(ct)},{sq(act)},{sq(dt) if dt else 'NULL'},{sq(note)},{sq(src)}) ON CONFLICT DO NOTHING;")
sql.append("SELECT count(*) AS total_ops, count(DISTINCT legislation_id) AS laws, count(DISTINCT basis_act) AS acts FROM legislation_article_amendments;")
sql.append("COMMIT;")
open(os.path.join(WORK, "load.sql"), "w").write("\n".join(sql))
print("applying SQL...", flush=True)
res = subprocess.run(PG, stdin=open(os.path.join(WORK, "load.sql")), capture_output=True, text=True)
print(res.stdout[-2000:]); print(res.stderr[-1000:])
print("ROLLOUT COMPLETE", flush=True)
