"""Async client for lexfind.ch's front-end API (`/api/fe/{lang}/`), the
registry of all 26 cantons' legislation run by the Chancellery of Fribourg.

Undocumented but open (empty robots.txt, no auth); routes were read out of
the SPA bundle and verified 2026-08-26:

  entities                                   26 cantons + CH (27) + Intlex (28)
  entities/{id}/systematics?active_only=false
        &tols_for_systematics[]={leaf}...    tree of nodes; `tols` filled for
                                             the leaf ids passed
  texts-of-law/{tol}/with-version-groups     the act with families[[[version]]]
  /tolv/{version}/{lang}                     the version's PDF (phase 2)

The PDF route is derivable from ids alone: dtah_urls[].url is exactly
"/tolv/{version_id}/{language}", and verified live 2026-08-26 on
https://www.lexfind.ch/tolv/251719/de -> HTTP 200, Content-Type
application/pdf, body starts with %PDF-1.4, no redirect, no browser
User-Agent needed (identical answer with the pipeline UA and with none).
/api/fe/de/tolv/... is a 404; the PDF lives on the site root, not the API.

LexFind is the INDEPENDENT side of the cantonal reconciliation gate: what
it lists is compared with what the Lexwork hosts serve. It is deliberately
not used as a text source in phase 1.
"""
from __future__ import annotations

from urllib.parse import urlencode

from . import cantons
from .http import Fetcher

# LexFind's systematics endpoint takes node ids as a repeated query
# parameter; 50 per request keeps the URL well under any proxy's limit and
# BE's 425 nodes in 9 requests.
LEAVES_PER_REQUEST = 50

LEXFIND_SITE = "https://www.lexfind.ch"


def pdf_url(version_id: int, lang: str) -> str:
    """The PDF of one version in one language, on the site root. Kept as a
    function of the ids rather than read back from versions_json so a
    registry row written before pdf_urls existed still resolves: the
    26,252 prod rows of 2026-08-26 hold only `languages`, and re-walking
    them (~4 h at 2 req/s) is not a precondition of materialising them."""
    return f"{LEXFIND_SITE}/tolv/{int(version_id)}/{lang}"


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


def node_ids(tree: dict) -> list[int]:
    """Every node id of the systematics tree, root entry ("") excluded.
    Acts hang off INNER nodes as well as leaves (BE 2026-08-26: 23 acts on
    the first 50 inner nodes; asking for leaves only found 1,009 of 1,129),
    so the registry walk asks for every node's tols."""
    return sorted(int(key) for key, node in tree.items() if key and isinstance(node, dict))


def leaves(tree: dict) -> list[int]:
    """Node ids with no children -- kept for reports; NOT the driving set."""
    return sorted(int(key) for key, node in tree.items()
                  if key and isinstance(node, dict) and not node.get("children"))


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
    """families[[[version]]] -> one flat list, document order (newest
    first: 8,488 of 8,488 acts of the 7 LexFind-only cantons on prod
    2026-08-26 list their latest version at index 0), with the bulky
    dtah_urls reduced to the languages they name and, per language, the
    PDF URL they point at (`pdf_urls`). A dtah_urls entry without a url
    falls back to the id-derived route, which is the same string."""
    out = []
    for family in groups.get("families") or []:
        for group in family:
            for version in group:
                slim = {k: v for k, v in version.items() if k not in ("dtah_urls", "keywords")}
                slim["languages"] = [d.get("language") for d in version.get("dtah_urls") or []]
                slim["pdf_urls"] = {
                    d["language"]: (LEXFIND_SITE + d["url"] if d.get("url", "").startswith("/")
                                    else pdf_url(version["id"], d["language"]))
                    for d in version.get("dtah_urls") or [] if d.get("language")}
                out.append(slim)
    return out
