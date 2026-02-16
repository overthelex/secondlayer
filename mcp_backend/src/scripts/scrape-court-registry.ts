/**
 * Scrape Court Decisions from reyestr.court.gov.ua
 *
 * Opens the Ukrainian court registry in a headed browser, fills the search form
 * (Цивільне + Рішення), navigates paginated results, and downloads each
 * decision's print-version HTML to disk.
 *
 * The browser is headed so the user can solve CAPTCHAs manually.
 *
 * Environment variables:
 *   MAX_DOCS      - Max documents to download (default: unlimited)
 *   MAX_PAGES     - Max result pages to process (default: 100)
 *   DOWNLOAD_DIR  - Output directory (default: ~/Downloads)
 *   DELAY_MS      - Delay between downloads in ms (default: 2000)
 *
 * Usage:
 *   npm run scrape:court
 *   MAX_DOCS=10 npm run scrape:court
 */

import { chromium, type Page, type Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MAX_DOCS = parseInt(process.env.MAX_DOCS || '0', 10) || Infinity;
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '100', 10);
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads');
const DELAY_MS = parseInt(process.env.DELAY_MS || '2000', 10);
const BASE_URL = 'https://reyestr.court.gov.ua/';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCaptcha(page: Page): Promise<void> {
  // Check if CAPTCHA modal appeared
  const captchaVisible = await page.locator('#modalcaptcha').isVisible().catch(() => false);
  if (!captchaVisible) return;

  console.log('\n⚠  CAPTCHA detected! Please solve it in the browser window.');
  console.log('   Waiting up to 5 minutes...\n');

  // Wait for the modal to disappear (user solved it) or for results to appear
  const startTime = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes

  while (Date.now() - startTime < timeout) {
    const stillVisible = await page.locator('#modalcaptcha').isVisible().catch(() => false);
    if (!stillVisible) {
      console.log('   CAPTCHA solved, continuing...\n');
      return;
    }
    await sleep(1000);
  }

  throw new Error('CAPTCHA timeout — not solved within 5 minutes');
}

async function clickMultiSelectOption(page: Page, labelText: string): Promise<boolean> {
  // These are custom multi-select dropdowns: div.multiSelectOptions > label
  // The label contains a checkbox input + text. Clicking the label toggles it.

  // First, the dropdown panel might be hidden — we need to open it by clicking the trigger.
  // Find all multiSelect containers and expand any that contain our target option.
  const containers = page.locator('.multiSelectOptions');
  const count = await containers.count();

  for (let i = 0; i < count; i++) {
    const container = containers.nth(i);
    const label = container.locator(`label:has-text("${labelText}")`);

    if (await label.count() > 0) {
      // Make sure the container is visible — if not, click its trigger to expand
      const isVisible = await container.isVisible().catch(() => false);
      if (!isVisible) {
        // The trigger is usually a sibling element before the options div
        const trigger = container.locator('..').locator('.multiSelectTrigger, .trigger, > span, > a, > div').first();
        if (await trigger.count() > 0) {
          await trigger.click();
          await sleep(300);
        }
      }

      await label.first().click();
      console.log(`  Checked: "${labelText}"`);
      return true;
    }
  }

  // Fallback: just find any label with that text in the page
  const fallbackLabel = page.locator(`.multiSelectOptions label:has-text("${labelText}")`);
  if (await fallbackLabel.count() > 0) {
    // Scroll into view and click
    await fallbackLabel.first().scrollIntoViewIfNeeded();
    await fallbackLabel.first().click();
    console.log(`  Checked (fallback): "${labelText}"`);
    return true;
  }

  console.log(`  WARNING: Could not find multi-select option "${labelText}"`);
  return false;
}

async function fillSearchForm(page: Page): Promise<void> {
  console.log('Filling search form...');

  // Wait for form to be interactive
  await page.waitForSelector('select', { timeout: 10000 });
  await sleep(1000);

  // The proceeding type and decision form use custom multi-select dropdowns:
  // div.multiSelectOptions > label (with checkbox inside)
  // We need to click the label to toggle the checkbox.

  // Select "Цивільне" — click the label inside multiSelectOptions
  await clickMultiSelectOption(page, 'Цивільне');
  await sleep(500);

  // Select "Рішення" — click the label inside multiSelectOptions
  await clickMultiSelectOption(page, 'Рішення');
  await sleep(500);

  // Set records per page to 100
  const pageSizeEl = page.locator('select[name="PagingInfo.ItemsPerPage"]');
  if (await pageSizeEl.count() > 0) {
    await pageSizeEl.selectOption('100');
    console.log('  Set page size: 100');
  }
}

async function clickSearch(page: Page): Promise<void> {
  console.log('Clicking search button...');

  // The site uses Btn_search_click() JS function to submit
  // Try calling it directly, then fall back to clicking the button element
  try {
    await page.evaluate('Btn_search_click()');
  } catch {
    // Fallback: find the search button by various selectors
    const searchBtn = page.locator(
      '#search_btn, .searchbtn, input[type="submit"], button:has-text("Пошук"), a[onclick*="Btn_search"]'
    );
    if (await searchBtn.count() > 0) {
      await searchBtn.first().click();
    } else {
      // Last resort: submit the form
      await page.locator('#login > form, form').first().evaluate((form: any) => form.submit());
    }
  }

  // Wait for CAPTCHA or results
  await sleep(3000);
  await waitForCaptcha(page);

  // Wait for results to appear — try multiple known result container selectors
  console.log('Waiting for results...');
  await page.waitForSelector(
    '.search_result, .result, table.results, #divresult, a[href*="/Review/"]',
    { timeout: 60000 }
  ).catch(() => {
    console.log('  Could not detect standard result container, continuing anyway...');
  });

  await sleep(2000);
}

async function extractDecisionLinks(page: Page): Promise<{ url: string; id: string }[]> {
  // Court registry links typically look like: /Review/12345678
  const anchors = await page.locator('a[href*="/Review/"]').all();
  const results: { url: string; id: string }[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const href = await anchor.getAttribute('href');
    if (!href) continue;
    const match = href.match(/\/Review\/(\d+)/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL.replace(/\/$/, '')}${href}`;
      results.push({ url: fullUrl, id: match[1] });
    }
  }

  return results;
}

async function downloadDecision(page: Page, browser: Browser, url: string, docId: string): Promise<boolean> {
  const filePath = path.join(DOWNLOAD_DIR, `${docId}.html`);

  // Skip if already downloaded
  if (fs.existsSync(filePath)) {
    console.log(`  [${docId}] Already exists, skipping`);
    return true;
  }

  try {
    // Open decision in a new tab
    const newPage = await browser.newPage();
    await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);

    // Try to find and click "Версія для друку" (Print version)
    const printLink = newPage.locator('a:has-text("Версія для друку"), a:has-text("версія для друку"), a[href*="prt_doc"]');

    if (await printLink.count() > 0) {
      // Get the print URL and navigate to it
      const printHref = await printLink.first().getAttribute('href');
      if (printHref) {
        const printUrl = printHref.startsWith('http') ? printHref : new URL(printHref, BASE_URL).toString();
        await newPage.goto(printUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1000);
      } else {
        await printLink.first().click();
        await sleep(2000);
      }
    }

    // Save the page HTML
    const html = await newPage.content();
    fs.writeFileSync(filePath, html, 'utf-8');
    console.log(`  [${docId}] Saved (${(html.length / 1024).toFixed(1)} KB)`);

    await newPage.close();
    return true;
  } catch (error: any) {
    console.error(`  [${docId}] Error: ${error.message}`);
    return false;
  }
}

async function goToNextPage(page: Page): Promise<boolean> {
  // Look for "next page" link — typically >, >>, or "Наступна"
  const nextBtn = page.locator(
    'a:has-text("Наступна"), a:has-text("»"), a:has-text(">"):not(:has-text(">>"))'
  );

  // Also try pagination links with specific patterns
  const paginationNext = page.locator('.pagination a.next, .pager a.next, a[title="Наступна сторінка"]');

  let clicked = false;

  if (await paginationNext.count() > 0) {
    await paginationNext.first().click();
    clicked = true;
  } else if (await nextBtn.count() > 0) {
    await nextBtn.first().click();
    clicked = true;
  }

  if (!clicked) {
    console.log('No next page button found.');
    return false;
  }

  await sleep(3000);
  await waitForCaptcha(page);
  await sleep(2000);

  return true;
}

async function main() {
  // Ensure download directory exists
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Court Registry Scraper (reyestr.court.gov.ua)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Max documents:  ${MAX_DOCS === Infinity ? 'unlimited' : MAX_DOCS}`);
  console.log(`  Max pages:      ${MAX_PAGES}`);
  console.log(`  Download dir:   ${DOWNLOAD_DIR}`);
  console.log(`  Delay:          ${DELAY_MS}ms`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'uk-UA',
  });
  const page = await context.newPage();

  let totalDownloaded = 0;
  let totalErrors = 0;

  try {
    // Navigate to court registry
    console.log('Navigating to court registry...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Fill and submit search form
    await fillSearchForm(page);
    await clickSearch(page);

    // Process pages
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (totalDownloaded >= MAX_DOCS) break;

      console.log(`\n--- Page ${pageNum} ---`);

      const links = await extractDecisionLinks(page);
      console.log(`Found ${links.length} decisions on this page`);

      if (links.length === 0) {
        console.log('No decisions found, stopping.');
        break;
      }

      // Download each decision
      for (const { url, id } of links) {
        if (totalDownloaded >= MAX_DOCS) break;

        const success = await downloadDecision(page, browser, url, id);
        if (success) {
          totalDownloaded++;
        } else {
          totalErrors++;
        }

        await sleep(DELAY_MS);
      }

      // Go to next page
      if (totalDownloaded < MAX_DOCS && pageNum < MAX_PAGES) {
        const hasNext = await goToNextPage(page);
        if (!hasNext) break;
      }
    }
  } finally {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Summary');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Downloaded:  ${totalDownloaded}`);
    console.log(`  Errors:      ${totalErrors}`);
    console.log(`  Output dir:  ${DOWNLOAD_DIR}`);
    console.log('═══════════════════════════════════════════════════════════════');

    await browser.close();
  }
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
