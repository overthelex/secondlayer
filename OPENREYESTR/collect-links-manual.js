#!/usr/bin/env node
/**
 * Manual link collector - processes scraped data from browser console
 * Run the scraping code in your browser's console on each page,
 * then paste the results here to generate the HTML report.
 */

const fs = require('fs').promises;
const path = require('path');

// Registry pages to process
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

// This is the code to run in the browser console on each page:
const BROWSER_CONSOLE_CODE = `
// Copy this code and run it in your browser's console on each NAIS registry page
(function() {
  const links = [];
  const paragraphs = document.querySelectorAll('p');

  paragraphs.forEach(paragraph => {
    const text = paragraph.textContent;
    const paraLinks = paragraph.querySelectorAll('a');

    if (paraLinks.length > 0) {
      paraLinks.forEach(link => {
        const href = link.getAttribute('href');
        const linkText = link.textContent.trim();

        if (href && href.includes('/files/')) {
          let type = 'file';
          if (text.includes('розширений набір даних')) {
            type = 'dataset';
          } else if (text.includes('структур') || linkText.includes('xsd')) {
            type = 'schema';
          }

          // Convert relative URL to absolute
          const absoluteUrl = new URL(href, window.location.href).href;

          links.push({
            url: absoluteUrl,
            text: linkText,
            type: type,
            description: text.substring(0, 150).trim()
          });
        }
      });
    }
  });

  console.log(JSON.stringify(links, null, 2));
  return links;
})();
`;

console.log('NAIS Open Data Manual Link Collector');
console.log('====================================\n');
console.log('Due to bot protection on nais.gov.ua, automated scraping is blocked.');
console.log('Use this manual process instead:\n');
console.log('1. Open each registry page in your browser');
console.log('2. Open Developer Console (F12)');
console.log('3. Paste the code below and press Enter');
console.log('4. Copy the JSON output');
console.log('5. Save as registry-<id>.json in this directory\n');
console.log('Browser Console Code:');
console.log('─'.repeat(80));
console.log(BROWSER_CONSOLE_CODE);
console.log('─'.repeat(80));
console.log('\nRegistry Pages:');
REGISTRY_PAGES.forEach(r => {
  console.log(`${r.id}. https://nais.gov.ua${r.url}`);
});

module.exports = { REGISTRY_PAGES };
