"""Ticino's Raccolta delle leggi (www3.ti.ch/CAN/RLeggi) -> acts, articles,
plain text. Pure functions over captured HTML; the network and the database
are in stages/ti_*_stage.py.

What the portal is (measured 2026-08-26): a PHP application with one list
page, `elenco-atti`, that names every act in force (623 links, one per
`legge-piatta/num/{id}`; LexFind's registry has 623 active TI acts and 622
of them carry the same id in original_url), and one flat page per act,
`legge-piatta/num/{id}`, which is the act's Word document exported by
Aspose.Words: a `<div id="contenutoLeggePiatta">` holding `<h2>` (the
systematic number), a `<title>`, one `<div>` of `<p>` paragraphs and, after
an `<hr>`, one `<div id="_ftnN">` per footnote. There is no version history
on the portal: the flat page is always the current consolidated text
("stato" date in its header), so one act is one open edition.

Two pitfalls this module exists for:

  * A missing id is HTTP 200 with "L'atto normativo cercato non è presente!"
    and no content div -- is_act_page() is how the fetch stage tells an act
    from that page, since the status code cannot.
  * The Word export carries no whitespace between the bold "Art. 1", the
    superscript capoverso number "1" and the body "Il Cantone ...": read as
    text_content() it is "Art. 11Il Cantone", and the article number is
    "11". Superscripts are typeset as spans with vertical-align (2pt for
    the Word superscripts, `super` for footnote marks). A NON-bold
    superscript is a capoverso number and gets a space on each side; a bold
    one right after the article number is "bis"/"ter" and is joined to it
    (Art. 34bis, 34ter of the constitution); a footnote mark ("[17]", an
    `<a href="#_ftnN">`) leaves the text and its footnote becomes one of the
    article's notes, the same field akn.Article uses for Fedlex's
    authorialNotes.

Marginal notes are bold, non-centred paragraphs directly before an article
("Cantone Ticino" before Art. 1 of the constitution); section headings are
centred paragraphs ("TITOLO I"). Neither is article text. Everything after
the last article (annexes, figures, "Entrata in vigore") stays in the last
article's text and in full_text -- the portal does not mark where an act's
operative part ends, and dropping it would lose the transitional provisions.
"""
from __future__ import annotations

import datetime
import re
from urllib.parse import urljoin

from lxml import html as lxml_html

from . import akn

HOST = "www3.ti.ch"
BASE = f"https://{HOST}/CAN/RLeggi/public/index.php/raccolta-leggi"
LIST_URL = f"{BASE}/elenco-atti"
CONTENT_ID = "contenutoLeggePiatta"
MISSING_TEXT = "L'atto normativo cercato non è presente"

_MONTHS = {name: i + 1 for i, name in enumerate((
    "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio",
    "agosto", "settembre", "ottobre", "novembre", "dicembre"))}
_DATE_WORDS = re.compile(r"(\d{1,2})[°º]?\s+(" + "|".join(_MONTHS) + r")\s+(\d{4})", re.I)
_DATE_DIGITS = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{4})")
_LIST_LINK = re.compile(r"legge-piatta/num/(\d+)$")
# "101.000  Costituzione della Repubblica e Cantone Ticino - 14 dicembre 1997"
_LIST_TEXT = re.compile(r"^\s*(\d[\d.]*\d)\s+(.*?)\s*(?:-\s*(\d{1,2}[°º]?\s+\w+\s+\d{4}))?\s*$", re.S)
_ARTICLE_HEAD = re.compile(r"^Art\.\s*(\d+[a-z]*)(?![\w])")
_SECTION = re.compile(r"^(TITOLO|PARTE|CAPITOLO|CAPO|SEZIONE|LIBRO|ALLEGATO)\b", re.I)
_WS = re.compile(r"\s+")
_FTN = re.compile(r"#_ftn(\d+)$")


class TiParseError(RuntimeError):
    pass


def act_url(rl_id: int) -> str:
    """The act's UI page: LexFind's original_url for TI and our ch_act.eli_work_uri."""
    return f"{BASE}/legge/num/{rl_id}"


def flat_url(rl_id: int) -> str:
    """The one-page consolidated text: what the fetch stage downloads."""
    return f"{BASE}/legge-piatta/num/{rl_id}"


def parse_date(text: str | None) -> datetime.date | None:
    """First Italian ('14 dicembre 1997', '1° gennaio 2023') or numeric
    ('5.2.2002') date in a string, or None."""
    if not text:
        return None
    m = _DATE_WORDS.search(text)
    if m:
        try:
            return datetime.date(int(m.group(3)), _MONTHS[m.group(2).lower()], int(m.group(1)))
        except ValueError:
            return None
    m = _DATE_DIGITS.search(text)
    if m:
        try:
            return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    return None


# --- the list -------------------------------------------------------------

def parse_list(page: str) -> list[dict]:
    """Every act on elenco-atti, in page order, one dict per id. The link
    text is "{sr_number}  {title} - {date}"; the date is the act's date of
    decision (the constitution's "14 dicembre 1997"), split off so the
    title is the title. A page with no act links is an error: the list is
    the discovery source, and an empty one is an outage or a layout change,
    never a canton with no law."""
    root = lxml_html.fromstring(page)
    entries: list[dict] = []
    seen: set[int] = set()
    for a in root.iter("a"):
        m = _LIST_LINK.search(a.get("href") or "")
        if not m:
            continue
        rl_id = int(m.group(1))
        if rl_id in seen:
            continue
        seen.add(rl_id)
        text = _WS.sub(" ", a.text_content().replace("\xa0", " ")).strip()
        parts = _LIST_TEXT.match(text)
        if parts:
            sr_number, title, date_text = parts.group(1), parts.group(2).strip(), parts.group(3)
        else:
            sr_number, title, date_text = "", text, None
        entries.append({
            "rl_id": rl_id,
            "sr_number": sr_number,
            "title": title,
            "date_text": date_text,
            "date_document": parse_date(date_text),
            "url": act_url(rl_id),
            "flat_url": flat_url(rl_id),
        })
    if not entries:
        raise TiParseError("elenco-atti has no legge-piatta links")
    return entries


# --- the act page ---------------------------------------------------------

def _content(page: str):
    root = lxml_html.fromstring(page)
    try:
        return root.get_element_by_id(CONTENT_ID)
    except KeyError:
        return None


def is_act_page(page: str) -> bool:
    """True when the body is a flat act page and not the portal's "not
    present" answer, which comes with HTTP 200 like everything else."""
    content = _content(page)
    return content is not None and any(child.tag == "div" for child in content)


def _style(el) -> str:
    return (el.get("style") or "").replace(" ", "").lower()


def _is_super(el) -> bool:
    return "vertical-align:" in _style(el)


def _is_bold(el) -> bool:
    return "font-weight:bold" in _style(el)


def _is_tab(el) -> bool:
    return "display:inline-block" in _style(el) and not (el.text or "").strip() and len(el) == 0


def _render(p) -> tuple[str, list[int], bool]:
    """One paragraph -> (text, footnote numbers referenced, all_bold).

    Word superscripts (vertical-align) are spaced unless bold and glued to
    the article number; tab stops (empty inline-block spans) become one
    space; footnote marks are dropped and returned as numbers."""
    pieces: list[str] = []
    notes: list[int] = []
    bold_flags: list[bool] = []

    def walk(el, bold: bool) -> None:
        if not isinstance(el.tag, str):
            return
        tag = el.tag.lower()
        if tag == "a":
            m = _FTN.search(el.get("href") or "")
            if m:
                notes.append(int(m.group(1)))
                return                       # the "[17]" mark itself
            if el.get("name") and not (el.text or "").strip() and len(el) == 0:
                return
        if tag == "span" and _is_tab(el):
            pieces.append(" ")
            return
        own_bold = bold or _is_bold(el)
        if tag == "span" and _is_super(el):
            text = _WS.sub(" ", el.text_content().replace("\xa0", " ")).strip()
            if text:
                # bold superscript right after "Art. 34" -> "Art. 34bis"
                if own_bold and pieces and _ARTICLE_HEAD.match("".join(pieces).strip()):
                    pieces.append(text)
                else:
                    pieces.append(f" {text} ")
                bold_flags.append(own_bold)
            return
        if tag == "br":
            pieces.append(" ")
        if el.text:
            pieces.append(el.text)
            if el.text.strip():
                bold_flags.append(own_bold)
        for child in el:
            walk(child, own_bold)
            if child.tail:
                pieces.append(child.tail)
                if child.tail.strip():
                    bold_flags.append(own_bold)

    for child in p:
        walk(child, _is_bold(p))
        if child.tail:
            pieces.append(child.tail)
            if child.tail.strip():
                bold_flags.append(False)
    if p.text:
        pieces.insert(0, p.text)
        if p.text.strip():
            bold_flags.append(False)
    text = _WS.sub(" ", "".join(pieces).replace("\xa0", " ")).strip()
    return text, notes, bool(bold_flags) and all(bold_flags)


def _centred(p) -> bool:
    return "text-align:center" in _style(p)


def _footnotes(content) -> dict[int, str]:
    out: dict[int, str] = {}
    for div in content.iter("div"):
        m = re.match(r"_ftn(\d+)$", div.get("id") or "")
        if not m:
            continue
        text, _, _ = _render(div)
        # the footnote's own "[n]" mark is a back-link, rendered as text
        text = re.sub(r"^\[\d+\]\s*", "", text)
        out[int(m.group(1))] = text
    return out


def parse_act(page: str) -> tuple[list[akn.Article], str, dict]:
    """Articles (the shape parse_akn_stage.store_articles writes), the plain
    text one line per paragraph with the footnotes appended, and meta:
    sr_number (the h2), title (the content <title>; junk on some acts,
    110.110's is ": DE conc. i colori ...", so the list title is what the
    acts stage stores), date_document (first date in the header), date_status
    ("(stato ...)" in the header), date_entry_force ("Entrata in vigore: ...")."""
    content = _content(page)
    if content is None or not any(child.tag == "div" for child in content):
        raise TiParseError(MISSING_TEXT if MISSING_TEXT in page else
                           f"no #{CONTENT_ID} with a body div")
    h2 = content.find("h2")
    sr_number = _WS.sub(" ", h2.text_content()).strip() if h2 is not None else ""
    title_el = content.find("title")
    title = _WS.sub(" ", title_el.text_content()).strip() if title_el is not None else ""
    footnotes = _footnotes(content)
    body = next(child for child in content if child.tag == "div"
                and not (child.get("id") or "").startswith("_ftn"))

    lines: list[str] = [sr_number] if sr_number else []
    paragraphs: list[tuple[str, list[int], bool, bool]] = []   # text, notes, all_bold, centred
    for p in body.iter("p"):
        text, notes, all_bold = _render(p)
        if not text:
            continue
        paragraphs.append((text, notes, all_bold, _centred(p)))
        lines.append(text)

    articles: list[akn.Article] = []
    e_ids: dict[str, int] = {}
    current: dict | None = None

    def close() -> None:
        if current is None:
            return
        base = f"art_{current['number']}"
        n = e_ids.get(base, 0) + 1
        e_ids[base] = n
        articles.append(akn.Article(
            e_id=base if n == 1 else f"{base}#{n}",
            article_number=current["number"],
            marginal_note=current["marginal"],
            text=" ".join(current["body"]).strip(),
            ordinal=len(articles),
            parent_e_id=None,
            notes=tuple(footnotes[k] for k in current["notes"] if k in footnotes)))

    for index, (text, notes, all_bold, centred) in enumerate(paragraphs):
        head = _ARTICLE_HEAD.match(text)
        if head:
            close()
            marginal = None
            if index > 0:
                prev_text, _, prev_bold, prev_centred = paragraphs[index - 1]
                if prev_bold and not prev_centred and not _ARTICLE_HEAD.match(prev_text) \
                        and len(prev_text) <= 120:
                    marginal = prev_text
            current = {"number": head.group(1), "marginal": marginal,
                       "body": [text[head.end():].strip()], "notes": list(notes)}
            continue
        if current is None:
            continue
        if centred and _SECTION.match(text):
            continue
        next_is_head = index + 1 < len(paragraphs) and _ARTICLE_HEAD.match(paragraphs[index + 1][0])
        if all_bold and not centred and next_is_head and len(text) <= 120:
            continue                                   # the next article's marginal note
        current["body"].append(text)
        current["notes"].extend(notes)
    close()

    for number in sorted(footnotes):
        lines.append(f"[{number}] {footnotes[number]}")

    header = [line for line in lines[1:9]]
    meta = {
        "sr_number": sr_number,
        "title": title,
        "date_document": next((d for d in (parse_date(line) for line in header) if d), None),
        "date_status": next((parse_date(m.group(1)) for line in header
                             for m in [re.search(r"\(stato\s+([^)]+)\)", line, re.I)] if m), None),
        "date_entry_force": next((parse_date(line) for line in lines
                                  if re.match(r"Entrata in vigore\b", line, re.I)), None),
        "footnotes": len(footnotes),
    }
    return articles, "\n".join(line for line in lines if line), meta
