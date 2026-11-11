// Operator CLI, run inside the container (docker exec -i attorney-crm-local node dist/cli.js ...):
//   set-password <email> <password> [display name]
//   mail suppress <email> [unsubscribe|bounce|complaint|manual] [detail]   add to the suppression list
//   mail unsuppress <email>                                                remove (any reason)
//   mail check <email...>                                                  which of these are blocked
//   mail import-bounces [source]                                           stdin: Postfix log lines or an address list
//   mail link <email>                                                      print the unsubscribe URL for an address
//   mail send --to <email> --subject <s> --text <file> [--html <file>] [--advocate <id>] [--campaign <name>] [--as <user email>] [--dry-run]
//   mail send-batch <file.jsonl> [--pace <seconds>] [--limit <n>] [--as <user email>] [--dry-run]
//       one JSON object per line: {to, subject, text, html?, advocate?, campaign?}; resumable (same campaign + address = skipped)
//   A sent message is noted on the lead (kind 'email') and a 'new' lead becomes 'contacted'; --as names the CRM user, default vladimir@<domain>.
//   mail stats [campaign]                                                  sent / suppressed / failed counts
//   mail hook-key                                                          key for the Event Grid webhook (/hooks/acs-events)
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
import { hookKey } from './mail/acs-events';
import { createMailer, type Mailer, type SendResult } from './mail/sender';
import { userIdByEmail } from './mail/crm';

const USAGE = `usage: node dist/cli.js <command>
  set-password <email> <password> [display name]
  mail suppress <email> [unsubscribe|bounce|complaint|manual] [detail]
  mail unsuppress <email>
  mail check <email...>
  mail import-bounces [source]            (stdin: Postfix log lines or an address list)
  mail link <email>
  mail send --to <email> --subject <s> --text <file> [--html <file>] [--advocate <id>] [--campaign <name>] [--as <user email>] [--dry-run]
  mail send-batch <file.jsonl> [--pace <seconds>] [--limit <n>] [--as <user email>] [--dry-run]
  mail stats [campaign]
  mail hook-key                           (key for the Event Grid webhook /hooks/acs-events)`;

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

function resultLine(res: SendResult): string {
  return `${res.status} ${res.email}${res.messageId ? ` ${res.messageId}` : ''}${res.error ? `  ${res.error}` : ''}${res.crmError ? `  CRM: ${res.crmError}` : ''}`;
}

// Shared by `mail send` and `mail send-batch`: a dry run without a transport, otherwise
// the real one, with sent messages noted on the lead as the CRM user named by --as.
async function openMailer(pool: Queryable, config: Config, opts: Record<string, string | true>): Promise<Mailer> {
  const dryRun = opts['dry-run'] === true || !config.smtpUrl;
  const asEmail = typeof opts.as === 'string' ? opts.as : `vladimir@${config.tenant.brand.domain}`;
  const userId = await userIdByEmail(pool, asEmail);
  if (!userId) process.stderr.write(`no CRM user ${asEmail}: sent messages will not be noted on leads (use --as <user email>)\n`);
  return createMailer(pool, {
    smtpUrl: dryRun ? null : config.smtpUrl,
    from: config.mailFrom,
    replyTo: config.replyTo ?? undefined,
    unsubscribe: { publicUrl: config.publicUrl, mailbox: config.unsubscribeMailbox, secret: config.sessionSecret },
    recordAsUserId: userId ?? undefined,
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
      const mailer = await openMailer(pool, config, opts);
      try {
        const res = await mailer.send({
          to,
          subject,
          text: fs.readFileSync(textFile, 'utf8'),
          html: typeof opts.html === 'string' ? fs.readFileSync(opts.html, 'utf8') : undefined,
          advocateSourceId: typeof opts.advocate === 'string' ? opts.advocate : null,
          campaign: typeof opts.campaign === 'string' ? opts.campaign : undefined,
        });
        out(resultLine(res));
        if (res.raw) process.stdout.write(`\n${res.raw.toString('utf8')}\n`);
        return res.status === 'failed' ? 1 : 0;
      } finally {
        mailer.close();
      }
    }
    case 'send-batch': {
      const { opts, rest } = flags(tail);
      if (!rest[0]) return usage();
      const pace = typeof opts.pace === 'string' ? Number(opts.pace) : 3;
      const limit = typeof opts.limit === 'string' ? Number(opts.limit) : Infinity;
      const lines = fs.readFileSync(rest[0], 'utf8').split('\n').filter((l) => l.trim());
      const mailer = await openMailer(pool, config, opts);
      const counts: Record<string, number> = {};
      let sentNow = 0;
      try {
        for (let n = 0; n < lines.length && sentNow < limit; n++) {
          const item = JSON.parse(lines[n]) as { to: string; subject: string; text: string; html?: string; advocate?: string; campaign?: string };
          const res = await mailer.send({ to: item.to, subject: item.subject, text: item.text, html: item.html, advocateSourceId: item.advocate ?? null, campaign: item.campaign });
          counts[res.status] = (counts[res.status] ?? 0) + 1;
          out(`${n + 1}/${lines.length} ${resultLine(res)}`);
          if (res.status === 'sent' || res.status === 'dry-run') {
            sentNow++;
            if (n < lines.length - 1 && sentNow < limit) await new Promise((r) => setTimeout(r, pace * 1000));
          }
        }
      } finally {
        mailer.close();
      }
      out(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing to do');
      return 0;
    }
    case 'hook-key': {
      out(hookKey(config.sessionSecret));
      return 0;
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
