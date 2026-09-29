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
// Access and activity: the edge's auth_request for every team page and API
// call comes here (/authz). This asks oauth2-proxy whether the session cookie
// is valid, then checks the page against the access rules, so hiding a page
// from someone is enforced here, not only in the menu. Admins (ADMIN_EMAILS)
// always see everything and edit the rules; everyone sees every page unless
// an admin hides it; the activity page is admin-only unless granted. Pages
// report views, visible time and scroll depth to /track.
//
// Pitch proposals: on /teamarea/pitch3/ anyone who can see the page proposes a
// new version of a script line; only an admin confirms it, and the confirmed text
// replaces the line for everyone. Lines are addressed by the data-line id in the
// page's HTML. Every proposal, confirmation and rejection goes to pitch_log.jsonl,
// which the Activity page shows.
//
// CRM: a shared list of companies (clients and investors, shown on two pages)
// and every email (or LinkedIn message, form,
// call) sent to them, with the replies. Its job is to stop anyone writing to the
// same firm twice by accident: logging a send to a company, or to an address,
// that has already been contacted is refused unless the caller says it is
// deliberate (force), and the page shows who wrote, when and to whom.
//
// Password change rewrites the oauth2-proxy htpasswd file (mounted read-write
// here, read-only in sell-auth). Apache's htpasswd from the image does the
// bcrypt work: -v checks the current password against the file, -n hashes the
// new one; passwords only ever travel on stdin.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = `${DATA_DIR}/profiles.json`;
const PORT = Number(process.env.PORT ?? 8080);
const PHOTO_DIR = `${DATA_DIR}/photos`;
const PHOTO_MAX = 2 * 1024 * 1024;
// Shared P&L assumptions: one document for the whole team, last 30 versions kept.
const PNL_FILE = `${DATA_DIR}/pnl.json`;
const PNL_MAX = 64 * 1024;
const PNL_HISTORY = 30;
const PITCH_FILE = `${DATA_DIR}/pitch.json`;
const PITCH_LOG = `${DATA_DIR}/pitch_log.jsonl`;
// Pages whose lines can be edited, and the limits on what a proposal can be.
const PITCH_PAGES = ['pitch3'];
const PITCH_LINE_RE = /^[a-z0-9-]{1,40}$/;
const PITCH_TEXT_MAX = 600;
const PITCH_PENDING_MAX = 300;
const CRM_FILE = `${DATA_DIR}/crm.json`;
const CRM_STATUSES = ['new', 'sent', 'replied', 'meeting', 'pilot', 'declined', 'bounced', 'partner'];
const CRM_CHANNELS = ['email', 'linkedin', 'form', 'call', 'meeting'];
// Clients and investors live in one list so the address guard covers both; the
// pages show one group each. Companies saved before groups existed are clients.
const CRM_GROUPS = ['client', 'investor'];
const CRM_MAX_COMPANIES = 2000;
const CRM_MAX_ENTRIES = 20000;
const HTPASSWD = process.env.HTPASSWD_FILE ?? '/htpasswd/sell';
const AUTH_URL = process.env.AUTH_URL ?? 'http://lawrider-sell-auth:4180/oauth2/auth';
const ADMINS = (process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const ACCESS_FILE = `${DATA_DIR}/access.json`;
const ACTIVITY_FILE = `${DATA_DIR}/activity.jsonl`;
const ACTIVITY_MAX_BYTES = 20 * 1024 * 1024;
// Pages the access rules know about, in menu order, with who sees them when
// no rule says otherwise. Profile is always visible (it is where people
// change their password) and is not listed. A page missing from this list is
// visible to everyone.
const PAGES: { slug: string; label: string; default: boolean }[] = [
  { slug: 'sales', label: 'Sales', default: true },
  { slug: 'pitch', label: 'Pitch', default: true },
  { slug: 'pitch3', label: 'Pitch3', default: true },
  { slug: 'pnl', label: 'P&L', default: true },
  { slug: 'crm', label: 'CRM', default: true },
  { slug: 'admin', label: 'Activity', default: false },
];
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
  send(res, 200, { email, profile, admin: isAdmin(email), pages: visiblePages(email) });
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

// ---- access rules
type Grants = Record<string, Record<string, boolean>>;

function loadGrants(): Grants {
  try {
    return JSON.parse(readFileSync(ACCESS_FILE, 'utf8')).grants ?? {};
  } catch {
    return {};
  }
}

function isAdmin(email: string): boolean {
  return ADMINS.includes(email);
}

function canSee(email: string, slug: string, grants: Grants = loadGrants()): boolean {
  if (isAdmin(email) || slug === '' || slug === 'profile' || slug === 'api') return true;
  const page = PAGES.find((p) => p.slug === slug);
  if (!page) return true;
  return grants[email]?.[slug] ?? page.default;
}

function visiblePages(email: string): string[] {
  const grants = loadGrants();
  return PAGES.filter((p) => canSee(email, p.slug, grants)).map((p) => p.slug);
}

function teamUsers(): string[] {
  try {
    return readFileSync(HTPASSWD, 'utf8')
      .split('\n')
      .map((l) => l.split(':')[0].trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// /teamarea/<slug>/... -> slug ('' for /teamarea or /teamarea/)
function slugOf(uri: string): string {
  const m = /^\/teamarea(?:\/([^/?#]*))?/.exec(uri);
  return m && m[1] ? decodeURIComponent(m[1]).toLowerCase() : '';
}

// ---- activity log: one JSON object per line
type Event = { t: number; u: string; p: string; k: string; v: string; a: number; s: number; d: string; c: string };

function device(ua: string): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  return `${os} · ${br}`;
}

function appendEvent(e: Event): void {
  try {
    writeFileSync(ACTIVITY_FILE, JSON.stringify(e) + '\n', { flag: 'a' });
    // Keep the log bounded: past the cap, drop the older half.
    const size = readFileSync(ACTIVITY_FILE).length;
    if (size > ACTIVITY_MAX_BYTES) {
      const lines = readFileSync(ACTIVITY_FILE, 'utf8').split('\n').filter(Boolean);
      writeFileSync(`${ACTIVITY_FILE}.tmp`, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
      renameSync(`${ACTIVITY_FILE}.tmp`, ACTIVITY_FILE);
    }
  } catch (err) {
    console.error('activity write failed', err);
  }
}

const SESSION_GAP_MS = 30 * 60 * 1000;

function activity(days: number) {
  const since = Date.now() - days * 86_400_000;
  let events: Event[] = [];
  try {
    events = readFileSync(ACTIVITY_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Event;
        } catch {
          return null;
        }
      })
      .filter((e): e is Event => !!e && e.t >= since);
  } catch {
    events = [];
  }
  events.sort((x, y) => x.t - y.t);
  const byUser = new Map<string, Event[]>();
  for (const e of events) {
    if (!byUser.has(e.u)) byUser.set(e.u, []);
    byUser.get(e.u)!.push(e);
  }
  const users = [...new Set([...teamUsers(), ...byUser.keys()])].map((u) => {
    const list = byUser.get(u) ?? [];
    const sessions: {
      start: number; end: number; active_s: number; device: string; country: string;
      pages: { page: string; views: number; active_s: number; scroll: number }[];
    }[] = [];
    let cur: Event[] = [];
    const flush = () => {
      if (!cur.length) return;
      // One page view = one v id; its visible time and scroll are the maximum reported.
      const views = new Map<string, { page: string; a: number; s: number }>();
      for (const e of cur) {
        const v = views.get(e.v) ?? { page: e.p, a: 0, s: 0 };
        v.a = Math.max(v.a, e.a);
        v.s = Math.max(v.s, e.s);
        views.set(e.v, v);
      }
      const pages = new Map<string, { page: string; views: number; active_s: number; scroll: number }>();
      for (const v of views.values()) {
        const p = pages.get(v.page) ?? { page: v.page, views: 0, active_s: 0, scroll: 0 };
        p.views += 1;
        p.active_s += Math.round(v.a / 1000);
        p.scroll = Math.max(p.scroll, v.s);
        pages.set(v.page, p);
      }
      const ps = [...pages.values()].sort((a, b) => b.active_s - a.active_s);
      sessions.push({
        start: cur[0].t,
        end: cur[cur.length - 1].t,
        active_s: ps.reduce((n, p) => n + p.active_s, 0),
        device: cur[0].d,
        country: cur[0].c,
        pages: ps,
      });
      cur = [];
    };
    for (const e of list) {
      if (cur.length && e.t - cur[cur.length - 1].t > SESSION_GAP_MS) flush();
      cur.push(e);
    }
    flush();
    sessions.reverse();
    return {
      email: u,
      admin: isAdmin(u),
      last_seen: list.length ? list[list.length - 1].t : null,
      sessions_count: sessions.length,
      active_s: sessions.reduce((n, x) => n + x.active_s, 0),
      sessions: sessions.slice(0, 50),
    };
  });
  return { days, users };
}

// ---- CRM
type CrmCompany = {
  id: string; name: string; group?: string; website?: string; segment?: string; note?: string;
  status: string; next_step?: string; created_by: string; created_at: string; updated_at: string;
};
type CrmEntry = {
  id: string; company: string; kind: 'sent' | 'reply' | 'note'; date: string;
  channel?: string; to?: string; subject?: string; text?: string;
  by: string; at: string; forced?: boolean;
};
type CrmDoc = { companies: CrmCompany[]; entries: CrmEntry[] };

function loadCrm(): CrmDoc {
  try {
    const d = JSON.parse(readFileSync(CRM_FILE, 'utf8'));
    return { companies: Array.isArray(d.companies) ? d.companies : [], entries: Array.isArray(d.entries) ? d.entries : [] };
  } catch {
    return { companies: [], entries: [] };
  }
}

function saveCrm(doc: CrmDoc): void {
  writeFileSync(`${CRM_FILE}.tmp`, JSON.stringify(doc));
  renameSync(`${CRM_FILE}.tmp`, CRM_FILE);
}

// Short free text: whitespace collapsed, trimmed, capped.
function crmText(x: unknown, max: number): string {
  return typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// "Farrer & Co LLP" and "farrer and co" are the same firm for duplicate checks.
function crmKey(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/\b(ltd|limited|llp|plc|solicitors?|law|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Email bodies and replies keep their paragraphs: only line endings are
// normalised and runs of blank lines squeezed.
function crmBody(x: unknown, max: number): string {
  return typeof x === 'string' ? x.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '';
}

function crmDate(x: unknown): string | null {
  const d = String(x ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) ? d : null;
}

// Sends already on record for this company or this address, newest first.
function priorSends(doc: CrmDoc, companyId: string, to: string): CrmEntry[] {
  const addr = to.toLowerCase();
  return doc.entries
    .filter((e) => e.kind === 'sent' && (e.company === companyId || (addr && (e.to ?? '').toLowerCase() === addr)))
    .sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
}

// ---- pitch proposals
type Proposal = {
  id: string; line: string; text: string; base: string; by: string; at: string;
  status: 'pending' | 'confirmed' | 'rejected'; decided_by?: string; decided_at?: string;
};
type PitchLine = { text: string; proposal: string; confirmed_by: string; confirmed_at: string };
type PitchPage = { lines: Record<string, PitchLine>; proposals: Proposal[] };
type PitchDoc = { pages: Record<string, PitchPage> };

function loadPitch(): PitchDoc {
  try {
    const d = JSON.parse(readFileSync(PITCH_FILE, 'utf8'));
    return d && typeof d === 'object' && d.pages ? d : { pages: {} };
  } catch {
    return { pages: {} };
  }
}

function savePitch(doc: PitchDoc): void {
  writeFileSync(`${PITCH_FILE}.tmp`, JSON.stringify(doc));
  renameSync(`${PITCH_FILE}.tmp`, PITCH_FILE);
}

function pitchPage(doc: PitchDoc, page: string): PitchPage {
  return (doc.pages[page] ??= { lines: {}, proposals: [] });
}

// One line of text: whitespace collapsed, no line breaks, trimmed.
function cleanLine(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const t = x.replace(/\s+/g, ' ').trim();
  return t && t.length <= PITCH_TEXT_MAX ? t : null;
}

function logPitch(e: Record<string, unknown>): void {
  try {
    writeFileSync(PITCH_LOG, JSON.stringify({ t: Date.now(), ...e }) + '\n', { flag: 'a' });
  } catch (err) {
    console.error('pitch log write failed', err);
  }
}

function pitchLog(days: number) {
  const since = Date.now() - days * 86_400_000;
  try {
    return readFileSync(PITCH_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.t >= since)
      .reverse()
      .slice(0, 500);
  } catch {
    return [];
  }
}

async function checkSession(cookie: string): Promise<string | null> {
  const r = await fetch(AUTH_URL, {
    headers: { cookie, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'lawrider.uk' },
    redirect: 'manual',
  });
  if (r.status !== 202 && r.status !== 200) return null;
  return (r.headers.get('x-auth-request-user') ?? '').trim().toLowerCase() || null;
}

createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/healthz') return send(res, 200, { ok: true });

  // auth_request from the edge: 202 + who, 401 not signed in, 403 hidden page.
  if (path === '/authz') {
    let user: string | null = null;
    try {
      user = await checkSession(String(req.headers.cookie ?? ''));
    } catch (e) {
      console.error('session check failed', e);
      res.writeHead(500);
      return res.end();
    }
    if (!user) {
      res.writeHead(401);
      return res.end();
    }
    const slug = slugOf(String(req.headers['x-original-uri'] ?? ''));
    if (!canSee(user, slug)) {
      res.writeHead(403, { 'X-Auth-Request-User': user });
      return res.end();
    }
    res.writeHead(202, { 'X-Auth-Request-User': user });
    return res.end();
  }

  if (
    path !== '/teamarea/api/me' &&
    path !== '/teamarea/api/password' &&
    path !== '/teamarea/api/photo' &&
    path !== '/teamarea/api/pnl' &&
    path !== '/teamarea/api/track' &&
    path !== '/teamarea/api/admin/activity' &&
    path !== '/teamarea/api/admin/access' &&
    path !== '/teamarea/api/admin/pitch-log' &&
    path !== '/teamarea/api/pitch' &&
    path !== '/teamarea/api/crm'
  ) {
    return send(res, 404, { error: 'not found' });
  }

  const email = String(req.headers['x-team-email'] ?? '').trim().toLowerCase();
  if (!email) return send(res, 401, { error: 'not signed in' });

  if (path === '/teamarea/api/track') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'bad JSON' });
    }
    const page = String(b.page ?? '');
    const kind = String(b.kind ?? '');
    const view = String(b.view ?? '');
    if (!/^[a-z0-9-]{0,32}$/.test(page) || !['view', 'beat', 'leave'].includes(kind) || !/^[a-z0-9]{8,32}$/.test(view)) {
      return send(res, 400, { error: 'bad event' });
    }
    const num = (x: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(x) || 0)));
    appendEvent({
      t: Date.now(),
      u: email,
      p: page || 'index',
      k: kind,
      v: view,
      a: num(b.active_ms, 12 * 3600 * 1000),
      s: num(b.scroll, 100),
      d: device(String(req.headers['user-agent'] ?? '')),
      c: String(req.headers['cf-ipcountry'] ?? '').slice(0, 2),
    });
    res.writeHead(204);
    return res.end();
  }

  if (path === '/teamarea/api/admin/activity') {
    if (!canSee(email, 'admin')) return send(res, 403, { error: 'not allowed' });
    const days = Math.max(1, Math.min(365, Number(new URL(req.url ?? '', 'http://x').searchParams.get('days')) || 30));
    return send(res, 200, activity(days));
  }

  if (path === '/teamarea/api/admin/access') {
    if (!isAdmin(email)) return send(res, 403, { error: 'admins only' });
    if (req.method === 'PUT') {
      let b: { grants?: unknown };
      try {
        b = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'bad JSON' });
      }
      const users = teamUsers();
      const grants: Grants = {};
      const input = (b.grants ?? {}) as Record<string, Record<string, unknown>>;
      for (const u of Object.keys(input)) {
        if (!users.includes(u) || isAdmin(u)) continue;
        for (const p of PAGES) {
          const v = input[u]?.[p.slug];
          // Store only what differs from the default, so new pages and new
          // people keep following the defaults.
          if (typeof v === 'boolean' && v !== p.default) (grants[u] ??= {})[p.slug] = v;
        }
      }
      try {
        writeFileSync(`${ACCESS_FILE}.tmp`, JSON.stringify({ grants, updated_by: email, updated_at: new Date().toISOString() }));
        renameSync(`${ACCESS_FILE}.tmp`, ACCESS_FILE);
      } catch (e) {
        console.error('access save failed', e);
        return send(res, 500, { error: 'Could not save.' });
      }
      console.log(`access rules changed by ${email}`);
    } else if (req.method !== 'GET') {
      return send(res, 405, { error: 'method not allowed' });
    }
    const grants = loadGrants();
    return send(res, 200, {
      pages: PAGES,
      users: teamUsers().map((u) => ({
        email: u,
        admin: isAdmin(u),
        pages: Object.fromEntries(PAGES.map((p) => [p.slug, canSee(u, p.slug, grants)])),
      })),
    });
  }

  if (path === '/teamarea/api/crm') {
    if (!canSee(email, 'crm')) return send(res, 403, { error: 'not allowed' });
    if (req.method === 'GET') return send(res, 200, { admin: isAdmin(email), me: email, ...loadCrm() });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { error: 'method not allowed' });
    }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return send(res, 415, { error: 'expected application/json' });
    }
    let b: Record<string, unknown>;
    try {
      b = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8'));
    } catch {
      return send(res, 400, { error: 'bad JSON or too large' });
    }
    const action = String(b.action ?? '');
    try {
      return await serial(async () => {
        const doc = loadCrm();
        const now = new Date().toISOString();
        const id = () => randomBytes(6).toString('hex');
        const company = (cid: unknown) => doc.companies.find((c) => c.id === String(cid ?? ''));
        const done = () => {
          saveCrm(doc);
          return send(res, 200, { admin: isAdmin(email), me: email, ...doc });
        };

        if (action === 'add_company') {
          const name = crmText(b.name, 160);
          if (!name) return send(res, 400, { error: 'Enter the company name.' });
          const key = crmKey(name);
          const same = doc.companies.find((c) => crmKey(c.name) === key);
          if (same) {
            const where = (same.group ?? 'client') === 'investor' ? 'investors' : 'clients';
            return send(res, 409, { error: `"${same.name}" is already in the list of ${where}.`, company: same.id });
          }
          const group = String(b.group ?? 'client');
          if (!CRM_GROUPS.includes(group)) return send(res, 400, { error: 'bad group' });
          if (doc.companies.length >= CRM_MAX_COMPANIES) return send(res, 429, { error: 'The company list is full.' });
          doc.companies.push({
            id: id(), name, group, website: crmText(b.website, 200), segment: crmText(b.segment, 80), note: crmText(b.note, 1000),
            status: 'new', next_step: '', created_by: email, created_at: now, updated_at: now,
          });
          return done();
        }

        if (action === 'update_company') {
          const c = company(b.id);
          if (!c) return send(res, 404, { error: 'No such company.' });
          if (b.status !== undefined) {
            if (!CRM_STATUSES.includes(String(b.status))) return send(res, 400, { error: 'bad status' });
            c.status = String(b.status);
          }
          if (b.group !== undefined) {
            if (!CRM_GROUPS.includes(String(b.group))) return send(res, 400, { error: 'bad group' });
            c.group = String(b.group);
          }
          if (b.next_step !== undefined) c.next_step = crmText(b.next_step, 300);
          if (b.note !== undefined) c.note = crmText(b.note, 1000);
          if (b.website !== undefined) c.website = crmText(b.website, 200);
          if (b.segment !== undefined) c.segment = crmText(b.segment, 80);
          c.updated_at = now;
          return done();
        }

        if (action === 'log_sent') {
          const c = company(b.company);
          if (!c) return send(res, 404, { error: 'Choose a company from the list.' });
          const channel = String(b.channel ?? 'email');
          if (!CRM_CHANNELS.includes(channel)) return send(res, 400, { error: 'bad channel' });
          const to = crmText(b.to, 200);
          if (channel === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return send(res, 400, { error: 'Enter the address the email went to.' });
          const date = crmDate(b.date) ?? now.slice(0, 10);
          const prior = priorSends(doc, c.id, to);
          if (prior.length && b.force !== true) {
            // The whole point of the page: say who already wrote, and make a
            // second send a deliberate choice.
            return send(res, 409, { error: 'already_contacted', prior });
          }
          if (doc.entries.length >= CRM_MAX_ENTRIES) return send(res, 429, { error: 'The CRM log is full.' });
          doc.entries.push({
            id: id(), company: c.id, kind: 'sent', date, channel, to, subject: crmText(b.subject, 200),
            text: crmBody(b.text, 8000), by: email, at: now, ...(prior.length ? { forced: true } : {}),
          });
          if (['new', 'bounced'].includes(c.status) || !c.status) c.status = 'sent';
          if (b.next_step !== undefined) c.next_step = crmText(b.next_step, 300);
          c.updated_at = now;
          return done();
        }

        if (action === 'log_reply' || action === 'log_note') {
          const c = company(b.company);
          if (!c) return send(res, 404, { error: 'Choose a company from the list.' });
          const text = crmBody(b.text, 8000);
          if (!text) return send(res, 400, { error: action === 'log_reply' ? 'Write what they answered.' : 'Write the note.' });
          if (doc.entries.length >= CRM_MAX_ENTRIES) return send(res, 429, { error: 'The CRM log is full.' });
          doc.entries.push({
            id: id(), company: c.id, kind: action === 'log_reply' ? 'reply' : 'note',
            date: crmDate(b.date) ?? now.slice(0, 10), channel: CRM_CHANNELS.includes(String(b.channel)) ? String(b.channel) : undefined,
            text, by: email, at: now,
          });
          if (b.status !== undefined) {
            if (!CRM_STATUSES.includes(String(b.status))) return send(res, 400, { error: 'bad status' });
            c.status = String(b.status);
          } else if (action === 'log_reply') {
            c.status = 'replied';
          }
          if (b.next_step !== undefined) c.next_step = crmText(b.next_step, 300);
          c.updated_at = now;
          return done();
        }

        if (action === 'delete_entry') {
          // A wrong entry can be removed by whoever wrote it, or by an admin.
          const i = doc.entries.findIndex((e) => e.id === String(b.id ?? ''));
          if (i < 0) return send(res, 404, { error: 'No such entry.' });
          if (doc.entries[i].by !== email && !isAdmin(email)) return send(res, 403, { error: 'Only the author or an admin can delete this.' });
          doc.entries.splice(i, 1);
          return done();
        }

        return send(res, 400, { error: 'unknown action' });
      });
    } catch (e) {
      console.error('crm save failed', e);
      return send(res, 500, { error: 'Could not save.' });
    }
  }

  if (path === '/teamarea/api/admin/pitch-log') {
    if (!canSee(email, 'admin')) return send(res, 403, { error: 'not allowed' });
    const days = Math.max(1, Math.min(365, Number(new URL(req.url ?? '', 'http://x').searchParams.get('days')) || 30));
    return send(res, 200, { days, events: pitchLog(days) });
  }

  if (path === '/teamarea/api/pitch') {
    const page = String(new URL(req.url ?? '', 'http://x').searchParams.get('page') ?? '');
    if (!PITCH_PAGES.includes(page)) return send(res, 404, { error: 'unknown page' });
    if (!canSee(email, page)) return send(res, 403, { error: 'not allowed' });
    const view = (doc: PitchDoc) => {
      const p = pitchPage(doc, page);
      return {
        admin: isAdmin(email),
        lines: p.lines,
        pending: p.proposals.filter((x) => x.status === 'pending'),
      };
    };
    if (req.method === 'GET') return send(res, 200, view(loadPitch()));
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { error: 'method not allowed' });
    }
    // JSON only, for the same cross-site reason as the profile PUT.
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return send(res, 415, { error: 'expected application/json' });
    }
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'bad JSON' });
    }
    const action = String(b.action ?? '');
    try {
      return await serial(async () => {
        const doc = loadPitch();
        const p = pitchPage(doc, page);
        const now = new Date().toISOString();

        if (action === 'propose') {
          const line = String(b.line ?? '');
          const text = cleanLine(b.text);
          const base = cleanLine(b.base) ?? '';
          if (!PITCH_LINE_RE.test(line)) return send(res, 400, { error: 'bad line' });
          if (!text) return send(res, 400, { error: `Write the new version (up to ${PITCH_TEXT_MAX} characters).` });
          const current = p.lines[line]?.text ?? base;
          if (text === current) return send(res, 400, { error: 'That is the same as the current text.' });
          if (p.proposals.filter((x) => x.status === 'pending').length >= PITCH_PENDING_MAX) {
            return send(res, 429, { error: 'Too many open proposals. Ask an admin to review them first.' });
          }
          const prop: Proposal = { id: randomBytes(6).toString('hex'), line, text, base: current, by: email, at: now, status: 'pending' };
          p.proposals.push(prop);
          savePitch(doc);
          logPitch({ u: email, page, action: 'propose', id: prop.id, line, text, old: current });
          return send(res, 200, view(doc));
        }

        if (action === 'confirm' || action === 'reject') {
          if (!isAdmin(email)) return send(res, 403, { error: 'Only an admin can confirm or reject a version.' });
          const prop = p.proposals.find((x) => x.id === String(b.id ?? ''));
          if (!prop) return send(res, 404, { error: 'No such proposal.' });
          if (prop.status !== 'pending') return send(res, 409, { error: `This proposal was already ${prop.status}.` });
          prop.status = action === 'confirm' ? 'confirmed' : 'rejected';
          prop.decided_by = email;
          prop.decided_at = now;
          const old = p.lines[prop.line]?.text ?? prop.base;
          if (action === 'confirm') {
            p.lines[prop.line] = { text: prop.text, proposal: prop.id, confirmed_by: email, confirmed_at: now };
          }
          savePitch(doc);
          logPitch({ u: email, page, action, id: prop.id, line: prop.line, text: prop.text, old, proposed_by: prop.by });
          return send(res, 200, view(doc));
        }

        return send(res, 400, { error: 'unknown action' });
      });
    } catch (e) {
      console.error('pitch save failed', e);
      return send(res, 500, { error: 'Could not save.' });
    }
  }

  if (path === '/teamarea/api/pnl') {
    if (!canSee(email, 'pnl')) return send(res, 403, { error: 'not allowed' });
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
    return send(res, 200, { email, profile: load()[email] ?? {}, admin: isAdmin(email), pages: visiblePages(email) });
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
