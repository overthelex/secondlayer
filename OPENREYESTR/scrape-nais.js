#!/usr/bin/env node
/**
 * NAIS Open Data Scraper
 * Collects download links from all 11 registry pages on nais.gov.ua/pass_opendata
 */

const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

const BASE_URL = 'https://nais.gov.ua';

// All 11 registry pages to scrape
const REGISTRY_PAGES = [
  {
    id: 1,
    url: '/m/ediniy-derjavniy-reestr-yuridichnih-osib-fizichnih-osib-pidpriemtsiv-ta-gromadskih-formuvan',
    title: 'Єдиний державний реєстр юридичних осіб, фізичних осіб-підприємців та громадських формувань'
  },
  {
    id: 2,
    url: '/m/ediniy-reestr-notariusiv-188',
    title: 'Єдиний реєстр нотаріусів'
  },
  {
    id: 3,
    url: '/m/derjavniy-reestr-atestovanih-sudovih-ekspertiv-189',
    title: 'Державний реєстр атестованих судових експертів'
  },
  {
    id: 4,
    url: '/m/ediniy-reestr-spetsialnih-blankiv-notarialnih-dokumentiv-190',
    title: 'Єдиний реєстр спеціальних бланків нотаріальних документів'
  },
  {
    id: 5,
    url: '/m/reestr-metodik-provedennya-sudovih-ekspertiz-192',
    title: 'Реєстр методик проведення судових експертиз'
  },
  {
    id: 6,
    url: '/m/ediniy-reestr-pidpriemstv-schodo-yakih-porusheno-vprovadjennya-u-spravi-pro-bankrutstvo',
    title: 'Єдиний реєстр підприємств, щодо яких порушено впровадження у справі про банкрутство'
  },
  {
    id: 7,
    url: '/m/ediniy-reestr-arbitrajnih-keruyuchih-ukraini',
    title: 'Єдиний реєстр арбітражних керуючих України'
  },
  {
    id: 8,
    url: '/m/ediniy-derjavniy-reestr-normativno-pravovih-aktiv-196',
    title: 'Єдиний державний реєстр нормативно-правових актів'
  },
  {
    id: 9,
    url: '/m/slovnik-administrativno-teritorialnogo-ustroyu-ukraini-slovnik-vulits-naselenih-punktiv-ta-vulits-imenovanih-obektiv',
    title: 'Словник адміністративно-територіального устрою України та словник вулиць'
  },
  {
    id: 10,
    url: '/m/informatsiya-z-avtomatizovanoi-sistemi-vikonavchogo-provadjennya-595',
    title: 'Інформація з автоматизованої системи виконавчого провадження'
  },
  {
    id: 11,
    url: '/m/ediniy-reestr-borjnikiv-549',
    title: 'Єдиний реєстр боржників'
  }
];

/**
 * Extracts download links from a registry page
 */
async function scrapeRegistryPage(page, registry) {
  const fullUrl = BASE_URL + registry.url;

  console.log(`\nScraping ${registry.id}. ${registry.title}`);
  console.log(`URL: ${fullUrl}`);

  try {
    await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for the main content to be present
    try {
      await page.waitForSelector('p', { timeout: 5000 });
    } catch (e) {
      console.log('  Warning: Could not find content paragraphs');
    }

    // Additional wait for dynamic content
    await page.waitForTimeout(3000);

    // Extract all download links
    const downloadLinks = await page.evaluate(() => {
      const links = [];
      const paragraphs = document.querySelectorAll('p');

      paragraphs.forEach(paragraph => {
        const text = paragraph.textContent;
        const paraLinks = paragraph.querySelectorAll('a');

        if (paraLinks.length > 0) {
          paraLinks.forEach(link => {
            const href = link.getAttribute('href');
            const linkText = link.textContent.trim();

            // Only include file links (with /files/ path or relative paths to .zip files)
            if (href && (href.includes('/files/') || (href.includes('.zip') && !href.startsWith('http://') && !href.startsWith('https://')))) {
              // Determine the type based on paragraph content
              let type = 'file';
              if (text.includes('розширений набір даних')) {
                type = 'dataset';
              } else if (text.includes('структур') || text.includes('xsd')) {
                type = 'schema';
              }

              links.push({
                url: href,
                text: linkText,
                type: type,
                description: text.substring(0, 150).trim()
              });
            }
          });
        }
      });

      return links;
    });

    // Convert relative URLs to absolute URLs
    const absoluteLinks = downloadLinks.map(link => {
      let absoluteUrl = link.url;

      // If it's a relative URL, convert to absolute
      if (link.url.startsWith('../../')) {
        absoluteUrl = new URL(link.url, fullUrl).href;
      } else if (link.url.startsWith('/')) {
        absoluteUrl = BASE_URL + link.url;
      }

      return {
        ...link,
        url: absoluteUrl
      };
    });

    console.log(`Found ${absoluteLinks.length} download links`);

    return {
      ...registry,
      downloadLinks: absoluteLinks,
      scrapedAt: new Date().toISOString(),
      status: 'success'
    };

  } catch (error) {
    console.error(`Error scraping ${registry.title}:`, error.message);
    return {
      ...registry,
      downloadLinks: [],
      scrapedAt: new Date().toISOString(),
      status: 'error',
      error: error.message
    };
  }
}

/**
 * Main scraping function
 */
async function scrapeAllRegistries() {
  console.log('Starting NAIS Open Data Scraper...');
  console.log(`Scraping ${REGISTRY_PAGES.length} registry pages\n`);

  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'uk-UA',
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0'
    }
  });

  const page = await context.newPage();

  const results = [];

  for (const registry of REGISTRY_PAGES) {
    const result = await scrapeRegistryPage(page, registry);
    results.push(result);

    // Be polite - wait between requests
    await page.waitForTimeout(2000);
  }

  await browser.close();

  return results;
}

/**
 * Generate HTML report
 */
function generateHTML(results) {
  const timestamp = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });

  let html = `<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NAIS Open Data - Посилання для завантаження</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background: #f5f5f5;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }

        header {
            border-bottom: 3px solid #0066cc;
            padding-bottom: 20px;
            margin-bottom: 30px;
        }

        h1 {
            color: #0066cc;
            margin-bottom: 10px;
            font-size: 28px;
        }

        .subtitle {
            color: #666;
            font-size: 14px;
        }

        .registry {
            margin-bottom: 30px;
            border: 1px solid #e0e0e0;
            border-radius: 6px;
            overflow: hidden;
        }

        .registry-header {
            background: linear-gradient(135deg, #0066cc 0%, #0052a3 100%);
            color: white;
            padding: 15px 20px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .registry-header:hover {
            background: linear-gradient(135deg, #0052a3 0%, #004080 100%);
        }

        .registry-number {
            font-weight: bold;
            font-size: 18px;
            margin-right: 10px;
        }

        .registry-title {
            flex: 1;
            font-size: 16px;
        }

        .download-count {
            background: rgba(255,255,255,0.2);
            padding: 5px 12px;
            border-radius: 15px;
            font-size: 14px;
        }

        .registry-content {
            padding: 20px;
            background: #fafafa;
        }

        .download-links {
            list-style: none;
        }

        .download-link {
            background: white;
            border: 1px solid #e0e0e0;
            border-radius: 4px;
            padding: 12px 15px;
            margin-bottom: 10px;
            transition: all 0.2s;
        }

        .download-link:hover {
            border-color: #0066cc;
            box-shadow: 0 2px 8px rgba(0,102,204,0.1);
        }

        .download-link a {
            color: #0066cc;
            text-decoration: none;
            font-weight: 500;
            display: block;
        }

        .download-link a:hover {
            text-decoration: underline;
        }

        .link-type {
            display: inline-block;
            background: #0066cc;
            color: white;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 11px;
            margin-left: 8px;
            text-transform: uppercase;
        }

        .link-type.dataset {
            background: #4caf50;
        }

        .link-type.schema {
            background: #ff9800;
        }

        .link-description {
            color: #888;
            font-size: 12px;
            margin-top: 5px;
            font-style: italic;
        }

        .link-url {
            color: #666;
            font-size: 12px;
            margin-top: 5px;
            word-break: break-all;
        }

        .no-links {
            color: #999;
            font-style: italic;
            padding: 20px;
            text-align: center;
        }

        .error {
            background: #fff3cd;
            border: 1px solid #ffc107;
            color: #856404;
            padding: 15px;
            border-radius: 4px;
            margin-top: 10px;
        }

        .stats {
            background: #e3f2fd;
            border-left: 4px solid #0066cc;
            padding: 15px;
            margin-bottom: 30px;
            border-radius: 4px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 10px;
        }

        .stat-item {
            background: white;
            padding: 10px;
            border-radius: 4px;
        }

        .stat-value {
            font-size: 24px;
            font-weight: bold;
            color: #0066cc;
        }

        .stat-label {
            font-size: 14px;
            color: #666;
        }

        footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            text-align: center;
            color: #666;
            font-size: 14px;
        }

        .source-link {
            color: #0066cc;
            text-decoration: none;
        }

        .source-link:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📂 NAIS Open Data - Посилання для завантаження</h1>
            <div class="subtitle">
                Зібрано: ${timestamp} | Джерело: <a href="https://nais.gov.ua/pass_opendata" class="source-link" target="_blank">nais.gov.ua/pass_opendata</a>
            </div>
        </header>
`;

  // Calculate statistics
  const totalLinks = results.reduce((sum, r) => sum + r.downloadLinks.length, 0);
  const successCount = results.filter(r => r.status === 'success').length;
  const errorCount = results.filter(r => r.status === 'error').length;

  html += `
        <div class="stats">
            <strong>Статистика:</strong>
            <div class="stats-grid">
                <div class="stat-item">
                    <div class="stat-value">${REGISTRY_PAGES.length}</div>
                    <div class="stat-label">Реєстрів всього</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${totalLinks}</div>
                    <div class="stat-label">Посилань знайдено</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${successCount}</div>
                    <div class="stat-label">Успішно оброблено</div>
                </div>
                ${errorCount > 0 ? `
                <div class="stat-item">
                    <div class="stat-value" style="color: #f44336;">${errorCount}</div>
                    <div class="stat-label">Помилок</div>
                </div>
                ` : ''}
            </div>
        </div>
`;

  // Generate registry sections
  results.forEach(registry => {
    html += `
        <div class="registry">
            <div class="registry-header">
                <span class="registry-number">${registry.id}.</span>
                <span class="registry-title">${registry.title}</span>
                <span class="download-count">${registry.downloadLinks.length} ${registry.downloadLinks.length === 1 ? 'файл' : 'файлів'}</span>
            </div>
            <div class="registry-content">
`;

    if (registry.status === 'error') {
      html += `
                <div class="error">
                    ⚠️ Помилка при обробці: ${registry.error}
                </div>
`;
    }

    if (registry.downloadLinks.length > 0) {
      html += `
                <ul class="download-links">
`;
      registry.downloadLinks.forEach(link => {
        const icon = link.type === 'dataset' ? '📦' : (link.type === 'schema' ? '📋' : '📥');
        html += `
                    <li class="download-link">
                        <a href="${link.url}" target="_blank" rel="noopener noreferrer">
                            ${icon} ${link.text || 'Завантажити файл'}
                            ${link.type !== 'unknown' ? `<span class="link-type ${link.type}">${link.type}</span>` : ''}
                        </a>
                        ${link.description && link.description !== 'File download' ? `<div class="link-description">${link.description.replace(/"/g, '&quot;')}</div>` : ''}
                        <div class="link-url">${link.url}</div>
                    </li>
`;
      });
      html += `
                </ul>
`;
    } else if (registry.status !== 'error') {
      html += `
                <div class="no-links">Посилання для завантаження не знайдено</div>
`;
    }

    html += `
            </div>
        </div>
`;
  });

  html += `
        <footer>
            <p>Дані зібрані автоматично з офіційного сайту NAIS</p>
            <p>Офіційна сторінка: <a href="https://nais.gov.ua/pass_opendata" class="source-link" target="_blank">https://nais.gov.ua/pass_opendata</a></p>
        </footer>
    </div>
</body>
</html>
`;

  return html;
}

/**
 * Main execution
 */
async function main() {
  try {
    // Scrape all registries
    const results = await scrapeAllRegistries();

    // Save results as JSON
    const jsonPath = path.join(__dirname, 'nais-data.json');
    await fs.writeFile(jsonPath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\n✅ JSON data saved to: ${jsonPath}`);

    // Generate and save HTML
    const html = generateHTML(results);
    const htmlPath = path.join(__dirname, 'nais-opendata.html');
    await fs.writeFile(htmlPath, html, 'utf-8');
    console.log(`✅ HTML report saved to: ${htmlPath}`);

    // Print summary
    console.log('\n📊 Summary:');
    console.log(`   Registries processed: ${results.length}`);
    console.log(`   Total download links: ${results.reduce((sum, r) => sum + r.downloadLinks.length, 0)}`);
    console.log(`   Successful: ${results.filter(r => r.status === 'success').length}`);
    console.log(`   Errors: ${results.filter(r => r.status === 'error').length}`);

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { scrapeAllRegistries, generateHTML };
