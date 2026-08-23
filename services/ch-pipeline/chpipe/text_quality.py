"""How usable is this extracted text?

Four components, each in 0..1, averaged with the weights below:

  alpha_ratio          letters as a share of non-space characters. A page of
                       coordinates or line numbers scores low.
  mean_word_length     penalises both character soup ("B u n d e s") and
                       run-together text with no spaces.
  dictionary_hit_rate  share of tokens found in the frequency list for the
                       document's language. This is what actually separates a
                       real judgment from a plausible-looking OCR hallucination.
  replacement_ratio    U+FFFD and control characters, inverted.

ACCEPT_THRESHOLD was calibrated on a hand-labelled sample of 100 documents; see
the calibration step in Task 9 of the plan.
"""
from __future__ import annotations

import pathlib
import re
import unicodedata

_WORDLIST_DIR = pathlib.Path(__file__).parent / "wordlists"
_TOKEN = re.compile(r"[^\W\d_]+", re.UNICODE)

ACCEPT_THRESHOLD = 0.55
MIN_TOKENS = 40

_WEIGHTS = {
    "alpha_ratio": 0.20,
    "mean_word_length": 0.20,
    "dictionary_hit_rate": 0.45,
    "replacement_ratio": 0.15,
}

_LISTS: dict[str, frozenset[str]] = {}


def _wordlist(lang: str) -> frozenset[str]:
    if lang not in _LISTS:
        path = _WORDLIST_DIR / f"{lang}.txt"
        if not path.exists():
            _LISTS[lang] = frozenset()
        else:
            _LISTS[lang] = frozenset(
                w.strip().lower() for w in path.read_text().splitlines() if w.strip())
    return _LISTS[lang]


def _vocabulary(languages: list[str]) -> frozenset[str]:
    wanted = [l for l in languages if (_WORDLIST_DIR / f"{l}.txt").exists()]
    if not wanted:
        wanted = ["de", "fr", "it"]
    vocabulary: frozenset[str] = frozenset()
    for lang in wanted:
        vocabulary |= _wordlist(lang)
    return vocabulary


def _mean_word_length_score(tokens: list[str]) -> float:
    """Peaks at 6 characters, the mean for German legal prose; falls off both
    ways so character soup and space-stripped text both lose."""
    if not tokens:
        return 0.0
    mean = sum(len(t) for t in tokens) / len(tokens)
    return max(0.0, 1.0 - abs(mean - 6.0) / 6.0)


def breakdown(text: str, languages: list[str]) -> dict[str, float]:
    tokens = [t.lower() for t in _TOKEN.findall(text)]
    if len(tokens) < MIN_TOKENS:
        return {"alpha_ratio": 0.0, "mean_word_length": 0.0,
                "dictionary_hit_rate": 0.0, "replacement_ratio": 0.0, "score": 0.0}

    non_space = [c for c in text if not c.isspace()]
    alpha_ratio = (sum(1 for c in non_space if c.isalpha()) / len(non_space)
                   if non_space else 0.0)

    bad = sum(1 for c in text
              if c == "�" or (unicodedata.category(c) == "Cc" and c not in "\n\r\t"))
    replacement_ratio = 1.0 - min(1.0, bad / max(1, len(text)) * 50)

    vocabulary = _vocabulary(languages)
    hit_rate = (sum(1 for t in tokens if t in vocabulary) / len(tokens)
                if vocabulary else 0.0)

    components = {
        "alpha_ratio": alpha_ratio,
        "mean_word_length": _mean_word_length_score(tokens),
        "dictionary_hit_rate": min(1.0, hit_rate / 0.35),   # 35% hits is a clean text
        "replacement_ratio": replacement_ratio,
    }
    components["score"] = round(
        sum(components[k] * w for k, w in _WEIGHTS.items()), 4)
    return components


def score(text: str, languages: list[str]) -> float:
    return breakdown(text, languages)["score"]
