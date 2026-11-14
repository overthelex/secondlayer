import type { AppLanguage } from '../../stores/localeStore';

export interface AboutCopy {
  metaTitle: string;
  metaDescription: string;
  back: string;
  hero: { kicker: string; headline: string; lead: string };
  problem: { title: string; body: string };
  audience: {
    title: string;
    items: { title: string; body: string }[];
  };
  market: { title: string; body: string };
  differentiation: { title: string; body: string };
  geography: { title: string; body: string };
  legal: { title: string; intro: string; lines: string[] };
  ctaTry: string;
  ctaTeam: string;
}

const en: AboutCopy = {
  metaTitle: 'About — LEX | AI legal intelligence for Ukraine and beyond',
  metaDescription:
    'LEX is the AI platform built by SecondLayer that turns 120M+ Ukrainian court decisions, full legislation, parliament records and 41M+ open-data registry records into structured, citation-backed answers in seconds.',
  back: 'Back',
  hero: {
    kicker: 'About SecondLayer',
    headline: 'AI-powered legal intelligence for Ukraine and beyond.',
    lead:
      'LEX is the AI platform built and operated by SecondLayer, a Ukrainian legal-tech company. We turn the entire Ukrainian legal corpus — 120 million court decisions, the full legislative code with amendment history, parliament voting records, and 41 million open-data registry records — into structured, citation-backed answers that arrive in seconds instead of days.',
  },
  problem: {
    title: 'The problem we solve',
    body:
      'Ukrainian legal practice runs on tools designed in the 2000s. The two largest incumbents (LIGA:ZAKON and ZakonOnline) are keyword databases with no semantic search, no AI, no analytics, no API. A practising lawyer who needs to research case law for a single matter spends 2–3 full business days digging through court records by hand. Generic LLM chatbots fill some of that gap but hallucinate, do not understand Ukrainian legal specifics, and cannot cite sources reliably.',
  },
  audience: {
    title: 'Who we serve',
    items: [
      { title: 'Law firms & solo practitioners', body: 'Semantic search, judge analytics, case-strategy generation, document drafting.' },
      { title: 'In-house & corporate counsel', body: 'Compliance research, contract analysis, regulatory monitoring.' },
      { title: 'Compliance & legal-ops teams', body: 'Reproducible, auditable AI-assisted analysis with source citations.' },
      { title: 'Legal-tech & fintech platforms', body: 'Embedded AI legal layer via API and MCP (Model Context Protocol).' },
      { title: 'Government & public sector', body: 'Court analytics, beneficial-ownership investigation, sanctions screening.' },
      { title: 'Academic & research', body: 'Bulk access to Ukrainian case law and legislation for empirical legal research.' },
    ],
  },
  market: {
    title: 'Market context',
    body:
      'Ukraine has 60,000+ practising lawyers, ~6,000 licensed attorneys, ~5,000 law firms, and 10,000+ corporate legal departments. The global legal-AI market is $500M+ and growing 28% YoY. Our serviceable market in Ukraine and CEE is conservatively $50M. We are the first and only platform in Ukraine to combine AI-native semantic search with the full national legal corpus and live state-registry integration.',
  },
  differentiation: {
    title: 'How we are different',
    body:
      'We are not a generic chatbot wrapper. Every recommendation drills down to the underlying court decision or legislative article. A built-in HallucinationGuard validates every citation against the source before it reaches the user. Authority weighting (instance, citation graph, motivation density, overrule status) ranks results so the lawyer immediately sees which positions are load-bearing and which are noise.',
  },
  geography: {
    title: 'Where we operate',
    body:
      'Headquartered in Kyiv, Ukraine. Production runs on our own server infrastructure in Kyiv behind Cloudflare. Active expansion into European jurisdictions — UK, Spain, Germany, Netherlands, France, Estonia — with country-specific data-source pages already shipped.',
  },
  legal: {
    title: "Contacts and legal details",
    intro: "The LEX service is provided under the public offer by:",
    lines: ["Sole proprietor (ФОП) Ihor Kyrychenko", "Tax number (РНОКПП): 2967214056", "Address: 19 Levka Lukianenka St, apt. 110, Kyiv 04207, Ukraine", "Email: info@legal.org.ua"],
  },
  ctaTry: 'Try LEX',
  ctaTeam: 'Meet the team',
};

const uk: AboutCopy = {
  metaTitle: 'Про нас — LEX | AI-аналітика українського права',
  metaDescription:
    'LEX — AI-платформа SecondLayer, що перетворює 120M+ судових рішень, повне законодавство, голосування парламенту та 41M+ записів відкритих реєстрів на структуровані відповіді з посиланнями за секунди.',
  back: 'Назад',
  hero: {
    kicker: 'Про SecondLayer',
    headline: 'AI-платформа для юридичної аналітики України та інших юрисдикцій.',
    lead:
      'LEX — AI-платформа, яку розробляє і підтримує SecondLayer, українська legal-tech компанія. Ми перетворюємо весь український правовий корпус — 120 мільйонів судових рішень, повне законодавство з історією змін, голосування парламенту та 41 мільйон записів відкритих реєстрів — на структуровані, підкріплені цитатами відповіді, які приходять за секунди замість днів.',
  },
  problem: {
    title: 'Яку проблему вирішуємо',
    body:
      'Українська юридична практика працює на інструментах із 2000-х. Два найбільших гравці (LIGA:ZAKON та ZakonOnline) — це keyword-бази без семантичного пошуку, без AI, без аналітики, без API. Юрист, який досліджує судову практику для однієї справи, витрачає 2–3 повних робочих дні на ручний пошук. Універсальні LLM-чатботи частково закривають цей gap, але галюцинують, не розуміють української специфіки та не дають надійних посилань на джерела.',
  },
  audience: {
    title: 'Кого обслуговуємо',
    items: [
      { title: 'Юридичні фірми та адвокати', body: 'Семантичний пошук, аналітика суддів, генерація стратегій, підготовка документів.' },
      { title: 'In-house та корпоративні юристи', body: 'Комплаєнс-дослідження, аналіз контрактів, моніторинг регулювання.' },
      { title: 'Compliance та legal-ops', body: 'Відтворювана, перевірювана AI-аналітика з посиланнями на першоджерела.' },
      { title: 'Legal-tech та fintech', body: 'Вбудований AI-шар через API та MCP (Model Context Protocol).' },
      { title: 'Державний сектор', body: 'Судова аналітика, перевірка кінцевих бенефіціарів, скринінг санкцій.' },
      { title: 'Освіта та дослідження', body: 'Bulk-доступ до української практики й законодавства для емпіричних правових досліджень.' },
    ],
  },
  market: {
    title: 'Контекст ринку',
    body:
      'В Україні 60 000+ практикуючих юристів, ~6 000 ліцензованих адвокатів, ~5 000 юридичних фірм та 10 000+ корпоративних юридичних департаментів. Світовий ринок legal-AI — $500М+ і росте 28% на рік. Наш доступний ринок (Україна + ЦСЄ) консервативно — $50М. Ми — перша і єдина платформа в Україні, яка поєднує AI-нативний семантичний пошук з повним національним правовим корпусом і живою інтеграцією державних реєстрів.',
  },
  differentiation: {
    title: 'Чим відрізняємось',
    body:
      'Ми не обгортка над чатботом. Кожна рекомендація прив\'язана до конкретного судового рішення або статті закону. Вбудований HallucinationGuard валідує кожну цитату проти першоджерела до того, як вона потрапить до користувача. Зважування за авторитетністю (інстанція, citation graph, щільність мотивації, статус скасування) ранжує результати так, щоб юрист одразу бачив, які позиції — несучі, а які — шум.',
  },
  geography: {
    title: 'Де працюємо',
    body:
      'Штаб-квартира — Київ. Продакшн — на власній серверній інфраструктурі в Києві за Cloudflare. Активне розширення в європейські юрисдикції (Велика Британія, Іспанія, Німеччина, Нідерланди, Франція, Естонія) — country-specific сторінки джерел даних уже опубліковано.',
  },
  legal: {
    title: "Контакти та реквізити",
    intro: "Послуги сервісу LEX надає за публічною офертою:",
    lines: ["ФОП Кириченко Ігор Вікторович", "РНОКПП: 2967214056", "Адреса: 04207, Україна, м. Київ, вул. Левка Лук'яненка, буд. 19, кв. 110", "Email: info@legal.org.ua"],
  },
  ctaTry: 'Спробувати LEX',
  ctaTeam: 'Команда',
};

export function getAboutCopy(language: AppLanguage): AboutCopy {
  return language === 'uk' || language === 'ru' ? uk : en;
}
