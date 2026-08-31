#!/usr/bin/env python3
"""Find the federal acts each judgment cites.

Emirati judgments name an act as <kind> رقم <number> لسنة <year>, and the shape
is remarkably stable across courts.  What is not stable is the spacing: the PDFs
these texts came from routinely glue words to numbers ("رقم5 لسنة2012") and
scatter parentheses ("رقم ( 38 )لسنة 2022"), so every gap in the pattern has to
be optional.  Arabic-Indic digits appear too.

Where the citation is preceded by an article reference - "المادة 269 / 1 من ..."
- the article numbers are captured with it, which is what lets a judgment be
linked to a specific article rather than only to an act.

Acts cited by name alone ("قانون الإثبات") are deliberately not matched: without
a number and year they cannot be resolved without a name index, and guessing
would put false edges in the graph.
"""
import hashlib
import json
import re
import sys

DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")

# Ordered longest-first so "مرسوم بقانون اتحادي" wins over "قانون".
KINDS = [
    ("المرسوم بقانون اتحادي", "federal_decree_law"),
    ("مرسوم بقانون اتحادي", "federal_decree_law"),
    ("المرسوم بقانون", "decree_law"),
    ("مرسوم بقانون", "decree_law"),
    ("القانون الاتحادي", "federal_law"),
    ("قانون اتحادي", "federal_law"),
    ("المرسوم الاتحادي", "federal_decree"),
    ("مرسوم اتحادي", "federal_decree"),
    ("قرار مجلس الوزراء", "cabinet_resolution"),
    ("قرار وزاري", "ministerial_resolution"),
    ("اللائحة التنفيذية", "regulation"),
    ("القانون", "law"),
    ("قانون", "law"),
    ("القرار", "resolution"),
    ("قرار", "resolution"),
]
KIND_ALT = "|".join(re.escape(k) for k, _ in KINDS)
KIND_LOOKUP = dict(KINDS)

CITATION = re.compile(
    r"(?P<kind>" + KIND_ALT + r")"
    r"[^\S\n]{0,3}(?:\s*ال\w+)?"          # an adjective may sit between kind and رقم
    r"\s*رقم\s*\(?\s*(?P<num>\d{1,4})\s*\)?"
    r"\s*(?P<bis>مكرر)?"
    r"\s*\)?\s*لسن[ةه]\s*\(?\s*(?P<year>\d{4})")

# "المادة (5)", "المادتين 11، 12", "المواد 1 - 4" immediately before the act.
ARTICLES = re.compile(r"(?:المواد|المادتين|المادتان|المادة|للمادة|بالمادة)"
                      r"\s*\(?\s*([\d\s،,/\-\)\(و]{1,60})")
ART_NUM = re.compile(r"\d{1,4}")


def normalise(text):
    return text.translate(DIGITS)


def extract(doc_id, text):
    """Yield one record per act cited, with any article numbers named beside it."""
    text = normalise(text)
    seen = {}
    for seq, m in enumerate(CITATION.finditer(text)):
        kind_ar = m.group("kind")
        number = m.group("num")
        year = int(m.group("year"))
        if not 1970 <= year <= 2030:
            continue
        window = text[max(0, m.start() - 130):m.start()]
        articles = []
        am = None
        for am in ARTICLES.finditer(window):
            pass                      # the closest article reference is the last one
        if am is not None and m.start() - (max(0, m.start() - 130) + am.end()) <= 12:
            articles = ART_NUM.findall(am.group(1))[:8]
        key = (KIND_LOOKUP[kind_ar], number, year)
        rec = seen.get(key)
        if rec is None:
            raw = re.sub(r"\s+", " ",
                         text[max(0, m.start() - 40):m.end() + 60]).strip()
            seen[key] = {
                "doc_id": doc_id,
                "law_type": KIND_LOOKUP[kind_ar],
                "kind_ar": kind_ar,
                "law_number": number,
                "law_year": year,
                "articles": articles,
                "mentions": 1,
                "raw": raw,
                "seq": seq,
            }
        else:
            rec["mentions"] += 1
            for a in articles:
                if a not in rec["articles"]:
                    rec["articles"].append(a)
    for rec in seen.values():
        rec["citation_id"] = "%s:%s" % (
            rec["doc_id"],
            hashlib.sha1(("%s|%s|%s" % (rec["law_type"], rec["law_number"],
                                        rec["law_year"])).encode()).hexdigest()[:10])
        yield rec


if __name__ == "__main__":
    # Ad-hoc use: a file of {"doc_id":..., "full_text":...} JSON lines.
    for line in sys.stdin:
        row = json.loads(line)
        for rec in extract(row["doc_id"], row["full_text"] or ""):
            print(json.dumps(rec, ensure_ascii=False))
