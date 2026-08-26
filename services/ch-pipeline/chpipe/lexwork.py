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
_DATE = r"(\d{2})\.(\d{2})\.(\d{4})"
_DECISION = (r"(?:\s*\((?:Beschlussdatum|Date de la décision|Date de décision|"
             r"Data della decisione|Data da la decisiun)[^:]*:\s*" + _DATE + r"\))?")
_CURRENT = re.compile(
    r"^\s*(?:Aktuelle Version|Version actuelle|Versione attuale|Versiun actuala)"
    r"[^\d]*?(?:seit|depuis le|depuis|dal|dals?)\s*:?\s*" + _DATE + _DECISION)
_RANGE = re.compile(
    r"^\s*(?:Version|Versione|Versiun)[^\d]*?(?:von|du|dal|dals?)\s*:?\s*" + _DATE
    + r"\s*(?:bis|au|al|fin a)\s*:?\s*" + _DATE + _DECISION)
_FUTURE = re.compile(
    r"^\s*(?:Zukünftige Version|Version future|Versione futura|Versiun futura)"
    r"[^\d]*?(?:ab|dès le|dès|dal|a partir dals?)\s*:?\s*" + _DATE + _DECISION)

# "Art. 61 Abs. 2" / "art. 12a al. 1" / "§ 7" -> the article's number
_ELEMENT_ARTICLE = re.compile(r"(?:\bArt\.?|\bArticle|\bArticolo|\bArtitgel|§)\s*(\d+[a-zA-Z]*)")

_ACTIONS = (
    ("inserted", re.compile(
        r"\b(?:eingefügt|introduit[es]?|introdott[oaie]|inserì|integrà|integrada)\b", re.IGNORECASE)),
    ("repealed", re.compile(
        r"\b(?:aufgehoben|abrogé[es]?|abrogat[oaie]|abolì|abolida)\b", re.IGNORECASE)),
    ("amended", re.compile(
        r"\b(?:geändert|modifié[es]?|modificat[oaie]|midà|midada)\b", re.IGNORECASE)),
)

_HISTORY_ROW = re.compile(r"history_info_(\d+)")

# Column roles of a modification table, recognised from the header cells so
# the "by decision" and "by article" tables (same rows, different column
# order) read the same way.
_HEADERS = (
    ("decision", re.compile(r"beschluss|décision|decisione|decisiun", re.IGNORECASE)),
    ("effective", re.compile(r"inkrafttreten|vigueur|vigore|vigur", re.IGNORECASE)),
    ("element", re.compile(r"el[ée]ment|elemento", re.IGNORECASE)),
    ("change", re.compile(r"änderung|modification|modifica|midada", re.IGNORECASE)),
    ("source", re.compile(r"fundstelle|référence|riferimento|source|publikation|pubblicazione", re.IGNORECASE)),
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
    """The three shapes Lexwork's UI writes: a closed range (an old version),
    a current version ("seit"), a future one ("ab"). Anything else raises."""
    m = _RANGE.match(text or "")
    if m:
        g = m.groups()
        return VersionDates(_d(*g[0:3]), _d(*g[3:6]), _opt(g, 6))
    m = _CURRENT.match(text or "") or _FUTURE.match(text or "")
    if m:
        g = m.groups()
        return VersionDates(_d(*g[0:3]), None, _opt(g, 3))
    raise LexworkParseError(f"unrecognised version date string: {text!r}")


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
_LINE_BREAK = "\x00"


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
    header and footer included -- the cantonal twin of akn.parse_edition."""
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
