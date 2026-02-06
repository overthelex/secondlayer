/**
 * Script to set password for a user (for OAuth authentication)
 * Usage: npx tsx src/scripts/set-user-password.ts <email> <password>
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

async function setUserPassword() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('❌ Usage: npx tsx src/scripts/set-user-password.ts <email> <password>');
    console.error('   Example: npx tsx src/scripts/set-user-password.ts igor@legal.org.ua MySecurePassword123');
    process.exit(1);
  }

  const [email, password] = args;

  if (password.length < 8) {
    console.error('❌ Password must be at least 8 characters long');
    process.exit(1);
  }

  const db = new Database();

  try {
    console.log('\n========================================');
    console.log('Set User Password');
    console.log('========================================\n');

    // Check if user exists
    const userResult = await db.query('SELECT id, email, name FROM users WHERE email = $1', [email]);

    if (userResult.rows.length === 0) {
      console.error(`❌ User not found: ${email}`);
      console.log('\nAvailable users:');

      const allUsersResult = await db.query('SELECT email, name FROM users ORDER BY email');
      allUsersResult.rows.forEach((user) => {
        console.log(`  - ${user.email} (${user.name || 'No name'})`);
      });

      await db.close();
      process.exit(1);
    }

    const user = userResult.rows[0];

    // Hash password
    console.log('🔐 Hashing password...');
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Update user password
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
      passwordHash,
      user.id,
    ]);

    console.log('✅ Password set successfully!\n');
    console.log('User Details:');
    console.log('────────────────────────────────────────');
    console.log(`ID:    ${user.id}`);
    console.log(`Email: ${user.email}`);
    console.log(`Name:  ${user.name || '(not set)'}`);
    console.log('────────────────────────────────────────\n');

    console.log('🔑 Authentication Methods:');
    console.log('  1. OAuth Login:');
    console.log(`     Email: ${email}`);
    console.log(`     Password: ${password}`);
    console.log('     URL: https://stage.legal.org.ua/oauth/authorize\n');

    console.log('  2. Direct Login (POST /auth/login):');
    console.log(`     { "email": "${email}", "password": "${password}" }\n`);

    console.log('⚠️  IMPORTANT: Store this password securely!');
    console.log('It cannot be retrieved later (only reset).\n');

    console.log('========================================\n');

    await db.close();
  } catch (error: any) {
    console.error('❌ Error setting password:', error.message);
    logger.error('Error in set-user-password script:', error);
    await db.close();
    process.exit(1);
  }
}

// Run the script
setUserPassword();
