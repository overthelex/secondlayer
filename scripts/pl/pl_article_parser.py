#!/usr/bin/env python3
"""Split a Polish act's text.html into articles, guided by its /struct tree.

No database, no network - so it can be tested on fixtures and re-run over cached
HTML when the extraction rules change, without refetching anything.

Why struct-guided rather than regex-guided. The Ukrainian corpus had to find
articles by matching headings, because zakon.rada published no structure; that
forced the monotonicity heuristic in scripts/legislation/full-corpus/rebuild_articles.py
(article numbers must ascend, MONO_MIN=0.9) as a proxy for "this is a code, not
an amending act quoting one". Poland publishes the structure, and every unit in
the HTML carries id="{struct node id}" data-id="{symbol}" - byte-identical to
the struct tree. So the proxy is replaced by an identity: we extract exactly the
articles struct declares, and any shortfall is an error rather than a ratio.

That is measurably stronger. On DU/2020/1320 (Kodeks pracy, tekst jednolity
2020) struct declares 494 articles, all under the "Załącznik" part. The HTML
carries 497 <div class="unit unit_arti"> anchors: the three extras are
pass_2-pint_1-arti_5, pass_2-pint_1-arti_6 and pass_2-pint_2-arti_86, articles
QUOTED inside the obwieszczenie's own passages. A regex over that HTML returns
497 articles for a 494-article code and no threshold would catch it.

Verified against fixtures on 2026-08-14:
  DU/1974/141  struct 305 arti, DOM 305 anchors, 1:1, ids all distinct
  DU/2020/1320 struct 494 arti in annex, DOM 497 anchors, 3 out of scope
  DU/1964/93   2,290 struct nodes / 2,289 distinct ids - ids DO repeat
"""
import json
import re
import unicodedata

import lxml.html

# Verdict codes, shared with pl_snapshot_texts.http_status. Above the HTTP range
# on purpose, the npa.edition idiom: one column answers "can this row be used"
# for both transport and content failures.
OK = 200
NO_STRUCT = 902           # act declares textHTML but /struct 404'd
ARTICLE_SHORTFALL = 904   # struct declared N in scope, we produced fewer
LABEL_MISMATCH = 905      # DOM heading disagrees with the struct symbol

# Polish article numbering has three levels and one special case, all of which
# occur inside a single act (Kodeks pracy, tekst jednolity DU/2020/1320):
#   arti_415        Art. 415.               -> '415'
#   arti_304_4      Art. 304<SUP>4</SUP>.   -> '304^4'    (superscript)
#   arti_18_3_a     Art. 18<SUP>3</SUP><SUP>a</SUP>. -> '18^3a'  (superscript + letter)
#   arti_266-280    Art. 266-280.           -> '266-280'  (a repealed range as one node)
# The letter-suffixed form accounts for 24 of the 494 articles in that act, so
# rejecting it is not a rounding error.
_SYMBOL_RE = re.compile(r"^arti_(\d+)([a-zA-Z]*)(?:_(\d+))?(?:_([a-zA-Z]+))?$")
_RANGE_SYMBOL_RE = re.compile(r"^arti_(\d+)-(\d+)$")
# The rendered heading after <SUP> flattening, e.g. "Art. 18^3^a." or "Art. 266-280."
_HEAD_RE = re.compile(
    r"Art\.\s*(\d+)(?:-(\d+))?([a-zA-Z]*)(?:\^(\d+))?(?:\^([a-zA-Z]+))?", re.IGNORECASE)
_ANNEX_RE = re.compile(r"^\s*Za[łl][aą]cznik", re.IGNORECASE)

MIN_ARTICLE_CHARS = 10
SUBSTANCE_RATIO = 0.95


def _clean(s):
    """Collapse whitespace without losing paragraph boundaries. Same shape as
    clean() in scripts/nl/harvest_bwb_texts.py, which is the house style."""
    s = s.replace(" ", " ")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" *\n *", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def art_no_from_symbol(symbol):
    """'arti_304_4' -> ('304^4', 304, 4). Returns (None, None, None) if the
    symbol is not an addressable article symbol (struct emits `none_`
    placeholders that are not articles).

    The number is taken from the symbol and never from the struct node's title,
    because the title is lossy: struct renders article 304 superscript 4 as the
    ambiguous string 'Art. 304_4.', which cannot be told apart from a
    hypothetical article '304_4'. The symbol carries the same '304_4' but with
    known semantics, and the DOM carries the unambiguous rendering
    'Art.&nbsp;304<SUP>4</SUP>.' which V2 checks it against.
    """
    symbol = symbol or ""

    m = _RANGE_SYMBOL_RE.match(symbol)
    if m:
        # A repealed span of articles published as a single unit, e.g.
        # "Art. 266-280." in the twelfth division of the Kodeks pracy. Sorts on
        # the first number so it lands in the right place in the chain.
        return f"{m.group(1)}-{m.group(2)}", int(m.group(1)), None

    m = _SYMBOL_RE.match(symbol)
    if not m:
        return None, None, None
    base, letter, sup, sup_letter = (m.group(1), m.group(2) or "",
                                     m.group(3), m.group(4) or "")
    canon = f"{base}{letter}"
    if sup:
        canon += f"^{sup}{sup_letter}"
    elif sup_letter:
        canon += sup_letter
    return canon, int(base), int(sup) if sup else None


def art_no_from_heading(display):
    """'Art. 18^3^a.' -> '18^3a'. None when the heading carries no number.

    Deliberately shares its output form with art_no_from_symbol: V2 compares the
    two, so if the canonical forms were built in two places they could drift and
    the check would compare a parser bug against itself.
    """
    m = _HEAD_RE.search(display or "")
    if not m:
        return None
    base, rng_end, letter, sup, sup_letter = m.groups()
    if rng_end:
        return f"{base}-{rng_end}"
    canon = f"{base}{letter or ''}"
    if sup:
        canon += f"^{sup}{sup_letter or ''}"
    elif sup_letter:
        canon += sup_letter
    return canon


def repair_struct_json(raw):
    """Parse a /struct payload, repairing the source's malformed JSON.

    ISAP's /struct serialiser has two independent defects, both appearing in
    title fields, and either one makes the entire payload unparseable - so the
    act gets no struct, and therefore no articles at all.

    Defect 1, unescaped ASCII double quotes. Polish typography opens a
    quotation with the low quote and the source often closes it with a straight
    ", which terminates the JSON string early:

        "title" : "...panstwowego ,,Polskie Koleje Panstwowe"1)",

    DU/2024/561 is 76 KB and 140 articles behind one such quotation mark.

    Defect 2, literal control characters. Long table captions are wrapped
    across physical lines and the newline is emitted raw inside the string,
    which JSON forbids (DU/2020/2075).

    The repair walks the payload, escaping a quote inside a string that is not
    followed by a structural delimiter, and escaping raw newline/CR/tab while
    inside a string. Outside a string those characters are legal whitespace,
    hence the in_string guard on both rules.

    Returns (parsed, repaired_bool) and still raises json.JSONDecodeError if
    the payload will not parse, so a genuinely broken one stays an honest
    failure rather than a silent empty result.
    """
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(raw), False
    except json.JSONDecodeError:
        pass

    out = []
    in_string = False
    escaped = False
    for i, ch in enumerate(raw):
        if escaped:
            out.append(ch)
            escaped = False
            continue
        if ch == "\\":
            # Defect 3: a trailing backslash in the content, unescaped. A title
            # ending "Zalacznik - WZOR\" leaves \" looking like an escaped
            # quote, so the string never closes. If what follows the quote is a
            # structural delimiter, the backslash is literal content and the
            # quote really is the terminator (DU/2018/428).
            if in_string and i + 1 < len(raw) and raw[i + 1] == '"':
                after = ""
                for c in raw[i + 2:]:
                    if not c.isspace():
                        after = c
                        break
                if after in (",", ":", "}", "]", ""):
                    out.append("\\\\")
                    continue
            out.append(ch)
            escaped = True
            continue
        if in_string and ch in "\n\r\t":
            # Defect 2: literal control characters inside a string value. JSON
            # forbids them; the source wraps long table captions across lines
            # and emits the newline raw. Outside a string they are legal
            # whitespace, hence the in_string guard.
            out.append({"\n": "\\n", "\r": "\\r", "\t": "\\t"}[ch])
            continue
        if ch == '"':
            if not in_string:
                in_string = True
                out.append(ch)
                continue
            # Closing quote only if the next non-space character is one that can
            # legally follow a string. Anything else means the source left a
            # quote inside the value.
            nxt = ""
            for c in raw[i + 1:]:
                if not c.isspace():
                    nxt = c
                    break
            if nxt in (",", ":", "}", "]", ""):
                in_string = False
                out.append(ch)
            else:
                out.append('\\"')
            continue
        out.append(ch)

    return json.loads("".join(out)), True


def _iter_struct(struct):
    """Preorder walk. Yields (node, depth, parent_ord, ord, top_id, in_annex)."""
    roots = struct if isinstance(struct, list) else (struct.get("children") or [struct])
    counter = [0]

    def walk(node, depth, parent_ord, top_id, in_annex):
        ord_i = counter[0]
        counter[0] += 1
        yield node, depth, parent_ord, ord_i, top_id, in_annex
        for child in node.get("children") or []:
            yield from walk(child, depth + 1, ord_i, top_id, in_annex)

    for root in roots:
        in_annex = bool(_ANNEX_RE.match(root.get("title") or ""))
        yield from walk(root, 0, None, root.get("id"), in_annex)


def strip_glosses(tree):
    """Remove the editorial footnote apparatus, and return how many were dropped.

    ISAP renders a footnote as
      <a class="gloss-link tooltip" href="#gloss-0:3:">
        <sup>3)</sup><span class="tooltip-text">W brzmieniu ustalonym przez ...</span>
      </a>
    inline, inside the very heading or paragraph it annotates. Two things go
    wrong if it is left in place.

    First, the tooltip prose becomes part of the provision: 21,332 characters
    across 44 glosses in DU/2020/1320 (1.6% of the body), and a reader or a
    retrieval index cannot tell the legislator's words from the publisher's
    note about which amendment changed them.

    Second, the <sup>3)</sup> marker sits immediately after the article number,
    so flattening it turns "Art. 47" into "Art. 47^6" and the article appears to
    be a superscript article that disagrees with its own symbol. That produced
    two false LABEL_MISMATCH verdicts on DU/2020/1320 and six on DU/2023/1610 -
    i.e. the check meant to catch mis-pairing was firing on formatting.

    Article-number superscripts are distinguishable by markup, not by content:
    they are bare <SUP>3</SUP> directly inside the heading's <B>, never wrapped
    in a gloss-link.
    """
    dropped = 0
    for a in tree.xpath('//a[contains(@class, "gloss-link")]'):
        parent = a.getparent()
        if parent is None:
            continue
        # Keep the tail: it is the text that follows the footnote marker and
        # belongs to the provision.
        tail = a.tail or ""
        if tail:
            prev = a.getprevious()
            if prev is not None:
                prev.tail = (prev.tail or "") + tail
            else:
                parent.text = (parent.text or "") + tail
        parent.remove(a)
        dropped += 1
    # Any leftover tooltip spans not wrapped in a gloss-link.
    for span in tree.xpath('//span[contains(@class, "tooltip-text")]'):
        p = span.getparent()
        if p is not None:
            p.remove(span)
            dropped += 1
    return dropped


def _flatten_sup(tree):
    """Rewrite <SUP>4</SUP> as the literal '^4' in the text stream, so that
    article 304 superscript 4 survives itertext() as 'Art. 304^4' instead of
    collapsing to the unreadable and ambiguous 'Art. 3044'.

    Must run AFTER strip_glosses, or footnote markers get the same treatment.
    """
    for sup in tree.iter():
        if sup.tag and str(sup.tag).lower() == "sup":
            inner = "".join(sup.itertext()).strip()
            sup.text = f"^{inner}" if inner else ""
            for child in list(sup):
                sup.remove(child)


def _text_with_offsets(el, want_ids, skip=()):
    """Text of an element, plus {id: (char_from, char_to)} for the descendants
    whose id is in want_ids.

    Offsets rather than nested copies: 'art. 415 § 1' is then a slice of the
    article's text, and no provision is ever stored twice.
    """
    parts = []
    spans = {}
    length = [0]

    def emit(s):
        if s:
            parts.append(s)
            length[0] += len(s)

    def walk(node):
        if node in skip:
            # The article's own "Art. 415." heading: already carried by
            # art_display, so repeating it inside text would store the label
            # twice and prefix every retrieved provision with its own number.
            # Nested headings (a paragraph's "§ 1.") are NOT skipped - those
            # are structure inside the provision. The caller emits node.tail
            # after this returns, so it must not be emitted here as well.
            return
        node_id = node.get("id")
        tracked = node_id in want_ids if node_id else False
        start = length[0]
        emit(node.text)
        for child in node:
            walk(child)
            emit(child.tail)
        tag = (str(node.tag) or "").lower()
        if tag in ("div", "p", "h1", "h2", "h3", "h4", "li", "br", "tr"):
            emit("\n")
        if tracked:
            spans[node_id] = (start, length[0])
        return

    walk(el)
    raw = "".join(parts)
    cleaned = _clean(raw)
    # _clean shifts offsets. Rather than track the rewrite, rescale
    # proportionally only when nothing moved; otherwise drop the spans for this
    # article. A wrong offset silently returns the wrong provision, which is
    # worse than returning none, so the honest failure is to have no span.
    if len(raw) != len(cleaned):
        spans = {}
    return cleaned, spans


class ParseResult:
    def __init__(self):
        self.articles = []        # dicts, see _make_article
        self.units = []           # dicts mirroring pl_act_units
        self.verdict = OK
        self.annex_part_id = None
        self.struct_articles = 0
        self.dom_anchors = 0
        self.label_mismatches = 0
        self.nonmonotonic = 0
        self.glosses_dropped = 0
        self.notes = []


def parse(struct, html_bytes, is_consolidation=False):
    """Return a ParseResult. Never raises on content; verdicts carry the failure."""
    res = ParseResult()

    if struct is None:
        res.verdict = NO_STRUCT
        res.notes.append("no struct")
        return res

    nodes = list(_iter_struct(struct))

    # Scope. On a consolidating obwieszczenie the law IS the annex: part_1 is
    # "Treść obwieszczenia" (the Marshal's announcement) and part_2 is
    # "Załącznik - Tekst jednolity ustawy ...". Only the annex is the act.
    if is_consolidation:
        annex_tops = {n[4] for n in nodes if n[5]}
        if not annex_tops:
            res.verdict = ARTICLE_SHORTFALL
            res.notes.append("consolidation with no Załącznik part")
            return res
        res.annex_part_id = sorted(annex_tops)[0]
        in_scope = [n for n in nodes if n[5]]
    else:
        in_scope = nodes

    arti_nodes = [n for n in in_scope if n[0].get("type") == "arti"]
    res.struct_articles = len(arti_nodes)

    # Force UTF-8. The documents declare
    #   <meta http-equiv="Content-Type" content="text/html; charset=UTF-8; charset=UTF-8">
    # - the charset is stated twice in one attribute - and lxml's sniffing gives
    # up on that and falls back to latin-1. The damage is not only mojibake in
    # the text: struct ids contain Polish letters (bran_piąty-chpt_I-arti_114),
    # so a mis-decoded id stops matching the struct tree and the article is
    # silently dropped. On Kodeks pracy that lost 134 of 305 articles while
    # every anchor count still looked right.
    doc = lxml.html.document_fromstring(
        html_bytes, parser=lxml.html.HTMLParser(encoding="utf-8"))
    res.glosses_dropped = strip_glosses(doc)
    _flatten_sup(doc)

    # ids repeat (DU/1964/93 lists book_trzecia-titl_XI-bran_I-arti_538 twice),
    # so index to a LIST and consume the k-th occurrence for the k-th struct
    # node. A dict keyed by id would silently drop one of the two.
    dom_by_id = {}
    for el in doc.iter("div"):
        cls = el.get("class") or ""
        if "unit" not in cls:
            continue
        el_id = el.get("id")
        if el_id:
            dom_by_id.setdefault(el_id, []).append(el)
    res.dom_anchors = sum(1 for el in doc.iter("div")
                          if "unit_arti" in (el.get("class") or ""))

    consumed = {}
    ord_i = 0
    prev_sort = (-1, -1)
    unit_rows = []
    art_by_struct_id = {}

    for node, depth, parent_ord, node_ord, top_id, in_annex in in_scope:
        unit_rows.append({
            "ord": node_ord, "parent_ord": parent_ord, "depth": depth,
            "struct_id": node.get("id"), "symbol": node.get("symbol"),
            "unit_type": node.get("type"), "name": node.get("name"),
            "title": node.get("title"), "in_annex": in_annex,
            "article_ord": None, "char_from": None, "char_to": None,
        })

    for node, depth, parent_ord, node_ord, top_id, in_annex in arti_nodes:
        struct_id = node.get("id")
        symbol = node.get("symbol")
        art_no, sort1, sort2 = art_no_from_symbol(symbol)
        if art_no is None:
            # Not an addressable article (struct emits `none_` placeholders).
            continue

        k = consumed.get(struct_id, 0)
        candidates = dom_by_id.get(struct_id) or []
        if k >= len(candidates):
            continue
        consumed[struct_id] = k + 1
        el = candidates[k]

        # Descendants of this article that struct also knows about, so their
        # offsets can be recorded while the text is built.
        want = {u["struct_id"] for u in unit_rows
                if u["struct_id"] and u["struct_id"].startswith(struct_id + "-")}

        # The article's own heading is its DIRECT child h3, not the first h3 in
        # the subtree - a paragraph's "§ 1." heading is also an h3, and
        # el.find(".//h3") would return whichever comes first in document order.
        head = next((c for c in el if str(c.tag).lower() == "h3"), None)
        display = _clean("".join(head.itertext())) if head is not None else ""
        text, spans = _text_with_offsets(el, want, skip={head} if head is not None else ())

        # V2: the number the document renders must equal the number the symbol
        # encodes. This is what catches an off-by-one in the occurrence pairing
        # above, which no aggregate check would show.
        head_no = art_no_from_heading(display)
        if head_no is not None and head_no != art_no:
            res.label_mismatches += 1

        # V3: residual, reported and never used to discard a document - but it
        # earns its place. In DU/1964/93 the article at document position 536 is
        # labelled "Art. 538." by BOTH struct and the DOM heading, while its
        # text is the real article 536 ("Cenę można określić przez wskazanie
        # podstaw do jej ustalenia"), and the real 538 follows at position 538.
        # That is a defect in the published source. V2 structurally cannot see
        # it, because V2 compares struct against the DOM and here the two agree
        # with each other and are both wrong. Only the ordering shows it. So a
        # non-zero nonmonotonic count is a finding to be surfaced by the audit,
        # not a number expected to be zero.
        cur = (sort1, sort2 if sort2 is not None else -1)
        if cur < prev_sort:
            res.nonmonotonic += 1
        prev_sort = cur

        ord_i += 1
        art_by_struct_id[struct_id] = ord_i
        res.articles.append({
            "ord": ord_i, "symbol": symbol, "struct_id": struct_id,
            "art_no": art_no, "art_display": display or f"Art. {art_no}.",
            "art_sort_1": sort1, "art_sort_2": sort2,
            "art_title": node.get("title"),
            "text": text, "n_chars": len(text), "spans": spans,
        })

    # Attach sub-unit offsets to their article.
    art_ord_by_prefix = sorted(art_by_struct_id.items(), key=lambda kv: -len(kv[0]))
    span_lookup = {}
    for a in res.articles:
        for uid, (cf, ct) in a["spans"].items():
            span_lookup[uid] = (a["ord"], cf, ct)
    for u in unit_rows:
        sid = u["struct_id"]
        if not sid:
            continue
        if sid in span_lookup:
            u["article_ord"], u["char_from"], u["char_to"] = span_lookup[sid]
        else:
            for prefix, a_ord in art_ord_by_prefix:
                if sid == prefix or sid.startswith(prefix + "-"):
                    u["article_ord"] = a_ord
                    break
    res.units = unit_rows

    # V1: exact coverage. Not a ratio and not a threshold - struct states how
    # many articles are in scope, and anything less means a truncated download,
    # a renamed anchor or a parse that stopped mid-document.
    addressable = sum(1 for n in arti_nodes
                      if art_no_from_symbol(n[0].get("symbol"))[0] is not None)
    if len(res.articles) != addressable:
        res.verdict = ARTICLE_SHORTFALL
        res.notes.append(f"extracted {len(res.articles)} of {addressable} in-scope articles")
        return res

    # V4: substance. Catches a stylesheet-only or JS-shell render that still
    # produced the right number of empty anchors.
    if res.articles:
        substantial = sum(1 for a in res.articles if a["n_chars"] >= MIN_ARTICLE_CHARS)
        if substantial / len(res.articles) < SUBSTANCE_RATIO:
            res.verdict = ARTICLE_SHORTFALL
            res.notes.append(
                f"only {substantial}/{len(res.articles)} articles have "
                f">={MIN_ARTICLE_CHARS} chars")
            return res

    if res.label_mismatches:
        res.verdict = LABEL_MISMATCH
        res.notes.append(f"{res.label_mismatches} DOM/symbol label mismatches")

    return res
