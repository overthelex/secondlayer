"""Where an article ends when the next thing in the act is not another article.

rebuild_articles.py cut each article at the next «Стаття N.» heading. Everything in
between — «Розділ II / ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ДОГОВІР / Глава 52 / ПОНЯТТЯ ТА УМОВИ
ДОГОВОРУ» — was glued to the end of the previous article, and the last article of an
act swallowed the whole «Прикінцеві та перехідні положення» section (LEXAI-2123).

A structural heading is one of Книга, Розділ, Підрозділ, Глава, Параграф/§, or a
final/transitional provisions title. The word alone proves nothing: article text says
«розділ II цього Кодексу» and «Глава 52 Кодексу застосовується» in passing. So a
match has to look like a heading:

* at the start of a line: keyword + number (arabic, roman in Latin or Cyrillic
  letters, or an ordinal word for books) + optional dot, then end of line or a
  capitalised title;
* mid-line, which is how pre-2013 editions come out of the HTML conversion with
  almost no newlines: only after a sentence end, and only when the title that
  follows is in capitals («... законом. Розділ II ЗАГАЛЬНІ ПОЛОЖЕННЯ») or the number
  carries a dot and a capitalised title («... справи. Глава 2. Цивільна юрисдикція»);
* a code's «ЗАГАЛЬНА ЧАСТИНА» / «ОСОБЛИВА ЧАСТИНА» counts only as a line of its own;
* never inside an open quotation: amending provisions quote whole sections of
  other acts, and a «Розділ» inside quotes belongs to the text being quoted.

Editorial notes in braces («{Розділ VII доповнено статтею 62-1 ...}») start with a
brace, so neither the line-start nor the sentence-end form matches them.
"""
import re

_UP = "A-ZА-ЯІЇЄҐ"
_ROMAN = "IVXLCІХ"          # Latin I V X L C, Cyrillic І and Х: both occur in Rada texts
_ORDINAL = (r"(?:перш|друг|трет|четверт|п[’'ʼ]?ят|шост|сьом|восьм|дев[’'ʼ]?ят|десят)"
            r"[аяий]")

_KEYWORD = (r"(?:Книга|КНИГА|Розділ|РОЗДІЛ|Підрозділ|ПІДРОЗДІЛ|Глава|ГЛАВА"
            r"|Параграф|ПАРАГРАФ)")
_NUM = r"(?:\d+|[" + _ROMAN + r"]+|(?i:" + _ORDINAL + r"))(?:\s*[-–—]\s*\d+)?"
_FINAL_CAPS = r"(?:ПРИКІНЦЕВІ|ПЕРЕХІДНІ|ЗАКЛЮЧНІ)(?:\s+ТА\s+ПЕРЕХІДНІ)?\s+ПОЛОЖЕННЯ"
# Codes open their parts with a bare «ЗАГАЛЬНА ЧАСТИНА» / «ОСОБЛИВА ЧАСТИНА» line.
_PART = r"(?:ЗАГАЛЬНА|ОСОБЛИВА|Загальна|Особлива)\s+(?:ЧАСТИНА|частина)"
_FINAL_TITLE = r"(?:Прикінцеві|Перехідні|Заключні)(?:\s+та\s+перехідні)?\s+положення"

_WS = r"[ \t\u00a0]"
_SUFFIX = r"(?:\s*[-–—]\s*\d+)?"

# What may follow a heading number. «Розділ II» ends the line; «Глава 1. Основні
# положення» carries a dot; «Розділ I ЗАГАЛЬНІ ПОЛОЖЕННЯ» is in capitals. A bare
# capitalised word without a dot («Глава 52 Кодексу ...») is a sentence, not a heading.
# Three capitals, an apostrophe allowed between them: «ОБ'ЄКТИ», «ПРЕД’ЯВЛЕННЯ».
_CAPS = r"[" + _UP + r"](?:['’ʼ]?[" + _UP + r"]){2}"
# After «N.» an editorial note may stand in for the title: «Розділ XVIII-2. {Розділ ...
# виключено ...}».
_AFTER_DOT = r"(?:[" + _UP + r"]|\{)"
_TAIL_LINE = (_WS + r"*(?:\r?$|\." + _WS + r"*(?:\r?$|" + _AFTER_DOT + r")|"
              + _WS + r"+" + _CAPS + r")")
_TAIL_INLINE = (r"(?:" + _WS + r"*\.?" + _WS + r"+" + _CAPS + r"|"
                + _WS + r"*\." + _WS + r"+" + _AFTER_DOT + r")")

# Line start.
_LINE = re.compile(
    r"(?m)^" + _WS + r"*(?:"
    + _KEYWORD + _WS + r"+" + _NUM + _TAIL_LINE
    + r"|§" + _WS + r"*\d+" + _SUFFIX + _TAIL_LINE
    + r"|" + _FINAL_CAPS + _WS + r"*\.?" + _WS + r"*\r?$"
    + r"|" + _FINAL_TITLE + _WS + r"*\.?" + _WS + r"*\r?$"
    + r"|" + _PART + _WS + r"*\r?$"
    + r")"
)

# Mid-line, straight after a sentence end: pre-2013 editions have almost no newlines.
_INLINE = re.compile(
    r"(?<=[.;:!?»\"”)}])" + _WS + r"+(?:"
    + _KEYWORD + _WS + r"+" + _NUM + _TAIL_INLINE
    + r"|§" + _WS + r"*\d+" + _SUFFIX + _WS + r"*\." + _WS + r"+[" + _UP + r"]"
    + r"|" + _FINAL_CAPS + r"(?![" + _UP + r"])"
    + r")"
)


def _inside_quotes(text, pos):
    """True when `pos` sits inside an unclosed quotation."""
    head = text[:pos]
    if head.count("«") > head.count("»"):
        return True
    if head.count("“") > head.count("”"):
        return True
    return head.count('"') % 2 == 1


def heading_start(text, start=0):
    """Offset of the first structural heading at or after `start`, or None."""
    cands = []
    for rx in (_LINE, _INLINE):
        for m in rx.finditer(text, start):
            # Report the heading itself, not the whitespace that precedes it.
            pos = m.start()
            while pos < len(text) and text[pos] in " \t ":
                pos += 1
            if not _inside_quotes(text, pos):
                cands.append(pos)
                break
    return min(cands) if cands else None


def trim_article(body):
    """Article text with any trailing structural heading (and what follows) removed.

    `body` starts with its own «Стаття N.» heading; the search starts after that
    line's first character so the article's own heading can never be the cut.
    Idempotent: a trimmed body has no heading left to cut at.
    """
    cut = heading_start(body, 1)
    if cut is None:
        return body
    return body[:cut].rstrip()
