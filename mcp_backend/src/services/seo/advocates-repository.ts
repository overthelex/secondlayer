/**
 * Read-only queries for /advokaty and /advokat, over the ЄРАУ open-data copy
 * (opendata_advocates). Only advocates whose right to practise is in force and
 * whose record carries no other note are published: suspensions, terminations
 * (incl. disciplinary ones) and records of deceased advocates never get a page.
 * Contacts (phones, e-mail) and street addresses are never selected.
 */
import type { BaseDatabase } from '@secondlayer/shared';

export const PUBLISHABLE = `a.status = 'FALSE' AND coalesce(a.status_description, '') = '' AND coalesce(btrim(a.other_info), '') = ''
  AND a.family_name IS NOT NULL AND a.name IS NOT NULL AND a.source_id ~ '^[0-9]{1,9}$'
  AND NOT EXISTS (SELECT 1 FROM seo_advocate_optout o WHERE o.source_id = a.source_id)`;

export interface AdvocateLink { id: string; familyName: string; name: string; additionalName: string | null }

export interface Advocate extends AdvocateLink {
  council: string | null;
  certificateNum: string | null;
  certificateDate: string | null;
  decisionDate: string | null;
  authority: string | null;
  city: string | null;
  region: string | null;
  orgs: Array<{ type: string | null; name: string | null }>;
  importedAt: string | null;
}

const LINK_COLS = 'a.source_id AS id, a.family_name, a.name, a.additional_name';
const toLink = (x: { id: string; family_name: string; name: string; additional_name: string | null }): AdvocateLink =>
  ({ id: x.id, familyName: x.family_name, name: x.name, additionalName: x.additional_name || null });

export class AdvocatesRepository {
  constructor(private readonly db: BaseDatabase) {}

  async councils(): Promise<Array<{ council: string; count: number }>> {
    const r = await this.db.query(
      `SELECT btrim(a.ra_name) AS council, count(*)::int AS count FROM opendata_advocates a
        WHERE ${PUBLISHABLE} AND coalesce(btrim(a.ra_name), '') <> '' GROUP BY 1 ORDER BY 1`,
    );
    return r.rows;
  }

  async letters(council: string): Promise<Array<{ letter: string; count: number }>> {
    const r = await this.db.query(
      `SELECT upper(left(btrim(a.family_name), 1)) AS letter, count(*)::int AS count FROM opendata_advocates a
        WHERE ${PUBLISHABLE} AND btrim(a.ra_name) = $1 GROUP BY 1 ORDER BY 1`,
      [council],
    );
    return r.rows;
  }

  async byLetter(council: string, letter: string): Promise<AdvocateLink[]> {
    const r = await this.db.query(
      `SELECT ${LINK_COLS} FROM opendata_advocates a
        WHERE ${PUBLISHABLE} AND btrim(a.ra_name) = $1 AND upper(left(btrim(a.family_name), 1)) = $2`,
      [council, letter],
    );
    return r.rows.map(toLink);
  }

  async byId(id: string): Promise<Advocate | null> {
    const r = await this.db.query(
      `SELECT ${LINK_COLS}, btrim(a.ra_name) AS council, a.certificate_num, a.certificate_date, a.decision_date,
              a.authority_name, a.work_address->0->>'workAddressCity' AS city, a.work_address->0->>'workAddressRegion' AS region,
              coalesce((SELECT jsonb_agg(jsonb_build_object('type', f->>'orgFormType', 'name', f->>'orgFormName'))
                          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.org_forms) = 'array' THEN a.org_forms ELSE '[]'::jsonb END) f), '[]') AS orgs,
              to_char(a.imported_at, 'YYYY-MM-DD') AS imported_at
         FROM opendata_advocates a WHERE a.source_id = $1 AND ${PUBLISHABLE}`,
      [id],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      ...toLink(x),
      council: x.council,
      certificateNum: x.certificate_num,
      certificateDate: /^\d{4}-\d{2}-\d{2}/.test(x.certificate_date ?? '') ? x.certificate_date.slice(0, 10) : null,
      decisionDate: /^\d{4}-\d{2}-\d{2}/.test(x.decision_date ?? '') ? x.decision_date.slice(0, 10) : null,
      authority: x.authority_name,
      city: x.city,
      region: x.region,
      orgs: (x.orgs as Array<{ type: string | null; name: string | null }>).filter(o => o.name),
      importedAt: x.imported_at,
    };
  }

  async sitemap(): Promise<{ items: AdvocateLink[]; lastmod: string | null }> {
    const r = await this.db.query(
      `SELECT ${LINK_COLS} FROM opendata_advocates a WHERE ${PUBLISHABLE} ORDER BY a.source_id::bigint LIMIT 49000`,
    );
    const m = await this.db.query(`SELECT to_char(max(imported_at), 'YYYY-MM-DD') AS d FROM opendata_advocates`);
    return { items: r.rows.map(toLink), lastmod: m.rows[0]?.d ?? null };
  }
}
