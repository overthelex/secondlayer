/**
 * UkLegislationTools — search, current text, point-in-time text and amendment history
 * over the UK statute book: `uk_legislation` (238,926 acts), `uk_legislation_provisions`
 * (current text, 129,897 acts), `uk_provision_version` + `uk_provision_text`
 * (point-in-time, 62,866 acts) and `uk_legislation_effects` (1.2M amendments).
 * See migrations 195, 196_uk_legislation_effect_scopes and 217_uk_point_in_time.
 *
 * Licensing: legislation.gov.uk is Open Government Licence v3.0 and commercial use is
 * permitted, so none of this is gated. ⚠ The judgments in `uk_court_decisions` are NOT
 * covered by that and have their own per-user gate in services/uk-judgment-access.ts —
 * nothing here may reach across into them.
 *
 * Three properties of the corpus that every tool below has to be honest about, because
 * each one produces a confidently wrong answer if it is papered over:
 *
 * 1. `valid_to IS NULL` means "still standing in the last version the archive holds for
 *    this act", NOT "in force today". The archive lags the live site, and an act can be
 *    repealed wholesale without a further revised version ever being published. Every
 *    point-in-time response carries `as_at_caveat` saying so.
 *
 * 2. Only 62,866 of 238,926 acts have any version history at all, and only 129,897 have
 *    text of any kind. The rest are published by the source as scans alone — measured,
 *    not assumed: loading the entire 186 GB historical archive added text for exactly one
 *    act the register did not already cover. So "no text" is reported as a coverage fact
 *    with a source link, never as a 404 that invites the caller to retry.
 *
 * 3. A provision is identified by `provision_key` — its own IdURI minus the version date,
 *    e.g. `ukpga/1990/8/section/55`. The positional `ord` is NOT an identifier: inserting
 *    a section shifts every ord after it, which is exactly what an amendment does.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import { datesToDays } from './uk-dates.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const AS_AT_CAVEAT =
  'An open interval (valid_to = null) means "in force as of the latest version the archive ' +
  'holds", not "in force today": the archive lags the live site, and an act can be ' +
  'repealed outright without a new revised version being published.';

const NO_TEXT_NOTE =
  'The source publishes this act only as scanned images; none of the legislation.gov.uk ' +
  'bulk collections carries its text. This is a property of the source, not a harvesting gap.';

// The register holds ids like `ukpga/1990/8`, `eur/2009/1198`, `aep/Hen3/23`.
const LEG_ID_RE = /^[a-z]{2,6}\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

function normaliseLegId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const id = String(value).trim().replace(/^https?:\/\/(?:www\.)?legislation\.gov\.uk\/(?:id\/)?/, '').replace(/\/+$/, '');
  return LEG_ID_RE.test(id) ? id : null;
}

/**
 * Accepts a section number ('55', '2A'), a bare key ('section/55') or a full key
 * ('ukpga/1990/8/section/55') and returns the full key. A bare number is assumed to be a
 * section, which is right for primary legislation and wrong for SIs — hence `kind`.
 */
function buildProvisionKey(legId: string, provision: string, kind?: string): string {
  const raw = String(provision).trim().replace(/^https?:\/\/(?:www\.)?legislation\.gov\.uk\//, '').replace(/\/+$/, '');
  if (raw.startsWith(legId + '/')) return raw;
  if (raw.includes('/')) return `${legId}/${raw}`;
  const type = (kind || (legId.startsWith('uksi') || legId.startsWith('ssi') || legId.startsWith('wsi') || legId.startsWith('nisr') ? 'regulation' : 'section')).trim();
  return `${legId}/${type}/${raw}`;
}

/**
 * Sentinel for "the caller's number matched more than one provision". Returning the
 * first row would be the wrong kind of helpful: `4` in an act can be section 4 and also
 * paragraph 4 of a schedule, and a lawyer quoting the wrong one has no way to tell.
 */
const AMBIGUOUS = Symbol('ambiguous');

function pickOne(rows: any[], key: string): any {
  if (!rows.length) return null;
  const exact = rows.find((r) => r.provision_key === key);
  if (exact) return exact;
  const keys = new Set(rows.map((r) => r.provision_key));
  return keys.size === 1 ? rows[0] : AMBIGUOUS;
}

export class UkLegislationTools extends BaseToolHandler {
  /** Every reply goes through here, so DATE columns leave as calendar days (see uk-dates.ts). */
  protected override wrapResponse(data: any): ToolResult {
    return super.wrapResponse(datesToDays(data));
  }

  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'uk_search_legislation',
        annotations: { title: 'Search UK legislation', readOnlyHint: true },
        description: `Search UK statute law by title or identifier.

Corpus: 238,926 acts: Acts of Parliament (ukpga), statutory instruments (uksi), Scottish (asp, ssi), Northern Irish (nia, nisr), Welsh (asc, anaw, wsi), historical (aep, apgb) and retained EU law (eur, eudn, eudr).
query is part of a title or an identifier such as 'ukpga/1990/8'. leg_type and year narrow the search.
⚠ Every result carries has_text and versions: 129,897 acts have text and 62,866 have version history. The source publishes the rest only as scans.
Next: uk_get_act for metadata and coverage, uk_get_provision for the text of a provision (with as_of, as at a date), uk_get_provision_history for how a provision changed.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Part of a title or an identifier, e.g. 'Companies Act 2006' or 'ukpga/2006/46'" },
            leg_type: { type: 'string', description: "Legislation type: ukpga, uksi, asp, ssi, nia, nisr, asc, anaw, wsi, eur, eudn, eudr, etc." },
            year: { type: 'number', description: 'Year' },
            with_text_only: { type: 'boolean', default: false, description: 'Only acts that have text' },
            limit: { type: 'number', default: 20, maximum: 50, description: 'Maximum results' },
            offset: { type: 'number', default: 0, description: 'Pagination offset' },
          },
          required: ['query'],
        },
      },
      {
        name: 'uk_get_act',
        annotations: { title: 'UK act: metadata and coverage', readOnlyHint: true },
        description: `Metadata for an act, with a plain account of what we actually hold for it.

Requires leg_id (e.g. 'ukpga/2006/46'). Returns title, type, year, number, status, extent, enactment and commencement dates, and also:
coverage: how many provisions have text, whether version history (point in time) exists and its date range;
effects: the number of amendments affecting the act, and how many are unapplied (made but not yet editorially reflected in the text). ⚠ This is the main reason the current text can lag the law: 32,766 acts have at least one unapplied amendment.
If there is no text, it says why and links to the source instead of returning an empty result.`,
        inputSchema: {
          type: 'object',
          properties: {
            leg_id: { type: 'string', description: "Act identifier, e.g. 'ukpga/2006/46'" },
          },
          required: ['leg_id'],
        },
      },
      {
        name: 'uk_get_provision',
        annotations: { title: 'UK provision, optionally as at a date', readOnlyHint: true },
        description: `Text of a single provision (section, regulation, article, schedule) of a UK act.

Requires leg_id and provision. provision accepts a number ('55', '2A'), a partial key ('section/55') or a full key ('ukpga/1990/8/section/55').
Without as_of it returns the current text from uk_legislation_provisions.
With as_of (YYYY-MM-DD) it returns the version in force on that date, from the interval [valid_from, valid_to). This is available for 62,866 acts; where an act has no history the tool says so and returns the current text.
⚠ ${AS_AT_CAVEAT}`,
        inputSchema: {
          type: 'object',
          properties: {
            leg_id: { type: 'string', description: "Act identifier, e.g. 'ukpga/1990/8'" },
            provision: { type: 'string', description: "Provision number or key, e.g. '55' or 'section/55'" },
            provision_type: { type: 'string', description: "Provision type when the number is ambiguous: section, regulation, article, paragraph" },
            as_of: { type: 'string', description: 'Date (YYYY-MM-DD): the text as it stood on that day' },
          },
          required: ['leg_id', 'provision'],
        },
      },
      {
        name: 'uk_get_provision_history',
        annotations: { title: 'UK provision revision history', readOnlyHint: true },
        description: `Full timeline of versions of one provision: every interval during which its text did not change, from the earliest version in the archive to the current one.

Requires leg_id and provision. For each interval it returns valid_from, valid_to, the text length and, with include_text, the text itself.
This is the direct way to answer "when and how did this provision change". For example, section 4 of the Human Rights Act 1998 has five intervals, and 2009-10-01 in the list is the day the Constitutional Reform Act 2005 replaced the House of Lords with the Supreme Court.
⚠ ${AS_AT_CAVEAT}`,
        inputSchema: {
          type: 'object',
          properties: {
            leg_id: { type: 'string', description: "Act identifier" },
            provision: { type: 'string', description: 'Provision number or key' },
            provision_type: { type: 'string', description: 'Provision type when the number is ambiguous' },
            include_text: { type: 'boolean', default: false, description: 'Return the text of each version, not only the dates' },
          },
          required: ['leg_id', 'provision'],
        },
      },
      {
        name: 'uk_get_act_as_at',
        annotations: { title: 'Whole UK act as at a date', readOnlyHint: true },
        description: `The whole act as it stood on a given date, in document order.

Requires leg_id and as_of (YYYY-MM-DD). Available for the 62,866 acts that have version history.
offset/max_chars page through the text (max_chars defaults to 50000, maximum 200000); truncated=true if the text did not fit.
If no provision was in force on as_of, it returns the earliest and latest known dates instead of an empty result, so you can see whether the date falls outside the archive.
⚠ ${AS_AT_CAVEAT}`,
        inputSchema: {
          type: 'object',
          properties: {
            leg_id: { type: 'string', description: "Act identifier, e.g. 'ukpga/2006/46'" },
            as_of: { type: 'string', description: 'Date (YYYY-MM-DD)' },
            offset: { type: 'number', default: 0, description: 'Offset in characters' },
            max_chars: { type: 'number', default: 50000, maximum: 200000, description: 'Maximum characters in the response' },
          },
          required: ['leg_id', 'as_of'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'uk_search_legislation': return this.searchLegislation(args);
      case 'uk_get_act': return this.getAct(args);
      case 'uk_get_provision': return this.getProvision(args);
      case 'uk_get_provision_history': return this.getProvisionHistory(args);
      case 'uk_get_act_as_at': return this.getActAsAt(args);
      default: return null;
    }
  }

  // ─── uk_search_legislation ─────────────────────────────────────────

  private async searchLegislation(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, leg_type, year, with_text_only = false } = args as any;
    const limit = Math.min(Number((args as any).limit) || 20, 50);
    const offset = Math.max(Number((args as any).offset) || 0, 0);

    if (!query || !String(query).trim()) {
      return this.wrapResponse('Provide query: an act title or identifier.');
    }
    const q = String(query).trim();
    const asId = normaliseLegId(q);

    const where: string[] = [];
    const values: any[] = [];
    if (asId) {
      values.push(asId);
      where.push(`l.id = $${values.length}`);
    } else {
      values.push(`%${q}%`);
      where.push(`l.title ILIKE $${values.length}`);
    }
    if (leg_type) { values.push(String(leg_type)); where.push(`l.leg_type = $${values.length}`); }
    if (year) { values.push(Number(year)); where.push(`l.year = $${values.length}`); }

    // Two correlated existence probes rather than joins: an act can have tens of
    // thousands of provision rows and the caller only needs to know whether any exist.
    const sql = `
      SELECT COUNT(*) OVER() AS _total_count,
             l.id, l.leg_type, l.year, l.number, l.title, l.document_status, l.extent,
             l.enactment_date, l.made_date, l.coming_into_force, l.source_url,
             EXISTS (SELECT 1 FROM uk_legislation_provisions p WHERE p.leg_id = l.id) AS has_text,
             COALESCE(s.versions, 0) AS versions,
             l.unapplied_effects
        FROM uk_legislation l
        LEFT JOIN uk_pit_load_state s ON s.leg_id = l.id
       WHERE ${where.join(' AND ')}
         ${with_text_only ? 'AND EXISTS (SELECT 1 FROM uk_legislation_provisions p2 WHERE p2.leg_id = l.id)' : ''}
       ORDER BY (l.id = $1) DESC, l.year DESC NULLS LAST, l.id
       LIMIT ${limit} OFFSET ${offset}`;

    try {
      const rows = (await this.db.query(sql, values)).rows;
      if (!rows.length) {
        return this.wrapResponse({
          results: [], total: 0,
          note: asId
            ? `Act ${asId} is not in the register. The register covers 238,926 acts; check the identifier on legislation.gov.uk.`
            : 'Nothing found by title. Try a shorter fragment or give leg_type and year.',
        });
      }
      return this.wrapSearchResults(
        rows.map((r: any) => ({
          ...r,
          // One archived version is still point-in-time data: it says what the
          // act looked like on that date. Only zero means none.
          point_in_time: Number(r.versions) > 0,
        })),
        limit, offset,
        'Contains public sector information licensed under the Open Government Licence v3.0.'
      );
    } catch (err) {
      logger.error('[uk_search_legislation] failed', { err });
      return this.wrapResponse({ error: 'query_failed', message: 'The UK legislation search failed.' });
    }
  }

  // ─── uk_get_act ────────────────────────────────────────────────────

  private async getAct(args: Record<string, unknown>): Promise<ToolResult> {
    const legId = normaliseLegId((args as any).leg_id);
    if (!legId) return this.wrapResponse({ error: 'bad_leg_id', message: "leg_id must look like 'ukpga/2006/46'." });

    try {
      const act = (await this.db.query(
        `SELECT id, leg_type, year, number, title, long_title, document_status, extent,
                enactment_date, made_date, coming_into_force, valid_date, source_url,
                unapplied_effects
           FROM uk_legislation WHERE id = $1`, [legId])).rows[0];
      if (!act) {
        return this.wrapResponse({ error: 'not_found', entity: 'act', leg_id: legId,
          message: `Act ${legId} is not in the register (238,926 acts).` });
      }

      const cov = (await this.db.query(
        `SELECT (SELECT count(*) FROM uk_legislation_provisions WHERE leg_id = $1) AS provisions,
                (SELECT max(valid_from) FROM uk_legislation_provisions WHERE leg_id = $1) AS text_valid_from,
                (SELECT count(*) FROM uk_provision_version WHERE leg_id = $1) AS pit_rows,
                (SELECT min(valid_from) FROM uk_provision_version WHERE leg_id = $1) AS pit_from,
                (SELECT max(valid_from) FROM uk_provision_version WHERE leg_id = $1) AS pit_to,
                (SELECT versions FROM uk_pit_load_state WHERE leg_id = $1) AS versions`,
        [legId])).rows[0];

      const eff = (await this.db.query(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE applied IS NOT TRUE) AS unapplied,
                count(*) FILTER (WHERE applied IS TRUE) AS applied
           FROM uk_legislation_effects WHERE affected_id = $1`, [legId])).rows[0];

      const provisions = Number(cov.provisions) || 0;
      return this.wrapResponse({
        act,
        coverage: {
          provisions,
          has_text: provisions > 0,
          text_valid_from: cov.text_valid_from,
          point_in_time: Number(cov.pit_rows) > 0,
          versions: Number(cov.versions) || 0,
          history_from: cov.pit_from,
          history_to: cov.pit_to,
          note: provisions === 0 ? NO_TEXT_NOTE : undefined,
          as_at_caveat: Number(cov.pit_rows) > 0 ? AS_AT_CAVEAT : undefined,
        },
        effects: {
          total: Number(eff.total) || 0,
          applied: Number(eff.applied) || 0,
          unapplied: Number(eff.unapplied) || 0,
          note: Number(eff.unapplied) > 0
            ? 'Unapplied amendments have been made but are not yet editorially reflected in the text, so the current text may lag the law.'
            : undefined,
        },
        attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
      });
    } catch (err) {
      logger.error('[uk_get_act] failed', { err, legId });
      return this.wrapResponse({ error: 'query_failed', message: 'Could not retrieve the act.' });
    }
  }

  // ─── uk_get_provision ──────────────────────────────────────────────

  private async getProvision(args: Record<string, unknown>): Promise<ToolResult> {
    const legId = normaliseLegId((args as any).leg_id);
    const provision = (args as any).provision;
    const asOf = (args as any).as_of ? String((args as any).as_of) : null;
    if (!legId) return this.wrapResponse({ error: 'bad_leg_id', message: "leg_id must look like 'ukpga/1990/8'." });
    if (!provision) return this.wrapResponse({ error: 'bad_provision', message: 'Provide provision: a provision number or key.' });
    if (asOf && !ISO_DATE.test(asOf)) return this.wrapResponse({ error: 'bad_date', message: 'as_of must be in YYYY-MM-DD format.' });

    const key = buildProvisionKey(legId, String(provision), (args as any).provision_type);
    const label = String(provision).trim().split('/').pop();

    try {
      if (asOf) {
        const candidates = (await this.db.query(
          `SELECT v.provision_key, v.provision_label, v.provision_type, v.ord, v.part, v.chapter,
                  v.schedule_no, v.title, v.valid_from, v.valid_to, t.text, t.n_chars
             FROM uk_provision_version v JOIN uk_provision_text t ON t.text_hash = v.text_hash
            WHERE v.leg_id = $1 AND (v.provision_key = $2 OR v.provision_label = $3)
              AND v.valid_from <= $4 AND (v.valid_to IS NULL OR v.valid_to > $4)
            ORDER BY (v.provision_key = $2) DESC, v.ord
            LIMIT 10`, [legId, key, label, asOf])).rows;
        const row = pickOne(candidates, key);
        if (row === AMBIGUOUS) return this.ambiguous(legId, key, candidates, asOf);
        if (row) {
          return this.wrapResponse({
            leg_id: legId, as_of: asOf, source: 'point_in_time', provision: row,
            as_at_caveat: AS_AT_CAVEAT,
            attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
          });
        }
        // Distinguish "act has no history" from "date outside the history" — the two
        // need different things from the caller and an empty result says neither.
        const span = (await this.db.query(
          `SELECT count(*) AS rows, min(valid_from) AS from_, max(COALESCE(valid_to, valid_from)) AS to_
             FROM uk_provision_version WHERE leg_id = $1`, [legId])).rows[0];
        if (!Number(span.rows)) {
          const current = await this.currentProvision(legId, key, label);
          if (current === AMBIGUOUS) return this.ambiguous(legId, key, [], asOf);
          return this.wrapResponse({
            leg_id: legId, as_of: asOf, source: 'current_text_only',
            message: 'This act has no version history (point in time covers 62,866 acts). The current text follows.',
            provision: current || null,
          });
        }
        return this.wrapResponse({
          error: 'no_version_for_date', leg_id: legId, provision_key: key, as_of: asOf,
          history_from: span.from_, history_to: span.to_,
          message: 'The provision was not in force on this date, or the date is outside the history the archive holds.',
        });
      }

      const current = await this.currentProvision(legId, key, label);
      if (current === AMBIGUOUS) {
        const all = (await this.db.query(
          `SELECT DISTINCT provision_type, schedule_no, title,
                  regexp_replace(provision_uri, '^https?://(?:www\\.)?legislation\\.gov\\.uk/', '')
                    AS provision_key
             FROM uk_legislation_provisions
            WHERE leg_id = $1 AND provision_label = $2 LIMIT 10`, [legId, label])).rows;
        return this.ambiguous(legId, key, all);
      }
      if (!current) {
        const hasAny = (await this.db.query(
          `SELECT count(*) AS n FROM uk_legislation_provisions WHERE leg_id = $1`, [legId])).rows[0];
        return this.wrapResponse({
          error: Number(hasAny.n) ? 'provision_not_found' : 'no_text',
          leg_id: legId, provision_key: key,
          message: Number(hasAny.n)
            ? 'Provision not found. Check the number or give provision_type (section / regulation / article).'
            : NO_TEXT_NOTE,
          source_url: `https://www.legislation.gov.uk/${legId}`,
        });
      }
      return this.wrapResponse({
        leg_id: legId, source: 'current_text', provision: current,
        attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
      });
    } catch (err) {
      logger.error('[uk_get_provision] failed', { err, legId, key });
      return this.wrapResponse({ error: 'query_failed', message: 'Could not retrieve the provision.' });
    }
  }

  private ambiguous(legId: string, key: string, rows: any[], asOf?: string | null): ToolResult {
    const seen = new Map<string, any>();
    for (const r of rows) if (!seen.has(r.provision_key)) seen.set(r.provision_key, r);
    return this.wrapResponse({
      error: 'ambiguous_provision',
      leg_id: legId,
      looked_for: key,
      ...(asOf ? { as_of: asOf } : {}),
      message: 'This number matches several provisions in the act; give provision as a full key.',
      matches: [...seen.values()].map((r) => ({
        provision_key: r.provision_key,
        provision_type: r.provision_type,
        schedule_no: r.schedule_no,
        title: r.title,
      })),
    });
  }

  private async currentProvision(legId: string, key: string, label?: string) {
    const suffix = key.slice(legId.length + 1);
    const rows = (await this.db.query(
      `SELECT provision_label, provision_type, ord, part, chapter, schedule_no, title,
              valid_from, text, n_chars,
              regexp_replace(provision_uri, '^https?://(?:www\\.)?legislation\\.gov\\.uk/', '')
                AS provision_key
         FROM uk_legislation_provisions
        WHERE leg_id = $1 AND (provision_uri LIKE $2 OR provision_label = $3)
        ORDER BY (provision_uri LIKE $2) DESC, ord
        LIMIT 10`, [legId, `%${suffix}%`, label])).rows;
    return pickOne(rows, key);
  }

  // ─── uk_get_provision_history ──────────────────────────────────────

  private async getProvisionHistory(args: Record<string, unknown>): Promise<ToolResult> {
    const legId = normaliseLegId((args as any).leg_id);
    const provision = (args as any).provision;
    const includeText = Boolean((args as any).include_text);
    if (!legId) return this.wrapResponse({ error: 'bad_leg_id', message: "leg_id must look like 'ukpga/1998/42'." });
    if (!provision) return this.wrapResponse({ error: 'bad_provision', message: 'Provide provision: a provision number or key.' });

    const key = buildProvisionKey(legId, String(provision), (args as any).provision_type);
    const label = String(provision).trim().split('/').pop();

    try {
      const rows = (await this.db.query(
        `SELECT v.provision_key, v.provision_label, v.valid_from, v.valid_to, t.n_chars,
                ${includeText ? 't.text' : 'NULL::text AS text'}
           FROM uk_provision_version v JOIN uk_provision_text t ON t.text_hash = v.text_hash
          WHERE v.leg_id = $1 AND (v.provision_key = $2 OR v.provision_label = $3)
          ORDER BY v.valid_from`, [legId, key, label])).rows;

      if (!rows.length) {
        const hasHistory = (await this.db.query(
          `SELECT count(*) AS n FROM uk_provision_version WHERE leg_id = $1`, [legId])).rows[0];
        return this.wrapResponse({
          error: Number(hasHistory.n) ? 'provision_not_found' : 'no_point_in_time',
          leg_id: legId, provision_key: key,
          message: Number(hasHistory.n)
            ? 'Provision not found in this act\'s history. Check the number or give provision_type.'
            : 'This act has no version history; point in time covers 62,866 of 238,926 acts.',
        });
      }

      // The key may resolve to more than one provision when the caller passed a bare
      // number that exists both as a section and inside a schedule; report each timeline
      // separately rather than interleaving them into one misleading sequence.
      const byKey: Record<string, any[]> = {};
      for (const r of rows) (byKey[r.provision_key] ||= []).push(r);

      return this.wrapResponse({
        leg_id: legId,
        provisions: Object.entries(byKey).map(([k, list]) => ({
          provision_key: k,
          provision_label: list[0].provision_label,
          intervals: list.length,
          first_version: list[0].valid_from,
          open_ended: list[list.length - 1].valid_to === null,
          history: list.map((r: any) => ({
            valid_from: r.valid_from, valid_to: r.valid_to, n_chars: r.n_chars,
            ...(includeText ? { text: r.text } : {}),
          })),
        })),
        as_at_caveat: AS_AT_CAVEAT,
        attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
      });
    } catch (err) {
      logger.error('[uk_get_provision_history] failed', { err, legId, key });
      return this.wrapResponse({ error: 'query_failed', message: 'Could not retrieve the provision history.' });
    }
  }

  // ─── uk_get_act_as_at ──────────────────────────────────────────────

  private async getActAsAt(args: Record<string, unknown>): Promise<ToolResult> {
    const legId = normaliseLegId((args as any).leg_id);
    const asOf = (args as any).as_of ? String((args as any).as_of) : null;
    const offset = Math.max(Number((args as any).offset) || 0, 0);
    const maxChars = Math.min(Number((args as any).max_chars) || 50000, 200000);
    if (!legId) return this.wrapResponse({ error: 'bad_leg_id', message: "leg_id must look like 'ukpga/2006/46'." });
    if (!asOf || !ISO_DATE.test(asOf)) return this.wrapResponse({ error: 'bad_date', message: 'as_of is required, in YYYY-MM-DD format.' });

    try {
      const rows = (await this.db.query(
        `SELECT provision_label, provision_type, ord, title, valid_from, valid_to, text
           FROM uk_act_as_at($1, $2::date)`, [legId, asOf])).rows;

      if (!rows.length) {
        const span = (await this.db.query(
          `SELECT count(*) AS rows, min(valid_from) AS from_, max(valid_from) AS to_
             FROM uk_provision_version WHERE leg_id = $1`, [legId])).rows[0];
        return this.wrapResponse({
          error: Number(span.rows) ? 'no_version_for_date' : 'no_point_in_time',
          leg_id: legId, as_of: asOf,
          history_from: span.from_, history_to: span.to_,
          message: Number(span.rows)
            ? 'No provision of the act was in force on this date; the date is outside the history the archive holds.'
            : 'This act has no version history; point in time covers 62,866 of 238,926 acts.',
        });
      }

      const body = rows
        .map((r: any) => `${r.provision_type === 'section' ? 'Section' : (r.provision_type || 'Provision')} ${r.provision_label}${r.title ? ` — ${r.title}` : ''}\n${r.text}`)
        .join('\n\n');
      const slice = body.slice(offset, offset + maxChars);

      return this.wrapResponse({
        leg_id: legId, as_of: asOf,
        provisions: rows.length,
        total_chars: body.length,
        offset, max_chars: maxChars,
        truncated: offset + slice.length < body.length,
        text: slice,
        as_at_caveat: AS_AT_CAVEAT,
        attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
      });
    } catch (err) {
      logger.error('[uk_get_act_as_at] failed', { err, legId, asOf });
      return this.wrapResponse({ error: 'query_failed', message: 'Could not assemble the text of the act as at that date.' });
    }
  }
}
