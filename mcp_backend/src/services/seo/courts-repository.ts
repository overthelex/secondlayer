/** Read-only queries for /sud and /suddia (precomputed by CourtsRefresh). */
import type { BaseDatabase } from '@secondlayer/shared';

export interface CourtListItem {
  courtCode: number;
  slug: string;
  name: string;
  instanceCode: number | null;
  region: string | null;
  lastDecision: string | null; // YYYY-MM-DD
}

export interface Court extends CourtListItem {
  instance: string | null;
}

export interface StatRow { year: number; justiceKind: number; decisions: number }

export interface JudgeLink { slug: string; fullName: string }

export interface Judge {
  dossier: string;
  slug: string;
  fullName: string;
  courtName: string | null;
  court: { slug: string; name: string } | null;
  courtCode: number | null;
  judgeKey: string | null;
  lastSeen: string | null;
  /** last_seen of the newest register snapshot: equal to lastSeen ⇔ listed now. */
  registerDate: string | null;
}

export interface CareerRow { courtName: string; from: string; to: string }

export interface Hearing {
  at: string; // "DD.MM.YYYY HH:MI", Kyiv time, as the court publishes it
  caseNumber: string;
  presiding: string | null;
  room: string | null;
  /** Subject of the case; null when it names a person (see subjectOrNull). */
  subject: string | null;
}

export interface Hearings { items: Hearing[]; asOf: string | null }

const NAMED = /[А-ЯІЇЄҐ][а-яіїєґ'’ʼ-]+\s+[А-ЯІЇЄҐ]\.\s*[А-ЯІЇЄҐ]\./;

/** The published schedule sometimes names a party in the subject ("про визнання Іванову Н.О. недієздатною"): drop those. */
export function subjectOrNull(s: string | null): string | null {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!t || NAMED.test(t)) return null;
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
}

/** "Головуючий суддя: Черенкова Н.П., суддя-доповідач: …" → "Черенкова Н.П." */
export function presidingJudge(judges: string | null): string | null {
  const m = /Головуючий суддя:\s*([^,]+)/.exec(judges ?? '');
  return m ? m[1].trim() : null;
}

/** "Берднік Ігор Сергійович" → "Берднік І.С.", the form the schedule uses. */
export function shortName(fullName: string): string | null {
  const [sur, first, mid] = fullName.trim().split(/\s+/);
  if (!sur || !first) return null;
  return `${sur} ${first[0]}.${mid ? `${mid[0]}.` : ''}`;
}

const CUR = `SELECT DISTINCT ON (dossier_number) dossier_number, full_name, court_name, last_seen
               FROM judges_current WHERE dossier_number IS NOT NULL
              ORDER BY dossier_number, last_seen DESC NULLS LAST`;

export class CourtsRepository {
  constructor(private readonly db: BaseDatabase) {}

  async listCourts(): Promise<CourtListItem[]> {
    const r = await this.db.query(
      `SELECT s.court_code, s.slug, btrim(c.name) AS name, c.instance_code, rg.name AS region,
              to_char(st.last_decision, 'YYYY-MM-DD') AS last_decision
         FROM seo_courts s
         JOIN edrsr_courts c ON c.court_code = s.court_code
         LEFT JOIN edrsr_regions rg ON rg.region_code = c.region_code
         LEFT JOIN (SELECT court_code, max(last_decision) AS last_decision FROM seo_court_stats GROUP BY 1) st
                ON st.court_code = s.court_code
        ORDER BY rg.name NULLS FIRST, c.instance_code, c.name`,
    );
    return r.rows.map(rowToCourt);
  }

  async courtBySlug(slug: string): Promise<Court | null> {
    const r = await this.db.query(
      `SELECT s.court_code, s.slug, btrim(c.name) AS name, c.instance_code, rg.name AS region, i.name AS instance,
              (SELECT to_char(max(last_decision), 'YYYY-MM-DD') FROM seo_court_stats WHERE court_code = s.court_code) AS last_decision
         FROM seo_courts s
         JOIN edrsr_courts c ON c.court_code = s.court_code
         LEFT JOIN edrsr_regions rg ON rg.region_code = c.region_code
         LEFT JOIN edrsr_instances i ON i.instance_code = c.instance_code
        WHERE s.slug = $1`,
      [slug],
    );
    const row = r.rows[0];
    return row ? { ...rowToCourt(row), instance: row.instance } : null;
  }

  async courtStats(courtCode: number): Promise<StatRow[]> {
    const r = await this.db.query(
      'SELECT year, justice_kind, decisions FROM seo_court_stats WHERE court_code = $1 ORDER BY year DESC, justice_kind',
      [courtCode],
    );
    return r.rows.map(toStat);
  }

  /** Judges listed in the newest register snapshot at this court. */
  async courtJudges(courtCode: number): Promise<JudgeLink[]> {
    const r = await this.db.query(
      `SELECT s.slug, cur.full_name
         FROM seo_judges s JOIN (${CUR}) cur ON cur.dossier_number = s.dossier_number
        WHERE s.court_code = $1 AND cur.last_seen = (SELECT max(last_seen) FROM judges_current)
        ORDER BY cur.full_name`,
      [courtCode],
    );
    return r.rows.map((x: { slug: string; full_name: string }) => ({ slug: x.slug, fullName: x.full_name }));
  }

  async judgeBySlug(slug: string): Promise<Judge | null> {
    const r = await this.db.query(
      `SELECT s.dossier_number, s.slug, s.court_code, s.judge_key, cur.full_name, cur.court_name,
              to_char(cur.last_seen, 'YYYY-MM-DD') AS last_seen,
              (SELECT to_char(max(last_seen), 'YYYY-MM-DD') FROM judges_current) AS register_date,
              sc.slug AS court_slug, btrim(c.name) AS court_name_edrsr
         FROM seo_judges s
         JOIN (${CUR}) cur ON cur.dossier_number = s.dossier_number
         LEFT JOIN seo_courts sc ON sc.court_code = s.court_code
         LEFT JOIN edrsr_courts c ON c.court_code = s.court_code
        WHERE s.slug = $1`,
      [slug],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      dossier: x.dossier_number,
      slug: x.slug,
      fullName: x.full_name,
      courtName: x.court_name,
      court: x.court_slug ? { slug: x.court_slug, name: x.court_name_edrsr } : null,
      courtCode: x.court_code,
      judgeKey: x.judge_key,
      lastSeen: x.last_seen,
      registerDate: x.register_date,
    };
  }

  async judgeCareer(dossier: string): Promise<CareerRow[]> {
    const r = await this.db.query(
      `SELECT court_name, to_char(min(snapshot_date), 'YYYY-MM-DD') AS d_from, to_char(max(snapshot_date), 'YYYY-MM-DD') AS d_to
         FROM judges WHERE dossier_number = $1 AND court_name IS NOT NULL
        GROUP BY court_name ORDER BY min(snapshot_date)`,
      [dossier],
    );
    return r.rows.map((x: { court_name: string; d_from: string; d_to: string }) => ({ courtName: x.court_name, from: x.d_from, to: x.d_to }));
  }

  async judgeStats(courtCode: number, judgeKey: string): Promise<StatRow[]> {
    const r = await this.db.query(
      `SELECT year, justice_kind, decisions FROM seo_judge_stats
        WHERE court_code = $1 AND judge_key = $2 ORDER BY year DESC, justice_kind`,
      [courtCode, judgeKey],
    );
    return r.rows.map(toStat);
  }

  async judgeSitemap(): Promise<Array<{ slug: string; lastmod: string }>> {
    const r = await this.db.query(
      `SELECT s.slug, to_char(greatest(s.updated_at, s.created_at), 'YYYY-MM-DD') AS lastmod
         FROM seo_judges s ORDER BY s.slug`,
    );
    return r.rows;
  }

  /**
   * Next 30 days from the published schedule (opendata_court_schedule, reloaded weekly).
   * Parties (case_involved) are never read. `judge` narrows to hearings where that
   * judge sits, matched as "Прізвище І.Б." the way the schedule writes it.
   */
  async upcomingHearings(courtName: string, judge?: string | null, limit = 15): Promise<Hearings> {
    const values: unknown[] = [courtName];
    let judgeCond = '';
    if (judge) {
      values.push(`%${judge.replace(/[%_\\]/g, '').replace(/['’ʼ]/g, '_')}%`);
      judgeCond = `AND judges ILIKE $${values.length}`;
    }
    values.push(limit);
    const r = await this.db.query(
      `WITH h AS (
         SELECT DISTINCT ON (case_number, hearing_date) hearing_date, case_number, judges, court_room, case_description, imported_at,
                to_timestamp(hearing_date, 'DD.MM.YYYY HH24:MI')::timestamp AS ts
           FROM opendata_court_schedule
          WHERE court_name = $1 ${judgeCond}
            AND hearing_date ~ '^\\d{2}\\.\\d{2}\\.\\d{4}'
            AND case_number IS NOT NULL)
       SELECT hearing_date, case_number, judges, court_room, case_description,
              to_char(imported_at, 'YYYY-MM-DD') AS as_of
         FROM h
        WHERE ts >= (now() AT TIME ZONE 'Europe/Kyiv') AND ts < (now() AT TIME ZONE 'Europe/Kyiv') + interval '30 days'
        ORDER BY ts, case_number
        LIMIT $${values.length}`,
      values,
    );
    // The table is reloaded whole each week, so any row's imported_at dates the snapshot.
    return { items: r.rows.map(rowToHearing), asOf: r.rows[0]?.as_of ?? null };
  }

  async statsRefreshedAt(): Promise<string | null> {
    const r = await this.db.query(`SELECT to_char(max(refreshed_at), 'YYYY-MM-DD') AS d FROM seo_stats_years`);
    return r.rows[0]?.d ?? null;
  }
}

function rowToHearing(x: { hearing_date: string; case_number: string; judges: string | null; court_room: string | null; case_description: string | null }): Hearing {
  return {
    at: x.hearing_date,
    caseNumber: x.case_number,
    presiding: presidingJudge(x.judges),
    room: x.court_room?.trim() || null,
    subject: subjectOrNull(x.case_description),
  };
}

function rowToCourt(x: Record<string, unknown>): CourtListItem {
  return {
    courtCode: x.court_code as number,
    slug: x.slug as string,
    name: x.name as string,
    instanceCode: (x.instance_code as number | null) ?? null,
    region: (x.region as string | null) ?? null,
    lastDecision: (x.last_decision as string | null) ?? null,
  };
}

function toStat(x: { year: number; justice_kind: number; decisions: number }): StatRow {
  return { year: Number(x.year), justiceKind: Number(x.justice_kind), decisions: Number(x.decisions) };
}
