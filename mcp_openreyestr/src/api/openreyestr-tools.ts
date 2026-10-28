import { Pool } from 'pg';
import { z } from 'zod';

export interface RegistrySearchParams {
  query?: string;
  edrpou?: string;
  record?: string;
  entityType?: 'UO' | 'FOP' | 'FSU' | 'ALL';
  stan?: string;
  limit?: number;
  offset?: number;
}

export interface EntityDetails {
  entityType: 'UO' | 'FOP' | 'FSU';
  record: string;
  mainInfo: any;
  founders?: any[];
  beneficiaries?: any[];
  signers?: any[];
  members?: any[];
  branches?: any[];
  predecessors?: any[];
  assignees?: any[];
  executivePower?: any;
  terminationStarted?: any;
  bankruptcyInfo?: any;
  exchangeData?: any[];
  /** Address / КВЕД from the ДССУ financial-statement extract (not part of the ЄДР dump). */
  addressAndActivity?: {
    address: string | null;
    region: string | null;
    kved: string | null;
    kvedName: string | null;
    reportYear: number | null;
    source: 'dssu_financial_reports';
  };
  dataNotes?: string[];
}

const EXCHANGE_FIELDS = ['tax_payer_type', 'start_date', 'start_num', 'end_date', 'end_num'];

/** An exchange_data row is noise when every data field is null/blank. */
export function isMeaningfulExchangeRow(row: any): boolean {
  return EXCHANGE_FIELDS.some(f => row?.[f] != null && String(row[f]).trim() !== '');
}

/** ДССУ row → addressAndActivity, or undefined when it has neither address nor КВЕД. */
export function formatDssuActivity(row: any): EntityDetails['addressAndActivity'] | undefined {
  if (!row) return undefined;
  const t = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const address = t(row.firm_address);
  const kved = t(row.firm_kved);
  if (!address && !kved) return undefined;
  return {
    address,
    region: t(row.firm_region),
    kved,
    kvedName: t(row.firm_kved_name),
    reportYear: row.report_year ?? null,
    source: 'dssu_financial_reports',
  };
}

/** Escape LIKE/ILIKE wildcards so user input matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * SQL expression normalising an organisation name for exact comparison:
 * typographic quotes → ", whitespace runs → one space, trimmed, upper-cased.
 */
export function normNameSql(expr: string): string {
  return `upper(btrim(regexp_replace(translate(${expr}, '«»“”„‟″', '"""""""'), '[[:space:]]+', ' ', 'g')))`;
}

/**
 * Abbreviated ОПФ tokens that precede the quoted name in short names
 * (ТОВ "НОВА ПОШТА", АТ КБ "ПРИВАТБАНК", ПРАТ "КИЇВСТАР").
 */
const OPF_ABBR = [
  'ТОВ', 'ТДВ', 'ПП', 'ПАТ', 'ПРАТ', 'АТ', 'ВАТ', 'ЗАТ', 'КБ', 'АКБ', 'ДП', 'КП', 'ДАК', 'НАК',
  'СП', 'ФГ', 'ПТ', 'КТ', 'ОСББ', 'ГО', 'БО', 'МПП', 'ПФ', 'ВКФ', 'ПВКФ', 'ТЗОВ', 'LLC',
];

/** Spelled-out ОПФ phrases a user may type before or after the name (longest first). */
const OPF_PHRASES = [
  'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ',
  'ТОВАРИСТВО З ДОДАТКОВОЮ ВІДПОВІДАЛЬНІСТЮ',
  'ПРИВАТНЕ АКЦІОНЕРНЕ ТОВАРИСТВО',
  'ПУБЛІЧНЕ АКЦІОНЕРНЕ ТОВАРИСТВО',
  'ВІДКРИТЕ АКЦІОНЕРНЕ ТОВАРИСТВО',
  'ЗАКРИТЕ АКЦІОНЕРНЕ ТОВАРИСТВО',
  'АКЦІОНЕРНЕ ТОВАРИСТВО',
  'КОМЕРЦІЙНИЙ БАНК',
  'ПРИВАТНЕ ПІДПРИЄМСТВО',
  'ДЕРЖАВНЕ ПІДПРИЄМСТВО',
  'КОМУНАЛЬНЕ ПІДПРИЄМСТВО',
  'ФЕРМЕРСЬКЕ ГОСПОДАРСТВО',
];

const OPF_ABBR_RE = OPF_ABBR.join('|');

/**
 * Normalised name core of a user query: upper-cased, ОПФ phrases/abbreviations at
 * the start or end removed, quotes and apostrophes dropped, punctuation → one space.
 * «ТОВ "Нова Пошта"» → «НОВА ПОШТА»; «Розетка.уа» → «РОЗЕТКА УА».
 * Mirrors nameCoreSql so the two compare equal for the same organisation.
 */
export function normalizeNameCore(input: string): string {
  let s = (input || '').toUpperCase().replace(/[ʼ’‘`']/g, '');
  s = s.replace(/[^0-9A-ZА-ЯЁІЇЄҐ]+/g, ' ').trim();
  const abbr = new RegExp(`^(?:${OPF_ABBR_RE})(?: |$)|(?: |^)(?:${OPF_ABBR_RE})$`);
  for (let changed = true; changed && s; ) {
    changed = false;
    for (const p of OPF_PHRASES) {
      if (s === p) { s = ''; changed = true; break; }
      if (s.startsWith(p + ' ')) { s = s.slice(p.length + 1); changed = true; break; }
      if (s.endsWith(' ' + p)) { s = s.slice(0, -(p.length + 1)); changed = true; break; }
    }
    if (!changed && abbr.test(s)) { s = s.replace(abbr, '').trim(); changed = true; }
  }
  return s;
}

/**
 * SQL expression for the normalised name core of a registry name:
 *  - the full ОПФ (opfExpr) is cut off the front when the name starts with it;
 *  - leading ОПФ abbreviations are cut only when a quoted name follows
 *    (ТОВ "X" → X, but НППП ТОВ "X" — a trade union — keeps its prefix);
 *  - then quotes/apostrophes are dropped and punctuation collapsed to one space
 *    exactly as normalizeNameCore does.
 */
export function nameCoreSql(expr: string, opfExpr?: string): string {
  let s = `upper(coalesce(${expr}, ''))`;
  if (opfExpr) {
    s = `CASE WHEN coalesce(${opfExpr}, '') <> '' AND left(${s}, length(${opfExpr}) + 1) = upper(${opfExpr}) || ' '
              THEN substr(${s}, length(${opfExpr}) + 2) ELSE ${s} END`;
  }
  // unify quotes: typographic and doubled apostrophes → "
  s = `regexp_replace(translate(${s}, '«»“”„‟″', '"""""""'), '''''', '"', 'g')`;
  s = `regexp_replace(btrim(${s}), '^((${OPF_ABBR_RE})[[:space:]]+)+(?=")', '')`;
  s = `regexp_replace(${s}, '[ʼ’‘\`'']', '', 'g')`;
  return `btrim(regexp_replace(${s}, '[^0-9A-ZА-ЯЁІЇЄҐ]+', ' ', 'g'))`;
}

/** 'DD.MM.YYYY' → 'YYYY-MM-DD'; anything else is returned trimmed, empty → null. */
export function toIsoDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

/** Trim the commas/whitespace NAIS pads fields with; '', '.', '-' and «(Не визначено)» mean nothing. */
function cleanNais(v: unknown): string | null {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).replace(/^[\s,]+|[\s,]+$/g, '');
  if (!s || s === '.' || s === '-' || /^\(?не визначено\)?$/i.test(s)) return null;
  return s;
}

/**
 * Bankruptcy row → output. STAN_PROV is "<стан провадження>, <підстава закриття>"
 * (the second part is a ст. 90 КУзПБ ground: звіт ліквідатора, мирова угода …);
 * INIC_SPR is the case initiator, stored as {"CODEXARTICLE": "<name>"} or ''.
 */
export function formatBankruptcyRow(row: any): Record<string, unknown> {
  const rawStatus = row.raw_status == null || typeof row.raw_status === 'object' ? '' : String(row.raw_status);
  const comma = rawStatus.indexOf(',');
  const statusPart = comma >= 0 ? rawStatus.slice(0, comma) : rawStatus;
  const groundPart = comma >= 0 ? rawStatus.slice(comma + 1) : '';
  const ini = row.raw_initiator;
  const initiator = ini && typeof ini === 'object' ? ini.CODEXARTICLE : ini;
  const ownEdrpou = cleanNais(row.debtor_edrpou);
  const matched = cleanNais(row.matched_edrpou);
  return {
    id: row.id,
    registration_number: row.registration_number,
    registration_date: row.registration_date ?? null,
    case_number: cleanNais(row.case_number),
    court_decision_date: row.court_decision_date ?? null,
    debtor_name: cleanNais(row.debtor_name),
    debtor_edrpou: ownEdrpou ?? matched,
    debtor_edrpou_source: ownEdrpou ? 'registry' : matched ? 'edr_exact_name_match' : null,
    procedure: cleanNais(row.raw_procedure),
    case_status: cleanNais(statusPart),
    case_closure_ground: cleanNais(groundPart),
    case_initiator: cleanNais(initiator),
    proceeding_status: row.proceeding_status ?? null,
  };
}

/** Termination row → output with ISO dates. */
export function formatTerminationRow(row: any): Record<string, unknown> {
  return {
    ...row,
    op_date: toIsoDate(row.op_date),
    creditor_req_end_date: toIsoDate(row.creditor_req_end_date),
  };
}

export class OpenReyestrTools {
  private static readonly STATS_CACHE_TTL_MS = 60 * 60 * 1000;
  private statsCache: { value: any; at: number } | null = null;
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Search for entities in the registry by name, EDRPOU, or other criteria
   */
  async searchEntities(params: RegistrySearchParams): Promise<any[]> {
    const {
      query,
      edrpou,
      record,
      entityType = 'ALL',
      stan,
      limit = 50,
      offset = 0,
    } = params;

    const results: any[] = [];
    const common = { query, edrpou, record, stan, limit, offset };

    if (entityType === 'UO' || entityType === 'ALL') {
      results.push(...await this.searchEntityTable({
        table: 'legal_entities', entityType: 'UO', hasEdrpou: true, hasShortName: true, opfColumn: 'opf',
        columns: 'id, record, edrpou, name, short_name, opf, stan, registration',
      }, common));
    }

    if (entityType === 'FOP' || entityType === 'ALL') {
      results.push(...await this.searchEntityTable({
        table: 'individual_entrepreneurs', entityType: 'FOP', hasEdrpou: false, hasShortName: false,
        columns: 'id, record, name, stan, registration',
      }, common));
    }

    if (entityType === 'FSU' || entityType === 'ALL') {
      results.push(...await this.searchEntityTable({
        table: 'public_associations', entityType: 'FSU', hasEdrpou: true, hasShortName: true,
        columns: 'id, record, edrpou, name, short_name, type_subject, type_branch, stan, registration',
      }, common));
    }

    const sliced = results.slice(0, limit);

    if (sliced.length === 0) {
      const registries = await this.getRegistrySummary();
      return [{
        found: false,
        query: query || edrpou || record || '',
        message: `Не знайдено суб'єктів за вашим запитом в Єдиному державному реєстрі`,
        availableRegistries: registries,
        suggestions: [
          'Спробуйте скоротити або змінити пошуковий запит',
          'Для пошуку за кодом ЄДРПОУ використовуйте openreyestr_get_by_edrpou',
          'ФОП не мають ЄДРПОУ — шукайте за прізвищем через search_entities',
        ],
      }];
    }

    return sliced;
  }

  /**
   * One registry table of search_entities. A name query is ranked (LEXAI-2098):
   *   0 — the normalised name core (ОПФ and quotes stripped) of name or short_name
   *       equals the query core («Нова Пошта» → ТОВ "НОВА ПОШТА");
   *   1 — the core starts with the query; 2 — the core contains it; 3 — other FTS hits
   *       (trade unions «ПРОФСПІЛКА … ТОВ "НОВА ПОШТА"» land here);
   * then registered (stan = 'зареєстровано') before others, trigram similarity of the
   * core, ts_rank, shorter name. Candidates are FTS hits on name or short_name.
   */
  private async searchEntityTable(
    cfg: {
      table: string;
      entityType: 'UO' | 'FOP' | 'FSU';
      columns: string;
      hasEdrpou: boolean;
      hasShortName: boolean;
      opfColumn?: string;
    },
    p: { query?: string; edrpou?: string; record?: string; stan?: string; limit: number; offset: number }
  ): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    const q = p.query?.trim();
    let core = '';

    if (q) {
      core = normalizeNameCore(q) || q.toUpperCase().replace(/[^0-9A-ZА-ЯЁІЇЄҐ]+/g, ' ').trim();
      values.push(q, core);
      const tsq = `(plainto_tsquery('simple', $1) || plainto_tsquery('simple', $2))`;
      conditions.push(cfg.hasShortName
        ? `(to_tsvector('simple', name) @@ ${tsq} OR to_tsvector('simple', coalesce(short_name, '')) @@ ${tsq})`
        : `to_tsvector('simple', name) @@ ${tsq}`);
    }
    if (p.edrpou && cfg.hasEdrpou) {
      values.push(p.edrpou);
      conditions.push(`edrpou = $${values.length}`);
    }
    if (p.record) {
      values.push(p.record);
      conditions.push(`record = $${values.length}`);
    }
    if (p.stan) {
      values.push(p.stan);
      conditions.push(`stan = $${values.length}`);
    }
    // An EDRPOU filter cannot match a table without the column (ФОП).
    if (p.edrpou && !cfg.hasEdrpou) return [];

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(p.limit, p.offset);
    const limitSql = `LIMIT $${values.length - 1} OFFSET $${values.length}`;

    if (!q) {
      const result = await this.pool.query(
        `SELECT ${cfg.columns}, '${cfg.entityType}' as entity_type
         FROM ${cfg.table}
         ${whereClause}
         ORDER BY id DESC
         ${limitSql}`,
        values
      );
      return result.rows;
    }

    const nc = nameCoreSql('name', cfg.opfColumn);
    const sc = cfg.hasShortName ? nameCoreSql('short_name') : `NULL::text`;
    const result = await this.pool.query(
      `WITH c AS (
         SELECT ${cfg.columns}, '${cfg.entityType}' as entity_type,
                ${nc} AS _nc, ${sc} AS _sc,
                ts_rank(to_tsvector('simple', name), (plainto_tsquery('simple', $1) || plainto_tsquery('simple', $2))) AS _fts
         FROM ${cfg.table}
         ${whereClause}
       )
       SELECT ${cfg.columns.split(',').map(c => c.trim()).join(', ')}, entity_type
       FROM c
       ORDER BY CASE WHEN _nc = $2 OR _sc = $2 THEN 0
                     WHEN _nc LIKE $2 || '%' OR _sc LIKE $2 || '%' THEN 1
                     WHEN _nc LIKE '%' || $2 || '%' OR _sc LIKE '%' || $2 || '%' THEN 2
                     ELSE 3 END,
                CASE WHEN stan = 'зареєстровано' THEN 0 ELSE 1 END,
                greatest(similarity(_nc, $2), similarity(coalesce(_sc, ''), $2)) DESC,
                _fts DESC,
                length(name),
                id
       ${limitSql}`,
      values
    );
    return result.rows;
  }

  /**
   * Get full details of an entity including all related data
   */
  async getEntityDetails(record: string, entityType?: 'UO' | 'FOP' | 'FSU'): Promise<EntityDetails | null> {
    // If entity type not specified, try to find it
    if (!entityType) {
      const typeResult = await this.findEntityType(record);
      if (!typeResult) {
        return null;
      }
      entityType = typeResult;
    }

    let mainInfo: any;

    // Get main entity info
    if (entityType === 'UO') {
      const result = await this.pool.query(
        'SELECT * FROM legal_entities WHERE record = $1',
        [record]
      );
      if (result.rows.length === 0) return null;
      mainInfo = result.rows[0];
    } else if (entityType === 'FOP') {
      const result = await this.pool.query(
        'SELECT * FROM individual_entrepreneurs WHERE record = $1',
        [record]
      );
      if (result.rows.length === 0) return null;
      mainInfo = result.rows[0];
    } else if (entityType === 'FSU') {
      const result = await this.pool.query(
        'SELECT * FROM public_associations WHERE record = $1',
        [record]
      );
      if (result.rows.length === 0) return null;
      mainInfo = result.rows[0];
    } else {
      return null;
    }

    const details: EntityDetails = {
      entityType,
      record,
      mainInfo,
    };

    // Get related data
    const foundersResult = await this.pool.query(
      'SELECT * FROM founders WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (foundersResult.rows.length > 0) {
      details.founders = foundersResult.rows;
    }

    const beneficiariesResult = await this.pool.query(
      'SELECT * FROM beneficiaries WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (beneficiariesResult.rows.length > 0) {
      details.beneficiaries = beneficiariesResult.rows;
    }

    const signersResult = await this.pool.query(
      'SELECT * FROM signers WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (signersResult.rows.length > 0) {
      details.signers = signersResult.rows;
    }

    if (entityType === 'UO') {
      const membersResult = await this.pool.query(
        'SELECT * FROM members WHERE entity_record = $1',
        [record]
      );
      if (membersResult.rows.length > 0) {
        details.members = membersResult.rows;
      }

      const branchesResult = await this.pool.query(
        'SELECT * FROM branches WHERE parent_record = $1',
        [record]
      );
      if (branchesResult.rows.length > 0) {
        details.branches = branchesResult.rows;
      }

      const assigneesResult = await this.pool.query(
        'SELECT * FROM assignees WHERE entity_record = $1',
        [record]
      );
      if (assigneesResult.rows.length > 0) {
        details.assignees = assigneesResult.rows;
      }

      const executivePowerResult = await this.pool.query(
        'SELECT * FROM executive_power WHERE entity_record = $1',
        [record]
      );
      if (executivePowerResult.rows.length > 0) {
        details.executivePower = executivePowerResult.rows[0];
      }

      const bankruptcyResult = await this.pool.query(
        'SELECT * FROM bankruptcy_info WHERE entity_record = $1',
        [record]
      );
      if (bankruptcyResult.rows.length > 0) {
        details.bankruptcyInfo = bankruptcyResult.rows[0];
      }
    }

    const predecessorsResult = await this.pool.query(
      'SELECT * FROM predecessors WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (predecessorsResult.rows.length > 0) {
      details.predecessors = predecessorsResult.rows;
    }

    const terminationResult = await this.pool.query(
      'SELECT * FROM termination_started WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (terminationResult.rows.length > 0) {
      details.terminationStarted = terminationResult.rows[0];
    }

    const exchangeDataResult = await this.pool.query(
      'SELECT * FROM exchange_data WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    // LEXAI-2107: the importer leaves most EXCHANGE_ANSWER rows with every field
    // empty; they carry no information, so only rows with data are returned.
    const exchangeRows = exchangeDataResult.rows.filter(isMeaningfulExchangeRow);
    if (exchangeRows.length > 0) {
      details.exchangeData = exchangeRows;
    }

    // The ЄДР open-data dump (UO_FULL/FSU_FULL) has no address or КВЕД fields at all.
    // The only stored source is the ДССУ financial-statement extract (by ЄДРПОУ).
    const edrpou = entityType === 'FOP' ? null : cleanNais(mainInfo?.edrpou);
    let activity: EntityDetails['addressAndActivity'] | undefined;
    if (edrpou) {
      const dssu = await this.pool.query(
        `SELECT firm_address, firm_region, firm_kved, firm_kved_name, report_year
         FROM dssu_financial_reports
         WHERE firm_edrpou = $1 AND (firm_address IS NOT NULL OR firm_kved IS NOT NULL)
         ORDER BY report_year DESC NULLS LAST, id DESC
         LIMIT 1`,
        [edrpou]
      );
      activity = formatDssuActivity(dssu.rows[0]);
    }
    if (activity) {
      details.addressAndActivity = activity;
    } else {
      details.dataNotes = [
        'Адреса та КВЕД відсутні: відкритий набір ЄДР (НАІС) цих полів не містить, ' +
        'а у фінансовій звітності ДССУ записів для цього ЄДРПОУ немає.',
      ];
    }

    return details;
  }

  /**
   * Search for beneficiaries by name
   */
  async searchBeneficiaries(query: string, limit: number = 50): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT b.*,
              CASE
                WHEN le.name IS NOT NULL THEN le.name
                WHEN ie.name IS NOT NULL THEN ie.name
                WHEN pa.name IS NOT NULL THEN pa.name
              END as entity_name,
              b.entity_type
       FROM beneficiaries b
       LEFT JOIN legal_entities le ON b.entity_type = 'UO' AND b.entity_record = le.record
       LEFT JOIN individual_entrepreneurs ie ON b.entity_type = 'FOP' AND b.entity_record = ie.record
       LEFT JOIN public_associations pa ON b.entity_type = 'FSU' AND b.entity_record = pa.record
       WHERE to_tsvector('simple', b.beneficiary_info) @@ plainto_tsquery('simple', $1)
       LIMIT $2`,
      [query, limit]
    );

    return result.rows;
  }

  /**
   * Get entity by EDRPOU code
   */
  async getByEdrpou(edrpou: string): Promise<any | null> {
    // Try legal entities first
    const uoResult = await this.pool.query(
      'SELECT *, \'UO\' as entity_type FROM legal_entities WHERE edrpou = $1',
      [edrpou]
    );

    if (uoResult.rows.length > 0) {
      return uoResult.rows[0];
    }

    // Try public associations
    const fsuResult = await this.pool.query(
      'SELECT *, \'FSU\' as entity_type FROM public_associations WHERE edrpou = $1',
      [edrpou]
    );

    if (fsuResult.rows.length > 0) {
      return fsuResult.rows[0];
    }

    const registries = await this.getRegistrySummary();
    return {
      found: false,
      edrpou,
      message: `Суб'єкт з ЄДРПОУ ${edrpou} не знайдено в Єдиному державному реєстрі`,
      availableRegistries: registries,
      suggestions: [
        'Перевірте правильність коду ЄДРПОУ',
        'Спробуйте пошук за назвою через openreyestr_search_entities',
        'ФОП не мають ЄДРПОУ — використовуйте пошук за іменем',
      ],
    };
  }

  /**
   * Get registry statistics.
   *
   * Exact counts (index-only scans, ~0.3s in total on 8.8M rows), cached in memory for
   * STATS_CACHE_TTL_MS: the ЄДР tables change once a day on import, so recounting on
   * every call is wasted work. pg_stat n_live_tup is not used — it reads 0 after bulk
   * loads (LEXAI-2121).
   *
   * publicAssociations here is the ЄДР FSU table, which holds only a few hundred rows;
   * the gateway (mcp_backend) replaces it with the Minjust registry of public formations.
   */
  async getStatistics(): Promise<any> {
    if (this.statsCache && Date.now() - this.statsCache.at < OpenReyestrTools.STATS_CACHE_TTL_MS) {
      return this.statsCache.value;
    }
    const countByStatus = async (table: string) => {
      const r = await this.pool.query(
        `SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE stan = $1)::bigint AS active FROM ${table}`,
        ['зареєстровано']
      );
      return { total: parseInt(r.rows[0].total), active: parseInt(r.rows[0].active) };
    };
    const [uo, fop, fsu] = await Promise.all([
      countByStatus('legal_entities'),
      countByStatus('individual_entrepreneurs'),
      countByStatus('public_associations'),
    ]);

    const value = {
      totalEntities: {
        legalEntities: uo.total,
        individualEntrepreneurs: fop.total,
        publicAssociations: fsu.total,
        total: uo.total + fop.total + fsu.total,
      },
      activeEntities: {
        legalEntities: uo.active,
        individualEntrepreneurs: fop.active,
        publicAssociations: fsu.active,
        total: uo.active + fop.active + fsu.active,
      },
    };
    this.statsCache = { value, at: Date.now() };
    return value;
  }

  /**
   * Approximate record counts of the ЄДР tables, shown in "not found" responses.
   * pg_class.reltuples (refreshed by ANALYZE / VACUUM / CREATE INDEX), not
   * pg_stat n_live_tup, which reads 0 after bulk loads (LEXAI-2121). A table that was
   * never analyzed (reltuples = -1) falls back to an exact count.
   */
  private async getRegistrySummary(): Promise<{ registry: string; records: number }[]> {
    const tables = ['individual_entrepreneurs', 'legal_entities', 'public_associations'];
    const result = await this.pool.query(
      `SELECT t.name, c.reltuples::bigint AS count
         FROM unnest($1::text[]) AS t(name)
         JOIN pg_class c ON c.oid = to_regclass(t.name)`,
      [tables]
    );
    const estimates = new Map<string, number>(result.rows.map((r: any) => [r.name, parseInt(r.count)]));
    const out: { registry: string; records: number }[] = [];
    for (const table of tables) {
      let records = estimates.get(table) ?? -1;
      if (records < 0) {
        const exact = await this.pool.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
        records = parseInt(exact.rows[0].count);
      }
      out.push({ registry: table, records });
    }
    return out;
  }

  /**
   * Search notaries registry
   */
  async searchNotaries(params: { query?: string; region?: string; status?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, region, status, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`full_name ILIKE $${paramIndex}`);
      values.push(`%${query}%`);
      paramIndex++;
    }
    if (region) {
      conditions.push(`region ILIKE $${paramIndex}`);
      values.push(`%${region}%`);
      paramIndex++;
    }
    if (status) {
      conditions.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, certificate_number, full_name, region, district, organization, address, phone, status
       FROM notaries ${whereClause}
       ORDER BY full_name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || region || '', message: 'Нотаріусів не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search court experts registry
   */
  async searchCourtExperts(params: { query?: string; region?: string; expertise_type?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, region, expertise_type, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`full_name ILIKE $${paramIndex}`);
      values.push(`%${query}%`);
      paramIndex++;
    }
    if (region) {
      conditions.push(`region ILIKE $${paramIndex}`);
      values.push(`%${region}%`);
      paramIndex++;
    }
    if (expertise_type) {
      conditions.push(`$${paramIndex} = ANY(expertise_types)`);
      values.push(expertise_type);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, expert_id, full_name, region, organization, expertise_types, certificate_number, status
       FROM court_experts ${whereClause}
       ORDER BY full_name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || region || '', message: 'Судових експертів не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search arbitration managers registry
   */
  async searchArbitrationManagers(params: { query?: string; status?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, status, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`full_name ILIKE $${paramIndex}`);
      values.push(`%${query}%`);
      paramIndex++;
    }
    if (status) {
      conditions.push(`certificate_status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, registration_number, full_name, certificate_number, certificate_status, certificate_issue_date
       FROM arbitration_managers ${whereClause}
       ORDER BY full_name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || '', message: 'Арбітражних керуючих не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search debtors registry
   */
  async searchDebtors(params: { query?: string; edrpou?: string; collection_category?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, edrpou, collection_category, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`to_tsvector('simple', debtor_name) @@ plainto_tsquery('simple', $${paramIndex})`);
      values.push(query);
      paramIndex++;
    }
    if (edrpou) {
      conditions.push(`debtor_edrpou = $${paramIndex}`);
      values.push(edrpou);
      paramIndex++;
    }
    if (collection_category) {
      conditions.push(`collection_category ILIKE $${paramIndex}`);
      values.push(`%${collection_category}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, proceeding_number, debtor_name, debtor_type, debtor_edrpou, issuing_authority, enforcement_agency, executor_name, collection_category
       FROM debtors ${whereClause}
       ORDER BY id DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || edrpou || '', message: 'Боржників не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search enforcement proceedings
   */
  async searchEnforcementProceedings(params: { query?: string; debtor_edrpou?: string; creditor_name?: string; proceeding_status?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, debtor_edrpou, creditor_name, proceeding_status, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`to_tsvector('simple', debtor_name) @@ plainto_tsquery('simple', $${paramIndex})`);
      values.push(query);
      paramIndex++;
    }
    if (debtor_edrpou) {
      conditions.push(`debtor_edrpou = $${paramIndex}`);
      values.push(debtor_edrpou);
      paramIndex++;
    }
    if (creditor_name) {
      conditions.push(`to_tsvector('simple', creditor_name) @@ plainto_tsquery('simple', $${paramIndex})`);
      values.push(creditor_name);
      paramIndex++;
    }
    if (proceeding_status) {
      conditions.push(`proceeding_status ILIKE $${paramIndex}`);
      values.push(`%${proceeding_status}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, proceeding_number, opening_date, proceeding_status, debtor_name, debtor_edrpou, creditor_name, creditor_edrpou, enforcement_agency, executor_name
       FROM enforcement_proceedings ${whereClause}
       ORDER BY opening_date DESC NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || debtor_edrpou || '', message: 'Виконавчих проваджень не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search bankruptcy cases (НАІС, «Реєстр підприємств у справах про банкрутство»).
   *
   * The source file carries no debtor EDRPOU and no court (LEXAI-2091). debtor_edrpou
   * is derived from ЄДР only when the debtor name equals exactly one legal entity's
   * name (case, whitespace and quote style aside); otherwise it stays null. Raw tags
   * are exposed under what they are: PROC_BORG_NAME → procedure, STAN_PROV →
   * case_status + case_closure_ground, INIC_SPR → case_initiator.
   */
  async searchBankruptcyCases(params: { query?: string; debtor_edrpou?: string; case_number?: string; proceeding_status?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, debtor_edrpou, case_number, proceeding_status, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];

    if (query) {
      values.push(query);
      conditions.push(`to_tsvector('simple', debtor_name) @@ plainto_tsquery('simple', $${values.length})`);
    }
    if (debtor_edrpou) {
      values.push(debtor_edrpou.trim());
      const n = values.length;
      conditions.push(`(debtor_edrpou = $${n}
        OR ${normNameSql('debtor_name')} IN (SELECT ${normNameSql('name')} FROM legal_entities WHERE edrpou = $${n} AND name IS NOT NULL))`);
    }
    if (case_number) {
      values.push(`%${escapeLike(case_number)}%`);
      conditions.push(`case_number ILIKE $${values.length}`);
    }
    if (proceeding_status) {
      values.push(`%${escapeLike(proceeding_status)}%`);
      conditions.push(`proceeding_status ILIKE $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    // Page first, then resolve EDRPOU for the page only.
    const result = await this.pool.query(
      `SELECT b.id, b.registration_number,
              to_char(b.registration_date, 'YYYY-MM-DD') AS registration_date,
              b.case_number,
              to_char(b.court_decision_date, 'YYYY-MM-DD') AS court_decision_date,
              b.debtor_name, b.debtor_edrpou, m.edrpou AS matched_edrpou,
              b.proceeding_status,
              b.raw_data->'PROC_BORG_NAME' AS raw_procedure,
              b.raw_data->'STAN_PROV' AS raw_status,
              b.raw_data->'INIC_SPR' AS raw_initiator
       FROM (
         SELECT * FROM bankruptcy_cases ${whereClause}
         ORDER BY registration_date DESC NULLS LAST, id DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}
       ) b
       LEFT JOIN LATERAL (
         SELECT CASE WHEN count(*) = 1 THEN min(l.edrpou) END AS edrpou
         FROM legal_entities l
         WHERE b.debtor_edrpou IS NULL
           AND NULLIF(btrim(b.debtor_name), '') IS NOT NULL
           AND to_tsvector('simple', l.name) @@ plainto_tsquery('simple', b.debtor_name)
           AND ${normNameSql('l.name')} = ${normNameSql('b.debtor_name')}
       ) m ON true
       ORDER BY b.registration_date DESC NULLS LAST, b.id DESC`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || debtor_edrpou || case_number || '', message: 'Справ про банкрутство не знайдено за вашим запитом' }];
    }
    return result.rows.map(formatBankruptcyRow);
  }

  /**
   * Search special notary forms
   */
  async searchSpecialForms(params: { series?: string; form_number?: string; recipient?: string; status?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { series, form_number, recipient, status, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (series) {
      conditions.push(`series = $${paramIndex}`);
      values.push(series);
      paramIndex++;
    }
    if (form_number) {
      conditions.push(`form_number = $${paramIndex}`);
      values.push(form_number);
      paramIndex++;
    }
    if (recipient) {
      conditions.push(`recipient ILIKE $${paramIndex}`);
      values.push(`%${recipient}%`);
      paramIndex++;
    }
    if (status) {
      conditions.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, series, form_number, issue_date, recipient, document_type, status, usage_date
       FROM special_forms ${whereClause}
       ORDER BY issue_date DESC NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: series || form_number || recipient || '', message: 'Спеціальних бланків не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search forensic methods registry
   */
  async searchForensicMethods(params: { query?: string; expertise_type?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, expertise_type, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`to_tsvector('simple', method_name) @@ plainto_tsquery('simple', $${paramIndex})`);
      values.push(query);
      paramIndex++;
    }
    if (expertise_type) {
      conditions.push(`expertise_type ILIKE $${paramIndex}`);
      values.push(`%${expertise_type}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, registration_code, expertise_type, method_name, developer, year_created, registration_date, status
       FROM forensic_methods ${whereClause}
       ORDER BY registration_date DESC NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || expertise_type || '', message: 'Методик судових експертиз не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search legal acts registry
   */
  async searchLegalActs(params: { query?: string; act_type?: string; publisher?: string; status?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, act_type, publisher, status, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`to_tsvector('simple', act_title) @@ plainto_tsquery('simple', $${paramIndex})`);
      values.push(query);
      paramIndex++;
    }
    if (act_type) {
      conditions.push(`act_type ILIKE $${paramIndex}`);
      values.push(`%${act_type}%`);
      paramIndex++;
    }
    if (publisher) {
      conditions.push(`publisher ILIKE $${paramIndex}`);
      values.push(`%${publisher}%`);
      paramIndex++;
    }
    if (status) {
      conditions.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, act_id, publisher, act_type, act_number, act_date, act_title, status, effective_date
       FROM legal_acts ${whereClause}
       ORDER BY act_date DESC NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || act_type || '', message: 'Нормативно-правових актів не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search administrative units
   */
  async searchAdministrativeUnits(params: { query?: string; region?: string; unit_type?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, region, unit_type, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`to_tsvector('simple', settlement_name) @@ plainto_tsquery('simple', $${paramIndex})`);
      values.push(query);
      paramIndex++;
    }
    if (region) {
      conditions.push(`region ILIKE $${paramIndex}`);
      values.push(`%${region}%`);
      paramIndex++;
    }
    if (unit_type) {
      conditions.push(`unit_type = $${paramIndex}`);
      values.push(unit_type);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, koatuu, unit_type, region, district, settlement_name, full_name
       FROM administrative_units ${whereClause}
       ORDER BY settlement_name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || region || '', message: 'Адміністративних одиниць не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search streets registry
   */
  async searchStreets(params: { query?: string; settlement?: string; region?: string; street_type?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, settlement, region, street_type, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`to_tsvector('simple', street_name) @@ plainto_tsquery('simple', $${paramIndex})`);
      values.push(query);
      paramIndex++;
    }
    if (settlement) {
      conditions.push(`settlement ILIKE $${paramIndex}`);
      values.push(`%${settlement}%`);
      paramIndex++;
    }
    if (region) {
      conditions.push(`region ILIKE $${paramIndex}`);
      values.push(`%${region}%`);
      paramIndex++;
    }
    if (street_type) {
      conditions.push(`street_type = $${paramIndex}`);
      values.push(street_type);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, street_id, street_type, street_name, full_address, region, district, settlement
       FROM streets ${whereClause}
       ORDER BY street_name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || settlement || '', message: 'Вулиць не знайдено за вашим запитом' }];
    }
    return result.rows;
  }

  /**
   * Search VAT payers registry
   */
  async searchVatPayers(params: { query?: string; vat_code?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, vat_code, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (vat_code) {
      conditions.push(`vat_code = $${paramIndex}`);
      values.push(vat_code);
      paramIndex++;
    } else if (query) {
      conditions.push(`name ILIKE $${paramIndex}`);
      values.push(`%${query}%`);
      paramIndex++;
    }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть назву або код ПДВ для пошуку' }];
    }

    values.push(limit, offset);
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const result = await this.pool.query(
      `SELECT id, name, vat_code, registration_date, termination_date
       FROM vat_payers ${whereClause}
       ORDER BY name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || vat_code || '', message: 'Платників ПДВ не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search single tax payers registry
   */
  async searchSingleTaxPayers(params: { query?: string; tin?: string; tax_group?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, tin, tax_group, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (tin) {
      conditions.push(`tin = $${paramIndex}`);
      values.push(tin);
      paramIndex++;
    } else if (query) {
      conditions.push(`name ILIKE $${paramIndex}`);
      values.push(`%${query}%`);
      paramIndex++;
    }
    if (tax_group) {
      conditions.push(`tax_group = $${paramIndex}`);
      values.push(tax_group);
      paramIndex++;
    }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть назву або ІПН для пошуку' }];
    }

    values.push(limit, offset);
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const result = await this.pool.query(
      `SELECT id, name, tin, start_date, rate, tax_group, activity_codes, end_date
       FROM single_tax_payers ${whereClause}
       ORDER BY name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || tin || '', message: 'Платників єдиного податку не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search tax debt registry
   */
  async searchTaxDebt(params: { query?: string; tin?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, tin, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (tin) {
      conditions.push(`tin = $${paramIndex}`);
      values.push(tin);
      paramIndex++;
    } else if (query) {
      conditions.push(`name ILIKE $${paramIndex}`);
      values.push(`%${query}%`);
      paramIndex++;
    }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть назву або ІПН для пошуку податкового боргу' }];
    }

    values.push(limit, offset);
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const result = await this.pool.query(
      `SELECT id, report_date, tin, name, chief_name, tax_office_name, tax_name, debt_total, debt_tax, debt_penalty, debt_fine
       FROM tax_debt ${whereClause}
       ORDER BY debt_total DESC NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || tin || '', message: 'Податкового боргу не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search ESV (social contribution) debt registry
   */
  async searchEsvDebt(params: { query?: string; tin?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, tin, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (tin) {
      conditions.push(`tin = $${paramIndex}`);
      values.push(tin);
      paramIndex++;
    } else if (query) {
      conditions.push(`name ILIKE $${paramIndex}`);
      values.push(`%${query}%`);
      paramIndex++;
    }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть назву або ІПН для пошуку боргу ЄСВ' }];
    }

    values.push(limit, offset);
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const result = await this.pool.query(
      `SELECT id, name, tin, tax_office, tax_office_chief, debt_amount
       FROM esv_debt ${whereClause}
       ORDER BY debt_amount DESC NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || tin || '', message: 'Боргу зі сплати ЄСВ не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search Prozorro public procurement tenders
   */
  async searchProzorro(params: { query?: string; buyer_edrpou?: string; buyer_name?: string; status?: string; cpv_code?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, buyer_edrpou, buyer_name, status, cpv_code, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (buyer_edrpou) {
      conditions.push(`buyer_edrpou = $${paramIndex}`);
      values.push(buyer_edrpou);
      paramIndex++;
    }
    if (query) {
      conditions.push(`title ILIKE $${paramIndex}`);
      values.push(`%${query}%`);
      paramIndex++;
    }
    if (buyer_name) {
      conditions.push(`buyer_name ILIKE $${paramIndex}`);
      values.push(`%${buyer_name}%`);
      paramIndex++;
    }
    if (status) {
      conditions.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }
    if (cpv_code) {
      conditions.push(`cpv_code LIKE $${paramIndex}`);
      values.push(`${cpv_code}%`);
      paramIndex++;
    }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть параметри пошуку тендерів' }];
    }

    values.push(limit, offset);
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const result = await this.pool.query(
      `SELECT id, tender_id, tender_number, title, status, procurement_method_type, buyer_name, buyer_edrpou, buyer_region, amount, currency, cpv_code, cpv_description, date_created, tender_start, tender_end
       FROM prozorro_tenders ${whereClause}
       ORDER BY date_created DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || buyer_edrpou || buyer_name || '', message: 'Тендерів не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search street renamings (OpenStreetMap data)
   */
  async searchStreetRenamings(params: { query?: string; min_renames?: number; limit?: number; offset?: number }): Promise<any[]> {
    const { query, min_renames = 1, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`(
        to_tsvector('simple', current_name) @@ plainto_tsquery('simple', $${paramIndex})
        OR current_name ILIKE $${paramIndex + 1}
        OR EXISTS (SELECT 1 FROM unnest(old_names) AS old WHERE old ILIKE $${paramIndex + 1})
      )`);
      values.push(query, `%${query}%`);
      paramIndex += 2;
    }

    if (min_renames > 1) {
      conditions.push(`rename_count >= $${paramIndex}`);
      values.push(min_renames);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT osm_id, current_name, current_name_uk, old_names, rename_count
       FROM street_renamings ${whereClause}
       ORDER BY rename_count DESC, current_name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: query || '', message: 'Перейменованих вулиць не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search NAZK declarations (anti-corruption declarations)
   */
  async searchNazkDeclarations(params: { declarant_name?: string; declarant_workplace?: string; declaration_year?: number; declaration_type?: number; declarant_region?: string; min_income?: number; limit?: number; offset?: number }): Promise<any[]> {
    const { declarant_name, declarant_workplace, declaration_year, declaration_type, declarant_region, min_income, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (declarant_name) { conditions.push(`declarant_name ILIKE $${paramIndex}`); values.push(`%${declarant_name}%`); paramIndex++; }
    if (declarant_workplace) { conditions.push(`declarant_workplace ILIKE $${paramIndex}`); values.push(`%${declarant_workplace}%`); paramIndex++; }
    if (declaration_year) { conditions.push(`declaration_year = $${paramIndex}`); values.push(declaration_year); paramIndex++; }
    if (declaration_type) { conditions.push(`declaration_type = $${paramIndex}`); values.push(declaration_type); paramIndex++; }
    if (declarant_region) { conditions.push(`declarant_region ILIKE $${paramIndex}`); values.push(`%${declarant_region}%`); paramIndex++; }
    if (min_income) { conditions.push(`total_income_declared >= $${paramIndex}`); values.push(min_income); paramIndex++; }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть ім\'я декларанта, місце роботи або рік для пошуку' }];
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT declaration_id, declarant_name, declarant_position, declarant_workplace,
        declarant_region, declaration_year, declaration_type, post_type, post_category,
        corruption_affected, submission_date, has_real_estate, has_vehicles,
        has_securities, has_corporate_rights, has_income, total_income_declared
      FROM nazk_declarations ${whereClause}
      ORDER BY declaration_year DESC, submission_date DESC NULLS LAST
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: declarant_name || declarant_workplace || '', message: 'Декларацій не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search exchange data (government agency data exchanges)
   */
  async searchExchangeData(params: { entity_record?: string; entity_type?: string; tax_payer_type?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { entity_record, entity_type, tax_payer_type, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (entity_record) { conditions.push(`entity_record = $${paramIndex}`); values.push(entity_record); paramIndex++; }
    if (entity_type) { conditions.push(`entity_type = $${paramIndex}`); values.push(entity_type); paramIndex++; }
    if (tax_payer_type) { conditions.push(`tax_payer_type ILIKE $${paramIndex}`); values.push(`%${tax_payer_type}%`); paramIndex++; }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть номер запису або тип суб\'єкта для пошуку' }];
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT entity_type, entity_record, tax_payer_type, start_date, start_num, end_date, end_num
      FROM exchange_data ${whereClause}
      ORDER BY start_date DESC NULLS LAST
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: entity_record || '', message: 'Записів обміну даними не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search ARMA seized assets registry
   */
  async searchArmaSeizedAssets(params: { owner_name?: string; owner_edrpou?: string; case_number?: string; asset_type?: string; status?: string; court_name?: string; region?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { owner_name, owner_edrpou, case_number, asset_type, status, court_name, region, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (owner_name) { conditions.push(`owner_name ILIKE $${paramIndex}`); values.push(`%${owner_name}%`); paramIndex++; }
    if (owner_edrpou) { conditions.push(`owner_edrpou = $${paramIndex}`); values.push(owner_edrpou); paramIndex++; }
    if (case_number) { conditions.push(`case_number = $${paramIndex}`); values.push(case_number); paramIndex++; }
    if (asset_type) { conditions.push(`asset_type ILIKE $${paramIndex}`); values.push(`%${asset_type}%`); paramIndex++; }
    if (status) { conditions.push(`status ILIKE $${paramIndex}`); values.push(`%${status}%`); paramIndex++; }
    if (court_name) { conditions.push(`court_name ILIKE $${paramIndex}`); values.push(`%${court_name}%`); paramIndex++; }
    if (region) { conditions.push(`region ILIKE $${paramIndex}`); values.push(`%${region}%`); paramIndex++; }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть власника, ЄДРПОУ або номер справи для пошуку' }];
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT case_number, case_date, court_name, asset_type, asset_description,
        owner_name, owner_type, owner_edrpou, region, status,
        arrest_date, transfer_date, manager
      FROM arma_assets ${whereClause}
      ORDER BY arrest_date DESC NULLS LAST
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query: owner_name || owner_edrpou || '', message: 'Арештованих активів не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search for entities with termination started.
   *
   * termination_started holds only (entity_type, entity_record) — no name and no
   * EDRPOU — so the query is resolved through the registry the same way
   * getEntityDetails does: UO → legal_entities.record, FSU → public_associations.record
   * (LEXAI-2090). A digit-only query is an EDRPOU (or the registry record number);
   * anything else is a substring of the full or short name.
   */
  async searchTerminationStarted(params: { query: string; entity_type?: string; signer_name?: string; reason?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { entity_type, signer_name, reason, limit = 50, offset = 0 } = params;
    const query = (params.query || '').trim();
    const conditions: string[] = [];
    const values: any[] = [];

    if (query) {
      if (/^\d+$/.test(query)) {
        values.push(query);
        const n = values.length;
        conditions.push(`(t.entity_record = $${n}
          OR (t.entity_type = 'UO' AND t.entity_record IN (SELECT record FROM legal_entities WHERE edrpou = $${n}))
          OR (t.entity_type = 'FSU' AND t.entity_record IN (SELECT record FROM public_associations WHERE edrpou = $${n})))`);
      } else {
        values.push(`%${escapeLike(query)}%`);
        const n = values.length;
        conditions.push(`(COALESCE(l.name, p.name) ILIKE $${n} OR COALESCE(l.short_name, p.short_name) ILIKE $${n})`);
      }
    }
    if (entity_type) {
      values.push(entity_type);
      conditions.push(`t.entity_type = $${values.length}`);
    }
    if (signer_name) {
      values.push(`%${escapeLike(signer_name)}%`);
      conditions.push(`t.signer_name ILIKE $${values.length}`);
    }
    if (reason) {
      values.push(`%${escapeLike(reason)}%`);
      conditions.push(`t.reason ILIKE $${values.length}`);
    }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть параметри пошуку' }];
    }

    values.push(limit, offset);
    const result = await this.pool.query(
      `SELECT t.id, t.entity_type, t.entity_record,
              COALESCE(l.edrpou, p.edrpou) AS edrpou,
              COALESCE(l.name, p.name) AS entity_name,
              COALESCE(l.short_name, p.short_name) AS entity_short_name,
              COALESCE(l.stan, p.stan) AS entity_state,
              t.op_date, t.reason, t.sbj_state, t.signer_name, t.creditor_req_end_date
       FROM termination_started t
       LEFT JOIN legal_entities l ON t.entity_type = 'UO' AND l.record = t.entity_record
       LEFT JOIN public_associations p ON t.entity_type = 'FSU' AND p.record = t.entity_record
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query, message: 'Записів про припинення не знайдено' }];
    }
    return result.rows.map(formatTerminationRow);
  }

  /**
   * Search RNBO sanctions lists
   */
  /**
   * Search datasets of the Ministry of Economy (Мінекономіки) open-data mirror.
   * Returns dataset slugs so the model can then search rows via searchMeRecords.
   */
  async searchMeDatasets(params: { query?: string; limit?: number }): Promise<any[]> {
    const { query, limit = 30 } = params;
    const values: any[] = [];
    let where = '';
    let orderBy = 'total_rows DESC';
    const q = (query || '').trim();
    if (q) {
      // 'simple' FTS has no Ukrainian stemming, so a phrase/lexeme match misses
      // morphological variants. Combine three forgiving signals:
      //  1. per-word substring ILIKE  ("авто" ⊂ "автомобілів")
      //  2. full FTS lexeme match
      //  3. pg_trgm word_similarity   ("квоти" ~ "квот", "ліцензія" ~ "ліцензії")
      // and rank by trigram similarity. Only 69 datasets → cheap.
      const words = q.split(/\s+/).filter(Boolean);
      const wordConds = words.map((w) => {
        values.push(`%${w}%`);
        return `(d.title ILIKE $${values.length} OR d.notes ILIKE $${values.length})`;
      });
      values.push(q);
      const qi = values.length;
      const sim = `word_similarity($${qi}, coalesce(d.title, '') || ' ' || coalesce(d.notes, ''))`;
      const parts: string[] = [];
      if (wordConds.length) parts.push(`(${wordConds.join(' AND ')})`);
      parts.push(
        `to_tsvector('simple', coalesce(d.title, '') || ' ' || coalesce(d.notes, '')) @@ plainto_tsquery('simple', $${qi})`
      );
      parts.push(`${sim} >= 0.3`);
      where = `WHERE ${parts.join(' OR ')}`;
      orderBy = `${sim} DESC, total_rows DESC`;
    }
    values.push(limit);

    const result = await this.pool.query(
      `SELECT d.slug, d.title, left(d.notes, 300) AS notes, d.num_resources,
              count(r.*) FILTER (WHERE r.import_status = 'imported') AS imported_resources,
              coalesce(sum(r.row_count), 0) AS total_rows
       FROM me_datasets d
       LEFT JOIN me_resources r ON r.dataset_id = d.id
       ${where}
       GROUP BY d.id, d.slug, d.title, d.notes, d.num_resources
       ORDER BY ${orderBy}
       LIMIT $${values.length}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query, message: 'Датасети Мінекономіки не знайдено' }];
    }
    return result.rows;
  }

  /**
   * Search rows inside a single Ministry of Economy dataset. The mirrored data
   * is heterogeneous JSONB, so a dataset scope (slug or resource_id) is required;
   * the query matches across all fields of a row via data::text ILIKE.
   */
  async searchMeRecords(params: { dataset?: string; resource_id?: number; query?: string; limit?: number; offset?: number }): Promise<any> {
    const { dataset, resource_id, query, limit = 50, offset = 0 } = params;
    if (!dataset && !resource_id) {
      return {
        found: false,
        message: 'Вкажіть dataset (slug) або resource_id. Спершу знайдіть датасет через search_me_datasets.',
      };
    }

    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;
    if (resource_id) {
      conditions.push(`r.resource_id = $${pi++}`);
      values.push(resource_id);
    } else {
      conditions.push(`d.slug = $${pi++}`);
      values.push(dataset);
    }
    if (query && query.trim()) {
      conditions.push(`rec.data::text ILIKE $${pi++}`);
      values.push(`%${query.trim()}%`);
    }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await this.pool.query(
      `SELECT count(*) FROM me_records rec
       JOIN me_resources r ON r.id = rec.resource_id
       JOIN me_datasets d ON d.id = r.dataset_id
       ${whereClause}`,
      values
    );
    const total = parseInt(countRes.rows[0].count, 10);

    values.push(limit, offset);
    const result = await this.pool.query(
      `SELECT d.title AS dataset_title, r.name AS resource_name, r.format,
              rec.row_index, rec.data
       FROM me_records rec
       JOIN me_resources r ON r.id = rec.resource_id
       JOIN me_datasets d ON d.id = r.dataset_id
       ${whereClause}
       ORDER BY rec.resource_id, rec.row_index
       LIMIT $${pi++} OFFSET $${pi++}`,
      values
    );

    if (total === 0) {
      return { found: false, dataset, resource_id, query, message: 'Рядків не знайдено' };
    }
    return { total, count: result.rows.length, rows: result.rows };
  }

  async searchRnboSanctions(params: { query: string; schema_type?: string; country?: string; identifier?: string; limit?: number; offset?: number }): Promise<any[]> {
    const { query, schema_type, country, identifier, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (query) {
      conditions.push(`(name ILIKE $${paramIndex} OR aliases ILIKE $${paramIndex})`);
      values.push(`%${query}%`);
      paramIndex++;
    }
    if (schema_type) {
      conditions.push(`schema_type = $${paramIndex}`);
      values.push(schema_type);
      paramIndex++;
    }
    if (country) {
      conditions.push(`countries ILIKE $${paramIndex}`);
      values.push(`%${country}%`);
      paramIndex++;
    }
    if (identifier) {
      conditions.push(`identifiers ILIKE $${paramIndex}`);
      values.push(`%${identifier}%`);
      paramIndex++;
    }

    if (conditions.length === 0) {
      return [{ found: false, message: 'Вкажіть параметри пошуку' }];
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    values.push(limit, offset);

    const result = await this.pool.query(
      `SELECT id, entity_id, schema_type, name, aliases, birth_date, countries, addresses, identifiers, sanctions, phones, emails, program_ids, dataset, first_seen, last_seen, last_change
       FROM rnbo_sanctions ${whereClause}
       ORDER BY last_change DESC NULLS LAST, id DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values
    );

    if (result.rows.length === 0) {
      return [{ found: false, query, message: 'Санкціонованих осіб не знайдено' }];
    }
    return result.rows;
  }

  private async findEntityType(record: string): Promise<'UO' | 'FOP' | 'FSU' | null> {
    const uoResult = await this.pool.query(
      'SELECT 1 FROM legal_entities WHERE record = $1',
      [record]
    );
    if (uoResult.rows.length > 0) return 'UO';

    const fopResult = await this.pool.query(
      'SELECT 1 FROM individual_entrepreneurs WHERE record = $1',
      [record]
    );
    if (fopResult.rows.length > 0) return 'FOP';

    const fsuResult = await this.pool.query(
      'SELECT 1 FROM public_associations WHERE record = $1',
      [record]
    );
    if (fsuResult.rows.length > 0) return 'FSU';

    return null;
  }
}

// Zod schemas for validation
export const SearchEntitiesSchema = z.object({
  query: z.string().optional(),
  edrpou: z.string().optional(),
  record: z.string().optional(),
  entityType: z.enum(['UO', 'FOP', 'FSU', 'ALL']).optional(),
  stan: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
});

export const GetEntityDetailsSchema = z.object({
  record: z.string(),
  entityType: z.enum(['UO', 'FOP', 'FSU']).optional(),
});

export const SearchBeneficiariesSchema = z.object({
  query: z.string(),
  limit: z.number().min(1).max(100).optional(),
});

export const GetByEdrpouSchema = z.object({
  edrpou: z.string(),
});

export const SearchVatPayersSchema = z.object({
  query: z.string().optional(),
  vat_code: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
});

export const SearchSingleTaxPayersSchema = z.object({
  query: z.string().optional(),
  tin: z.string().optional(),
  tax_group: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
});

export const SearchTaxDebtSchema = z.object({
  query: z.string().optional(),
  tin: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
});

export const SearchEsvDebtSchema = z.object({
  query: z.string().optional(),
  tin: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
});

export const SearchTerminationStartedSchema = z.object({
  query: z.string(),
  entity_type: z.string().optional(),
  signer_name: z.string().optional(),
  reason: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
});

export const SearchRnboSanctionsSchema = z.object({
  query: z.string(),
  schema_type: z.string().optional(),
  country: z.string().optional(),
  identifier: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
});
