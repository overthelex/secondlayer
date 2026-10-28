#!/usr/bin/env python3
"""An article ends before the next structural heading, not only before the next article.

LEXAI-2123: get_npa_act(435-15, article 625) returned the article followed by
«Розділ II ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ДОГОВІР Глава 52 ПОНЯТТЯ ТА УМОВИ ДОГОВОРУ». The
fixtures below are real texts from npa.article (ЦК 435-15, КК 2341-14, ГПК 1618-15,
ЗУ 1404-19), in both the current line-per-paragraph form and the pre-2013 form
where the HTML conversion left almost no newlines.

    python3 -m pytest scripts/legislation/full-corpus/test_structural_heading.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import rebuild_articles
import structural_heading as sh

ART_625 = (
    "Стаття 625. Відповідальність за порушення грошового зобов'язання\n"
    "1. Боржник не звільняється від відповідальності за неможливість виконання ним "
    "грошового зобов'язання.\n"
    "2. Боржник, який прострочив виконання грошового зобов'язання, на вимогу кредитора "
    "зобов'язаний сплатити суму боргу з урахуванням встановленого індексу інфляції за "
    "весь час прострочення, а також три проценти річних від простроченої суми, якщо "
    "інший розмір процентів не встановлений договором або законом."
)
HEADING_625 = "Розділ II\nЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ДОГОВІР\nГлава 52\nПОНЯТТЯ ТА УМОВИ ДОГОВОРУ"

# (article as stored before the fix, what it must become)
CASES = [
    # ЦК, current edition: the bug report.
    (ART_625 + "\n" + HEADING_625, ART_625),
    # ЦК 2003: the same boundary with no newlines at all.
    (ART_625.replace("\n", " ") + " Розділ II ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ДОГОВІР Глава 52 "
     "ПОНЯТТЯ ТА УМОВИ ДОГОВОРУ", ART_625.replace("\n", " ")),
    # ЦК: book heading spelled with an ordinal, apostrophe inside capitals.
    ("Стаття 508. Текст статті.\nКНИГА П'ЯТА\nЗОБОВ'ЯЗАЛЬНЕ ПРАВО\nРозділ I",
     "Стаття 508. Текст статті."),
    ("Стаття 176. Текст. Розділ III ОБ'ЄКТИ ЦИВІЛЬНИХ ПРАВ Глава 12",
     "Стаття 176. Текст."),
    # ЦК: paragraph, with and without a space after §, and a deleted paragraph.
    ("Стаття 548. Текст.\n§ 2. Неустойка", "Стаття 548. Текст."),
    ("Стаття 1076. Текст.\n§2. Рахунок умовного зберігання (ескроу)", "Стаття 1076. Текст."),
    ("Стаття 1088. Текст.\n§ 2. {Параграф 2 глави 74 виключено на підставі Закону}",
     "Стаття 1088. Текст."),
    # ЦК: the last article swallowed the whole final provisions.
    ("Стаття 1308. Текст.\nПРИКІНЦЕВІ ТА ПЕРЕХІДНІ ПОЛОЖЕННЯ\n1. Цей Кодекс набирає "
     "чинності з 1 січня 2004 року.", "Стаття 1308. Текст."),
    # КК: part heading before the section heading.
    ("Стаття 108. Текст.\nОСОБЛИВА ЧАСТИНА\nРозділ I\nЗЛОЧИНИ ПРОТИ ОСНОВ НАЦІОНАЛЬНОЇ "
     "БЕЗПЕКИ УКРАЇНИ", "Стаття 108. Текст."),
    # ГПК: «Глава N. Title» in sentence case, inserted chapter «2 - 1».
    ("Стаття 18. Текст.\nГлава 2. Цивільна юрисдикція\n§ 1. Предметна та суб’єктна "
     "юрисдикція", "Стаття 18. Текст."),
    ("Стаття 300. Текст.\nГлава 2 - 1 . Розгляд судом справ про обмеження фізичної особи",
     "Стаття 300. Текст."),
    # ГПК 2004: mid-line, title in capitals, «Параграф» spelled out.
    ("Стаття 25. Текст. Глава 4 УЧАСНИКИ ЦИВІЛЬНОГО ПРОЦЕСУ Параграф 1. Особи",
     "Стаття 25. Текст."),
    # A law: section heading after an editorial note, Cyrillic roman numerals.
    ("Стаття 47. Текст.\n{в редакції Закону № 2888-IX від 12.01.2023 }\nРозділ VII\n"
     "ПОРЯДОК ЗВЕРНЕННЯ СТЯГНЕННЯ НА МАЙНО БОРЖНИКА",
     "Стаття 47. Текст.\n{в редакції Закону № 2888-IX від 12.01.2023 }"),
    ("Стаття 78. Текст.\nРозділ ХІІІ\nПРИКІНЦЕВІ ТА ПЕРЕХІДНІ ПОЛОЖЕННЯ\n1. Цей Закон",
     "Стаття 78. Текст."),
    ("Стаття 31. Текст. Розділ IX ПРИКІНЦЕВІ ПОЛОЖЕННЯ 1. Цей Закон набирає чинності",
     "Стаття 31. Текст."),
]

# Mentions, not headings: these must come back unchanged.
UNCHANGED = [
    "Стаття 5. Положення глави 52 цього Кодексу застосовуються до договорів.",
    "Стаття 5. Текст.\nГлава 52 Кодексу застосовується до цих відносин.",
    "Стаття 5. Текст.\nрозділ II цього Закону застосовується.",
    "Стаття 5. Відповідно до розділу II. Інші положення не змінюються.",
    "Стаття 5. Глава держави підписує закон.",
    "Стаття 5. Текст.\n{Розділ VII доповнено статтею 62-1 згідно із Законом № 4833-IX}",
    # Quoted text of another act inside an amending provision.
    "Стаття 9. Внести зміни:\n\"Розділ II\nЗАГАЛЬНІ ПОЛОЖЕННЯ\nГлава 1\nТекст\".",
    "Стаття 9. Доповнити словами «Розділ IV ПРИКІНЦЕВІ ПОЛОЖЕННЯ».",
    "Стаття 9. Частина загальна. Загальна частина цього Кодексу діє.",
]


class TrimArticle(unittest.TestCase):
    def test_article_625_stops_before_section_heading(self):
        self.assertEqual(sh.trim_article(ART_625 + "\n" + HEADING_625), ART_625)

    def test_headings_are_cut(self):
        for before, after in CASES:
            with self.subTest(before=before[:60]):
                self.assertEqual(sh.trim_article(before), after)

    def test_mentions_are_not_cut(self):
        for body in UNCHANGED:
            with self.subTest(body=body[:60]):
                self.assertEqual(sh.trim_article(body), body)

    def test_idempotent(self):
        for before, _ in CASES:
            once = sh.trim_article(before)
            self.assertEqual(sh.trim_article(once), once)

    def test_own_heading_never_cut(self):
        self.assertEqual(sh.trim_article("Глава 1. Текст"), "Глава 1. Текст")


class RebuildUsesTrim(unittest.TestCase):
    def test_parse_stops_article_before_section(self):
        text = (
            "Стаття 624. Інше.\nТекст.\n" + ART_625 + "\n" + HEADING_625 + "\n"
            "Стаття 626. Поняття договору\n1. Договором є домовленість двох або більше сторін."
        )
        arts = {no: body for no, _, _, body in rebuild_articles.parse(text)}
        self.assertEqual(arts["625"], ART_625)
        self.assertTrue(arts["626"].startswith("Стаття 626."))

    def test_title_does_not_carry_heading(self):
        text = ("Стаття 1. А\nТекст.\nСтаття 2. Б\nТекст.\nРозділ II\nВ\n"
                "Стаття 3. Г\nТекст.")
        rows = rebuild_articles.parse(text)
        title_2 = [t for no, _, t, _ in rows if no == "2"][0]
        self.assertNotIn("Розділ", title_2)


if __name__ == "__main__":
    unittest.main()
