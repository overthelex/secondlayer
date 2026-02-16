/**
 * Admin User Seed Script
 * Creates or updates administrator users on every deploy.
 *
 * Supports two modes:
 *   1. ADMIN_USERS env var — JSON array: [{"email":"...","password":"...","name":"..."}]
 *   2. Legacy: ADMIN_USER_EMAIL + ADMIN_USER_PASSWORD (single admin)
 *
 * Idempotent: safe to run multiple times.
 *
 * Usage:
 *   node dist/scripts/seed-admin-user.js
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import bcrypt from 'bcryptjs';

interface AdminEntry {
  email: string;
  password: string;
  name?: string;
}

function getAdminList(): AdminEntry[] {
  // Mode 1: JSON array
  if (process.env.ADMIN_USERS) {
    try {
      const parsed = JSON.parse(process.env.ADMIN_USERS);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('ADMIN_USERS must be a non-empty JSON array');
      }
      for (const entry of parsed) {
        if (!entry.email || !entry.password) {
          throw new Error(`Each admin entry must have email and password, got: ${JSON.stringify(entry)}`);
        }
      }
      return parsed;
    } catch (error: any) {
      logger.error(`Failed to parse ADMIN_USERS: ${error.message}`);
      throw error;
    }
  }

  // Mode 2: Legacy single admin
  const email = process.env.ADMIN_USER_EMAIL;
  const password = process.env.ADMIN_USER_PASSWORD;
  if (email && password) {
    return [{ email, password, name: 'Administrator' }];
  }

  return [];
}

async function seedAdminUser(db: Database, admin: AdminEntry) {
  const { email, password, name = 'Administrator' } = admin;
  logger.info(`Seeding admin user: ${email}`);

  const passwordHash = await bcrypt.hash(password, 10);

  const result = await db.query(
    `INSERT INTO users (email, name, password_hash, email_verified, role, is_admin)
     VALUES ($1, $2, $3, TRUE, 'administrator', TRUE)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = $3,
       role = 'administrator',
       is_admin = TRUE,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [email, name, passwordHash]
  );

  const userId = result.rows[0].id;
  logger.info(`Admin user ready: ${email} (ID: ${userId})`);

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
}

async function seedAllAdmins() {
  const admins = getAdminList();
  if (admins.length === 0) {
    logger.info('No admin users configured — skipping admin seed');
    return;
  }

  const db = new Database();

  try {
    await db.connect();
    for (const admin of admins) {
      await seedAdminUser(db, admin);
    }
    logger.info(`Admin seed completed: ${admins.length} user(s)`);
  } catch (error: any) {
    logger.error('Error seeding admin users:', error);
    throw error;
  } finally {
    await db.close();
  }
}

seedAllAdmins()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
