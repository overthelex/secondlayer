# lawrider.ch vs opencaselaw.ch: пробелы по открытым данным и план закрытия

## Context

opencaselaw.ch (Jonas Hertner, MIT-код на github.com/jonashertner/opencaselaw, корпус CC0 на HF `voilaj/swiss-caselaw`) позиционируется как «открытая запись швейцарского права, пересобираемая ежедневно». У него 130 источников решений, законодательство, Botschaften, административная практика, 44K научных публикаций, комментарии, 42 MCP-тулзы без ключа. Задача: понять, чего из его открытых источников нет в lawrider, и спланировать добор.

Измерено 02.09.2026: opencaselaw через `/stats.json`, `/api/scraper-health`, README/`scrapers/` репо; lawrider через read-only SQL на `pg-lawrider` (lawrider-gcp) и инвентарь `services/ch-pipeline` (origin/main; текущий checkout `feat/legislation-stage2-supervised-fetch` этого кода не содержит, рабочая копия main лежит в `.claude/worktrees/ch-citation-index/`).

## Сводка: где мы, где они

| Слой | opencaselaw | lawrider (lawrider-gcp, 02.09) | Вердикт |
|---|---|---|---|
| Судебные решения | 1,062,054 представлений, **921,142 уникальных** (140K дублей), 130 кодов судов, 1875–2026 | **1,224,714** строк, 0 дублей ECLI, 54 spider'а entscheidsuche, 1875–2026 | Мы больше по объёму. Пробелы точечные (ниже) |
| Свежесть BGer | poller каждые 15 мин в рабочие часы | ночная delta 07:15 UTC по snapshot entscheidsuche 06:00 | Лаг 1–2 дня у нас |
| Регуляторы | FINMA, FINMA-Versicherungsrecht, UBI, ElCom, ESchK, EMARK, PostCom, ComCom, BAZG, ESBK, Preisüberwacher, RAB, SAV, WEKO, EDÖB, Bundesrat, TA-SST, MKG | только то, что есть в entscheidsuche: WEKO 117, EDÖB 1,878, Bundesrat 33, TA_SST 205, VB 32,705 | **Пробел ≈ 6.5K документов** |
| ЕСПЧ (Швейцария) | 9,617: HUDOC Swiss 853 + BGE-переводы 487 + все Chamber/GC importance 1–3 (8.1K) | `echr_cases` на lawrider **0 строк** (210K лежат на legal_prod) | **Пробел** |
| Федеральное законодательство | 5,531 законов / 133.6K статей (Fedlex SPARQL, помесячно) | 17,293 актов SR, 37.6K XML-редакций + 51K pdf-a редакций, 1.76M статей, PiT 96–99% с 2000 | Мы впереди |
| Кантональное законодательство | 15,608 актов / 361.8K статей, 22 кантона напрямую + 4 через LexFind PDF | реестр 26 кантонов (26,257 актов), текст 23 кантонов (Lexwork 19 + SIL GE/NE + TI + ZH-Lex), VD/JU/SZ через LexFind PDF (phase2 weekly), 7.5M статей всех редакций | Паритет / впереди |
| Botschaften (материалы) | **6,157 Botschaften, 421K абзацев полного текста**; 83,958 ссылок поправка→BBl | `ch_as_act` 211,641 строк AS/BBl, **только метаданные**, `ch_bundesblatt` пуст | **Пробел** (полный текст) |
| Административная практика | FINMA-Rundschreiben 1,133; ESTV Kreisschreiben 285 + MWST-Info; SECO ArG 1,102; BAFU 297; ARE; SEM Weisungen; EPA; SSK; VPB 23K | VPB есть (CH_VB 32.7K), остального нет | **Пробел ≈ 3–4K документов** |
| Научные публикации | **44,495** из 24 источников (ZORA 14K, BORIS 7.3K, UNIGE 6.5K, e-periodica 7K, ZHAW 3K, LIBRA 2K, ETH 1.8K, …), в основном OAI-PMH | нет | **Пробел** |
| Комментарии | onlinekommentar.ch (у них 1,173 по 23 законам; измерено у источника 02.09: 391 × 4 языка = 1,564 записи, 24 акта, CC BY 4.0) + openlegalcommentary.ch (CC BY-SA; **генерируется ИИ** по их же странице методики) | нет → **1a сделано, PR #2398** | **Пробел** (дешёвый) |
| Граф цитирований | 9.86M решение→решение (92.9% резолв), 12.5M решение→статья | 9.05M case (84.3%), 21.6M legislation (act 90.9%, article-at-date 81.9%) | Паритет |
| Реестры | нет | Zefix 787,706 + SHAB 2,511,033 + FINMA 15,660 + SECO 8,563 | Мы впереди |
| Доступ | MCP + REST без ключа, HF parquet CC0, Word add-in, CLI/ECLI-идентификаторы, JSON-LD | MCP по ключу с кредитами, 12 ch_* тулз | Не данные, вне этого плана; см. «Открытые вопросы» |

Решения по кантонам, где они заметно больше нас (нужна проверка по порталу, а не по их stats: их счётчик включает дубли):

| Кантон | opencaselaw | lawrider | Возможный добор |
|---|---|---|---|
| GE | ge_gerichte 170,063 (direct justice.ge.ch; в health 93,163) | GE_Gerichte 92,183 | до +77K, если portal count подтвердится |
| TI | 66,908 (direct www3.ti.ch) | 59,031 | ≈ +8K |
| NE | 10,770 + ne_jurisprudence_adm 1,611 | NE_Omni 7,720 | ≈ +4.6K (адм. практика NE) |
| GL | 1,417 (2001–2026) | GL_Omni 724 (2012–2026) | ≈ +700 старых |
| ZH | + Arbeitsgericht 31, Mietgericht 3 (новые с 2025) | нет | мелочь, следить |

Везде остальное мы равны или больше (VD 267K vs 157K, BS 27K vs 10.7K, LU 13.4K vs 5.2K, GR 19.5K vs 15.8K).

## План: 6 фаз, по убыванию ценность/стоимость

Все фазы строятся по существующему паттерну `services/ch-pipeline`: стадия в `chpipe/stages/<name>_stage.py`, регистрация в `run-stage.sh`, хвост в `chpipe/delta.py`, миграция в `mcp_backend/src/migrations/` (последняя занятая 208, этот PR), тулза в `mcp_backend/src/api/tools/ch-*.ts` + `curated-mcp-tools.ts` + список `ch` в `mcp-toolset.ts`. Лицензия хранится per-row (колонка `licence`), как это делает opencaselaw в `scrapers/scholarship/sources.py`.

### Фаза 1. Комментарии + Botschaften (самая высокая ценность для юриста)

**1a. onlinekommentar.ch + openlegalcommentary.ch** (CC-BY 4.0 / CC-BY-SA 4.0, оба явно разрешают переиспользование).
- Источник: сайт onlinekommentar.ch (структура: закон → статья → комментарий, версии), у opencaselaw есть готовые `scrapers/onlinekommentar.py`, `openlegalcommentary.py` как подсказка по эндпоинтам.
- Таблица `ch_commentary(id, source, act_sr_number, article_number, lang, title, authors, version_date, full_text, licence, source_url, content_hash)`; линк на `ch_act` через существующий резолвер алиасов `chpipe/ch_aliases.py`.
- Тулза `ch_get_commentary(act, article)` + вход в `ch_search_legislation` (флаг `include_commentary`).
- Объём: 391 × 4 языка = 1,564 записи (измерено 02.09), один вечер. openlegalcommentary.ch отложен: комментарии там генерируются ИИ (их страница /de/methodology), решение за Ваттом.

**1b. Botschaften полный текст.**
- У нас уже есть 162K BBl-строк с ELI в `ch_as_act`. Fedlex отдаёт PDF/HTML манифестации по `eli/fga/...` через тот же SPARQL/filestore, что и pdf-a редакции (стадия `fedlex_pdf_text_stage.py` переиспользуется почти целиком: клейм, 80MB cap, quality gate, OCR-хвост).
- Фильтр: `document_type` = Botschaft (в `metadata_json`), ≈ 6–7K документов, ~400K абзацев. Сохранять абзацы с якорями (нужно для «цели статьи»).
- Линк Botschaft → акт: `ch_act_as_link` уже есть (17,055 basicAct связей); добавить парсинг «Änderung von Art. X» из текста для маппинга поправка→BBl (у них 83,958 таких ссылок).
- Тулзы: `ch_search_materials(query, act, article)`, `ch_get_article_purpose(act, article)` (возвращает абзацы Botschaft, где обсуждается статья).
- Объём: ~7K PDF, ночь на GCP (4 vCPU; pdftotext стоит с 01.09).

### Фаза 2. Регуляторы и MKG (≈ 8K документов, все открытые порталы)

Один общий базовый класс (как `scrapers/practice/base.py` у них): листинг → PDF/HTML → `ch_court_decisions` с новыми `spider`/`court_code` (спайдер-схема уже поддерживает не-суды: CH_WEKO, CH_EDOEB). Так они сразу попадают в FTS, граф цитирований и `ch_verify_citations`.

| Источник | URL | Объём у них | Примечание |
|---|---|---|---|
| FINMA Enforcement + Versicherungsrecht | finma.ch/de/dokumentation/enforcement-reporting/, Versicherungsrecht-Entscheide | 455 + 2,583 | Versicherungsrecht 1994–2024 |
| UBI (Unabhängige Beschwerdeinstanz Radio/TV) | ubi.admin.ch Entscheide | 667 | 1998–2026 |
| ElCom | elcom.admin.ch/de/entscheide | 425 | |
| ESchK (Schätzungskommission) | eschk.admin.ch | 415 | |
| EMARK (Asylrekurskommission, история) | ARK-Entscheide 1949–2006 | 237 | закрытый архив, одноразовый импорт |
| PostCom, ComCom, BAZG, ESBK, Preisüberwacher, RAB, SAV | по одному порталу каждый | 224+64+88+20+27+5+45 | мелкие, один класс на всех |
| MKG (Militärkassationsgericht) | oa.admin.ch / alexandria | 1,244 (1915–2025) | закрытый архив |
| WEKO добор | weko.admin.ch/de/entscheide | у них 261–283 vs наши 117 | проверить, что entscheidsuche отдаёт |

Delta: еженедельно (регуляторы публикуют редко), не в ночную.

### Фаза 3. ЕСПЧ по Швейцарии

- Самый дешёвый путь: на legal_prod лежат `echr_cases` 209,774 (HUDOC); выгрузить Swiss-respondent подмножество (+ все Chamber/GC importance 1–3, как у них: 8.1K) в lawrider через тот же dump-push AWS→GCP, что использовался при миграции (обратного ssh нет by design).
- Если legal_prod-таблица без полного текста или без поля importance, добрать через HUDOC API (см. память `reference_hudoc_api_gotchas`).
- Таблица: свои `echr_cases` на lawrider (уже созданы, пусты). Тулза `ch_search_echr` или флаг `include_echr` в `ch_search_court_decisions`. Резолвер цитат: добавить паттерн «EGMR/CourEDH ... Nr. 12345/09» в `chpipe/citations.py`, чтобы ссылки из BGE резолвились.
- Объём ≈ 10K документов.

### Фаза 4. Кантональные доборы напрямую с порталов (только где измерен разрыв)

Сначала измерить, потом кодить: для GE, TI, NE, GL снять portal count с самого портала (justice.ge.ch, www3.ti.ch/CAN/giurisprudenza, jurisprudence.ne.ch, gl.entscheidsuche.ch) и сравнить с нашим `count(*) by spider`. Их stats по GE (170K) почти наверняка включают дубли (в health 93K), так что реальный разрыв может быть нулевым.
- Если разрыв подтверждён: direct-scraper как дополнительный spider (`GE_Direct`), дедуп по docket+date против entscheidsuche-строк (у нас 0 дублей ECLI, держать это гейтом).
- NE jurisprudence administrative (1,611) точно не в entscheidsuche: отдельный маленький спайдер.

### Фаза 5. Административная практика федеральных ведомств (≈ 3–4K документов)

FINMA-Rundschreiben (1,133), ESTV Kreisschreiben (285) + MWST-Info/Branchen-Info, SECO Kommentar ArG (1,102), BAFU/ARE Vollzugshilfen (297+), SEM Weisungen, EPA Personalrecht, SSK Kreisschreiben. Все на admin.ch, PDF, открыты.
- Таблица `ch_practice_documents(source, office, doc_number, title, lang, valid_from, valid_to, full_text, source_url, licence)`; версии (Kreisschreiben заменяют друг друга) через `supersedes`.
- Тулза `ch_search_practice(query, office)`. Линк на статьи через существующий резолвер.
- Delta ежемесячно.

### Фаза 6. Научные публикации (OAI-PMH, 24 источника)

- Один harvester OAI-PMH (`oai_pmh.py` у них: sets по DDC 340/320/350, windowed для ZORA/UNIGE/SONAR) + 5 кастомных (repositorium Supabase, medialex/EuZ WordPress REST, anci PDF, thegoodboard sitemap, LeGes HTML).
- Лицензия per-record: метаданные + абстракт всегда, полный текст только при CC-*; для «In Copyright»/«Per-record» хранить только ссылку. Это единственная фаза с лицензионным риском, поэтому последняя.
- Таблица `ch_scholarship(source, oai_id, title, authors, year, lang, type, abstract, full_text NULL, licence, url, cited_statutes[], cited_decisions[])`; тулзы `ch_search_scholarship`, `ch_find_scholarship_citing(decision|article)`.
- Объём 44K записей, ночь харвеста.

## Открытые вопросы (не данные, но влияют на позиционирование)

1. У opencaselaw MCP/REST без ключа и CC0-датасет на HF. У нас MCP по ключу с кредитами. Открывать ли read-only tier без ключа с rate-limit? Отдельное решение Ватта.
2. Их числа честнее нашего сайта в одном месте: они публикуют `unique_decisions` (921K) рядом с представлениями. На lawrider.ch можно писать «1.22M решений, 0 дублей ECLI» и это проверяемо больше.
3. Ticino/GE direct-scrapers имеет смысл делать только после измерения (фаза 4).

## Порядок и оценка

| Фаза | Документов | Оценка | Зависимости |
|---|---|---|---|
| 1a комментарии | 1,564 | 1 день, сделано (PR #2398) | нет |
| 1b Botschaften | 7K | 2 дня + ночь на GCP | fedlex_pdf_text_stage |
| 2 регуляторы + MKG | 8K | 3 дня | нет |
| 3 ЕСПЧ | 10K | 1 день (копия с legal_prod) | dump-push AWS→GCP |
| 4 кантональные доборы | 0–90K | 0.5 дня измерить, потом решать | нет |
| 5 адм. практика | 3–4K | 2 дня | нет |
| 6 scholarship | 44K | 3 дня | лицензионная политика |

Каждая фаза = отдельная ветка от main, PR, тикет под эпиком LEXAI-2000 в Plane.

## Verification (для каждой фазы)

- Счётчик источник vs наш `count(*)` по `spider`/`source` записывается в README стадии (как `Gate D`).
- Качество текста: выборка 200 строк, top-words (ловит CSS/mojibake), `quality >= 0.5`, `mojibake = 0` (существующий gate в `extract_stage`).
- Лицензия: `SELECT licence, count(*)` не содержит NULL; для scholarship `full_text IS NULL` там, где лицензия не CC.
- Дубли: `ch_court_decisions` остаётся с 0 дублей ECLI после фаз 2–4.
- Тулзы: live smoke через `/v2/mcp` на mcp.lawrider.ch (как делалось для LEXAI-2035), + jest в `mcp_backend/src/api/tools/__tests__/`.
- Delta: первый ночной/еженедельный прогон под наблюдением в tmux (память `feedback_supervise_long_jobs_on_prod`).
