// Operator CLI, run inside the container (docker exec -i attorney-crm-local node dist/cli.js ...):
//   set-password <email> <password> [display name]
//   mail suppress <email> [unsubscribe|bounce|complaint|manual] [detail]   add to the suppression list
//   mail unsuppress <email>                                                remove (any reason)
//   mail check <email...>                                                  which of these are blocked
//   mail import-bounces [source]                                           stdin: Postfix log lines or an address list
//   mail link <email>                                                      print the unsubscribe URL for an address
//   mail send --to <email> --subject <s> --text <file> [--html <file>] [--advocate <id>] [--campaign <name>] [--dry-run]
//   mail stats [campaign]                                                  sent / suppressed / failed counts
import fs from 'fs';
import path from 'path';
import { loadConfig, type Config } from './config';
import { createPool } from './db';
import { applySchema } from './schema';
import { upsertUser } from './auth/users';
import { setTenant } from './tenant';
import type { Queryable } from './db';
import { getSuppression, importBounces, isSuppressionReason, parseBounceLines, suppress, suppressedAmong, unsuppress } from './mail/suppression';
import { unsubscribeUrl } from './mail/headers';
import { createMailer } from './mail/sender';

const USAGE = `usage: node dist/cli.js <command>
  set-password <email> <password> [display name]
  mail suppress <email> [unsubscribe|bounce|complaint|manual] [detail]
  mail unsuppress <email>
  mail check <email...>
  mail import-bounces [source]            (stdin: Postfix log lines or an address list)
  mail link <email>
  mail send --to <email> --subject <s> --text <file> [--html <file>] [--advocate <id>] [--campaign <name>] [--dry-run]
  mail stats [campaign]`;

function usage(): number {
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

function flags(args: string[]): { opts: Record<string, string | true>; rest: string[] } {
  const opts: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else opts[key] = true;
    } else rest.push(a);
  }
  return { opts, rest };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function mail(pool: Queryable, config: Config, args: string[]): Promise<number> {
  const [sub, ...tail] = args;
  const out = (s: string) => process.stdout.write(`${s}\n`);
  switch (sub) {
    case 'suppress': {
      const [email, reason = 'manual', ...detail] = tail;
      if (!email) return usage();
      if (!isSuppressionReason(reason)) {
        process.stderr.write(`reason must be unsubscribe|bounce|complaint|manual, got "${reason}"\n`);
        return 2;
      }
      const row = await suppress(pool, { email, reason, source: 'cli', detail: detail.join(' ') || null });
      out(`${row.email} ${row.reason} (${row.source})`);
      return 0;
    }
    case 'unsuppress': {
      if (!tail[0]) return usage();
      out((await unsuppress(pool, tail[0])) ? `removed ${tail[0]}` : `not listed ${tail[0]}`);
      return 0;
    }
    case 'check': {
      if (!tail.length) return usage();
      const blocked = await suppressedAmong(pool, tail);
      for (const e of tail) {
        const key = e.trim().toLowerCase();
        if (!blocked.has(key)) {
          out(`ok        ${key}`);
          continue;
        }
        const row = await getSuppression(pool, key);
        out(`BLOCKED   ${key}  ${row?.reason} ${row?.source} ${row?.createdAt.toISOString().slice(0, 10)}${row?.detail ? `  ${row.detail}` : ''}`);
      }
      return 0;
    }
    case 'import-bounces': {
      const lines = parseBounceLines(await readStdin());
      const added = await importBounces(pool, lines, tail[0] ?? 'postfix-log');
      out(`parsed ${lines.length} address(es), ${added} new`);
      return 0;
    }
    case 'link': {
      if (!tail[0]) return usage();
      out(unsubscribeUrl({ publicUrl: config.publicUrl, mailbox: config.unsubscribeMailbox, secret: config.sessionSecret }, tail[0]));
      return 0;
    }
    case 'send': {
      const { opts } = flags(tail);
      const to = typeof opts.to === 'string' ? opts.to : null;
      const subject = typeof opts.subject === 'string' ? opts.subject : null;
      const textFile = typeof opts.text === 'string' ? opts.text : null;
      if (!to || !subject || !textFile) return usage();
      const dryRun = opts['dry-run'] === true || !config.smtpUrl;
      const mailer = createMailer(pool, {
        smtpUrl: dryRun ? null : config.smtpUrl,
        from: config.mailFrom,
        replyTo: config.replyTo ?? undefined,
        unsubscribe: { publicUrl: config.publicUrl, mailbox: config.unsubscribeMailbox, secret: config.sessionSecret },
      });
      try {
        const res = await mailer.send({
          to,
          subject,
          text: fs.readFileSync(textFile, 'utf8'),
          html: typeof opts.html === 'string' ? fs.readFileSync(opts.html, 'utf8') : undefined,
          advocateSourceId: typeof opts.advocate === 'string' ? opts.advocate : null,
          campaign: typeof opts.campaign === 'string' ? opts.campaign : undefined,
        });
        out(`${res.status} ${res.email}${res.messageId ? ` ${res.messageId}` : ''}${res.error ? `  ${res.error}` : ''}`);
        if (res.raw) process.stdout.write(`\n${res.raw.toString('utf8')}\n`);
        return res.status === 'failed' ? 1 : 0;
      } finally {
        mailer.close();
      }
    }
    case 'stats': {
      const r = await pool.query<{ campaign: string; status: string; n: string }>(
        `SELECT campaign, status, COUNT(*)::text AS n FROM attorney_crm_mail_log
         WHERE ($1::text IS NULL OR campaign = $1) GROUP BY 1, 2 ORDER BY 1, 2`,
        [tail[0] ?? null],
      );
      for (const row of r.rows) out(`${row.campaign || '(none)'}\t${row.status}\t${row.n}`);
      const s = await pool.query<{ reason: string; n: string }>('SELECT reason, COUNT(*)::text AS n FROM attorney_crm_suppression GROUP BY 1 ORDER BY 1');
      for (const row of s.rows) out(`suppression\t${row.reason}\t${row.n}`);
      return 0;
    }
    default:
      return usage();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd !== 'set-password' && cmd !== 'mail') return usage();
  const config = loadConfig(process.env);
  setTenant(config.tenant);
  const pool = createPool(config.databaseUrl, config.tenant.schema);
  try {
    await applySchema(pool, path.join(__dirname, '..', 'sql'), config.tenant.sqlFiles, config.tenant.schema);
    if (cmd === 'set-password') {
      const [email, password, ...rest] = args;
      if (!email || !password) return usage();
      await upsertUser(pool, email, password, rest.join(' '));
      process.stdout.write(`ok ${email.trim().toLowerCase()}\n`);
      return 0;
    }
    return await mail(pool, config, args);
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
