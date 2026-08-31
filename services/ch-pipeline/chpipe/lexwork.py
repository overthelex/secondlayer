"""Lexwork show_as_json -> akn.Article rows, plain text, provenance.

Lexwork (Sitrox) is the platform behind 19 cantonal collections. One
`texts_of_law/{nr}/versions/{id}/show_as_json` payload holds EVERY language
of one consolidated version as a tree of nodes
{uid, type, number{lang}, text{lang}, html_content{lang},
 html_content_post{lang}, children[]}. The uid ("t-0--t-1--a-6--p-2") is
structural and plays the role AKN's eId plays on the federal side: the
identity diff_articles keys on across editions.

Three things this module refuses to guess:

  * version dates come as localised UI strings ("Version in Kraft von:
    03.03.2024 bis: 31.12.2025 (Beschlussdatum: 03.03.2024)"); an
    unrecognised string raises LexworkParseError, which the stage counts,
    instead of a default date that would later read as a fact;
  * a language absent from available_languages raises, so a row created
    from cantons.py's expectation fails visibly in the parse stage;
  * `<strong>*</strong>` (the platform's "amended in this version" marker)
    is stripped from text, because otherwise every marker flip between two
    editions is a fabricated "modified" row.

"bis: 31.12.2025" is the INCLUSIVE last day in force (the next version
starts 01.01.2026), which is the semantics ch_act_version.date_end_applicability
already has for Fedlex (measured 2026-08-25 on 19,428 consecutive pairs).
"""
from __future__ import annotations

import datetime
import re
from dataclasses import dataclass

from lxml import html as lxml_html

from . import akn

_WS = re.compile(r"\s+")
# dd.mm.yyyy everywhere except GR's Romansh table, which writes dd-mm-yyyy
_DATE = r"(\d{2})[.\-/](\d{2})[.\-/](\d{4})"

# Every labelled date in a Lexwork version string, in any of the four UI
# languages. The strings are assembled from parts and vary more than a
# fixed grammar admits ("Version in Kraft von: 01.01.2017 (wurde formlos
# berichtigt am: 06.12.2016) (Beschlussdatum: 23.09.2012)" on GR has a
# range start, no end, and two parenthesised dates), so the parser reads
# label:date pairs and classifies the LABEL rather than matching the whole
# sentence. Unknown labels (a correction date) are ignored; a string with no
# start label raises.
_LABELLED_DATE = re.compile(r"([A-Za-zÀ-ÿ' ]+?)\s*:?\s*" + _DATE)
_START_LABELS = re.compile(
    r"(?:\bvon|\bseit|\bab|\bdu|\bdepuis(?: le)?|\bdès(?: le)?|\bdal|\bdals?|\ba partir dals?)\s*$",
    re.IGNORECASE)
_END_LABELS = re.compile(r"(?:\bbis|\bau|\bal|\bfin a|\bjusqu'au)\s*$", re.IGNORECASE)
_DECISION_LABELS = re.compile(
    r"(?:beschlussdatum|erlassdatum|date de (?:la )?décision|date d'adoption|data della decisione|"
    r"data da la decisiun|data d'adopziun)\s*$",
    re.IGNORECASE)

# "Art. 61 Abs. 2" / "art. 12a al. 1" / "§ 7" -> the article's number
# "Art. 61 Abs. 2" / "Artikel 17 Abs. 1" (UR) / "art. 12a al. 1" / "§ 7" (BL, ZG) -> the article number
_ELEMENT_ARTICLE = re.compile(r"(?:\bArtikel|\bArticle|\bArticolo|\bArtitgel|\bArt\.?|§)\s*(\d+[a-zA-Z]*)")

# Change-cell vocabulary, measured on GR 110.100 (de/rm/it, 87 rows each,
# 2026-08-26) and FR 10.1 (de/fr): de geändert/eingefügt/aufgehoben (+ "Titel
# geändert"), fr modifié/introduit/abrogé, it modifica/introduzione/abrogazione,
# rm midada/integraziun/aboliziun. "Erstfassung" / "unbekannt" (ZG) map to None.
_ACTIONS = (
    ("inserted", re.compile(
        r"\b(?:eingefügt|introduit[es]?|introdott[oaie]|introduzione|inserì|integraziun|integrà|integrada)\b",
        re.IGNORECASE)),
    ("repealed", re.compile(
        r"\b(?:aufgehoben|abrogé[es]?|abrogat[oaie]|abrogazione|aboliziun|abolì|abolida)\b",
        re.IGNORECASE)),
    ("amended", re.compile(
        r"\b(?:geändert|modifié[es]?|modifica|modificat[oaie]|midà|midada)\b", re.IGNORECASE)),
)

_HISTORY_ROW = re.compile(r"history_info_(\d+)")

# Column roles of a modification table, recognised from the header cells so
# the "by decision" and "by article" tables (same rows, different column
# order) read the same way.
_HEADERS = (
    # observed: BE/ZG "Beschluss", FR de "Beschluss" / fr "Adoption", GR rm "Conclus", it "Decisione",
    # SG "Erlassdatum"
    ("decision", re.compile(r"beschluss|erlassdatum|adoption|décision|decisione|conclus|decisiun",
                            re.IGNORECASE)),
    # "Inkrafttreten", "Vollzugsbeginn" (SG), "Entrée en vigueur", "Entrata in vigore", "Entrada en vigur"
    # + BL "Inkraft seit"
    ("effective", re.compile(r"inkraft|vollzugsbeginn|vigueur|vigore|vigur", re.IGNORECASE)),
    # "Element", "Berührtes Element", "Bestimmung" (SG), "Elément touché", "Elemento"
    ("element", re.compile(r"el[ée]ment|elemento|bestimmung|disposition|disposizione", re.IGNORECASE)),
    # "Änderung", "Änderungstyp", "Type de modification", "Cambiamento", "Modificaziun"
    # + BL "Wirkung"
    ("change", re.compile(r"änderung|wirkung|modification|modifica|cambiamento|midada", re.IGNORECASE)),
    # "BAG-Fundstelle", "GS Fundstelle", "nGS-Fundstelle", "Quelle (ASF seit 2002)", "Source (ROF)",
    # "Rimando AGS", "Publicaziun en la CUL"
    # + BL "Publiziert mit"
    ("source", re.compile(r"fundstelle|quelle|source|référence|riferimento|rimando|fonte|"
                          r"publikation|publiziert|publicaziun|pubblicazione", re.IGNORECASE)),
)


class LexworkParseError(ValueError):
    pass


@dataclass(frozen=True)
class VersionDates:
    date_applicability: datetime.date
    date_end_applicability: datetime.date | None
    date_decision: datetime.date | None


@dataclass(frozen=True)
class Provenance:
    """One row of a version's modification table, anchored to this
    edition's articles -- the cantonal twin of amendment_notes.Provenance.
    as_reference carries the canton's official-collection reference
    ("04-9" in BAG/BSG); change_document_source_id is the Lexwork
    change_documents[].id the row links to, or None when the platform has
    no document for it (older changes)."""
    e_id: str
    action: str | None
    as_reference: str | None
    effective_date: datetime.date | None
    source_act_date: datetime.date | None
    raw_note: str
    anchor_level: str
    container_articles: int | None
    change_document_source_id: int | None


def _d(day: str, month: str, year: str) -> datetime.date:
    return datetime.date(int(year), int(month), int(day))


def _opt(groups: tuple, start: int) -> datetime.date | None:
    if groups[start] is None:
        return None
    return _d(*groups[start:start + 3])


def parse_version_dates(text: str) -> VersionDates:
    """The dates a Lexwork version string carries: start ("von"/"seit"/"ab"
    and the fr/it/rm equivalents), optional inclusive end ("bis"), optional
    decision date. Anything without a start date raises."""
    start = end = decision = None
    for m in _LABELLED_DATE.finditer(text or ""):
        label = m.group(1).strip()
        date = _d(*m.groups()[1:4])
        if _DECISION_LABELS.search(label):
            decision = decision or date
        elif _END_LABELS.search(label):
            end = end or date
        elif _START_LABELS.search(label):
            start = start or date
        # any other label (a correction date, "wurde formlos berichtigt am") is ignored
    if start is None:
        raise LexworkParseError(f"unrecognised version date string: {text!r}")
    return VersionDates(start, end, decision)


def _selected(payload: dict) -> dict:
    try:
        return payload["text_of_law"]["selected_version"]
    except (KeyError, TypeError) as exc:
        raise LexworkParseError("payload has no text_of_law.selected_version") from exc


def available_languages(payload: dict) -> list[str]:
    return [entry["language"]["iso639_1_code"]
            for entry in _selected(payload).get("available_languages") or []]


def strip_html(fragment: str | None) -> str:
    """Text of an HTML fragment: amendment markers (`<strong>*</strong>`)
    removed, NBSP folded, whitespace runs collapsed."""
    if not fragment or not fragment.strip():
        return ""
    root = lxml_html.fragment_fromstring(fragment, create_parent="div")
    for strong in list(root.iter("strong")):
        if (strong.text or "").strip() == "*" and len(strong) == 0:
            strong.drop_tree()
    text = root.text_content().replace("\xa0", " ")
    return _WS.sub(" ", text).strip()


def article_number_of(number_html: str | None) -> str | None:
    """'Art.&nbsp;6' -> '6', '§ 12a' -> '12a'."""
    return akn.normalise_number(strip_html(number_html))


def _lang(d: dict | None, lang: str) -> str | None:
    if not d or not isinstance(d, dict):
        return None
    return d.get(lang)


def _node_lines(node: dict, lang: str) -> list[str]:
    """Text of a paragraph/enumeration subtree, one block per line."""
    lines: list[str] = []
    own = strip_html(_lang(node.get("html_content"), lang))
    if own:
        lines.append(own)
    for child in node.get("children") or []:
        lines.extend(_node_lines(child, lang))
    post = strip_html(_lang(node.get("html_content_post"), lang))
    if post:
        lines.append(post)
    return lines


def _document(payload: dict) -> dict:
    try:
        return _selected(payload)["json_content"]["document"]
    except (KeyError, TypeError) as exc:
        raise LexworkParseError("payload has no json_content.document") from exc


def _content_root(payload: dict) -> dict:
    try:
        return _document(payload)["content"]
    except (KeyError, TypeError) as exc:
        raise LexworkParseError("payload has no json_content.document.content") from exc


_BLOCK_TAGS = frozenset({"div", "p", "h1", "h2", "h3", "h4", "li", "tr", "table"})
_LINE_BREAK = "\ue000"   # private-use: lxml rejects NUL in text


def block_lines(fragment: str | None) -> list[str]:
    """strip_html(), but one line per block element: the header (systematic
    number, title, abbreviation, enactment line, preamble paragraphs) and
    the footer (signatures) are several blocks that must not fuse into one
    line of full_text."""
    if not fragment or not fragment.strip():
        return []
    root = lxml_html.fragment_fromstring(fragment, create_parent="div")
    for strong in list(root.iter("strong")):
        if (strong.text or "").strip() == "*" and len(strong) == 0:
            strong.drop_tree()
    for element in root.iter():
        if not isinstance(element.tag, str) or element.tag.lower() not in _BLOCK_TAGS:
            continue
        # A sentinel, not "\n": the source's own indentation newlines sit
        # inside every block and would split "Verfassung<br />des Kantons
        # Bern" into two lines -- the same reason akn.py uses _LINE_BREAK.
        element.text = _LINE_BREAK + (element.text or "")
        element.tail = _LINE_BREAK + (element.tail or "")
    text = root.text_content().replace("\xa0", " ")
    lines = [_WS.sub(" ", part).strip() for part in text.split(_LINE_BREAK)]
    return [line for line in lines if line]


def _require_lang(payload: dict, lang: str) -> None:
    langs = available_languages(payload)
    if lang not in langs:
        raise LexworkParseError(
            f"language {lang!r} not in payload ({', '.join(langs) or 'none'})")


def parse_edition(payload: dict, lang: str) -> tuple[list[akn.Article], str]:
    """Both products of one walk: the articles (same shape parse_akn_stage
    stores) and the plain text of the whole document, one block per line,
    header and footer included -- the cantonal twin of akn.parse_edition.

    An edition with NO article node is returned as ([], text), and stored
    that way (article_count 0, full_text kept). Measured on prod 2026-08-26:
    235 of 38,014 parsed lexwork editions are such, and in all 235 the
    content tree is one childless `title` node -- the hosts publish these
    documents (see empty_reason()) with their whole text in header/footer.
    Re-fetching three of them live (BS x2, AG) gave byte-identical payloads,
    so there is no article to find and nothing to retry. No pseudo-article
    (number '' or the title) is fabricated for them, deliberately:
      * akn.plain_text() records a body-less Fedlex act the same way, and
        2,496 parsed Fedlex editions already sit at article_count 0;
      * ch_get_act_article answers such an edition with article_not_found
        and available_examples; a row numbered '' is unreachable by it;
      * no search reads ch_act_article.text, so the row would make nothing
        findable that full_text does not already carry;
      * diff_articles keys on e_id, and a root-uid row would turn every
        wording change of a repeal notice into a fabricated "modified".
    """
    _require_lang(payload, lang)
    doc = _document(payload)
    articles: list[akn.Article] = []
    lines: list[str] = block_lines(_lang(doc.get("header"), lang))

    def walk(node: dict, parent_uid: str | None) -> None:
        kind = node.get("type")
        uid = node.get("uid") or ""
        if kind == "article":
            heading = strip_html(_lang(node.get("number"), lang))
            marginal = strip_html(_lang(node.get("text"), lang)) or None
            body: list[str] = []
            for child in node.get("children") or []:
                body.extend(_node_lines(child, lang))
            articles.append(akn.Article(
                e_id=uid,
                article_number=akn.normalise_number(heading),
                marginal_note=marginal,
                text=" ".join(body).strip(),
                ordinal=len(articles),
                parent_e_id=parent_uid))
            title_line = " ".join(p for p in (heading, marginal) if p)
            if title_line:
                lines.append(title_line)
            lines.extend(body)
            return
        heading = (strip_html(_lang(node.get("html_content"), lang))
                   or strip_html(_lang(node.get("text"), lang)))
        if heading:
            lines.append(heading)
        next_parent = uid if kind == "title" else parent_uid
        for child in node.get("children") or []:
            walk(child, next_parent)

    walk(_content_root(payload), None)
    lines.extend(block_lines(_lang(doc.get("footer"), lang)))
    return articles, "\n".join(line for line in lines if line)


# Why an edition parsed to zero articles, measured on all 235 such prod
# editions (2026-08-26; BS 147, BE 34, ZG 17, AG 12, UR 12, BL 5, GL 3,
# NW 2, LU 1, OW 1, TG 1):
#   annex_only              82  BS only: the act is a PDF in annex_documents
#                               ("Für den Text des RRB ... siehe Anhang")
#   published_by_reference  77  AG 12, BE 34, BL 2, NW 2, UR 12, ZG 15: the
#                               collection publishes a pointer, not the text
#   unstructured_text       73  BS 65, BL 3, GL 1, OW 1, TG 1, ZG 2: treaties,
#                               Grossratsbeschlüsse, oaths, one-sentence acts
#                               -- real text with no article structure
#   placeholder              3  GL 2 "In Revision", LU 1 "überholt"
EMPTY_REASONS = ("annex_only", "published_by_reference", "placeholder", "unstructured_text")

# The by-reference vocabulary of six hosts. AG "wird durch Verweisung
# publiziert" / "in der AGS und SAR nicht publiziert"; BE de "in der Form
# eines (Sammel)verweises veröffentlicht", BE fr "sous la forme d'un renvoi";
# BL "wird in der Gesetzessammlung nicht publiziert"; NW "nicht im Volltext
# veröffentlicht" / "durch Verweis"; UR "durch Verweis veröffentlicht; er
# wird nicht ins Rechtsbuch aufgenommen"; ZG "nur noch über die
# interkantonale Publikationsplattform Intlex publiziert".
_BY_REFERENCE = re.compile(
    r"durch Verweis(?:ung)?\b|in der Form eines (?:Sammel)?verweises|sous la forme d[’']un renvoi"
    r"|nicht im Volltext veröffentlicht|in der Gesetzessammlung nicht publiziert"
    r"|nicht ins Rechtsbuch aufgenommen|Publikationsplattform Intlex|in der AGS und SAR nicht publiziert",
    re.IGNORECASE)
# GL "In Revision" (2), LU "Dieser Beschluss ist überholt, formell aber noch
# in Kraft" (1): an entry with no text at all, not even a pointer.
_PLACEHOLDER = re.compile(r"\bIn Revision\b|\büberholt\b", re.IGNORECASE)


def empty_reason(payload: dict, lang: str, text: str) -> str:
    """Why parse_edition() found no article: one of EMPTY_REASONS. Meant for
    the stage's report, not for a column -- the edition is stored honestly
    (0 articles, its text as full_text) whatever the reason.

    The annex list is checked first and structurally: it is the one signal
    that does not depend on a host's wording, and no by-reference edition
    ships an annex (0 of 77). `text` is the full text parse_edition()
    returned, so the header's notice and the footer's are both read."""
    if _selected(payload).get("annex_documents"):
        return "annex_only"
    if _BY_REFERENCE.search(text):
        return "published_by_reference"
    if _PLACEHOLDER.search(text):
        return "placeholder"
    return "unstructured_text"


def annex_pdf_url(payload: dict) -> str | None:
    """The PDF the host serves this version's annexes as, for the annex_only
    editions (BS: the act body is "siehe Anhang" plus a PDF). The payload
    names it twice, identically: `selected_version.pdf_link_annexes` is ONE
    URL (`https://{host}/api/{lang}/versions/{id}/annexes`, one bundle of
    all annexes -- verified live 2026-08-31 on BS 834.420 v2939: 200
    application/pdf, %PDF-1.5, exactly pdf_link_annexes_size bytes), and
    every `annex_documents[].url` that is not null repeats the same bundle
    URL (85 of 85 BS rows). Returns None when the version lists no annex
    documents (not annex_only -- the caller skips), and '' when annexes are
    listed but no link is given (a defect worth counting, not skipping)."""
    selected = _selected(payload)
    if not selected.get("annex_documents"):
        return None
    if selected.get("pdf_link_annexes"):
        return selected["pdf_link_annexes"]
    for doc in selected["annex_documents"]:
        if doc.get("url"):
            return doc["url"]
    return ""


def _action(text: str) -> str | None:
    for name, pattern in _ACTIONS:
        if pattern.search(text):
            return name
    return None


def _cell_text(cell) -> str:
    return _WS.sub(" ", cell.text_content().replace("\xa0", " ")).strip()


def _date_or_none(text: str) -> datetime.date | None:
    m = re.search(_DATE, text or "")
    return _d(*m.groups()) if m else None


def _column_roles(table) -> dict[str, int] | None:
    headers = [_cell_text(th) for th in table.iter("th")]
    if not headers:
        return None
    roles: dict[str, int] = {}
    for index, header in enumerate(headers):
        for role, pattern in _HEADERS:
            if role not in roles and pattern.search(header):
                roles[role] = index
                break
    if {"decision", "effective", "element", "change"} <= set(roles):
        return roles
    return None


def modification_table_status(payload: dict, lang: str) -> str:
    """'none' (the version ships no table), 'recognised' (its header row maps
    to the four required columns), or 'unrecognised' (a table whose header
    vocabulary this module does not know -- a host to look at, since
    provenance() silently yields nothing for it). SG's "Bestimmung /
    Erlassdatum / Vollzugsbeginn" was found exactly this way."""
    sv = _selected(payload)
    tables = sv.get("json_content", {}).get("modification_table") or []
    fragment = None
    for table in tables:
        fragment = (_lang(table.get("html_content"), lang)
                    or _lang(table.get("html_content"), "de"))
        if fragment:
            break
    if not fragment:
        return "none"
    root = lxml_html.fragment_fromstring(fragment, create_parent="div")
    for html_table in root.iter("table"):
        if _column_roles(html_table):
            return "recognised"
    return "unrecognised"


def provenance(payload: dict, lang: str,
               articles: list[akn.Article]) -> list[Provenance]:
    """Rows of the version's FIRST modification table (Lexwork ships the
    same rows twice, sorted by decision and by article), anchored to this
    edition's articles: "Art. 61 Abs. 2" anchors to article 61 when the
    edition has it; "Erlass", a title, or an article this edition does not
    contain anchor to the document root as a container statement (the
    CHECK in migration 198 wants container_articles for those).

    Reads the table in `lang` and falls back to German: the modification
    table is the one part of the payload some hosts publish in German
    only, and a French row that says "geändert" is still a row."""
    sv = _selected(payload)
    history = sv.get("history_information_map") or {}
    by_number = {a.article_number: a.e_id for a in articles if a.article_number}
    root_uid = _content_root(payload).get("uid") or "t-0"
    tables = sv.get("json_content", {}).get("modification_table") or []
    rows: list[Provenance] = []
    for table in tables:
        fragment = (_lang(table.get("html_content"), lang)
                    or _lang(table.get("html_content"), "de"))
        if not fragment:
            continue
        root = lxml_html.fragment_fromstring(fragment, create_parent="div")
        roles = None
        for html_table in root.iter("table"):
            roles = _column_roles(html_table)
            if roles:
                break
        if not roles:
            continue
        for tr in root.iter("tr"):
            cells = [_cell_text(td) for td in tr.iter("td")]
            if len(cells) <= max(roles.values()):
                continue
            decision = cells[roles["decision"]]
            effective = cells[roles["effective"]]
            element = cells[roles["element"]]
            change = cells[roles["change"]]
            source = cells[roles["source"]] if "source" in roles else ""
            if source.strip("-\u2013\u2014 ") == "":     # GR writes "-" for "no reference"
                source = ""
            m = _HISTORY_ROW.search(tr.get("class") or "")
            change_doc = None
            if m and m.group(1) in history:
                change_doc = (history[m.group(1)] or {}).get("change_document_id")
            art = _ELEMENT_ARTICLE.search(element)
            e_id = by_number.get(akn.normalise_number(art.group(1))) if art else None
            raw = " | ".join(c for c in (decision, effective, element, change, source) if c)
            if e_id:
                rows.append(Provenance(e_id, _action(change), source or None,
                                       _date_or_none(effective), _date_or_none(decision),
                                       raw, "article", None, change_doc))
            else:
                rows.append(Provenance(root_uid, _action(change), source or None,
                                       _date_or_none(effective), _date_or_none(decision),
                                       raw, "container", len(articles), change_doc))
        break   # the second table is the first one re-sorted
    return rows
