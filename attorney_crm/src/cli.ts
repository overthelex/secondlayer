// Operator CLI, run inside the container:
//   node dist/cli.js set-password <email> <password> [display name]
import path from 'path';
import { loadConfig } from './config';
import { createPool } from './db';
import { applySchema } from './schema';
import { upsertUser } from './auth/users';

async function main(argv: string[]): Promise<number> {
  const [cmd, email, password, ...rest] = argv;
  if (cmd !== 'set-password' || !email || !password) {
    process.stderr.write('usage: node dist/cli.js set-password <email> <password> [display name]\n');
    return 2;
  }
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  try {
    await applySchema(pool, path.join(__dirname, '..', 'sql'));
    await upsertUser(pool, email, password, rest.join(' '));
    process.stdout.write(`ok ${email.trim().toLowerCase()}\n`);
    return 0;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  },
);
