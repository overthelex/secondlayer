import { CodeBlock } from '@/components/CodeBlock';

export function IntroductionPage() {
  return (
    <article className="prose prose-sm max-w-none">
      <h1>Introduction</h1>
      <p>
        SecondLayer — платформа для юридичного AI-аналізу, побудована на протоколі
        Model Context Protocol (MCP). Вона надає 45 спеціалізованих інструментів для
        пошуку судових рішень, аналізу законодавства, перевірки реєстрів та роботи з
        правовими документами.
      </p>

      <h2>Що ви можете робити</h2>
      <ul>
        <li><strong>Семантичний пошук</strong> — знаходьте релевантні судові рішення за змістом, а не лише за ключовими словами</li>
        <li><strong>Аналіз законодавства</strong> — отримуйте конкретні статті, частини та розділи нормативних актів</li>
        <li><strong>Реєстри</strong> — перевіряйте юридичних осіб, бенефіціарів, боржників через OpenReyestr</li>
        <li><strong>Парламентські дані</strong> — депутати, законопроєкти, голосування через RADA API</li>
        <li><strong>Документи</strong> — завантажуйте та аналізуйте правові документи через Vault</li>
      </ul>

      <h2>Інтеграції</h2>
      <p>SecondLayer працює з будь-яким MCP-сумісним клієнтом:</p>
      <ul>
        <li><strong>Claude Code</strong> — CLI від Anthropic</li>
        <li><strong>Claude Desktop</strong> — десктопний додаток</li>
        <li><strong>REST API</strong> — пряме HTTP-підключення</li>
        <li><strong>SSE</strong> — Server-Sent Events, застарілий транспорт</li>
      </ul>

      <h2>Швидкий старт</h2>
      <p>Підключіть Claude Code до SecondLayer за 30 секунд:</p>
      <CodeBlock
        code={`claude mcp add --transport http secondlayer \\
  https://mcp.legal.org.ua/api/v2/mcp \\
  --header "Authorization: Bearer YOUR_API_KEY"`}
        title="Terminal"
      />
      <p>
        Створіть API ключ на сторінці{' '}
        <a href="/keys">API Keys</a>, підставте його замість{' '}
        <code>YOUR_API_KEY</code>, і ви готові до роботи.
      </p>
    </article>
  );
}
