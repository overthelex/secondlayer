import { CodeBlock } from '@/components/CodeBlock';

export function IntegrationsPage() {
  return (
    <article className="prose prose-sm max-w-none">
      <h1>Integrations</h1>
      <p>
        SecondLayer підтримує три транспортні протоколи для інтеграції.
      </p>

      <h2>MCP Streamable HTTP (рекомендований)</h2>
      <p>
        Найкращий варіант для MCP-сумісних клієнтів. Підтримує стрімінг,
        автоматичне виявлення інструментів та двосторонню комунікацію.
      </p>

      <h3>Claude Code</h3>
      <CodeBlock
        code={`claude mcp add --transport http secondlayer \\
  https://mcp.legal.org.ua/api/v2/mcp \\
  --header "Authorization: Bearer YOUR_API_KEY"`}
        title="Terminal"
      />

      <h3>Claude Desktop</h3>
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

      <h2>MCP SSE (застарілий)</h2>
      <p>
        Транспорт <code>/v1/sse</code> залишається робочим для вже підключених клієнтів,
        але нові інтеграції варто робити на Streamable HTTP. Клієнти, які спершу пробують
        POST без <code>sessionId</code>, отримують на цьому ендпоінті 400 і частина з них
        не робить fallback на SSE.
      </p>

      <h2>REST API</h2>
      <p>
        Для прямої інтеграції без MCP-клієнта. Підходить для серверних додатків,
        скриптів та автоматизації.
      </p>

      <h3>Python</h3>
      <CodeBlock
        code={`import requests

class SecondLayerClient:
    def __init__(self, api_key: str):
        self.base_url = "https://mcp.legal.org.ua/api/tools"
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

    def call_tool(self, tool_name: str, params: dict):
        response = requests.post(
            f"{self.base_url}/{tool_name}",
            headers=self.headers,
            json=params
        )
        response.raise_for_status()
        return response.json()

# Використання
client = SecondLayerClient("YOUR_API_KEY")

# Пошук судових рішень
results = client.call_tool("search_court_decisions", {
    "query": "відшкодування моральної шкоди",
    "limit": 5
})

# Отримати статтю закону
article = client.call_tool("get_legislation", {
    "name": "Цивільний кодекс",
    "article": "23"
})`}
        title="Python"
      />

      <h3>TypeScript / Node.js</h3>
      <CodeBlock
        code={`class SecondLayerClient {
  private baseUrl = 'https://mcp.legal.org.ua/api/tools';

  constructor(private apiKey: string) {}

  async callTool(toolName: string, params: Record<string, unknown>) {
    const res = await fetch(\`\${this.baseUrl}/\${toolName}\`, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${this.apiKey}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(\`API error: \${res.status}\`);
    return res.json();
  }
}

// Використання
const client = new SecondLayerClient(process.env.SECONDLAYER_API_KEY!);

const results = await client.callTool('search_court_decisions', {
  query: 'відшкодування моральної шкоди',
  limit: 5,
});`}
        title="TypeScript"
      />

      <h2>Webhook / Batch Processing</h2>
      <p>
        Для обробки великих обсягів даних використовуйте batch endpoint:
      </p>
      <CodeBlock
        code={`POST /api/tools/batch
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{
  "tools": [
    { "name": "search_court_decisions", "params": { "query": "шахрайство" } },
    { "name": "search_court_decisions", "params": { "query": "крадіжка" } },
    { "name": "get_legislation", "params": { "name": "Кримінальний кодекс", "article": "190" } }
  ]
}`}
        title="Batch Request"
      />
    </article>
  );
}
