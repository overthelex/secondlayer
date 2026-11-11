import { html, type RawHtml } from './html';

// The registry packs several phones or e-mails into one string
// («+38(050)500-51-34, +38(050)500-51-34»), often with duplicates. One item per
// line, duplicates dropped, each one clickable.

export function splitContacts(value: string | null | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[,;\n]+|\s{2,}/)) {
    const item = part.trim();
    if (!item) continue;
    const key = item.replace(/[\s()-]/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  return `tel:${digits.startsWith('+') ? digits : `+${digits}`}`;
}

export function phoneList(value: string | null | undefined): RawHtml {
  const items = splitContacts(value);
  return html`${items.map((p) => html`<a class="contact" href="${telHref(p)}">${p}</a>`)}`;
}

/** Same list, each number with a «Подзвонити» button that posts it to /advocates/:id/call. */
export function phoneListWithCall(value: string | null | undefined, sourceId: string, labels: { call: string; title: string }): RawHtml {
  const items = splitContacts(value);
  return html`${items.map(
    (p) => html`<span class="contact contact--call"><a href="${telHref(p)}">${p}</a> <form method="post" action="/advocates/${sourceId}/call" class="inline"><input type="hidden" name="number" value="${p}"><button type="submit" class="btn btn-small" title="${labels.title}">☎ ${labels.call}</button></form></span>`,
  )}`;
}

export function emailList(value: string | null | undefined): RawHtml {
  const items = splitContacts(value).filter((e) => e.includes('@'));
  return html`${items.map((e) => html`<a class="contact" href="mailto:${e}">${e}</a>`)}`;
}

/** «Адвокатське бюро X; Адвокатське об'єднання Y» → one line per organisation. */
export function orgList(value: string | null | undefined): RawHtml {
  const items = value ? value.split(/;\s*/).map((s) => s.trim()).filter(Boolean) : [];
  return html`${items.map((o) => html`<span class="line">${o}</span>`)}`;
}
