"""How usable is this extracted text?

Four components, each in 0..1, averaged with the weights below:

  alpha_ratio          letters as a share of non-space characters. A page of
                       coordinates or line numbers scores low.
  mean_word_length     penalises both character soup ("B u n d e s") and
                       run-together text with no spaces.
  dictionary_hit_rate  share of tokens found in the frequency list for the
                       document's language. This is what actually separates a
                       real judgment from a plausible-looking OCR hallucination.
  replacement_ratio    U+FFFD, control characters, and anomalous "?" density,
                       inverted.

ACCEPT_THRESHOLD was calibrated on a hand-labelled sample of 100 documents; see
the calibration step in Task 9 of the plan.

Two additional, evidence-based guards sit on top of the weighted average:

  MIN_RAW_HIT_RATE / NO_DICTIONARY_SCORE_CAP
      300 random six-letter tokens (no real words at all) score a perfect
      1.0 on alpha_ratio, mean_word_length and replacement_ratio, and land
      the composite EXACTLY on ACCEPT_THRESHOLD even though
      dictionary_hit_rate is 0.0 — the other three components alone sum to
      the full accept band. The real PDF fixture's raw (pre-normalisation)
      dictionary hit rate is 0.594; both the random-token case and a
      character-soup version measure 0.0. MIN_RAW_HIT_RATE = 0.05 sits far
      below the real fixture and exactly on the zero these noise cases
      produce, so it never touches real prose. Below it the composite is
      capped at NO_DICTIONARY_SCORE_CAP = 0.15 — comfortably under
      ACCEPT_THRESHOLD regardless of how tidy the other three components
      look, because text with no real words in it must not be accepted for
      being well-formed noise.

  QMARK_BASELINE_DENSITY
      replacement_ratio previously only caught U+FFFD and control
      characters, so a broken font CMap that renders missing glyphs as a
      literal "?" scored a perfect 1.0 on the one component meant to catch
      exactly that. Measured on real data: the PDF fixture's extracted text
      has a "?" density of 0.0 (0 of 140,522 chars); the same text with
      every "e" replaced by "?" has a density of 0.1228 (17,259 of 140,522).
      QMARK_BASELINE_DENSITY = 0.005 (0.5%) gives ordinary legal prose — the
      occasional rhetorical or quoted "?" — ten times the headroom the real
      fixture actually needed, while anything past it is scored as glyph
      failure rather than punctuation.
"""
from __future__ import annotations

import pathlib
import re
import unicodedata

_WORDLIST_DIR = pathlib.Path(__file__).parent / "wordlists"
_TOKEN = re.compile(r"[^\W\d_]+", re.UNICODE)

ACCEPT_THRESHOLD = 0.55
MIN_TOKENS = 40

# See the module docstring for how these two guards were derived from
# measurements on the real PDF fixture versus synthetic noise.
MIN_RAW_HIT_RATE = 0.05
NO_DICTIONARY_SCORE_CAP = 0.15
QMARK_BASELINE_DENSITY = 0.005

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
    # A broken font CMap renders missing glyphs as a literal "?", which is an
    # ordinary printable character and would otherwise sail through this
    # component untouched. Only the density ABOVE what ordinary prose uses
    # counts as damage, so a stray rhetorical "?" is not penalised.
    qmark_baseline = QMARK_BASELINE_DENSITY * len(text)
    excess_qmarks = max(0.0, text.count("?") - qmark_baseline)
    bad_total = bad + excess_qmarks
    replacement_ratio = 1.0 - min(1.0, bad_total / max(1, len(text)) * 50)

    vocabulary = _vocabulary(languages)
    hit_rate = (sum(1 for t in tokens if t in vocabulary) / len(tokens)
                if vocabulary else 0.0)

    components = {
        "alpha_ratio": alpha_ratio,
        "mean_word_length": _mean_word_length_score(tokens),
        "dictionary_hit_rate": min(1.0, hit_rate / 0.35),   # 35% hits is a clean text
        "replacement_ratio": replacement_ratio,
    }
    raw_score = sum(components[k] * w for k, w in _WEIGHTS.items())
    # Text with essentially no real words in it must not reach the accept
    # band by being tidy in every OTHER respect — see MIN_RAW_HIT_RATE in the
    # module docstring for the measurements behind this cap.
    if hit_rate < MIN_RAW_HIT_RATE:
        raw_score = min(raw_score, NO_DICTIONARY_SCORE_CAP)
    components["score"] = round(raw_score, 4)
    return components


def score(text: str, languages: list[str]) -> float:
    return breakdown(text, languages)["score"]
