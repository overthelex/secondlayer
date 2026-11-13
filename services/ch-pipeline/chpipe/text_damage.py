"""Damage markers for raw pdftotext-layout output (pure, no I/O)."""

import re
from collections import Counter

_GLUED_REFS = re.compile(r"[a-zäöüéèàç]\.?\d{2,3}\s")
_HYPHEN_BREAKS = re.compile(r"\w-\n\s*\w")
_PAGE_NUMBER = re.compile(r"^\s*\d{1,3}\s*$", re.M)
_LIGATURES = re.compile("[ﬁﬂﬀﬃﬄ]")

REPEAT_MIN = 3
REPEAT_MAX_LEN = 120
SHORT_LINE = 60


def markers(text: str) -> dict[str, float]:
    lines = [ln for ln in text.split("\n") if ln.strip()]
    counts = Counter(s for s in (ln.strip() for ln in lines) if len(s) <= REPEAT_MAX_LEN)
    n = len(lines)
    return {
        "glued_refs": len(_GLUED_REFS.findall(text)),
        "hyphen_breaks": len(_HYPHEN_BREAKS.findall(text)),
        "page_number_lines": len(_PAGE_NUMBER.findall(text)),
        "repeated_lines": sum(1 for c in counts.values() if c >= REPEAT_MIN),
        "ligatures": len(_LIGATURES.findall(text)),
        "replacement_chars": text.count("�"),
        "nbsp": text.count(" "),
        "mean_line_len": (sum(len(ln) for ln in lines) / n) if n else 0.0,
        "short_line_share": (sum(1 for ln in lines if len(ln) < SHORT_LINE) / n) if n else 0.0,
    }
