# Рішення для зберігання та відображення великих законодавчих документів

## Проблема

При відображенні відповідей (наприклад, `deadline_report.html`) необхідно:
1. Завантажувати всі пов'язані з запитом документи
2. Створити механізм для відображення повних документів з бази даних
3. Ефективно зберігати та відображати великі законодавчі акти (наприклад, ЦПК України - https://zakon.rada.gov.ua/laws/show/1618-15#Text)

## Архітектурне рішення

### 1. Стратегія зберігання (PostgreSQL)

#### Таблиці бази даних:

**`legislation`** - метадані законодавчих актів
- `rada_id` - ідентифікатор на zakon.rada.gov.ua (наприклад, "1618-15" для ЦПК)
- `type` - тип документа (code/law/regulation)
- `title`, `short_title` - назва та скорочена назва
- `total_articles` - загальна кількість статей
- `structure_metadata` - JSON зі структурою (розділи, глави)

**`legislation_articles`** - окремі статті з повним текстом
- `article_number` - номер статті (наприклад, "354", "354-1")
- `section_number`, `chapter_number` - розділ та глава
- `full_text` - повний текст статті (plain text)
- `full_text_html` - форматований HTML
- `byte_size` - розмір для оптимізації завантаження
- `is_current` - чи є це поточна версія

**`legislation_chunks`** - фрагменти для векторного пошуку
- `chunk_index` - порядковий номер фрагмента
- `text` - текст фрагмента (~500 символів)
- `vector_id` - ID в Qdrant для семантичного пошуку
- `context_before/after` - контекст для кращого розуміння

**`legislation_citations`** - зв'язки між законодавством та судовими рішеннями
- Відстежує, як суди застосовують конкретні статті
- Частота цитування та тип інтерпретації

### 2. Стратегія завантаження та парсингу

**`RadaLegislationAdapter`** (`src/adapters/rada-legislation-adapter.ts`):
- Завантажує HTML з zakon.rada.gov.ua
- Парсить структуру документа (статті, розділи, глави)
- Витягує метадані (дата прийняття, чинності)
- Зберігає в базу даних з версіонуванням
- Створює chunks для векторного пошуку

**Методи:**
```typescript
fetchLegislation(radaId: string) // Завантажити з rada.gov.ua
saveLegislationToDatabase() // Зберегти в PostgreSQL
createArticleChunks() // Створити фрагменти для векторизації
getArticleByNumber() // Отримати конкретну статтю
searchArticles() // Повнотекстовий пошук
```

### 3. Сервіс для роботи з законодавством

**`LegislationService`** (`src/services/legislation-service.ts`):

**Основні методи:**
- `ensureLegislationExists(radaId)` - перевіряє наявність в БД, завантажує якщо немає
- `getArticle(radaId, articleNumber)` - отримати конкретну статтю
- `getMultipleArticles(radaId, articleNumbers[])` - отримати кілька статей
- `searchLegislation(query, radaId?)` - пошук по тексту
- `findRelevantArticles(query, radaId?)` - семантичний пошук через векторні embeddings
- `getLegislationStructure(radaId)` - отримати структуру документа (зміст)
- `indexArticlesForVectorSearch(radaId)` - індексація в Qdrant

**Автоматичний парсинг посилань:**
```typescript
parseArticleReference(text: string)
// "стаття 354 ЦПК" → { radaId: "1618-15", articleNumber: "354" }
```

### 4. Система рендерингу HTML

**`LegislationRenderer`** (`src/services/legislation-renderer.ts`):

**Режими відображення:**

1. **Одна стаття** - `renderArticleHTML()`
   - Компактне відображення однієї статті
   - Посилання на джерело
   - Підтримка light/dark теми

2. **Кілька статей** - `renderMultipleArticlesHTML()`
   - Зміст (table of contents) з навігацією
   - Підсвічування важливих статей
   - Якорі для швидкого переходу

3. **Прогресивне завантаження** - `renderProgressiveLoadingHTML()`
   - Початковий рендер структури
   - Lazy loading статей при скролі
   - Skeleton screens під час завантаження

**Опції рендерингу:**
```typescript
interface RenderOptions {
  includeNavigation?: boolean;     // Показати зміст
  highlightArticles?: string[];    // Підсвітити статті
  maxArticlesPerPage?: number;     // Пагінація
  theme?: 'light' | 'dark';        // Тема
  format?: 'full' | 'compact';     // Формат
}
```

### 5. Інтеграція з MCP Tools

**Нові MCP інструменти:**

```typescript
// 1. Отримати конкретну статтю
get_legislation_article({
  rada_id: "1618-15",
  article_number: "354"
})

// 2. Отримати кілька статей
get_legislation_articles({
  rada_id: "1618-15",
  article_numbers: ["354", "355", "356"]
})

// 3. Пошук релевантних статей
search_legislation({
  query: "строки апеляційного оскарження",
  rada_id: "1618-15",  // опціонально
  limit: 5
})

// 4. Отримати структуру закону
get_legislation_structure({
  rada_id: "1618-15"
})
```

### 6. Оновлення calculateProceduralDeadlines

**Додано автоматичне завантаження повних текстів статей:**

```typescript
async calculateProceduralDeadlines(args) {
  // ... існуючий код ...
  
  // Додати повні тексти статей законодавства
  const legislationReferences = await this.extractLegislationReferences(
    packagedAnswer
  );
  
  // Рендерити HTML з повними статтями
  const html = this.renderDeadlineReportWithLegislation(
    packagedAnswer,
    legislationReferences
  );
}
```

## Переваги рішення

### 1. Ефективність зберігання
- ✅ Гранулярне зберігання (по статтях) замість цілих документів
- ✅ Дедуплікація - одна стаття зберігається один раз
- ✅ Версіонування - відстеження змін законодавства

### 2. Швидкість доступу
- ✅ Індекси по номерах статей
- ✅ Повнотекстовий пошук (PostgreSQL)
- ✅ Векторний пошук (Qdrant) для семантичного пошуку
- ✅ Materialized view для швидких запитів

### 3. Зручність використання
- ✅ Автоматичне завантаження з rada.gov.ua
- ✅ Кешування в базі даних
- ✅ Прогресивне завантаження для великих документів
- ✅ Responsive HTML з навігацією

### 4. Масштабованість
- ✅ Підтримка будь-якої кількості законодавчих актів
- ✅ Chunking для векторного пошуку
- ✅ Пагінація для великих результатів
- ✅ Lazy loading в UI

## Приклад використання

### 1. Завантажити ЦПК України

```typescript
const legislationService = new LegislationService(db, embeddingService);

// Автоматично завантажить з rada.gov.ua якщо немає в БД
await legislationService.ensureLegislationExists("1618-15");
```

### 2. Отримати статтю 354 ЦПК

```typescript
const article = await legislationService.getArticle("1618-15", "354");

// Результат:
{
  rada_id: "1618-15",
  article_number: "354",
  title: "Строк і порядок подання апеляційної скарги",
  full_text: "...",
  full_text_html: "<p>...</p>",
  url: "https://zakon.rada.gov.ua/laws/show/1618-15#n354"
}
```

### 3. Знайти релевантні статті

```typescript
const articles = await legislationService.findRelevantArticles(
  "поновлення пропущеного строку",
  "1618-15"
);
// Використовує векторний пошук для семантичної релевантності
```

### 4. Відобразити в HTML

```typescript
const renderer = new LegislationRenderer();

// Одна стаття
const html = renderer.renderArticleHTML(article, {
  theme: 'light',
  format: 'full'
});

// Кілька статей з навігацією
const html = renderer.renderMultipleArticlesHTML(
  articles,
  "Цивільний процесуальний кодекс України",
  {
    includeNavigation: true,
    highlightArticles: ["354"]
  }
);
```

## Розміри та продуктивність

### ЦПК України (1618-15)
- **Загальний розмір:** ~2-3 MB HTML
- **Кількість статей:** ~500
- **Середній розмір статті:** 4-6 KB
- **Chunks для векторного пошуку:** ~2000-3000

### Стратегія для великих документів:
1. **Початкове завантаження:** Структура + перші 10 статей (~50 KB)
2. **Lazy loading:** Статті завантажуються при скролі (по 10 штук)
3. **Кешування:** Завантажені статті зберігаються в пам'яті браузера
4. **Векторний пошук:** Швидкий пошук релевантних статей без завантаження всього документа

## Міграція бази даних

```bash
# Створити таблиці
psql -U postgres -d legal_db -f src/database/legislation-schema.sql

# Завантажити основні кодекси
node scripts/load-legislation.js 1618-15  # ЦПК
node scripts/load-legislation.js 435-15   # ГПК
node scripts/load-legislation.js 2747-15  # КАС
node scripts/load-legislation.js 4651-17  # КПК
```

## Наступні кроки

1. ✅ Створити схему бази даних
2. ✅ Реалізувати adapter для rada.gov.ua
3. ✅ Створити legislation service
4. ✅ Реалізувати HTML renderer
5. ⏳ Додати MCP tools в query API
6. ⏳ Оновити calculateProceduralDeadlines
7. ⏳ Створити скрипт для завантаження основних кодексів
8. ⏳ Додати тести

## Файли

- `src/database/legislation-schema.sql` - схема БД
- `src/adapters/rada-legislation-adapter.ts` - завантаження з rada.gov.ua
- `src/services/legislation-service.ts` - бізнес-логіка
- `src/services/legislation-renderer.ts` - рендеринг HTML
- `src/api/mcp-query-api.ts` - MCP tools (оновити)
