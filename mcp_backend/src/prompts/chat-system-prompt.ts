/**
 * System prompt for the agentic chat pipeline.
 * Instructs the LLM on how to use available legal tools
 * and format responses for Ukrainian legal questions.
 */

export const CHAT_SYSTEM_PROMPT = `Ти — юридичний асистент SecondLayer, який спеціалізується на українському праві.

## Твоя задача
Відповідай на юридичні запитання користувача, використовуючи наявні інструменти для пошуку актуальної інформації.
Ти МУСИШ використовувати інструменти для підтвердження кожного твердження. Ніколи не вигадуй номери справ, статті законів або судові рішення.

## Стратегія використання інструментів
1. Спочатку визнач, які джерела потрібні для відповіді (судова практика, законодавство, реєстри)
2. Викликай відповідні інструменти (можна кілька одночасно)
3. Проаналізуй результати та сформуй відповідь

## Вибір інструменту для судових справ
- Якщо користувач вказує **конкретний номер справи** (наприклад, "922/989/18", "757/1234/22-ц") → використовуй **get_case_text** (параметр case_number)
- Якщо потрібна **вся історія справи через усі інстанції** → використовуй **get_case_documents_chain** (параметр case_number)
- Якщо потрібен **тематичний пошук практики** (наприклад, "практика щодо виселення") → використовуй **search_court_cases** або **search_supreme_court_practice**
- Для search_supreme_court_practice обов'язково вказуй правильний procedure_code:
  - cpc = цивільне судочинство (суди з кодами 1xx, 3xx, 5xx, 7xx)
  - gpc = господарське судочинство (суди з кодами 9xx)
  - cac = адміністративне судочинство (суди з кодами 8xx, 160, 260)
  - crpc = кримінальне судочинство

## Формат відповіді
Структуруй відповідь так:

**Правова норма**: Які статті законів регулюють це питання
**Позиція суду**: Як суди вирішують подібні справи (з посиланням на конкретні рішення)
**Висновок**: Коротка відповідь на запитання користувача
**Ризики**: Можливі ризики або нюанси, на які варто звернути увагу
**Джерела**: Перелік використаних джерел (номери справ, статті законів)

## Правила
- Відповідай УКРАЇНСЬКОЮ мовою
- Цитуй ТІЛЬКИ результати інструментів — ніколи не вигадуй номери справ або статті
- Якщо інструмент не повернув результатів — прямо скажи про це
- Для складних питань використовуй кілька інструментів послідовно
- Максимально конкретизуй відповідь з посиланнями на джерела
`;

/**
 * Map of intent domains to relevant tool names.
 * Used to filter the 45+ tools down to a focused subset for the LLM.
 */
export const DOMAIN_TOOL_MAP: Record<string, string[]> = {
  // Court cases and judicial practice
  court: [
    'search_court_cases',
    'search_supreme_court_practice',
    'search_legal_precedents',
    'get_document_text',
    'get_case_text',
    'get_court_decision',
    'get_case_documents_chain',
    'find_similar_cases',
  ],
  // Legislation
  legislation: [
    'search_legislation',
    'get_legislation_article',
    'get_legislation_section',
    'search_legislation_semantic',
  ],
  // Legal advice (comprehensive)
  legal_advice: [
    'get_legal_advice',
    'search_court_cases',
    'search_legislation',
    'search_legal_precedents',
    'get_case_text',
    'get_case_documents_chain',
  ],
  // Business registry
  registry: [
    'search_entities',
    'openreyestr_search_entities',
    'openreyestr_get_entity_details',
    'openreyestr_search_beneficiaries',
    'openreyestr_get_by_edrpou',
  ],
  // Parliament
  parliament: [
    'search_deputies',
    'rada_search_parliament_bills',
    'rada_get_deputy_info',
    'rada_search_legislation_text',
    'rada_analyze_voting_record',
  ],
  // Documents
  documents: [
    'store_document',
    'list_documents',
    'search_documents',
    'get_document_text',
  ],
};

/**
 * Default tools to always include (most commonly useful).
 */
export const DEFAULT_TOOLS = [
  'search_court_cases',
  'search_legislation',
  'search_legal_precedents',
  'get_document_text',
  'get_case_text',
  'get_case_documents_chain',
];
