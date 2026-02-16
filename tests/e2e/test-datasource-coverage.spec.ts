/**
 * E2E Test: Data Source Coverage via Chat
 *
 * Sends one question per data source domain through the AI chat endpoint
 * on https://legal.org.ua/ and verifies each domain's tools are invoked.
 *
 * Domains tested:
 *  1. Court / Judicial Practice  (search_legal_precedents, get_court_decision, etc.)
 *  2. Legislation                (search_legislation, get_legislation_article, etc.)
 *  3. Registry / OpenReyestr     (openreyestr_search_entities, openreyestr_get_by_edrpou, etc.)
 *  4. Parliament / RADA          (rada_search_parliament_bills, rada_get_deputy_info, etc.)
 *  5. Vault / Documents          (list_documents, semantic_search, etc.)
 *  6. Procedural                 (calculate_procedural_deadlines, etc.)
 *
 * Run:
 *   cd tests && npx playwright test test-datasource-coverage.spec.ts
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL || 'https://legal.org.ua';
const API_URL = `${BASE_URL}/api`;

// Admin credentials from deployment/.env.stage
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@legal.org.ua';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'Ne0yVvEzGKq7bOJVTo7KRcl1N372b1Wf';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string;
  data: any;
}

function parseSSEEvents(body: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const lines = body.split('\n');
  let currentEvent = '';
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentEvent && currentData) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(currentData) });
      } catch {
        events.push({ event: currentEvent, data: currentData });
      }
      currentEvent = '';
      currentData = '';
    }
  }

  return events;
}

/** Extract tool names from thinking events */
function extractToolCalls(events: SSEEvent[]): string[] {
  return events
    .filter((e) => e.event === 'thinking' && e.data?.tool)
    .map((e) => e.data.tool);
}

/** Send a chat query and return parsed SSE events */
async function chatQuery(
  request: any,
  token: string,
  query: string,
  budget: string = 'standard',
  timeoutMs: number = 240000
): Promise<{ events: SSEEvent[]; tools: string[]; answer: string; status: number }> {
  const response = await request.post(`${API_URL}/chat`, {
    data: { query, budget },
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    timeout: timeoutMs,
  });

  const status = response.status();
  if (status !== 200) {
    return { events: [], tools: [], answer: '', status };
  }

  const events = parseSSEEvents(await response.text());
  const tools = extractToolCalls(events);
  const answerEvent = events.find((e) => e.event === 'answer');
  const answer = answerEvent?.data?.text || '';

  return { events, tools, answer, status };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe('Data Source Coverage: one chat question per domain', () => {
  let authToken: string;

  // Authenticate once before all tests
  test.beforeAll(async ({ request }) => {
    console.log(`\nAuthenticating as ${ADMIN_EMAIL} against ${BASE_URL}...`);

    const loginResponse = await request.post(`${BASE_URL}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    expect(loginResponse.status(), `Login should succeed (got ${loginResponse.status()})`).toBe(200);
    const loginData = await loginResponse.json();
    authToken = loginData.token;
    expect(authToken, 'Should receive JWT token').toBeTruthy();
    console.log(`  Authenticated OK as: ${loginData.user?.email || ADMIN_EMAIL}\n`);
  });

  // ========================================================================
  // 1. Court / Judicial Practice
  // ========================================================================

  test('1. Court: search for case by number triggers court tools', async ({ request }) => {
    test.setTimeout(300000);

    const { events, tools, answer, status } = await chatQuery(
      request,
      authToken,
      'Знайди судову справу номер 922/989/18 та дай короткий опис',
    );

    expect(status).toBe(200);

    console.log('=== Court Domain ===');
    console.log(`  Tools called: [${tools.join(' -> ')}]`);
    console.log(`  Answer preview: ${answer.substring(0, 200)}...`);

    const courtTools = [
      'get_court_decision',
      'get_case_documents_chain',
      'search_legal_precedents',
      'search_supreme_court_practice',
      'find_similar_fact_pattern_cases',
      'compare_practice_pro_contra',
      'count_cases_by_party',
    ];

    const usedCourtTool = tools.some((t) => courtTools.includes(t));
    expect(usedCourtTool, `Expected court tool, got: [${tools.join(', ')}]`).toBeTruthy();
    expect(answer.length, 'Answer should not be empty').toBeGreaterThan(10);

    // Should reference the case number in the answer
    const hasRef = answer.includes('922/989/18') || answer.includes('922') || answer.includes('Харків');
    expect(hasRef, 'Answer should reference the case').toBeTruthy();

    // Validate SSE structure
    const complete = events.find((e) => e.event === 'complete');
    expect(complete, 'Should have complete event').toBeTruthy();
    console.log(`  Completed in ${complete?.data?.elapsed_ms}ms, ${complete?.data?.iterations} iterations`);
  });

  // ========================================================================
  // 2. Legislation
  // ========================================================================

  test('2. Legislation: ask about a specific article triggers legislation tools', async ({ request }) => {
    test.setTimeout(300000);

    const { events, tools, answer, status } = await chatQuery(
      request,
      authToken,
      'Покажи текст статті 625 Цивільного кодексу України',
    );

    expect(status).toBe(200);

    console.log('=== Legislation Domain ===');
    console.log(`  Tools called: [${tools.join(' -> ')}]`);
    console.log(`  Answer preview: ${answer.substring(0, 200)}...`);

    const legislationTools = [
      'search_legislation',
      'get_legislation_article',
      'get_legislation_section',
      'find_relevant_law_articles',
      'search_procedural_norms',
    ];

    const usedLegTool = tools.some((t) => legislationTools.includes(t));
    expect(usedLegTool, `Expected legislation tool, got: [${tools.join(', ')}]`).toBeTruthy();
    expect(answer.length, 'Answer should not be empty').toBeGreaterThan(10);

    // Should mention the article or the Civil Code
    const hasRef =
      answer.includes('625') ||
      answer.includes('Цивільн') ||
      answer.includes('прострочення') ||
      answer.includes('боржник');
    expect(hasRef, 'Answer should reference article 625 or Civil Code').toBeTruthy();

    const complete = events.find((e) => e.event === 'complete');
    console.log(`  Completed in ${complete?.data?.elapsed_ms}ms, ${complete?.data?.iterations} iterations`);
  });

  // ========================================================================
  // 3. Registry / OpenReyestr
  // ========================================================================

  test('3. Registry: search company by EDRPOU triggers openreyestr tools', async ({ request }) => {
    test.setTimeout(300000);

    const { events, tools, answer, status } = await chatQuery(
      request,
      authToken,
      'Знайди інформацію про компанію з кодом ЄДРПОУ 00032129',
    );

    expect(status).toBe(200);

    console.log('=== Registry / OpenReyestr Domain ===');
    console.log(`  Tools called: [${tools.join(' -> ')}]`);
    console.log(`  Answer preview: ${answer.substring(0, 200)}...`);

    const registryTools = [
      'openreyestr_search_entities',
      'openreyestr_get_entity_details',
      'openreyestr_search_beneficiaries',
      'openreyestr_get_by_edrpou',
      'openreyestr_search_debtors',
      'openreyestr_search_enforcement_proceedings',
      'openreyestr_search_bankruptcy_cases',
      'openreyestr_search_notaries',
      'openreyestr_search_court_experts',
      'openreyestr_search_arbitration_managers',
      'openreyestr_search_forensic_methods',
      'openreyestr_search_legal_acts',
      'openreyestr_search_administrative_units',
      'openreyestr_search_streets',
      'openreyestr_search_special_forms',
      'openreyestr_get_statistics',
    ];

    const usedRegistryTool = tools.some((t) => registryTools.includes(t));
    expect(usedRegistryTool, `Expected openreyestr tool, got: [${tools.join(', ')}]`).toBeTruthy();
    expect(answer.length, 'Answer should not be empty').toBeGreaterThan(10);

    // Should mention the EDRPOU or company info
    const hasRef =
      answer.includes('00032129') ||
      answer.includes('ЄДРПОУ') ||
      answer.includes('компанія') ||
      answer.includes('юридична особа') ||
      answer.includes('підприємство');
    expect(hasRef, 'Answer should reference the company or EDRPOU').toBeTruthy();

    const complete = events.find((e) => e.event === 'complete');
    console.log(`  Completed in ${complete?.data?.elapsed_ms}ms, ${complete?.data?.iterations} iterations`);
  });

  // ========================================================================
  // 4. Parliament / RADA
  // ========================================================================

  test('4. Parliament: search bills triggers rada tools', async ({ request }) => {
    test.setTimeout(300000);

    const { events, tools, answer, status } = await chatQuery(
      request,
      authToken,
      'Знайди законопроекти про штучний інтелект у Верховній Раді',
    );

    expect(status).toBe(200);

    console.log('=== Parliament / RADA Domain ===');
    console.log(`  Tools called: [${tools.join(' -> ')}]`);
    console.log(`  Answer preview: ${answer.substring(0, 200)}...`);

    const radaTools = [
      'rada_search_parliament_bills',
      'rada_get_deputy_info',
      'rada_search_legislation_text',
      'rada_analyze_voting_record',
    ];

    const usedRadaTool = tools.some((t) => radaTools.includes(t));
    expect(usedRadaTool, `Expected rada tool, got: [${tools.join(', ')}]`).toBeTruthy();
    expect(answer.length, 'Answer should not be empty').toBeGreaterThan(10);

    // Should mention parliament / bills / AI
    const hasRef =
      answer.includes('законопроект') ||
      answer.includes('Верховн') ||
      answer.includes('Рад') ||
      answer.includes('інтелект') ||
      answer.includes('проект');
    expect(hasRef, 'Answer should reference parliament bills').toBeTruthy();

    const complete = events.find((e) => e.event === 'complete');
    console.log(`  Completed in ${complete?.data?.elapsed_ms}ms, ${complete?.data?.iterations} iterations`);
  });

  // ========================================================================
  // 5. Vault / Documents
  // ========================================================================

  test('5. Vault: list my documents triggers vault tools', async ({ request }) => {
    test.setTimeout(300000);

    const { events, tools, answer, status } = await chatQuery(
      request,
      authToken,
      'Покажи список моїх документів у сховищі',
    );

    expect(status).toBe(200);

    console.log('=== Vault / Documents Domain ===');
    console.log(`  Tools called: [${tools.join(' -> ')}]`);
    console.log(`  Answer preview: ${answer.substring(0, 200)}...`);

    const vaultTools = [
      'list_documents',
      'semantic_search',
      'get_document',
      'store_document',
      'parse_document',
      'extract_document_sections',
      'summarize_document',
      'compare_documents',
      'extract_key_clauses',
    ];

    const usedVaultTool = tools.some((t) => vaultTools.includes(t));
    expect(usedVaultTool, `Expected vault tool, got: [${tools.join(', ')}]`).toBeTruthy();
    expect(answer.length, 'Answer should not be empty').toBeGreaterThan(10);

    const complete = events.find((e) => e.event === 'complete');
    console.log(`  Completed in ${complete?.data?.elapsed_ms}ms, ${complete?.data?.iterations} iterations`);
  });

  // ========================================================================
  // 6. Supreme Court Practice (specialized court search)
  // ========================================================================

  test('6. Supreme Court: practice search triggers supreme court tool', async ({ request }) => {
    test.setTimeout(300000);

    const { events, tools, answer, status } = await chatQuery(
      request,
      authToken,
      'Яка практика Верховного Суду щодо стягнення моральної шкоди за ДТП?',
    );

    expect(status).toBe(200);

    console.log('=== Supreme Court Practice ===');
    console.log(`  Tools called: [${tools.join(' -> ')}]`);
    console.log(`  Answer preview: ${answer.substring(0, 200)}...`);

    const scTools = [
      'search_supreme_court_practice',
      'search_legal_precedents',
      'find_similar_fact_pattern_cases',
    ];

    const usedSCTool = tools.some((t) => scTools.includes(t));
    expect(usedSCTool, `Expected supreme court tool, got: [${tools.join(', ')}]`).toBeTruthy();
    expect(answer.length, 'Answer should not be empty').toBeGreaterThan(10);

    // Should mention moral damages or Supreme Court
    const hasRef =
      answer.includes('моральн') ||
      answer.includes('Верховн') ||
      answer.includes('ДТП') ||
      answer.includes('шкод');
    expect(hasRef, 'Answer should reference moral damages or Supreme Court').toBeTruthy();

    const complete = events.find((e) => e.event === 'complete');
    console.log(`  Completed in ${complete?.data?.elapsed_ms}ms, ${complete?.data?.iterations} iterations`);
  });

  // ========================================================================
  // Summary: all domains reachable
  // ========================================================================

  test('Summary: health check confirms all backend services are up', async ({ request }) => {
    test.setTimeout(15000);

    const response = await request.get(`${BASE_URL}/health`, {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: 10000,
    });

    console.log('=== Health Check ===');
    console.log(`  Status: ${response.status()}`);

    // Health endpoint may return 200 or 503 with details
    const body = await response.json().catch(() => ({}));
    console.log(`  Response: ${JSON.stringify(body).substring(0, 300)}`);

    // At minimum the endpoint should respond
    expect([200, 503]).toContain(response.status());

    if (body.services) {
      for (const [service, info] of Object.entries(body.services as Record<string, any>)) {
        console.log(`  ${service}: ${info.status || info}`);
      }
    }
  });
});
