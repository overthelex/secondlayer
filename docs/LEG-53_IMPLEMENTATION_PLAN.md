# LEG-53: Backfill Improvement — Court Registry (reyestr.court.gov.ua)

## Задача
Улучшить массовую загрузку судебных решений из реестра судов (reyestr.court.gov.ua) через Playwright-скрапер: checkpoint/resume, инкрементальный режим, anti-detection, обработка CAPTCHA, метрики, queue-based архитектура.

## Текущее состояние

### Скрипты и сервисы
- **`scrape-court-registry.ts`** — основной Playwright-скрапер для reyestr.court.gov.ua
- **`backfill-fulltext-reyestr.ts`** — backfill full_text для документов без текста (axios, не Playwright)
- **`scrape-worker-service.ts`** — для ZakonOnline (zakononline.ua), не для court registry

### Что уже работает
- ✅ Playwright с concurrent browser tabs
- ✅ Поиск по форме (justice kind, document form, search text, date)
- ✅ Пагинация результатов
- ✅ Ожидание CAPTCHA (headed mode, до 5 минут)
- ✅ Сохранение HTML на диск
- ✅ Pipeline: HTML → text → sections → embeddings → Qdrant

### Реализовано (LEG-53)
- ✅ Checkpoint: сохранение последней страницы/даты в БД
- ✅ Incremental mode: скрапить только решения с даты последнего успешного запуска
- ✅ Anti-detection: рандомизированные задержки, ротация user-agent (Chrome 133+, Firefox 133)
- ✅ Graceful handling CAPTCHA/блокировок (pause + webhook alert)
- ✅ Proxy support (передаётся в `chromium.launch()`)
- ✅ Мониторинг success rate и алерты при деградации
- ✅ Prometheus metrics
- ⏳ Queue-based: discovery/extraction — planned for follow-up

---

## План реализации

### 1. Миграция: таблицы для checkpoint и очереди

**Файл:** `mcp_backend/src/migrations/045_add_court_registry_scrape_tables.sql`

```sql
-- Checkpoint для скрапинга court registry
CREATE TABLE IF NOT EXISTS court_registry_scrape_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scrape_config_hash VARCHAR(64) NOT NULL,  -- hash(justice_kind + doc_form + search_text) — без date_from для incremental
  justice_kind VARCHAR(100) NOT NULL,
  doc_form VARCHAR(100) NOT NULL,
  search_text TEXT,
  date_from VARCHAR(20) NOT NULL,
  last_page INTEGER NOT NULL DEFAULT 0,
  last_scraped_at TIMESTAMP,
  documents_scraped INTEGER NOT NULL DEFAULT 0,
  documents_failed INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'in_progress',
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(scrape_config_hash)
);

CREATE INDEX IF NOT EXISTS idx_court_registry_checkpoint_config 
  ON court_registry_scrape_checkpoints(scrape_config_hash);
CREATE INDEX IF NOT EXISTS idx_court_registry_checkpoint_status 
  ON court_registry_scrape_checkpoints(status);

-- Очередь URL для queue-based архитектуры
CREATE TABLE IF NOT EXISTS court_registry_scrape_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id VARCHAR(50) NOT NULL UNIQUE,
  url TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  checkpoint_id UUID REFERENCES court_registry_scrape_checkpoints(id) ON DELETE SET NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, failed
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  scraped_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scrape_queue_status ON court_registry_scrape_queue(status);
CREATE INDEX IF NOT EXISTS idx_scrape_queue_checkpoint ON court_registry_scrape_queue(checkpoint_id);
CREATE INDEX IF NOT EXISTS idx_scrape_queue_doc_id ON court_registry_scrape_queue(doc_id);

-- Статистика для мониторинга и алертов
CREATE TABLE IF NOT EXISTS court_registry_scrape_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id VARCHAR(64) NOT NULL,
  checkpoint_id UUID REFERENCES court_registry_scrape_checkpoints(id) ON DELETE SET NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  captcha_count INTEGER NOT NULL DEFAULT 0,
  block_count INTEGER NOT NULL DEFAULT 0,
  duration_sec FLOAT,
  success_rate FLOAT,
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scrape_stats_run ON court_registry_scrape_stats(run_id);
CREATE INDEX IF NOT EXISTS idx_scrape_stats_recorded ON court_registry_scrape_stats(recorded_at);

-- Триггеры updated_at (как в остальных таблицах)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_court_registry_checkpoint_updated_at') THEN
    CREATE TRIGGER update_court_registry_checkpoint_updated_at
      BEFORE UPDATE ON court_registry_scrape_checkpoints
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_court_registry_queue_updated_at') THEN
    CREATE TRIGGER update_court_registry_queue_updated_at
      BEFORE UPDATE ON court_registry_scrape_queue
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
```

---

### 2. Сервис checkpoint и очереди

**Файл:** `mcp_backend/src/services/court-registry-scrape-service.ts`

```typescript
import { Database } from '../database/database.js';
import crypto from 'crypto';

export interface ScrapeConfig {
  justiceKind: string;
  docForm: string;
  searchText?: string;
  dateFrom: string;
}

export interface Checkpoint {
  id: string;
  scrape_config_hash: string;
  last_page: number;
  last_scraped_at: Date | null;
  documents_scraped: number;
  documents_failed: number;
  status: 'in_progress' | 'completed' | 'failed';
}

export class CourtRegistryScrapeService {
  constructor(private db: Database) {}

  /** Hash без dateFrom — иначе incremental mode ломается при смене effectiveDateFrom */
  hashConfig(config: ScrapeConfig): string {
    const str = `${config.justiceKind}|${config.docForm}|${config.searchText || ''}`;
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 32);
  }

  async getCheckpoint(config: ScrapeConfig): Promise<Checkpoint | null> {
    const hash = this.hashConfig(config);
    const res = await this.db.query(
      `SELECT * FROM court_registry_scrape_checkpoints WHERE scrape_config_hash = $1`,
      [hash]
    );
    return res.rows[0] ? this.mapCheckpoint(res.rows[0]) : null;
  }

  async upsertCheckpoint(
    config: ScrapeConfig,
    lastPage: number,
    documentsScraped: number,
    documentsFailed: number,
    status: 'in_progress' | 'completed' | 'failed',
    errorMessage?: string
  ): Promise<Checkpoint> {
    const hash = this.hashConfig(config);
    await this.db.query(`
      INSERT INTO court_registry_scrape_checkpoints (
        scrape_config_hash, justice_kind, doc_form, search_text, date_from,
        last_page, documents_scraped, documents_failed, status, error_message, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (scrape_config_hash)
      DO UPDATE SET
        last_page = EXCLUDED.last_page,
        documents_scraped = EXCLUDED.documents_scraped,
        documents_failed = EXCLUDED.documents_failed,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        last_scraped_at = NOW(),  /* обновляется и при in_progress — incremental после краша */
        updated_at = NOW()
    `, [hash, config.justiceKind, config.docForm, config.searchText || null, config.dateFrom,
        lastPage, documentsScraped, documentsFailed, status, errorMessage || null]);
    const r = await this.db.query('SELECT * FROM court_registry_scrape_checkpoints WHERE scrape_config_hash = $1', [hash]);
    return this.mapCheckpoint(r.rows[0]);
  }

  async enqueueUrls(checkpointId: string, items: { docId: string; url: string; pageNumber: number }[]): Promise<number> {
    if (items.length === 0) return 0;
    const docIds = items.map((i) => i.docId);
    const urls = items.map((i) => i.url);
    const pageNumbers = items.map((i) => i.pageNumber);
    const res = await this.db.query(
      `INSERT INTO court_registry_scrape_queue (doc_id, url, page_number, checkpoint_id, status)
       SELECT unnest($1::varchar[]), unnest($2::text[]), unnest($3::int[]), $4::uuid, 'pending'
       ON CONFLICT (doc_id) DO NOTHING`,
      [docIds, urls, pageNumbers, checkpointId]
    );
    return res.rowCount ?? 0;
  }

  async getNextBatch(status: string, limit: number): Promise<{ doc_id: string; url: string }[]> {
    const res = await this.db.query(`
      UPDATE court_registry_scrape_queue
      SET status = 'in_progress', updated_at = NOW()
      WHERE id IN (
        SELECT id FROM court_registry_scrape_queue
        WHERE status = $1
        ORDER BY page_number, created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING doc_id, url
    `, [status, limit]);
    return res.rows;
  }

  async markCompleted(docId: string): Promise<void> {
    await this.db.query(
      `UPDATE court_registry_scrape_queue SET status = 'completed', scraped_at = NOW() WHERE doc_id = $1`,
      [docId]
    );
  }

  async markFailed(docId: string, errorMessage: string): Promise<void> {
    await this.db.query(
      `UPDATE court_registry_scrape_queue SET status = 'failed', retry_count = retry_count + 1, error_message = $2 WHERE doc_id = $1`,
      [docId, errorMessage]
    );
  }

  async recordStats(runId: string, checkpointId: string, success: number, fail: number, captcha: number, block: number, durationSec: number): Promise<void> {
    const total = success + fail;
    const successRate = total > 0 ? success / total : 0;
    await this.db.query(`
      INSERT INTO court_registry_scrape_stats (run_id, checkpoint_id, success_count, fail_count, captcha_count, block_count, duration_sec, success_rate)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [runId, checkpointId, success, fail, captcha, block, durationSec, successRate]);
  }

  private mapCheckpoint(row: any): Checkpoint {
    return {
      id: row.id,
      scrape_config_hash: row.scrape_config_hash,
      last_page: row.last_page,
      last_scraped_at: row.last_scraped_at,
      documents_scraped: row.documents_scraped,
      documents_failed: row.documents_failed,
      status: row.status,
    };
  }
}
```

---

### 3. Anti-detection и user-agent rotation

**Файл:** `mcp_backend/src/utils/scrape-anti-detection.ts`

```typescript
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
];

export function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export function getRandomDelay(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

export async function sleepWithJitter(baseMs: number, jitterMs: number = 500): Promise<void> {
  const delay = baseMs + (Math.random() * 2 - 1) * jitterMs;
  await new Promise(r => setTimeout(r, Math.max(0, delay)));
}
```

---

### 4. Инкрементальный режим

Логика:
- При `INCREMENTAL=true` читать последний успешный checkpoint.
- Если checkpoint есть и `last_scraped_at` не старше N дней — использовать `DATE_FROM` = `last_scraped_at` (или `DATE_FROM` из env, если не задан — брать из checkpoint).
- Если checkpoint нет — использовать `DATE_FROM` из env, по умолчанию 2 года назад.

```typescript
// В main() scrape-court-registry.ts
const INCREMENTAL = process.env.INCREMENTAL === 'true';
const scrapeConfig: ScrapeConfig = {
  justiceKind: JUSTICE_KIND,
  docForm: DOC_FORM,
  searchText: SEARCH_TEXT || undefined,
  dateFrom: DATE_FROM,
};

let effectiveDateFrom = DATE_FROM;
let startPage = 1;

if (INCREMENTAL) {
  const checkpoint = await scrapeService.getOrCreateCheckpoint(scrapeConfig);
  if (checkpoint && checkpoint.last_scraped_at) {
    const lastDate = new Date(checkpoint.last_scraped_at);
    const daysSince = (Date.now() - lastDate.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSince < 7) {
      effectiveDateFrom = formatDate(lastDate);

      // Resume from last page if checkpoint was in_progress
      if (checkpoint.status === 'in_progress') {
        startPage = checkpoint.last_page + 1;
      }
    }
  }
}
```

---

### 5. Graceful handling CAPTCHA и блокировок

**Файл:** обновить `scrape-court-registry.ts`

```typescript
async function waitForCaptcha(page: Page): Promise<'solved' | 'timeout' | 'blocked'> {
  const captchaVisible = await page.locator('#modalcaptcha').isVisible().catch(() => false);
  if (!captchaVisible) return 'solved';

  console.log('\n  CAPTCHA detected! Please solve it in the browser window.');
  console.log('   Waiting up to 5 minutes...\n');

  // Опционально: отправить webhook/alert
  if (process.env.SCRAPE_ALERT_WEBHOOK) {
    await fetch(process.env.SCRAPE_ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'captcha_detected',
        source: 'reyestr.court.gov.ua',
        message: 'CAPTCHA detected, waiting for manual solve',
      }),
    }).catch(() => {});
  }

  const startTime = Date.now();
  const timeout = 5 * 60 * 1000;

  while (Date.now() - startTime < timeout) {
    const stillVisible = await page.locator('#modalcaptcha').isVisible().catch(() => false);
    if (!stillVisible) {
      console.log('   CAPTCHA solved, continuing...\n');
      return 'solved';
    }

    // Проверка на блокировку (403, "доступ заборонено" и т.п.)
    const bodyText = await page.locator('body').textContent().catch(() => '');
    if (/доступ заборонено|403|forbidden|blocked/i.test(bodyText)) {
      console.log('   Access blocked detected.');
      return 'blocked';
    }

    await sleep(1000);
  }

  return 'timeout';
}
```

При `blocked` или `timeout`:
- Сохранить checkpoint с `status = 'failed'`, `error_message = 'CAPTCHA timeout' | 'Access blocked'`
- Записать в `court_registry_scrape_stats` с `block_count` / `captcha_count`
- Остановить скрап, вывести инструкции для ручного запуска

---

### 6. Proxy support

**Файл:** `scrape-court-registry.ts`

Proxy передаётся в `chromium.launch()`, не в `newContext()` — Playwright ожидает proxy на уровне launch.

```typescript
const proxy = process.env.SCRAPE_PROXY || process.env.HTTP_PROXY;
const launchOptions = {
  headless: HEADLESS,
  ...(proxy && { proxy: { server: proxy } }),
};
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'uk-UA', userAgent: getRandomUserAgent() });
```

---

### 7. Prometheus metrics

**Файл:** `mcp_backend/src/services/court-registry-metrics.ts`

```typescript
import { Registry, Counter, Gauge, Histogram } from 'prom-client';

// Использовать существующий registry или создать отдельный
const registry = new Registry();

export const courtRegistryScrapeTotal = new Counter({
  name: 'court_registry_scrape_total',
  help: 'Total documents scraped from court registry',
  labelNames: ['status'], // success, failed, skipped
  registers: [registry],
});

export const courtRegistryScrapeDuration = new Histogram({
  name: 'court_registry_scrape_duration_seconds',
  help: 'Scraping duration per document',
  labelNames: ['status'],
  registers: [registry],
});

export const courtRegistryScrapeSuccessRate = new Gauge({
  name: 'court_registry_scrape_success_rate',
  help: 'Success rate of last scrape run',
  registers: [registry],
});

export const courtRegistryCaptchaCount = new Counter({
  name: 'court_registry_captcha_total',
  help: 'Total CAPTCHAs encountered',
  registers: [registry],
});

export const courtRegistryBlockCount = new Counter({
  name: 'court_registry_block_total',
  help: 'Total access blocks encountered',
  registers: [registry],
});

export function getRegistry(): Registry {
  return registry;
}
```

---

### 8. Queue-based архитектура

**Разделение на два этапа:**

1. **Discovery (list URLs)** — один процесс Playwright:
   - Заполняет форму, выполняет поиск
   - Проходит по страницам результатов
   - Извлекает ссылки на решения
   - Складывает в `court_registry_scrape_queue`
   - Сохраняет checkpoint после каждой страницы

2. **Extraction (scrape content)** — воркеры (Playwright или axios):
   - Берут из очереди `status = 'pending'`
   - Скачивают HTML
   - Парсят и сохраняют в БД
   - Обновляют `status = 'completed' | 'failed'`

**Режимы запуска:**
- `MODE=full` — discovery + extraction в одном процессе (как сейчас)
- `MODE=discovery` — только discovery, заполняет очередь
- `MODE=extraction` — только extraction из очереди

```typescript
// discovery
for (let pageNum = startPage; pageNum <= MAX_PAGES; pageNum++) {
  const links = await extractDecisionLinks(page);
  await scrapeService.enqueueUrls(checkpointId, links.map(l => ({ docId: l.id, url: l.url, pageNumber: pageNum })));
  await scrapeService.upsertCheckpoint(config, pageNum, totalScraped, totalFailed, 'in_progress');
  const hasNext = await goToNextPage(page);
  if (!hasNext) break;
}

// extraction (отдельный worker)
const batch = await scrapeService.getNextBatch('pending', CONCURRENCY);
for (const { doc_id, url } of batch) {
  const html = await downloadHtml(url);
  await processDocument(ctx, doc_id, html);
  await scrapeService.markCompleted(doc_id);
}
```

---

### 9. Мониторинг и алерты

- После каждого run записывать в `court_registry_scrape_stats`:
  - `success_count`, `fail_count`, `captcha_count`, `block_count`
  - `success_rate`, `duration_sec`

- Проверка деградации:
  - Если `success_rate < 0.8` за последние 3 run — отправить alert
  - Если `block_count > 0` или `captcha_count > 2` — отправить alert

```typescript
async function checkAndAlert(stats: { success_rate: number; block_count: number; captcha_count: number }) {
  const webhook = process.env.SCRAPE_ALERT_WEBHOOK;
  if (!webhook) return;

  if (stats.success_rate < 0.8) {
    await fetch(webhook, {
      method: 'POST',
      body: JSON.stringify({ event: 'low_success_rate', ...stats }),
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  }
  if (stats.block_count > 0 || stats.captcha_count > 2) {
    await fetch(webhook, {
      method: 'POST',
      body: JSON.stringify({ event: 'access_issues', ...stats }),
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  }
}
```

---

### 9.1. Resume: прямая навигация на страницу

Вместо O(N) кликов по «Наступна» при resume — попытка прямого перехода:
- Клик по ссылке с номером страницы (pagination links)
- Или установка `PagingInfo.Page` и submit формы (ASP.NET)
- Fallback: цикл кликов с предупреждением при `startPage > 20`

### 9.2. Cleanup при ошибках

`process.exit(1)` заменён на `throw` — чтобы `finally` блоки закрывали browser и db. Обёртка `try/finally` гарантирует `ctx.db.close()`.

---

## Code Review Fixes (Vladimir)

| # | Проблема | Исправление |
|---|----------|-------------|
| 1 | Hash включал dateFrom — ломал incremental | Убран dateFrom из hashConfig |
| 2 | Resume O(N) пролистывание | tryGoToPageDirect() — прямая навигация |
| 3 | enqueueUrls N+1 запросов | Bulk insert через unnest() |
| 4 | Proxy в newContext() | Перенесён в chromium.launch() |
| 5 | process.exit(1) без cleanup | throw + try/finally для db |
| 6 | last_scraped_at только при completed/failed | Обновляется при каждом upsert |
| 7 | updated_at без триггера | Добавлены триггеры в миграцию |
| 8 | User-Agent устаревшие (Chrome 120) | Chrome 133, Firefox 133, Safari 17.6 |

---

## Структура изменений

| Файл | Действие |
|------|----------|
| `migrations/045_add_court_registry_scrape_tables.sql` | Создать |
| `services/court-registry-scrape-service.ts` | Создать |
| `services/court-registry-metrics.ts` | Создать |
| `utils/scrape-anti-detection.ts` | Создать |
| `scripts/scrape-court-registry.ts` | Обновить (checkpoint, incremental, anti-detection, proxy, CAPTCHA, metrics) |
| `scripts/scrape-court-registry-discovery.ts` | Создать (опционально, для discovery-only) |
| `scripts/scrape-court-registry-extraction.ts` | Создать (опционально, для extraction-only) |

---

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `INCREMENTAL` | `true` — скрапить только с даты последнего run |
| `RESUME` | `true` — продолжить с последней страницы checkpoint |
| `SCRAPE_PROXY` | HTTP proxy для Playwright |
| `SCRAPE_ALERT_WEBHOOK` | URL для отправки алертов (CAPTCHA, блокировка) |
| `SCRAPE_DELAY_MIN_MS` | Минимальная задержка между запросами (default 1500) |
| `SCRAPE_DELAY_MAX_MS` | Максимальная задержка (default 3500) |
| `MODE` | `full` \| `discovery` \| `extraction` |

---

## Чеклист

- [x] Миграция 045 (+ триггеры updated_at)
- [x] CourtRegistryScrapeService (hash без dateFrom, bulk enqueueUrls)
- [x] scrape-anti-detection.ts (User-Agent 133+)
- [x] Checkpoint в scrape-court-registry.ts
- [x] Incremental mode
- [x] Anti-detection (delays, user-agent)
- [x] CAPTCHA/block handling + webhook
- [x] Proxy support (launch-level)
- [x] Prometheus metrics
- [x] court_registry_scrape_stats + alert logic
- [x] Resume: tryGoToPageDirect + fallback
- [x] Cleanup: throw вместо process.exit, try/finally для db
- [ ] Queue-based architecture (discovery / extraction) — follow-up
- [ ] Тесты

---


