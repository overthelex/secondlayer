#!/usr/bin/env node
/**
 * Debug script to test Playwright scraping
 */

const { chromium } = require('playwright');

async function test() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'uk-UA',
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1'
    }
  });
  const page = await context.newPage();

  const url = 'https://nais.gov.ua/m/ediniy-derjavniy-reestr-yuridichnih-osib-fizichnih-osib-pidpriemtsiv-ta-gromadskih-formuvan';

  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  console.log('Page loaded, waiting for content...');
  await page.waitForTimeout(3000);

  console.log('Extracting page info...');

  // Test 1: Check if page has content
  const pageInfo = await page.evaluate(() => {
    return {
      title: document.title,
      paragraphCount: document.querySelectorAll('p').length,
      linkCount: document.querySelectorAll('a').length,
      bodyText: document.body.textContent.substring(0, 200)
    };
  });

  console.log('\n=== Page Info ===');
  console.log(JSON.stringify(pageInfo, null, 2));

  // Test 2: Extract links
  const links = await page.evaluate(() => {
    const results = [];
    const paragraphs = document.querySelectorAll('p');

    paragraphs.forEach((p, idx) => {
      const paraLinks = p.querySelectorAll('a');
      if (paraLinks.length > 0) {
        paraLinks.forEach(link => {
          const href = link.getAttribute('href');
          if (href && href.includes('/files/')) {
            results.push({
              paragraphIndex: idx,
              text: link.textContent.trim(),
              href: href,
              paragraphText: p.textContent.substring(0, 80)
            });
          }
        });
      }
    });

    return results;
  });

  console.log('\n=== Download Links Found ===');
  console.log(JSON.stringify(links, null, 2));
  console.log(`\nTotal: ${links.length} links`);

  await browser.close();
}

test().catch(console.error);
