import { CodeBlock } from '@/components/CodeBlock';

export function QuickStartPage() {
  return (
    <article className="prose prose-sm max-w-none">
      <h1>Quick Start</h1>
      <p>
        Підключіть SecondLayer до вашого MCP-клієнта за кілька хвилин.
      </p>

      <h2>1. Створіть API ключ</h2>
      <p>
        Перейдіть на сторінку <a href="/keys">API Keys</a> та створіть новий ключ.
        Збережіть його — він показується лише один раз.
      </p>

      <h2>2. Claude Code (CLI)</h2>
      <CodeBlock
        code={`claude mcp add --transport http secondlayer \\
  https://mcp.legal.org.ua/api/v2/mcp \\
  --header "Authorization: Bearer YOUR_API_KEY"`}
        title="Terminal"
      />
      <p>
        Крок 1 можна пропустити: якщо не передавати <code>--header</code>, Claude Code
        авторизується через OAuth. Виконайте <code>/mcp</code>, оберіть secondlayer і
        натисніть Authenticate, далі увійдіть своїм акаунтом у браузері. Зверніть увагу:
        заданий <code>Authorization</code> вимикає OAuth, тож ці два способи
        взаємовиключні.
      </p>
      <p>Після додавання перезапустіть Claude Code. Тепер ви можете писати запити як:</p>
      <CodeBlock
        code={`> Знайди судові рішення про відшкодування моральної шкоди за 2024 рік
> Покажи статтю 16 Цивільного кодексу
> Перевір компанію "Нафтогаз" в реєстрі`}
        title="Claude Code prompts"
      />

      <h2>3. Claude Desktop</h2>
      <p>Додайте в файл конфігурації <code>claude_desktop_config.json</code>:</p>
      <CodeBlock
        code={`{
  "mcpServers": {
    "secondlayer": {
      "type": "http",
      "url": "https://mcp.legal.org.ua/api/v2/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}`}
        title="claude_desktop_config.json"
      />

      <h2>4. REST API (curl)</h2>
      <p>Ви також можете викликати інструменти напряму через HTTP:</p>
      <CodeBlock
        code={`curl -X POST https://mcp.legal.org.ua/api/tools/search_court_decisions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "query": "відшкодування моральної шкоди",
    "limit": 5
  }'`}
        title="curl"
      />

      <h2>5. Python SDK</h2>
      <CodeBlock
        code={`import requests

API_KEY = "YOUR_API_KEY"
BASE_URL = "https://mcp.legal.org.ua/api/tools"

def search_decisions(query: str, limit: int = 5):
    response = requests.post(
        f"{BASE_URL}/search_court_decisions",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={"query": query, "limit": limit}
    )
    return response.json()

results = search_decisions("відшкодування збитків")
print(results)`}
        title="Python"
      />

      <h2>6. TypeScript / Node.js</h2>
      <CodeBlock
        code={`const API_KEY = process.env.SECONDLAYER_API_KEY;
const BASE_URL = 'https://mcp.legal.org.ua/api/tools';

async function searchDecisions(query: string, limit = 5) {
  const res = await fetch(\`\${BASE_URL}/search_court_decisions\`, {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${API_KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, limit }),
  });
  return res.json();
}

const results = await searchDecisions('відшкодування збитків');
console.log(results);`}
        title="TypeScript"
      />
    </article>
  );
}
