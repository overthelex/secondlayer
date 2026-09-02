"""Federal Gazette citations, normalised so two spellings of the same place
compare equal.

Fedlex writes an expression's own citation as "BBl 2001 1433" (de) or
"FF 2001 1341" (fr, it -- the French and Italian editions have their own
pagination, so the three languages of one Botschaft carry three different
page numbers). The consolidation footnotes migration 198 stores in
ch_article_provenance.bbl_reference write the same thing in the footnote's
language, plus the pre-1999 multi-volume form "FF 1986 II 360" and the
occasional trailing "ff." / "s." / "segg.".

bbl_key() reduces every one of those to 'year|volume|page', volume empty
when absent, so a footnote and a work match on the key alone. The volume
is kept (not dropped) because "FF 1986 II 360" and "FF 1986 III 360" are
different places; that they can never match a Fedlex work (which start in
1999) is the known ceiling, not a reason to conflate them.

Since 2021 the Gazette is no longer paginated: a citation is "BBl 2021
2318", the year and the DOCUMENT NUMBER, identical in all three languages
-- and that number is the work's ELI sequence (/eli/fga/2021/2318). Those
expressions carry no historicalLegalId at all, so eli_key() derives the
same 'year||number' key from the ELI for that era. Measured 2026-09-02
against prod's provenance rows of 2021+: 23,874 of 26,476 citations name
a discovered material's ELI number; the rest cite Gazette documents that
are not materials (the enacted text itself, drafts).
"""
from __future__ import annotations

import re

_CITATION = re.compile(
    r"^\s*(?:BBl|FF|BBI)\s+(\d{4})\s+(?:([IVX]{1,4})\s+)?(\d+)\b", re.IGNORECASE)


def bbl_key(reference: str | None) -> str | None:
    """'BBl 2001 1433' -> '2001||1433'; 'FF 1986 II 360' -> '1986|II|360';
    anything that is not a Gazette citation -> None."""
    if not reference:
        return None
    m = _CITATION.match(reference)
    if not m:
        return None
    year, volume, page = m.group(1), (m.group(2) or "").upper(), m.group(3).lstrip("0") or "0"
    return f"{year}|{volume}|{page}"


_ELI_FGA = re.compile(r"/eli/fga/(\d{4})/(\d+)/?$")
# The first Gazette year cited by document number rather than by page.
ELI_KEY_FROM_YEAR = 2021


def eli_key(eli_work_uri: str | None) -> str | None:
    """'https://fedlex.data.admin.ch/eli/fga/2021/2318' -> '2021||2318' for
    the document-numbered era (2021+); None for an older ELI, whose number
    is a sequence unrelated to the page a footnote would cite."""
    m = _ELI_FGA.search(eli_work_uri or "")
    if not m or int(m.group(1)) < ELI_KEY_FROM_YEAR:
        return None
    return f"{m.group(1)}||{m.group(2).lstrip('0') or '0'}"
