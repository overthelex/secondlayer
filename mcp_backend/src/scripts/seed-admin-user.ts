/**
 * Admin User Seed Script
 * Creates or updates the administrator user on every deploy.
 * Reads ADMIN_USER_EMAIL and ADMIN_USER_PASSWORD from environment.
 *
 * Idempotent: safe to run multiple times.
 *
 * Usage:
 *   node dist/scripts/seed-admin-user.js
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import bcrypt from 'bcryptjs';

const ADMIN_EMAIL = process.env.ADMIN_USER_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_USER_PASSWORD;

async function seedAdminUser() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    logger.info('ADMIN_USER_EMAIL or ADMIN_USER_PASSWORD not set — skipping admin seed');
    return;
  }

  const db = new Database();

  try {
    await db.connect();
    logger.info(`Seeding admin user: ${ADMIN_EMAIL}`);

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

    // Upsert: create if not exists, update password + role if exists
    const result = await db.query(
      `INSERT INTO users (email, name, password_hash, email_verified, role, is_admin)
       VALUES ($1, 'Administrator', $2, TRUE, 'administrator', TRUE)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = $2,
         role = 'administrator',
         is_admin = TRUE,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [ADMIN_EMAIL, passwordHash]
    );

    const userId = result.rows[0].id;
    logger.info(`Admin user ready: ${ADMIN_EMAIL} (ID: ${userId})`);

    // Ensure billing record exists (so admin can use the platform)
    await db.query(
      `INSERT INTO user_billing (
        user_id, balance_usd, balance_uah,
        daily_limit_usd, monthly_limit_usd,
        total_spent_usd, total_requests, is_active, billing_enabled
      )
      VALUES ($1, 1000.00, 0, 100.00, 1000.00, 0, 0, true, true)
      ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    logger.info('Admin seed completed successfully');
  } catch (error: any) {
    logger.error('Error seeding admin user:', error);
    throw error;
  } finally {
    await db.close();
  }
}

seedAdminUser()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
