// The regional chambers (OIRP) that publish radca contacts on their own sites. All of these lists are
// opt-in: a radca or a firm asked to be listed, so the yield is a few hundred per chamber at most.
//   Kraków      https://oirp.krakow.pl/radcy/?page=N         cards with KR-number and, when filled in, phone/e-mail
//               https://oirp.krakow.pl/kancelarie/?page=N    firm cards (NIP, phone, e-mail, website)
//   Olsztyn     https://oirp.olsztyn.pl/radcowie/lista-kancelarii/   one TablePress table
//   Opole       https://oirp.opole.pl/kancelarie?page=N      table; /kancelarie/<id> has e-mail and website
//   Zielona Góra https://zielonagora.oirp.pl/lista-kancelarii/        cards with the radca's name and number
//   Szczecin    https://oirp.szczecin.pl/listy/lista-kancelarii/      tiles; /kancelaria/<slug>/ has the contacts
//   Rzeszów     https://www.oirp.rzeszow.pl/json/kancelaria.json       the JSON the list page itself loads
// Wrocław forbids all crawlers in robots.txt and is not here. The other twelve chambers publish names only.
import { clean, normalisePhone, splitPostcodeCity, text } from './normalise';

const stripSvg = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
const email = (s: string | null | undefined): string | null => {
  const m = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(s ?? '');
  return m ? m[0].toLowerCase() : null;
};
const website = (s: string | null | undefined): string | null => {
  const v = clean(s);
  if (!v) return null;
  const m = /(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/i.exec(v);
  return m && !/@/.test(m[0]) && !/google\.com\/maps/.test(m[0]) ? m[0].replace(/[.,;]$/, '') : null;
};
const pager = (html: string): number | null => {
  const m = /Strona\s+\d+\s+z\s+(\d+)/.exec(html);
  return m ? Number(m[1]) : null;
};

// ── Kraków ──

export interface KrakowRadca { name: string; entryNumber: string; phone: string | null; email: string | null }

export function parseKrakowRadcy(html: string): { rows: KrakowRadca[]; lastPage: number | null } {
  const h = stripSvg(html);
  const rows: KrakowRadca[] = [];
  for (const m of h.matchAll(/<div class="wynik[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*(?=<div class="wynik|<\/div>\s*<div class="pagination-block|$)/g)) {
    const card = m[1];
    const name = text(/<h4>([\s\S]*?)<\/h4>/.exec(card)?.[1] ?? '');
    const stan = text(/class="orange stanowisko">([\s\S]*?)<\/p>/.exec(card)?.[1] ?? '');
    const entryNumber = clean(stan.split('/').slice(1).join('/'));
    if (!name || !entryNumber) continue;
    rows.push({
      name,
      entryNumber: entryNumber.toUpperCase(),
      phone: normalisePhone(/href="tel:([^"]+)"/.exec(card)?.[1]),
      email: email(/href="mailto:([^"]+)"/.exec(card)?.[1]),
    });
  }
  return { rows, lastPage: pager(h) };
}

export interface KrakowFirm {
  name: string; kind: string; phone: string | null; email: string | null; website: string | null; nip: string | null; city: string | null; address: string | null; tags: string[];
}

export function parseKrakowKancelarie(html: string): { rows: KrakowFirm[]; lastPage: number | null } {
  const h = stripSvg(html);
  const rows: KrakowFirm[] = [];
  const starts = [...h.matchAll(/<div class="wynik[^"]*">/g)].map((m) => m.index!);
  starts.forEach((start, i) => {
    const card = h.slice(start, starts[i + 1] ?? h.indexOf('<div class="pagination-block', start));
    const name = text(/<h4>([\s\S]*?)<\/h4>/.exec(card)?.[1] ?? '');
    if (!name) return;
    const kind = text(/class="orange stanowisko">([\s\S]*?)<\/p>/.exec(card)?.[1] ?? '');
    const addr = /<span class="kontaktowy"><span class="ikonka"><\/span>([^<]*)<br>([^<]*)<\/span>/.exec(card);
    const cityOnly = [...card.matchAll(/<span class="kontaktowy"><span class="ikonka"><\/span>([^<]+)<\/span>/g)].map((m) => clean(m[1])).filter(Boolean) as string[];
    const tags = [...(/<ul class="specjalizacje">([\s\S]*?)<\/ul>/.exec(card)?.[1] ?? '').matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]).toLowerCase()).filter(Boolean);
    rows.push({
      name,
      kind,
      phone: normalisePhone(/href="tel:([^"]+)"/.exec(card)?.[1]),
      email: email(/href="mailto:([^"]+)"/.exec(card)?.[1]),
      website: website(/<a href="(https?:\/\/[^"]+)" class="kontaktowy"/.exec(card)?.[1]),
      nip: clean(/NIP:\s*([\d-]+)/.exec(card)?.[1])?.replace(/-/g, '') ?? null,
      city: cityOnly.find((c) => !/\d/.test(c)) ?? null,
      address: addr ? clean(`${text(addr[1])}, ${text(addr[2])}`) : null,
      tags,
    });
  });
  return { rows, lastPage: pager(h) };
}

// ── Olsztyn ──

export interface OlsztynFirm { name: string; city: string | null; phone: string | null; phone2: string | null; email: string | null; website: string | null; address: string | null }

export function parseOlsztynKancelarie(html: string): OlsztynFirm[] {
  const rows: OlsztynFirm[] = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 4) continue; // the <th> header row
    const name = clean(text(cells[0]));
    if (!name) continue;
    const phones = text(cells[2]).split('\n').map((l) => l.trim()).filter((l) => l && !/^fax/i.test(l)).map((l) => normalisePhone(l)).filter((p): p is string => !!p);
    const infoLines = text(cells[3]).split('\n').map((l) => l.trim()).filter(Boolean);
    const addressLines = infoLines.filter((l) => !/@/.test(l) && !/^www\./i.test(l) && !/^e-?mail/i.test(l));
    rows.push({
      name,
      city: clean(text(cells[1])),
      phone: phones[0] ?? null,
      phone2: phones[1] ?? null,
      email: email(text(cells[3])),
      website: infoLines.map((l) => (/^www\./i.test(l) ? l : null)).find(Boolean) ?? null,
      address: addressLines.length ? addressLines.join(', ') : null,
    });
  }
  return rows;
}

// ── Opole ──

export interface OpoleRow { name: string; city: string | null; phone: string | null; path: string }
export interface OpoleDetail { name: string; address: string | null; city: string | null; postcode: string | null; phone: string | null; phone2: string | null; email: string | null; website: string | null }

export function parseOpoleList(html: string): { rows: OpoleRow[]; lastPage: number | null } {
  const rows: OpoleRow[] = [];
  for (const m of html.matchAll(/<tr><td><a href="(\/kancelarie\/\d+)">([\s\S]*?)<\/a><\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/g)) {
    rows.push({ name: text(m[2]), city: clean(text(m[3])), phone: normalisePhone(text(m[4])), path: m[1] });
  }
  const pages = [...html.matchAll(/class="page-link"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
  return { rows, lastPage: pages.length ? Math.max(...pages) : null };
}

export function parseOpoleDetail(html: string): OpoleDetail {
  const field = (label: string): string | null => {
    const m = new RegExp(`<p class="text-sm text-gray-400">${label}</p>\\s*<p class="font-bold">([\\s\\S]*?)</p>`).exec(html);
    const v = clean(text(m?.[1] ?? ''));
    return v && v !== '-' ? v : null;
  };
  return {
    name: text(/<h1 class="text-xl font-bold">([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? ''),
    address: field('Adres'),
    city: field('Miasto'),
    postcode: field('Kod pocztowy'),
    phone: normalisePhone(field('Telefon')),
    phone2: normalisePhone(field('Telefon komórkowy')),
    email: email(field('Email')),
    website: website(field('WWW')),
  };
}

// ── Zielona Góra ──

export interface ZielonaGoraRow { surname: string; givenNames: string; entryNumberRaw: string | null; officeName: string | null; address: string | null; phone: string | null; email: string | null; website: string | null }

export function parseZielonaGoraKancelarie(html: string): ZielonaGoraRow[] {
  const rows: ZielonaGoraRow[] = [];
  const starts = [...html.matchAll(/<div class="tabela-kancelarie p-4">/g)].map((m) => m.index!);
  starts.forEach((start, i) => {
    const card = html.slice(start, starts[i + 1] ?? html.length);
    const infoRows = [...card.matchAll(/<div class="col-md-12 info-row">([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
    const head = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(infoRows[0] ?? '');
    const person = (head ? head[1] : infoRows[0] ?? '').replace(/\s*-\s*/g, '-').trim();
    const parts = person.split(/\s+/);
    if (parts.length < 2) return;
    const contactBlock = /<div class="dane-kontaktowe">([\s\S]*?)$/.exec(card)?.[1] ?? '';
    const contactText = text(contactBlock);
    const phone = /Nr tel\.?:\s*([+\d][\d\s-]+)/.exec(contactText)?.[1] ?? null;
    const nonContact = contactText.split('\n').map((l) => l.trim()).filter((l) => l && !/^(Dane kontaktowe|Nr tel|Fax)/i.test(l) && !/@/.test(l));
    rows.push({
      surname: parts[0],
      givenNames: parts.slice(1).join(' '),
      entryNumberRaw: head ? clean(head[2]) : null,
      officeName: clean(infoRows[1] ?? null),
      address: clean(text(/<div class="adres">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/.exec(card)?.[1] ?? ''))?.replace(/\s*\(poczta:[^)]*\)/, '') ?? null,
      phone: normalisePhone(phone),
      email: email(contactText),
      website: nonContact.map(website).find(Boolean) ?? null,
    });
  });
  return rows;
}

// ── Szczecin ──

export interface SzczecinTile { url: string; name: string; city: string | null }
export interface SzczecinDetail { officeName: string | null; address: string | null; postcode: string | null; city: string | null; phone: string | null; email: string | null; website: string | null; tags: string[] }

export function parseSzczecinList(html: string): SzczecinTile[] {
  const out: SzczecinTile[] = [];
  for (const m of html.matchAll(/<div class="kancelariaTile">\s*<a href="(https:\/\/oirp\.szczecin\.pl\/kancelaria\/[^"]+)">([\s\S]*?)<\/a>\s*<\/div>/g)) {
    const name = text(/class="kancelariaImieNazwisko">([\s\S]*?)<\/div>/.exec(m[2])?.[1] ?? '');
    if (!name) continue;
    out.push({ url: m[1], name, city: clean(text(/class="kancelariaMiasto">([\s\S]*?)<\/div>/.exec(m[2])?.[1] ?? '')) });
  }
  return out;
}

export function parseSzczecinDetail(html: string): SzczecinDetail {
  const block = /<div class="kancelariaKontakt">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const ls = text(block).split('\n').map((l) => l.trim()).filter(Boolean);
  const officeName = ls[0] ?? null;
  const addrLines = ls.slice(1).filter((l) => !/^(tel|kom|e-?mail|strona|fax|www)\b/i.test(l) && !/@/.test(l));
  const pc = addrLines.map((l) => /^(\d{2}-\d{3})\s+(.+)$/.exec(l)).find(Boolean);
  const tagsBlock = /<h3>Specjalizacje<\/h3>\s*<ul>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
  return {
    officeName,
    address: addrLines.length ? addrLines.join(', ') : null,
    postcode: pc ? pc[1] : null,
    city: pc ? pc[2].trim() : null,
    phone: normalisePhone(/(?:tel|kom)\.?:\s*([+\d][\d\s-]+)/i.exec(text(block))?.[1]),
    email: email(block),
    website: website(/strona:\s*<a href="([^"]+)"/i.exec(block)?.[1]),
    tags: [...tagsBlock.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]).toLowerCase()).filter(Boolean),
  };
}

// ── Rzeszów ──

export interface RzeszowFirm { name: string; kind: string | null; phone: string | null; email: string | null; website: string | null; address: string | null; postcode: string | null; city: string | null }

export function parseRzeszowJson(json: string): RzeszowFirm[] {
  const data = JSON.parse(json) as unknown;
  const list = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>).find(Array.isArray) ?? [];
  const out: RzeszowFirm[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const name = clean(String(raw.workplace_name ?? ''));
    if (!name) continue;
    const pc = raw.postcode as Record<string, unknown> | null | undefined;
    const kind = raw.chancellory_type as Record<string, unknown> | null | undefined;
    out.push({
      name,
      kind: clean(String(kind?.chancellory_type_name ?? '')),
      phone: normalisePhone(raw.workplace_phone as string | null),
      email: email(raw.workplace_email as string | null),
      website: website(raw.workplace_www as string | null),
      address: clean(raw.workplace_address as string | null),
      postcode: clean(pc?.postcode as string | null),
      city: clean(pc?.city_name as string | null),
    });
  }
  return out;
}

// ── matching helpers ──

const FIRM_WORDS = new Set([
  'kancelaria', 'kancelarie', 'kancelarii', 'radcy', 'radca', 'radcow', 'radców', 'radcowie', 'prawnego', 'prawny', 'prawna', 'prawne', 'prawnych', 'prawnicza', 'prawnicze', 'prawniczy',
  'krp', 'k.r.p', 'k.r.p.', 'sc', 's.c', 's.c.', 'sp', 'sp.', 'spk', 'sp.k', 'sp.k.', 'spółka', 'spolka', 'partnerska', 'komandytowa', 'jawna', 'cywilna', 'z', 'o.o', 'o.o.', 'oo', 'zoo',
  'dr', 'mgr', 'prof', 'hab', 'r.pr', 'r.pr.', 'adw', 'adw.', 'adwokat', 'adwokata', 'adwokatów', 'adwokacka',
  'prawa', 'prawo', 'obsługa', 'obsługi', 'doradztwo', 'doradztwa', 'usługi', 'pomoc', 'pomocy', 'biuro', 'legal', 'law', 'office', 'consulting', 'group', 'partners', 'partnerzy',
  'handlowego', 'gospodarczego', 'cywilnego', 'pracy', 'rodzinnego', 'i', 'oraz', 'and', '&', 'wspólnicy', 'wspolnicy', 'współpracownicy', 'wspolpracownicy', 'filia', 'oddział',
]);

/**
 * Person-name candidates hidden in a firm name: strip firm vocabulary, abbreviations, quoted brands and
 * bracketed notes; what is left must be two or three capitalised words. Two → both orders; three → the
 * first-and-last reading in both orders. "i"/"&" between surnames or a four-word remainder means a
 * multi-person firm, and nothing is returned: a firm e-mail must not land on the wrong radca.
 */
export function personFromOfficeName(officeName: string): { surname: string; givenNames: string }[] {
  let s = officeName.replace(/"[^"]*"|„[^”]*”|\([^)]*\)/g, ' ').replace(/&quot;[^&]*&quot;/g, ' ');
  s = s.replace(/\s*-\s*/g, '-').replace(/-(?=[A-ZŁŚŻŹĆŃÓĘĄ][a-ząćęłńóśźż]*(?:\s|$))(?=Kancelari)/g, ' ');
  // "Ewa-Kancelaria" glued by a stray hyphen: split off firm words
  s = s.replace(/-(Kancelari\w*)/g, ' $1');
  const tokens = s.split(/[\s,;]+/).map((t) => t.replace(/^[^\p{L}.]+|[^\p{L}.]+$/gu, '')).filter(Boolean);
  const rest = tokens.filter((t) => !FIRM_WORDS.has(t.toLowerCase()) && !/\d/.test(t) && !/^\p{L}\.$/u.test(t) && /^\p{Lu}[\p{L}-]*$/u.test(t));
  if (rest.length < tokens.filter((t) => !FIRM_WORDS.has(t.toLowerCase())).length) return []; // an initial, a brand or a number was in the way
  if (/(^|\s)(i|&|oraz)(\s|$)/i.test(officeName) && rest.length > 2) return [];
  if (rest.some((t) => t.length <= 4 && t === t.toUpperCase())) return []; // "GP", "MW": a brand, not a name
  if (rest.length === 2) return [{ surname: rest[1], givenNames: rest[0] }, { surname: rest[0], givenNames: rest[1] }];
  if (rest.length === 3) return [{ surname: rest[2], givenNames: `${rest[0]} ${rest[1]}` }, { surname: rest[0], givenNames: `${rest[1]} ${rest[2]}` }];
  return [];
}

/**
 * 'R-ZG-ZG-690' / 'RZG/ZG/439' / 'ZG ZG 500' → 'ZGZG690' / 'ZGZG439' / 'ZGZG500' for chamber code ZG; the register's
 * own 'KR-1363' → 'KR1363'. The chambers prefix "R" (radca) now and then; it is dropped only before the chamber's code,
 * so Rzeszów's 'RZ-1176' stays 'RZ1176'.
 */
export function looseEntryKey(s: string, chamberCode?: string): string {
  const k = s.toUpperCase().replace(/[^\p{L}\d]/gu, '');
  return chamberCode && k.startsWith(`R${chamberCode}`) ? k.slice(1) : k;
}
