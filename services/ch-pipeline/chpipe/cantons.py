"""The 26 cantons, their legislation platform and their LexFind entity id.

Hosts were identified 2026-08-26 from LexFind's dta_urls[].original_url and
verified by GET /api/de/status on BE, BL, GR, AI, FR, LU (the same Angular
bundle everywhere, clex.ch included). The language tuple is an expectation
used when versions are discovered; the truth per version is the payload's
available_languages[], and cantonal_parse_stage fails a row whose language
is not in it -- visibly, as a counted reason -- rather than inventing a
translation. Hosts that were only inferred (the 13 not probed by hand) are
verified by the stage's first request (/status); a host that does not
answer is reported and skipped, not fatal for the other eighteen.

The seven cantons without a Lexwork host (ZH, VD, TI, NE, GE, JU, SZ) are
registered from LexFind only; their text is phase 2. TI is the first of
them with a text platform: 'ti_rl', the Raccolta delle leggi on www3.ti.ch
(chpipe/ti_rl.py), Italian only, one open edition per act.
"""
from __future__ import annotations

from dataclasses import dataclass

LEXFIND_API = "https://www.lexfind.ch/api/fe/de"


@dataclass(frozen=True)
class Canton:
    code: str
    host: str
    langs: tuple[str, ...]
    platform: str          # 'lexwork' | 'ti_rl' | 'lexfind' (registry only)
    lexfind_id: int


def _lw(code: str, host: str, langs: tuple[str, ...], lexfind_id: int) -> Canton:
    return Canton(code, host, tuple(langs), "lexwork", lexfind_id)


def _lf(code: str, lexfind_id: int) -> Canton:
    return Canton(code, "", (), "lexfind", lexfind_id)


ALL: dict[str, Canton] = {c.code: c for c in (
    _lw("AG", "gesetzessammlungen.ag.ch", ("de",), 1),
    _lw("AI", "ai.clex.ch", ("de",), 2),
    _lw("AR", "ar.clex.ch", ("de",), 3),
    _lw("BE", "www.belex.sites.be.ch", ("de", "fr"), 4),
    _lw("BL", "bl.clex.ch", ("de",), 5),
    _lw("BS", "www.gesetzessammlung.bs.ch", ("de",), 6),
    _lw("FR", "bdlf.fr.ch", ("de", "fr"), 7),
    _lf("GE", 8),
    _lw("GL", "gesetze.gl.ch", ("de",), 9),
    _lw("GR", "www.gr-lex.gr.ch", ("de", "it", "rm"), 10),
    _lf("JU", 11),
    _lw("LU", "srl.lu.ch", ("de",), 12),
    _lf("NE", 13),
    _lw("NW", "gesetze.nw.ch", ("de",), 14),
    _lw("OW", "gdb.ow.ch", ("de",), 15),
    _lw("SG", "www.gesetzessammlung.sg.ch", ("de",), 16),
    _lw("SH", "rechtsbuch.sh.ch", ("de",), 17),
    _lw("SO", "bgs.so.ch", ("de",), 18),
    _lf("SZ", 19),
    _lw("TG", "www.rechtsbuch.tg.ch", ("de",), 20),   # bare rechtsbuch.tg.ch does not resolve
    Canton("TI", "www3.ti.ch", ("it",), "ti_rl", 21),
    _lw("UR", "rechtsbuch.ur.ch", ("de",), 22),
    _lf("VD", 23),
    _lw("VS", "lex.vs.ch", ("de", "fr"), 24),
    _lw("ZG", "bgs.zg.ch", ("de",), 25),
    _lf("ZH", 26),
)}

LEXWORK: dict[str, Canton] = {k: v for k, v in ALL.items() if v.platform == "lexwork"}

# The ch_act_version.source (migration 203) each text platform's stages
# write. A platform absent here has no text pipeline: registry only.
SOURCE_BY_PLATFORM: dict[str, str] = {"lexwork": "lexwork", "ti_rl": "ti_rl"}


def version_source(code: str) -> str | None:
    """The ch_act_version.source the canton's text stages write, or None
    for a registry-only canton -- what Gate F filters editions on."""
    return SOURCE_BY_PLATFORM.get(ALL[code].platform)


def text_codes() -> list[str]:
    """Every canton with a text pipeline: Gate F's default list."""
    return sorted(code for code, c in ALL.items() if c.platform in SOURCE_BY_PLATFORM)


def api(canton: Canton, lang: str = "de") -> str:
    return f"https://{canton.host}/api/{lang}"


def canonical_link(canton: Canton, sysnr: str) -> str:
    """The act's stable front-end URL, used as ch_act.eli_work_uri."""
    return f"https://{canton.host}/app/de/texts_of_law/{sysnr}"


def deep_link(canton: Canton, sysnr: str, version_id: int) -> str:
    """One version's stable front-end URL, used as ch_act_version.eli_consolidation_uri."""
    return f"{canonical_link(canton, sysnr)}/versions/{version_id}"


def show_as_json_url(canton: Canton, sysnr: str, version_id: int) -> str:
    return f"{api(canton)}/texts_of_law/{sysnr}/versions/{version_id}/show_as_json"


def lexwork_codes(selection: str | None) -> list[str]:
    """CHPIPE_CANTON -> the cantons to run. Empty means every Lexwork canton;
    a code that is not a Lexwork canton is a hard error, not a silent skip."""
    if not selection:
        return sorted(LEXWORK)
    codes = [s.strip().upper() for s in selection.split(",") if s.strip()]
    unknown = [c for c in codes if c not in LEXWORK]
    if unknown:
        raise ValueError(f"not a Lexwork canton: {', '.join(unknown)} "
                         f"(Lexwork cantons: {', '.join(sorted(LEXWORK))})")
    return codes
