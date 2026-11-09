/**
 * Helpers shared by the Polish MCP tools (pl-registry-tools.ts, pl-legal-tools.ts).
 *
 * Search responses do not carry a total. COUNT(*) OVER() would have to read every match,
 * and a common word matches millions of rows in pl_court_decisions, so each query asks for
 * one row more than the page and reports has_more from that.
 */

export const QUERY_TIMEOUT_MS = 20_000;
export const MAX_LIMIT = 50;
export const MAX_OFFSET = 1000;

export interface Page { limit: number; offset: number }

export function pageOf(args: Record<string, unknown>, defaultLimit = 20): Page {
  const limit = Math.min(Math.max(Number(args.limit) || defaultLimit, 1), MAX_LIMIT);
  const offset = Math.min(Math.max(Number(args.offset) || 0, 0), MAX_OFFSET);
  return { limit: Math.floor(limit), offset: Math.floor(offset) };
}

/** Runs one statement under a server-side timeout, so Postgres cancels a runaway scan. */
export async function runQuery(db: any, sql: string, params: unknown[]): Promise<any[]> {
  const result = await db.transaction(async (client: any) => {
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    return client.query(sql, params);
  });
  return result.rows;
}

export function pageResponse(rows: any[], page: Page, extra: Record<string, unknown> = {}) {
  return {
    results: rows.slice(0, page.limit),
    has_more: rows.length > page.limit,
    limit: page.limit,
    offset: page.offset,
    ...extra,
  };
}

export function isTimeout(err: unknown): boolean {
  return /statement timeout/i.test(String((err as Error)?.message));
}

/** YYYY-MM-DD for a real calendar date, otherwise null. */
export function isoDate(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** The digits of an identifier written with spaces or dashes, or null if it holds anything else. */
export function identifierDigits(value: unknown): string | null {
  const s = String(value ?? '').replace(/^PL/i, '').replace(/[\s-]/g, '');
  return /^\d+$/.test(s) ? s : null;
}

/**
 * SLPS writes a judge's name as the court typed it: 'Tomasz Wierzchowiec' next to
 * 'JOANNA SAWICZ'. The name indexes are exact, so the lookup tries the renderings that occur
 * instead of lower-casing 26M rows.
 */
export function nameVariants(name: string): string[] {
  const clean = name.trim().replace(/\s+/g, ' ');
  const title = clean.toLocaleLowerCase('pl').replace(/(^|[\s-])(\p{L})/gu,
    (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase('pl'));
  return [...new Set([clean, clean.toLocaleUpperCase('pl'), title])];
}

const SUPERSCRIPT: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
};

/** 'art. 22¹', 'Art 22(1)' and '22^1' are all article 22^1, the form pl_act_articles stores. */
export function normalizeArticle(value: string): string {
  let s = value.trim().toLowerCase().replace(/^art(ykuł|\.)?\s*/, '').replace(/\.$/, '').replace(/\s+/g, '');
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => '^' + [...m].map((c) => SUPERSCRIPT[c]).join(''));
  return s.replace(/^(\d+[a-z]?)\((\d+)\)$/, '$1^$2');
}

/** A window of a long text, and where the next one starts. */
export function sliceText(text: string, offset: number, max: number) {
  const start = Math.max(offset, 0);
  const end = start + max;
  return {
    text: text.slice(start, end),
    text_offset: start,
    total_chars: text.length,
    next_text_offset: end < text.length ? end : null,
  };
}

/** Some SAOS judgments are stored as HTML, the other sources as plain text. */
export function plainText(text: string): string {
  return /<\/?(p|div|strong|span|br|table)\b/i.test(text) ? htmlToText(text) : text;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
