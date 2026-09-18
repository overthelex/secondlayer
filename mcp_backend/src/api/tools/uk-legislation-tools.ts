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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const AS_AT_CAVEAT =
  'Відкритий інтервал (valid_to = null) означає «діяло станом на останню редакцію, ' +
  'яку містить архів», а не «чинне сьогодні»: архів відстає від сайту, і акт може бути ' +
  'скасований цілком без публікації нової редакції.';

const NO_TEXT_NOTE =
  'Джерело публікує цей акт лише у вигляді сканів — тексту немає в жодній з bulk-колекцій ' +
  'legislation.gov.uk. Це властивість джерела, а не прогалина харвесту.';

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
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'uk_search_legislation',
        annotations: { title: 'Пошук законодавства Великої Британії', readOnlyHint: true },
        description: `Пошук актів статутного права Великої Британії за назвою або ідентифікатором.

Корпус: 238,926 актів — парламентські акти (ukpga), підзаконні акти (uksi), шотландські (asp, ssi), північноірландські (nia, nisr), валлійські (asc, anaw, wsi), історичні (aep, apgb) та збережене право ЄС (eur, eudn, eudr).
query — фрагмент назви або ідентифікатор виду 'ukpga/1990/8'. leg_type і year звужують пошук.
⚠ Кожен результат містить has_text і versions: текст є у 129,897 актів, історія редакцій — у 62,866. Решта опублікована джерелом лише сканами.
Далі: uk_get_act для метаданих і покриття, uk_get_provision для тексту норми (з as_of — на дату), uk_get_provision_history для історії змін норми.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Фрагмент назви або ідентифікатор, напр. 'Companies Act 2006' чи 'ukpga/2006/46'" },
            leg_type: { type: 'string', description: "Тип акта: ukpga, uksi, asp, ssi, nia, nisr, asc, anaw, wsi, eur, eudn, eudr тощо" },
            year: { type: 'number', description: 'Рік' },
            with_text_only: { type: 'boolean', default: false, description: 'Лише акти, для яких є текст' },
            limit: { type: 'number', default: 20, maximum: 50, description: 'Макс. результатів' },
            offset: { type: 'number', default: 0, description: 'Зсув для пагінації' },
          },
          required: ['query'],
        },
      },
      {
        name: 'uk_get_act',
        annotations: { title: 'Акт Великої Британії: метадані та покриття', readOnlyHint: true },
        description: `Метадані акта разом із чесною довідкою про те, що саме ми про нього маємо.

Потрібен leg_id (напр. 'ukpga/2006/46'). Повертає назву, тип, рік, номер, статус, територію дії, дати прийняття та набуття чинності, і далі:
coverage — скільки норм із текстом, чи є історія редакцій (point-in-time) та її межі;
effects — кількість поправок, що стосуються акта, з яких unapplied — редакційно ще не внесені в текст. ⚠ Це головна причина, чому чинний текст може відставати від права: 32,766 актів мають щонайменше одну невнесену поправку.
Якщо тексту немає — пояснює чому і дає посилання на джерело, а не віддає порожній результат.`,
        inputSchema: {
          type: 'object',
          properties: {
            leg_id: { type: 'string', description: "Ідентифікатор акта, напр. 'ukpga/2006/46'" },
          },
          required: ['leg_id'],
        },
      },
      {
        name: 'uk_get_provision',
        annotations: { title: 'Норма акта Великої Британії, за потреби на дату', readOnlyHint: true },
        description: `Текст окремої норми (section, regulation, article, schedule) акта Великої Британії.

Потрібні leg_id і provision. provision приймає номер ('55', '2A'), частковий ключ ('section/55') або повний ('ukpga/1990/8/section/55').
Без as_of повертає чинний текст із uk_legislation_provisions.
З as_of (YYYY-MM-DD) повертає редакцію, що діяла на цю дату, з інтервалу [valid_from, valid_to). Це доступно для 62,866 актів; якщо для акта історії немає, інструмент прямо про це каже і віддає чинний текст.
⚠ ${AS_AT_CAVEAT}`,
        inputSchema: {
          type: 'object',
          properties: {
            leg_id: { type: 'string', description: "Ідентифікатор акта, напр. 'ukpga/1990/8'" },
            provision: { type: 'string', description: "Номер або ключ норми, напр. '55' або 'section/55'" },
            provision_type: { type: 'string', description: "Тип норми, якщо номер неоднозначний: section, regulation, article, paragraph" },
            as_of: { type: 'string', description: 'Дата (YYYY-MM-DD) — текст станом на цей день' },
          },
          required: ['leg_id', 'provision'],
        },
      },
      {
        name: 'uk_get_provision_history',
        annotations: { title: 'Історія змін норми акта Великої Британії', readOnlyHint: true },
        description: `Повна хронологія редакцій однієї норми: кожен інтервал, протягом якого її текст не змінювався, від найранішої редакції в архіві до поточної.

Потрібні leg_id і provision. Для кожного інтервалу повертає valid_from, valid_to, довжину тексту і — за include_text — сам текст.
Це прямий спосіб відповісти «коли і як змінилася ця норма». Наприклад, section 4 Human Rights Act 1998 дає п'ять інтервалів, і 2009-10-01 у переліку — це день, коли Constitutional Reform Act 2005 замінив House of Lords на Supreme Court.
⚠ ${AS_AT_CAVEAT}`,
        inputSchema: {
          type: 'object',
          properties: {
            leg_id: { type: 'string', description: "Ідентифікатор акта" },
            provision: { type: 'string', description: 'Номер або ключ норми' },
            provision_type: { type: 'string', description: 'Тип норми, якщо номер неоднозначний' },
            include_text: { type: 'boolean', default: false, description: 'Повертати текст кожної редакції, а не лише дати' },
          },
          required: ['leg_id', 'provision'],
        },
      },
      {
        name: 'uk_get_act_as_at',
        annotations: { title: 'Акт Великої Британії цілком станом на дату', readOnlyHint: true },
        description: `Весь акт у редакції, що діяла на задану дату, у порядку документа.

Потрібні leg_id і as_of (YYYY-MM-DD). Доступно для 62,866 актів, які мають історію редакцій.
offset/max_chars керують посторінковим читанням (max_chars типово 50000, максимум 200000); truncated=true, якщо текст не вміщено повністю.
Якщо жодна норма не діяла на as_of — повертає найранішу та найпізнішу відомі дати замість порожнього результату, щоб було видно, чи дата поза межами архіву.
⚠ ${AS_AT_CAVEAT}`,
        inputSchema: {
          type: 'object',
          properties: {
            leg_id: { type: 'string', description: "Ідентифікатор акта, напр. 'ukpga/2006/46'" },
            as_of: { type: 'string', description: 'Дата (YYYY-MM-DD)' },
            offset: { type: 'number', default: 0, description: 'Зсув у символах' },
            max_chars: { type: 'number', default: 50000, maximum: 200000, description: 'Макс. символів у відповіді' },
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
      return this.wrapResponse('Вкажіть query — назву акта або його ідентифікатор.');
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
            ? `Акт ${asId} відсутній у реєстрі. Реєстр охоплює 238,926 актів; перевірте ідентифікатор на legislation.gov.uk.`
            : 'Нічого не знайдено за назвою. Спробуйте коротший фрагмент або вкажіть leg_type і year.',
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
      return this.wrapResponse({ error: 'query_failed', message: 'Пошук законодавства Великої Британії не виконано.' });
    }
  }

  // ─── uk_get_act ────────────────────────────────────────────────────

  private async getAct(args: Record<string, unknown>): Promise<ToolResult> {
    const legId = normaliseLegId((args as any).leg_id);
    if (!legId) return this.wrapResponse({ error: 'bad_leg_id', message: "leg_id має виглядати як 'ukpga/2006/46'." });

    try {
      const act = (await this.db.query(
        `SELECT id, leg_type, year, number, title, long_title, document_status, extent,
                enactment_date, made_date, coming_into_force, valid_date, source_url,
                unapplied_effects
           FROM uk_legislation WHERE id = $1`, [legId])).rows[0];
      if (!act) {
        return this.wrapResponse({ error: 'not_found', entity: 'act', leg_id: legId,
          message: `Акт ${legId} відсутній у реєстрі (238,926 актів).` });
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
            ? 'Невнесені поправки вже ухвалені, але редакційно ще не відображені в тексті акта, тож чинний текст може відставати від права.'
            : undefined,
        },
        attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
      });
    } catch (err) {
      logger.error('[uk_get_act] failed', { err, legId });
      return this.wrapResponse({ error: 'query_failed', message: 'Не вдалося отримати акт.' });
    }
  }

  // ─── uk_get_provision ──────────────────────────────────────────────

  private async getProvision(args: Record<string, unknown>): Promise<ToolResult> {
    const legId = normaliseLegId((args as any).leg_id);
    const provision = (args as any).provision;
    const asOf = (args as any).as_of ? String((args as any).as_of) : null;
    if (!legId) return this.wrapResponse({ error: 'bad_leg_id', message: "leg_id має виглядати як 'ukpga/1990/8'." });
    if (!provision) return this.wrapResponse({ error: 'bad_provision', message: 'Вкажіть provision — номер або ключ норми.' });
    if (asOf && !ISO_DATE.test(asOf)) return this.wrapResponse({ error: 'bad_date', message: 'as_of має бути у форматі YYYY-MM-DD.' });

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
            message: 'Для цього акта історії редакцій немає (point-in-time охоплює 62,866 актів). Нижче — чинний текст.',
            provision: current || null,
          });
        }
        return this.wrapResponse({
          error: 'no_version_for_date', leg_id: legId, provision_key: key, as_of: asOf,
          history_from: span.from_, history_to: span.to_,
          message: 'Норма не діяла на цю дату або дата поза межами історії, яку містить архів.',
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
            ? 'Норму не знайдено. Перевірте номер або вкажіть provision_type (section / regulation / article).'
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
      return this.wrapResponse({ error: 'query_failed', message: 'Не вдалося отримати норму.' });
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
      message: 'Цей номер у межах акта має кілька норм — уточніть provision повним ключем.',
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
    if (!legId) return this.wrapResponse({ error: 'bad_leg_id', message: "leg_id має виглядати як 'ukpga/1998/42'." });
    if (!provision) return this.wrapResponse({ error: 'bad_provision', message: 'Вкажіть provision — номер або ключ норми.' });

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
            ? 'Норму не знайдено в історії цього акта. Перевірте номер або вкажіть provision_type.'
            : 'Для цього акта історії редакцій немає — point-in-time охоплює 62,866 актів із 238,926.',
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
      return this.wrapResponse({ error: 'query_failed', message: 'Не вдалося отримати історію норми.' });
    }
  }

  // ─── uk_get_act_as_at ──────────────────────────────────────────────

  private async getActAsAt(args: Record<string, unknown>): Promise<ToolResult> {
    const legId = normaliseLegId((args as any).leg_id);
    const asOf = (args as any).as_of ? String((args as any).as_of) : null;
    const offset = Math.max(Number((args as any).offset) || 0, 0);
    const maxChars = Math.min(Number((args as any).max_chars) || 50000, 200000);
    if (!legId) return this.wrapResponse({ error: 'bad_leg_id', message: "leg_id має виглядати як 'ukpga/2006/46'." });
    if (!asOf || !ISO_DATE.test(asOf)) return this.wrapResponse({ error: 'bad_date', message: 'as_of обовʼязкова, формат YYYY-MM-DD.' });

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
            ? 'На цю дату жодна норма акта не діяла — дата поза межами історії, яку містить архів.'
            : 'Для цього акта історії редакцій немає — point-in-time охоплює 62,866 актів із 238,926.',
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
      return this.wrapResponse({ error: 'query_failed', message: 'Не вдалося зібрати текст акта на дату.' });
    }
  }
}
