"""UAE harvest proxy (me-central-1).

Modes:
  fetch : plain GET of a URL              -> body_b64
  walk  : Dubai Courts search + page walk -> rows[]

`walk` replicates the OutSystems OsAjax postback: the browser sets hidden
fields __EVENTTARGET (unique control name) and __AJAX (comma-joined click
context: docW,docH,originId,offTop,offLeft,scrollTop,scrollLeft,mouseX,mouseY,)
then submits the whole form. The partial response carries the next
__OSVSTATE in {"hidden":{"__OSVSTATE":"..."}} and new rows inside
{"outers":{...:{"inner":"<escaped html>"}}}.
"""
import base64, gzip, io, json, os, re, time, urllib.parse, urllib.request, http.cookiejar
import boto3

BUCKET = os.environ['HARVEST_BUCKET']


def _s3_put(key, obj):
    body = gzip.compress(json.dumps(obj, ensure_ascii=False).encode('utf-8'), 6)
    boto3.client('s3').put_object(Bucket=BUCKET, Key=key, Body=body,
                                  ContentType='application/json', ContentEncoding='gzip')
    return {'bucket': BUCKET, 'key': key, 'bytes': len(body)}

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
P = "DCWeb_Template_wt29$block$wtUT_MainContent$wt4$"
LIST_URL = "https://www.dc.gov.ae/PublicServices/LatestVerdicts.aspx"

Q = r"(?:'|&#39;|&#039;|\\\\')"
ANCHOR = re.compile(
    r"OsAjax\(arguments\[0\]\s*\|\|\s*window\.event,\s*" + Q + r"([^'&\\]+)" + Q +
    r"\s*,\s*" + Q + r"([^'&\\]+)" + Q +
    r".{0,500}?>\s*(?:<[^>]+>\s*)*([^<]{1,12}?)\s*<", re.S)
PREVIEW = re.compile(
    r"VerdictPreview\.aspx\?[^\"']*?CaseSubtypeCode=(\d+)[^\"']*?CaseSerialNumber=(\d+)"
    r"[^\"']*?CaseYear=(\d+)[^\"']*?DecisionNumber=(\d+)[^\"']*?OpenedLitigationStage=(\d+)")
ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
CELL = re.compile(r"<td[^>]*>(.*?)</td>", re.S)


def _read(r):
    raw = r.read()
    if r.headers.get("Content-Encoding") == "gzip":
        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    return raw.decode("utf-8", "replace")


def _hidden(doc):
    out = {}
    for m in re.finditer(r'<input[^>]*type="hidden"[^>]*>', doc, re.I):
        n = re.search(r'name="([^"]+)"', m.group(0))
        v = re.search(r'value="([^"]*)"', m.group(0))
        if n:
            out[n.group(1)] = v.group(1) if v else ""
    m = re.search(r'"hidden"\s*:\s*\{\s*"__OSVSTATE"\s*:\s*"((?:[^"\\]|\\.)*)"', doc)
    if m:
        out["__OSVSTATE"] = json.loads('"%s"' % m.group(1))
    return out


def _unescape_partial(doc):
    frags = []
    for m in re.finditer(r'"inner"\s*:\s*"((?:[^"\\]|\\.)*)"', doc):
        try:
            frags.append(json.loads('"%s"' % m.group(1)))
        except ValueError:
            pass
    return "\n".join(frags)


def _rows(doc):
    out = []
    for rm in ROW.finditer(doc):
        pm = PREVIEW.search(rm.group(1))
        if not pm:
            continue
        cells = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", c)).strip()
                 for c in CELL.findall(rm.group(1))]
        cells = [c for c in cells if c]
        out.append({"subtype": pm.group(1), "serial": pm.group(2), "case_year": pm.group(3),
                    "decision_no": pm.group(4), "stage": pm.group(5),
                    "case": cells[0] if cells else None,
                    "registered": cells[1] if len(cells) > 1 else None,
                    "decided": cells[2] if len(cells) > 2 else None,
                    "days": cells[3] if len(cells) > 3 else None})
    return out



VERDICT_URL = ("https://www.dc.gov.ae/PublicServices/VerdictPreview.aspx?"
               "OpenedPageNumber=0&Keyword=&CaseSubtypeCode=%(subtype)s&"
               "CaseSerialNumber=%(serial)s&OpenedCaseMainType=0&CaseYear=%(case_year)s&"
               "lang=&DecisionNumber=%(decision_no)s&OpenedLitigationStage=%(stage)s")


# The judgment always opens with the Basmala; everything before it is site
# navigation, and everything from the loading widget on is the page footer.
# The old greedy `<div class="...content...">(.*)</div>` swallowed both — about
# 3.7k characters of identical chrome per document, ~29% of the corpus.
BASMALA = "بِسْمِ"
FOOTER = "جاري التحميل"


def _strip_chrome(t):
    i = t.find(BASMALA)
    if i == -1:
        i = t.find("باسم صاحب السمو")
    if 0 < i < 8000:
        t = t[i:]
    j = t.rfind(FOOTER)
    if j > 500:
        t = t[:j]
    return t.strip()


def _text(doc):
    """Judgment text from the ut_verdict container.

    Case-SENSITIVE on the class: 'ut_VerdictWeb' is the small parties block and
    appears earlier in the page. The old greedy
    `<div class="...content...">(.*)</div>` swallowed the site nav and footer -
    about 3.7k characters of identical chrome per document, ~29% of the corpus.
    """
    t = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", doc)
    m = re.search(r'<div[^>]*class="[^"]*ut_verdict[\s"]', t)
    if m:
        start = t.find(">", m.start()) + 1
        depth, end = 1, len(t)
        for mm in re.finditer(r"<(/?)div\b", t[start:]):
            depth += 1 if not mm.group(1) else -1
            if depth == 0:
                end = start + mm.start()
                break
        if end - start > 500:
            t = t[start:end]
    t = re.sub(r"(?i)<br\s*/?>", "\n", t)
    t = re.sub(r"(?i)</(p|div|tr|li|h[1-6])>", "\n", t)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    for a, b in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&quot;", '"'), ("&#39;", "'")]:
        t = t.replace(a, b)
    t = t.replace("\x00", "").replace("\x01", " ").replace("\x02", " ")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n\n", t)
    return _strip_chrome(t.strip())


def _dump_cookies(cj):
    return [{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path}
            for c in cj]


def _load_cookies(cj, items):
    import http.cookiejar as cjm
    for it in items:
        cj.set_cookie(cjm.Cookie(0, it["name"], it["value"], None, False,
                                 it["domain"], True, it["domain"].startswith("."),
                                 it["path"], True, False, None, True, None, None, {}))


def _s3_get(key):
    body = boto3.client("s3").get_object(Bucket=BUCKET, Key=key)["Body"].read()
    return json.loads(gzip.decompress(body))


def _num_targets(view):
    out = {}
    for oid, uniq, label in ANCHOR.findall(view):
        s = label.strip()
        if s.isdigit():
            out[int(s)] = (oid, uniq)
    return out


def lambda_handler(event, context):
    mode = event.get("mode", "fetch")
    timeout = event.get("timeout", 45)
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", UA), ("Accept", "text/html,*/*;q=0.8"),
                     ("Accept-Language", "ar,en;q=0.8")]

    if mode == "fetch":
        for k, v in (event.get("headers") or {}).items():
            op.addheaders = [(a, b) for a, b in op.addheaders if a.lower() != k.lower()]
            op.addheaders.append((k, v))
        try:
            with op.open(event["url"], timeout=timeout) as r:
                body = _read(r)
            return {"ok": True, "len": len(body),
                    "body_b64": base64.b64encode(
                        body.encode("utf-8")[: event.get("max_bytes", 900000)]).decode()}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "err": "%s: %s" % (type(e).__name__, e)}

    if mode == "texts":
        out = []
        for it in event.get("items", []):
            try:
                with op.open(VERDICT_URL % it, timeout=timeout) as r:
                    txt = _text(_read(r))
                out.append(dict(it, ok=True, chars=len(txt), text=txt))
                time.sleep(float(event.get("delay", 0.25)))
            except Exception as e:  # noqa: BLE001
                out.append(dict(it, ok=False, err="%s: %s" % (type(e).__name__, e)))
        if event.get("s3_key"):
            return {"ok": True, "count": len(out), "s3": _s3_put(event["s3_key"], out)}
        return {"ok": True, "count": len(out), "items": out}

    if mode == "grab":
        """Fetch a list of URLs and park each PDF in S3. Used for the UAE legislation
        portal, where every law is at /ar/legislations/<id>/download and a missing id
        answers 200 with a ~650 KB HTML shell instead of a 404."""
        hdrs = {"Accept": "*/*", "Accept-Language": "ar-AE,ar;q=0.9",
                "Referer": "https://uaelegislation.gov.ae/ar/legislations",
                "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
                "Upgrade-Insecure-Requests": "1"}
        hdrs.update(event.get("headers") or {})
        op.addheaders = [(k, v) for k, v in hdrs.items()] + [("User-Agent", UA)]
        s3 = boto3.client("s3")
        out = []
        for it in event.get("items", []):
            rec = {"id": it["id"]}
            try:
                req = urllib.request.Request(it["url"])
                with op.open(req, timeout=timeout) as r:
                    body = r.read()
                if body[:4] == b"%PDF":
                    key = "%s%s.pdf" % (event.get("s3_prefix", "leg/"), it["id"])
                    s3.put_object(Bucket=BUCKET, Key=key, Body=body,
                                  ContentType="application/pdf")
                    rec.update(ok=True, kind="pdf", bytes=len(body), key=key)
                else:
                    rec.update(ok=True, kind="missing", bytes=len(body))
            except Exception as e:  # noqa: BLE001
                rec.update(ok=False, err="%s: %s" % (type(e).__name__, e))
            out.append(rec)
            time.sleep(float(event.get("delay", 0.2)))
        found = sum(1 for r in out if r.get("kind") == "pdf")
        return {"ok": True, "count": len(out), "pdfs": found, "items": out}

    stage = str(event.get("stage", "5"))
    pages = int(event.get("pages", 5))
    filters = {P + "wtUT_LitigationStageInput": stage,
               P + "wtUT_CaseMainTypeSearch": str(event.get("case_main_type", "__ossli_0")),
               P + "wtUT_CaseSubtypeSearch": str(event.get("case_subtype", "__ossli_0")),
               P + "wtUT_CaseYearSearch": str(event.get("case_year", "__ossli_0")),
               P + "wtUT_CaseSerialNumberInput": str(event.get("case_serial", "")),
               P + "wtUT_KeywordInput": str(event.get("keyword", "__ossli_0"))}

    def post(fields):
        data = urllib.parse.urlencode(fields, encoding="utf-8").encode()
        req = urllib.request.Request(LIST_URL, data=data, headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": LIST_URL, "Origin": "https://www.dc.gov.ae"})
        with op.open(req, timeout=timeout) as r:
            return _read(r)

    resumed_at = None

    def _attempt(fn, tries=4):
        """Network calls here face abrupt TLS EOFs; one must not kill a chunk."""
        last = None
        for a in range(tries):
            try:
                return fn()
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(5 * (a + 1) ** 2)
        raise last

    try:
        if event.get("resume_state_key"):
            st = _s3_get(event["resume_state_key"])
            _load_cookies(cj, st["cookies"])
            resumed_at = st["page"]
            fields = dict(filters)
            fields["__OSVSTATE"] = st["osvstate"]
            fields["__EVENTTARGET"] = st["next_target"][1]
            fields["__EVENTARGUMENT"] = ""
            fields["__AJAX"] = "1440,3200,%s,2400,300,0,0,700,2450," % st["next_target"][0]
            raw = _attempt(lambda: post(fields))
            inner = _unescape_partial(raw)
            view = (inner + "\n" + raw) if inner else raw
        else:
            def _fresh():
                with op.open(LIST_URL, timeout=timeout) as r:
                    return _read(r)
            doc = _attempt(_fresh)
            f = _hidden(doc)
            f.update(filters)
            f[P + "wtUT_SearchButton"] = "بحث"
            view = _attempt(lambda: post(f))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "phase": "search/resume",
                "err": "%s: %s" % (type(e).__name__, e)}

    total = None
    i = view.find("wtcntTotalNumberOfPages")
    if i > 0:
        j = view.find(">", i)
        seg = re.sub(r"<[^>]+>", " ", view[j:j + 800])
        m = re.search(r"\d[\d,]*", seg)
        if m:
            total = int(m.group(0).replace(",", ""))

    rows, seen, cur, visited = [], set(), (resumed_at + 1) if resumed_at else 1, []
    def _left():
        try:
            return context.get_remaining_time_in_millis() / 1000.0
        except Exception:  # noqa: BLE001
            return 9999

    start_page = int(event.get("start_page", 1))
    ff_delay = float(event.get("ff_delay", 0.05))
    ff_hops = 0
    while cur < start_page:
        if _left() < 150:
            break
        tg = _num_targets(view)
        cand = [n for n in tg if cur < n <= start_page]
        if not cand:
            break
        n = max(cand)
        fields = dict(filters)
        fields["__OSVSTATE"] = _hidden(view).get("__OSVSTATE", "")
        fields["__EVENTTARGET"] = tg[n][1]
        fields["__EVENTARGUMENT"] = ""
        fields["__AJAX"] = "1440,3200,%s,2400,300,0,0,700,2450," % tg[n][0]
        try:
            raw = post(fields)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "phase": "ff->%d" % n, "reached": cur,
                    "err": "%s: %s" % (type(e).__name__, e)}
        inner = _unescape_partial(raw)
        view = (inner + "\n" + raw) if inner else raw
        cur = n
        ff_hops += 1
        time.sleep(ff_delay)

    stopped_early = False
    disconnected = None
    for _ in range(pages):
        if _left() < 120:
            stopped_early = True
            break
        for rec in _rows(view):
            k = (rec["subtype"], rec["serial"], rec["case_year"], rec["decision_no"])
            if k not in seen:
                seen.add(k)
                rows.append(rec)
        visited.append(cur)
        nxt = str(cur + 1)
        target = None
        for oid, uniq, label in ANCHOR.findall(view):
            if label.strip() == nxt:
                target = (oid, uniq)
                break
        if not target:
            break
        st = _hidden(view)
        fields = dict(filters)
        fields["__OSVSTATE"] = st.get("__OSVSTATE", "")
        fields["__EVENTTARGET"] = target[1]
        fields["__EVENTARGUMENT"] = ""
        fields["__AJAX"] = "1440,3200,%s,2400,300,0,0,700,2450," % target[0]
        raw = None
        last_err = None
        for attempt in range(4):
            try:
                raw = post(fields)
                break
            except Exception as e:  # noqa: BLE001
                last_err = "%s: %s" % (type(e).__name__, e)
                if _left() < 150:
                    break
                time.sleep(5 * (attempt + 1) ** 2)
        if raw is None:
            # keep whatever we already have: write rows + state, report the drop
            disconnected = last_err
            break
        time.sleep(float(event.get('delay', 0.3)))
        inner = _unescape_partial(raw)
        view = (inner + "\n" + raw) if inner else raw
        cur += 1

    if event.get("save_state_key"):
        tg = _num_targets(view)
        nxt = tg.get(cur + 1)
        if nxt:
            _s3_put(event["save_state_key"],
                    {"cookies": _dump_cookies(cj), "osvstate": _hidden(view).get("__OSVSTATE", ""),
                     "page": cur, "next_target": list(nxt), "stage": stage})
    res = {"ok": True, "stage_filter": stage, "total_pages": total,
           "pages_visited": [visited[0], visited[-1]] if visited else [],
           "page_count": len(visited), "row_count": len(rows),
           "start_page": start_page, "ff_hops": ff_hops, "last_page": cur,
           "resumed_at": resumed_at, "stopped_early": stopped_early,
           "disconnected": disconnected}
    if event.get("s3_key"):
        res["s3"] = _s3_put(event["s3_key"], rows)
        return res
    res["rows_gz"] = base64.b64encode(gzip.compress(
        json.dumps(rows, ensure_ascii=False).encode("utf-8"), 6)).decode()
    return res
