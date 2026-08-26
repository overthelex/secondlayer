"""The amtsblattportal.ch (SHAB / FOSC) bulk-export list format.

The endpoint, probed live on 2026-08-26 with no authentication of any kind:

    GET https://amtsblattportal.ch/api/v1/publications/xml
        ?publicationStates=PUBLISHED
        &rubrics=HR
        &publicationDate.start=YYYY-MM-DD&publicationDate.end=YYYY-MM-DD
        &pageRequest.size=2000&pageRequest.page=N

It answers a `<bulk:bulk-export>` envelope carrying `<total>` (the size of the
WHOLE filtered result set, not of the page), a `<pageRequest>` echo, and one
`<publication ref="…/{uuid}/xml">` per hit whose `<meta>` block is all this
module reads. Measured totals for the two rubrics this pipeline walks:
HR (Handelsregister) 2,293,215 and KK (Konkurse und Schuldenrufe) 215,853.

Everything below was checked against 70 real titles captured that day and kept
in tests/fixtures/registries/shab_titles.txt, plus two three-publication pages
in shab_list_hr.xml / shab_list_kk.xml. What those captures actually contained
is what shaped three decisions here:

  * `<meta>` is read by DIRECT CHILD, never by a recursive walk. `<id>` occurs
    twice inside one meta block -- the publication's own id and the
    registration office's -- so a walk that takes the first `<id>` it finds is
    correct only as long as the two happen to stay in that order.
  * A KK title has NO SEAT. "Kollokationsplan und Inventar Christian Schwägli,
    ausgeschlagene Erbschaft" ends in a comma segment that is a statement
    about the estate, and "Avis préalable d'ouverture de faillite MOBS CH
    SARL, EN LIQUIDATION" ends in one that is part of the company's name.
    Applying HR's "the last segment is the seat" rule to KK would have written
    "ausgeschlagene Erbschaft" into 8 of 20 sampled seats.
  * HR03 in French is "Annulation", not the "Radiation" the plan predicted --
    4 of the 5 HR03 titles in the sample. A verb list written from the plan
    alone would have left the verb inside every one of those company names.

`legalRemedy` is deliberately not captured: it is the same paragraph of
statutory boilerplate on every publication of a sub-rubric, so storing it
would be ~2.5M copies of a dozen distinct strings.
"""
from __future__ import annotations

import calendar
import datetime as dt
import html
import re
from decimal import Decimal, InvalidOperation
from urllib.parse import urlencode
from xml.etree import ElementTree as ET

ENDPOINT = "https://amtsblattportal.ch/api/v1/publications/xml"

# The endpoint's own maximum; a larger value is silently clamped.
PAGE_SIZE = 2000

# executemany batch for the stage's upsert.
UPSERT_BATCH = 500

# The languages amtsblattportal publishes every title in.
LANGUAGES = ("de", "fr", "it", "en")

# Sub-rubric labels, used for ch_shab_publications.publication_type.
#
# Every entry below is the German title prefix of a publication the endpoint
# actually returned on 2026-08-26. The codes were found by probing each one
# with `subRubrics=<code>` over 2025-01-01..2026-08-26 and reading the
# `<total>` and the first title, plus the distribution over a full month of
# each rubric (KK 2026-08: 3,963 publications; HR 2026-08: 18,764).
#
# Two codes are deliberately absent:
#
#   HR04..HR07 -- they exist in the older ch_kantonsblatt importer's list, but
#   each of them answers total=0 over a 20-month window. Nothing to label.
#
#   KK10 (1,163 publications) -- its titles are free text written by the
#   office, IDENTICAL in all four languages and with no fixed opening phrase
#   ("Beschwerde mit aufschiebender Wirkung, Yalcin Mehmet, Unterkulm",
#   "Avviso di liquidazione speciale ai sensi dell'art. 230a LEF",
#   "Aufhebung Konkurseröffnung"). There is no phrase to label it with and no
#   verb to strip, so the code stands and parse_title leaves those titles whole.
#
# sub_rubric_label() returns the code itself for anything not here. A wrong
# label is worse than a bare code, because a bare code is visibly a code.
SUB_RUBRIC_LABELS = {
    "HR01": "Neueintragung",
    "HR02": "Mutation",
    "HR03": "Löschung",
    "KK01": "Vorläufige Konkursanzeige",
    "KK02": "Konkurspublikation/Schuldenruf",
    "KK03": "Einstellung des Konkursverfahrens",
    "KK04": "Kollokationsplan und Inventar",
    "KK05": "Verteilungsliste und Schlussrechnung",
    "KK06": "Schluss des Konkursverfahrens",
    "KK07": "Widerruf des Konkurses",
    "KK08": "Konkursamtliche Grundstücksteigerung",
    "KK09": "Lastenverzeichnisse",
    "KK11": "Anerkennung eines ausländischen Konkurses",
    "KK12": "Verzicht auf die Durchführung eines IPRG-Konkursverfahrens",
}

# The leading verb phrase a title opens with, in all four languages. Matched
# longest-first, so "Kollokationsplan und Inventar" wins over "Kollokationsplan"
# and the shorter one never truncates the longer one's title into a name
# beginning with "und Inventar".
#
# Every phrase here was READ OFF A LIVE PUBLICATION of the sub-rubric it
# belongs to (one probe per code, 2026-08-26), never predicted. Three of the
# predictions in the plan were wrong and would each have left the verb glued to
# a company name:
#
#   HR01 fr/it/en is "Nouvelles entrées" / "Nuove registrazioni" /
#        "New entries" -- plural, not the singular "Nouvelle inscription" /
#        "Nuova iscrizione" / "New entry".
#   HR03 fr is "Annulation", not "Radiation" -- all five HR03 titles in the
#        sampled page.
#   The renounced-estate qualifier in Italian is "eredità rifiutata", not
#        "eredità rinunciata", and in English "refused estate".
#
# Language-agnostic on purpose: the phrases do not collide across languages
# ("Mutation" is the same word and the same event in German and French), and a
# per-language table would fail on the one thing that actually varies -- a
# publication whose `language` is one thing and whose title, for an office that
# writes only in German, is another (KK10 is exactly that).
_VERBS = (
    # HR01 / HR02 / HR03
    "Neueintragung", "Nouvelles entrées", "Nuove registrazioni", "New entries",
    "Mutation", "Cambiamenti", "Change",
    "Löschung", "Annulation", "Cancellazione", "Deletion",
    # KK01..KK09, KK11, KK12 (KK10 is free text -- see SUB_RUBRIC_LABELS)
    "Vorläufige Konkursanzeige", "Avis préalable d'ouverture de faillite",
    "Avviso provvisorio di apertura di fallimento",
    "Provisional announcement of bankruptcy",
    "Konkurspublikation/Schuldenruf",
    "Publication de faillite/appel aux créanciers",
    "Pubblicazione di fallimento/diffida ai creditori",
    "Bankruptcy publication/call to creditors",
    "Einstellung des Konkursverfahrens", "Suspension de la procédure de faillite",
    "Sospensione della procedura di fallimento",
    "Suspension of bankruptcy proceedings",
    # KK04 publishes with and without the inventory, in German and in French
    # ("Kollokationsplan Econom Treuhand AG", "Etat de collocation Catherine
    # GRANDJEAN"). Both short forms are observed; no short Italian or English
    # one was, so none is invented.
    "Kollokationsplan und Inventar", "Kollokationsplan",
    "Etat de collocation et inventaire", "Etat de collocation",
    "Graduatoria e inventario", "Collocation plan and inventory",
    "Verteilungsliste und Schlussrechnung",
    "Liste de répartition et décompte final",
    "Stato di ripartizione e conto finale",
    "Distribution list and final accounts",
    "Schluss des Konkursverfahrens", "Clôture de faillite",
    "Chiusura della procedura di fallimento",
    "Closing of bankruptcy proceedings",
    "Widerruf des Konkurses", "Révocation de faillite", "Revoca del fallimento",
    "Revocation of bankruptcy",
    "Konkursamtliche Grundstücksteigerung",
    "Vente aux enchères forcée d'immeubles",
    "Pubblici incanti di fondi nel fallimento",
    "Auction of land by bankruptcy office",
    "Lastenverzeichnisse", "Etat des charges", "Elenco degli oneri",
    "Schedules of claims",
    "Anerkennung eines ausländischen Konkurses (Art. 166 ff. IPRG)",
    "Reconnaissance d'une faillite étrangère (cf. art. 166 ss. LDIP)",
    "Riconoscimento fallimento estero",
    "Recognition of a foreign bankruptcy (Art. 166 et seq. IPLA)",
    "Verzicht auf die Durchführung eines IPRG-Konkursverfahrens (Art. 174a IPRG)",
    "Renonciation à la procédure de faillite prévue par la LDIP "
    "(cf. art. 174a LDIP)",
    "Rinuncia all'esecuzione di una procedura di fallimento ancillare "
    "(art. 174a LDIP)",
    "Waiver of an IPLA bankruptcy proceeding (Art. 174a IPLA)",
)
_VERB_PREFIXES = tuple(sorted(_VERBS, key=len, reverse=True))

# The gazette writes the French and Italian apostrophe both ways -- KK08 fr has
# "d'immeubles" with U+0027 and KK11 fr has "d’une" with U+2019, in the same
# rubric on the same day. Normalised for MATCHING only, and the substitution is
# one character for one so the offsets used to slice the original still hold.
_APOSTROPHES = str.maketrans({"\u2019": "'", "\u02bc": "'"})

# "Mutation X, <old seat>, neu <new seat>" -- the tail announces the change,
# so it is cut before the seat is read and the row keeps the seat the company
# had at publication time. shab-detail overwrites both from the detail XML.
_NEW_TAIL = re.compile(r",\s+(?:neu|nouveau|nouvelle|nuovo|nuova|new)\s+")

# A KK debtor is often an estate rather than a person; the qualifier is a fact
# about the proceedings, not part of the name, and leaving it in stops the name
# from ever matching Zefix. All four forms are from live KK04/KK06/KK08 titles.
# Bare "succession" is the Geneva office's own short form ("Etat de collocation
# Gérard Daniel COQUOZ, succession"), seen alongside the full "succession
# répudiée" in the same rubric. Anchored at the end, so it cannot eat a comma
# segment in the middle of a name.
_ESTATE_QUALIFIER = re.compile(
    r",\s+(?:ausgeschlagene\s+Erbschaft|succession\s+répudiée|succession|"
    r"eredità\s+rifiutata|refused\s+estate)\s*$", re.IGNORECASE)


def sub_rubric_label(code: str | None) -> str | None:
    """The human label for a sub-rubric, or the code itself when unobserved."""
    if not code:
        return None
    return SUB_RUBRIC_LABELS.get(code, code)


def month_bounds(month: dt.date) -> tuple[dt.date, dt.date]:
    """(first day, last day) of the month `month` falls in."""
    first = month.replace(day=1)
    return first, first.replace(day=calendar.monthrange(first.year, first.month)[1])


def list_url(rubric: str, start: dt.date, end: dt.date, page: int = 0,
             size: int = PAGE_SIZE) -> str:
    """One page of one rubric over one date window.

    publicationDate.start/end are inclusive on both ends (checked against a
    single-day window that returned that day's publications).
    """
    return ENDPOINT + "?" + urlencode({
        "publicationStates": "PUBLISHED",
        "rubrics": rubric,
        "publicationDate.start": start.isoformat(),
        "publicationDate.end": end.isoformat(),
        "pageRequest.size": size,
        "pageRequest.page": page,
    })


def _tag(element) -> str:
    tag = element.tag
    return tag.split("}", 1)[-1] if isinstance(tag, str) and "}" in tag else tag


def _text(element) -> str:
    return (element.text or "").strip() if element is not None else ""


def _child(parent, name: str):
    """The first DIRECT child called `name`. See the module docstring for why
    this is not a recursive search."""
    for child in parent:
        if _tag(child) == name:
            return child
    return None


def _date(raw: str) -> dt.date | None:
    try:
        return dt.date.fromisoformat(raw)
    except ValueError:
        return None


def parse_list_page(xml_bytes: bytes) -> tuple[int, list[dict]]:
    """(total, one meta dict per publication).

    `total` is the size of the whole filtered result set, which is what the
    caller needs to know how many pages to ask for; len(metas) is this page.

    A publication with no `<id>` is dropped: shab_id is the upsert key, so a
    row without one could be written but never found, updated or given a
    detail. Everything else is best effort -- a missing field is None and the
    row still lands, because a list row is a pointer to a detail fetch, not
    the final record.
    """
    root = ET.fromstring(xml_bytes)
    total = int(_text(_child(root, "total")) or 0)

    metas: list[dict] = []
    for publication in root:
        if _tag(publication) != "publication":
            continue
        meta = _child(publication, "meta")
        if meta is None:
            continue
        shab_id = _text(_child(meta, "id"))
        if not shab_id:
            continue

        office = _child(meta, "registrationOffice")
        title_element = _child(meta, "title")
        titles = {}
        if title_element is not None:
            for child in title_element:
                text = _text(child)
                if text:
                    titles[_tag(child)] = text
        language = _text(_child(meta, "language")) or None

        cantons = [_text(node) for node in meta if _tag(node) == "cantons"]
        # <cantons>NE</cantons> in every sample, but the plural is the schema's
        # own word for the field, so a nested <canton> list is accepted too.
        nested = [_text(node) for element in meta if _tag(element) == "cantons"
                  for node in element if _tag(node) == "canton"]
        cantons = [c for c in cantons + nested if c]

        metas.append({
            "id": shab_id,
            "ref": publication.get("ref"),
            "rubric": _text(_child(meta, "rubric")) or None,
            "sub_rubric": _text(_child(meta, "subRubric")) or None,
            "language": language,
            "publication_number": _text(_child(meta, "publicationNumber")) or None,
            "publication_date": _date(_text(_child(meta, "publicationDate"))),
            "cantons": cantons[0] if cantons else None,
            "all_cantons": cantons,
            "title": titles.get(language) or titles.get("de") or None,
            "titles": titles,
            "registration_office": _text(_child(office, "displayName")) or None
                                   if office is not None else None,
        })
    return total, metas


def parse_title(title: str | None, lang: str | None = None,
                rubric: str | None = None) -> tuple[str | None, str | None]:
    """(company_name, seat) from a publication title.

    `lang` is accepted because callers have it and the signature is part of
    the stage contract; the verb table is deliberately language-agnostic (see
    _VERBS). `rubric` is what actually changes the shape: only HR titles carry
    a seat.

    Forgiving by construction. A verb this table has never seen -- HR04..HR07
    and KK05 were not in the captures -- leaves the title whole rather than
    cutting it at a guessed word boundary, so the worst case is a name with a
    verb glued to its front, which still matches on a trigram search.
    """
    text = " ".join((title or "").split())
    if not text:
        return None, None

    probe = text.translate(_APOSTROPHES)
    for verb in _VERB_PREFIXES:
        # ", " as well as " ": KK10-style titles put a comma after the phrase,
        # and so does the occasional office elsewhere.
        for separator in (" ", ", "):
            if probe.startswith(verb + separator):
                text = text[len(verb) + len(separator):].strip()
                break
        else:
            if probe == verb:
                return None, None
            continue
        break

    if rubric == "KK":
        return _ESTATE_QUALIFIER.sub("", text).strip() or None, None

    tail = _NEW_TAIL.search(text)
    if tail:
        text = text[:tail.start()].strip()
    if "," in text:
        name, _, seat = text.rpartition(",")
        return name.strip() or None, seat.strip() or None
    return text or None, None


# --- the detail endpoint ---------------------------------------------------
#
# GET https://amtsblattportal.ch/api/v1/publications/{id}/xml, no
# authentication, probed live on 2026-08-25/26 over eight publications across
# both rubrics. The body is `<{SUBRUBRIC}:publication>` carrying the SAME
# `<meta>` block the list page served, plus one `<content>` block whose shape
# is decided by the sub-rubric. What the captures actually held:
#
# HR (fixtures shab_detail_hr.xml = HR01, shab_detail_hr03.xml = HR03):
#     content/publicationText          the whole entry as prose
#     content/commonsNew               the state AFTER the event (HR01, HR02)
#     content/commonsActual            the state BEFORE it (HR02, HR03)
#         company/name, /uid, /uidOrganisationId, /seat, /legalForm, /address
#         purpose, capital/nominal, capital/paid
#     content/journalNumber, /journalDate
#     content/lastFosc/lastFoscDate, /lastFoscNumber, /lastFoscSequence
#     content/transaction/{registration|update|delete}
#     content/senderOffice/officeName
#
#   commonsNew is preferred and commonsActual is the fallback, in that order,
#   because they are not alternatives: an HR02 that renames a company carries
#   BOTH ("Avenso Schweiz GmbH" actual, "Lumas Galerien GmbH" new), and the
#   publication is the announcement of the new state. An HR03 deletion has no
#   new state at all and only commonsActual -- reading commonsNew alone would
#   leave every deletion in the corpus without a company.
#
#   legalForm is an eCH-0097 CODE ("0107"), not a label. Kept as the code:
#   ch_zefix_companies.legal_form_code holds the same codes from LINDAS, and
#   the detail stage resolves the label through that table rather than through
#   a hand-written map (see chpipe/zefix.py's docstring for the two labels a
#   hand-written map got wrong).
#
# KK (fixtures shab_detail_kk.xml = KK01, _kk04 = KK04, _kk06 = KK06):
#     content/debtor/selectType        "company" or "person"
#     content/debtor/companies/noUID   the office's own "no UID known" flag
#     content/debtor/companies/company/{name,uid,uidOrganisationId,legalForm}
#     content/debtor/person/{prename,name,dateOfBirth,dateOfDeath}
#     content/typeOfCirculation/selectType
#     content/remarks                  free text, often the only prose
#     content/registrationOfficeAndCirculationAuthority | /registrationOffice
#     content/publication              KK10 only: the body, as escaped HTML
#
#   A KK publication states NO SEAT: the debtor block carries a postal address
#   and a canton, and neither is a legal seat. seat stays None rather than
#   being filled with a town the register never called a seat.
#
# `legalRemedy` is in `<meta>` on the detail too, and is skipped for the same
# reason as in the list: it is a dozen distinct paragraphs of boilerplate
# repeated over 2.5M publications.

DETAIL_ENDPOINT = "https://amtsblattportal.ch/api/v1/publications/{id}/xml"

# Markup inside a text node. HR's publicationText and KK10's <publication> both
# carry ESCAPED HTML (`&lt;br />`), which the XML parser hands back as literal
# tags in the text.
_MARKUP = re.compile(r"<[^>]*>")

_NON_DIGITS = re.compile(r"\D")

# The thousands separator the gazette writes as an apostrophe, both ways, plus
# the space and the non-breaking space. Removed before Decimal() sees the text.
_CAPITAL_NOISE = str.maketrans({"'": "", "’": "", "ʼ": "",
                                " ": "", " ": ""})


def detail_url(shab_id: str) -> str:
    return DETAIL_ENDPOINT.format(id=shab_id)


def canonical_uid(raw: str | None) -> str | None:
    """"344059939" or "CHE-344.059.939" -> "CHE-344.059.939".

    One canonical form, because the same company arrives as bare digits from
    `uidOrganisationId` and as a rendered UID from `uid`, and
    ch_zefix_companies.uid is the rendered form -- two spellings would mean a
    publication that never joins to its company.

    Anything that is not exactly nine digits is None rather than a guess: the
    UID is a checksummed nine-digit number, and a shorter one is not a UID
    with a typo, it is a field this parser has misread.
    """
    digits = _NON_DIGITS.sub("", raw or "")
    if len(digits) != 9:
        return None
    return f"CHE-{digits[:3]}.{digits[3:6]}.{digits[6:]}"


def parse_capital(raw: str | None) -> Decimal | None:
    """"100'000.00" -> Decimal("100000.00"). Non-numeric text is None.

    Decimal rather than float: this is money, it is written to a numeric
    column, and 20000.00 is a value a user reads back.
    """
    text = (raw or "").strip().translate(_CAPITAL_NOISE)
    if not text:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def plain_text(raw: str | None) -> str | None:
    """A publication body as text: markup stripped, whitespace normalised."""
    text = html.unescape(_MARKUP.sub(" ", raw or ""))
    return " ".join(text.split()) or None


def _first_child_tag(parent) -> str | None:
    """The name of the first child, which is how <transaction> states its kind.

    `parent is None`, not `not parent`: an element with no children is FALSY
    (and ElementTree warns about the test), so the short form would read an
    empty <transaction/> the same way as a missing one -- harmless here, and
    a trap the moment the value is used for anything but a label."""
    if parent is None:
        return None
    for child in parent:
        return _tag(child)
    return None


def _company_fields(company) -> dict:
    """name/uid/legalForm/seat off a `<company>` block, HR or KK."""
    if company is None:
        return {}
    return {
        "company_name": _text(_child(company, "name")) or None,
        "company_uid": canonical_uid(_text(_child(company, "uidOrganisationId"))
                                     or _text(_child(company, "uid"))),
        "legal_form": _text(_child(company, "legalForm")) or None,
        "seat": _text(_child(company, "seat")) or None,
    }


def _parse_hr_detail(content) -> dict:
    # `is None`, not `or`: an element with no children is falsy, so `or` would
    # silently fall through to commonsActual on an empty <commonsNew/> and
    # report the state BEFORE the event as the state after it.
    commons = _child(content, "commonsNew")
    if commons is None:
        commons = _child(content, "commonsActual")
    detail = _company_fields(_child(commons, "company")
                             if commons is not None else None)
    capital = _child(commons, "capital") if commons is not None else None
    detail.update({
        "purpose": plain_text(_text(_child(commons, "purpose")))
                   if commons is not None else None,
        "capital": parse_capital(_text(_child(capital, "nominal")))
                   if capital is not None else None,
        # Unobserved in the 2026-08 captures -- the capital block states a
        # number and no unit. Read when present, never assumed to be CHF.
        "capital_currency": (_text(_child(capital, "currency")) or None)
                            if capital is not None else None,
        "content": plain_text(_text(_child(content, "publicationText"))),
    })

    last_fosc = _child(content, "lastFosc")
    sender = _child(content, "senderOffice")
    transaction = _child(content, "transaction")
    detail["extra"] = {
        "journal_number": _text(_child(content, "journalNumber")) or None,
        "journal_date": _text(_child(content, "journalDate")) or None,
        "transaction": _first_child_tag(transaction),
        "sender_office": _text(_child(sender, "officeName")) or None
                         if sender is not None else None,
        "last_fosc_date": _text(_child(last_fosc, "lastFoscDate")) or None
                          if last_fosc is not None else None,
        "last_fosc_number": _text(_child(last_fosc, "lastFoscNumber")) or None
                            if last_fosc is not None else None,
        "last_fosc_sequence": _text(_child(last_fosc, "lastFoscSequence")) or None
                              if last_fosc is not None else None,
    }
    return detail


def _parse_kk_detail(content) -> dict:
    debtor = _child(content, "debtor")
    companies = _child(debtor, "companies") if debtor is not None else None
    person = _child(debtor, "person") if debtor is not None else None

    detail = _company_fields(_child(companies, "company")
                             if companies is not None else None)
    no_uid = _text(_child(companies, "noUID")).lower() if companies is not None else ""
    if no_uid == "true":
        # The office says it does not know the debtor's UID. Whatever else the
        # block holds, there is no identifier to store.
        detail["company_uid"] = None
    if person is not None:
        detail["company_name"] = " ".join(
            part for part in (_text(_child(person, "prename")),
                              _text(_child(person, "name"))) if part) or None

    circulation = _child(content, "typeOfCirculation")
    remarks = plain_text(_text(_child(content, "remarks")))
    # KK10 is the one sub-rubric with a body of its own; every other one's
    # prose is the remarks, and content is what a search reads.
    detail["content"] = (plain_text(_text(_child(content, "publication")))
                         or remarks)
    detail.update({"purpose": None, "capital": None, "capital_currency": None})
    detail["extra"] = {
        "debtor_type": _text(_child(debtor, "selectType")) or None
                       if debtor is not None else None,
        "no_uid": True if no_uid == "true" else (False if no_uid else None),
        "type_of_circulation": _text(_child(circulation, "selectType")) or None
                               if circulation is not None else None,
        "remarks": remarks,
        # Two spellings of the same fact -- where a creditor files and who is
        # handling the estate. KK04/KK05 use the long name, the rest the short.
        "circulation_authority": plain_text(
            _text(_child(content, "registrationOfficeAndCirculationAuthority"))
            or _text(_child(content, "registrationOffice"))),
        # The only thing that distinguishes two debtors of the same name.
        "date_of_birth": _text(_child(person, "dateOfBirth")) or None
                         if person is not None else None,
    }
    return detail


def parse_detail(xml_bytes: bytes, rubric: str | None = None) -> dict:
    """One publication's detail XML -> the columns and the metadata it fills.

    `rubric` picks the content shape: "KK" reads a debtor, anything else reads
    a Handelsregister entry. It is a parameter rather than something read off
    the body because the queue row already knows it and a body whose meta and
    whose content disagree is a body this parser should not be guessing about.

    Keys always present: company_uid, company_name, legal_form, seat, purpose,
    capital, capital_currency, content, extra. `extra` holds only the keys the
    rubric actually provides, with None for a field the schema has but this
    publication left empty -- the detail stage drops the Nones before merging.

    Raises ValueError when there is no `<content>` block. All eight
    publications probed on 2026-08-26 had one; a body without it is not a
    publication this parser understands, and stamping the row as fetched would
    record emptiness as a fact about the company.
    """
    root = ET.fromstring(xml_bytes)
    content = _child(root, "content")
    if content is None:
        raise ValueError("publication has no <content> block")
    detail = (_parse_kk_detail(content) if rubric == "KK"
              else _parse_hr_detail(content))
    detail.setdefault("company_uid", None)
    detail.setdefault("company_name", None)
    detail.setdefault("legal_form", None)
    detail.setdefault("seat", None)
    return detail
