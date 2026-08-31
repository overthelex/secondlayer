"""Amendment events from the notes the GE/NE (SIL) and TI (Raccolta) portal
pages carry -- the portal twin of lexwork.provenance() + the change-document
half of cantonal_acts_stage, for the three cantons whose platforms publish
no change-document index at all.

What the notes look like (measured 2026-08-31 on 45 random parsed prod
pages: 15 GE, 15 NE, 15 TI; the fractions below are from that sample):

  GE  sil.parse_act resolves each article's footnote marks against the
      modification table at the foot of the page and stores one note per
      table row: "{body} | {date d'adoption} | {entrée en vigueur}"
      ("n.t. : 13/2e 2°, 38 | 04.10.2013 | 01.01.2014"). The body is
      action groups over article lists -- "n." (nouveau), "n.t." (nouvelle
      teneur), "a." (abrogé) -- plus free-text prefixes ("Restructuration
      des sections..."). The table names NO amending act: no law number,
      no publication reference, only the two dates. 137 of 137 sampled
      notes carried both dates, so the adoption date as printed IS the
      reference here, and two rows adopted the same day collapse into one
      document (they are almost always the same amending law, which GE
      lists once per row with all its changes).

  NE  footnote prose: "Teneur selon L du 5 novembre 2013 (FO 2013 N° 47)
      avec effet au 1er janvier 2014", verbs Teneur selon / Modifié par /
      Introduit par / Abrogé par / Remplacé par, several events in one
      note ("L du X (FO...), L du Y (FO...) avec effet au Z et L du ...").
      The reference is the Feuille officielle issue "FO {year} N° {n}";
      legacy articles cite "RLN V 384" (the old Recueil, volume/page) or
      bare "RS 220" / "RSN 152.510" cross-references, which are not
      amendment events and yield nothing. 139 of 168 sampled notes yielded
      events (the other 29: cross-references, bare refs, "Approbation
      fédérale"); "avec effet immédiat" leaves date_in_force None rather
      than inventing a date.

  TI  footnote prose: "Art./Cpv./Lett. modificato dal R 10.11.2021;
      in vigore dal 12.11.2021 - BU 2021, 328." with verbs modificato /
      abrogato / introdotto / reintrodotto / sostituito, the amending
      decree named only by type letter and date ("R 10.11.2021",
      "L 22.9.2020", "votazione popolare del 25.9.2016") and the
      reference the Bollettino ufficiale page "BU {year}, {page}".
      Trailing "precedente/i modifica/e: BU 2005, 450; BU 2011, 119"
      lists earlier events as bare BU refs (ref-only events, no dates).
      "Entrata in vigore:", "Approvazione federale:" and "Norma
      transitoria:" notes are the act's own history, not amendments, and
      yield nothing. 137 of 152 sampled notes yielded events.

One parsed event becomes one ch_article_provenance row (raw_note = the
whole original note, so a multi-event note repeats it); the distinct
source references of an act become its ch_act_change_document rows, with
source_id a stable 63-bit hash of the reference text -- the portals have
no numeric document ids, and the hash keeps the upsert idempotent under
UNIQUE (jurisdiction, source_id, act_id). date_publication stays NULL
everywhere: an FO issue number and a BU page name where a change was
published but not when, and GE prints no publication reference at all.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import re
from dataclasses import dataclass

from psycopg.rows import tuple_row

from . import akn

_WS = re.compile(r"\s+")
_DDMMYYYY = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{4})")

_FR_MONTHS = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5,
    "juin": 6, "juillet": 7, "août": 8, "aout": 8, "septembre": 9,
    "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12,
}
_FR_DATE = re.compile(r"(\d{1,2})(?:er)?\s+([a-zA-Zéèêûôîà]+)\s+(\d{4})")
_IT_MONTHS = {name: i + 1 for i, name in enumerate((
    "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio",
    "agosto", "settembre", "ottobre", "novembre", "dicembre"))}
_IT_DATE = re.compile(r"(\d{1,2})[°º]?\s+(" + "|".join(_IT_MONTHS) + r")\s+(\d{4})", re.I)


@dataclass(frozen=True)
class Event:
    """One amendment event a note describes. source_ref is the printed
    reference in a normalised form ("FO 2013 N° 47", "BU 2021, 328", GE's
    "04.10.2013" adoption date), or None when the note names none."""
    action: str | None
    date_decision: datetime.date | None
    date_in_force: datetime.date | None
    source_ref: str | None


def _date(day: str, month: int, year: str) -> datetime.date | None:
    try:
        return datetime.date(int(year), month, int(day))
    except ValueError:
        return None


def _ddmm(text: str | None) -> datetime.date | None:
    m = _DDMMYYYY.search(text or "")
    return _date(m.group(1), int(m.group(2)), m.group(3)) if m else None


def _fr_date(text: str | None) -> datetime.date | None:
    for m in _FR_DATE.finditer(text or ""):
        month = _FR_MONTHS.get(m.group(2).lower())
        if month:
            return _date(m.group(1), month, m.group(3))
    return None


def _it_date(text: str | None) -> datetime.date | None:
    found = _ddmm(text)
    if found:
        return found
    m = _IT_DATE.search(text or "")
    return _date(m.group(1), _IT_MONTHS[m.group(2).lower()], m.group(3)) if m else None


# ---------------------------------------------------------------------------
# GE -- "body | dd.mm.yyyy | dd.mm.yyyy"
# ---------------------------------------------------------------------------

_GE_ACTION = {"n.t.": "amended", "n.": "inserted", "a.": "repealed"}
# longest first, or "n.t." is eaten by "n."
_GE_GROUP = re.compile(r"(?:^|[;:]\s*|\s)(n\.t\.|n\.|a\.)\s*:")
_GE_TOKEN_ID = re.compile(r"^(?:chap\.|section|art\.)?\s*(\d+[A-Za-z]?)")


def _ge_action(body: str, article_number: str | None) -> str | None:
    """The action group of this article, when the note says. One group ->
    that action; several -> the one whose article list names this article's
    number, and None when none or more than one does (an honest unknown
    beats a guessed verb)."""
    marks = list(_GE_GROUP.finditer(body))
    if not marks:
        return None
    if len({m.group(1) for m in marks}) == 1:
        return _GE_ACTION[marks[0].group(1)]
    if not article_number:
        return None
    hits = set()
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
        # "(d. : 13/g-j >> 13/f-i)" is a renumbering annotation on the token
        # before it, never a target of the action
        group = re.sub(r"\([^)]*\)", " ", body[m.end():end])
        for token in re.split(r"[,;]", group):
            token = token.strip()
            if ">>" in token:            # a renumbering annotation, not a target
                continue
            t = _GE_TOKEN_ID.match(token)
            if t and t.group(1).upper() == article_number.upper():
                hits.add(m.group(1))
    if len(hits) == 1:
        return _GE_ACTION[hits.pop()]
    return None


def _parse_ge(note: str, article_number: str | None) -> list[Event]:
    parts = [p.strip() for p in note.split(" | ")]
    if len(parts) < 3:
        return []
    body, adopt_text, force_text = " | ".join(parts[:-2]), parts[-2], parts[-1]
    adopt, force = _ddmm(adopt_text), _ddmm(force_text)
    if adopt is None and force is None:
        return []
    return [Event(_ge_action(body, article_number), adopt, force,
                  adopt_text if adopt else None)]


# ---------------------------------------------------------------------------
# NE -- "Teneur selon L du 5 novembre 2013 (FO 2013 N° 47) avec effet au ..."
# ---------------------------------------------------------------------------

_NE_EVENT = re.compile(
    r"du\s+(\d{1,2}(?:er)?\s+[a-zA-Zéèêûôà]+\s+\d{4})\s*\(([^)]{1,200})\)")
_NE_FO = re.compile(r"FO\s+(\d{4})\s+N[o°]\s*(\d+)", re.I)
_NE_RLN = re.compile(r"RLN\s+([IVXLC]+\s+\d+)", re.I)
_NE_EFFET = re.compile(
    r"avec effet\s+(?:r[ée]troactif\s+)?(?:au\s+(\d{1,2}(?:er)?\s+[a-zA-Zéèêûôà]+\s+\d{4})"
    r"|(imm[ée]diat))", re.I)
_NE_ACTIONS = (
    ("inserted", re.compile(r"\bIntroduite?s?\b", re.I)),
    ("repealed", re.compile(r"\bAbrog[ée]e?s?\b", re.I)),
    ("amended", re.compile(r"\bTeneur selon\b|\bModifi[ée]e?s?\s+par\b|\bRemplac[ée]e?s?\s+par\b", re.I)),
)
# A note that is ONLY a Feuille officielle reference ("FO 2022 N° 51"):
# an amendment the page cites without prose -- a ref-only event, the same
# claim TI's "precedenti modifiche" bare refs make.
_NE_BARE_FO = re.compile(r"^FO\s+\d{4}\s+N[o°]\s*\d+\.?$", re.I)


def _ne_ref(paren: str) -> str | None:
    fo = _NE_FO.search(paren)
    if fo:
        return f"FO {fo.group(1)} N° {fo.group(2)}"
    rln = _NE_RLN.search(paren)
    if rln:
        return "RLN " + _WS.sub(" ", rln.group(1))
    return None


def _parse_ne(note: str) -> list[Event]:
    if _NE_BARE_FO.match(note.strip()):
        fo = _NE_FO.search(note)
        return [Event(None, None, None, f"FO {fo.group(1)} N° {fo.group(2)}")]
    matches = list(_NE_EVENT.finditer(note))
    if not matches:
        return []
    events: list[Event] = []
    prev_end = 0
    first_action: str | None = None
    for i, m in enumerate(matches):
        # The verb sits between the previous event and this one; in a list
        # ("Teneur selon L du X (..), L du Y (..) et L du Z (..)") the first
        # event's verb governs the rest.
        action = None
        for name, pattern in _NE_ACTIONS:
            if pattern.search(note, prev_end, m.start()):
                action = name
                break
        if i == 0:
            first_action = action
        events_action = action if action is not None else first_action
        decision = _fr_date(m.group(1))
        next_start = matches[i + 1].start() if i + 1 < len(matches) else len(note)
        effet = _NE_EFFET.search(note, m.end(), next_start)
        force = _fr_date(effet.group(1)) if effet and effet.group(1) else None
        events.append(Event(events_action, decision, force, _ne_ref(m.group(2))))
        prev_end = m.end()
    return events


# ---------------------------------------------------------------------------
# TI -- "Art. modificato dal R 10.11.2021; in vigore dal 12.11.2021 - BU 2021, 328."
# ---------------------------------------------------------------------------

_TI_ACTIONS = (
    ("inserted", re.compile(r"\b(?:re)?introdott[oaie]\b|\bintroduzione\b", re.I)),
    ("repealed", re.compile(r"\babrogat[oaie]\b|\babrogazione\b", re.I)),
    ("amended", re.compile(r"\bmodificat[oaie]\b|\bsostituit[oaie]\b|\bmodifica\b", re.I)),
)
_TI_BU = re.compile(r"\bBU\s+(\d{4}),\s*(\d+(?:\s+e\s+\d+)*)")
# "- 2025, 118." -- the same reference with "BU" forgotten (real, on
# 184.310); only after " - ", where nothing else is ever printed like that.
_TI_BU_BARE = re.compile(r"[-–]\s*(\d{4}),\s*(\d+)")
_TI_VIGORE = re.compile(r"in vigore\s+dal(?:l['’])?\s*(.{0,60}?)(?:\s*[-–;]|$)", re.I)
_TI_DECISION = re.compile(
    r"\b(?:dal(?:la|l['’])?|del)\s+(?:[A-Z][A-Za-z]{0,15}\.?\s+)?(?:del\s+)?(\d{1,2}\.\d{1,2}\.\d{4})")
_TI_PRECEDENTI = re.compile(r"precedent[ei]\s+modifi\w+:\s*", re.I)
# The act's own history, not an amendment of this article.
_TI_NOT_AMENDMENT = re.compile(
    r"^(?:Entrata in vigore|Approvazione federale|Abrogazione formale|Norma transitoria)\b", re.I)


def _parse_ti(note: str) -> list[Event]:
    m = _TI_PRECEDENTI.search(note)
    main, tail = (note[:m.start()], note[m.end():]) if m else (note, None)
    events: list[Event] = []
    if not _TI_NOT_AMENDMENT.match(main.strip()):
        action = None
        for name, pattern in _TI_ACTIONS:
            if pattern.search(main):
                action = name
                break
        decision_m = _TI_DECISION.search(main)
        decision = _ddmm(decision_m.group(1)) if decision_m else None
        vigore = _TI_VIGORE.search(main)
        force = _it_date(vigore.group(1)) if vigore else None
        bu = _TI_BU.search(main)
        ref = f"BU {bu.group(1)}, {_WS.sub(' ', bu.group(2))}" if bu else None
        if ref is None:
            bare = _TI_BU_BARE.search(main)
            if bare:
                ref = f"BU {bare.group(1)}, {bare.group(2)}"
        if action or (decision and (force or ref)):
            events.append(Event(action, decision, force, ref))
    if tail:
        for bu in _TI_BU.finditer(tail):
            events.append(Event(None, None, None,
                                f"BU {bu.group(1)}, {_WS.sub(' ', bu.group(2))}"))
    return events


# ---------------------------------------------------------------------------
# The one entry point per note, and the write
# ---------------------------------------------------------------------------

def parse_note(jurisdiction: str, note: str, article_number: str | None = None) -> list[Event]:
    """The amendment events one note describes: [] when the note is a
    cross-reference or the act's own history, one Event per amendment
    otherwise. Unknown jurisdictions yield [] -- this module knows exactly
    three grammars and guessing a fourth would fabricate history."""
    if jurisdiction == "GE":
        return _parse_ge(note, article_number)
    if jurisdiction == "NE":
        return _parse_ne(note)
    if jurisdiction == "TI":
        return _parse_ti(note)
    return []


@dataclass(frozen=True)
class NoteEvent:
    e_id: str
    raw_note: str
    event: Event


def events_of(jurisdiction: str, articles: list[akn.Article]) -> list[NoteEvent]:
    """Every amendment event on every article's notes, in article order."""
    out: list[NoteEvent] = []
    for article in articles:
        for note in article.notes:
            for event in parse_note(jurisdiction, note, article.article_number):
                out.append(NoteEvent(article.e_id, note, event))
    return out


def source_id_of(ref: str) -> int:
    """A stable 63-bit id for a reference string: the portals publish no
    numeric document ids, and ch_act_change_document.source_id must be the
    same value every run for the upsert on (jurisdiction, source_id,
    act_id) to be idempotent."""
    return int.from_bytes(hashlib.sha1(ref.encode("utf-8")).digest()[:8], "big") >> 1


_UPSERT_DOCUMENT = """
INSERT INTO ch_act_change_document
    (act_id, jurisdiction, source_id, number, title, date_publication,
     date_decision, pdf_url, metadata_json, updated_at)
VALUES (%(act_id)s, %(jurisdiction)s, %(source_id)s, %(number)s, NULL, NULL,
        %(date_decision)s, NULL, %(metadata)s, now())
ON CONFLICT (jurisdiction, source_id, act_id) DO UPDATE SET
    number        = EXCLUDED.number,
    date_decision = COALESCE(EXCLUDED.date_decision, ch_act_change_document.date_decision),
    metadata_json = EXCLUDED.metadata_json,
    updated_at    = now()
RETURNING change_document_id
"""

_INSERT_PROVENANCE = (
    "INSERT INTO ch_article_provenance (version_id, e_id, action, as_reference, "
    "bbl_reference, effective_date, source_act_date, raw_note, anchor_level, "
    "container_articles, change_document_id) "
    "VALUES (%s, %s, %s, %s, NULL, %s, %s, %s, 'article', NULL, %s)")


@dataclass
class StoreResult:
    documents: int = 0
    rows: int = 0
    linked: int = 0


def store(conn, version_id: int, act_id: int, jurisdiction: str,
          note_events: list[NoteEvent], platform: str) -> StoreResult:
    """Replace this version's provenance rows and upsert the act's change
    documents from the events' references. Caller wraps this in the same
    transaction as store_articles, exactly as cantonal_parse_stage does.

    A document's date_decision is the one decision date its events agree
    on; events that disagree (the same FO issue cited with two dates) leave
    it as it stands. linked counts rows whose event carries a reference --
    by construction every such row links, since the documents ARE the
    distinct references."""
    result = StoreResult()
    decisions: dict[str, set[datetime.date]] = {}
    for ne in note_events:
        if ne.event.source_ref:
            decisions.setdefault(ne.event.source_ref, set())
            if ne.event.date_decision:
                decisions[ne.event.source_ref].add(ne.event.date_decision)
    doc_ids: dict[str, int] = {}
    with conn.cursor(row_factory=tuple_row) as cur:
        for ref in sorted(decisions):
            dates = decisions[ref]
            cur.execute(_UPSERT_DOCUMENT, {
                "act_id": act_id,
                "jurisdiction": jurisdiction,
                "source_id": source_id_of(ref),
                "number": ref,
                "date_decision": next(iter(dates)) if len(dates) == 1 else None,
                "metadata": json.dumps({"platform": platform, "ref": ref},
                                       ensure_ascii=False),
            })
            doc_ids[ref] = cur.fetchone()[0]
        result.documents = len(doc_ids)
        cur.execute("DELETE FROM ch_article_provenance WHERE version_id = %s", (version_id,))
        for ne in note_events:
            document_id = doc_ids.get(ne.event.source_ref) if ne.event.source_ref else None
            cur.execute(_INSERT_PROVENANCE, (
                version_id, ne.e_id, ne.event.action, ne.event.source_ref,
                ne.event.date_in_force, ne.event.date_decision, ne.raw_note,
                document_id))
            result.rows += 1
            result.linked += document_id is not None
    return result
