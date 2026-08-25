# Кантональне законодавство Швейцарії: усі акти 26 кантонів і всі правки до них

Дата: 2026-08-26. Статус: затверджено в чаті ("так, як рекомендуєш" на три питання нижче).
Розширює `2026-08-23-ch-corpus-pipeline-design.md`, §11 якої виносила кантональне
законодавство поза scope зі словами "публічного API немає". Це виявилось неправдою:
19 кантонів працюють на одній платформі (Lexwork, Sitrox) з однаковим REST API, а
lexfind.ch має відкритий (недокументований) JSON API для всіх 26.

## 1. Мета

Завантажити всі кантональні акти (26,252 за LexFind, з них 16,327 чинних) з усіма
консолідованими редакціями (~150-200K) і всіма правками у той самий набір таблиць,
де живе федеральне право (`ch_act` → `ch_act_version` → `ch_act_article` →
`ch_act_change` / `ch_article_provenance`), так щоб `ch_get_act_article(as_of)`,
`ch_get_act_history` і `diff` працювали для кантону без окремої логіки.

"Всі правки" тут означає дві незалежні речі, обидві зберігаються:

1. **обчислений diff** між сусідніми редакціями по статтях (`ch_act_change`), тим
   самим `diff_stage`, що й для Fedlex;
2. **джерельний реєстр правок**: Lexwork віддає для кожної редакції
   `modification_table` (рішення, набуття чинності, елемент, тип зміни, посилання на
   офіційний збірник) і `history_information_map` (елемент → акт-зміна), а також
   `change_documents[]` (номер, назва "Änderung vom ...", дата публікації, PDF).
   Це лягає у `ch_article_provenance` (існуюча таблиця) плюс нову
   `ch_act_change_document`.

## 2. Три рішення, затверджені 2026-08-26

| # | Питання | Рішення |
|---|---|---|
| 1 | Одні таблиці чи окремий набір `ch_cantonal_*` | **Одні таблиці** з колонкою `ch_act.jurisdiction` ('CH' для федерального, 'ZH'/'BE'/... для кантонів) |
| 2 | Обсяг фази 1 | **19 Lexwork-кантонів** повністю (текст, редакції, правки) + **реєстр LexFind для всіх 26** як звірка. 7 bespoke-кантонів (ZH, VD, TI, NE, GE, JU, SZ) у фазі 2 через LexFind PDF / власні адаптери |
| 3 | Ліцензія (ніде не вказана) | Вантажимо з атрибуцією джерела, як Basel-Stadt публікує ті самі LexFind-дані на opendata.swiss під CC BY 4.0. User-Agent пайплайну називає нас і контакт |

## 3. Джерела (виміряно 2026-08-26, ~50 запитів)

### 3.1 Lexwork REST, `https://{host}/api/{lang}/`

Один бандл на всіх хостах (clex.ch теж Lexwork). Перевірено на BE, BL, GR, AI, FR, LU;
решта 13 хостів ідентифіковані за `original_url` у LexFind і за тим самим `/data/` URL.

| Ендпоінт | Що дає |
|---|---|
| `status` | `nof_tol_total / in_force / out_of_force / modified_last_20_days` |
| `texts_of_law/lightweight_index` | dict `category_id → [{id, systematic_number, title, abrogated, structured_document_id}]`. **Лише чинні** (BE 712 проти 1,129 у LexFind) |
| `texts_of_law/{sysnr}` | `text_of_law{systematic_number, title, abbreviation, enactment (ISO), date_of_decision (ISO), abrogated, canonical_link, current_version{id, version_dates_str, structured_document_id}, old_versions[{id, version_dates_str, ...}], future_versions[], change_documents[{id, number "25-022", document_title, date_of_publication_string, pdf_link}]}` |
| `texts_of_law/{sysnr}/versions/{vid}/show_as_json` | `selected_version{json_content{document{header, content, footer}, footnotes, modification_table[]}, history_information_map{history_id: {change_document_id, materials_count}}, available_languages[]}`. `content` = дерево вузлів `{uid, type ∈ title/article/paragraph/enumeration, number{lang}, text{lang}, html_content{lang}, html_content_post{lang}, children[]}`; uid структурний (`t-0--t-1--a-6--p-2`); усі мови в одному payload |
| `change_documents/lightweight_index` | повний реєстр актів-змін `cYYYYMM → [{id, number, document_title, date_string}]` |
| `status/recent_changes?offset=N` | пагінований журнал змін для delta |

Дати версій приходять **рядками локалізованого UI**: `"Version in Kraft von: 03.03.2024
bis: 31.12.2025 (Beschlussdatum: 03.03.2024)"`, `"Aktuelle Version in Kraft seit:
01.01.2026 (Beschlussdatum: 27.11.2023)"`. Реєстр завжди читається через `/api/de/`
(FR перевірено: de+fr; двомовні кантони BE/FR/VS/GR віддають de), регекс суворий,
нерозпізнаний рядок = лічильник помилок і пропуск версії, не дефолт. Кінець дії
"bis: 31.12.2025" **включний** (наступна версія стартує 01.01.2026), що збігається з
семантикою `date_end_applicability` у 197 (виміряно 25.08 на 19,428 парах Fedlex).

`<strong>*</strong>` у тексті = маркер зміненого елемента у поточній версії; знімається
з тексту, інакше diff бачить правку там, де її нема.

### 3.2 LexFind, `https://www.lexfind.ch/api/fe/{lang}/`

`entities` (28: 26 кантонів, CH=27, Intlex=28), `entities/{id}/extended` (лічильники),
`entities/{id}/systematics?active_only=false&tols_for_systematics[]={leaf}` (дерево +
акти під листком), `texts-of-law/{tol}/with-version-groups` (усі версії з ISO-датами
`version_active_since / version_inactive_since / version_found_at`, `info_badge`,
`dta_urls[].original_url` = URL у кантональній системі), `/tolv/{vid}/{lang}` = PDF.
Це **реєстр і звірка**, у фазі 1 текст з нього не береться.

Entity ids: AG 1, AI 2, AR 3, BE 4, BL 5, BS 6, FR 7, GE 8, GL 9, GR 10, JU 11, LU 12,
NE 13, NW 14, OW 15, SG 16, SH 17, SO 18, SZ 19, TG 20, TI 21, UR 22, VD 23, VS 24,
ZG 25, ZH 26.

### 3.3 Реєстр кантонів (`chpipe/cantons.py`)

| Кантон | Хост | Мови | Платформа |
|---|---|---|---|
| AG | gesetzessammlungen.ag.ch | de | lexwork |
| AI | ai.clex.ch | de | lexwork |
| AR | ar.clex.ch | de | lexwork |
| BE | www.belex.sites.be.ch | de, fr | lexwork |
| BL | bl.clex.ch | de | lexwork |
| BS | www.gesetzessammlung.bs.ch | de | lexwork |
| FR | bdlf.fr.ch | de, fr | lexwork |
| GL | gesetze.gl.ch | de | lexwork |
| GR | www.gr-lex.gr.ch | de, it, rm | lexwork |
| LU | srl.lu.ch | de | lexwork |
| NW | gesetze.nw.ch | de | lexwork |
| OW | gdb.ow.ch | de | lexwork |
| SG | www.gesetzessammlung.sg.ch | de | lexwork |
| SH | rechtsbuch.sh.ch | de | lexwork |
| SO | bgs.so.ch | de | lexwork |
| TG | rechtsbuch.tg.ch | de | lexwork |
| UR | rechtsbuch.ur.ch | de | lexwork |
| VS | lex.vs.ch | de, fr | lexwork |
| ZG | bgs.zg.ch | de | lexwork |
| ZH, VD, TI, NE, GE, JU, SZ | (LexFind реєстр) | | фаза 2 |

Мови в таблиці є очікуванням; істина для кожної версії = `available_languages[]` у
payload, і рядок `ch_act_version` створюється лише для мов, які там є. Хост, якого
не вдалось верифікувати першим запитом `status`, стадія рапортує як `hosts_failed`
і йде далі (18 інших кантонів не чекають на один).

## 4. Модель даних: міграція `201_ch_cantonal_legislation.sql`

(200 зарезервовано під заплановану `ch_citation_state`; прогалина в нумерації безпечна.)

```sql
ALTER TABLE ch_act ADD COLUMN IF NOT EXISTS jurisdiction text NOT NULL DEFAULT 'CH';
-- CHECK: 'CH' або один з 26 кодів кантонів.
-- Унікальність акта тепер (jurisdiction, sr_number); idx_ch_act_sr лишається.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_jur_sr ON ch_act (jurisdiction, sr_number)
    WHERE sr_number IS NOT NULL;
-- ⚠ Перед створенням індексу: SELECT jurisdiction, sr_number, count(*) ... HAVING count(*)>1
-- на проді. Fedlex sr_number NOT NULL є унікальним? НЕ доведено (ELI work унікальний,
-- sr_number ні: 12 dual-status works). Тому індекс створюється лише якщо перевірка
-- порожня; інакше міграція зупиняється з повідомленням, а не мовчки пропускає.
-- Реалізація: DO-блок, що рахує дублікати і RAISE EXCEPTION.

ALTER TABLE ch_act_version ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'fedlex';
-- CHECK source IN ('fedlex','lexwork'). Фаза 2 додасть 'lexfind_pdf'.
-- Для lexwork: xml_url = URL show_as_json; akn_xml = сирий JSON payload (та сама
-- колонка, семантика "сирий документ редакції"; перейменування колонки на 37,607
-- рядках заради назви не варте).
CREATE INDEX IF NOT EXISTS idx_ch_act_version_source_stage ON ch_act_version (source, stage)
    WHERE stage <> 'parsed';

CREATE TABLE IF NOT EXISTS ch_act_change_document (
    change_document_id bigserial PRIMARY KEY,
    act_id            bigint NOT NULL REFERENCES ch_act(act_id) ON DELETE CASCADE,
    jurisdiction      text NOT NULL,
    source_id         bigint NOT NULL,        -- Lexwork change_documents[].id
    number            text,                   -- "25-022" (номер в офіційному збірнику)
    title             text,                   -- "Verfassung des Kantons Bern (KV) (Änderung vom 27.11.2023)"
    date_publication  date,
    date_decision     date,
    pdf_url           text,
    metadata_json     jsonb,
    imported_at       timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (jurisdiction, source_id, act_id)
);

ALTER TABLE ch_article_provenance
    ADD COLUMN IF NOT EXISTS change_document_id bigint
        REFERENCES ch_act_change_document(change_document_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ch_cantonal_registry (   -- LexFind, звірка
    lexfind_tol_id    bigint PRIMARY KEY,
    canton            text NOT NULL,
    systematic_number text,
    title             text,
    is_active         boolean,
    category          text,
    original_url      text,
    versions_json     jsonb NOT NULL,         -- with-version-groups як є
    version_count     int NOT NULL,
    fetched_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ch_cantonal_registry_canton ON ch_cantonal_registry (canton, systematic_number);
```

Що НЕ змінюється: `ch_act_version` unique `(eli_consolidation_uri, lang)`, stage-машина
`discovered → fetched → parsed | failed`, `ch_act_article`, `ch_act_change`.

Ідентичність кантонального акта: `eli_work_uri` = `canonical_link` Lexwork
(`https://www.belex.sites.be.ch/app/de/texts_of_law/101.1`), `sr_number` =
`systematic_number` ("101.1"), `jurisdiction` = код кантону. Редакція:
`eli_consolidation_uri` = `https://{host}/app/de/texts_of_law/{sysnr}/versions/{vid}`
(deep link фронтенду, стабільний). `enforcement_status`: 0 якщо `abrogated=false`,
3 якщо `abrogated=true` (той самий словник, що Fedlex; `in_force` GENERATED працює).
`metadata_json` тримає `{platform, host, lexwork_id, structured_document_id,
text_of_law_type_id, abrogated_scheduled, lexfind_tol_id?}`.

### 4.1 Наслідки для існуючого коду, що ключує по `sr_number`

- `citations_resolve_stage._RESOLVE_ACTS`: `JOIN ch_act a ON a.sr_number = al.sr_number`
  отримує `AND a.jurisdiction = 'CH'`. Без цього кантональний "131.1" забере
  федеральні цитати.
- `ch_search_legislation` lateral по `ch_act_alias`: те саме `a.jurisdiction = 'CH'`.
- `ch_act_alias` PK лишається федеральним; кантональних аліасів у фазі 1 нема
  (`ch_aliases.py:22-28` лишається правдою).
- `fetch_xml_stage` / `parse_akn_stage` / `provenance_stage` / `versions_stage` мають
  бачити лише `source='fedlex'`: `db.claim_versions(..., source=...)` отримує
  обов'язковий параметр; `provenance_stage` і `diff_stage` фільтрують по source там,
  де читають `akn_xml` (diff читає лише `ch_act_article`, йому байдуже).
- `project_legacy_stage._PROJECT`: літерал `'fedlex'` → `CASE WHEN a.jurisdiction='CH'
  THEN 'fedlex' ELSE 'lexwork' END`, і `metadata_json` проекції отримує `jurisdiction`.

## 5. Стадії (`chpipe/stages/`, той самий контракт: `run(settings, ...) -> Report`, `main()`)

| Стадія | Аргумент | Черга | Що робить |
|---|---|---|---|
| `lexfind-registry` | `[CANTON]` | ні | `entities/{id}/systematics` → усі tol ids → `with-version-groups` → upsert `ch_cantonal_registry`. Для всіх 26. Ідемпотентна, restartable |
| `cantonal-acts` | `[CANTON]` | ні | `status` (health), `lightweight_index` + `change_documents/lightweight_index` → множина `systematic_number`; **плюс** sysnr з `ch_cantonal_registry` для цього кантону (щоб скасовані акти, яких нема в індексі чинних, теж пройшли через `texts_of_law/{sysnr}`; 404 = `not_on_host`, лічильник). На кожен акт: upsert `ch_act`, upsert `ch_act_change_document`, upsert `ch_act_version` для current + old + future × мови кантону з `cantons.py` (див. абзац про мови нижче) при `stage='discovered'`, `source='lexwork'` |
| `cantonal-fetch` | `[CANTON]` | так | `claim_versions('discovered', source='lexwork')` → show_as_json → валідація (JSON, є `json_content.document.content`, uid кореня) → `akn_xml`=payload, audit-копія у `raw_dir/cantonal/{canton}/{vid}.json` → `fetched`. Кеш URL у межах батчу: мовні sibling-рядки сусідні у порядку claim, один payload пишеться в кожен |
| `cantonal-parse` | `[CANTON]` | так | `claim_versions('fetched', source='lexwork')` → `lexwork.parse_edition(payload, lang)` → `store_articles` (той самий, з `parse_akn_stage`) + `full_text` + provenance з `modification_table`/`history_information_map` + лінк на `ch_act_change_document` → `parsed`. Якщо `lang` рядка нема в `available_languages` payload → `fail_version("lang not in payload")` |
| `diff`, `project-legacy` | | | без змін, крім §4.1 |
| `reports-cantonal` | | | Gate F, §7 |

Мови на етапі `cantonal-acts`: `texts_of_law/{sysnr}` не каже, які мови є у старих версій.
Тому `cantonal-acts` створює рядки для мов з `cantons.py`, а `cantonal-parse` ставить
`failed` з причиною `lang_not_in_payload` для мови, якої в payload нема. Це видимий
лічильник, не тиха відсутність. Очікувано ≈0 для одномовних кантонів.

Порядок claim `ORDER BY act_id, date_applicability, lang` (є) гарантує, що sibling-мови
однієї редакції йдуть підряд, тож кеш батчу в `cantonal-fetch` майже завжди спрацьовує.

### 5.1 `chpipe/lexwork.py` (чистий парсер, без БД, тестований на фікстурі)

- `parse_version_dates(s: str) -> (date_applicability, date_end_applicability|None, date_decision|None)`;
  регекси для трьох форм (Aktuelle/Version von-bis/Zukünftige "ab"); інакше `LexworkParseError`.
- `articles_of(payload, lang) -> list[akn.Article]`: обхід `content`; для кожного вузла
  `type='article'`: `e_id=uid`, `article_number = akn.normalise_number(number[lang]
  без "Art.")`, `marginal_note = text[lang]`, `text` = параграфи цього article (номер
  параграфа + текст `html_content` + `enumeration` діти "a ..." + `html_content_post`),
  HTML → текст через lxml.html, `<strong>*</strong>` знято, `&nbsp;` нормалізовано,
  `ordinal` = порядок обходу, `parent_e_id` = uid батьківського `title`. Вузли `title`
  з власним текстом (преамбули) у статті не потрапляють, але входять у `plain_text`.
- `plain_text(payload, lang)`: header + усі вузли + footer, як `akn.plain_text`.
- `provenance_of(payload, lang, articles) -> list[amendment_notes.Provenance + history_id]`:
  парсинг `modification_table[].html_content[lang]` рядок за рядком
  (`tr.history_info_{id}` → 5 td: рішення, чинність, елемент, зміна, джерело);
  `action`: eingefügt→inserted, geändert→amended, aufgehoben→repealed, інше (Erstfassung,
  Titel geändert) → NULL; елемент `Art. 61 Abs. 2` → e_id статті 61 (`anchor_level='article'`);
  `Erlass`, `Titel ...`, нерозпізнаний → `e_id` кореня (`t-0`), `anchor_level='container'`,
  `container_articles = len(articles)`; `as_reference` = джерело ("04-9"),
  `effective_date` = чинність, `source_act_date` = рішення, `raw_note` = текст рядка,
  `change_document_id` через `history_information_map[history_id]` → `ch_act_change_document.source_id`.
  fr/it/rm таблиці мають ті самі дієслова у своїй мові: словник як `amendment_notes._ACTIONS`
  (fr: introduit/modifié/abrogé; it: introdotto/modificato/abrogato; rm: по факту фікстури GR).

### 5.2 HTTP

`chpipe.http.Fetcher` (глобальний семафор, ретраї, User-Agent) + per-host семафор у
стадії: `CHPIPE_CANTONAL_PER_HOST` (default 2). 19 хостів × 2 = до 38 паралельних, але
глобальний `http_concurrency` (12 у Settings) ріже зверху. Оцінка: ~26K деталей актів +
~150K show_as_json при ~10 req/s ≈ 5 год бекфілу.

### 5.3 Delta (`chpipe/delta.py`)

`run_cantonal(settings)` четвертим guarded-кроком після `legislation`: для кожного
Lexwork-кантону читає `status/recent_changes` з offset-пагінацією до `change_date <
state.cantonal[canton].last_seen`, збирає sysnr, перезапускає `cantonal-acts` лише для
них (`cantonal_acts_stage.run(settings, canton, only=sysnrs)`), потім `cantonal-fetch`,
`cantonal-parse`, `diff`/`project-legacy` для `parsed.acts`. Стан у тому самому
`delta-state.json`. Повний re-walk `cantonal-acts` + `lexfind-registry` раз на тиждень
у cron (нд 04:00 UTC), не щоночі. `run-delta.sh` не змінюється.

## 6. MCP-інструменти (`mcp_backend/src/api/tools/ch-legislation-tools.ts`)

Усі три отримують опційний `canton` (`'CH'` default, або код кантону, або `'all'` лише
для пошуку). `ch_search_legislation`: фільтр `a.jurisdiction = $canton` (або без
фільтра при 'all'), у виводі поле `jurisdiction`. `ch_get_act_article` /
`ch_get_act_history`: `WHERE jurisdiction = $canton AND sr_number = $1`. Описи
інструментів: "федерального (Fedlex) та кантонального (19 кантонів)". `lexwebapp
evidence/ch.ts`: підпис `(SR 220)` → `(ZH 131.1)` коли `jurisdiction != 'CH'`.
Поведінка для існуючих викликів без `canton` не змінюється.

## 7. Gate F: перевірки перед тим, як назвати корпус завантаженим

`reports_cantonal.py` друкує по кантону:

1. акти: `ch_act` (jurisdiction=X) проти `ch_cantonal_registry` (canton=X): total, active,
   `only_in_lexfind`, `only_in_lexwork` з прикладами sysnr;
2. редакції: `ch_act_version` (source=lexwork) проти `version_count` реєстру, і збіг
   `date_applicability` з `version_active_since` LexFind на спільних актах (обидві сторони
   незалежні, тому це справжній gate, на відміну від Gate E у первісній формі);
3. якість: parsed / failed по причинах, `article_count=0`, `full_text` < 200 символів,
   частка `lang_not_in_payload`, `dates_unparsed`;
4. правки: `ch_act_change` рядків, `ch_article_provenance` рядків з `change_document_id`
   проти без, `ch_act_change_document` без жодного provenance-лінку.

Ручний крок (не автоматизується): прочитати 20 статей з 5 кантонів (у т.ч. одну
двомовну BE/FR і GR-it) проти сторінки Lexwork і підтвердити, що текст, номер і
маргіналія збігаються, а `*` знято. Правило з `feedback_verify_text_quality_not_presence`.

## 8. Тести

- `tests/test_lexwork.py`: фікстура `tests/fixtures/lexwork_be_101_1_v3020.json` (реальний
  show_as_json BE KV, 784 KB; обрізати до ~5 статей + повна modification_table);
  дати трьох форм; `*` знято; двомовність (de/fr з одного payload); provenance:
  `Art. 61 Abs. 2 geändert 04-9` → article anchor, `Erlass Erstfassung` → container;
  history_id → change_document_id.
- `tests/test_cantonal_acts_stage.py`, `test_cantonal_fetch_stage.py`,
  `test_cantonal_parse_stage.py`: httpx MockTransport, `CHPIPE_TEST_DSN` як у сусідів.
- `tests/test_migration_201.py`: ідемпотентність, CHECK на jurisdiction, унікальність
  `(jurisdiction, sr_number)`, дубль-guard.
- Регресія: `test_db_version_queue.py` отримує `source` у claim; `test_project_legacy_stage`
  перевіряє `source` для кантонального рядка; `test_citations_resolve_stage`: кантональний
  акт з федеральним sr_number не резолвиться.
- `run-stage.sh` case-гілки для нових стадій; `test_entry_points.py` ловить нові модулі.

## 9. Прод-операції (lawrider_prod, AWS; `/data/ch-corpus`, 943 GB вільно)

1. Міграція 201 через `migrate-prod` при деплої (lock_timeout 3s; `ADD COLUMN ... DEFAULT`
   на 17K/37K рядках миттєва в PG16; unique index на 17K рядках миттєвий).
2. `run-stage.sh lexfind-registry` (~33K запитів, ~2-4 год при 2-3 req/s) у tmux.
3. `run-stage.sh cantonal-acts BE` як пілот, `reports-cantonal`, ручна читка; потім усі 19.
4. `cantonal-fetch`, `cantonal-parse` під supervisor-циклом (як ch-extract), потім
   `diff` і `project-legacy` (повний прохід; diff по кантональних актах ≈ 26K актів).
5. Gate F, ручна читка, і лише тоді cron: тижневий full re-walk; нічний delta підхоплює
   `run_cantonal` автоматично після мержу, тому мерж коду в main іде ПІСЛЯ supervised
   backfill (правило README:1080).
6. `~/ch-status.sh` доповнити лічильниками по source.

## 10. Поза scope цієї фази

7 bespoke-кантонів (текст), комунальне право, кантональні аліаси для резолвера цитат
(TFJC, VRPG, LOJV з `unresolved_abbr` 10.3%: очевидний наступний крок, коли є акти),
BGE-M3 вектори, історичний ZH TEI-XML з Zenodo.
