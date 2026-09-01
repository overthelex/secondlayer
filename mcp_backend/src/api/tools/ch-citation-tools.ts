/**
 * ChCitationTools — the case-citation graph over the Swiss decisions corpus:
 * `ch_case_citations` (edges, migration 199) + `ch_decision_index` (inbound
 * aggregates per cited decision, migration 207, maintained nightly by the
 * ch-pipeline's decision-index stage).
 *
 * The graph is served straight from Postgres: every read here is a primary-key
 * or single-index lookup, and the legislation direction already has its own
 * richer tool (ch_get_decision_legislation) — this file only summarises it and
 * points there.
 *
 * Known source quirk this file must not hide: the same BGE can be published
 * under SEVERAL ECLIs (e.g. BGE 123 III 391 under three). A reference lookup
 * therefore picks its primary deterministically (preferred spider, then ecli —
 * the same disambiguation order citations_resolve_stage uses) and reports every
 * match in `variants` rather than pretending the docket is unique.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const MAX_LIMIT = 50;
const RECENT_CITINGS = 5;
const TOP_ACTS = 5;
const UNRESOLVED_REFS = 5;
const MAX_VARIANTS = 5;

// Inbound-citation recency thresholds behind `status` (documented in the tool
// description): cited within the last 3 years = actively cited; cited, but not
// within 3 years (or only on undated edges) = previously cited.
const ACTIVE_YEARS = 3;

export class ChCitationTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'ch_get_citation_graph',
        annotations: { title: 'Граф цитувань судового рішення Швейцарії', readOnlyHint: true },
        description: `Его-граф цитувань швейцарського судового рішення (ECLI): кого воно цитує і хто цитує його.

outbound.cases — посилання цього рішення на інші рішення (BGE/ATF/DTF, номери справ, ECLI) з метаданими знайденої цілі; unresolved_refs — посилання, які не вдалося знайти в корпусі (переважно рішення поза ним).
legislation — стислий підсумок цитованого законодавства (top_acts за кількістю цитувань, unresolved_count); повна розгортка з редакціями на дату рішення — ch_get_decision_legislation.
inbound — хто цитує це рішення: cited_by_count / citing_courts / first- та last_citing_date з підтримуваного індексу, recent — останні цитування (нові першими).
limit (типово 20, максимум 50) обмежує outbound.cases та inbound.recent.
Рішення, що ще не опрацьоване, повертає { error: 'not_loaded', stage }; невідомий ECLI — { error: 'not_found' }.`,
        inputSchema: {
          type: 'object',
          properties: {
            ecli: { type: 'string', description: 'ECLI судового рішення' },
            limit: { type: 'number', default: 20, maximum: MAX_LIMIT, description: 'Макс. елементів у outbound.cases та inbound.recent' },
          },
          required: ['ecli'],
        },
      },
      {
        name: 'ch_check_precedent_status',
        annotations: { title: 'Статус прецеденту (Швейцарія)', readOnlyHint: true },
        description: `Чи існує процитоване швейцарське рішення і як активно його цитують.

Вхід: ecli АБО reference — посилання так, як його пишуть у рішеннях: 'BGE 142 III 102' (також ATF/DTF), номер справи '4A_22/2017' або ECLI.
status: 'not_in_corpus' (рішення не знайдено), 'uncited' (знайдено, але ніхто не цитує), 'actively_cited' (останнє цитування за останні ${ACTIVE_YEARS} роки), 'previously_cited' (цитувалося, але давніше).
Числа з підтримуваного індексу цитувань: cited_by_count, citing_courts, first/last_citing_date, citations_last_5_years; recent_citings — останні ${RECENT_CITINGS} цитувань.
Один BGE може бути опублікований під кількома ECLI — тоді variants перелічує всі збіги, а основним детерміновано обирається перший за (пріоритет CH_BGE для BGE-посилань, потім ecli).`,
        inputSchema: {
          type: 'object',
          properties: {
            ecli: { type: 'string', description: 'ECLI рішення (альтернатива reference)' },
            reference: { type: 'string', description: "Посилання як у тексті рішення: 'BGE 142 III 102', 'ATF 142 III 102', '4A_22/2017' або ECLI" },
          },
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'ch_get_citation_graph': return this.getCitationGraph(args);
      case 'ch_check_precedent_status': return this.checkPrecedentStatus(args);
      default: return null;
    }
  }

  /** Loaded-decision header row, with the not_loaded/not_found distinction the
   *  other CH tools already make (ch_get_court_decision). Returns either
   *  { row } or { errorResult } — never both. */
  private async loadDecision(ecli: string): Promise<{ row?: any; errorResult?: ToolResult }> {
    const row = (await this.db.query(
      `SELECT ecli, doc_id, spider, court_code, docket_number,
              to_char(decision_date, 'YYYY-MM-DD') AS decision_date
         FROM ch_court_decisions WHERE ecli = $1 AND stage = 'loaded'`,
      [ecli]
    )).rows[0];
    if (row) return { row };

    const stageRow = (await this.db.query(
      `SELECT ecli, stage FROM ch_court_decisions WHERE ecli = $1`, [ecli]
    )).rows[0];
    if (stageRow) {
      return {
        errorResult: this.wrapResponse({
          error: 'not_loaded',
          ecli: stageRow.ecli,
          stage: stageRow.stage,
          message: `Це рішення ще не опрацьоване (стадія: ${stageRow.stage}).`,
        }),
      };
    }
    return { errorResult: this.wrapResponse({ error: 'not_found', ecli }) };
  }

  /** Inbound block shared by both tools: the ch_decision_index aggregate (absent
   *  row = never cited) plus the most recent citing edges. */
  private async inboundFor(ecli: string, limit: number): Promise<any> {
    const agg = (await this.db.query(
      `SELECT cited_by_count, citing_courts,
              to_char(first_citing_date, 'YYYY-MM-DD') AS first_citing_date,
              to_char(last_citing_date, 'YYYY-MM-DD') AS last_citing_date
         FROM ch_decision_index WHERE ecli = $1`,
      [ecli]
    )).rows[0];

    const recent = (await this.db.query(
      `SELECT from_ecli, to_char(from_date, 'YYYY-MM-DD') AS from_date, from_court
         FROM ch_case_citations
        WHERE to_ecli = $1 AND resolved AND from_ecli <> $1
        ORDER BY from_date DESC NULLS LAST, from_ecli
        LIMIT $2`,
      [ecli, limit]
    )).rows;

    return {
      cited_by_count: agg ? Number(agg.cited_by_count) : 0,
      citing_courts: agg ? Number(agg.citing_courts) : 0,
      first_citing_date: agg?.first_citing_date ?? null,
      last_citing_date: agg?.last_citing_date ?? null,
      recent: recent.map((r: any) => ({
        from_ecli: r.from_ecli,
        from_date: r.from_date,
        from_court: r.from_court,
      })),
    };
  }

  // ─── ch_get_citation_graph ─────────────────────────────────────────

  private async getCitationGraph(args: Record<string, unknown>): Promise<ToolResult> {
    const { ecli, limit = 20 } = args as any;

    if (!ecli || !String(ecli).trim()) {
      return this.wrapResponse('Вкажіть ecli — ідентифікатор судового рішення.');
    }
    const lim = Math.min(Math.max(Number(limit) || 20, 1), MAX_LIMIT);

    try {
      const { row: decision, errorResult } = await this.loadDecision(String(ecli));
      if (!decision) return errorResult!;

      // Outbound case edges, resolved first (they carry a found target), each
      // resolved target joined to its decision metadata. count(*) OVER() is the
      // untruncated total, same pattern as the other CH tools.
      const outRows = (await this.db.query(
        `SELECT c.to_raw, c.cite_kind, c.to_ecli, c.resolved,
                d.court_code, d.docket_number,
                to_char(d.decision_date, 'YYYY-MM-DD') AS decision_date,
                count(*) OVER()::int AS _total,
                count(*) FILTER (WHERE c.resolved) OVER()::int AS _resolved
           FROM ch_case_citations c
           LEFT JOIN ch_court_decisions d ON d.ecli = c.to_ecli
          WHERE c.from_ecli = $1
          ORDER BY c.resolved DESC, c.to_raw
          LIMIT $2`,
        [String(ecli), lim]
      )).rows;

      const total = outRows.length > 0 ? Number(outRows[0]._total) : 0;
      const resolvedCount = outRows.length > 0 ? Number(outRows[0]._resolved) : 0;

      const unresolvedRefs = (await this.db.query(
        `SELECT to_raw FROM ch_case_citations
          WHERE from_ecli = $1 AND NOT resolved
          ORDER BY to_raw LIMIT ${UNRESOLVED_REFS}`,
        [String(ecli)]
      )).rows.map((r: any) => r.to_raw);

      // Legislation summary only — the full per-edition expansion belongs to
      // ch_get_decision_legislation and is not duplicated here.
      const legAgg = (await this.db.query(
        `SELECT count(*)::int AS total_citations,
                count(DISTINCT act_id) FILTER (WHERE act_id IS NOT NULL)::int AS total_acts,
                count(*) FILTER (WHERE act_id IS NULL)::int AS unresolved_count
           FROM ch_legislation_citations WHERE from_ecli = $1`,
        [String(ecli)]
      )).rows[0];
      const topActs = (await this.db.query(
        `SELECT c.act_id, count(*)::int AS citations_count,
                a.sr_number, a.abbreviation,
                COALESCE(a.title_de, a.title_fr, a.title_it) AS title
           FROM ch_legislation_citations c
           JOIN ch_act a ON a.act_id = c.act_id
          WHERE c.from_ecli = $1 AND c.act_id IS NOT NULL
          GROUP BY c.act_id, a.sr_number, a.abbreviation, a.title_de, a.title_fr, a.title_it
          ORDER BY citations_count DESC, c.act_id
          LIMIT ${TOP_ACTS}`,
        [String(ecli)]
      )).rows;

      const inbound = await this.inboundFor(String(ecli), lim);

      return this.wrapResponse({
        ecli: decision.ecli,
        doc_id: decision.doc_id,
        court_code: decision.court_code,
        docket_number: decision.docket_number,
        decision_date: decision.decision_date,
        outbound: {
          cases: outRows.map((r: any) => ({
            to_raw: r.to_raw,
            cite_kind: r.cite_kind,
            to_ecli: r.to_ecli,
            resolved: r.resolved,
            court_code: r.court_code,
            docket_number: r.docket_number,
            decision_date: r.decision_date,
          })),
          total,
          resolved_count: resolvedCount,
          unresolved_count: total - resolvedCount,
          unresolved_refs: unresolvedRefs,
        },
        legislation: {
          total_citations: Number(legAgg?.total_citations ?? 0),
          total_acts: Number(legAgg?.total_acts ?? 0),
          unresolved_count: Number(legAgg?.unresolved_count ?? 0),
          top_acts: topActs.map((r: any) => ({
            act_id: Number(r.act_id),
            sr_number: r.sr_number,
            abbreviation: r.abbreviation,
            title: r.title,
            citations_count: Number(r.citations_count),
          })),
          next: { tool: 'ch_get_decision_legislation', ecli: decision.ecli },
        },
        inbound,
      });
    } catch (error: any) {
      logger.error('ch_get_citation_graph error', { error: error.message });
      return this.wrapError(`Помилка побудови графа цитувань: ${error.message}`);
    }
  }

  // ─── ch_check_precedent_status ─────────────────────────────────────

  private async checkPrecedentStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const { ecli, reference } = args as any;

    if ((!ecli || !String(ecli).trim()) && (!reference || !String(reference).trim())) {
      return this.wrapResponse('Вкажіть ecli або reference — один із параметрів обов’язковий.');
    }

    try {
      let decision: any = null;
      let variants: string[] = [];

      if (ecli) {
        const { row, errorResult } = await this.loadDecision(String(ecli));
        if (!row) return errorResult!;
        decision = row;
      } else {
        const raw = String(reference).trim();
        // ATF (fr) / DTF (it) are the same reporter as BGE (de); the corpus
        // stores the docket in the German form.
        const normalized = raw.replace(/^(ATF|DTF)\b/i, 'BGE');
        const isEcli = /^ECLI:/i.test(normalized);
        const preferBge = /^BGE\b/i.test(normalized);

        // Deterministic disambiguation, same order citations_resolve_stage
        // uses: preferred spider first (CH_BGE for the reporter form, CH_BGer
        // for plain dockets), then ecli. Every match is reported in variants.
        const matches = (await this.db.query(
          isEcli
            ? `SELECT ecli FROM ch_court_decisions
                WHERE ecli = $1 AND stage = 'loaded' ORDER BY ecli LIMIT ${MAX_VARIANTS}`
            : `SELECT ecli FROM ch_court_decisions
                WHERE docket_number = $1 AND stage = 'loaded'
                ORDER BY (spider = $2) DESC, ecli LIMIT ${MAX_VARIANTS}`,
          isEcli ? [normalized] : [normalized, preferBge ? 'CH_BGE' : 'CH_BGer']
        )).rows.map((r: any) => r.ecli);

        if (matches.length === 0) {
          return this.wrapResponse({
            status: 'not_in_corpus',
            reference: raw,
            message: 'Процитоване рішення не знайдено в корпусі (поза корпусом або неточне посилання).',
          });
        }
        variants = matches;
        const { row, errorResult } = await this.loadDecision(matches[0]);
        if (!row) return errorResult!;
        decision = row;
      }

      const inbound = await this.inboundFor(decision.ecli, RECENT_CITINGS);

      const last5y = (await this.db.query(
        `SELECT count(*)::int AS n FROM ch_case_citations
          WHERE to_ecli = $1 AND resolved AND from_ecli <> $1
            AND from_date >= CURRENT_DATE - INTERVAL '5 years'`,
        [decision.ecli]
      )).rows[0];

      let status: 'uncited' | 'actively_cited' | 'previously_cited';
      if (inbound.cited_by_count === 0) {
        status = 'uncited';
      } else if (inbound.last_citing_date != null) {
        const cutoff = new Date();
        cutoff.setFullYear(cutoff.getFullYear() - ACTIVE_YEARS);
        status = new Date(inbound.last_citing_date) >= cutoff
          ? 'actively_cited' : 'previously_cited';
      } else {
        status = 'previously_cited';
      }

      return this.wrapResponse({
        ...(reference ? { reference: String(reference).trim() } : {}),
        ecli: decision.ecli,
        docket_number: decision.docket_number,
        court_code: decision.court_code,
        spider: decision.spider,
        decision_date: decision.decision_date,
        ...(variants.length > 1 ? { variants } : { variants: variants.length ? variants : [decision.ecli] }),
        status,
        cited_by_count: inbound.cited_by_count,
        citing_courts: inbound.citing_courts,
        first_citing_date: inbound.first_citing_date,
        last_citing_date: inbound.last_citing_date,
        citations_last_5_years: Number(last5y?.n ?? 0),
        recent_citings: inbound.recent,
        next: { tool: 'ch_get_citation_graph', ecli: decision.ecli },
      });
    } catch (error: any) {
      logger.error('ch_check_precedent_status error', { error: error.message });
      return this.wrapError(`Помилка перевірки статусу прецеденту: ${error.message}`);
    }
  }
}
