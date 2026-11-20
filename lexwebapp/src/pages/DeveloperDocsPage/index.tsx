import { useState, useRef, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { useDocumentMeta } from '../../hooks/useDocumentMeta';
import { WebAPIJsonLd } from '../../components/seo/WebAPIJsonLd';

/* ================================================================
   DATA
   ================================================================ */

/**
 * Єдиний публічний ендпоінт для розробників (MCP Streamable HTTP, куратований набір).
 * API-ключі sl_ працюють лише тут: REST /api/tools/* та інші транспорти повертають
 * 403 API_KEY_V2_ONLY (mcp_backend/src/middleware/client-key-guard.ts).
 * Канонічний перелік інструментів — tools/list цього ендпоінта.
 */
const MCP_HTTP_URL = 'https://mcp.legal.org.ua/api/v2/mcp';

/** Повний цикл MCP-сесії curl-ом: initialize → notifications/initialized → tools/list → tools/call. */
const QUICKSTART_CURL = `KEY=sl_YOUR_API_KEY
URL=${MCP_HTTP_URL}

# 1. initialize: id сесії приходить у заголовку відповіді Mcp-Session-Id
SID=$(curl -s -D - -o /dev/null "$URL" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-app","version":"1.0"}}}' \\
  | awk 'tolower($1)=="mcp-session-id:" {print $2}' | tr -d '\\r')

# допоміжна функція: POST у відкриту сесію
mcp() {
  curl -s "$URL" \\
    -H "Authorization: Bearer $KEY" \\
    -H "Mcp-Session-Id: $SID" \\
    -H "Content-Type: application/json" \\
    -H "Accept: application/json, text/event-stream" \\
    -d "$1"
}

# 2. підтвердити ініціалізацію
mcp '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. перелік доступних інструментів зі схемами параметрів
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 4. виклик інструмента: ст. 625 Цивільного кодексу
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_legislation_section","arguments":{"rada_id":"435-15","article_number":"625"}}}'`;

/** Курс НБУ на 14.11.2026, за яким перераховані гривневі суми нижче. */
const USD_UAH = '45,43';

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
      { name: 'search_court_decisions', description: 'Єдиний пошук у ЄДРСР (136M+ документів). Режими: structured (метадані), fulltext (FTS), hybrid (FTS+семантика), semantic', params: [{ name: 'mode', required: true }, { name: 'query' }, { name: 'party_name' }, { name: 'party_role' }, { name: 'cause_num' }, { name: 'judge' }, { name: 'court_code' }, { name: 'court_name' }, { name: 'justice_kind' }, { name: 'judgment_code' }, { name: 'category_code' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'instance_code' }, { name: 'court_level' }, { name: 'military_preset' }, { name: 'kupap_preset' }, { name: 'include_fulltext' }, { name: 'limit' }, { name: 'offset' }, { name: 'oversample' }, { name: 'rrf_k' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'find_similar_fact_pattern_cases', description: 'Справи зі схожою фабулою: семантичний пошук за описом фактичних обставин', params: [{ name: 'procedure_code', required: true }, { name: 'facts_text', required: true }, { name: 'court_level' }, { name: 'time_range' }, { name: 'limit' }], cost: '₴3.00 · до ₴4.50' },
      { name: 'compare_practice_pro_contra', description: 'Дві лінії практики за правовою тезою — рішення «за» і рішення «проти»', params: [{ name: 'procedure_code', required: true }, { name: 'query', required: true }, { name: 'court_level' }, { name: 'time_range' }, { name: 'limit' }], cost: '₴5.00 · до ₴7.50' },
    ],
  },
  {
    title: 'Документи справ',
    tools: [
      { name: 'get_court_decision', description: 'Повний текст рішення з розбивкою на секції: ФАКТИ, МОТИВУВАННЯ, РІШЕННЯ', params: [{ name: 'doc_id' }, { name: 'case_number' }, { name: 'depth' }, { name: 'reasoning_budget' }, { name: 'include_citations' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'edrsr_get_decision_dispositive', description: 'Лише резолютивна частина: ВИРІШИВ / УХВАЛИВ / ПОСТАНОВИВ / ВИРОК, 2–8 КБ замість повного тексту', params: [{ name: 'doc_id', required: true }], cost: '₴0.25 · до ₴0.38' },
      { name: 'get_decision_cited_norms', description: 'Норми законодавства, на які фактично посилається рішення (граф цитувань)', params: [{ name: 'doc_id', required: true }], cost: '₴0.25 · до ₴0.38' },
      { name: 'get_case_documents_chain', description: 'Усі документи справи через усі інстанції — перша, апеляція, касація', params: [{ name: 'case_number', required: true }, { name: 'include_full_text' }, { name: 'max_docs' }, { name: 'group_by_instance' }, { name: 'sort' }, { name: 'offset' }, { name: 'document_types' }], cost: '₴0.75 · до ₴1.12' },
      { name: 'load_full_texts', description: 'Пакетне завантаження повних текстів рішень за масивом doc_id', params: [{ name: 'doc_ids', required: true }, { name: 'max_docs' }, { name: 'batch_size' }, { name: 'return_texts' }, { name: 'snippet_chars' }], cost: '₴1.00 · до ₴1.50' },
    ],
  },
  {
    title: 'Аналіз практики',
    tools: [
      { name: 'count_cases_by_party', description: 'Точна кількість справ за назвою сторони (позивач/відповідач)', params: [{ name: 'party_name', required: true }, { name: 'party_type' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'return_cases' }, { name: 'max_cases_to_return' }], cost: '₴4.00 · до ₴6.00' },
      { name: 'check_precedent_status', description: 'Чи не скасовано рішення вищою інстанцією', params: [{ name: 'case_id' }, { name: 'case_number' }, { name: 'doc_id' }], cost: '₴1.50 · до ₴2.25' },
      { name: 'get_citation_graph', description: 'Граф цитувань: статті законів у рішенні, хто цитує справу і кого цитує вона', params: [{ name: 'case_id', required: true }, { name: 'direction' }, { name: 'limit' }, { name: 'depth' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'search_court_case_status', description: 'Статус судової справи за номером, суддею або судом', params: [{ name: 'case_number' }, { name: 'judge' }, { name: 'description' }, { name: 'court_name' }, { name: 'limit' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'search_case_status_by_party', description: 'Справи за стороною (ПІБ або назва юрособи): стадії розгляду, судді, засідання', params: [{ name: 'party', required: true }, { name: 'region' }, { name: 'court_name' }, { name: 'case_number' }, { name: 'proceeding_number' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'include_sessions' }, { name: 'limit' }, { name: 'offset' }], cost: '₴3.63 · до ₴5.45' },
      { name: 'get_case_status_details', description: 'Картка справи: усі стадії розгляду, сторони, судді, засідання', params: [{ name: 'case_number', required: true }, { name: 'court_name' }], cost: '₴1.00 · до ₴1.50' },
    ],
  },
  {
    title: 'Законодавство',
    tools: [
      { name: 'get_legislation_section', description: 'Стаття за посиланням («ст. 625 ЦК») або за rada_id + article_number, з історичною редакцією на дату', params: [{ name: 'query' }, { name: 'rada_id' }, { name: 'article_number' }, { name: 'as_of_date' }, { name: 'include_html' }, { name: 'theme' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'get_legislation_articles', description: 'Кілька статей одного акту за один виклик (напр. 354–356 ЦПК)', params: [{ name: 'rada_id', required: true }, { name: 'article_numbers', required: true }, { name: 'as_of_date' }, { name: 'include_html' }, { name: 'theme' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'search_legislation', description: 'Семантичний пошук релевантних статей законодавства за описом ситуації', params: [{ name: 'query', required: true }, { name: 'rada_id' }, { name: 'limit' }, { name: 'include_html' }, { name: 'include_court_practice' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'get_legislation_structure', description: 'Структура акту: розділи, глави, параграфи з лічильником статей', params: [{ name: 'rada_id', required: true }, { name: 'include_articles' }, { name: 'offset' }, { name: 'limit' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'get_legislation_history', description: 'Історія редакцій акту: які статті змінювались і коли', params: [{ name: 'rada_id', required: true }, { name: 'article_number' }], cost: '₴0.50 · до ₴0.75' },
      { name: 'list_legislation_editions', description: 'Перелік доступних історичних редакцій акту з датами', params: [{ name: 'rada_id', required: true }], cost: '₴0.50 · до ₴0.75' },
    ],
  },
  {
    title: 'НПА та правові акти',
    tools: [
      { name: 'search_npa', description: 'Повний корпус НПА України (293K актів): закони, підзаконні акти, редакції', params: [{ name: 'query' }, { name: 'title' }, { name: 'status' }, { name: 'doc_type' }, { name: 'as_of_date' }, { name: 'limit' }], cost: '₴0.50 · до ₴0.75' },
      { name: 'get_npa_act', description: 'Картка акта НПА за nreg: метадані, редакції, текст, окрема стаття', params: [{ name: 'nreg', required: true }, { name: 'mode' }, { name: 'article_number' }, { name: 'as_of_date' }, { name: 'offset' }, { name: 'limit' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'search_edrnpa', description: 'Реєстр нормативно-правових актів ЄДРНПА (141K записів)', params: [{ name: 'name' }, { name: 'number' }, { name: 'publisher' }, { name: 'doc_type' }, { name: 'keywords' }, { name: 'include_text' }, { name: 'limit' }], cost: '₴0.25 · до ₴0.38' },
    ],
  },
  {
    title: 'Процесуальні інструменти',
    tools: [
      { name: 'search_court_hearing_schedule', description: 'Розклад судових засідань: дата, час, зал, учасники', params: [{ name: 'query' }, { name: 'source' }, { name: 'target' }, { name: 'case_number' }, { name: 'judge' }, { name: 'participant' }, { name: 'court_name' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'limit' }], cost: '₴0.50 · до ₴0.75' },
    ],
  },
  {
    title: 'Інтелектуальна власність',
    tools: [
      { name: 'search_ip_objects', description: 'Реєстр об’єктів права інтелектуальної власності: ТМ, патенти, промзразки', params: [{ name: 'query' }, { name: 'obj_type' }, { name: 'obj_state' }, { name: 'classes' }, { name: 'owner' }, { name: 'owner_edrpou' }, { name: 'limit' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'find_similar_trademarks', description: 'Тотожні та схожі ТМ у тих самих класах — перевірка на «зіткнення»', params: [{ name: 'app_number' }, { name: 'query' }, { name: 'classes' }, { name: 'obj_state' }, { name: 'min_similarity' }, { name: 'limit' }], cost: '₴3.00 · до ₴4.50' },
      { name: 'get_ip_object', description: 'Картка об’єкта ІВ за номером заявки або реєстрації', params: [{ name: 'app_number' }, { name: 'registration_number' }, { name: 'obj_type' }], cost: '₴0.50 · до ₴0.75' },
      { name: 'get_trademark_dossier', description: 'Повне досьє ТМ за одним номером: заявка, діловодство, публікації', params: [{ name: 'number', required: true }], cost: '₴8.00 · до ₴12.00' },
    ],
  },
  {
    title: 'Відкриті дані та реєстри',
    tools: [
      { name: 'search_registry', description: 'Єдиний вхід у 37 реєстрів відкритих даних: санкції, адвокати, корупціонери, банки НБУ, фінзвітність та ін.', params: [{ name: 'registry', required: true }, { name: 'filters' }, { name: 'aggregate' }, { name: 'limit' }], cost: '₴0.50 · до ₴0.75' },
      { name: 'search_judges', description: 'Реєстр суддів ВККС: 6K чинних плюс 417K історичних записів', params: [{ name: 'full_name' }, { name: 'court_name' }, { name: 'dossier_number' }, { name: 'gender' }, { name: 'include_history' }, { name: 'limit' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'search_vkks', description: 'Дані ВККС у 5 категоріях: judges, evaluations, declarations, vacancies, efficiency', params: [{ name: 'category', required: true }, { name: 'judge_name' }, { name: 'court_name' }, { name: 'year' }, { name: 'region' }, { name: 'court_level' }, { name: 'dossier_number' }, { name: 'limit' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'search_vrp_judges_discipline', description: 'Дисциплінарні дані суддів ВРП: звільнені, відсторонені, втручання', params: [{ name: 'judge_name' }, { name: 'court_name' }, { name: 'type' }, { name: 'limit' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'search_public_spending', description: 'Публічні витрати spending.gov.ua: 12.6M+ записів (таймаут 120с)', params: [{ name: 'edrpou' }, { name: 'contractor_name' }, { name: 'contractor_edrpou' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'min_amount' }, { name: 'max_amount' }, { name: 'doc_type' }, { name: 'limit' }], cost: '₴0.75 · до ₴1.12' },
      { name: 'search_invalid_passports', description: 'Недійсні паспорти МВС: 2.9M внутрішніх документів', params: [{ name: 'd_series' }, { name: 'd_number' }, { name: 'ovd' }, { name: 'd_status' }, { name: 'include_foreign' }, { name: 'limit' }], cost: '₴0.50 · до ₴0.75' },
      { name: 'search_amcu_practice', description: 'Семантичний пошук по рішеннях Антимонопольного комітету', params: [{ name: 'query', required: true }, { name: 'date_from' }, { name: 'date_to' }, { name: 'limit' }], cost: '₴0.75 · до ₴1.12' },
    ],
  },
  {
    title: 'Верховна Рада',
    tools: [
      { name: 'rada_search_parliament_bills', description: 'Законопроєкти Верховної Ради з семантичним аналізом', params: [{ name: 'query', required: true }, { name: 'status' }, { name: 'initiator' }, { name: 'committee' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'limit' }], cost: '₴0.30 · до ₴0.45' },
      { name: 'rada_search_bill_documents', description: 'Супровідні документи законопроєктів: висновки ГНЕУ, комітетів, порівняльні таблиці', params: [{ name: 'query' }, { name: 'bill_number' }, { name: 'doc_kind' }, { name: 'convocation' }, { name: 'initiator' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'limit' }], cost: '₴0.40 · до ₴0.60' },
      { name: 'rada_get_deputy_info', description: 'Дані народного депутата: фракція, помічники, історія голосувань', params: [{ name: 'name' }, { name: 'rada_id' }, { name: 'faction' }, { name: 'include_voting_record' }, { name: 'include_assistants' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'rada_analyze_voting_record', description: 'Аналіз голосувань депутата з AI-інсайтами', params: [{ name: 'deputy_name', required: true }, { name: 'date_from' }, { name: 'date_to' }, { name: 'bill_number' }, { name: 'analyze_patterns' }], cost: '₴0.50 · до ₴0.75' },
    ],
  },
  {
    title: 'Державні реєстри (OpenReyestr)',
    tools: [
      { name: 'openreyestr_search_entities', description: 'Юридичні особи та ФОП у ЄДР', params: [{ name: 'query' }, { name: 'edrpou' }, { name: 'record' }, { name: 'entityType' }, { name: 'stan' }, { name: 'limit' }, { name: 'offset' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'openreyestr_get_entity_details', description: 'Повна картка суб’єкта: засновники, бенефіціари, керівники', params: [{ name: 'record', required: true }, { name: 'entityType' }], cost: '₴0.75 · до ₴1.12' },
      { name: 'get_company_dossier', description: 'Досьє компанії за ЄДРПОУ: ЄДР, санкції, борги, ProZorro, ЄДЕССБ, суди; джерело й дата на кожен розділ', params: [{ name: 'edrpou', required: true }], cost: '₴8.00 · до ₴12.00' },
      { name: 'get_financial_statements', description: 'Фінансова звітність за ЄДРПОУ: активи, капітал, зобов’язання, дохід і прибуток за роками (Ф1/Ф2, 1-м, 1-мс), тис. грн; джерело й дата подання на кожен звіт', params: [{ name: 'edrpou', required: true }, { name: 'year_from' }, { name: 'year_to' }, { name: 'include_interim' }], cost: '₴2.00 · до ₴3.00' },
      { name: 'openreyestr_get_by_edrpou', description: 'Швидкий пошук суб’єкта за кодом ЄДРПОУ', params: [{ name: 'edrpou', required: true }], cost: '₴0.50 · до ₴0.75' },
      { name: 'openreyestr_search_beneficiaries', description: 'Кінцеві бенефіціарні власники компаній', params: [{ name: 'query', required: true }, { name: 'limit' }], cost: '₴1.50 · до ₴2.25' },
      { name: 'openreyestr_search_founders', description: 'Зворотний пошук за засновниками, зокрема іноземними: країна, частка, юрособа', params: [{ name: 'query' }, { name: 'country' }, { name: 'foreign_only' }, { name: 'entity_type' }, { name: 'limit' }, { name: 'offset' }], cost: '₴1.50 · до ₴2.25' },
      { name: 'openreyestr_company_as_of', description: 'Юрособа станом на дату за знімками ЄДР (2016–2021, щотижнево з 2026): назва, стан, адреса, керівники, засновники; дата знімка і джерело', params: [{ name: 'edrpou', required: true }, { name: 'date', required: true }], cost: '₴2.00 · до ₴3.00' },
      { name: 'openreyestr_company_history', description: 'Історія змін юрособи за знімками ЄДР: кожне значення з першим і останнім знімком', params: [{ name: 'edrpou', required: true }], cost: '₴2.00 · до ₴3.00' },
      { name: 'openreyestr_search_founders_history', description: 'Засновники, зокрема колишні: пошук латиницею чи кирилицею, за країною або кодом ЄДРПОУ засновника', params: [{ name: 'query' }, { name: 'code' }, { name: 'country' }, { name: 'current_only' }, { name: 'limit' }], cost: '₴2.50 · до ₴3.75' },
      { name: 'openreyestr_search_beneficiaries_history', description: 'Кінцеві бенефіціари, зокрема колишні: пошук латиницею чи кирилицею, за країною', params: [{ name: 'query' }, { name: 'country' }, { name: 'current_only' }, { name: 'limit' }], cost: '₴2.50 · до ₴3.75' },
      { name: 'openreyestr_search_termination_started', description: 'Юрособи, щодо яких розпочато процедуру припинення', params: [{ name: 'query', required: true }, { name: 'entity_type' }, { name: 'signer_name' }, { name: 'reason' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'openreyestr_get_statistics', description: 'Агрегована статистика по ЄДР', cost: '₴0.01 · до ₴0.01' },
      { name: 'openreyestr_search_debtors', description: 'Єдиний реєстр боржників', params: [{ name: 'query' }, { name: 'edrpou' }, { name: 'collection_category' }, { name: 'limit' }, { name: 'offset' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'openreyestr_search_enforcement_proceedings', description: 'Виконавчі провадження', params: [{ name: 'query' }, { name: 'debtor_edrpou' }, { name: 'creditor_name' }, { name: 'proceeding_status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'openreyestr_search_bankruptcy_cases', description: 'Справи про банкрутство', params: [{ name: 'query' }, { name: 'debtor_edrpou' }, { name: 'case_number' }, { name: 'proceeding_status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'openreyestr_search_arma_seized_assets', description: 'Реєстр АРМА: активи під арештом у кримінальних провадженнях', params: [{ name: 'owner_name' }, { name: 'owner_edrpou' }, { name: 'case_number' }, { name: 'asset_type' }, { name: 'status' }, { name: 'court_name' }, { name: 'region' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0.50 · до ₴0.75' },
      { name: 'openreyestr_search_rnbo_sanctions', description: 'Санкційні списки РНБО', params: [{ name: 'query', required: true }, { name: 'schema_type' }, { name: 'country' }, { name: 'identifier' }, { name: 'limit' }, { name: 'offset' }], cost: '₴2.50 · до ₴3.75' },
      { name: 'openreyestr_search_nazk_declarations', description: 'Декларації НАЗК', params: [{ name: 'declarant_name' }, { name: 'declarant_workplace' }, { name: 'declaration_year' }, { name: 'declaration_type' }, { name: 'declarant_region' }, { name: 'min_income' }, { name: 'limit' }, { name: 'offset' }], cost: '₴2.00 · до ₴3.00' },
      { name: 'openreyestr_search_prozorro', description: 'Тендери ProZorro з переможцями', params: [{ name: 'query' }, { name: 'buyer_edrpou' }, { name: 'buyer_name' }, { name: 'supplier_edrpou' }, { name: 'supplier_name' }, { name: 'supplier_phone' }, { name: 'supplier_email' }, { name: 'status' }, { name: 'cpv_code' }, { name: 'date_from' }, { name: 'date_to' }, { name: 'limit' }, { name: 'offset' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'openreyestr_search_single_tax_payers', description: 'Реєстр платників єдиного податку (ДПС)', params: [{ name: 'query' }, { name: 'tin' }, { name: 'tax_group' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'openreyestr_search_tax_debt', description: 'Реєстр податкового боргу (ДПС)', params: [{ name: 'query' }, { name: 'tin' }, { name: 'limit' }, { name: 'offset' }], cost: '₴1.00 · до ₴1.50' },
      { name: 'openreyestr_search_esv_debt', description: 'Реєстр боргу зі сплати ЄСВ', params: [{ name: 'query' }, { name: 'tin' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0.50 · до ₴0.75' },
      { name: 'openreyestr_search_notaries', description: 'Єдиний реєстр нотаріусів', params: [{ name: 'query' }, { name: 'region' }, { name: 'status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'openreyestr_search_arbitration_managers', description: 'Арбітражні керуючі (банкрутство)', params: [{ name: 'query' }, { name: 'status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0.25 · до ₴0.38' },
      { name: 'openreyestr_search_special_forms', description: 'Спеціальні бланки нотаріальних документів', params: [{ name: 'series' }, { name: 'form_number' }, { name: 'recipient' }, { name: 'status' }, { name: 'limit' }, { name: 'offset' }], cost: '₴0.25 · до ₴0.38' },
    ],
  },
];

/**
 * Каталог вище — українська частина V2_TOOL_NAMES (mcp_backend/src/api/curated-mcp-tools.ts),
 * звірено 20.11.2026. Лічильники рахуються з нього, а не хардкодяться.
 */
const ALL_TOOLS = toolGroups.flatMap(g => g.tools);
const TOOL_COUNTS = {
  total: ALL_TOOLS.length,
  rada: ALL_TOOLS.filter(t => t.name.startsWith('rada_')).length,
  openreyestr: ALL_TOOLS.filter(t => t.name.startsWith('openreyestr_')).length,
  backend: ALL_TOOLS.filter(t => !t.name.startsWith('rada_') && !t.name.startsWith('openreyestr_')).length,
};

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
    description: `Підключіть Claude Desktop, Cursor, VS Code або ChatGPT до MCP сервера LEX AI (mcp.legal.org.ua). ${TOOL_COUNTS.total} інструментів: 136M+ судових рішень ЄДРСР, законодавство, державні реєстри, відкриті дані, інтелектуальна власність. MCP Streamable HTTP, API-ключ або OAuth.`,
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
        description={`MCP сервер для юридичного аналізу: ${TOOL_COUNTS.total} інструментів — судова практика (136M+ документів ЄДРСР), законодавство, державні реєстри, відкриті дані, інтелектуальна власність. Підключається через MCP Streamable HTTP до Claude Desktop, Cursor, VS Code, ChatGPT.`}
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
        Доступ до {TOOL_COUNTS.total} інструментів юридичного аналізу через MCP-сервер{' '}
        <Code>{MCP_HTTP_URL}</Code>. Судова практика, законодавство, державні реєстри, відкриті
        дані, парламентські дані, інтелектуальна власність.
      </p>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-px bg-claude-border rounded-xl overflow-hidden border border-claude-border">
        <InfoCell label="Інструменти" value={String(TOOL_COUNTS.total)} />
        <InfoCell label="Мікросервіси" value="3" />
        <InfoCell label="Транспорт" value="MCP Streamable HTTP" />
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
        </tbody>
      </table>
      <p className="mt-2 text-[12px] text-zinc-400">Станом на 20.08.2026.</p>

      <h2 className="mt-10 text-[20px] font-semibold text-claude-text">Сервіси</h2>

      <div className="mt-4 space-y-3">
        <ServiceRow name="mcp_backend" count={TOOL_COUNTS.backend} description="Судова практика, законодавство, НПА, ІВ, відкриті дані, досьє компанії" />
        <ServiceRow name="mcp_rada" count={TOOL_COUNTS.rada} description="Законопроєкти, супровідні документи, депутати, голосування, тексти законів" />
        <ServiceRow name="mcp_openreyestr" count={TOOL_COUNTS.openreyestr} description="Юридичні особи, ФОП, бенефіціари, боржники, ProZorro, податки, АРМА, НАЗК, санкції" />
      </div>

      <h2 className="mt-10 text-[20px] font-semibold text-claude-text">Транспорт</h2>
      <p className="mt-3 text-[14px] text-claude-subtext leading-relaxed">
        Єдиний публічний ендпоінт &mdash; <Code>{MCP_HTTP_URL}</Code>, протокол{' '}
        <a href="https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http" target="_blank" rel="noopener noreferrer" className="text-claude-accent hover:underline">MCP Streamable HTTP</a>{' '}
        (JSON-RPC 2.0). Підходить і для MCP-клієнтів (Claude, Cursor, VS Code, ChatGPT), і для
        власного коду: через офіційні SDK або напряму HTTP-запитами.
      </p>
      <div className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700/50 px-4 py-3 text-[13px] text-claude-text">
        REST-шлях <Code>/api/tools/:toolName</Code> обслуговує лише вебзастосунок. API-ключ на ньому
        (як і на будь-якому іншому шляху, крім <Code>/api/v2/mcp</Code>) отримує{' '}
        <Code>403 API_KEY_V2_ONLY</Code>.
      </div>
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
          Згенеруйте API-ключ (<Code>sl_…</Code>) у розділі <strong>Профіль &rarr; API токени</strong>{' '}
          і передавайте його в кожному запиті до <Code>{MCP_HTTP_URL}</Code>:
        </p>

        <CodeBlock lang="http" code={`Authorization: Bearer sl_YOUR_API_KEY`} />

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
              <Td>API-ключ (Bearer)</Td>
              <Td>Скрипти, серверні інтеграції, MCP-клієнти з налаштуванням заголовків</Td>
            </tr>
            <tr className="border-b border-claude-border/50">
              <Td>OAuth 2.1</Td>
              <Td>MCP-клієнти з інтерактивним входом (ChatGPT, Claude): клієнт сам відкриває вхід в акаунт LEX AI</Td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-[13px] text-claude-subtext leading-relaxed">
          API-ключ дійсний лише на <Code>/api/v2/mcp</Code>. Запит із ключем на будь-який інший шлях
          (зокрема REST <Code>/api/tools/*</Code>) отримує <Code>403</Code> з кодом{' '}
          <Code>API_KEY_V2_ONLY</Code>.
        </p>

        <h3 className="mt-6 text-[15px] font-semibold text-claude-text">Ліміти</h3>
        <div className="mt-3 text-[13px] text-claude-subtext space-y-1">
          <p>Ліміти викликів на хвилину та на день задаються для кожного ключа; кожен виклик списується з балансу акаунта.</p>
          <p>Максимальний розмір тіла запиту: <Code>10 MB</Code></p>
          <p>
            Timeout інструмента: <Code>60 с</Code> за замовчуванням. Важкі інструменти мають
            власний ліміт: <Code>120 с</Code> для <Code>search_court_decisions</Code>,{' '}
            <Code>get_case_documents_chain</Code>, <Code>compare_practice_pro_contra</Code>,{' '}
            <Code>find_similar_fact_pattern_cases</Code>, <Code>search_public_spending</Code>.
          </p>
          <p>
            Сесія MCP живе в пам’яті сервера. Якщо запит із <Code>Mcp-Session-Id</Code> повернув{' '}
            <Code>400</Code> (сесію втрачено, наприклад після оновлення сервера), просто повторіть{' '}
            <Code>initialize</Code>. Офіційні SDK роблять це самі.
          </p>
        </div>
      </div>

      {/* Endpoints */}
      <div id="endpoints" data-section className="mt-10">
        <h2 className="text-[20px] font-semibold text-claude-text">Ендпоінти</h2>
        <p className="mt-2 text-[13px] text-claude-subtext">
          Хост: <Code>https://mcp.legal.org.ua</Code>
        </p>

        <table className="mt-4 w-full text-[13px]">
          <thead>
            <tr className="border-b border-claude-border text-left">
              <Th>Метод</Th>
              <Th>Шлях</Th>
              <Th>Опис</Th>
            </tr>
          </thead>
          <tbody className="text-claude-subtext">
            <EndpointTableRow method="POST" path="/api/v2/mcp" desc="JSON-RPC: initialize, tools/list, tools/call. Перший запит — initialize без Mcp-Session-Id; id сесії повертається в заголовку відповіді Mcp-Session-Id" />
            <EndpointTableRow method="GET" path="/api/v2/mcp" desc="SSE-потік серверних повідомлень для відкритої сесії (заголовок Mcp-Session-Id)" />
            <EndpointTableRow method="DELETE" path="/api/v2/mcp" desc="Закрити сесію" />
          </tbody>
        </table>
        <p className="mt-3 text-[13px] text-claude-subtext leading-relaxed">
          Кожен POST має містити заголовки <Code>Content-Type: application/json</Code> та{' '}
          <Code>Accept: application/json, text/event-stream</Code>. Відповідь приходить як SSE:
          рядок <Code>data: {'{…}'}</Code> із JSON-RPC-відповіддю.
        </p>
      </div>

      {/* Quick Start */}
      <div id="quick-start" data-section className="mt-10">
        <h2 className="text-[20px] font-semibold text-claude-text">Швидкий старт</h2>
        <p className="mt-2 text-[14px] text-claude-subtext leading-relaxed">
          Найпростіше &mdash; підключити ключ до MCP-клієнта (див.{' '}
          <a href="#mcp-clients" className="text-claude-accent hover:underline">MCP клієнти</a>). Напряму з
          терміналу повний цикл виглядає так:
        </p>
        <CodeBlock lang="bash" code={QUICKSTART_CURL} />
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
        Інструменти викликаються методом <Code>tools/call</Code> з{' '}
        <Code>{`{"name": "…", "arguments": {…}}`}</Code>.
        Зірочка <span className="text-claude-accent">*</span> позначає обов’язковий параметр.
      </p>
      <p className="mt-2 text-[13px] text-claude-subtext leading-relaxed">
        Канонічне джерело &mdash; <Code>tools/list</Code>: повертає актуальні імена, описи та JSON-схеми
        параметрів. Список нижче звірено з ним 20.11.2026. Вартість &mdash; див. розділ{' '}
        <a href="#pricing" className="text-claude-accent hover:underline">Вартість</a>.
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
      <p className="mt-2 text-[14px] text-claude-subtext leading-relaxed">
        Для власного коду найзручніше брати офіційні MCP SDK: вони самі відкривають сесію,
        передають <Code>Mcp-Session-Id</Code> і розбирають SSE-відповіді.
      </p>

      <div id="example-js" data-section className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">JavaScript / TypeScript</h2>
        <CodeBlock lang="bash" code={`npm install @modelcontextprotocol/sdk`} />
        <CodeBlock lang="typescript" code={`import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('${MCP_HTTP_URL}'),
  { requestInit: { headers: { Authorization: 'Bearer sl_YOUR_API_KEY' } } },
);
const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(tools.map(t => t.name));

const result = await client.callTool({
  name: 'search_court_decisions',
  arguments: {
    mode: 'hybrid',
    query: 'стягнення заборгованості за кредитом',
    limit: 5,
  },
});
console.log(result.content);

await client.close();`} />
      </div>

      <div id="example-python" data-section className="mt-10">
        <h2 className="text-[17px] font-semibold text-claude-text">Python</h2>
        <CodeBlock lang="bash" code={`pip install mcp`} />
        <CodeBlock lang="python" code={`import asyncio
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = '${MCP_HTTP_URL}'
HEADERS = {'Authorization': 'Bearer sl_YOUR_API_KEY'}

async def main():
    async with streamablehttp_client(URL, headers=HEADERS) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            print([t.name for t in tools.tools])

            result = await session.call_tool(
                'get_npa_act',
                {'nreg': '435-15', 'mode': 'article', 'article_number': '625'},
            )
            for block in result.content:
                print(block.text)

asyncio.run(main())`} />
      </div>

      <div id="example-curl" data-section className="mt-10">
        <h2 className="text-[17px] font-semibold text-claude-text">cURL</h2>
        <p className="mt-2 text-[13px] text-claude-subtext leading-relaxed">
          Спершу відкрийте сесію і визначте функцію <Code>mcp</Code>, як у розділі{' '}
          <a href="#quick-start" className="text-claude-accent hover:underline">Швидкий старт</a>.
          Далі кожен виклик &mdash; один рядок.
        </p>

        <h3 className="mt-4 text-[14px] font-medium text-claude-text">Пошук судових рішень</h3>
        <CodeBlock lang="bash" code={`mcp '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"search_court_decisions","arguments":{
  "mode": "hybrid",
  "query": "відшкодування моральної шкоди при ДТП",
  "date_from": "2023-01-01",
  "date_to": "2024-12-31",
  "limit": 10
}}}'`} />

        <h3 className="mt-6 text-[14px] font-medium text-claude-text">Практика «за» і «проти»</h3>
        <CodeBlock lang="bash" code={`mcp '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"compare_practice_pro_contra","arguments":{
  "procedure_code": "ЦПК",
  "query": "орендар не сплачує оренду понад три місяці — підстава для розірвання договору",
  "limit": 10
}}}'`} />

        <h3 className="mt-6 text-[14px] font-medium text-claude-text">Стаття закону</h3>
        <CodeBlock lang="bash" code={`mcp '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"get_legislation_section","arguments":{"rada_id":"435-15","article_number":"625"}}}'`} />

        <div className="mt-3 text-[12px] text-zinc-400">
          Той самий виклик приймає вільне посилання: <Code>{`{"query": "ст. 625 ЦК"}`}</Code>.
          Історична редакція &mdash; через <Code>as_of_date</Code>.
          Поширені <Code>rada_id</Code>: <Code>254к/96-вр</Code> (Конституція), <Code>435-15</Code> (ЦК),{' '}
          <Code>436-15</Code> (ГК), <Code>2755-17</Code> (ПКУ), <Code>2341-14</Code> (ККУ), <Code>1618-15</Code> (ЦПК)
        </div>

        <h3 className="mt-6 text-[14px] font-medium text-claude-text">Пошук у реєстрі</h3>
        <CodeBlock lang="bash" code={`mcp '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"openreyestr_search_entities","arguments":{"query":"Приватбанк","entityType":"UO","limit":5}}}'`} />

        <p className="mt-4 text-[13px] text-claude-subtext leading-relaxed">
          Відповідь &mdash; SSE-подія; корисне навантаження в полі <Code>result.content</Code> рядка{' '}
          <Code>data:</Code>. Витягти текст можна так:{' '}
          <Code>{`mcp '…' | sed -n 's/^data: //p' | jq -r '.result.content[].text'`}</Code>
        </p>
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

  return (
    <section id="mcp-clients" data-section>
      <h1 className="text-[24px] font-bold text-claude-text tracking-tight">MCP клієнти</h1>
      <p className="mt-2 text-[14px] text-claude-subtext leading-relaxed">
        Єдиний MCP-ендпоінт &mdash; <Code>{MCP_HTTP_URL}</Code> (Streamable HTTP).
        Згенеруйте токен у <a href="/profile" className="text-claude-accent hover:underline">Профілі &rarr; MCP Access Tokens</a>.
      </p>
      <p className="mt-2 text-[13px] text-claude-subtext leading-relaxed">
        Через MCP клієнт отримує куратований набір інструментів: законодавство і повний корпус
        НПА, судова практика ЄДРСР, <Code>search_registry</Code> та державні реєстри OpenReyestr,
        відкриті дані, інтелектуальна власність, парламентські дані. Актуальний перелік повертає
        сам ендпоінт (<Code>tools/list</Code>).
      </p>

      <div id="mcp-claude-code" data-section className="mt-8">
        <h2 className="text-[17px] font-semibold text-claude-text">Claude Code</h2>
        <p className="mt-2 text-[13px] text-claude-subtext">
          Одна команда в терміналі:
        </p>
        <CodeBlock lang="bash" code={`claude mcp add --transport http secondlayer \\
  ${MCP_HTTP_URL} \\
  --header "Authorization: Bearer YOUR_API_TOKEN"`} />
        <p className="mt-2 text-[13px] text-claude-subtext">
          Або збережіть як <Code>.mcp.json</Code> в корені проєкту:
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
          ChatGPT підтримує MCP-конектори у платних планах (Plus/Team/Enterprise).
        </p>
        <ol className="mt-3 text-[13px] text-claude-subtext space-y-2 list-decimal list-inside">
          <li>Відкрийте <Code>Settings &rarr; Connectors &rarr; Add</Code></li>
          <li>Server URL: <Code>{MCP_HTTP_URL}</Code></li>
          <li>Authorization header: <Code>Bearer YOUR_API_TOKEN</Code></li>
        </ol>
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
        Кожен виклик коштує щонайменше ціну інструмента за прайсом; якщо фактична вартість
        (токени LLM, зовнішні API) більша, списується вона. Зверху додається націнка тарифу:
        Free 0%, Startup 30%, Enterprise 40%, Business 50%.
      </p>
      <p className="mt-2 text-[13px] text-claude-subtext leading-relaxed">
        У списку інструментів перше число &mdash; ціна за прайсом без націнки, друге &mdash; з
        найбільшою націнкою (Business). Для інструментів без ціни в прайсі (аналітика з LLM)
        наведено фактичні заміри на проді. Перераховано за курсом НБУ {USD_UAH} ₴/$ на
        20.11.2026; списання з балансу йде за курсом НБУ на день поповнення.
      </p>

      <table className="mt-6 w-full text-[13px]">
        <thead>
          <tr className="border-b border-claude-border text-left">
            <Th>Категорія</Th>
            <Th>За прайсом</Th>
            <Th>З націнкою</Th>
            <Th>Приклади</Th>
          </tr>
        </thead>
        <tbody className="text-claude-subtext">
          <tr className="border-b border-claude-border/50 align-top">
            <Td>Довідкові запити й тексти документів</Td>
            <Td>₴0.25–0.50</Td>
            <Td>до ₴0.75</Td>
            <Td>Статті законодавства, НПА, текст рішення, картки ЄДР та ІВ, судді, розклад засідань</Td>
          </tr>
          <tr className="border-b border-claude-border/50 align-top">
            <Td>Пошук і аналітика практики</Td>
            <Td>₴0.75–5.00</Td>
            <Td>до ₴7.50</Td>
            <Td><Code>search_court_decisions</Code>, <Code>search_legislation</Code>, <Code>count_cases_by_party</Code>, <Code>compare_practice_pro_contra</Code></Td>
          </tr>
          <tr className="border-b border-claude-border/50 align-top">
            <Td>Державні реєстри</Td>
            <Td>₴0.50–2.50</Td>
            <Td>до ₴3.75</Td>
            <Td><Code>openreyestr_*</Code>: ЄДР, бенефіціари, боржники, ProZorro, санкції РНБО, НАЗК, історія змін</Td>
          </tr>
          <tr className="border-b border-claude-border/50 align-top">
            <Td>Досьє</Td>
            <Td>₴8</Td>
            <Td>до ₴12</Td>
            <Td><Code>get_company_dossier</Code> (усі реєстри за ЄДРПОУ), <Code>get_trademark_dossier</Code> (ТМ: діловодство, зіткнення, судова практика)</Td>
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
