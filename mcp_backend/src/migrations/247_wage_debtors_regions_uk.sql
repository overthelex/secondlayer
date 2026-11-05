-- Migration 247: Ukrainian region names in opendata_wage_debtors (LEXAI-2126)
--
-- The one snapshot we have (Мінсоцполітики, 25.02.2019; the dataset is marked as no longer
-- updated) was loaded with the region taken from the transliterated file names
-- («Donecka Oblast», «M.Kyyiv»), so the Ukrainian region filter of search_wage_debtors
-- matched nothing. Map the 25 values to the Ukrainian names.
--
-- Idempotent: rows already in Ukrainian are not touched.

UPDATE opendata_wage_debtors w
   SET region = m.uk
  FROM (VALUES
    ('Cherkaska Oblast', 'Черкаська область'),
    ('Chernihivska Oblast', 'Чернігівська область'),
    ('Chernivecka Oblast', 'Чернівецька область'),
    ('Dnipropetrovska Oblast', 'Дніпропетровська область'),
    ('Donecka Oblast', 'Донецька область'),
    ('Harkivska Oblast', 'Харківська область'),
    ('Hersonska Oblast', 'Херсонська область'),
    ('Hmelnycka Oblast', 'Хмельницька область'),
    ('Ivano Frankivska Oblast', 'Івано-Франківська область'),
    ('Kirovohradska Oblast', 'Кіровоградська область'),
    ('Kyyivska Oblast', 'Київська область'),
    ('Luhanska Oblast', 'Луганська область'),
    ('Lvivska Oblast', 'Львівська область'),
    ('M.Kyyiv', 'м. Київ'),
    ('Mykolayivska Oblast', 'Миколаївська область'),
    ('Odeska Oblast', 'Одеська область'),
    ('Poltavska Oblast', 'Полтавська область'),
    ('Rivnenska Oblast', 'Рівненська область'),
    ('Sumska Oblast', 'Сумська область'),
    ('Ternopilska Oblast', 'Тернопільська область'),
    ('Vinnycka Oblast', 'Вінницька область'),
    ('Volynska Oblast', 'Волинська область'),
    ('Zakarpatska Oblast', 'Закарпатська область'),
    ('Zaporizka Oblast', 'Запорізька область'),
    ('Zhytomyrska Oblast', 'Житомирська область')
  ) AS m(en, uk)
 WHERE w.region = m.en;
