"""One definition of how an article number is captured and written down.

Three scripts in this pipeline spelled this out separately and disagreed, which is
how «Стаття 111-14» came to be stored three different ways:

    emit_text.py       (\\d+(?:[-–]\\d+)?)   + en dash → hyphen        → 111-14
    rebuild_articles.py same, plus em dash and whitespace stripping    → 111-14
    04_chunk.py        (\\d+)                                          → 111     ← truncation

The third one feeds the `legislation_full_bge` Qdrant collection, so an article
whose number carries an index was indexed under its neighbour's number. MCP looks
articles up with `art_no = $3`, an exact string match, so «ст. 111-14» found
nothing while «ст. 111» returned the wrong text with full confidence.

NUMBER is the sub-pattern only. Heading detection stays with each script on
purpose: emit_text anchors at line start so a passing mention of «статті 5» in a
body cannot masquerade as a heading, and rebuild_articles requires the trailing
dot. Those choices decide what counts as an article at all across 2.2M rows, and
unifying them here would change that silently.
"""
import re

# «111», «111-14», «111 – 14», «111—14». Hyphen, en dash and em dash all occur in
# the Rada texts, sometimes inside a single act.
NUMBER = r"\d+(?:\s*[-–—]\s*\d+)?"

_DASHES = str.maketrans({"–": "-", "—": "-", "−": "-"})


def normalize(raw):
    """Canonical article number, exactly as npa.article.art_no stores it.

    Whitespace removed, every dash folded to ASCII hyphen. This is the form MCP
    compares against, so anything that writes an article number anywhere in the
    pipeline has to agree with it character for character.
    """
    return re.sub(r"\s", "", str(raw)).translate(_DASHES)


def leading_int(raw):
    """Integer part, for ordering and monotonicity checks only — never for storage.

    «Стаття 111–14» uses an EN DASH, so splitting on the ASCII hyphen alone left
    '111–14' intact and int() raised, killing a rebuild three quarters through.
    Normalising first is what makes the split safe.
    """
    return int(normalize(raw).split("-")[0])
