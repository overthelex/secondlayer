// rejestradwokatow.pl: list pages (/adwokat/list/strona/N, 100 rows) and profile pages (/adwokat/<slug>-<id>).
import { clean, lines, normaliseEntryNumber, splitPostcodeCity, text } from './normalise';

export interface AdwokatListRow {
  id: string;
  surname: string;
  givenNames: string;
  city: string | null;
  chamber: string | null;
  statusRaw: string;
  profileUrl: string;
}

export interface AdwokaciListPage {
  rows: AdwokatListRow[];
  lastPage: number | null;
  total: number | null;
}

const ROW = /<tr>\s*<td>\d+<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*><a href="([^"]+)"/gs;

export function parseAdwokaciList(html: string): AdwokaciListPage {
  const rows: AdwokatListRow[] = [];
  for (const m of html.matchAll(ROW)) {
    const [, surname, first, second, city, chamber, status, url] = m;
    const idm = /-(\d+)\/?$/.exec(url);
    if (!idm) continue;
    rows.push({
      id: idm[1],
      surname: text(surname),
      givenNames: [text(first), text(second)].filter(Boolean).join(' '),
      city: clean(text(city)),
      chamber: clean(text(chamber)),
      statusRaw: text(status),
      profileUrl: url.replace(/\/$/, ''),
    });
  }
  const pages = [...html.matchAll(/\/adwokat\/list\/strona\/(\d+)/g)].map((m) => Number(m[1]));
  const tm = /Znaleziono:\s*<span>\s*(\d+)/.exec(html);
  return { rows, lastPage: pages.length ? Math.max(...pages) : null, total: tm ? Number(tm[1]) : null };
}

export interface AdwokatDetail {
  name: string;
  entryNumber: string | null;
  statusRaw: string | null;
  entryDate: string | null;
  officeName: string | null;
  address: string | null;
  postcode: string | null;
  city: string | null;
  phone: string | null;
  phone2: string | null;
  email: string | null;
  practices: string[];
}

function field(html: string, label: RegExp): string | null {
  const re = new RegExp(`<span>\\s*${label.source}[^<]*</span>\\s*<div[^>]*>(.*?)</div>`, 's');
  const m = re.exec(html);
  return m ? m[1] : null;
}

export function parseAdwokatDetail(html: string): AdwokatDetail {
  const sec = /<section>(.*?)<\/section>/s.exec(html)?.[1] ?? html;
  const name = text(/<h2>(.*?)<\/h2>/s.exec(sec)?.[1] ?? '');
  const entryNumber = normaliseEntryNumber(/<h3>\s*\(?([^<)]+)\)?\s*<\/h3>/s.exec(sec)?.[1] ?? null)?.replace(/\/ADW\//, '/Adw/') ?? null;
  const statusRaw = clean(text(field(sec, /Status:/) ?? ''));
  const dateRaw = clean(text(field(sec, /Data wpisu/) ?? ''));
  const entryDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
  const addrLines = lines(field(sec, /Adres do korespondencji:/) ?? '');
  let officeName: string | null = null;
  let address: string | null = null;
  let postcode: string | null = null;
  let city: string | null = null;
  if (addrLines.length) {
    const last = addrLines[addrLines.length - 1];
    const pc = splitPostcodeCity(last);
    if (pc.postcode) {
      postcode = pc.postcode;
      city = pc.city;
      addrLines.pop();
    }
    if (addrLines.length > 1 && /kancelari|adwokac|spółka|sp\.|s\.c\.|partner/i.test(addrLines[0]) && !/^(ul\.|al\.|pl\.|os\.|\d)/i.test(addrLines[0])) {
      officeName = addrLines.shift() ?? null;
    }
    address = clean(addrLines.join(', '));
  }
  const phone = clean(text(field(sec, /Komórkowy:/) ?? ''));
  const phone2 = clean(text(field(sec, /Stacjonarny:/) ?? ''));
  const em = /class="address_e"\s+data-ea="([^"]+)"\s+data-eb="([^"]+)"/.exec(sec);
  const email = em ? `${em[1]}@${em[2]}`.toLowerCase() : null;
  // the block ends where the chamber tab begins; a lazy match on `</div></div>` would cut the last item
  const practicesBlock = /PREFEROWANA PRAKTYKA<\/span><\/h3>\s*<div class="line_list_A\s*">(.*?)<div class="line_list_K/s.exec(html)?.[1] ?? '';
  const practices = [...practicesBlock.matchAll(/<div>(.*?)<\/div>/gs)].map((m) => text(m[1])).filter(Boolean);
  return { name, entryNumber, statusRaw, entryDate, officeName, address, postcode, city, phone, phone2, email, practices };
}
