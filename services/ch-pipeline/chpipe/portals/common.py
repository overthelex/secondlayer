"""What every portal spider shares: the record it hands the discovery stage,
the three date grammars of the Swiss federal administration, the two page
shapes admin.ch sites come in, and the doc_id discipline the decisions
queue demands.

A portal spider is a source that is NOT on entscheidsuche.ch -- a federal
regulator or a court that publishes on its own site. Its rows go into
ch_court_decisions like any other spider's (LEXAI-2039, gap plan phase 2)
and the existing fetch / extract / ocr / load / citations stages take them
from there: fetch_stage reads html_url/pdf_url off the row and knows
nothing about entscheidsuche (fetch_stage.py `_pick_source`). The only
things a portal must get right are the columns those stages key on:

  * doc_id: unique, and a FILENAME -- fetch writes {raw_dir}/{spider}/{doc_id}.{ext},
    so it must match fetch_stage._SAFE_NAME (`^[\\w.\\- ]+\\Z`). safe_doc_id()
    below is the one way to make one.
  * ecli: `ECLI:CH:{spider}:{doc_id}`, the shape es_document gives every
    non-ECLI entscheidsuche document (tests/test_es_document.py pins it).
  * text_source: 'pdf' or 'html' -- extract_stage defaults NULL to pdf.
  * languages[1]: the search tool's `lang` filter reads it.

Page shapes:
  * `download_items()` -- the admin.ch "download-item" list (ElCom, ESchK,
    ComCom, MKG): `<a class="download-item" href=...><h4 class="download-item__title">`
    with an optional description and a meta-info date.
  * `nuxt_payload()` -- the newer admin.ch Nuxt sites (ESBK, PostCom) render
    no links at all; the page carries its content as a devalue-encoded
    `__NUXT_DATA__` JSON array (index-based references), and the PDF objects
    inside it are `{key, url, size, mimeType, filename}`.
"""
from __future__ import annotations

import hashlib
import html as htmllib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from urllib.parse import unquote, urljoin

LANGS = ("de", "fr", "it", "rm")   # rm: UBI decides on Radio Rumantsch complaints

_MONTHS = {
    # de
    "januar": 1, "februar": 2, "märz": 3, "maerz": 3, "april": 4, "mai": 5, "juni": 6, "juli": 7,
    "august": 8, "september": 9, "oktober": 10, "november": 11, "dezember": 12,
    "jan": 1, "feb": 2, "mär": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9,
    "okt": 10, "nov": 11, "dez": 12,
    # fr
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4, "juin": 6, "juillet": 7,
    "août": 8, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12,
    "janv": 1, "févr": 2, "avr": 4, "juil": 7, "déc": 12,
    # it
    "gennaio": 1, "febbraio": 2, "marzo": 3, "aprile": 4, "maggio": 5, "giugno": 6, "luglio": 7,
    "agosto": 8, "settembre": 9, "ottobre": 10, "dicembre": 12,
    "gen": 1, "mag": 5, "giu": 6, "lug": 7, "ago": 8, "set": 9, "ott": 10, "dic": 12,
}
_NUMERIC = re.compile(r"(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)")
_ISO = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)")
_WORDY = re.compile(r"(?<!\d)(\d{1,2})(?:\.|er|re|°)?\s+([A-Za-zÀ-ÿ]{3,10})\.?\s+(\d{4})(?!\d)")


def parse_date(text: str | None) -> date | None:
    """The first date in `text`: 13.07.2026, 2024-12-19, 23. Januar 2024,
    18 mai 2005, 1er février 2020, 3 agosto 2021. None when there is none
    or the day/month is impossible."""
    if not text:
        return None
    for m in _NUMERIC.finditer(text):
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return date(y, mo, d)
        except ValueError:
            continue
    m = _ISO.search(text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    for m in _WORDY.finditer(text):
        mo = _MONTHS.get(m.group(2).lower().rstrip("."))
        if not mo:
            continue
        try:
            return date(int(m.group(3)), mo, int(m.group(1)))
        except ValueError:
            continue
    return None


def last_date(text: str | None) -> date | None:
    """The LAST date in `text`, whatever grammar it is written in -- ElCom
    titles end in the decision date ("211-00500 Anrechenbarkeit ..., 2.6.2026")
    while an earlier number in the title can look like one."""
    if not text:
        return None
    best: tuple[int, date] | None = None
    for m in _NUMERIC.finditer(text):
        try:
            d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            continue
        if best is None or m.start() > best[0]:
            best = (m.start(), d)
    for m in _ISO.finditer(text):
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            continue
        if best is None or m.start() > best[0]:
            best = (m.start(), d)
    for m in _WORDY.finditer(text):
        mo = _MONTHS.get(m.group(2).lower().rstrip("."))
        if not mo:
            continue
        try:
            d = date(int(m.group(3)), mo, int(m.group(1)))
        except ValueError:
            continue
        if best is None or m.start() > best[0]:
            best = (m.start(), d)
    return best[1] if best else None


_SAFE = re.compile(r"[^\w.\- ]+")        # what fetch_stage._SAFE_NAME refuses
_ID_CHARS = re.compile(r"[^\w.\-]+")       # stricter for ids we mint: no spaces either


def safe_doc_id(*parts: str, max_len: int = 120) -> str:
    """A doc_id from free text: ASCII-folded, anything outside [A-Za-z0-9_.-]
    replaced by '_' (fetch_stage would accept a space, but a filename with
    spaces is a shell hazard for the operator), runs collapsed, length
    capped. Deterministic, so the same document yields the same id on every
    walk."""
    if max_len < 10:        # a capped name is at least one character plus "_" and the 8-hex digest
        raise ValueError(f"max_len {max_len} leaves no room for a name and its digest")
    raw = "_".join(p for p in parts if p)
    folded = unicodedata.normalize("NFKD", unquote(raw)).encode("ascii", "ignore").decode()
    folded = _ID_CHARS.sub("_", folded).strip("_ .")
    folded = re.sub(r"_+", "_", folded)
    if len(folded) > max_len:
        # Two names that differ only past the cap must not become one id: the
        # digest of the whole (pre-fold) input rides along.
        digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
        folded = folded[: max_len - 9].rstrip("_ .") + "_" + digest
    return folded or "doc"


def lang_from_dam(url: str | None) -> str | None:
    """admin.ch DAM links carry the language: /dam/de/sd-web/..."""
    m = re.search(r"/dam/(de|fr|it)/", url or "")
    return m.group(1) if m else None


# Whole words, so "Italien" (the country, in a German title) is not "italiano"
# and "decision" is not "decisione". German first: a German title always
# carries its Verfügung / Entscheid, a French one its décision / requête.
_LANG_WORDS = (
    (r"deutsch|allemand|tedesco", "de"),
    (r"französisch|français|francais|francese", "fr"),
    (r"italienisch|italiano", "it"),
    (r"rumantsch|rätoromanisch|romanche|romancio", "rm"),
    # the document's own language as a title word (PostCom's fr/it files on the de
    # page; ComCom's and ElCom's fr/it decisions listed under /dam/de/)
    (r"verfügung|verfuegung|entscheide?|beschluss|urteil", "de"),
    (r"décision|decision|requête|requete|interconnexion|concession de|recours|prestations", "fr"),
    (r"decisione|ricorso|richiesta|concessione", "it"),
)
_LANG_RES = tuple((re.compile(rf"(?<![^\W_])(?:{words})(?![^\W_])"), code) for words, code in _LANG_WORDS)   # letters/digits bound the word; "_" does not


def lang_from_name(name: str | None) -> str | None:
    """Language words and one-letter suffixes as the portals write them:
    'Deutsch' / 'Französisch' / 'Italienisch', 'Deutsch|Français|Italiano',
    the document's own title words, a trailing '-d' / '-f' / '-i' before
    the extension (ESBK)."""
    if not name:
        return None
    low = name.lower()
    for rx, code in _LANG_RES:
        if rx.search(low):
            return code
    m = re.search(r"[-_](d|f|i)(?:\.pdf)?$", low)
    if m:
        return {"d": "de", "f": "fr", "i": "it"}[m.group(1)]
    return None


@dataclass
class PortalDoc:
    doc_id: str
    url: str                         # what fetch_stage downloads
    text_source: str = "pdf"         # 'pdf' | 'html'
    title: str | None = None
    decision_date: date | None = None
    docket_number: str | None = None
    lang: str | None = None
    chamber: str | None = None
    decision_type: str | None = None            # overrides the portal's DECISION_TYPE (ESBK: Strafbescheid vs Verfügung)
    extra: dict = field(default_factory=dict)   # goes into metadata_json['portal']

    def __post_init__(self):
        if self.text_source not in ("pdf", "html"):
            raise ValueError(f"text_source must be pdf or html, got {self.text_source!r}")
        if _SAFE.search(self.doc_id) or not self.doc_id.strip():
            raise ValueError(f"doc_id {self.doc_id!r} is not a safe filename; use safe_doc_id()")
        if self.lang is not None and self.lang not in LANGS:
            self.lang = None


# --- admin.ch "download-item" lists -------------------------------------------

_ITEM = re.compile(
    r'<a[^>]*class="download-item"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_TITLE = re.compile(r'<h4 class="download-item__title"[^>]*>(.*?)</h4>', re.S)
_DESC = re.compile(r'<p class="download-item__description"[^>]*>(.*?)</p>', re.S)
_META = re.compile(r'<span class="meta-info__item"[^>]*>(.*?)</span>', re.S)
_TAGS = re.compile(r"<[^>]+>")


def _clean(s: str | None) -> str:
    return re.sub(r"\s+", " ", htmllib.unescape(_TAGS.sub(" ", s or ""))).strip()


@dataclass
class DownloadItem:
    href: str
    title: str
    description: str
    meta: list[str]          # e.g. ['PDF', '584.19 kB', '13. August 2026']

    @property
    def meta_date(self) -> date | None:
        return parse_date(" ".join(self.meta))


def download_items(page_html: str, base: str) -> list[DownloadItem]:
    out = []
    for m in _ITEM.finditer(page_html):
        href, body = htmllib.unescape(m.group(1)), m.group(2)
        t = _TITLE.search(body)
        d = _DESC.search(body)
        out.append(DownloadItem(
            href=urljoin(base, href),
            title=_clean(t.group(1) if t else ""),
            description=_clean(d.group(1) if d else ""),
            meta=[_clean(x) for x in _META.findall(body)],
        ))
    return out


# --- admin.ch Nuxt sites: the devalue payload ---------------------------------

_NUXT = re.compile(r'<script type="application/json"[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', re.S)
_WRAPPERS = {"ShallowReactive", "Reactive", "Ref", "ShallowRef", "NuxtError"}


def nuxt_payload(page_html: str):
    """The page's `__NUXT_DATA__` decoded from devalue's index-referenced
    array into plain Python (dicts, lists, scalars). Cycles are cut."""
    m = _NUXT.search(page_html)
    if not m:
        return None
    arr = json.loads(m.group(1))
    memo: dict[int, object] = {}
    active: set[int] = set()

    def res(i):
        if not isinstance(i, int) or i < 0 or i >= len(arr):
            return i
        if i in memo:
            return memo[i]
        if i in active:
            return None
        active.add(i)
        v = arr[i]
        if isinstance(v, list):
            if v and isinstance(v[0], str) and v[0] in _WRAPPERS and len(v) == 2:
                out = res(v[1])
            else:
                out = [res(x) for x in v]
        elif isinstance(v, dict):
            out = {k: res(x) for k, x in v.items()}
        else:
            out = v
        active.discard(i)
        memo[i] = out
        return out

    return res(0)


def nuxt_files(payload, mime: str = "application/pdf") -> list[dict]:
    """Every file object `{key, url, filename, mimeType, size}` in a decoded
    payload, deduplicated by url, in document order."""
    seen: set[str] = set()
    out: list[dict] = []

    def walk(o):
        if isinstance(o, dict):
            if o.get("mimeType") == mime and isinstance(o.get("url"), str):
                if o["url"] not in seen:
                    seen.add(o["url"])
                    out.append(o)
                return
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(payload)
    return out


def links(page_html: str, base: str, pattern: str = r"\.pdf") -> list[tuple[str, str]]:
    """(href, anchor text) for every <a> whose href matches `pattern`."""
    out = []
    for m in re.finditer(r'<a\s[^>]*href="([^"]+)"[^>]*>(.*?)</a>', page_html, flags=re.S | re.I):
        href = htmllib.unescape(m.group(1))
        if re.search(pattern, href, flags=re.I):
            out.append((urljoin(base, href), _clean(m.group(2))))
    return out


def filename_of(url: str) -> str:
    return unquote(url.rsplit("/", 1)[-1].split("?", 1)[0])


def stem_of(url: str) -> str:
    name = filename_of(url)
    return re.sub(r"\.(pdf|html?|htm)$", "", name, flags=re.I)
