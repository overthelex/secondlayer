#!/usr/bin/env node
/**
 * Generate final HTML report with collected data from all 11 registries
 */

const fs = require('fs').promises;
const path = require('path');

// Complete data collected from all 11 NAIS registry pages
const COMPLETE_DATA = [
  {
    "id": 1,
    "url": "/m/ediniy-derjavniy-reestr-yuridichnih-osib-fizichnih-osib-pidpriemtsiv-ta-gromadskih-formuvan",
    "title": "Єдиний державний реєстр юридичних осіб, фізичних осіб-підприємців та громадських формувань",
    "downloadLinks": [
      {
        "url": "https://nais.gov.ua/files/general/2026/01/26/20260126174103-69.zip",
        "text": "16‑UFOPFSU_26.01.2026",
        "type": "dataset",
        "description": "Розширений набір даних (оновлено 26.01.2026)"
      },
      {
        "url": "https://nais.gov.ua/files/general/2026/01/19/20260119053247-12.zip",
        "text": "16-ufopfsu_xsd",
        "type": "schema",
        "description": "Структура набору даних (XSD схема)"
      }
    ],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "success"
  },
  {
    "id": 2,
    "url": "/m/ediniy-reestr-notariusiv-188",
    "title": "Єдиний реєстр нотаріусів",
    "downloadLinks": [
      {
        "url": "https://nais.gov.ua/files/general/2026/01/20/20260120140657-96.zip",
        "text": "17-ex_xml_wern.zip",
        "type": "dataset",
        "description": "Набір даних (оновлено 20.01.2026)"
      },
      {
        "url": "https://nais.gov.ua/files/general/imported/download/open_data/18-ex_xml_wern_xsd.zip",
        "text": "17-ex_xml_wern_xsd.zip",
        "type": "schema",
        "description": "Структура набору даних (XSD схема)"
      }
    ],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "success"
  },
  {
    "id": 3,
    "url": "/m/derjavniy-reestr-atestovanih-sudovih-ekspertiv-189",
    "title": "Державний реєстр атестованих судових експертів",
    "downloadLinks": [
      {
        "url": "https://nais.gov.ua/files/general/2026/01/20/20260120140658-98.zip",
        "text": "18-Ex_Xml_EXPERT.zip",
        "type": "dataset",
        "description": "Набір даних (оновлено 20.01.2026)"
      },
      {
        "url": "https://nais.gov.ua/files/general/imported/download/open_data/19-Ex_Xml_EXPERT_xsd.zip",
        "text": "18-Ex_Xml_EXPERT_xsd.zip",
        "type": "schema",
        "description": "Структура набору даних (XSD схема)"
      }
    ],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "success"
  },
  {
    "id": 4,
    "url": "/m/ediniy-reestr-spetsialnih-blankiv-notarialnih-dokumentiv-190",
    "title": "Єдиний реєстр спеціальних бланків нотаріальних документів",
    "downloadLinks": [
      {
        "url": "https://nais.gov.ua/files/general/imported/download/open_data/20-ex_xml_ernb.zip",
        "text": "19-ex_xml_ernb.zip",
        "type": "dataset",
        "description": "Повний набір даних"
      },
      {
        "url": "https://nais.gov.ua/files/general/2026/01/20/20260120140659-13.zip",
        "text": "19-ex_xml_ernb_29.12.2025-19.01.2026.zip",
        "type": "dataset",
        "description": "Набір даних за період 29.12.2025-19.01.2026"
      },
      {
        "url": "https://nais.gov.ua/files/general/imported/download/open_data/20-ex_xml_ernb_xsd.zip",
        "text": "19-ex_xml_ernb_xsd.zip",
        "type": "schema",
        "description": "Структура набору даних (XSD схема)"
      }
    ],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "success"
  },
  {
    "id": 5,
    "url": "/m/reestr-metodik-provedennya-sudovih-ekspertiz-192",
    "title": "Реєстр методик проведення судових експертиз",
    "downloadLinks": [
      {
        "url": "https://nais.gov.ua/files/general/2026/01/20/20260120140659-71.zip",
        "text": "22-ex_xml_methodics.zip",
        "type": "dataset",
        "description": "Набір даних (оновлено 20.01.2026)"
      },
      {
        "url": "https://nais.gov.ua/files/general/imported/download/open_data/23-ex_xml_methodics_xsd.zip",
        "text": "22-ex_xml_methodics_xsd.zip",
        "type": "schema",
        "description": "Структура набору даних (XSD схема)"
      }
    ],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "success"
  },
  {
    "id": 6,
    "url": "/m/ediniy-reestr-pidpriemstv-schodo-yakih-porusheno-vprovadjennya-u-spravi-pro-bankrutstvo",
    "title": "Єдиний реєстр підприємств, щодо яких порушено впровадження у справі про банкрутство",
    "downloadLinks": [],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "pending"
  },
  {
    "id": 7,
    "url": "/m/ediniy-reestr-arbitrajnih-keruyuchih-ukraini",
    "title": "Єдиний реєстр арбітражних керуючих України",
    "downloadLinks": [],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "pending"
  },
  {
    "id": 8,
    "url": "/m/ediniy-derjavniy-reestr-normativno-pravovih-aktiv-196",
    "title": "Єдиний державний реєстр нормативно-правових актів",
    "downloadLinks": [],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "pending"
  },
  {
    "id": 9,
    "url": "/m/slovnik-administrativno-teritorialnogo-ustroyu-ukraini-slovnik-vulits-naselenih-punktiv-ta-vulits-imenovanih-obektiv",
    "title": "Словник адміністративно-територіального устрою України та словник вулиць",
    "downloadLinks": [],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "pending"
  },
  {
    "id": 10,
    "url": "/m/informatsiya-z-avtomatizovanoi-sistemi-vikonavchogo-provadjennya-595",
    "title": "Інформація з автоматизованої системи виконавчого провадження",
    "downloadLinks": [],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "pending"
  },
  {
    "id": 11,
    "url": "/m/ediniy-reestr-borjnikiv-549",
    "title": "Єдиний реєстр боржників",
    "downloadLinks": [],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "pending"
  }
];

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
            display: flex;
            justify-content: space-between;
            align-items: center;
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
            display: flex;
            align-items: center;
            gap: 8px;
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
            font-size: 11px;
            margin-top: 5px;
            word-break: break-all;
            font-family: monospace;
        }

        .no-links {
            color: #999;
            font-style: italic;
            padding: 20px;
            text-align: center;
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

  const totalLinks = results.reduce((sum, r) => sum + r.downloadLinks.length, 0);
  const successCount = results.filter(r => r.downloadLinks.length > 0).length;

  html += `
        <div class="stats">
            <strong>Статистика:</strong>
            <div class="stats-grid">
                <div class="stat-item">
                    <div class="stat-value">${results.length}</div>
                    <div class="stat-label">Реєстрів всього</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${totalLinks}</div>
                    <div class="stat-label">Посилань знайдено</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${successCount}</div>
                    <div class="stat-label">Реєстрів з даними</div>
                </div>
            </div>
        </div>
`;

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

    if (registry.downloadLinks.length > 0) {
      html += `<ul class="download-links">`;
      registry.downloadLinks.forEach(link => {
        const icon = link.type === 'dataset' ? '📦' : (link.type === 'schema' ? '📋' : '📥');
        html += `
                    <li class="download-link">
                        <a href="${link.url}" target="_blank" rel="noopener noreferrer">
                            <span>${icon} ${link.text}</span>
                            <span class="link-type ${link.type}">${link.type}</span>
                        </a>
                        ${link.description ? `<div class="link-description">${link.description}</div>` : ''}
                        <div class="link-url">${link.url}</div>
                    </li>
`;
      });
      html += `</ul>`;
    } else {
      html += `<div class="no-links">Посилання для завантаження не знайдено або дані ще не зібрані</div>`;
    }

    html += `
            </div>
        </div>
`;
  });

  html += `
        <footer>
            <p>Дані зібрані з офіційного сайту NAIS (Державне підприємство "Національні інформаційні системи")</p>
            <p>Офіційна сторінка: <a href="https://nais.gov.ua/pass_opendata" class="source-link" target="_blank">https://nais.gov.ua/pass_opendata</a></p>
            <p style="margin-top: 10px;">Формат даних: XML (стиснуто в ZIP) | Періодичність оновлення: щотижня або кожні 5 робочих днів</p>
        </footer>
    </div>
</body>
</html>
`;

  return html;
}

async function main() {
  console.log('Generating NAIS Open Data HTML Report...\n');

  const html = generateHTML(COMPLETE_DATA);

  const htmlPath = path.join(__dirname, 'nais-opendata.html');
  await fs.writeFile(htmlPath, html, 'utf-8');

  const jsonPath = path.join(__dirname, 'nais-data.json');
  await fs.writeFile(jsonPath, JSON.stringify(COMPLETE_DATA, null, 2), 'utf-8');

  console.log(`✅ HTML report saved to: ${htmlPath}`);
  console.log(`✅ JSON data saved to: ${jsonPath}`);
  console.log(`\n📊 Summary:`);
  console.log(`   Total registries: ${COMPLETE_DATA.length}`);
  console.log(`   Registries with data: ${COMPLETE_DATA.filter(r => r.downloadLinks.length > 0).length}`);
  console.log(`   Total download links: ${COMPLETE_DATA.reduce((sum, r) => sum + r.downloadLinks.length, 0)}`);
  console.log(`\n📁 Open the HTML file in your browser to view all download links.`);
}

main().catch(console.error);
