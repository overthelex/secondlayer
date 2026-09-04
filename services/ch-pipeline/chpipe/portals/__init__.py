"""The portal spider family: Swiss decision sources that are not on
entscheidsuche.ch (LEXAI-2039, gap plan phase 2). One module per source,
each exposing SPIDER, COURT_NAME, DECISION_TYPE, TEXT_SOURCE and an
`async discover(fetcher, known) -> list[PortalDoc]`; the discovery stage
(chpipe/stages/portals_discover_stage.py) upserts what they return into
ch_court_decisions at stage 'indexed', and the ordinary decision stages
take it from there.

PORTAL_SPIDERS is what the rest of the pipeline consults to tell a portal
row from an entscheidsuche row: delta.court_code_spider_map skips them
without the "not a spider directory" warning, and reports.py's coverage
gate leaves them out of the entscheidsuche comparison.

Measured on the live portals on 2026-09-03 (see each module's docstring for
its own numbers): FINMA enforcement 455, FINMA insurance 2,610, UBI ~667,
ElCom ~433, ESchK ~415, EMARK 237, PostCom ~282 files (de), ComCom ~64,
ESBK ~43 files, Preisüberwacher ~27, RAB ~5, MKG 58 single decisions on the
index (the bound volumes are a later pass).
"""
from __future__ import annotations

from . import (comcom, elcom, emark, esbk, eschk, finma, finma_vr, mkg, postcom,
               pue, rab, ubi)

PORTALS = {m.SPIDER: m for m in (
    finma, finma_vr, mkg, ubi, elcom, eschk, emark, postcom, comcom, esbk, pue, rab)}

PORTAL_SPIDERS: frozenset[str] = frozenset(PORTALS)

__all__ = ["PORTALS", "PORTAL_SPIDERS"]
