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
// Photos arrive already cropped to a square JPEG by the profile page (the
// browser does the HEIC decoding, circle framing and zoom); this only checks
// it is a JPEG of sane size and keeps one per person.
//
// Password change rewrites the oauth2-proxy htpasswd file (mounted read-write
// here, read-only in sell-auth). Apache's htpasswd from the image does the
// bcrypt work: -v checks the current password against the file, -n hashes the
// new one; passwords only ever travel on stdin.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = `${DATA_DIR}/profiles.json`;
const PORT = Number(process.env.PORT ?? 8080);
const PHOTO_DIR = `${DATA_DIR}/photos`;
const PHOTO_MAX = 2 * 1024 * 1024;
// Shared P&L assumptions: one document for the whole team, last 30 versions kept.
const PNL_FILE = `${DATA_DIR}/pnl.json`;
const PNL_MAX = 64 * 1024;
const PNL_HISTORY = 30;
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

mkdirSync(PHOTO_DIR, { recursive: true });

// File name from the email, so an address never becomes a path.
function photoPath(email: string): string {
  return `${PHOTO_DIR}/${createHash('sha256').update(email).digest('hex').slice(0, 32)}.jpg`;
}

function isJpeg(b: Buffer): boolean {
  return b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
}

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

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) {
      req.resume();
      return reject(new Error('too large'));
    }
    // Past the limit, keep reading and drop the bytes, so the caller can still
    // answer 413 instead of the connection just dying.
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => (size > limit ? reject(new Error('too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readRaw(req, 16_384)).toString('utf8');
}

function saveProfile(res: ServerResponse, email: string, profile: Profile): void {
  const all = load();
  all[email] = profile;
  try {
    save(all);
  } catch (e) {
    // A failed write must cost one request, not the whole service.
    console.error('profile save failed', e);
    return send(res, 500, { error: 'Could not save your profile.' });
  }
  send(res, 200, { email, profile });
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
  if (
    path !== '/teamarea/api/me' &&
    path !== '/teamarea/api/password' &&
    path !== '/teamarea/api/photo' &&
    path !== '/teamarea/api/pnl'
  ) {
    return send(res, 404, { error: 'not found' });
  }

  const email = String(req.headers['x-team-email'] ?? '').trim().toLowerCase();
  if (!email) return send(res, 401, { error: 'not signed in' });

  if (path === '/teamarea/api/pnl') {
    type Version = { assumptions: Record<string, unknown>; updated_by: string; updated_at: string };
    let doc: { current: Version | null; history: Version[] };
    try {
      doc = JSON.parse(readFileSync(PNL_FILE, 'utf8'));
    } catch {
      doc = { current: null, history: [] };
    }
    if (req.method === 'GET') {
      return send(res, 200, {
        current: doc.current,
        history: doc.history.map((v) => ({ updated_by: v.updated_by, updated_at: v.updated_at })),
      });
    }
    if (req.method === 'PUT') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 415, { error: 'expected application/json' });
      }
      let input: { assumptions?: unknown };
      try {
        input = JSON.parse((await readRaw(req, PNL_MAX)).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'bad JSON or too large' });
      }
      const a = input?.assumptions;
      if (!a || typeof a !== 'object' || Array.isArray(a)) return send(res, 400, { error: 'assumptions must be an object' });
      // Numbers and short strings only: this is a table of assumptions, not a store.
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
        if (k.length > 64) return send(res, 400, { error: 'key too long' });
        if (!(typeof v === 'number' && Number.isFinite(v)) && !(typeof v === 'string' && v.length <= 200) && typeof v !== 'boolean') {
          return send(res, 400, { error: `bad value for ${k}` });
        }
      }
      const version: Version = { assumptions: a as Record<string, unknown>, updated_by: email, updated_at: new Date().toISOString() };
      if (doc.current) doc.history = [doc.current, ...doc.history].slice(0, PNL_HISTORY);
      doc.current = version;
      try {
        writeFileSync(`${PNL_FILE}.tmp`, JSON.stringify(doc));
        renameSync(`${PNL_FILE}.tmp`, PNL_FILE);
      } catch (e) {
        console.error('pnl save failed', e);
        return send(res, 500, { error: 'Could not save.' });
      }
      return send(res, 200, { current: version });
    }
    res.setHeader('Allow', 'GET, PUT');
    return send(res, 405, { error: 'method not allowed' });
  }

  if (path === '/teamarea/api/photo') {
    const file = photoPath(email);
    if (req.method === 'GET') {
      let img: Buffer;
      try {
        img = readFileSync(file);
      } catch {
        return send(res, 404, { error: 'no photo' });
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': img.length,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(img);
    }
    if (req.method === 'PUT') {
      if (String(req.headers['content-type'] ?? '') !== 'image/jpeg') {
        return send(res, 415, { error: 'expected image/jpeg' });
      }
      let img: Buffer;
      try {
        img = await readRaw(req, PHOTO_MAX);
      } catch {
        return send(res, 413, { error: 'The photo is larger than 2 MB.' });
      }
      if (!isJpeg(img)) return send(res, 400, { error: 'That is not a JPEG image.' });
      try {
        writeFileSync(`${file}.tmp`, img);
        renameSync(`${file}.tmp`, file);
      } catch (e) {
        console.error('photo save failed', e);
        return send(res, 500, { error: 'Could not save your photo.' });
      }
      const profile: Profile = { ...(load()[email] ?? {}), photo: new Date().toISOString() };
      return saveProfile(res, email, profile);
    }
    if (req.method === 'DELETE') {
      rmSync(file, { force: true });
      const profile: Profile = { ...(load()[email] ?? {}) };
      delete profile.photo;
      return saveProfile(res, email, profile);
    }
    res.setHeader('Allow', 'GET, PUT, DELETE');
    return send(res, 405, { error: 'method not allowed' });
  }

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
    // The photo is set through /photo; saving the form keeps it.
    const photo = load()[email]?.photo;
    if (photo) profile.photo = photo;
    return saveProfile(res, email, profile);
  }

  res.setHeader('Allow', 'GET, PUT');
  return send(res, 405, { error: 'method not allowed' });
}).listen(PORT, () => console.log(`teamarea-api listening on ${PORT}`));
