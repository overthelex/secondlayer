import { useState, useRef, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { useDocumentMeta } from '../../hooks/useDocumentMeta';
import { WebAPIJsonLd } from '../../components/seo/WebAPIJsonLd';

/* ================================================================
   DATA
   ================================================================ */

const API_BASE = 'https://platform.legal.org.ua/api/tools';
/** Streamable HTTP — канонічний транспорт, куратований набір із 28 інструментів. */
const MCP_HTTP_URL = 'https://mcp.legal.org.ua/api/v2/mcp';
/** Legacy SSE — той самий куратований набір, для клієнтів без Streamable HTTP. */
const MCP_SSE_URL = 'https://mcp.legal.org.ua/sse';
/** Повний набір інструментів через MCP (для власних інтеграцій). */
const MCP_FULL_URL = 'https://mcp.legal.org.ua/api/v1/mcp';

/** Кількість інструментів за сервісами — звірено з GET /api/tools, 20.08.2026. */
const TOOL_COUNTS = { total: 124, backend: 90, rada: 5, openreyestr: 29 };
/** Курс НБУ на 20.08.2026, за яким перераховані гривневі суми нижче. */
const USD_UAH = '44,70';

interface ToolDef {
  name: string;
  description: string;
  params?: { name: string; required?: boolean }[];
  cost?: string;
}

interface ToolGroup {
  title: string;
  tools: ToolDef[];
}

const toolGroups: ToolGroup[] = [
  {
    title: 'Пошук судових рішень (ЄДРСР)',
    tools: [
      { name: 'search_court_decisions', description: 'Єдиний пошук у ЄДРСР (136M+ документів). Режими: structured (метадані), fulltext (FTS), hybrid (FTS+семантика), semantic', params: [{ name: 'mode', required: true }, { name: 'query' }, { name: 'party_name' }, { name: 'party_role' }, { name: 'cause_num' }, { name: 'judge' }, { name: 'court_code' }, { name: 'court_name' }, { name: 'justice_kind' }, { name: 'judgment_code' }, { name: 'category_code' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'instance_code' }, { name: 'court_level' }, { name: 'military_preset' }, { name: 'kupap_preset' }, { name: 'include_fulltext' }, { name: 'limit' }, { name: 'offset' }, { name: 'oversample' }, { name: 'rrf_k' }], cost: '₴0.06 · до ₴0.55' },
      { name: 'search_legal_precedents', description: 'Пошук прецедентів із семантичним аналізом; фільтри за рівнем суду (ВП/КЦС/КГС/КАС/ККС) та видом судочинства', params: [{ name: 'query', required: true }, { name: 'domain' }, { name: 'court_level' }, { name: 'procedure_code' }, { name: 'time_range' }, { name: 'limit' }, { name: 'offset' }, { name: 'count_all' }, { name: 'sections' }, { name: 'section_focus' }], cost: '₴0.65 · до ₴29' },
      { name: 'find_similar_fact_pattern_cases', description: 'Справи зі схожою фабулою: семантичний пошук за описом фактичних обставин', params: [{ name: 'procedure_code', required: true }, { name: 'facts_text', required: true }, { name: 'court_level' }, { name: 'time_range' }, { name: 'limit' }], cost: '₴0 · до ₴0.09' },
      { name: 'compare_practice_pro_contra', description: 'Дві лінії практики за правовою тезою — рішення «за» і рішення «проти»', params: [{ name: 'procedure_code', required: true }, { name: 'query', required: true }, { name: 'court_level' }, { name: 'time_range' }, { name: 'limit' }], cost: '₴0 · до ₴1.01' },
      { name: 'edrsr_court_decisions_by_court', description: 'Рішення конкретного суду за FTS-запитом у заданому вікні дат', params: [{ name: 'court_code', required: true }, { name: 'fts_query', required: true }, { name: 'date_from', required: true }, { name: 'date_to' }, { name: 'limit' }, { name: 'offset' }] },
      { name: 'get_similar_reasoning', description: 'Схожі судові обґрунтування за векторною подібністю секцій рішень', params: [{ name: 'query', required: true }, { name: 'section_type' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'court' }, { name: 'chamber' }, { name: 'dispute_category' }, { name: 'outcome' }, { name: 'deviation_flag' }, { name: 'precedent_status' }, { name: 'case_number' }, { name: 'limit' }], cost: '₴0' },
    ],
  },
  {
    title: 'Документи справ',
    tools: [
      { name: 'get_court_decision', description: 'Повний текст рішення з розбивкою на секції: ФАКТИ, МОТИВУВАННЯ, РІШЕННЯ', params: [{ name: 'doc_id' }, { name: 'case_number' }, { name: 'depth' }, { name: 'reasoning_budget' }, { name: 'include_citations' }], cost: '₴0 · до ₴2.07' },
      { name: 'get_case_documents_chain', description: 'Усі документи справи через усі інстанції — перша, апеляція, касація', params: [{ name: 'case_number', required: true }, { name: 'include_full_text' }, { name: 'max_docs' }, { name: 'group_by_instance' }, { name: 'sort' }, { name: 'offset' }, { name: 'document_types' }], cost: '₴0' },
      { name: 'edrsr_get_decision_dispositive', description: 'Лише резолютивна частина: ВИРІШИВ / УХВАЛИВ / ПОСТАНОВИВ / ВИРОК', params: [{ name: 'doc_id', required: true }], cost: '₴0' },
      { name: 'extract_document_sections', description: 'Розбивка тексту рішення на структуровані секції (з LLM або без)', params: [{ name: 'doc_id' }, { name: 'document_id' }, { name: 'text' }, { name: 'use_llm' }] },
      { name: 'load_full_texts', description: 'Пакетне завантаження повних текстів рішень за масивом doc_id', params: [{ name: 'doc_ids', required: true }, { name: 'max_docs' }, { name: 'batch_size' }, { name: 'return_texts' }, { name: 'snippet_chars' }], cost: '₴0 · до ₴1.98' },
      { name: 'get_decision_cited_norms', description: 'Норми законодавства, на які фактично посилається рішення (граф цитувань)', params: [{ name: 'doc_id', required: true }], cost: '₴0' },
      { name: 'bulk_ingest_court_decisions', description: 'Масове завантаження та векторизація рішень за запитом (пагінація)', params: [{ name: 'query', required: true }, { name: 'date_from' }, { name: 'date_to' }, { name: 'max_docs' }, { name: 'max_pages' }, { name: 'page_size' }, { name: 'supreme_court_hint' }] },
    ],
  },
  {
    title: 'Аналіз практики',
    tools: [
      { name: 'analyze_case_pattern', description: 'Патерни практики: успішні аргументи, ризики, статистика результатів', params: [{ name: 'intent', required: true }, { name: 'query' }, { name: 'case_ids' }, { name: 'documents' }, { name: 'method' }] },
      { name: 'count_cases_by_party', description: 'Точна кількість справ за назвою сторони (позивач/відповідач)', params: [{ name: 'party_name', required: true }, { name: 'party_type' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'return_cases' }, { name: 'max_cases_to_return' }], cost: '₴0' },
      { name: 'check_precedent_status', description: 'Чи не скасовано рішення вищою інстанцією', params: [{ name: 'case_id' }, { name: 'case_number' }, { name: 'doc_id' }], cost: '₴0' },
      { name: 'get_citation_graph', description: 'Граф цитувань рішення: на які статті законодавства воно посилається', params: [{ name: 'case_id', required: true }, { name: 'depth' }], cost: '₴0' },
      { name: 'search_court_case_status', description: 'Статус судової справи за номером, суддею або судом', params: [{ name: 'case_number' }, { name: 'judge' }, { name: 'description' }, { name: 'court_name' }, { name: 'limit' }], cost: '₴0' },
      { name: 'analyze_data', description: 'Read-only SQL для аналітики: GROUP BY, COUNT, агрегати, JOIN (таймаут 45с)', params: [{ name: 'sql', required: true }], cost: '₴0' },
    ],
  },
  {
    title: 'Законодавство',
    tools: [
      { name: 'get_legislation_section', description: 'Стаття за посиланням («ст. 625 ЦК») або за rada_id + article_number, з історичною редакцією на дату', params: [{ name: 'query' }, { name: 'rada_id' }, { name: 'article_number' }, { name: 'as_of_date' }, { name: 'include_html' }, { name: 'theme' }], cost: '₴0' },
      { name: 'get_legislation_articles', description: 'Кілька статей одного акту за один виклик (напр. 354–356 ЦПК)', params: [{ name: 'rada_id', required: true }, { name: 'article_numbers', required: true }, { name: 'as_of_date' }, { name: 'include_html' }, { name: 'theme' }], cost: '₴0' },
      { name: 'search_legislation', description: 'Семантичний пошук релевантних статей законодавства за описом ситуації', params: [{ name: 'query', required: true }, { name: 'rada_id' }, { name: 'limit' }, { name: 'include_html' }, { name: 'include_court_practice' }], cost: '₴0.15 · до ₴0.22' },
      { name: 'get_legislation_structure', description: 'Структура акту: розділи, глави, параграфи з лічильником статей', params: [{ name: 'rada_id', required: true }, { name: 'include_articles' }, { name: 'offset' }, { name: 'limit' }], cost: '₴0' },
      { name: 'get_legislation_history', description: 'Історія редакцій акту: які статті змінювались і коли', params: [{ name: 'rada_id', required: true }, { name: 'article_number' }], cost: '₴0' },
      { name: 'list_legislation_editions', description: 'Перелік доступних історичних редакцій акту з датами', params: [{ name: 'rada_id', required: true }], cost: '₴0' },
      { name: 'search_procedural_norms', description: 'Процесуальні норми ЦПК/ГПК/КАС через RADA MCP', params: [{ name: 'code', required: true }, { name: 'query' }, { name: 'article' }, { name: 'limit' }] },
    ],
  },
  {
    title: 'НПА та правові акти',
    tools: [
      { name: 'search_npa', description: 'Повний корпус НПА України (293K актів): закони, підзаконні акти, редакції', params: [{ name: 'query' }, { name: 'title' }, { name: 'status' }, { name: 'doc_type' }, { name: 'as_of_date' }, { name: 'limit' }], cost: '₴0' },
      { name: 'get_npa_act', description: 'Картка акта НПА за nreg: метадані, редакції, текст, окрема стаття', params: [{ name: 'nreg', required: true }, { name: 'mode' }, { name: 'article_number' }, { name: 'as_of_date' }, { name: 'offset' }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_edrnpa', description: 'Реєстр нормативно-правових актів ЄДРНПА (141K записів)', params: [{ name: 'name' }, { name: 'number' }, { name: 'publisher' }, { name: 'doc_type' }, { name: 'keywords' }, { name: 'include_text' }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_legal_acts', description: 'Пошук НПА: закони, кодекси, укази, постанови', params: [{ name: 'query', required: true }, { name: 'target' }, { name: 'date_before' }, { name: 'limit' }], cost: '₴0' },
      { name: 'get_legal_act_meta', description: 'Кількість і метадані НПА за запитом без завантаження результатів', params: [{ name: 'query', required: true }, { name: 'target' }], cost: '₴0' },
    ],
  },
  {
    title: 'Процесуальні інструменти',
    tools: [
      { name: 'calculate_procedural_deadlines', description: 'Калькулятор процесуальних строків з аналізом практики їх поновлення', params: [{ name: 'procedure_code', required: true }, { name: 'event_type' }, { name: 'event_date', required: true }, { name: 'received_full_text_date' }, { name: 'appeal_type', required: true }, { name: 'time_range' }, { name: 'practice_limit' }, { name: 'practice_queries_max' }, { name: 'practice_broad_queries_max' }, { name: 'practice_disable_time_range' }, { name: 'practice_use_court_practice' }, { name: 'practice_case_map_max' }, { name: 'practice_expand_docs' }, { name: 'practice_expand_depth' }, { name: 'reasoning_budget' }] },
      { name: 'build_procedural_checklist', description: 'Чекліст для стадії справи з посиланням на норму', params: [{ name: 'procedure_code', required: true }, { name: 'stage', required: true }, { name: 'case_category' }] },
      { name: 'calculate_monetary_claims', description: '3% річних, інфляційні втрати та інші грошові вимоги', params: [{ name: 'amount', required: true }, { name: 'date_from', required: true }, { name: 'date_to', required: true }, { name: 'claim_type' }] },
      { name: 'search_court_hearing_schedule', description: 'Розклад судових засідань: дата, час, зал, учасники', params: [{ name: 'query' }, { name: 'source' }, { name: 'target' }, { name: 'case_number' }, { name: 'judge' }, { name: 'participant' }, { name: 'court_name' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'limit' }], cost: '₴0' },
      { name: 'bulk_ingest_court_sessions', description: 'Масовий імпорт судових засідань у локальну базу', params: [{ name: 'query', required: true }, { name: 'date_from' }, { name: 'date_to' }, { name: 'max_sessions' }, { name: 'max_pages' }] },
      { name: 'build_legal_decision', description: 'Decision Layer: структурована правова позиція з результатів пошуку (таймаут 120с)', params: [{ name: 'query', required: true }, { name: 'context', required: true }, { name: 'pro_cases' }, { name: 'contra_cases' }, { name: 'legislation' }], cost: '₴24 · до ₴26' },
    ],
  },
  {
    title: 'Обробка документів',
    tools: [
      { name: 'parse_document', description: 'Парсинг PDF/DOCX/HTML з витягом тексту та метаданих, OCR через Google Vision', params: [{ name: 'fileBase64', required: true }, { name: 'mimeType' }, { name: 'filename' }] },
      { name: 'extract_key_clauses', description: 'Ключові положення договору з класифікацією за типами клауз', params: [{ name: 'documentText', required: true }, { name: 'documentId' }] },
      { name: 'summarize_document', description: 'Резюме документа: executive summary, посекційний розбір, ключові факти', params: [{ name: 'documentText', required: true }, { name: 'detailLevel' }] },
      { name: 'compare_documents', description: 'Семантичне порівняння двох версій документа з класифікацією змін', params: [{ name: 'oldDocumentText', required: true }, { name: 'newDocumentText', required: true }] },
      { name: 'batch_process_documents', description: 'Пакетна обробка документів із контролем конкурентності та повторами', params: [{ name: 'files', required: true }, { name: 'operations', required: true }, { name: 'concurrency' }, { name: 'retryAttempts' }, { name: 'skipErrors' }] },
    ],
  },
  {
    title: 'Due Diligence',
    tools: [
      { name: 'bulk_review_runner', description: 'Пакетна DD-перевірка масиву документів (batch orchestration)', params: [{ name: 'documentIds', required: true }, { name: 'maxConcurrency' }, { name: 'trace_id' }] },
      { name: 'risk_scoring', description: 'Risk score за findings: Critical +25, High +15 тощо', params: [{ name: 'documentIds', required: true }, { name: 'findings' }, { name: 'trace_id' }] },
      { name: 'generate_dd_report', description: 'DD-звіт: executive summary плюс таблиця findings', params: [{ name: 'findings', required: true }, { name: 'riskScores', required: true }, { name: 'reportTitle', required: true }, { name: 'format' }, { name: 'trace_id' }] },
    ],
  },
  {
    title: 'Pipeline',
    tools: [
      { name: 'classify_intent', description: 'Класифікація запиту (service/task/depth) — точка входу в pipeline', params: [{ name: 'query', required: true }, { name: 'context' }, { name: 'reasoning_budget' }], cost: '₴0.05 · до ₴0.89' },
      { name: 'retrieve_legal_sources', description: 'RAG retrieval: сирі джерела (справи, закони, роз’яснення) без аналізу', params: [{ name: 'context', required: true }, { name: 'limits' }], cost: '₴0' },
      { name: 'validate_response', description: 'Trust layer: перевірка, що відповідь спирається на надані джерела', params: [{ name: 'answer', required: true }, { name: 'sources', required: true }] },
      { name: 'format_answer_pack', description: 'Пакування результату у структуру norm / position / conclusion / risks', params: [{ name: 'desired_output' }, { name: 'norm' }, { name: 'position' }, { name: 'conclusion' }, { name: 'risks' }] },
    ],
  },
  {
    title: 'Інтелектуальна власність',
    tools: [
      { name: 'search_ip_objects', description: 'Реєстр об’єктів права інтелектуальної власності: ТМ, патенти, промзразки', params: [{ name: 'query' }, { name: 'obj_type' }, { name: 'obj_state' }, { name: 'classes' }, { name: 'owner' }, { name: 'owner_edrpou' }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_trademarks', description: 'Свідоцтва на знаки для товарів і послуг за класами МКТП та власником', params: [{ name: 'query' }, { name: 'nice_classes' }, { name: 'owner' }, { name: 'owner_edrpou' }, { name: 'obj_state' }, { name: 'limit' }], cost: '₴0' },
      { name: 'find_similar_trademarks', description: 'Тотожні та схожі ТМ у тих самих класах — перевірка на «зіткнення»', params: [{ name: 'app_number' }, { name: 'query' }, { name: 'classes' }, { name: 'obj_state' }, { name: 'min_similarity' }, { name: 'limit' }], cost: '₴0' },
      { name: 'get_ip_object', description: 'Картка об’єкта ІВ за номером заявки або реєстрації', params: [{ name: 'app_number' }, { name: 'registration_number' }, { name: 'obj_type' }], cost: '₴0' },
      { name: 'get_trademark_dossier', description: 'Повне досьє ТМ за одним номером: заявка, діловодство, публікації', params: [{ name: 'number', required: true }], cost: '₴0.05 · до ₴0.07' },
    ],
  },
  {
    title: 'Відкриті дані та реєстри',
    tools: [
      { name: 'search_registry', description: 'Єдиний вхід у 37 реєстрів відкритих даних: санкції, адвокати, корупціонери, банки НБУ, фінзвітність та ін.', params: [{ name: 'registry', required: true }, { name: 'filters' }, { name: 'aggregate' }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_judges', description: 'Реєстр суддів ВККС: 6K чинних плюс 417K історичних записів', params: [{ name: 'full_name' }, { name: 'court_name' }, { name: 'dossier_number' }, { name: 'gender' }, { name: 'include_history' }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_vkks', description: 'Дані ВККС у 5 категоріях: judges, evaluations, declarations, vacancies, efficiency', params: [{ name: 'category', required: true }, { name: 'judge_name' }, { name: 'court_name' }, { name: 'year' }, { name: 'region' }, { name: 'court_level' }, { name: 'dossier_number' }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_vrp_judges_discipline', description: 'Дисциплінарні дані суддів ВРП: звільнені, відсторонені, втручання', params: [{ name: 'judge_name' }, { name: 'court_name' }, { name: 'type' }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_public_spending', description: 'Публічні витрати spending.gov.ua: 12.6M+ записів (таймаут 120с)', params: [{ name: 'edrpou' }, { name: 'contractor_name' }, { name: 'contractor_edrpou' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'min_amount' }, { name: 'max_amount' }, { name: 'doc_type' }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_invalid_passports', description: 'Недійсні паспорти МВС: 2.9M внутрішніх документів', params: [{ name: 'd_series' }, { name: 'd_number' }, { name: 'ovd' }, { name: 'd_status' }, { name: 'include_foreign' }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_terrorism_list', description: 'Перелік осіб і організацій, пов’язаних з тероризмом (ДСФМУ)', params: [{ name: 'name', required: true }, { name: 'limit' }], cost: '₴0' },
      { name: 'search_amcu_practice', description: 'Семантичний пошук по рішеннях Антимонопольного комітету', params: [{ name: 'query', required: true }, { name: 'date_from' }, { name: 'date_to' }, { name: 'limit' }], cost: '₴0' },
    ],
  },
  {
    title: 'ЄСПЛ',
    tools: [
      { name: 'search_echr_practice', description: 'Практика Європейського суду з прав людини', params: [{ name: 'query', required: true }, { name: 'type_id' }, { name: 'limit' }], cost: '₴0' },
      { name: 'get_echr_document', description: 'Повний текст документа ЄСПЛ за ID', params: [{ name: 'id', required: true }] },
    ],
  },
  {
    title: 'Верховна Рада',
    tools: [
      { name: 'rada_search_parliament_bills', description: 'Законопроєкти Верховної Ради з семантичним аналізом', params: [{ name: 'query', required: true }, { name: 'status' }, { name: 'initiator' }, { name: 'committee' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'limit' }], cost: '₴0' },
      { name: 'rada_search_bill_documents', description: 'Супровідні документи законопроєктів: висновки ГНЕУ, комітетів, порівняльні таблиці', params: [{ name: 'query' }, { name: 'bill_number' }, { name: 'doc_kind' }, { name: 'convocation' }, { name: 'initiator' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'limit' }], cost: '₴0' },
      { name: 'rada_get_deputy_info', description: 'Дані народного депутата: фракція, помічники, історія голосувань', params: [{ name: 'name' }, { name: 'rada_id' }, { name: 'faction' }, { name: 'include_voting_record' }, { name: 'include_assistants' }], cost: '₴0' },
      { name: 'rada_search_legislation_text', description: 'Тексти законів із посиланнями на судові рішення', params: [{ name: 'law_identifier', required: true }, { name: 'article' }, { name: 'search_text' }, { name: 'include_court_citations' }], cost: '₴0' },
      { name: 'rada_analyze_voting_record', description: 'Аналіз голосувань депутата з AI-інсайтами', params: [{ name: 'deputy_name', required: true }, { name: 'date_from' }, { name: 'date_to' }, { name: 'bill_number' }, { name: 'analyze_patterns' }] },
    ],
  },
  {
    title: 'Державні реєстри (OpenReyestr)',
    tools: [
      { name: 'openreyestr_search_entities', description: 'Юридичні особи та ФОП у ЄДР', params: [{ name: 'query' }, { name: 'edrpou' }, { name: 'record' }, { name: 'entityType' }, { name: 'stan' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_get_entity_details', description: 'Повна картка суб’єкта: засновники, бенефіціари, керівники', params: [{ name: 'record', required: true }, { name: 'entityType' }], cost: '₴0' },
      { name: 'openreyestr_get_by_edrpou', description: 'Швидкий пошук суб’єкта за кодом ЄДРПОУ', params: [{ name: 'edrpou', required: true }], cost: '₴0' },
      { name: 'openreyestr_search_beneficiaries', description: 'Кінцеві бенефіціарні власники компаній', params: [{ name: 'query', required: true }, { name: 'limit' }], cost: '₴0' },
      { name: 'openreyestr_search_termination_started', description: 'Юрособи, щодо яких розпочато процедуру припинення', params: [{ name: 'query', required: true }, { name: 'entity_type' }, { name: 'signer_name' }, { name: 'reason' }, { name: 'limit' }, { name: 'offset' }] },
      { name: 'openreyestr_get_statistics', description: 'Агрегована статистика по ЄДР', cost: '₴0' },
      { name: 'openreyestr_search_debtors', description: 'Єдиний реєстр боржників', params: [{ name: 'query' }, { name: 'edrpou' }, { name: 'collection_category' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_enforcement_proceedings', description: 'Виконавчі провадження', params: [{ name: 'query' }, { name: 'debtor_edrpou' }, { name: 'creditor_name' }, { name: 'proceeding_status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_bankruptcy_cases', description: 'Справи про банкрутство', params: [{ name: 'query' }, { name: 'debtor_edrpou' }, { name: 'case_number' }, { name: 'proceeding_status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_arma_seized_assets', description: 'Реєстр АРМА: активи під арештом у кримінальних провадженнях', params: [{ name: 'owner_name' }, { name: 'owner_edrpou' }, { name: 'case_number' }, { name: 'asset_type' }, { name: 'status' }, { name: 'court_name' }, { name: 'region' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_rnbo_sanctions', description: 'Санкційні списки РНБО', params: [{ name: 'query', required: true }, { name: 'schema_type' }, { name: 'country' }, { name: 'identifier' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_nazk_declarations', description: 'Декларації НАЗК', params: [{ name: 'declarant_name' }, { name: 'declarant_workplace' }, { name: 'declaration_year' }, { name: 'declaration_type' }, { name: 'declarant_region' }, { name: 'min_income' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_prozorro', description: 'Тендери ProZorro', params: [{ name: 'query' }, { name: 'buyer_edrpou' }, { name: 'buyer_name' }, { name: 'status' }, { name: 'cpv_code' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_vat_payers', description: 'Реєстр платників ПДВ (ДПС)', params: [{ name: 'query' }, { name: 'vat_code' }, { name: 'limit' }, { name: 'offset' }] },
      { name: 'openreyestr_search_single_tax_payers', description: 'Реєстр платників єдиного податку (ДПС)', params: [{ name: 'query' }, { name: 'tin' }, { name: 'tax_group' }, { name: 'limit' }, { name: 'offset' }] },
      { name: 'openreyestr_search_tax_debt', description: 'Реєстр податкового боргу (ДПС)', params: [{ name: 'query' }, { name: 'tin' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_esv_debt', description: 'Реєстр боргу зі сплати ЄСВ', params: [{ name: 'query' }, { name: 'tin' }, { name: 'limit' }, { name: 'offset' }] },
      { name: 'openreyestr_search_notaries', description: 'Єдиний реєстр нотаріусів', params: [{ name: 'query' }, { name: 'region' }, { name: 'status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_court_experts', description: 'Атестовані судові експерти', params: [{ name: 'query' }, { name: 'region' }, { name: 'expertise_type' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_arbitration_managers', description: 'Арбітражні керуючі (банкрутство)', params: [{ name: 'query' }, { name: 'status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_forensic_methods', description: 'Методики судових експертиз', params: [{ name: 'query' }, { name: 'expertise_type' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_special_forms', description: 'Спеціальні бланки нотаріальних документів', params: [{ name: 'series' }, { name: 'form_number' }, { name: 'recipient' }, { name: 'status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_legal_acts', description: 'Нормативно-правові акти в реєстрі НАІС', params: [{ name: 'query' }, { name: 'act_type' }, { name: 'publisher' }, { name: 'status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_administrative_units', description: 'Адміністративно-територіальні одиниці (КОАТУУ)', params: [{ name: 'query' }, { name: 'region' }, { name: 'unit_type' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_streets', description: 'Реєстр вулиць НАІС', params: [{ name: 'query' }, { name: 'settlement' }, { name: 'region' }, { name: 'street_type' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0' },
      { name: 'openreyestr_search_street_renamings', description: 'Історія перейменувань вулиць (дані OpenStreetMap)', params: [{ name: 'query' }, { name: 'min_renames' }, { name: 'limit' }, { name: 'offset' }] },
      { name: 'openreyestr_search_exchange_data', description: 'Реєстр обміну даними з державними органами', params: [{ name: 'entity_record' }, { name: 'entity_type' }, { name: 'tax_payer_type' }, { name: 'limit' }, { name: 'offset' }] },
      { name: 'openreyestr_search_me_datasets', description: 'Каталог датасетів Мінекономіки', params: [{ name: 'query' }, { name: 'limit' }], cost: '₴0' },
      { name: 'openreyestr_search_me_records', description: 'Рядки всередині датасету Мінекономіки', params: [{ name: 'dataset' }, { name: 'resource_id' }, { name: 'query' }, { name: 'limit' }, { name: 'offset' }] },
    ],
  },
  {
    title: 'Суди Індії',
    tools: [
      { name: 'search_india_supreme_court', description: 'Рішення Верховного суду Індії: 38K+ актів, 1950–2026', params: [{ name: 'query' }, { name: 'petitioner' }, { name: 'respondent' }, { name: 'judge' }, { name: 'citation' }, { name: 'case_id' }, { name: 'cnr' }, { name: 'disposal_nature' }, { name: 'year_from' }, { name: 'year_to' }, { name: 'limit' }, { name: 'offset' }] },
      { name: 'search_india_high_courts', description: 'Рішення 25 High Courts Індії: 16M+ актів, 1950–2025', params: [{ name: 'query' }, { name: 'court' }, { name: 'court_code' }, { name: 'judge' }, { name: 'cnr' }, { name: 'disposal_nature' }, { name: 'bench' }, { name: 'year_from' }, { name: 'year_to' }, { name: 'limit' }, { name: 'offset' }] },
      { name: 'india_court_stats', description: 'Агрегована статистика судів Індії за роками, судами, суддями', params: [{ name: 'source' }, { name: 'court' }, { name: 'year_from' }, { name: 'year_to' }, { name: 'group_by' }, { name: 'limit' }] },
    ],
  },
  {
    title: 'Vault',
    tools: [
      { name: 'store_document', description: 'Зберегти документ у Vault: парсинг, секціонування, векторизація', params: [{ name: 'fileBase64', required: true }, { name: 'mimeType' }, { name: 'title', required: true }, { name: 'type', required: true }, { name: 'metadata' }] },
      { name: 'get_document', description: 'Документ із Vault за ID: текст, метадані, теги, секції', params: [{ name: 'documentId', required: true }, { name: 'includeSections' }, { name: 'includePatterns' }], cost: '₴0' },
      { name: 'list_documents', description: 'Список документів Vault з фільтрами та текстовим пошуком', params: [{ name: 'query' }, { name: 'type' }, { name: 'tags' }, { name: 'category' }, { name: 'uploadedAfter' }, { name: 'uploadedBefore' }, { name: 'limit' }, { name: 'offset' }, { name: 'sortBy' }, { name: 'sortOrder' }, { name: 'folderPath' }, { name: 'matterId' }], cost: '₴0' },
      { name: 'semantic_search', description: 'Семантичний пошук по документах Vault через векторні ембедінги', params: [{ name: 'query', required: true }, { name: 'type' }, { name: 'tags' }, { name: 'limit' }, { name: 'threshold' }], cost: '₴0 · до ₴0' },
      { name: 'update_document', description: 'Оновити метадані документа: назву, теги, тип, категорію, теку', params: [{ name: 'documentId', required: true }, { name: 'title' }, { name: 'tags' }, { name: 'type' }, { name: 'category' }, { name: 'folderPath' }, { name: 'matterId' }] },
      { name: 'delete_document', description: 'Soft-delete документа разом із векторними ембедінгами', params: [{ name: 'documentId', required: true }] },
      { name: 'auto_tag_vault_documents', description: 'Автотегування документів Vault, у яких немає тегів', params: [{ name: 'userId', required: true }, { name: 'limit' }, { name: 'type' }, { name: 'force' }] },
    ],
  },
  {
    title: 'Службові та адміністративні',
    tools: [
      { name: 'list_import_sources', description: 'Каталог джерел даних для імпорту (data.gov.ua, НІПО тощо)', cost: '₴0' },
      { name: 'start_import', description: 'Запустити фонову задачу імпорту з багатопотоковим завантаженням', params: [{ name: 'source_name', required: true }, { name: 'from_page' }, { name: 'threads_per_ip' }], cost: '₴0' },
      { name: 'get_import_status', description: 'Прогрес, швидкість та ETA імпортних задач', params: [{ name: 'task_id' }, { name: 'status' }], cost: '₴0' },
      { name: 'cancel_import', description: 'Скасувати задачу імпорту зі збереженням прогресу', params: [{ name: 'task_id', required: true }] },
      { name: 'workflow_memory_query', description: 'Семантичний пошук по трирівневій workflow memory', params: [{ name: 'query', required: true }, { name: 'layers' }, { name: 'tags' }, { name: 'top_k' }, { name: 'session_id' }] },
      { name: 'workflow_memory_ingest', description: 'Додати запис до workflow memory (principle / pattern / knowledge)', params: [{ name: 'layer', required: true }, { name: 'title', required: true }, { name: 'body', required: true }, { name: 'principle_key' }, { name: 'pattern_type' }, { name: 'knowledge_type' }, { name: 'source' }, { name: 'source_ref' }, { name: 'tags' }, { name: 'session_id' }, { name: 'commit_range' }, { name: 'files_touched' }, { name: 'tools_used' }, { name: 'pattern_data' }] },
      { name: 'workflow_memory_reconcile', description: 'Post-session reconciliation workflow memory', params: [{ name: 'session_id', required: true }, { name: 'files_touched', required: true }, { name: 'commit_range' }, { name: 'tools_used' }, { name: 'prompts_count' }] },
      { name: 'workflow_memory_push_refresh', description: 'Push-mode refresh для неактивних задач', params: [{ name: 'max_age_days' }, { name: 'task_ids' }] },
      { name: 'workflow_memory_push_sync_tasks', description: 'Синхронізація задач Plane у push-watchlist', params: [{ name: 'tasks', required: true }] },
      { name: 'workflow_memory_stats', description: 'Статистика записів по шарах workflow memory' },
      { name: 'ab_create_experiment', description: 'Створити A/B експеримент: моделі, промпти, конфігурації', params: [{ name: 'name', required: true }, { name: 'description' }, { name: 'experiment_type' }, { name: 'config', required: true }, { name: 'target_budget' }, { name: 'traffic_pct' }] },
      { name: 'ab_list_experiments', description: 'Список A/B експериментів із фільтром за статусом', params: [{ name: 'status' }] },
      { name: 'ab_update_status', description: 'Змінити статус експерименту: running / paused / completed', params: [{ name: 'experiment_id', required: true }, { name: 'status', required: true }] },
      { name: 'ab_get_results', description: 'Агреговані результати по варіантах експерименту', params: [{ name: 'experiment_id', required: true }] },
      { name: 'nextcloud_upload', description: 'Завантажити файл у сховище Nextcloud', params: [{ name: 'remote_path', required: true }, { name: 'content_base64' }, { name: 'local_file_path' }, { name: 'content_type' }] },
      { name: 'nextcloud_share', description: 'Створити посилання для спільного доступу в Nextcloud', params: [{ name: 'path', required: true }, { name: 'share_type' }, { name: 'share_with' }, { name: 'password' }, { name: 'expire_date' }, { name: 'permissions' }] },
    ],
  },
];

/* ================================================================
   TABLE OF CONTENTS
   ================================================================ */

const tocItems = [
  { id: 'overview', label: 'Огляд' },
  { id: 'authentication', label: 'Автентифікація' },
  { id: 'endpoints', label: 'Ендпоінти' },
  { id: 'tools', label: 'Інструменти' },
  { id: 'examples', label: 'Приклади' },
  { id: 'mcp-clients', label: 'MCP клієнти' },
  { id: 'pricing', label: 'Вартість' },
];

/* ================================================================
   MAIN COMPONENT
   ================================================================ */

export function DeveloperDocsPage() {
  const [activeSection, setActiveSection] = useState('overview');
  const contentRef = useRef<HTMLDivElement>(null);

  useDocumentMeta({
    title: `LEX AI API — документація MCP сервера | ${TOOL_COUNTS.total} юридичних інструментів`,
    description: `Підключіть Claude Desktop, Cursor, VS Code або ChatGPT до MCP сервера LEX AI (mcp.legal.org.ua). ${TOOL_COUNTS.total} інструментів: 136M+ судових рішень ЄДРСР, законодавство, державні реєстри, відкриті дані, due diligence. REST API, MCP Streamable HTTP та SSE.`,
    ogTitle: 'LEX AI API — MCP сервер для юридичного аналізу',
    ogDescription: `Підключіть Claude, Cursor або ChatGPT до ${TOOL_COUNTS.total} інструментів юридичного аналізу через MCP. Судова практика, законодавство, реєстри України.`,
    ogImage: 'https://legal.org.ua/og-image.png',
  });

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Track active section on scroll
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const handleScroll = () => {
      const sections = container.querySelectorAll('[data-section]');
      let current = 'overview';
      for (const section of sections) {
        const el = section as HTMLElement;
        if (el.offsetTop - 80 <= container.scrollTop) {
          current = el.id;
        }
      }
      setActiveSection(current);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div ref={contentRef} className="flex-1 h-full overflow-y-auto">
      <WebAPIJsonLd
        name="LEX AI MCP Server"
        description={`MCP сервер для юридичного аналізу: ${TOOL_COUNTS.total} інструментів — судова практика (136M+ документів ЄДРСР), законодавство, державні реєстри, відкриті дані, due diligence. Підключається через Streamable HTTP або SSE до Claude Desktop, Cursor, VS Code, ChatGPT.`}
        url={MCP_HTTP_URL}
        documentationUrl="https://legal.org.ua/developer/docs"
        provider={{ name: "SecondLayer", url: "https://legal.org.ua" }}
        termsOfService="https://legal.org.ua/ua/developer-offer"
      />
      <div className="max-w-[820px] mx-auto px-6 py-8 pb-32">

        {/* Sticky TOC bar */}
        <nav className="sticky top-0 z-10 -mx-6 px-6 py-2.5 mb-6 bg-claude-bg/95 backdrop-blur-sm border-b border-claude-border/50 overflow-x-auto">
          <div className="flex gap-1">
            {tocItems.map(item => (
              <button
                key={item.id}
                onClick={() => scrollTo(item.id)}
                className={`
                  px-3 py-1.5 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors
                  ${activeSection === item.id
                    ? 'bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-zinc-800'
                  }
                `}
              >
                {item.label}
              </button>
            ))}
          </div>
        </nav>

        <OverviewSection />
        <Divider />
        <GettingStartedSection />
        <Divider />
        <ToolsSection />
        <Divider />
        <ExamplesSection />
        <Divider />
        <MCPClientsSection />
        <Divider />
        <PricingSection />
      </div>
    </div>
  );
}


/* ================================================================
   SECTION: OVERVIEW
   ================================================================ */

function OverviewSection() {
  return (
    <section id="overview" data-section>
      <h1 className="text-[28px] font-bold text-claude-text tracking-tight leading-tight">
        LEX AI Platform API
      </h1>
      <p className="mt-3 text-[15px] text-claude-subtext leading-relaxed max-w-[640px]">
        Доступ до {TOOL_COUNTS.total} інструментів юридичного аналізу через уніфікований API.
        Судова практика, законодавство, державні реєстри, відкриті дані, парламентські дані.
      </p>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-px bg-claude-border rounded-xl overflow-hidden border border-claude-border">
        <InfoCell label="Інструменти" value={String(TOOL_COUNTS.total)} />
        <InfoCell label="Мікросервіси" value="3" />
        <InfoCell label="Транспорти" value="REST, MCP, SSE" />
      </div>

      <h2 className="mt-10 text-[20px] font-semibold text-claude-text">Дані</h2>

      <table className="mt-4 w-full text-[13px]">
        <thead>
          <tr className="border-b border-claude-border text-left">
            <Th>Джерело</Th>
            <Th>Обсяг</Th>
          </tr>
        </thead>
        <tbody className="text-claude-subtext">
          <tr className="border-b border-claude-border/50">
            <Td>ЄДРСР — судові рішення</Td>
            <Td>136,3 млн документів, з них 134,5 млн з повним текстом (≈99%); 38,9 млн справ</Td>
          </tr>
          <tr className="border-b border-claude-border/50">
            <Td>Законодавство (<Code>get_legislation_*</Code>)</Td>
            <Td>1,24 млн статей кодексів і законів з історією редакцій</Td>
          </tr>
          <tr className="border-b border-claude-border/50">
            <Td>Повний корпус НПА (<Code>search_npa</Code>)</Td>
            <Td>293 тис. актів, 439 тис. редакцій, 2,2 млн статей; окремо 141 тис. записів ЄДРНПА</Td>
          </tr>
          <tr className="border-b border-claude-border/50">
            <Td>Відкриті дані</Td>
            <Td>37 реєстрів через <Code>search_registry</Code>, 12,6 млн записів публічних витрат</Td>
          </tr>
          <tr className="border-b border-claude-border/50">
            <Td>Державні реєстри</Td>
            <Td>29 реєстрів OpenReyestr: ЄДР, боржники, АРМА, НАЗК, ДПС, ProZorro, санкції РНБО</Td>
          </tr>
          <tr className="border-b border-claude-border/50">
            <Td>Суди Індії</Td>
            <Td>38 тис. рішень Верховного суду, 16 млн рішень 25 High Courts</Td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[12px] text-zinc-400">Станом на 20.08.2026.</p>

      <h2 className="mt-10 text-[20px] font-semibold text-claude-text">Сервіси</h2>

      <div className="mt-4 space-y-3">
        <ServiceRow name="mcp_backend" count={TOOL_COUNTS.backend} description="Судова практика, аналіз, законодавство, НПА, ІВ, парсинг, Vault, відкриті дані, due diligence" />
        <ServiceRow name="mcp_rada" count={TOOL_COUNTS.rada} description="Законопроєкти, супровідні документи, депутати, голосування, тексти законів" />
        <ServiceRow name="mcp_openreyestr" count={TOOL_COUNTS.openreyestr} description="Юридичні особи, ФОП, бенефіціари, боржники, ProZorro, податки, АРМА, НАЗК, санкції" />
      </div>

      <h2 className="mt-10 text-[20px] font-semibold text-claude-text">Транспорти</h2>

      <table className="mt-4 w-full text-[13px]">
        <thead>
          <tr className="border-b border-claude-border text-left">
            <Th>Протокол</Th>
            <Th>Ендпоінт</Th>
            <Th>Призначення</Th>
          </tr>
        </thead>
        <tbody className="text-claude-subtext">
          <tr className="border-b border-claude-border/50">
            <Td>HTTP REST</Td>
            <Td><Code>POST {API_BASE}/:tool</Code></Td>
            <Td>Вебдодатки, серверні інтеграції. Усі {TOOL_COUNTS.total} інструментів</Td>
          </tr>
          <tr className="border-b border-claude-border/50">
            <Td>SSE Streaming</Td>
            <Td><Code>POST {API_BASE}/:tool/stream</Code></Td>
            <Td>Тривалі операції з поточною відповіддю</Td>
          </tr>
          <tr className="border-b border-claude-border/50">
            <Td>MCP Streamable HTTP</Td>
            <Td><Code>{MCP_HTTP_URL}</Code></Td>
            <Td>Claude, Cursor, VS Code. Куратований набір із 28 інструментів</Td>
          </tr>
          <tr className="border-b border-claude-border/50">
            <Td>MCP SSE (legacy)</Td>
            <Td><Code>{MCP_SSE_URL}</Code></Td>
            <Td>Клієнти без підтримки Streamable HTTP. Той самий набір із 28 інструментів</Td>
          </tr>
          <tr className="border-b border-claude-border/50">
            <Td>MCP — повний набір</Td>
            <Td><Code>{MCP_FULL_URL}</Code></Td>
            <Td>Власні інтеграції, яким потрібні всі {TOOL_COUNTS.total} інструментів</Td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[12px] text-zinc-400">
        MCP-клієнти за замовчуванням отримують куратований набір: повний список із {TOOL_COUNTS.total} інструментів
        перевантажує вибір моделі та впирається в ліміти клієнтів на кількість інструментів.
      </p>
    </section>
  );
}

/* ================================================================
   SECTION: GETTING STARTED
   ================================================================ */

function GettingStartedSection() {
  return (
    <section>
      <div id="getting-started" data-section />

      {/* Authentication */}
      <div id="authentication" data-section>
        <h2 className="text-[20px] font-semibold text-claude-text">Автентифікація</h2>
        <p className="mt-2 text-[14px] text-claude-subtext leading-relaxed">
          Всі запити потребують автентифікації через Bearer Token. Згенеруйте API ключ
          у розділі <strong>Профіль &rarr; API токени</strong>.
        </p>

        <CodeBlock lang="http" code={`Authorization: Bearer YOUR_API_KEY`} />

        <h3 className="mt-6 text-[15px] font-semibold text-claude-text">Методи автентифікації</h3>
        <table className="mt-3 w-full text-[13px]">
          <thead>
            <tr className="border-b border-claude-border text-left">
              <Th>Метод</Th>
              <Th>Призначення</Th>
            </tr>
          </thead>
          <tbody className="text-claude-subtext">
            <tr className="border-b border-claude-border/50">
              <Td>Bearer Token</Td>
              <Td>API клієнти, MCP клієнти, скрипти</Td>
            </tr>
            <tr className="border-b border-claude-border/50">
              <Td>JWT / Google OAuth</Td>
              <Td>Вебдодатки з інтерактивною авторизацією</Td>
            </tr>
          </tbody>
        </table>

        <h3 className="mt-6 text-[15px] font-semibold text-claude-text">Ліміти</h3>
        <div className="mt-3 text-[13px] text-claude-subtext space-y-1">
          <p>Rate limit залежить від тарифного плану.</p>
          <p>Максимальний розмір тіла запиту: <Code>10 MB</Code></p>
          <p>
            Timeout інструмента: <Code>60 с</Code> за замовчуванням. Важкі інструменти мають
            власний ліміт: <Code>120 с</Code> для <Code>search_court_decisions</Code>,{' '}
            <Code>get_case_documents_chain</Code>, <Code>compare_practice_pro_contra</Code>,{' '}
            <Code>find_similar_fact_pattern_cases</Code>, <Code>build_legal_decision</Code>,{' '}
            <Code>search_public_spending</Code>; <Code>45 с</Code> для <Code>analyze_data</Code>.
          </p>
          <p>SSE streaming &mdash; без обмеження на тривалість відповіді.</p>
        </div>
      </div>

      {/* Endpoints */}
      <div id="endpoints" data-section className="mt-10">
        <h2 className="text-[20px] font-semibold text-claude-text">Ендпоінти</h2>

        <table className="mt-4 w-full text-[13px]">
          <thead>
            <tr className="border-b border-claude-border text-left">
              <Th>Метод</Th>
              <Th>Шлях</Th>
              <Th>Опис</Th>
            </tr>
          </thead>
          <tbody className="text-claude-subtext">
            <EndpointTableRow method="POST" path="/api/tools/:toolName" desc="Виконати інструмент" />
            <EndpointTableRow method="POST" path="/api/tools/:toolName/stream" desc="Виконати з SSE streaming" />
            <EndpointTableRow method="POST" path="/api/tools/batch" desc="Пакетне виконання" />
            <EndpointTableRow method="GET" path="/api/tools" desc="Список доступних інструментів зі схемами параметрів" />
            <EndpointTableRow method="POST" path="/api/v2/mcp" desc="MCP Streamable HTTP — куратований набір" />
            <EndpointTableRow method="POST" path="/api/v1/mcp" desc="MCP Streamable HTTP — повний набір" />
            <EndpointTableRow method="GET" path="/sse" desc="MCP SSE (legacy транспорт)" />
            <EndpointTableRow method="GET" path="/health" desc="Перевірка стану сервісу" />
          </tbody>
        </table>
      </div>

      {/* Quick Start */}
      <div id="quick-start" data-section className="mt-10">
        <h2 className="text-[20px] font-semibold text-claude-text">Швидкий старт</h2>
        <p className="mt-2 text-[14px] text-claude-subtext leading-relaxed">
          Отримайте API ключ та зробіть перший запит:
        </p>
        <CodeBlock lang="bash" code={`curl -X POST ${API_BASE}/search_legal_precedents \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"arguments": {"query": "відшкодування збитків ДТП", "limit": 5}}'`} />
      </div>
    </section>
  );
}

/* ================================================================
   SECTION: TOOLS
   ================================================================ */

function ToolsSection() {
  return (
    <section id="tools" data-section>
      <h1 className="text-[24px] font-bold text-claude-text tracking-tight">Інструменти</h1>
      <p className="mt-2 text-[14px] text-claude-subtext leading-relaxed">
        Всі {TOOL_COUNTS.total} інструментів доступні через <Code>POST /api/tools/:toolName</Code> з тілом <Code>{`{"arguments": {...}}`}</Code>.
        Зірочка <span className="text-claude-accent">*</span> позначає обов’язковий параметр.
      </p>
      <p className="mt-2 text-[13px] text-claude-subtext leading-relaxed">
        Канонічне джерело — <Code>GET /api/tools</Code>: повертає актуальні імена, описи та JSON-схеми
        параметрів. Список нижче звірено з ним 20.08.2026. Вартість — фактичні заміри на проді,
        див. розділ <a href="#pricing" className="text-claude-accent hover:underline">Вартість</a>.
      </p>

      {toolGroups.map((group, i) => (
        <div key={i} id={`tools-${i}`} data-section className="mt-8">
          <h2 className="text-[17px] font-semibold text-claude-text pb-2 border-b border-claude-border">
            {group.title}
          </h2>
          <div className="divide-y divide-claude-border/50">
            {group.tools.map(tool => (
              <ToolEntry key={tool.name} tool={tool} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function ToolEntry({ tool }: { tool: ToolDef }) {
  return (
    <div className="py-4">
      <div className="flex items-baseline gap-3">
        <code className="text-[13px] font-mono font-semibold text-claude-text">
          {tool.name}
        </code>
        {tool.cost && (
          <span className="text-[11px] text-zinc-400">{tool.cost}</span>
        )}
      </div>
      <p className="mt-1 text-[13px] text-claude-subtext">{tool.description}</p>
      {tool.params && tool.params.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1">
          {tool.params.map(p => (
            <span key={p.name} className="text-[12px] font-mono text-claude-subtext">
              {p.name}{p.required && <span className="text-claude-accent ml-0.5">*</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   SECTION: EXAMPLES
   ================================================================ */

function ExamplesSection() {
  return (
    <section id="examples" data-section>
      <h1 className="text-[24px] font-bold text-claude-text tracking-tight">Приклади коду</h1>

      <div id="example-curl" data-section className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">cURL</h2>
        <h3 className="mt-4 text-[14px] font-medium text-claude-text">Пошук судових рішень</h3>
        <CodeBlock lang="bash" code={`curl -X POST ${API_BASE}/search_court_decisions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "arguments": {
      "mode": "hybrid",
      "query": "відшкодування моральної шкоди при ДТП",
      "date_from": "2023-01-01",
      "date_to": "2024-12-31",
      "limit": 10
    }
  }'`} />

        <h3 className="mt-6 text-[14px] font-medium text-claude-text">Практика «за» і «проти»</h3>
        <CodeBlock lang="bash" code={`curl -X POST ${API_BASE}/compare_practice_pro_contra \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "arguments": {
      "procedure_code": "ЦПК",
      "query": "орендар не сплачує оренду понад три місяці — підстава для розірвання договору",
      "limit": 10
    }
  }'`} />

        <h3 className="mt-6 text-[14px] font-medium text-claude-text">Стаття закону</h3>
        <CodeBlock lang="bash" code={`curl -X POST ${API_BASE}/get_legislation_section \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"arguments": {"rada_id": "435-15", "article_number": "625"}}'`} />

        <div className="mt-3 text-[12px] text-zinc-400">
          Той самий виклик приймає вільне посилання: <Code>{`{"query": "ст. 625 ЦК"}`}</Code>.
          Історична редакція &mdash; через <Code>as_of_date</Code>.
          Поширені <Code>rada_id</Code>: <Code>254к/96-вр</Code> (Конституція), <Code>435-15</Code> (ЦК),{' '}
          <Code>436-15</Code> (ГК), <Code>2755-17</Code> (ПКУ), <Code>2341-14</Code> (ККУ), <Code>1618-15</Code> (ЦПК)
        </div>

        <h3 className="mt-6 text-[14px] font-medium text-claude-text">Пошук у реєстрі</h3>
        <CodeBlock lang="bash" code={`curl -X POST ${API_BASE}/openreyestr_search_entities \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"arguments": {"query": "Приватбанк", "entityType": "UO", "limit": 5}}'`} />
      </div>

      <div id="example-js" data-section className="mt-10">
        <h2 className="text-[17px] font-semibold text-claude-text">JavaScript / TypeScript</h2>
        <CodeBlock lang="typescript" code={`const response = await fetch('${API_BASE}/search_legal_precedents', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    arguments: {
      query: 'стягнення заборгованості за кредитом',
      limit: 5,
    },
  }),
});

const data = await response.json();
console.log(data.result);`} />
      </div>

      <div id="example-python" data-section className="mt-10">
        <h2 className="text-[17px] font-semibold text-claude-text">Python</h2>
        <CodeBlock lang="python" code={`import requests

response = requests.post(
    '${API_BASE}/search_legal_precedents',
    headers={
        'Authorization': 'Bearer YOUR_API_KEY',
        'Content-Type': 'application/json',
    },
    json={
        'arguments': {
            'query': 'стягнення заборгованості за кредитом',
            'limit': 5,
        }
    }
)

print(response.json()['result'])`} />
      </div>

      <div id="example-sse" data-section className="mt-10">
        <h2 className="text-[17px] font-semibold text-claude-text">SSE Streaming</h2>
        <p className="mt-2 text-[13px] text-claude-subtext leading-relaxed">
          Для тривалих операцій використовуйте SSE endpoint. Відповідь надходить потоком подій.
        </p>
        <CodeBlock lang="typescript" code={`const response = await fetch('${API_BASE}/build_legal_decision/stream', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    arguments: {
      query: 'трудовий спір: звільнення за прогул',
      context: 'Працівника звільнено за п. 4 ч. 1 ст. 40 КЗпП без вимоги письмових пояснень.',
    },
  }),
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value);
  for (const line of chunk.split('\\n')) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));
      console.log(event.type, event.data);
    }
  }
}`} />
      </div>
    </section>
  );
}

/* ================================================================
   SECTION: MCP CLIENTS
   ================================================================ */

function MCPClientsSection() {
  const mcpConfig = `{
  "mcpServers": {
    "secondlayer": {
      "type": "http",
      "url": "${MCP_HTTP_URL}",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}`;

  const mcpConfigSse = `{
  "mcpServers": {
    "secondlayer": {
      "type": "sse",
      "url": "${MCP_SSE_URL}",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}`;

  return (
    <section id="mcp-clients" data-section>
      <h1 className="text-[24px] font-bold text-claude-text tracking-tight">MCP клієнти</h1>
      <p className="mt-2 text-[14px] text-claude-subtext leading-relaxed">
        LEX AI підтримує Streamable HTTP (канонічний транспорт) та SSE для старіших клієнтів.
        Згенеруйте токен у <a href="/profile" className="text-claude-accent hover:underline">Профілі &rarr; MCP Access Tokens</a>.
      </p>
      <p className="mt-2 text-[13px] text-claude-subtext leading-relaxed">
        Через MCP клієнт отримує куратований набір із 28 інструментів: законодавство (6),
        ЄДРСР (9), <Code>search_registry</Code> і державні реєстри OpenReyestr (12).
        Повний набір із {TOOL_COUNTS.total} інструментів &mdash; через REST або <Code>{MCP_FULL_URL}</Code>.
      </p>

      <div id="mcp-claude-code" data-section className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">Claude Code</h2>
        <p className="mt-2 text-[13px] text-claude-subtext">
          Додайте до <Code>~/.claude/settings.json</Code> або <Code>.mcp.json</Code> в корені проєкту:
        </p>
        <CodeBlock lang="json" code={mcpConfig} />
        <p className="mt-2 text-[12px] text-zinc-400">
          Після додавання перезапустіть Claude Code або виконайте <Code>/mcp</Code> для перепідключення.
        </p>
      </div>

      <div id="mcp-claude-desktop" data-section className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">Claude Desktop</h2>
        <p className="mt-2 text-[13px] text-claude-subtext">
          Додайте до <Code>claude_desktop_config.json</Code>:
        </p>
        <CodeBlock lang="json" code={mcpConfig} />
      </div>

      <div id="mcp-cursor" data-section className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">Cursor</h2>
        <p className="mt-2 text-[13px] text-claude-subtext">
          Збережіть як <Code>.cursor/mcp.json</Code> в корені проєкту:
        </p>
        <CodeBlock lang="json" code={mcpConfig} />
      </div>

      <div id="mcp-vscode" data-section className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">VS Code</h2>
        <p className="mt-2 text-[13px] text-claude-subtext">
          Збережіть як <Code>.vscode/mcp.json</Code>. Увімкніть: <Code>chat.mcp.discovery.enabled: true</Code>
        </p>
        <CodeBlock lang="json" code={mcpConfig} />
      </div>

      <div id="mcp-chatgpt" data-section className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">ChatGPT</h2>
        <p className="mt-2 text-[13px] text-claude-subtext leading-relaxed">
          ChatGPT підтримує MCP через SSE транспорт (Plus/Team/Enterprise).
        </p>
        <ol className="mt-3 text-[13px] text-claude-subtext space-y-2 list-decimal list-inside">
          <li>Відкрийте <Code>Settings &rarr; Features &rarr; MCP Servers &rarr; Add</Code></li>
          <li>Server URL: <Code>{MCP_SSE_URL}</Code></li>
          <li>Authorization header: <Code>Bearer YOUR_API_TOKEN</Code></li>
        </ol>
      </div>

      <div id="mcp-continue" data-section className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">Continue.dev</h2>
        <p className="mt-2 text-[13px] text-claude-subtext">
          Збережіть як <Code>.continue/mcpServers/secondlayer.yaml</Code>:
        </p>
        <CodeBlock lang="yaml" code={`name: secondlayer
type: sse
url: ${MCP_SSE_URL}

headers:
  Authorization: "Bearer YOUR_API_TOKEN"`} />
      </div>

      <div className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">Клієнти без Streamable HTTP</h2>
        <p className="mt-2 text-[13px] text-claude-subtext">
          Якщо клієнт не підтримує <Code>type: &quot;http&quot;</Code>, використайте SSE:
        </p>
        <CodeBlock lang="json" code={mcpConfigSse} />
      </div>

      <div className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">Версіонування</h2>
        <table className="mt-3 w-full text-[13px]">
          <thead>
            <tr className="border-b border-claude-border text-left">
              <Th>Ендпоінт</Th>
              <Th>Транспорт</Th>
              <Th>Набір</Th>
              <Th>Статус</Th>
            </tr>
          </thead>
          <tbody className="text-claude-subtext">
            <tr className="border-b border-claude-border/50">
              <Td><Code>{MCP_HTTP_URL}</Code></Td>
              <Td>Streamable HTTP</Td>
              <Td>28</Td>
              <Td>Канонічний</Td>
            </tr>
            <tr className="border-b border-claude-border/50">
              <Td><Code>{MCP_SSE_URL}</Code></Td>
              <Td>SSE</Td>
              <Td>28</Td>
              <Td>Legacy, підтримується</Td>
            </tr>
            <tr className="border-b border-claude-border/50">
              <Td><Code>{MCP_FULL_URL}</Code></Td>
              <Td>Streamable HTTP</Td>
              <Td>{TOOL_COUNTS.total}</Td>
              <Td>Stable</Td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ================================================================
   SECTION: PRICING
   ================================================================ */

function PricingSection() {
  return (
    <section id="pricing" data-section>
      <h1 className="text-[24px] font-bold text-claude-text tracking-tight">Вартість</h1>
      <p className="mt-2 text-[14px] text-claude-subtext leading-relaxed">
        Списується фактична вартість виклику без націнки: токени LLM плюс зовнішні API.
        Більшість інструментів &mdash; це read-only запити до бази й векторного індексу,
        які не викликають LLM взагалі, тому коштують ₴0.
      </p>
      <p className="mt-2 text-[13px] text-claude-subtext leading-relaxed">
        Цифри нижче &mdash; не прайс, а фактичні заміри на проді (медіана та 95-й перцентиль
        по завершених викликах). Перераховано за курсом НБУ {USD_UAH} ₴/$ на 20.08.2026.
        Реальна сума залежить від обсягу тексту у відповіді.
      </p>

      <table className="mt-6 w-full text-[13px]">
        <thead>
          <tr className="border-b border-claude-border text-left">
            <Th>Категорія</Th>
            <Th>Медіана</Th>
            <Th>p95</Th>
            <Th>Приклади</Th>
          </tr>
        </thead>
        <tbody className="text-claude-subtext">
          <tr className="border-b border-claude-border/50 align-top">
            <Td>Без LLM</Td>
            <Td>₴0</Td>
            <Td>₴0</Td>
            <Td>Законодавство, реєстри, <Code>openreyestr_*</Code>, <Code>rada_*</Code>, Vault, <Code>analyze_data</Code></Td>
          </tr>
          <tr className="border-b border-claude-border/50 align-top">
            <Td>Пошук з реранкінгом</Td>
            <Td>₴0–0.15</Td>
            <Td>до ₴1</Td>
            <Td><Code>search_court_decisions</Code>, <Code>search_legislation</Code>, <Code>compare_practice_pro_contra</Code></Td>
          </tr>
          <tr className="border-b border-claude-border/50 align-top">
            <Td>Обробка документів</Td>
            <Td>₴0.2–0.9</Td>
            <Td>до ₴2</Td>
            <Td><Code>summarize_document</Code>, <Code>extract_key_clauses</Code>, <Code>compare_documents</Code>, <Code>generate_dd_report</Code></Td>
          </tr>
          <tr className="border-b border-claude-border/50 align-top">
            <Td>Глибокий аналіз</Td>
            <Td>₴24</Td>
            <Td>до ₴29</Td>
            <Td><Code>build_legal_decision</Code>, <Code>search_legal_precedents</Code> з повним розбором секцій</Td>
          </tr>
        </tbody>
      </table>

      <p className="mt-3 text-[12px] text-zinc-400">
        Вартість конкретного інструмента вказана поруч із його назвою в розділі{' '}
        <a href="#tools" className="text-claude-accent hover:underline">Інструменти</a> &mdash;
        там, де накопичено достатньо викликів для заміру. Відсутність позначки означає,
        що інструмент ще не має репрезентативної статистики, а не що він безкоштовний.
      </p>

      <h2 className="mt-8 text-[17px] font-semibold text-claude-text">Правові документи</h2>
      <div className="mt-3 space-y-1.5 text-[13px]">
        <DocLink href="/ua/developer-offer" label="Оферта розробника" />
        <DocLink href="/en/api-terms" label="API Terms of Use (EN)" />
        <DocLink href="/ua/privacy" label="Політика конфіденційності" />
        <DocLink href="/ua/dpa" label="DPA (обробка даних)" />
      </div>
    </section>
  );
}

/* ================================================================
   SHARED UI PRIMITIVES
   ================================================================ */

function Divider() {
  return <hr className="my-12 border-claude-border" />;
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="pb-2 pr-4 text-[12px] font-semibold text-zinc-400 uppercase tracking-wider">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-2.5 pr-4">{children}</td>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="text-[12px] font-mono bg-claude-bg-secondary text-claude-text px-1.5 py-0.5 rounded">
      {children}
    </code>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-claude-bg-secondary px-5 py-4">
      <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">{label}</div>
      <div className="text-[17px] font-semibold text-claude-text mt-1">{value}</div>
    </div>
  );
}

function ServiceRow({ name, count, description }: { name: string; count: number; description: string }) {
  return (
    <div className="flex items-baseline gap-4 py-2">
      <code className="text-[13px] font-mono font-semibold text-claude-text w-[160px] flex-shrink-0">{name}</code>
      <span className="text-[12px] text-zinc-400 w-[36px] flex-shrink-0">{count}+</span>
      <span className="text-[13px] text-claude-subtext">{description}</span>
    </div>
  );
}

function EndpointTableRow({ method, path, desc }: { method: string; path: string; desc: string }) {
  return (
    <tr className="border-b border-claude-border/50">
      <Td>
        <span className={`text-[11px] font-mono font-semibold ${method === 'GET' ? 'text-green-600' : 'text-claude-accent'}`}>
          {method}
        </span>
      </Td>
      <Td><Code>{path}</Code></Td>
      <Td>{desc}</Td>
    </tr>
  );
}

function DocLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block text-claude-accent hover:underline"
    >
      {label}
    </a>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-3 rounded-lg border border-claude-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-1.5 bg-claude-bg-secondary border-b border-claude-border">
        <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">{lang}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-claude-text transition-colors"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Скопійовано' : 'Копіювати'}
        </button>
      </div>
      <pre className="px-4 py-3.5 bg-claude-bg overflow-x-auto">
        <code className="text-[12.5px] font-mono text-claude-text leading-relaxed whitespace-pre">{code}</code>
      </pre>
    </div>
  );
}
