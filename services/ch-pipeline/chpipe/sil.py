"""The SIL platform (Système d'Information Législatif): Geneva's rsGE on
silgeneve.ch and Neuchâtel's RSN on rsn.ne.ch. Both publish the collection
as static files written by Microsoft Word's "filtered" HTML export:

    {book}/content.htm      the systematic table of contents, one <a> per
                            act in force: href='htm/{file}.htm', text
                            '{number} {title}'
    {book}/htm/{file}.htm   one act, the consolidated text in force

Measured 2026-08-26: GE content.htm lists 863 acts, NE 825 -- exactly the
is_active counts LexFind holds for the two cantons (863 / 825), so the TOC
IS the in-force set and LexFind's abrogated acts (451 GE, 878 NE) have no
HTML here at all. Every page declares charset=windows-1252 and none of the
eight sampled decodes as UTF-8 (0x92 for the apostrophe, 0xE9 for é), so
the declaration is trusted, with cp1252 as the default when a page has
none. Word writes `&nbsp;` (GE: 97 in one act) and raw 0xA0 (NE: 119-229
per act) interchangeably, and no soft hyphens at all; both are folded here
so article text compares equal across the two cantons.

Article boundaries differ per canton and are found by CLASS, not by
regex over flat text (opencaselaw's approach, which splits GE's "Art. 4
Autorisation préalable" correctly but on NE glues "Art. 10" to the alinea
that follows on the same paragraph):

    GE  <p class=article>Art. 4   Autorisation préalable</p>  heading, the
        marginal note in the heading itself; body in the p.Texte /
        p.TexteTL / p.retrait* paragraphs that follow; p.sousmargi is a
        sub-heading inside the article. Footnote references are
        <sup><a href="!W!TAB_...#FN12">(12)</a></sup>, resolved against
        the modification table at the foot of the page (p.Ttexte "12. n.t.
        : ..."). Historical acts (A 1 01, 1815) number "Art.e I." in roman.
    NE  <p class=xNormal><b>Art. 10</b>[2] <sup>1</sup>Le Conseil ...</p>
        number and first alinea in ONE paragraph, the marginal note in the
        p.xMarginale (+ p.xMarginaleRetrait) paragraphs BEFORE it, "Article
        premier" for article 1. Footnote references <a href="#_ftn3">[2]</a>,
        bodies in p.MsoFootnoteText "[2] Teneur selon L du ...". An
        abrogated article is a heading with no body ("Art. 13[12]"), kept
        as an article with empty text and the footnote as its note.

Alinea numbers are <sup>n</sup> immediately followed by the text on NE
("1Le Conseil"); a space is inserted after every <sup> so the stored text
reads "1 Le Conseil" on both hosts (GE already writes &nbsp; after it).

Structural headings (GE p.titre/chapitre/section, NE p.xTitre/xChapitre/
xNomChapitre/xSection) close the open article and become parent_e_id, the
way Lexwork's title nodes do. The GE modification table (from p.Tteteintit
on) and NE's footnote block end the article region; both are kept in
full_text.
"""
from __future__ import annotations

import datetime
import html as html_entities
import re
from dataclasses import dataclass, field

from lxml import html as lxml_html

from . import akn

BOOKS: dict[str, str] = {
    "GE": "/legis/program/books/rsg",
    "NE": "/DATA/program/books/rsne",
}

_CHARSET = re.compile(rb"charset=['\"]?([A-Za-z0-9_-]+)", re.IGNORECASE)
_TOC_LINK = re.compile(r"href=['\"](htm/[^'\"]+\.htm)['\"][^>]*>(.*?)</a>", re.IGNORECASE | re.DOTALL)
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")

# GE: a letter, two spaced numeric groups, an optional sub-number
# ("A 1 01", "J 4 18.01"). NE: dotted numerics, an optional letter
# ("101", "916.510.1", "831.2a"). Numeric first, the same order the
# registry uses: GE's shape can never match a NE title.
_NUMBER_NE = re.compile(r"^(\d[\d.]*[a-z]?)\s+(.*)$", re.DOTALL)
_NUMBER_GE = re.compile(r"^([A-Z]\s+\d+\s+\d+(?:\.\d+)?)\s+(.*)$", re.DOTALL)

# "Art. 4", "Art. 7A", "Art. 13a", "Art. 2 bis", "Art.e I." (GE, 1815),
# "Article premier", "§ 3". The lookahead refuses "Art. 4bisserie" and
# "Articles 27 à 30" (a range heading, not an article).
_ARTICLE_START = re.compile(
    r"^(?:Article\s+premier|(?:Art\.?e?|§)\s*"
    r"(\d+(?:\s?(?:bis|ter|quater|quinquies|sexies|septies|octies)\b|[A-Za-z]\b)?|[IVXLC]+)\.?)"
    r"(?=\s|$|\[|\()")

_MONTHS = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
    "juillet": 7, "août": 8, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11,
    "décembre": 12, "decembre": 12,
}
_FR_DATE = re.compile(r"(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})", re.IGNORECASE)

_GE_HEADING = "article"
_GE_STRUCTURE = frozenset({"titre", "chapitre", "section"})
_GE_FOOTER_START = "tteteintit"
_GE_FOOTNOTE_BODY = "ttexte"
_NE_STRUCTURE = frozenset({"xtitre", "xchapitre", "xnomchapitre", "xsection"})
_NE_MARGINAL = frozenset({"xmarginale", "xmarginaleretrait"})
_NE_FOOTNOTE_BODY = "msofootnotetext"
_NE_ARTICLE_CLASSES = frozenset({"xnormal", "msonormal"})
_NE_HEADING_CLASSES = frozenset({"xnormal", "msonormal", "xdateadoption"})

_BLOCKS = ("p", "h1", "h2", "h3", "h4", "h5", "h6")


@dataclass
class ParsedAct:
    articles: list[akn.Article]
    text: str
    meta: dict = field(default_factory=dict)


def toc_url(host: str, canton: str) -> str:
    return f"https://{host}{BOOKS[canton]}/content.htm"


def act_url(host: str, canton: str, href: str) -> str:
    """'htm/rsg_a1_01.htm' as found in content.htm -> the absolute page URL."""
    return f"https://{host}{BOOKS[canton]}/{href.lstrip('/')}"


def decode(raw: bytes) -> str:
    """The declared charset (every SIL page says windows-1252), cp1252 when
    nothing is declared. A page that claims one encoding and is written in
    another would produce mojibake, not an exception -- which is why the
    fetch stage stores the DECODED text and the tests read a real page."""
    m = _CHARSET.search(raw[:4096])
    charset = (m.group(1).decode("ascii", "replace") if m else "windows-1252").lower()
    if charset in ("iso-8859-1", "latin-1", "latin1"):
        # Browsers treat Latin-1 as cp1252 (WHATWG); the 0x80-0x9F range
        # holds Word's curly quotes, which Latin-1 proper would drop.
        charset = "windows-1252"
    try:
        return raw.decode(charset)
    except (LookupError, UnicodeDecodeError):
        return raw.decode("windows-1252", errors="replace")


def _clean(text: str) -> str:
    return _WS.sub(" ", text.replace("\xa0", " ").replace("­", "")).strip()


def split_number_and_title(raw: str) -> tuple[str | None, str]:
    """'A 1 01 Acte d'union ...' -> ('A 1 01', "Acte d'union ...");
    '916.510.1 Arrêté ...' -> ('916.510.1', 'Arrêté ...'). (None, raw)
    when neither shape matches: a guessed number resolves a lookup to the
    wrong act, a missing one is visible in Gate F."""
    raw = _clean(raw)
    for pattern in (_NUMBER_NE, _NUMBER_GE):
        m = pattern.match(raw)
        if m and m.group(2).strip():
            return _WS.sub(" ", m.group(1)).rstrip("."), m.group(2).strip()
    return None, raw


def parse_toc(html: str) -> list[dict]:
    """Every act linked from content.htm, in document order:
    {sr_number, title, href}. href is relative ('htm/rsg_a1_01.htm');
    act_url() makes it absolute. Duplicated hrefs (none seen on either
    host) keep the first occurrence."""
    seen: set[str] = set()
    out: list[dict] = []
    for href, inner in _TOC_LINK.findall(html):
        if href in seen:
            continue
        seen.add(href)
        label = lxml_html.fromstring(f"<a>{inner}</a>").text_content() if "<" in inner else inner
        label = _clean(_unescape(label))
        number, title = split_number_and_title(label)
        out.append({"sr_number": number, "title": title, "href": href})
    return out


def _unescape(text: str) -> str:
    return html_entities.unescape(text)


def parse_fr_date(text: str | None) -> datetime.date | None:
    """First French date in a string: 'du 16 juin 1988' -> 1988-06-16,
    'Etat au 1er janvier 2026' -> 2026-01-01. None when absent or the
    month is not a French month name."""
    if not text:
        return None
    for m in _FR_DATE.finditer(text):
        month = _MONTHS.get(m.group(2).lower())
        if month is None:
            continue
        try:
            return datetime.date(int(m.group(3)), month, int(m.group(1)))
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Block extraction
# ---------------------------------------------------------------------------

@dataclass
class _Block:
    tag: str
    cls: str
    text: str
    refs: list[str]      # footnote numbers referenced from this block


def _block_text(el) -> tuple[str, list[str]]:
    """Text of one block with footnote references removed and returned
    separately, a space after every <sup>, nbsp folded."""
    refs: list[str] = []
    for a in list(el.iter("a")):
        href = a.get("href") or ""
        if re.match(r"^#_ftn\d", href) or "!W!TAB" in href or "#FN" in href:
            mark = _clean(a.text_content())
            m = re.match(r"^[\[(]?([0-9]+|[a-z])[\])]?$", mark)
            if m:
                refs.append(m.group(1))
            _drop(a)
    for sup in list(el.iter("sup")):
        inner = _clean(sup.text_content())
        for child in list(sup):
            sup.remove(child)
        sup.text = (inner + " ") if inner else ""
    return _clean(el.text_content()), refs


def _drop(el) -> None:
    parent = el.getparent()
    if parent is None:
        return
    if el.tail:
        prev = el.getprevious()
        if prev is not None:
            prev.tail = (prev.tail or "") + el.tail
        else:
            parent.text = (parent.text or "") + el.tail
    parent.remove(el)


def _blocks(html: str) -> tuple[list[_Block], str | None]:
    doc = lxml_html.fromstring(html)
    title_el = doc.find(".//title")
    page_title = _clean(title_el.text_content()) if title_el is not None else None
    body = doc.find("body")
    if body is None:
        body = doc
    out: list[_Block] = []
    for el in body.iter(*_BLOCKS):
        # a <p> nested in another block (Word does this inside table cells)
        # is reached by iter() on its own; skip the container's copy
        if el.tag == "p" and any(anc.tag in _BLOCKS for anc in el.iterancestors()):
            continue
        text, refs = _block_text(el)
        out.append(_Block(el.tag, (el.get("class") or "").strip().lower(), text, refs))
    return out, page_title


# ---------------------------------------------------------------------------
# Articles
# ---------------------------------------------------------------------------

_ROMAN = re.compile(r"^[IVXLC]+$")


def _article_number(heading: str) -> str | None:
    if heading.lower().startswith("article premier"):
        return "1"
    m = _ARTICLE_START.match(heading)
    if not m or not m.group(1):
        return None
    raw = m.group(1).replace(" ", "")
    if _ROMAN.match(raw):
        return raw
    return akn.normalise_number(raw)


def _split_heading(text: str) -> tuple[str | None, str]:
    """('4', 'Autorisation préalable') from 'Art. 4 Autorisation préalable';
    ('1', 'Le Département ...') from 'Article premier Le Département ...'."""
    m = _ARTICLE_START.match(text)
    if not m:
        return None, text
    return _article_number(text), text[m.end():].strip(" .:")


class _Builder:
    def __init__(self) -> None:
        self.articles: list[akn.Article] = []
        self.lines: list[str] = []
        self.footnotes: dict[str, str] = {}
        self.parent: str | None = None
        self.structure_count = 0
        self._open: dict | None = None
        self._pending_marginal: list[str] = []
        self._e_ids: set[str] = set()

    def line(self, text: str) -> None:
        if text:
            self.lines.append(text)

    def structure(self, text: str) -> None:
        self.close()
        self.structure_count += 1
        self.parent = f"sec_{self.structure_count}"
        self.line(text)

    def marginal(self, text: str) -> None:
        self.close()
        self._pending_marginal.append(text)
        self.line(text)

    def open(self, number: str | None, marginal: str | None, first_line: str | None,
             refs: list[str]) -> None:
        self.close()
        self._open = {"number": number, "marginal": marginal, "body": [],
                      "refs": list(refs), "parent": self.parent}
        if first_line:
            self._open["body"].append(first_line)
        self._pending_marginal = []

    def take_marginal(self) -> str | None:
        note = " ".join(self._pending_marginal) or None
        self._pending_marginal = []
        return note

    def body(self, text: str, refs: list[str]) -> bool:
        if self._open is None:
            return False
        if text:
            self._open["body"].append(text)
        self._open["refs"].extend(refs)
        return True

    def close(self) -> None:
        if self._open is None:
            return
        art = self._open
        self._open = None
        base = f"art_{art['number']}" if art["number"] else f"art_x{len(self.articles) + 1}"
        e_id = base
        n = 1
        while e_id in self._e_ids:
            n += 1
            e_id = f"{base}_{n}"
        self._e_ids.add(e_id)
        self.articles.append(akn.Article(
            e_id=e_id,
            article_number=art["number"],
            marginal_note=art["marginal"] or None,
            text=" ".join(art["body"]).strip(),
            ordinal=len(self.articles),
            parent_e_id=art["parent"],
            notes=tuple(art["refs"]),        # resolved against footnotes below
        ))

    def resolve_notes(self) -> None:
        resolved = []
        for a in self.articles:
            notes = []
            for ref in a.notes:
                body = self.footnotes.get(ref)
                if body and body not in notes:
                    notes.append(body)
            resolved.append(akn.Article(a.e_id, a.article_number, a.marginal_note, a.text,
                                        a.ordinal, a.parent_e_id, tuple(notes)))
        self.articles = resolved


_FOOTNOTE_NE = re.compile(r"^\[(\d+)\]\s*(.*)$", re.DOTALL)
_FOOTNOTE_GE = re.compile(r"^(\d+|[a-z])\.\s+(.*)$", re.DOTALL)


def parse_act(html: str) -> ParsedAct:
    """One SIL act page -> (articles, full_text, meta).

    meta: title, sr_number (as printed on the page), date_adoption,
    date_entry_force, date_state (the 'Etat au' / 'Dernières modifications
    au' date: the consolidation the page shows), footnotes (count). Dates
    are datetime.date or None; nothing is defaulted."""
    blocks, page_title = _blocks(html)
    b = _Builder()
    meta: dict = {"title": None, "sr_number": None, "date_adoption": None,
                  "date_entry_force": None, "date_state": None}
    in_footer = False
    footer_key: str | None = None
    adoption_parts: list[str] = []

    for blk in blocks:
        cls, text = blk.cls, blk.text
        if not text and cls != "xdateadoption":
            continue
        b.line(text)

        # -- footers / footnotes -------------------------------------------
        if cls == _GE_FOOTER_START:
            in_footer = True
            b.close()
        if in_footer:
            # GE modification table: p.Ttexte "12. n.t. : ..." then the
            # adoption and entry-into-force dates in p.Tadopt / p.Tvigueur;
            # the three make one note ("n.t. : ... | 27.02.2026 | 27.02.2026")
            if cls == _GE_FOOTNOTE_BODY:
                m = _FOOTNOTE_GE.match(text)
                footer_key = m.group(1) if m else None
                if m and footer_key not in b.footnotes:
                    b.footnotes[footer_key] = m.group(2).strip()
            elif cls in ("tadopt", "tvigueur") and footer_key in b.footnotes:
                b.footnotes[footer_key] += f" | {text}"
            continue
        if cls == _NE_FOOTNOTE_BODY:
            b.close()
            m = _FOOTNOTE_NE.match(text)
            if m:
                b.footnotes.setdefault(m.group(1), m.group(2).strip())
            continue

        # -- front matter --------------------------------------------------
        if cls in ("titreloi", "xnom") and meta["title"] is None:
            meta["title"] = text
            b.close()
            continue
        if cls == "noloi":
            meta["sr_number"] = text
            continue
        if cls == "msonormal" and meta["sr_number"] is None and not b.articles \
                and split_number_and_title(text + " x")[0] == text:
            meta["sr_number"] = text
            continue
        if cls == "xdateadoption":
            if text:
                adoption_parts.append(text)
            continue
        if cls == "date" and meta["date_adoption"] is None:
            meta["date_adoption"] = parse_fr_date(text)
            continue
        if cls == "vigueur" and meta["date_entry_force"] is None:
            meta["date_entry_force"] = parse_fr_date(text)
            continue
        if cls in ("xedition", "textetl") and meta["date_state"] is None \
                and re.match(r"^(Etat au|État au|Dernières modifications au)", text):
            meta["date_state"] = parse_fr_date(text)
            continue

        # -- structure and articles ----------------------------------------
        if cls in _GE_STRUCTURE or cls in _NE_STRUCTURE or blk.tag != "p":
            b.structure(text)
            continue
        if cls in _NE_MARGINAL:
            b.marginal(text)
            continue
        if cls == _GE_HEADING:
            number, marginal = _split_heading(text)
            if number is None:
                # a p.article that is not an article ("Dispositions
                # transitoires" as a heading): a structural line
                b.structure(text)
                continue
            b.open(number, marginal or None, None, blk.refs)
            continue
        if cls in _NE_ARTICLE_CLASSES and _ARTICLE_START.match(text):
            number, rest = _split_heading(text)
            if number is not None:
                b.open(number, b.take_marginal(), rest or None, blk.refs)
                continue
        if not b.body(text, blk.refs):
            pass  # preamble or trailing matter: in full_text only

    b.close()
    b.resolve_notes()
    if adoption_parts and meta["date_adoption"] is None:
        meta["date_adoption"] = parse_fr_date(" ".join(adoption_parts))
    if meta["title"] is None and page_title:
        meta["title"] = re.sub(r"^\S+(?:\s+\S+){0,3}?\s*:\s*", "", page_title, count=1).strip() or page_title
    meta["footnotes"] = len(b.footnotes)
    return ParsedAct(articles=b.articles, text="\n".join(b.lines), meta=meta)
