#!/usr/bin/env node

/**
 * Скрипт для пошуку та завантаження даних з порталу Верховної Ради України
 *
 * Джерела даних:
 *   - data.rada.gov.ua - відкриті дані (депутати, голосування, законопроекти)
 *   - zakon.rada.gov.ua - законодавство України (закони, кодекси, конституція)
 *
 * Приклади використання:
 *   node fetch_rada_dataset.js --list                    # Список наборів відкритих даних
 *   node fetch_rada_dataset.js --search конституція      # Пошук документів
 *   node fetch_rada_dataset.js --law 254к/96-вр          # Отримати закон за номером
 *   node fetch_rada_dataset.js --law constitution        # Отримати Конституцію
 *   node fetch_rada_dataset.js mps --output deputies.json
 */

const https = require("https");
const fs = require("fs");
const { URL } = require("url");
const zlib = require("zlib");

// ============================================================================
// CONSTANTS
// ============================================================================

const LIST_URL = "https://data.rada.gov.ua/ogd/list.json";
const BASE_HOST = "https://data.rada.gov.ua";
const ZAKON_HOST = "https://zakon.rada.gov.ua";

// Відомі документи для швидкого доступу
const KNOWN_LAWS = {
  constitution: "254к/96-вр",
  конституція: "254к/96-вр",
  "цивільний кодекс": "435-15",
  "кримінальний кодекс": "2341-14",
  "сімейний кодекс": "2947-14",
  "господарський кодекс": "436-15",
  "кодекс про адміністративні правопорушення": "80731-10",
  кпк: "4651-17",
  цпк: "1618-15",
};

// ============================================================================
// HTTP HELPERS
// ============================================================================

function fetchWithCompression(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RadaFetcher/1.0)",
        Accept: "text/html,application/json,*/*",
        "Accept-Encoding": "gzip, deflate, br",
      },
    };

    const req = https.get(url, options, (res) => {
      // Handle redirects
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        let redirectUrl = res.headers.location;
        // Handle relative redirects
        if (redirectUrl.startsWith("/")) {
          const parsedUrl = new URL(url);
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        }
        return fetchWithCompression(redirectUrl).then(resolve).catch(reject);
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }

      const chunks = [];
      const encoding = res.headers["content-encoding"];

      let stream = res;
      if (encoding === "gzip") {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === "deflate") {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === "br") {
        stream = res.pipe(zlib.createBrotliDecompress());
      }

      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      stream.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

async function fetchJson(url) {
  const data = await fetchWithCompression(url);
  try {
    return JSON.parse(data);
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${url}: ${err.message}`);
  }
}

// ============================================================================
// CLI PARSER
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    command: null, // list, search, law, dataset
    query: null, // search query or law ID
    datasetKey: null, // dataset ID for open data
    format: "json",
    file: null,
    output: null,
    help: false,
  };

  while (args.length) {
    const arg = args.shift();
    switch (arg) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "-l":
      case "--list":
        parsed.command = "list";
        break;
      case "-s":
      case "--search":
        parsed.command = "search";
        parsed.query = args.shift() || "";
        break;
      case "--law":
        parsed.command = "law";
        parsed.query = args.shift() || "";
        break;
      case "--format":
        parsed.format = (args.shift() || "json").toLowerCase();
        break;
      case "--file":
        parsed.file = args.shift() || null;
        break;
      case "-o":
      case "--output":
        parsed.output = args.shift() || null;
        break;
      default:
        if (!parsed.datasetKey && !arg.startsWith("-")) {
          parsed.datasetKey = arg;
          parsed.command = parsed.command || "dataset";
        }
    }
  }

  return parsed;
}

function showHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║              🇺🇦 Пошук на порталі Верховної Ради України                      ║
╚══════════════════════════════════════════════════════════════════════════════╝

ВИКОРИСТАННЯ:
  node fetch_rada_dataset.js [КОМАНДА] [ОПЦІЇ]

КОМАНДИ:
  --list, -l              Показати список наборів відкритих даних
  --search, -s <запит>    Пошук документів у законодавстві
  --law <номер>           Отримати закон за номером (напр. 254к/96-вр)
  <dataset>               Завантажити набір відкритих даних

ОПЦІЇ:
  --format <тип>          Формат даних: json, csv, xml (за замовчуванням: json)
  --output, -o <файл>     Зберегти результат у файл
  --file <назва>          Конкретний файл з набору даних
  --help, -h              Показати цю довідку

ПРИКЛАДИ:
  # Пошук документів
  node fetch_rada_dataset.js --search "конституція"
  node fetch_rada_dataset.js --search "цивільний кодекс"
  
  # Отримати конкретний закон
  node fetch_rada_dataset.js --law constitution
  node fetch_rada_dataset.js --law "254к/96-вр"
  node fetch_rada_dataset.js --law "435-15" --output civil_code.html
  
  # Відкриті дані
  node fetch_rada_dataset.js --list
  node fetch_rada_dataset.js mps --output deputies.json
  node fetch_rada_dataset.js zpr --format csv

ВІДОМІ ДОКУМЕНТИ (можна використовувати як псевдоніми):
  constitution, конституція    → Конституція України (254к/96-вр)
  цивільний кодекс             → Цивільний кодекс України (435-15)
  кримінальний кодекс          → Кримінальний кодекс України (2341-14)
  сімейний кодекс              → Сімейний кодекс України (2947-14)
  господарський кодекс         → Господарський кодекс України (436-15)
  кпк                          → Кримінальний процесуальний кодекс (4651-17)
  цпк                          → Цивільний процесуальний кодекс (1618-15)
`);
}

// ============================================================================
// OPEN DATA FUNCTIONS
// ============================================================================

function extractItems(data) {
  // New format: { item: [...] }
  if (data && Array.isArray(data.item)) {
    return data.item;
  }
  // Old format: [...]
  if (Array.isArray(data)) {
    return data;
  }
  return [];
}

function findDataset(datasets, key) {
  if (!key) return null;
  const search = key.toLowerCase();
  return datasets.find((item) => {
    const id = (item.id || "").toString().toLowerCase();
    const guid = (item.guid || "").toString().toLowerCase();
    const title = (item.title || "").toString().toLowerCase();
    return id === search || guid === search || title.includes(search);
  });
}

function buildAbsoluteUrl(path) {
  try {
    return new URL(path, BASE_HOST).toString();
  } catch {
    return null;
  }
}

async function listDatasets() {
  console.log(`\n📂 Завантаження реєстру: ${LIST_URL}\n`);
  const data = await fetchJson(LIST_URL);
  const datasets = extractItems(data);

  if (datasets.length === 0) {
    throw new Error("Реєстр порожній або змінився формат даних");
  }

  console.log(`Знайдено ${datasets.length} наборів даних:\n`);
  console.log("─".repeat(80));

  datasets.forEach((d) => {
    const id = d.id || d.guid || "unknown";
    const title = d.title || "без назви";
    const path = d.path || "n/a";
    console.log(`  📁 ${id.padEnd(12)} │ ${title}`);
    console.log(`     ${"".padEnd(12)} │ path: ${path}`);
  });

  console.log("─".repeat(80));
  console.log(
    "\n💡 Використайте: node fetch_rada_dataset.js <id> для завантаження\n"
  );
}

async function downloadDataset(datasetKey, opts) {
  console.log(`\n📂 Завантаження реєстру...`);
  const data = await fetchJson(LIST_URL);
  const datasets = extractItems(data);

  const dataset = findDataset(datasets, datasetKey);
  if (!dataset) {
    throw new Error(`Набір даних "${datasetKey}" не знайдено`);
  }

  console.log(`\n✅ Знайдено: ${dataset.title || dataset.id}`);
  console.log(`   Path: ${dataset.path || "n/a"}`);
  console.log(`   Formats: ${dataset.format || "n/a"}`);

  // Build download URL
  let downloadUrl = null;

  if (opts.file) {
    if (/^https?:\/\//i.test(opts.file)) {
      downloadUrl = opts.file;
    } else if (dataset.path) {
      const joined = `${dataset.path.replace(/\\/g, "/").replace(/\/+$/, "")}/${
        opts.file
      }`;
      downloadUrl = buildAbsoluteUrl(joined);
    }
  }

  if (!downloadUrl && dataset.path) {
    const guessed = `${dataset.path
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")}/list.${opts.format}`;
    downloadUrl = buildAbsoluteUrl(guessed);
  }

  if (!downloadUrl) {
    throw new Error(
      "Не вдалося визначити URL для завантаження. Спробуйте --file <назва>"
    );
  }

  console.log(`\n📥 Завантаження: ${downloadUrl}`);
  const content = await fetchWithCompression(downloadUrl);

  if (opts.output) {
    fs.writeFileSync(opts.output, content);
    console.log(`\n✅ Збережено у ${opts.output}`);
  } else {
    console.log("\n📄 Перші 1500 символів:\n");
    console.log("─".repeat(80));
    console.log(content.slice(0, 1500));
    console.log("─".repeat(80));
  }
}

// ============================================================================
// LEGISLATION FUNCTIONS
// ============================================================================

function encodeLawId(id) {
  // Encode each part separately to preserve slashes
  return id
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function resolveLawAlias(query) {
  const normalized = query.toLowerCase().trim();
  return KNOWN_LAWS[normalized] || query;
}

async function searchLaws(query) {
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `${ZAKON_HOST}/laws/main/a?find=1&text=${encodedQuery}`;

  console.log(`\n🔍 Пошук: "${query}"`);
  console.log(`   URL: ${searchUrl}\n`);

  const html = await fetchWithCompression(searchUrl);

  // Check if redirected directly to a document (single exact match)
  const titleMatch = html.match(/<title>([^|<]+)/);
  const pageTitle = titleMatch ? titleMatch[1].trim() : "";

  // If page title contains the search query and shows a specific document
  if (
    pageTitle &&
    !pageTitle.includes("пошук") &&
    html.includes('class="page-header"')
  ) {
    const idMatch =
      html.match(/Ідентифікатор[^>]*>([^<]+)/i) ||
      html.match(/№\s*<strong>([^<]+)<\/strong>/);
    const docId = idMatch ? idMatch[1].trim() : "";

    console.log(`✅ Знайдено точний збіг:\n`);
    console.log("─".repeat(80));
    console.log(`  📜 ${pageTitle}`);
    if (docId) {
      console.log(`     ID: ${docId}`);
      console.log(`     URL: ${ZAKON_HOST}/laws/main/${encodeLawId(docId)}`);
    }
    console.log("─".repeat(80));
    console.log(
      `\n💡 Використайте: node fetch_rada_dataset.js --law "${
        docId || query
      }" для завантаження\n`
    );
    return;
  }

  // Extract search results from list
  const results = [];

  // Pattern for search result links: /laws/show/ID or /laws/main/ID
  const regex =
    /href="[^"]*\/laws\/show\/([^"#]+)"[^>]*>|<a[^>]*href="[^"]*\/laws\/main\/([^"#]+)"[^>]*class="[^"]*doc[^"]*"[^>]*>([^<]+)/gi;
  let match;

  const seen = new Set();

  // Also try to find document entries in search results
  const docRegex =
    /href="(?:https?:\/\/zakon\.rada\.gov\.ua)?\/laws\/show\/([^"#]+)"[^>]*>/gi;
  while ((match = docRegex.exec(html)) !== null) {
    let id = decodeURIComponent(match[1])
      .replace(/\/$/, "")
      .replace(/\/print$/, "");

    // Skip navigation/menu items
    if (seen.has(id)) continue;
    if (
      /^(a|nn|d|perv|groups|koms|termin|eurovoc|klas|days|rules|contact|cookies|privacy|meta|index)$/i.test(
        id
      )
    )
      continue;

    seen.add(id);
    results.push({ id, title: "" });
  }

  // Try to get titles for found IDs
  const titleRegex =
    /<a[^>]*href="[^"]*\/laws\/(?:show|main)\/([^"#]+)"[^>]*>([^<]{10,})<\/a>/gi;
  while ((match = titleRegex.exec(html)) !== null) {
    const id = decodeURIComponent(match[1])
      .replace(/\/$/, "")
      .replace(/\/print$/, "");
    const title = match[2].trim();

    // Update title for existing result
    const existing = results.find((r) => r.id === id);
    if (existing && !existing.title && title.length > 5) {
      existing.title = title;
    }
  }

  // Filter results with meaningful content
  const filteredResults = results.filter((r) => r.id && r.id.length > 2);

  if (filteredResults.length === 0) {
    console.log("❌ Нічого не знайдено");
    console.log(
      "💡 Спробуйте інший пошуковий запит або використайте --law з відомим номером документа"
    );
    return;
  }

  console.log(`✅ Знайдено ${filteredResults.length} результатів:\n`);
  console.log("─".repeat(80));

  filteredResults.slice(0, 25).forEach((r, i) => {
    const title = r.title || `Документ ${r.id}`;
    console.log(`  ${(i + 1).toString().padStart(2)}. ${title}`);
    console.log(`      ID: ${r.id}`);
    console.log(`      URL: ${ZAKON_HOST}/laws/show/${encodeLawId(r.id)}`);
    console.log();
  });

  console.log("─".repeat(80));
  console.log(
    `\n💡 Використайте: node fetch_rada_dataset.js --law "<ID>" для отримання документа\n`
  );
}

async function fetchLaw(lawId, opts) {
  const resolvedId = resolveLawAlias(lawId);
  const encodedId = encodeLawId(resolvedId);

  const urls = {
    card: `${ZAKON_HOST}/laws/card/${encodedId}`,
    main: `${ZAKON_HOST}/laws/main/${encodedId}`,
    text: `${ZAKON_HOST}/laws/show/${encodedId}`,
  };

  console.log(`\n📜 Документ: ${resolvedId}`);
  console.log(`   Картка: ${urls.card}`);
  console.log(`   Текст:  ${urls.main}`);

  // Fetch the main page with text
  console.log(`\n📥 Завантаження тексту...`);
  const html = await fetchWithCompression(urls.main);

  // Extract title
  const titleMatch = html.match(/<title>([^<|]+)/);
  const title = titleMatch ? titleMatch[1].trim() : resolvedId;
  console.log(`\n✅ ${title}`);

  // Extract metadata
  const dateMatch = html.match(/від\s+(\d{2}\.\d{2}\.\d{4})/);
  if (dateMatch) {
    console.log(`   Дата: ${dateMatch[1]}`);
  }

  // Count articles
  const articleCount = (html.match(/Стаття\s+\d+\./g) || []).length / 2; // Usually duplicated
  if (articleCount > 0) {
    console.log(`   Статей: ~${Math.round(articleCount)}`);
  }

  if (opts.output) {
    fs.writeFileSync(opts.output, html);
    console.log(
      `\n✅ Збережено у ${opts.output} (${(html.length / 1024).toFixed(1)} KB)`
    );
  } else {
    // Extract and show text preview
    console.log("\n📄 Попередній перегляд:\n");
    console.log("─".repeat(80));

    // Try to extract article text
    const articleRegex = /<span class=rvts\d+>(Стаття \d+\.)<\/span>([^<]+)/g;
    const articles = [];
    let articleMatch;
    while (
      (articleMatch = articleRegex.exec(html)) !== null &&
      articles.length < 3
    ) {
      const articleNum = articleMatch[1];
      const articleText = articleMatch[2].trim();
      if (articleText.length > 10) {
        articles.push(
          `  ${articleNum} ${articleText.slice(0, 150)}${
            articleText.length > 150 ? "..." : ""
          }`
        );
      }
    }

    if (articles.length > 0) {
      articles.forEach((a) => console.log(a));
    } else {
      // Try to extract paragraph text
      const paraRegex = /class="rvps\d*"[^>]*>([^<]{30,})/g;
      const paras = [];
      let paraMatch;
      while ((paraMatch = paraRegex.exec(html)) !== null && paras.length < 3) {
        const text = paraMatch[1].trim();
        if (
          text.length > 30 &&
          !text.includes("РАДА") &&
          !text.includes("Картка")
        ) {
          paras.push(
            `  ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`
          );
        }
      }

      if (paras.length > 0) {
        paras.forEach((p) => console.log(p));
      } else {
        // Last fallback: extract any meaningful text
        const mainContent = html.match(
          /<div[^>]*id="article"[^>]*>([\s\S]*?)<\/div>/
        );
        if (mainContent) {
          const cleanText = mainContent[1]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 500);
          console.log(`  ${cleanText}...`);
        } else {
          console.log(
            "  [Текст документа завантажено. Використайте --output для збереження]"
          );
        }
      }
    }

    console.log("─".repeat(80));
    console.log(
      `\n💡 Використайте --output <файл> для збереження повного тексту\n`
    );
  }

  return { title, id: resolvedId, urls };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    return;
  }

  switch (args.command) {
    case "list":
      await listDatasets();
      break;

    case "search":
      if (!args.query) {
        throw new Error("Вкажіть пошуковий запит: --search <запит>");
      }
      await searchLaws(args.query);
      break;

    case "law":
      if (!args.query) {
        throw new Error("Вкажіть номер закону: --law <номер>");
      }
      await fetchLaw(args.query, { output: args.output });
      break;

    case "dataset":
      await downloadDataset(args.datasetKey, {
        format: args.format,
        file: args.file,
        output: args.output,
      });
      break;

    default:
      showHelp();
  }
}

main().catch((err) => {
  console.error(`\n❌ Помилка: ${err.message}\n`);
  process.exit(1);
});
