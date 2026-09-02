/**
 * ChMaterialsTools — Federal Gazette materials (`ch_material`, migration 209): Federal
 * Council dispatches (Botschaften), Federal Council reports and opinions, parliamentary
 * committee reports, full text per language, written by services/ch-pipeline
 * materials_discover_stage / materials_text_stage. LEXAI-2038, gap plan phase 1b.
 *
 * Three tools:
 *  - `ch_search_materials` — full-text search ('simple' tsvector over title + text, cut at
 *    900K characters as the index expression is), narrowable by type, language and year.
 *  - `ch_get_material` — one material by id or by (ELI, language), text sliced in SQL.
 *  - `ch_get_article_purpose` — the passages of the linked materials that discuss one article
 *    of one act. The link is DATA, not a guess: ch_article_provenance (migration 198) records
 *    the Gazette citation of the dispatch behind every amendment ("BBl 2015 657"), the
 *    material row carries its own edition's citation ("BBl 2001 1433"), and both are
 *    normalised to the same `year|volume|page` key (chpipe/bbl.py; bblKey() below is its
 *    twin and must stay identical). The citations are per language edition — the French
 *    footnote cites the French page — so the join is made within the requested language.
 *    Paragraphs are found at query time by splitting full_text on blank lines and keeping
 *    those that name the article; nothing is precomputed.
 *
 * Every hit carries `pdf_url` (the Fedlex file) and `historical_id` (the citation to write).
 * Fedlex texts are official publications, free of copyright under Art. 5 URG.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const LANGS = ['de', 'fr', 'it'];
const TYPES = ['botschaft', 'bericht_br', 'stellungnahme_br', 'bericht_kommission'];
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_TEXT_CHARS = 20000;
const MAX_TEXT_CHARS = 300000;
const DEFAULT_MAX_PARAGRAPHS = 8;
const MAX_PARAGRAPHS = 40;
const MAX_MATERIALS_PER_ARTICLE = 10;
const PARAGRAPH_CHARS = 1500;

const ROW_COLUMNS = `
  material_id, eli_work_uri, lang, material_type, title, historical_id,
  to_char(date_document, 'YYYY-MM-DD') AS date_document,
  to_char(publication_date, 'YYYY-MM-DD') AS publication_date,
  pdf_url, stage`;

const FTS_EXPR = `to_tsvector('simple', left(coalesce(title, '') || ' ' || coalesce(full_text, ''), 900000))`;

// Twin of chpipe/bbl.py::bbl_key — same regex, same key shape.
const BBL_RE = /^\s*(?:BBl|FF|BBI)\s+(\d{4})\s+(?:([IVX]{1,4})\s+)?(\d+)\b/i;

export function bblKey(reference: unknown): string | null {
  if (typeof reference !== 'string') return null;
  const m = BBL_RE.exec(reference);
  if (!m) return null;
  const page = m[3].replace(/^0+/, '') || '0';
  return `${m[1]}|${(m[2] || '').toUpperCase()}|${page}`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ChMaterialsTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'ch_search_materials',
        annotations: { title: 'Пошук у матеріалах законодавця Швейцарії (Botschaften)', readOnlyHint: true },
        description: `Повнотекстовий пошук у матеріалах федерального законодавця Швейцарії з Bundesblatt/Feuille fédérale (Fedlex): послання Федеральної ради (Botschaft / Message, 2,048 з 1999 р.), звіти та позиції Федеральної ради, звіти парламентських комісій — de/fr/it. Результат: заголовок, тип, дата, цитата BBl/FF (historical_id), pdf_url, фрагмент. Повний текст — через ch_get_material; пояснення до конкретної статті закону — через ch_get_article_purpose.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Пошуковий запит (de/fr/it)' },
            material_type: { type: 'string', enum: TYPES, description: 'botschaft | bericht_br | stellungnahme_br | bericht_kommission' },
            lang: { type: 'string', enum: LANGS, description: 'Мова видання' },
            year_from: { type: 'integer', description: 'Рік публікації від' },
            year_to: { type: 'integer', description: 'Рік публікації до' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
          required: ['query'],
        },
      },
      {
        name: 'ch_get_material',
        annotations: { title: 'Матеріал законодавця Швейцарії (Botschaft) — текст', readOnlyHint: true },
        description: `Повний текст одного матеріалу з Bundesblatt (Fedlex) за material_id або за eli_work_uri (напр. https://fedlex.data.admin.ch/eli/fga/2001/318) і мовою. Текст віддається зрізом (text_offset / text_chars, типово перші 20 000 символів; text_total_chars — повна довжина). Якщо матеріалу немає — { error: 'not_found', available_langs }.`,
        inputSchema: {
          type: 'object',
          properties: {
            material_id: { type: 'integer', description: 'Ідентифікатор з ch_search_materials' },
            eli_work_uri: { type: 'string', description: 'ELI роботи Fedlex, напр. https://fedlex.data.admin.ch/eli/fga/2001/318' },
            lang: { type: 'string', enum: LANGS, default: 'de' },
            text_offset: { type: 'integer', minimum: 0, default: 0 },
            text_chars: { type: 'integer', minimum: 1, maximum: MAX_TEXT_CHARS, default: DEFAULT_TEXT_CHARS },
          },
        },
      },
      {
        name: 'ch_get_article_purpose',
        annotations: { title: 'Мета статті закону Швейцарії за Botschaft', readOnlyHint: true },
        description: `Що законодавець мав на увазі під статтею швейцарського федерального акта: уривки з послань Федеральної ради (Botschaft) та інших матеріалів Bundesblatt, які цю статтю обговорюють.

Зв'язок статті з матеріалом — не здогад: примітки до консолідованих редакцій (ch_article_provenance) називають цитату BBl/FF послання за кожною поправкою статті; матеріал несе цитату свого видання; збіг нормалізованих цитат у межах мови і є зв'язком (link_method 'provenance_bbl'). Потрібні sr_number та article; lang типово 'de'. Повертає для кожного пов'язаного матеріалу заголовок, дату, historical_id, pdf_url і до max_paragraphs абзаців, у яких згадано "Art. N". Якщо примітки не називають жодної цитати BBl — { error: 'no_materials_linked', bbl_references }; якщо цитати є, але матеріал ще не завантажено — materials з stage <> 'parsed' і paragraphs: [].
Стеля: примітки Fedlex до 1999 р. цитують багатотомний BBl ("FF 1986 II 360"), для якого у Fedlex немає тексту.`,
        inputSchema: {
          type: 'object',
          properties: {
            sr_number: { type: 'string', description: 'Номер SR акта, напр. 220' },
            article: { type: 'string', description: "Номер статті, напр. '336' або '336a'" },
            lang: { type: 'string', enum: LANGS, default: 'de' },
            max_paragraphs: { type: 'integer', minimum: 1, maximum: MAX_PARAGRAPHS, default: DEFAULT_MAX_PARAGRAPHS, description: 'Абзаців на матеріал' },
          },
          required: ['sr_number', 'article'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'ch_search_materials': return this.searchMaterials(args);
      case 'ch_get_material': return this.getMaterial(args);
      case 'ch_get_article_purpose': return this.getArticlePurpose(args);
      default: return null;
    }
  }

  private async searchMaterials(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, material_type, lang } = args as any;
    if (!query || !String(query).trim()) {
      return this.wrapResponse('Вкажіть query — пошуковий запит.');
    }
    if (material_type != null && !TYPES.includes(String(material_type))) {
      return this.wrapResponse(`material_type має бути одним з: ${TYPES.join(', ')}.`);
    }
    if (lang != null && !LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    const limit = clampInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const offset = clampInt(args.offset, 0, 0, 100000);

    const params: unknown[] = [String(query).trim()];
    const where = [`${FTS_EXPR} @@ plainto_tsquery('simple', $1)`, `stage = 'parsed'`];
    if (material_type) { params.push(String(material_type)); where.push(`material_type = $${params.length}`); }
    if (lang) { params.push(String(lang)); where.push(`lang = $${params.length}`); }
    const yearFrom = Number(args.year_from);
    if (Number.isFinite(yearFrom) && yearFrom > 0) { params.push(Math.trunc(yearFrom)); where.push(`extract(year from publication_date) >= $${params.length}`); }
    const yearTo = Number(args.year_to);
    if (Number.isFinite(yearTo) && yearTo > 0) { params.push(Math.trunc(yearTo)); where.push(`extract(year from publication_date) <= $${params.length}`); }
    params.push(limit, offset);

    try {
      const rows = (await this.db.query(
        `SELECT ${ROW_COLUMNS},
                ts_rank(${FTS_EXPR}, plainto_tsquery('simple', $1)) AS rank,
                ts_headline('simple', left(full_text, 900000), plainto_tsquery('simple', $1),
                            'MaxWords=40, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "') AS snippet,
                COUNT(*) OVER() AS _total_count
           FROM ch_material
          WHERE ${where.join(' AND ')}
          ORDER BY rank DESC, publication_date DESC NULLS LAST, material_id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      )).rows;
      return this.wrapSearchResults(rows, limit, offset);
    } catch (error: any) {
      logger.error('[ChMaterialsTools] ch_search_materials failed', { error: error.message });
      return this.wrapError(`Помилка пошуку в матеріалах: ${error.message}`);
    }
  }

  private async getMaterial(args: Record<string, unknown>): Promise<ToolResult> {
    const { material_id, eli_work_uri, lang = 'de' } = args as any;
    const id = Number(material_id);
    const eli = eli_work_uri ? String(eli_work_uri).trim() : '';
    if (!(Number.isFinite(id) && id > 0) && !eli) {
      return this.wrapResponse('Вкажіть material_id або eli_work_uri.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    const offset = clampInt(args.text_offset, 0, 0, MAX_TEXT_CHARS * 100);
    const chars = clampInt(args.text_chars, DEFAULT_TEXT_CHARS, 1, MAX_TEXT_CHARS);
    const byId = Number.isFinite(id) && id > 0;

    try {
      const row = (await this.db.query(
        `SELECT ${ROW_COLUMNS}, text_quality,
                substr(full_text || '', $2::int + 1, $3::int) AS text,
                length(full_text) AS text_total_chars
           FROM ch_material
          WHERE ${byId ? 'material_id = $1' : 'eli_work_uri = $1 AND lang = $4'}
          LIMIT 1`,
        byId ? [Math.trunc(id), offset, chars] : [eli, offset, chars, String(lang)]
      )).rows[0];

      if (!row) {
        const langs = eli
          ? (await this.db.query(`SELECT lang FROM ch_material WHERE eli_work_uri = $1 ORDER BY lang`, [eli])).rows.map((r: any) => r.lang)
          : [];
        return this.wrapResponse({ error: 'not_found', material_id: byId ? Math.trunc(id) : undefined, eli_work_uri: eli || undefined, lang: String(lang), available_langs: langs });
      }
      const total = Number(row.text_total_chars) || 0;
      const text = String(row.text || '');
      const { text: _t, text_total_chars: _n, ...rest } = row;
      return this.wrapResponse({
        ...rest,
        text,
        text_offset: offset,
        text_total_chars: total,
        truncated: offset + text.length < total,
        text_available: row.stage === 'parsed',
      });
    } catch (error: any) {
      logger.error('[ChMaterialsTools] ch_get_material failed', { error: error.message });
      return this.wrapError(`Помилка отримання матеріалу: ${error.message}`);
    }
  }

  private async getArticlePurpose(args: Record<string, unknown>): Promise<ToolResult> {
    const { sr_number, article, lang = 'de' } = args as any;
    if (!sr_number || !String(sr_number).trim()) {
      return this.wrapResponse('Вкажіть sr_number — номер SR акта.');
    }
    if (!article || !String(article).trim()) {
      return this.wrapResponse('Вкажіть article — номер статті.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    const maxParagraphs = clampInt(args.max_paragraphs, DEFAULT_MAX_PARAGRAPHS, 1, MAX_PARAGRAPHS);
    const sr = String(sr_number).trim();
    const art = String(article).trim();
    const language = String(lang);

    try {
      const act = (await this.db.query(
        `SELECT act_id, sr_number, abbreviation, title_de, title_fr, title_it
           FROM ch_act WHERE jurisdiction = 'CH' AND sr_number = $1
          ORDER BY enforcement_status = 0 DESC, date_entry_force DESC NULLS LAST
          LIMIT 1`,
        [sr]
      )).rows[0];
      if (!act) {
        return this.wrapResponse({ error: 'not_found', entity: 'act', sr_number: sr, jurisdiction: 'CH' });
      }

      // The Gazette citations the consolidation footnotes attach to this article, in
      // this language's editions. Same join as ch_get_act_history's provenance block.
      const refs = (await this.db.query(
        `SELECT DISTINCT p.bbl_reference, p.action, to_char(p.effective_date, 'YYYY-MM-DD') AS effective_date
           FROM ch_article_provenance p
           JOIN ch_act_version v ON v.version_id = p.version_id
          WHERE v.act_id = $1 AND v.lang = $2 AND p.bbl_reference IS NOT NULL
            AND EXISTS (SELECT 1 FROM ch_act_article a
                         WHERE a.version_id = p.version_id AND a.e_id = p.e_id AND a.article_number = $3)
          ORDER BY effective_date NULLS LAST`,
        [act.act_id, language, art]
      )).rows;

      const keyByRef = new Map<string, string>();
      for (const r of refs) {
        const key = bblKey(r.bbl_reference);
        if (key) keyByRef.set(String(r.bbl_reference), key);
      }
      const keys = [...new Set(keyByRef.values())];
      const unmatchable = refs.map((r: any) => String(r.bbl_reference)).filter((r: string) => !keyByRef.has(r));

      if (keys.length === 0) {
        return this.wrapResponse({
          error: 'no_materials_linked',
          sr_number: sr, article: art, lang: language,
          bbl_references: refs.map((r: any) => ({ bbl_reference: r.bbl_reference, action: r.action, effective_date: r.effective_date })),
          note: refs.length === 0
            ? 'Примітки до редакцій не називають цитату BBl для цієї статті.'
            : 'Цитати BBl є, але жодна не нормалізується до ключа видання Fedlex.',
        });
      }

      // Which citations have a material at all is answered over the WHOLE set of
      // linked keys; the response below is capped, and a citation whose material
      // fell past the cap is still found.
      const matchedKeys = new Set(
        (await this.db.query(
          `SELECT DISTINCT bbl_key FROM ch_material WHERE bbl_key = ANY($1::text[]) AND lang = $2`,
          [keys, language]
        )).rows.map((r: any) => String(r.bbl_key))
      );
      const materials = (await this.db.query(
        `SELECT ${ROW_COLUMNS}, bbl_key
           FROM ch_material
          WHERE bbl_key = ANY($1::text[]) AND lang = $2
          ORDER BY publication_date DESC NULLS LAST, material_id
          LIMIT ${MAX_MATERIALS_PER_ARTICLE + 1}`,
        [keys, language]
      )).rows;
      const truncated = materials.length > MAX_MATERIALS_PER_ARTICLE;
      const kept = materials.slice(0, MAX_MATERIALS_PER_ARTICLE);

      // "Art. 25a", "Artikel 25a", "art. 25a", "article 25a", "articolo 25a" — the article
      // token must not be followed by a letter or digit ('25a' is not '25ab', '25' is not '250').
      const pattern = `(^|[^0-9A-Za-z])(Art\\.|Artikel|Article|Articolo|Articles|Articoli|Artikeln)\\s*${escapeRegex(art)}(?![0-9A-Za-z])`;
      const out: any[] = [];
      for (const m of kept) {
        const { bbl_key: _k, ...meta } = m;
        const stage = m.stage;
        let paragraphs: any[] = [];
        if (stage === 'parsed') {
          paragraphs = (await this.db.query(
            `SELECT ordinal, left(btrim(paragraph), $3::int) AS text
               FROM ch_material,
                    regexp_split_to_table(full_text, E'\\n[ \\t]*\\n') WITH ORDINALITY AS t(paragraph, ordinal)
              WHERE material_id = $1 AND paragraph ~* $2
              ORDER BY ordinal
              LIMIT $4::int`,
            [m.material_id, pattern, PARAGRAPH_CHARS, maxParagraphs + 1]
          )).rows;
        }
        out.push({
          ...meta,
          text_available: stage === 'parsed',
          matched_via: [...keyByRef.entries()].filter(([, k]) => k === m.bbl_key).map(([ref]) => ref),
          paragraphs: paragraphs.slice(0, maxParagraphs).map((p: any) => ({ ordinal: Number(p.ordinal), text: p.text })),
          paragraphs_truncated: paragraphs.length > maxParagraphs,
        });
      }

      return this.wrapResponse({
        sr_number: sr,
        act_title: act[`title_${language}`] || act.title_de,
        abbreviation: act.abbreviation,
        article: art,
        lang: language,
        link_method: 'provenance_bbl',
        bbl_references: refs.map((r: any) => ({
          bbl_reference: r.bbl_reference, action: r.action, effective_date: r.effective_date,
          material_found: matchedKeys.has(keyByRef.get(String(r.bbl_reference)) || ''),
        })),
        unmatchable_references: unmatchable,
        materials: out,
        materials_truncated: truncated,
      });
    } catch (error: any) {
      logger.error('[ChMaterialsTools] ch_get_article_purpose failed', { error: error.message });
      return this.wrapError(`Помилка пошуку матеріалів до статті: ${error.message}`);
    }
  }
}
