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
];
