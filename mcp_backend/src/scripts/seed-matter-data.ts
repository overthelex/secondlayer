/**
 * Matter Seed Data Script
 * Creates test clients, matters, time entries, invoices, and legal holds
 *
 * Usage:
 *   npm run seed:matters          # Build and run
 *   npm run seed:matters:dev      # Run with ts-node-dev
 *   npm run seed:matters:clean    # Cleanup test data
 *
 * Requires: seed-test-account to be run first (for test user)
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

const TEST_EMAIL = process.env.TEST_ACCOUNT_EMAIL || 'test@legal.org.ua';

async function seedMatterData() {
  const db = new Database();

  try {
    await db.connect();
    logger.info('Starting matter data seed...');

    // Get test user
    const userResult = await db.query('SELECT id FROM users WHERE email = $1', [TEST_EMAIL]);
    if (userResult.rows.length === 0) {
      throw new Error(`Test user ${TEST_EMAIL} not found. Run seed-test-account first.`);
    }
    const userId = userResult.rows[0].id;
    logger.info(`Using test user: ${TEST_EMAIL} (${userId})`);

    // Get or create organization
    let orgId: string;
    const orgResult = await db.query('SELECT id FROM organizations WHERE owner_id = $1', [userId]);
    if (orgResult.rows.length > 0) {
      orgId = orgResult.rows[0].id;
      logger.info(`Using existing organization: ${orgId}`);
    } else {
      const newOrg = await db.query(
        `INSERT INTO organizations (name, owner_id, plan, max_members)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['Тестова юридична фірма', userId, 'professional', 10]
      );
      orgId = newOrg.rows[0].id;
      logger.info(`Created organization: ${orgId}`);

      // Add user as org member (check first to avoid duplicates)
      const existingMember = await db.query(
        'SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2',
        [orgId, userId]
      );
      if (existingMember.rows.length === 0) {
        await db.query(
          `INSERT INTO organization_members (organization_id, user_id, email, role, status, joined_at)
           VALUES ($1, $2, $3, 'owner', 'active', now())`,
          [orgId, userId, TEST_EMAIL]
        );
      }
    }

    // --- CLIENTS ---
    const clients = [
      {
        name: 'ТОВ "Укрбуд Інвест"',
        type: 'business',
        email: 'office@ukrbud-invest.ua',
        taxId: '40123456',
      },
      {
        name: 'Петренко Олександр Іванович',
        type: 'individual',
        email: 'petrenko.o@gmail.com',
        taxId: '3012345678',
      },
      {
        name: 'Департамент юстиції Київської ОДА',
        type: 'government',
        email: 'justice@kyiv-oda.gov.ua',
        taxId: '02141567',
      },
    ];

    const clientIds: string[] = [];
    for (const client of clients) {
      const result = await db.query(
        `INSERT INTO clients (organization_id, client_name, client_type, contact_email, tax_id, status, conflict_status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'active', 'clear', $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [orgId, client.name, client.type, client.email, client.taxId, userId]
      );
      if (result.rows.length > 0) {
        clientIds.push(result.rows[0].id);
        logger.info(`Created client: ${client.name}`);
      } else {
        // Client may already exist, try to fetch
        const existing = await db.query(
          'SELECT id FROM clients WHERE organization_id = $1 AND client_name = $2',
          [orgId, client.name]
        );
        if (existing.rows.length > 0) {
          clientIds.push(existing.rows[0].id);
          logger.info(`Client already exists: ${client.name}`);
        }
      }
    }

    if (clientIds.length < 3) {
      throw new Error('Failed to create/find all 3 clients');
    }

    // --- MATTERS ---
    const matters = [
      {
        clientIdx: 0,
        number: 'CIV-2026-001',
        name: 'Стягнення заборгованості за договором підряду',
        type: 'civil',
        status: 'active',
        opposingParty: 'ТОВ "БудСервіс Плюс"',
        caseNumber: '910/1234/26',
        courtName: 'Господарський суд міста Києва',
      },
      {
        clientIdx: 1,
        number: 'CRIM-2026-002',
        name: 'Захист підозрюваного у справі про шахрайство',
        type: 'criminal',
        status: 'active',
        opposingParty: 'Прокуратура Київської області',
        caseNumber: '760/5678/26',
        courtName: 'Дарницький районний суд м. Києва',
      },
      {
        clientIdx: 2,
        number: 'ADM-2026-003',
        name: 'Оскарження рішення податкової перевірки',
        type: 'administrative',
        status: 'open',
        opposingParty: 'ГУ ДПС у м. Києві',
        caseNumber: '640/9012/26',
        courtName: 'Окружний адміністративний суд м. Києва',
      },
      {
        clientIdx: 0,
        number: 'COM-2026-004',
        name: 'Спір щодо розірвання договору оренди нежитлового приміщення',
        type: 'commercial',
        status: 'active',
        opposingParty: 'ФОП Сидоренко В.М.',
        caseNumber: '910/3456/26',
        courtName: 'Господарський суд міста Києва',
      },
      {
        clientIdx: 1,
        number: 'FAM-2026-005',
        name: 'Розподіл майна подружжя',
        type: 'family',
        status: 'closed',
        opposingParty: 'Петренко Тетяна Миколаївна',
        caseNumber: '753/7890/25',
        courtName: 'Голосіївський районний суд м. Києва',
      },
    ];

    const matterIds: string[] = [];
    for (const matter of matters) {
      const result = await db.query(
        `INSERT INTO matters (client_id, matter_number, matter_name, matter_type, status,
         opposing_party, court_case_number, court_name, responsible_attorney, created_by,
         closed_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
         ON CONFLICT (matter_number) DO NOTHING
         RETURNING id`,
        [
          clientIds[matter.clientIdx],
          matter.number,
          matter.name,
          matter.type,
          matter.status,
          matter.opposingParty,
          matter.caseNumber,
          matter.courtName,
          userId,
          matter.status === 'closed' ? new Date('2026-01-15') : null,
        ]
      );
      if (result.rows.length > 0) {
        matterIds.push(result.rows[0].id);
        logger.info(`Created matter: ${matter.number} — ${matter.name}`);
      } else {
        const existing = await db.query('SELECT id FROM matters WHERE matter_number = $1', [matter.number]);
        if (existing.rows.length > 0) {
          matterIds.push(existing.rows[0].id);
          logger.info(`Matter already exists: ${matter.number}`);
        }
      }
    }

    // --- MATTER TEAM ---
    for (const matterId of matterIds) {
      await db.query(
        `INSERT INTO matter_team (matter_id, user_id, role, access_level, added_by)
         VALUES ($1, $2, 'lead_attorney', 'full', $2)
         ON CONFLICT (matter_id, user_id) DO NOTHING`,
        [matterId, userId]
      );
    }
    logger.info(`Added test user to ${matterIds.length} matter teams`);

    // --- BILLING RATES ---
    const existingRate = await db.query(
      'SELECT id FROM user_billing_rates WHERE user_id = $1 AND is_default = true',
      [userId]
    );
    if (existingRate.rows.length === 0) {
      await db.query(
        `INSERT INTO user_billing_rates (user_id, hourly_rate_usd, is_default, created_by)
         VALUES ($1, 150.00, true, $1)`,
        [userId]
      );
    }
    logger.info('Set default billing rate: $150/hr');

    // --- TIME ENTRIES ---
    const timeEntries = [
      { matterIdx: 0, duration: 120, desc: 'Аналіз договору підряду та підготовка правової позиції', date: '2026-02-01', status: 'approved' },
      { matterIdx: 0, duration: 90, desc: 'Складання позовної заяви до господарського суду', date: '2026-02-03', status: 'approved' },
      { matterIdx: 0, duration: 60, desc: 'Підготовка додатків до позову (копії документів)', date: '2026-02-04', status: 'invoiced' },
      { matterIdx: 1, duration: 180, desc: 'Вивчення матеріалів кримінальної справи', date: '2026-02-05', status: 'approved' },
      { matterIdx: 1, duration: 90, desc: 'Складання клопотання про зміну запобіжного заходу', date: '2026-02-06', status: 'submitted' },
      { matterIdx: 2, duration: 60, desc: 'Консультація з клієнтом щодо акту перевірки', date: '2026-02-07', status: 'draft' },
      { matterIdx: 2, duration: 120, desc: 'Підготовка скарги на рішення податкової', date: '2026-02-08', status: 'draft' },
      { matterIdx: 3, duration: 45, desc: 'Телефонна конференція з протилежною стороною', date: '2026-02-09', status: 'approved' },
      { matterIdx: 3, duration: 150, desc: 'Підготовка відзиву на зустрічний позов', date: '2026-02-10', status: 'submitted' },
      { matterIdx: 4, duration: 90, desc: 'Підготовка мирової угоди про розподіл майна', date: '2025-12-20', status: 'invoiced' },
      { matterIdx: 4, duration: 60, desc: 'Участь у судовому засіданні', date: '2026-01-10', status: 'invoiced' },
    ];

    const timeEntryIds: string[] = [];
    for (const entry of timeEntries) {
      const result = await db.query(
        `INSERT INTO time_entries (matter_id, user_id, entry_date, duration_minutes, hourly_rate_usd,
         billable, status, description, created_by,
         submitted_at, approved_at)
         VALUES ($1, $2, $3, $4, 150.00, true, $5, $6, $2, $7, $8)
         RETURNING id`,
        [
          matterIds[entry.matterIdx],
          userId,
          entry.date,
          entry.duration,
          entry.status,
          entry.desc,
          ['submitted', 'approved', 'invoiced'].includes(entry.status) ? new Date(entry.date) : null,
          ['approved', 'invoiced'].includes(entry.status) ? new Date(entry.date) : null,
        ]
      );
      timeEntryIds.push(result.rows[0].id);
    }
    logger.info(`Created ${timeEntryIds.length} time entries`);

    // --- INVOICES ---
    // Invoice 1: Matter CIV-2026-001 (invoiced time entry index 2)
    const inv1 = await db.query(
      `INSERT INTO matter_invoices (matter_id, invoice_number, status, issue_date, due_date,
       subtotal_usd, tax_rate, tax_amount_usd, total_usd, amount_paid_usd, created_by, notes)
       VALUES ($1, $2, 'sent', '2026-02-05', '2026-03-05', 150.00, 0.2, 30.00, 180.00, 0, $3,
       'Інвойс за правову допомогу у справі про стягнення заборгованості')
       RETURNING id`,
      [matterIds[0], 'INV-2026-001', userId]
    );
    // Link time entry to invoice
    await db.query('UPDATE time_entries SET invoice_id = $1 WHERE id = $2', [inv1.rows[0].id, timeEntryIds[2]]);
    // Add line item
    await db.query(
      `INSERT INTO invoice_line_items (invoice_id, time_entry_id, description, quantity, unit_price_usd, amount_usd, line_order)
       VALUES ($1, $2, 'Підготовка додатків до позову', 1.0, 150.00, 150.00, 1)`,
      [inv1.rows[0].id, timeEntryIds[2]]
    );
    logger.info('Created invoice INV-2026-001 ($180.00)');

    // Invoice 2: Matter FAM-2026-005 (invoiced time entries indexes 9, 10)
    const inv2 = await db.query(
      `INSERT INTO matter_invoices (matter_id, invoice_number, status, issue_date, due_date,
       subtotal_usd, tax_rate, tax_amount_usd, total_usd, amount_paid_usd, created_by, paid_at, notes)
       VALUES ($1, $2, 'paid', '2026-01-15', '2026-02-15', 375.00, 0.2, 75.00, 450.00, 450.00, $3, '2026-02-01',
       'Фінальний інвойс — розподіл майна подружжя')
       RETURNING id`,
      [matterIds[4], 'INV-2026-002', userId]
    );
    // Link time entries
    await db.query('UPDATE time_entries SET invoice_id = $1 WHERE id = ANY($2)', [inv2.rows[0].id, [timeEntryIds[9], timeEntryIds[10]]]);
    // Add line items
    await db.query(
      `INSERT INTO invoice_line_items (invoice_id, time_entry_id, description, quantity, unit_price_usd, amount_usd, line_order)
       VALUES ($1, $2, 'Підготовка мирової угоди', 1.5, 150.00, 225.00, 1)`,
      [inv2.rows[0].id, timeEntryIds[9]]
    );
    await db.query(
      `INSERT INTO invoice_line_items (invoice_id, time_entry_id, description, quantity, unit_price_usd, amount_usd, line_order)
       VALUES ($1, $2, 'Участь у судовому засіданні', 1.0, 150.00, 150.00, 2)`,
      [inv2.rows[0].id, timeEntryIds[10]]
    );
    // Add payment
    await db.query(
      `INSERT INTO invoice_payments (invoice_id, amount_usd, payment_date, payment_method, reference_number, recorded_by)
       VALUES ($1, 450.00, '2026-02-01', 'bank_transfer', 'PAY-20260201-001', $2)`,
      [inv2.rows[0].id, userId]
    );
    logger.info('Created invoice INV-2026-002 ($450.00 — paid)');

    // --- LEGAL HOLDS ---
    // Legal hold on the criminal matter
    await db.query(
      `INSERT INTO legal_holds (matter_id, hold_name, hold_type, issued_by, scope_description, status)
       VALUES ($1, 'Кримінальне провадження — збереження доказів', 'investigation', $2,
       'Усі документи, повідомлення та матеріали, пов''язані з кримінальним провадженням, мають бути збережені до завершення справи', 'active')
       ON CONFLICT DO NOTHING`,
      [matterIds[1], userId]
    );
    logger.info('Created legal hold on CRIM-2026-002');

    // Legal hold on the admin matter
    await db.query(
      `INSERT INTO legal_holds (matter_id, hold_name, hold_type, issued_by, scope_description, status)
       VALUES ($1, 'Регуляторна перевірка ДПС', 'regulatory', $2,
       'Збереження усіх документів бухгалтерського та податкового обліку за 2023-2025 роки', 'active')
       ON CONFLICT DO NOTHING`,
      [matterIds[2], userId]
    );
    logger.info('Created legal hold on ADM-2026-003');

    // Update matters to reflect legal_hold flag
    await db.query(
      'UPDATE matters SET legal_hold = true WHERE id = ANY($1)',
      [[matterIds[1], matterIds[2]]]
    );

    // --- SUMMARY ---
    logger.info('');
    logger.info('Matter data seed complete:');
    logger.info(`  Clients: ${clientIds.length}`);
    logger.info(`  Matters: ${matterIds.length}`);
    logger.info(`  Time entries: ${timeEntryIds.length}`);
    logger.info(`  Invoices: 2`);
    logger.info(`  Legal holds: 2`);

  } catch (error: any) {
    logger.error('Matter seed failed:', error);
    throw error;
  } finally {
    await db.close();
  }
}

async function cleanupMatterData() {
  const db = new Database();

  try {
    await db.connect();
    logger.info('Cleaning up matter seed data...');

    const userResult = await db.query('SELECT id FROM users WHERE email = $1', [TEST_EMAIL]);
    if (userResult.rows.length === 0) {
      logger.info('No test user found, nothing to clean up');
      return;
    }
    const userId = userResult.rows[0].id;

    // Delete in reverse dependency order
    await db.query('DELETE FROM invoice_payments WHERE recorded_by = $1', [userId]);
    await db.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM matter_invoices WHERE created_by = $1)', [userId]);
    await db.query('DELETE FROM matter_invoices WHERE created_by = $1', [userId]);
    await db.query('DELETE FROM time_entries WHERE created_by = $1', [userId]);
    await db.query('DELETE FROM legal_holds WHERE issued_by = $1', [userId]);
    await db.query('DELETE FROM matter_team WHERE added_by = $1', [userId]);
    await db.query('DELETE FROM matters WHERE created_by = $1', [userId]);
    await db.query('DELETE FROM clients WHERE created_by = $1', [userId]);

    logger.info('Matter data cleaned up successfully');
  } catch (error: any) {
    logger.error('Cleanup failed:', error);
    throw error;
  } finally {
    await db.close();
  }
}

const isCleanup = process.argv.includes('--cleanup');
(isCleanup ? cleanupMatterData() : seedMatterData())
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
