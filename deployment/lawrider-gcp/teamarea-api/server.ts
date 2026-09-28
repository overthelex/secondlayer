// Team-area profile API for lawrider.uk/teamarea.
//
// Who is asking comes only from X-Team-Email, which the edge sets from
// oauth2-proxy's X-Auth-Request-User (the htpasswd
// login, which is the person's email) after auth_request has accepted the
// session cookie; the edge overwrites whatever the browser sent. So each
// person can read and change their own profile and nobody else's.
//
// No npm dependencies: node:24 runs this file directly (type stripping). Profiles
// live in one JSON file on a named volume, written via tmp + rename.
//
// Password change rewrites the oauth2-proxy htpasswd file (mounted read-write
// here, read-only in sell-auth). Apache's htpasswd from the image does the
// bcrypt work: -v checks the current password against the file, -n hashes the
// new one; passwords only ever travel on stdin.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = `${DATA_DIR}/profiles.json`;
const PORT = Number(process.env.PORT ?? 8080);
const HTPASSWD = process.env.HTPASSWD_FILE ?? '/htpasswd/sell';
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
// Wrong current passwords per person before a 15-minute pause.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Field -> max length. Anything else in the body is ignored.
const FIELDS: Record<string, number> = {
  name: 100,
  title: 100,
  phone: 40,
  linkedin: 200,
  bio: 2000,
};

type Profile = Record<string, string> & { updated_at?: string };

mkdirSync(DATA_DIR, { recursive: true });

function load(): Record<string, Profile> {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(all: Record<string, Profile>): void {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, FILE);
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 16_384) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function htpasswd(args: string[], stdin: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('htpasswd', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
    p.stdin.end(stdin + '\n');
  });
}

// One password change at a time, so two saves cannot interleave their
// read-modify-write of the htpasswd file.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

const failures = new Map<string, { n: number; until: number }>();

async function changePassword(user: string, current: string, next: string): Promise<[number, string]> {
  const f = failures.get(user);
  if (f && f.until > Date.now()) return [429, 'Too many wrong passwords. Try again in 15 minutes.'];

  const verify = await htpasswd(['-v', '-i', HTPASSWD, user], current);
  if (verify.code !== 0) {
    const n = (f?.n ?? 0) + 1;
    failures.set(user, n >= MAX_FAILURES ? { n: 0, until: Date.now() + LOCKOUT_MS } : { n, until: 0 });
    return [403, 'Current password is incorrect.'];
  }
  failures.delete(user);

  const hashed = await htpasswd(['-n', '-i', '-B', '-C', '12', user], next);
  const line = hashed.out.split('\n')[0].trim();
  if (hashed.code !== 0 || !line.startsWith(`${user}:$2`)) return [500, 'Could not set the new password.'];

  const lines = readFileSync(HTPASSWD, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const i = lines.findIndex((l) => l.startsWith(`${user}:`));
  if (i < 0) return [404, 'Your account was not found.'];
  lines[i] = line;
  const tmp = `${HTPASSWD}.tmp`;
  writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o644 });
  renameSync(tmp, HTPASSWD);
  console.log(`password changed for ${user}`);
  return [200, 'Password changed.'];
}

createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/healthz') return send(res, 200, { ok: true });
  if (path !== '/teamarea/api/me' && path !== '/teamarea/api/password') {
    return send(res, 404, { error: 'not found' });
  }

  const email = String(req.headers['x-team-email'] ?? '').trim().toLowerCase();
  if (!email) return send(res, 401, { error: 'not signed in' });

  if (path === '/teamarea/api/password') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: 'method not allowed' });
    }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return send(res, 415, { error: 'expected application/json' });
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'bad JSON' });
    }
    const current = input?.current;
    const next = input?.next;
    if (typeof current !== 'string' || typeof next !== 'string' || !current) {
      return send(res, 400, { error: 'Enter your current and new password.' });
    }
    if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) {
      return send(res, 400, { error: `The new password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.` });
    }
    if (/[\r\n]/.test(next) || /[\r\n]/.test(current)) {
      return send(res, 400, { error: 'Passwords cannot contain line breaks.' });
    }
    if (next === current) return send(res, 400, { error: 'The new password is the same as the current one.' });
    try {
      const [code, message] = await serial(() => changePassword(email, current, next));
      return send(res, code, code === 200 ? { ok: true, message } : { error: message });
    } catch (e) {
      console.error('password change failed', e);
      return send(res, 500, { error: 'Could not change the password.' });
    }
  }

  if (req.method === 'GET') {
    return send(res, 200, { email, profile: load()[email] ?? {} });
  }

  if (req.method === 'PUT') {
    // JSON only: a cross-site form cannot send this content type without a
    // CORS preflight, which this API never answers.
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return send(res, 415, { error: 'expected application/json' });
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'bad JSON' });
    }
    const profile: Profile = {};
    for (const [key, max] of Object.entries(FIELDS)) {
      const v = input?.[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') return send(res, 400, { error: `${key} must be text` });
      const s = v.trim();
      if (s.length > max) return send(res, 400, { error: `${key} is longer than ${max} characters` });
      if (s) profile[key] = s;
    }
    if (profile.linkedin && !/^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(profile.linkedin)) {
      return send(res, 400, { error: 'linkedin must be a https://linkedin.com/ link' });
    }
    profile.updated_at = new Date().toISOString();
    const all = load();
    all[email] = profile;
    try {
      save(all);
    } catch (e) {
      // A failed write must cost one request, not the whole service.
      console.error('profile save failed', e);
      return send(res, 500, { error: 'Could not save your profile.' });
    }
    return send(res, 200, { email, profile });
  }

  res.setHeader('Allow', 'GET, PUT');
  return send(res, 405, { error: 'method not allowed' });
}).listen(PORT, () => console.log(`teamarea-api listening on ${PORT}`));
