import { CodeBlock } from '@/components/CodeBlock';

export function ApiReferencePage() {
  return (
    <article className="prose prose-sm max-w-none">
      <h1>API Reference</h1>
      <p>
        SecondLayer надає REST API для виклику MCP інструментів через HTTP.
        Базовий URL: <code>https://mcp.legal.org.ua</code>
      </p>

      <h2>Виклик інструменту</h2>
      <div className="not-prose">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-green-100 text-green-700">POST</span>
          <code className="text-sm">/api/tools/:toolName</code>
        </div>
      </div>
      <p>Виконує MCP інструмент та повертає результат.</p>
      <CodeBlock
        code={`POST /api/tools/search_court_decisions HTTP/1.1
Host: mcp.legal.org.ua
Authorization: Bearer sl_your_api_key
Content-Type: application/json

{
  "query": "відшкодування збитків",
  "limit": 10
}`}
        title="Request"
      />
      <CodeBlock
        code={`{
  "success": true,
  "result": {
    "decisions": [...],
    "total": 42,
    "query_time_ms": 230
  }
}`}
        title="Response"
      />

      <h2>Стрімінг (SSE)</h2>
      <div className="not-prose">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-green-100 text-green-700">POST</span>
          <code className="text-sm">/api/tools/:toolName/stream</code>
        </div>
      </div>
      <p>Виконує інструмент з потоковою відповіддю через Server-Sent Events.</p>

      <h2>Batch-запити</h2>
      <div className="not-prose">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-green-100 text-green-700">POST</span>
          <code className="text-sm">/api/tools/batch</code>
        </div>
      </div>
      <p>Виконує кілька інструментів в одному запиті.</p>
      <CodeBlock
        code={`{
  "tools": [
    {
      "name": "search_court_decisions",
      "params": { "query": "моральна шкода" }
    },
    {
      "name": "get_legislation",
      "params": { "name": "Цивільний кодекс", "article": "23" }
    }
  ]
}`}
        title="Batch Request"
      />

      <h2>MCP Endpoint</h2>
      <div className="not-prose">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">POST</span>
          <code className="text-sm">/api/v2/mcp</code>
        </div>
      </div>
      <p>
        Основний ендпоінт для MCP-клієнтів (Claude Code, Claude Desktop, ChatGPT).
        Транспорт Streamable HTTP, автентифікація за API-ключем або через OAuth
        (RFC 9728 discovery на <code>/.well-known/oauth-protected-resource/api/v2/mcp</code>).
        Віддає кураторський набір інструментів, а не весь реєстр.
      </p>

      <h3>Застарілі ендпоінти</h3>
      <p>
        <code>GET /v1/sse</code> — транспорт SSE, і <code>POST /api/v1/mcp</code> —
        Streamable HTTP з повним набором інструментів. Обидва працюють, але нові
        інтеграції слід робити на <code>/api/v2/mcp</code>.
      </p>

      <h2>Health Check</h2>
      <div className="not-prose">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-700">GET</span>
          <code className="text-sm">/health</code>
        </div>
      </div>
      <p>Перевірка стану сервера. Не потребує автентифікації.</p>

      <h2>API Keys Management</h2>
      <table>
        <thead>
          <tr>
            <th>Метод</th>
            <th>Endpoint</th>
            <th>Опис</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>GET</code></td>
            <td><code>/api/keys</code></td>
            <td>Список ваших API ключів</td>
          </tr>
          <tr>
            <td><code>POST</code></td>
            <td><code>/api/keys</code></td>
            <td>Створити новий ключ</td>
          </tr>
          <tr>
            <td><code>DELETE</code></td>
            <td><code>/api/keys/:id</code></td>
            <td>Відкликати ключ</td>
          </tr>
          <tr>
            <td><code>GET</code></td>
            <td><code>/api/keys/balance</code></td>
            <td>Баланс кредитів</td>
          </tr>
          <tr>
            <td><code>GET</code></td>
            <td><code>/api/keys/transactions</code></td>
            <td>Історія транзакцій</td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}
