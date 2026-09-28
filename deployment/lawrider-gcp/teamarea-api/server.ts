// Team-area profile API for lawrider.uk/teamarea.
//
// Who is asking comes only from X-Team-Email, which the edge sets from
// oauth2-proxy's X-Auth-Request-Email after auth_request has accepted the
// session cookie; the edge overwrites whatever the browser sent. So each
// person can read and change their own profile and nobody else's.
//
// No dependencies: node:24 runs this file directly (type stripping). Profiles
// live in one JSON file on a named volume, written via tmp + rename.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = `${DATA_DIR}/profiles.json`;
const PORT = Number(process.env.PORT ?? 8080);

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

createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/healthz') return send(res, 200, { ok: true });
  if (path !== '/teamarea/api/me') return send(res, 404, { error: 'not found' });

  const email = String(req.headers['x-team-email'] ?? '').trim().toLowerCase();
  if (!email) return send(res, 401, { error: 'not signed in' });

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
    save(all);
    return send(res, 200, { email, profile });
  }

  res.setHeader('Allow', 'GET, PUT');
  return send(res, 405, { error: 'method not allowed' });
}).listen(PORT, () => console.log(`teamarea-api listening on ${PORT}`));
