/**
 * Daily refresh of the data behind /sud and /suddia:
 *  1. per-court and per-judge decision counts from each edrsr_documents
 *     partition (≈5 s per year partition; years two or more back are frozen
 *     after one run, so a normal day re-aggregates only two partitions);
 *  2. permanent slugs for courts and judges that do not have one yet;
 *  3. the current court of every judge with a dossier number.
 */
import type { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../../utils/logger.js';
import { slugify } from './translit.js';

const STATEMENT_TIMEOUT = '900s';

export class CourtsRefresh {
  private running = false;

  constructor(private readonly db: BaseDatabase) {}

  /** Returns false when a refresh is already in progress in this process. */
  async run(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    const t0 = Date.now();
    try {
      const years = await this.refreshStats();
      const courts = await this.assignCourtSlugs();
      const judges = await this.refreshJudges();
      logger.info('[seo-courts] refresh done', { years, newCourtSlugs: courts, newJudgeSlugs: judges, ms: Date.now() - t0 });
      return true;
    } finally {
      this.running = false;
    }
  }

  async isEmpty(): Promise<boolean> {
    const r = await this.db.query('SELECT NOT EXISTS (SELECT 1 FROM seo_court_stats) AS empty');
    return r.rows[0].empty;
  }

  private async refreshStats(): Promise<number[]> {
    const parts = await this.db.query(
      `SELECT c.relname, substring(c.relname from '(\\d{4})$')::int AS year
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'edrsr_documents'::regclass AND c.relname ~ '_\\d{4}$'
        ORDER BY 2`,
    );
    const final = new Set(
      (await this.db.query('SELECT year FROM seo_stats_years WHERE final')).rows.map((r: { year: number }) => r.year),
    );
    const thisYear = new Date().getFullYear();
    const done: number[] = [];
    for (const { relname, year } of parts.rows as Array<{ relname: string; year: number }>) {
      if (final.has(year)) continue;
      if (!/^edrsr_documents_p_\d{4}$/.test(relname)) continue; // identifier is interpolated below
      await this.db.transaction(async client => {
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await client.query('DELETE FROM seo_court_stats WHERE year = $1', [year]);
        await client.query('DELETE FROM seo_judge_stats WHERE year = $1', [year]);
        await client.query(
          `INSERT INTO seo_court_stats (court_code, year, justice_kind, decisions, last_decision)
           SELECT court_code, $1, coalesce(justice_kind, 0), count(*), max(adjudication_date AT TIME ZONE 'Europe/Kyiv')::date
             FROM ${relname} WHERE court_code IS NOT NULL
            GROUP BY 1, 3`,
          [year],
        );
        await client.query(
          `INSERT INTO seo_judge_stats (court_code, judge_key, year, justice_kind, decisions)
           -- Group by the raw string first, then key each distinct spelling.
           -- MATERIALIZED stops the planner pushing the key function back down
           -- to every decision row (4 min instead of 2 s on a 7.6M-row year).
           WITH g AS MATERIALIZED (
                  SELECT court_code, judge, coalesce(justice_kind, 0) AS jk, count(*) AS n FROM ${relname}
                   WHERE court_code IS NOT NULL AND judge IS NOT NULL GROUP BY 1, 2, 3),
                k AS MATERIALIZED (SELECT court_code, seo_judge_key(judge) AS k, jk, n FROM g)
           SELECT court_code, k, $1, jk, sum(n) FROM k WHERE k IS NOT NULL GROUP BY 1, 2, 4`,
          [year],
        );
        await client.query(
          `INSERT INTO seo_stats_years (year, final, refreshed_at) VALUES ($1, $2, now())
           ON CONFLICT (year) DO UPDATE SET final = EXCLUDED.final, refreshed_at = now()`,
          // late publications keep arriving for about a year
          [year, year <= thisYear - 2],
        );
      });
      done.push(year);
    }
    return done;
  }

  private async assignCourtSlugs(): Promise<number> {
    const r = await this.db.query(
      `SELECT c.court_code, btrim(c.name) AS name
         FROM edrsr_courts c
        WHERE NOT EXISTS (SELECT 1 FROM seo_courts s WHERE s.court_code = c.court_code)
          AND EXISTS (SELECT 1 FROM seo_court_stats st WHERE st.court_code = c.court_code)
        ORDER BY c.court_code`,
    );
    if (!r.rows.length) return 0;
    const taken = new Set((await this.db.query('SELECT slug FROM seo_courts')).rows.map((x: { slug: string }) => x.slug));
    // names shared by several courts (old regional appeal courts) get the code suffix from the start
    const all = await this.db.query('SELECT btrim(name) AS name, count(*)::int AS n FROM edrsr_courts GROUP BY 1');
    const dupNames = new Set(all.rows.filter((x: { n: number }) => x.n > 1).map((x: { name: string }) => x.name));
    let added = 0;
    for (const { court_code, name } of r.rows as Array<{ court_code: number; name: string }>) {
      let slug = slugify(name) || `sud-${court_code}`;
      if (dupNames.has(name) || taken.has(slug)) slug = `${slug}-${court_code}`;
      if (taken.has(slug)) continue;
      await this.db.query('INSERT INTO seo_courts (court_code, slug) VALUES ($1, $2) ON CONFLICT DO NOTHING', [court_code, slug]);
      taken.add(slug);
      added++;
    }
    return added;
  }

  private async refreshJudges(): Promise<number> {
    const r = await this.db.query(
      `SELECT DISTINCT ON (dossier_number) dossier_number, full_name
         FROM judges_current
        WHERE dossier_number IS NOT NULL AND dossier_number ~ '^[0-9A-Za-z-]{1,20}$'
          AND NOT EXISTS (SELECT 1 FROM seo_judges s WHERE s.dossier_number = judges_current.dossier_number)
        ORDER BY dossier_number, last_seen DESC NULLS LAST`,
    );
    let added = 0;
    for (const { dossier_number, full_name } of r.rows as Array<{ dossier_number: string; full_name: string }>) {
      const slug = `${slugify(full_name, 70) || 'suddia'}-${dossier_number.toLowerCase()}`;
      const ins = await this.db.query(
        'INSERT INTO seo_judges (dossier_number, slug) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [dossier_number, slug],
      );
      added += ins.rowCount ?? 0;
    }

    // Current court: the normalised name first; otherwise the court where this
    // judge signed most decisions over the last two years, provided its name
    // starts with the same word (renamed / differently declined city courts).
    await this.db.query(
      `WITH cur AS (
         SELECT DISTINCT ON (dossier_number) dossier_number, full_name, court_name
           FROM judges_current WHERE dossier_number IS NOT NULL
          ORDER BY dossier_number, last_seen DESC NULLS LAST
       ), norm AS (
         SELECT DISTINCT ON (seo_court_norm(name)) court_code, seo_court_norm(name) AS k
           FROM edrsr_courts ORDER BY seo_court_norm(name), court_code DESC
       ), resolved AS (
         SELECT cur.dossier_number, seo_judge_key(cur.full_name) AS jk,
                coalesce(norm.court_code, (
                  SELECT st.court_code FROM seo_judge_stats st JOIN edrsr_courts c ON c.court_code = st.court_code
                   WHERE st.judge_key = seo_judge_key(cur.full_name)
                     AND st.year >= extract(year FROM now())::int - 1
                     AND split_part(seo_court_norm(c.name), ' ', 1) = split_part(seo_court_norm(cur.court_name), ' ', 1)
                   GROUP BY st.court_code ORDER BY sum(st.decisions) DESC LIMIT 1)) AS court_code
           FROM cur LEFT JOIN norm ON norm.k = seo_court_norm(cur.court_name)
       )
       UPDATE seo_judges s SET court_code = r.court_code, judge_key = r.jk, updated_at = now()
         FROM resolved r
        WHERE r.dossier_number = s.dossier_number
          AND (s.court_code IS DISTINCT FROM r.court_code OR s.judge_key IS DISTINCT FROM r.jk)`,
    );
    return added;
  }
}
