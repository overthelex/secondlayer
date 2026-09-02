"""onlinekommentar.ch: the API, and the parsing of what it returns.

Measured 2026-09-02:

  * `GET /api/commentaries?page=N&language=L` lists 50 per page, 8 pages,
    391 commentaries for EACH of de/fr/it/en. A translation is its own
    record with its own uuid (the de and fr id sets do not intersect), so
    the walk is per language and the natural key is (source, uuid). Without
    `language=` the list is the English one.
  * `GET /api/commentaries/{uuid}` returns the record in its own language
    (the `language` query parameter is ignored there): `content` is the
    commentary as HTML with numbered paragraphs, `legal_text` the provision
    as HTML, `authors`/`editors` lists of {id, name}, `date` the last
    edition of the text, `legislative_act` {id, title} with an ENGLISH
    title whatever the record's language -- and one record (Art. 80c IRSG)
    has no `legislative_act` at all.
  * The title carries the act's abbreviation in the record's language:
    "Art. 1b BankG" / "Art. 1b LB" / "Art. 1b LBCR" / "Art. 1b BA". Ten
    titles per language are not about one article ("Vorb. zu Art. 13-14a
    StHG", "Einleitung KGTG", "Übergangsbestimmungen zur
    Aktienrechtsrevision vom 19. Juni 2020").

Licence: CC BY 4.0, https://onlinekommentar.ch/de/creative-commons-license.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from urllib.parse import urlencode

import lxml.html

from .http import Fetcher

API = "https://onlinekommentar.ch/api/commentaries"
SOURCE = "onlinekommentar"
LICENCE = "CC-BY-4.0"
LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/"
LANGS = ("de", "fr", "it", "en")

# The source's act uuid -> SR number. Language-independent (the same uuid
# appears on the de, fr, it and en records), so it is the reliable key; the
# abbreviation in the title is the fallback for a uuid not listed here.
# Every SR number below was checked against ch_act on lawrider-gcp on
# 2026-09-02 (jurisdiction CH, in force).
ACT_BY_UUID: dict[str, str] = {
    "8223e697-4ffc-4c9b-974b-96836bbbca4f": "101",        # Federal Constitution (BV)
    "4a0601f8-c727-4293-bb18-2585a92dd9fe": "152.3",      # Freedom of Information Act (BGÖ)
    "4512c1a0-c01a-49cb-8c2d-be3f87f796d0": "161.1",      # Political Rights (BPR)
    "f04c23a0-391f-41c4-9385-35faf7230f90": "210",        # Civil Code (ZGB)
    "d2870610-6720-4037-be1c-d870b3189c0f": "220",        # Code of Obligations (OR)
    "becaa5f2-8e13-483f-9073-6f7b497b729a": "221.411",    # Commercial Register Ordinance (HRegV)
    "1ecd0f17-8299-4ab0-8e0c-42fd50fa526d": "235.1",      # Data Protection (DSG)
    "0bc52020-2c96-4c97-8410-8e44ac370dd5": "251",        # Cartel Act (KG)
    "2cdeaaed-30b6-416e-a6ca-7eaef78dfd69": "272",        # Civil Procedure Code (ZPO)
    "cf1153b8-58b2-47eb-a7a3-ec280166bd0d": "281.1",      # DEBA (SchKG)
    "0e999038-1e85-4b97-b912-4d216f850fdc": "291",        # Private International Law (IPRG)
    "9e7f5589-45b9-48c3-a19d-05ffe54f3e41": "311.0",      # Criminal Code (StGB)
    "191d45d8-ed6a-47ab-9fb9-17c0744effda": "312.0",      # Criminal Procedure Code (StPO)
    "1c7f2762-fc1b-4a51-9b40-3b2086197f87": "351.1",      # Mutual Assistance in Criminal Matters (IRSG)
    "02b30208-85de-4c14-b5fb-0cb408145400": "444.1",      # Transfer of Cultural Property (KGTG)
    "e6629fbc-4495-4942-93a5-609f08501cba": "642.11",     # Direct Federal Tax (DBG)
    "8585ec22-f3d5-4d69-9fdf-b291e2f21a81": "642.14",     # Tax Harmonisation (StHG)
    "cb34bc55-848e-4b3e-8a8d-a03b3e1d1b41": "812.21",     # Therapeutic Products (HMG)
    "d1c89c53-4275-423b-9884-f99c9e136f51": "812.213",    # Medical Devices Ordinance (MepV)
    "d673263a-b469-42eb-af67-7c01a19779d7": "952.0",      # Banking Act (BankG)
    "8cc7e9b6-eff3-4400-8463-ff14db576ca7": "955.0",      # Anti-Money Laundering (GwG)
    "e2c3e574-433c-4f6e-bcc6-eafec7fd7125": "0.275.12",   # Lugano Convention (LugÜ)
    "cf0dd38c-fb3a-4090-8794-b3a5e2fea1b3": "0.311.43",   # Cybercrime Convention (CCC)
}


@dataclass(frozen=True)
class ParsedTitle:
    kind: str                       # article | preliminary | introduction | other
    article_number: str | None      # '1b', '119a'; None unless kind == 'article'
    abbr: str | None                # the act as the title writes it, None when not found


# "Art. 1b BankG", "Art. 119a BV", "Art. 1 CCC (Übereinkommen ...)",
# "Art. 6 Abs. 6 und 7 BV". Article = the first number after "Art.", with
# its letter suffix; abbreviation = the last token before any parenthesis.
# Article numbers carry a letter (119a) or a Latin ordinal (179quater,
# 322decies -- the StGB corruption articles are all of that shape; six of
# them were parsed as `other` on the first live walk because the suffix
# was capped at three letters). Longest alternative first, or "quater"
# would match as "qua"+"ter" and stop at a non-boundary.
_ARTICLE_RE = re.compile(
    r"^\s*Art\.?\s*(\d+(?:quinquies|septies|quater|sexies|octies|novies|decies|bis|ter|[a-z])?)\b",
    re.IGNORECASE)
_PRELIM_RE = re.compile(r"^\s*(Vorb\.|Vorbemerkung|Remarques|Osservazioni|Preliminary)", re.IGNORECASE)
_INTRO_RE = re.compile(r"^\s*(Einleitung|Introduction|Introduzione)\b", re.IGNORECASE)
_CONNECTORS = {"und", "et", "e", "and", "zu", "à", "a", "al", "abs", "abs.", "cpv.", "cpv"}


def parse_title(title: str) -> ParsedTitle:
    """Which article, which act, and whether it is an article commentary at all.

    The abbreviation is the LAST token of the title before any parenthesis:
    "Art. 1b BankG" -> BankG, "Art. 6 Abs. 6 und 7 BV" -> BV, "Vorb. zu
    Art. 261 – 269 ZPO und Art. 261 ZPO" -> ZPO, "Art. 119a Cst." -> Cst.
    (the dot is part of how the alias table spells it). A title that ends
    in a number or a connector has no abbreviation."""
    head = title.split("(", 1)[0].strip().rstrip(",;:")
    abbr = None
    if head:
        last = head.split()[-1]
        if not re.fullmatch(r"[\d\-–—]+[a-z]?", last) and last.lower() not in _CONNECTORS:
            abbr = last
    if _PRELIM_RE.match(title):
        return ParsedTitle("preliminary", None, abbr)
    if _INTRO_RE.match(title):
        return ParsedTitle("introduction", None, abbr)
    m = _ARTICLE_RE.match(title)
    if m:
        return ParsedTitle("article", m.group(1), abbr)
    return ParsedTitle("other", None, abbr)


def html_to_text(html: str | None) -> str:
    """Plain text of the source's HTML: block elements become line breaks,
    runs of whitespace inside a paragraph collapse, paragraph numbers
    ("<span class=paragraph-nr>12</span>") survive as a leading number."""
    if not html or not html.strip():
        return ""
    doc = lxml.html.fromstring(f"<div>{html}</div>")
    for el in doc.iter():
        if el.tag in {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "br", "tr"}:
            el.tail = "\n" + (el.tail or "")
    text = doc.text_content()
    lines = [re.sub(r"[ \t ]+", " ", line).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def content_hash(html: str) -> str:
    return hashlib.sha256((html or "").encode("utf-8")).hexdigest()


def names(people) -> list[str]:
    out = []
    for person in people or []:
        if isinstance(person, dict):
            name = person.get("name") or " ".join(
                p for p in (person.get("first_name"), person.get("last_name")) if p)
        else:
            name = str(person)
        if name and name.strip():
            out.append(name.strip())
    return out


def record(detail: dict, lang: str) -> dict:
    """The row commentary_stage upserts, minus sr_number (resolved there
    because it needs the database). `lang` is the language the record was
    listed under -- the detail carries its own `language` and the two agree,
    but the listing is what the walk keys on."""
    data = detail.get("data", detail)
    title = (data.get("title") or "").strip()
    parsed = parse_title(title)
    act = data.get("legislative_act") or {}
    content = data.get("content") or ""
    return {
        "source": SOURCE,
        "source_id": data["id"],
        "lang": (data.get("language") or lang).lower(),
        "kind": parsed.kind,
        "act_uuid": act.get("id"),
        "act_title": act.get("title"),
        "abbr": parsed.abbr,
        "article_number": parsed.article_number,
        "title": title,
        "authors": names(data.get("authors")),
        "editors": names(data.get("editors")),
        "version_date": (data.get("date") or None),
        "suggested_citation": data.get("suggested_citation_long") or data.get("suggested_citation_short"),
        "content_html": content,
        "content_text": html_to_text(content),
        "legal_text": html_to_text(data.get("legal_text")) or None,
        "licence": LICENCE,
        "source_url": data.get("html_link") or data.get("link") or f"{API}/{data['id']}",
        "pdf_url": data.get("pdf_link"),
        "content_hash": content_hash(content),
    }


class OnlinekommentarClient:
    def __init__(self, fetcher: Fetcher, base: str = API):
        self._fetcher = fetcher
        self._base = base.rstrip("/")

    async def list_page(self, lang: str, page: int) -> dict:
        return await self._fetcher.json(f"{self._base}?{urlencode({'page': page, 'language': lang})}")

    async def detail(self, uuid: str) -> dict:
        return await self._fetcher.json(f"{self._base}/{uuid}")


def list_items(page: dict) -> list[dict]:
    return page.get("data") or []


def last_page(page: dict) -> int:
    meta = page.get("meta") or {}
    try:
        return max(1, int(meta.get("last_page") or 1))
    except (TypeError, ValueError):
        return 1
