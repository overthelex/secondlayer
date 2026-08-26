"""Async client for lexfind.ch's front-end API (`/api/fe/{lang}/`), the
registry of all 26 cantons' legislation run by the Chancellery of Fribourg.

Undocumented but open (empty robots.txt, no auth); routes were read out of
the SPA bundle and verified 2026-08-26:

  entities                                   26 cantons + CH (27) + Intlex (28)
  entities/{id}/systematics?active_only=false
        &tols_for_systematics[]={leaf}...    tree of nodes; `tols` filled for
                                             the leaf ids passed
  texts-of-law/{tol}/with-version-groups     the act with families[[[version]]]
  /tolv/{version}/{lang}                     PDF (phase 2)

LexFind is the INDEPENDENT side of the cantonal reconciliation gate: what
it lists is compared with what the Lexwork hosts serve. It is deliberately
not used as a text source in phase 1.
"""
from __future__ import annotations

from urllib.parse import urlencode

from . import cantons
from .http import Fetcher

# LexFind's systematics endpoint takes the leaf ids as a repeated query
# parameter; 50 per request keeps the URL well under any proxy's limit and
# BE's 303 leaves in 7 requests.
LEAVES_PER_REQUEST = 50


class LexfindClient:
    def __init__(self, fetcher: Fetcher, base: str = cantons.LEXFIND_API):
        self._fetcher = fetcher
        self._base = base.rstrip("/")

    async def systematics(self, entity_id: int, leaf_ids: list[int] | None = None) -> dict:
        query = [("active_only", "false")]
        for leaf in leaf_ids or []:
            query.append(("tols_for_systematics[]", str(leaf)))
        url = f"{self._base}/entities/{entity_id}/systematics?{urlencode(query)}"
        return await self._fetcher.json(url)

    async def with_version_groups(self, tol_id: int) -> dict:
        return await self._fetcher.json(f"{self._base}/texts-of-law/{tol_id}/with-version-groups")


def leaves(tree: dict) -> list[int]:
    """Node ids with no children. The tree is a dict keyed by node id as a
    string, with an unnamed root entry ("" -> {children}) that is skipped."""
    out = []
    for key, node in tree.items():
        if not key or not isinstance(node, dict):
            continue
        if not node.get("children"):
            out.append(int(key))
    return sorted(out)


def tols_of(tree: dict) -> list[dict]:
    """Every text of law attached to a node of the tree, with the node's
    systematic identifier and title carried along as `category`."""
    out = []
    for key, node in tree.items():
        if not key or not isinstance(node, dict):
            continue
        for tol in node.get("tols") or []:
            enriched = dict(tol)
            enriched["category"] = f"{node.get('identifier', '')} {node.get('title', '')}".strip()
            out.append(enriched)
    return out


def flatten_versions(groups: dict) -> list[dict]:
    """families[[[version]]] -> one flat list, document order, with the
    bulky dtah_urls reduced to the languages they name."""
    out = []
    for family in groups.get("families") or []:
        for group in family:
            for version in group:
                slim = {k: v for k, v in version.items() if k not in ("dtah_urls", "keywords")}
                slim["languages"] = [d.get("language") for d in version.get("dtah_urls") or []]
                out.append(slim)
    return out
