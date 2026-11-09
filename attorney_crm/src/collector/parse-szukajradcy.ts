// szukajradcy.pl: city listing pages (/radca-prawny-<city>?radcowie_page_<city>=N) and profiles (/lawyers/<slug>).
// /search is disallowed by robots.txt and is never requested.
import { clean, normaliseEntryNumber, normalisePhone, text } from './normalise';

export interface CityPage {
  profiles: string[];
  lastPage: number | null;
  pageParam: string | null;
}

export function parseCityPage(html: string): CityPage {
  const profiles = [...new Set([...html.matchAll(/href="(https:\/\/szukajradcy\.pl\/lawyers\/[^"/?#]+)\/?"/g)].map((m) => m[1]))];
  const pager = [...html.matchAll(/class="sr-pagination__link"\s+href="[^"?]*\?([a-z_]+)=(\d+)"/g)];
  const pages = pager.map((m) => Number(m[2]));
  return { profiles, lastPage: pages.length ? Math.max(...pages) : null, pageParam: pager[0]?.[1] ?? null };
}

export interface DirectoryProfile {
  name: string;
  city: string | null;
  officeName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
  entryNumber: string | null;
  tags: string[];
}

export function parseDirectoryProfile(html: string): DirectoryProfile {
  const contact = /<div class="single-lawyer-contact__data">(.*?)<div class="single-lawyer-contact__buttons/s.exec(html)?.[1] ?? '';
  const buttons = /<div class="single-lawyer-contact__buttons(.*?)<div class="modal"/s.exec(html)?.[1] ?? '';
  const name = text(/<h1 class="single-lawyer-contact__name">(.*?)<\/h1>/s.exec(contact)?.[1] ?? '');
  const item = (label: string): string | null => {
    const m = new RegExp(`<span class="visually-hidden">${label}</span>(.*?)</(?:span|a)>`, 's').exec(contact);
    return m ? clean(text(m[1])) : null;
  };
  const phoneHref = /href="tel:([^"]+)"/.exec(contact)?.[1] ?? null;
  const website = /href="(https?:\/\/[^"]+)"[^>]*rel="nofollow"/.exec(buttons)?.[1] ?? null;
  const entryNumber = normaliseEntryNumber(/Numer uprawnień:\s*<span>(.*?)<\/span>/s.exec(html)?.[1] ?? null);
  const tagsBlock = /<ul class="single-lawyer-areas-of-practice__list">(.*?)<\/ul>/s.exec(html)?.[1] ?? '';
  const tags = [...tagsBlock.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => text(m[1]).toLowerCase()).filter(Boolean);
  return {
    name,
    city: item('Miasto:'),
    officeName: item('Pracuje w:'),
    email: (item('E-mail:') ?? /href="mailto:([^"?]+)"/.exec(contact)?.[1] ?? null)?.toLowerCase() ?? null,
    phone: normalisePhone(phoneHref ?? item('Telefon:')),
    address: item('Adres:'),
    website: website && !/google\.com\/maps/.test(website) ? website : null,
    entryNumber,
    tags,
  };
}
