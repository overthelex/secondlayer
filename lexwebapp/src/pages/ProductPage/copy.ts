import type { AppLanguage } from '../../stores/localeStore';

export interface ProductCopy {
  metaTitle: string;
  metaDescription: string;
  back: string;
  hero: { kicker: string; headline: string; lead: string };
  stage: {
    live: string;
    beta: string;
  };
  products: {
    slug: string;
    number: string;
    title: string;
    summary: string;
    features: string[];
    stage: 'live' | 'beta';
    screenshots: { src: string; caption: string }[];
  }[];
  security: {
    title: string;
    body: string;
    items: string[];
  };
  infra: {
    title: string;
    items: { label: string; value: string }[];
  };
  pricing: {
    title: string;
    plans: { name: string; price: string }[];
    note: string;
  };
  cta: {
    title: string;
    subtitle: string;
    primary: string;
    secondary: string;
  };
}

const en: ProductCopy = {
  metaTitle: 'Product — LEX | AI legal platform',
  metaDescription:
    'LEX bundles five products around the Ukrainian legal corpus: AI research & drafting, state-registry OSINT, parliament analytics, an attorney marketplace, and MCP Connect for any LLM client.',
  back: 'Back',
  hero: {
    kicker: 'Product',
    headline: 'A single AI platform, five products, one legal corpus.',
    lead:
      'LEX is a production AI platform that turns the entire Ukrainian legal corpus into citation-backed answers. Below: what the product actually does, what stage each piece is at, and the screenshots straight from the live system.',
  },
  stage: { live: 'Live in production', beta: 'Beta' },
  products: [
    {
      slug: 'research',
      number: '01',
      title: 'AI Legal Research & Drafting',
      summary:
        'A web app where the lawyer asks a natural-language question and receives a structured, citation-backed answer in seconds.',
      features: [
        'Semantic search across 120M+ court decisions (entire ЄДРСР, since 2006).',
        'Article-level legislation retrieval with full amendment history and word-level diff.',
        'AI-generated litigation strategies. Real client case: 11-year-old enforcement matter (UAH 11.9M) — 473 documents analysed, 9 defence strategies in 15 minutes.',
        'Judge analytics — 12 000+ judge profiles with overturn rate, decision volume, peer ranking. No other Ukrainian platform offers this.',
        'Citation graph & Shepardization — track whether a precedent is still good law.',
        'Legislative monitoring with word-level diffs and customer notifications.',
      ],
      stage: 'live',
      screenshots: [
        { src: '/product-screenshots/01-hero-workflow-plan.png', caption: 'LLM-generated 7-step workflow plan from a single sentence' },
        { src: '/product-screenshots/02-workflow-execution.png', caption: 'Real-time step execution with progress' },
        { src: '/product-screenshots/03-structured-legal-analysis.png', caption: 'Structured, citation-backed legal analysis' },
        { src: '/product-screenshots/04-institutional-analysis-risks.png', caption: 'Built-in risk and limitation disclosure' },
        { src: '/product-screenshots/05-legislation-viewer.png', caption: 'Article-level legislation viewer with evidence sidebar' },
        { src: '/product-screenshots/09-judge-profile.png', caption: 'Judge profile — appointment history, statistics, instance, specialization' },
      ],
    },
    {
      slug: 'osint',
      number: '02',
      title: 'State Registry & OSINT',
      summary: 'Built into LEX and exposed via API. Live, fuzzy lookup across the Ukrainian state-registry stack.',
      features: [
        'Business entities — full ЄДРПОУ corporate registry with beneficial-ownership chains.',
        'Debtors & enforcement proceedings — official Ministry of Justice data.',
        'Notaries, judges, attorneys — official registries indexed and searchable.',
        'Open-data lookups — invalidated passports (3.1M), public-procurement spending (12.6M+), vehicle registrations (19.5M), NGOs (1.08M), financial reports (504K), VAT payers (264K), corruption / sanctions / wanted-persons / lustration / terrorist-list registries.',
      ],
      stage: 'live',
      screenshots: [
        { src: '/product-screenshots/06-osint-fop-search.png', caption: 'Fuzzy / multilingual ФОП lookup with spelling variants' },
        { src: '/product-screenshots/07-case-document-chain.png', caption: 'Document-chain tool — registry → strategy → full text' },
        { src: '/product-screenshots/08-case-info-card.png', caption: 'Final case card — court, parties, subject of dispute' },
      ],
    },
    {
      slug: 'parliament',
      number: '03',
      title: 'Parliament & Voting Analytics',
      summary: 'Verkhovna Rada bills, deputies, and voting records — live and queryable.',
      features: [
        'Bills, deputies, voting records of the Verkhovna Rada.',
        'Deputy profiles with voting history and party-loyalty metrics.',
        'Bill tracking with notifications when watched bills change status.',
      ],
      stage: 'live',
      screenshots: [],
    },
    {
      slug: 'marketplace',
      number: '04',
      title: 'Marketplace for Legal Consultations',
      summary:
        'A two-sided marketplace connecting clients with verified Ukrainian attorneys. E2EE messaging, Monobank payments (UAH and USD), escrow and audit trails.',
      features: [
        'Anchored in the official ЄРАУ (Unified Registry of Ukrainian Attorneys).',
        'E2EE consultation messaging (X25519 + AES-256-GCM).',
        'Live Monobank payments with dual UAH / USD balance system.',
        'Escrow + audit trail for every consultation.',
      ],
      stage: 'beta',
      screenshots: [
        { src: '/product-screenshots/10-attorney-registry.png', caption: 'Attorney search anchored in the official ЄРАУ registry' },
      ],
    },
    {
      slug: 'mcp',
      number: '05',
      title: 'MCP Connect — AI tools for any LLM client',
      summary:
        'LEX is the first and only Ukrainian legal platform with native MCP (Model Context Protocol) support. All 118 tools plug directly into Claude Desktop, ChatGPT, Cursor, and any MCP-compatible client.',
      features: [
        'Native MCP transport (HTTP, SSE, stdio).',
        'OAuth 2.0 authorisation supported by ChatGPT and Claude.',
        'Public developer documentation with copy-paste configs for Claude Code, Claude Desktop, Cursor.',
        'Free for individual developers; metered for enterprise.',
      ],
      stage: 'live',
      screenshots: [
        { src: '/product-screenshots/14-chatgpt-mcp-connected.png', caption: 'ChatGPT with the SecondLayer MCP connector active' },
        { src: '/product-screenshots/15-platform-api-docs.png', caption: 'Public LEX AI Platform API — 100+ tools, 3 microservices, REST/MCP/SSE' },
        { src: '/product-screenshots/alt-mcp-clients-docs.png', caption: 'Copy-paste configs for Claude Code / Claude Desktop / Cursor' },
      ],
    },
  ],
  security: {
    title: 'Security & compliance',
    body:
      'Independent security audit completed in March 2026 — 10 OWASP findings remediated, 7-layer defence-in-depth architecture.',
    items: [
      'GDPR-compliant — full export, deletion, and legal-hold pipelines.',
      'DPA available for enterprise customers.',
      'E2EE for documents and consultations (X25519 + AES-256-GCM).',
      'WebAuthn / FIDO2 / multi-factor authentication.',
      'Diia digital-ID auth — first legal-tech platform in Ukraine to support the national digital identity.',
    ],
  },
  infra: {
    title: 'Infrastructure (transparency)',
    items: [
      { label: 'Cloud', value: 'AWS (eu-central-1, Frankfurt) — backed by AWS Activate' },
      { label: 'Stack', value: 'TypeScript / Node.js 20, React 19, PostgreSQL 15 (PgBouncer), Redis 7, Qdrant, Docker, Nginx' },
      { label: 'AI providers', value: 'OpenAI GPT-4o, Anthropic Claude (via Amazon Bedrock), Voyage AI embeddings' },
      { label: 'CI/CD', value: 'Blue-green deployment with self-healing test agents on a self-hosted runner' },
    ],
  },
  pricing: {
    title: 'Pricing',
    plans: [
      { name: 'Data tools (case law, legislation, registries)', price: 'fixed price per query' },
      { name: 'AI chat', price: 'billed by actual usage' },
      { name: 'API / MCP', price: 'same per-query prices' },
      { name: 'Enterprise / on-prem / VPC', price: 'custom' },
    ],
    note: 'No subscription: top up your balance and pay per query. Full price list: legal.org.ua/pricing.',
  },
  cta: {
    title: 'Try LEX',
    subtitle: 'Live product · No subscription · Pay per query',
    primary: 'Open legal.org.ua',
    secondary: 'Book a demo',
  },
};

const uk: ProductCopy = {
  metaTitle: 'Продукт — LEX | AI-платформа для юристів',
  metaDescription:
    'LEX обʼєднує пʼять продуктів навколо українського правового корпусу: AI-дослідження, OSINT по реєстрах, аналітика парламенту, маркетплейс адвокатів та MCP Connect для будь-якого LLM-клієнта.',
  back: 'Назад',
  hero: {
    kicker: 'Продукт',
    headline: 'Одна AI-платформа, пʼять продуктів, єдиний правовий корпус.',
    lead:
      'LEX — продакшн AI-платформа, яка перетворює увесь український правовий корпус на структуровані відповіді з посиланнями. Нижче — що саме робить продукт, на якій стадії кожен модуль, і скріншоти прямо з живої системи.',
  },
  stage: { live: 'Продакшн', beta: 'Бета' },
  products: [
    {
      slug: 'research',
      number: '01',
      title: 'AI-дослідження та підготовка документів',
      summary:
        'Юрист задає питання природною мовою — отримує структуровану відповідь з посиланнями на джерела за секунди.',
      features: [
        'Семантичний пошук по 120M+ судових рішень (увесь ЄДРСР з 2006 року).',
        'Ретрів законодавства на рівні статті з повною історією змін та word-level diff.',
        'AI-генерація стратегій захисту. Реальний кейс: справа 11-річної давнини про стягнення 11.9 млн грн — проаналізовано 473 документи, згенеровано 9 стратегій за 15 хвилин.',
        'Аналітика суддів — 12 000+ профілів з відсотком скасувань, обсягом рішень, рейтингом. Жодна інша українська платформа цього не має.',
        'Citation graph та Shepardization — відстеження статусу прецеденту.',
        'Моніторинг законодавства з word-level diff та нотифікаціями.',
      ],
      stage: 'live',
      screenshots: [
        { src: '/product-screenshots/01-hero-workflow-plan.png', caption: 'LLM генерує 7-кроковий план з одного речення' },
        { src: '/product-screenshots/02-workflow-execution.png', caption: 'Виконання кроку в реальному часі з прогресом' },
        { src: '/product-screenshots/03-structured-legal-analysis.png', caption: 'Структурований правовий аналіз з посиланнями' },
        { src: '/product-screenshots/04-institutional-analysis-risks.png', caption: 'Вбудоване розкриття ризиків та обмежень' },
        { src: '/product-screenshots/05-legislation-viewer.png', caption: 'Перегляд законодавства на рівні статті з evidence-панеллю' },
        { src: '/product-screenshots/09-judge-profile.png', caption: 'Профіль судді — призначення, статистика, інстанція, спеціалізація' },
      ],
    },
    {
      slug: 'osint',
      number: '02',
      title: 'Державні реєстри та OSINT',
      summary: 'Вбудовано в LEX і доступно через API. Жива нечітка перевірка по українському реєстровому стеку.',
      features: [
        'Юридичні особи — повний ЄДРПОУ з ланцюгами кінцевих бенефіціарів.',
        'Боржники та виконавчі провадження — офіційні дані Мінʼюсту.',
        'Нотаріуси, судді, адвокати — офіційні реєстри.',
        'Відкриті дані — недійсні паспорти (3.1M), публічні витрати (12.6M+), транспортні засоби (19.5M), громадські організації (1.08M), фінансові звіти (504K), платники ПДВ (264K), реєстри корупції / санкцій / розшуку / люстрації / терористичних списків.',
      ],
      stage: 'live',
      screenshots: [
        { src: '/product-screenshots/06-osint-fop-search.png', caption: 'Нечіткий / багатомовний пошук ФОП з варіантами написання' },
        { src: '/product-screenshots/07-case-document-chain.png', caption: 'Інструмент document-chain — реєстр → стратегія → повний текст' },
        { src: '/product-screenshots/08-case-info-card.png', caption: 'Картка справи — суд, сторони, предмет спору' },
      ],
    },
    {
      slug: 'parliament',
      number: '03',
      title: 'Парламент та аналітика голосувань',
      summary: 'Законопроєкти, депутати та голосування Верховної Ради — живі та доступні для запитів.',
      features: [
        'Законопроєкти, депутати, голосування Верховної Ради.',
        'Профілі депутатів з історією голосувань та партійною лояльністю.',
        'Трекінг законопроєктів з нотифікаціями про зміну статусу.',
      ],
      stage: 'live',
      screenshots: [],
    },
    {
      slug: 'marketplace',
      number: '04',
      title: 'Маркетплейс юридичних консультацій',
      summary:
        'Двосторонній маркетплейс, що звʼязує клієнтів з верифікованими українськими адвокатами. E2EE-повідомлення, оплата через Monobank (UAH та USD), escrow та audit trail.',
      features: [
        'Прив\'язаний до офіційного ЄРАУ (Єдиний реєстр адвокатів України).',
        'E2EE-повідомлення (X25519 + AES-256-GCM).',
        'Жива оплата через Monobank з dual UAH/USD балансом.',
        'Escrow + audit trail для кожної консультації.',
      ],
      stage: 'beta',
      screenshots: [
        { src: '/product-screenshots/10-attorney-registry.png', caption: 'Пошук адвокатів на базі офіційного ЄРАУ' },
      ],
    },
    {
      slug: 'mcp',
      number: '05',
      title: 'MCP Connect — AI-інструменти для будь-якого LLM-клієнта',
      summary:
        'LEX — перша і єдина українська юридична платформа з нативною підтримкою MCP. Усі 118 інструментів підключаються до Claude Desktop, ChatGPT, Cursor та будь-якого MCP-клієнта.',
      features: [
        'Нативний MCP-транспорт (HTTP, SSE, stdio).',
        'Авторизація через OAuth 2.0 — підтримка ChatGPT і Claude.',
        'Публічна dev-документація з copy-paste конфігами для Claude Code, Claude Desktop, Cursor.',
        'Безкоштовно для індивідуальних розробників, metered для enterprise.',
      ],
      stage: 'live',
      screenshots: [
        { src: '/product-screenshots/14-chatgpt-mcp-connected.png', caption: 'ChatGPT з активним SecondLayer MCP-конектором' },
        { src: '/product-screenshots/15-platform-api-docs.png', caption: 'Публічна LEX AI Platform API — 100+ інструментів, 3 сервіси, REST/MCP/SSE' },
        { src: '/product-screenshots/alt-mcp-clients-docs.png', caption: 'Конфіги для Claude Code / Claude Desktop / Cursor' },
      ],
    },
  ],
  security: {
    title: 'Безпека та комплаєнс',
    body:
      'Зовнішній security-аудит завершено в березні 2026 — 10 OWASP-знахідок виправлено, 7-рівнева defence-in-depth архітектура.',
    items: [
      'GDPR — повні пайплайни експорту, видалення та legal hold.',
      'DPA для enterprise-клієнтів.',
      'E2EE для документів та консультацій (X25519 + AES-256-GCM).',
      'WebAuthn / FIDO2 / multi-factor.',
      'Авторизація через Дію — перша legal-tech платформа в Україні з нативною підтримкою.',
    ],
  },
  infra: {
    title: 'Інфраструктура (для прозорості)',
    items: [
      { label: 'Хмара', value: 'AWS (eu-central-1, Франкфурт) — підтримка AWS Activate' },
      { label: 'Стек', value: 'TypeScript / Node.js 20, React 19, PostgreSQL 15 (PgBouncer), Redis 7, Qdrant, Docker, Nginx' },
      { label: 'AI-провайдери', value: 'OpenAI GPT-4o, Anthropic Claude (через Amazon Bedrock), Voyage AI embeddings' },
      { label: 'CI/CD', value: 'Blue-green deployment з self-healing test-агентами на self-hosted runner' },
    ],
  },
  pricing: {
    title: 'Тарифи',
    plans: [
      { name: 'Інструменти даних (практика, законодавство, реєстри)', price: 'фіксована ціна за запит' },
      { name: 'AI-чат', price: 'за фактичним використанням' },
      { name: 'API / MCP', price: 'ті самі ціни за запит' },
      { name: 'Enterprise / on-prem / VPC', price: 'за домовленістю' },
    ],
    note: 'Без абонплати: поповнюєте баланс і платите за запит. Повний прайс: legal.org.ua/pricing.',
  },
  cta: {
    title: 'Спробувати LEX',
    subtitle: 'Live-продукт · Без абонплати · Оплата за запит',
    primary: 'Відкрити legal.org.ua',
    secondary: 'Demo',
  },
};

export function getProductCopy(language: AppLanguage): ProductCopy {
  return language === 'uk' || language === 'ru' ? uk : en;
}
