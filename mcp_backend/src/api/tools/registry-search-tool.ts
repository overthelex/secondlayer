/**
 * Registry Search Tool — single meta-tool replacing 22 parametric SQL search tools.
 *
 * One tool `search_registry` with a `registry` enum and dynamic `filters` object.
 * The catalog in registry-catalog.ts declares table, columns, match types, descriptions.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { REGISTRY_CATALOG, RegistryDef, FieldDef } from './registry-catalog.js';
import { buildWhere } from '@secondlayer/shared';
import { logger } from '../../utils/logger.js';

const REGISTRY_KEYS = Object.keys(REGISTRY_CATALOG);

// Array-column match types (val tested against ANY(col)). Such columns cannot
// be used as a GROUP BY / COUNT(DISTINCT) target in aggregate mode.
const isArrayMatch = (m: FieldDef['match']): boolean =>
  m === 'array_contains' || m === 'array_contains_text';

export class RegistrySearchTool extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    const registryDescriptions = REGISTRY_KEYS
      .map(k => `• **${k}** — ${REGISTRY_CATALOG[k].title}`)
      .join('\n');

    return [{
      name: 'search_registry',
      annotations: { title: 'Пошук у реєстрах відкритих даних', readOnlyHint: true },
      description: `Єдиний інструмент для пошуку в ${REGISTRY_KEYS.length} реєстрах відкритих даних. Переважно Україна; реєстри з префіксом us_ та uk_ — це США і Велика Британія, їхні описи англійською.

Обов'язковий параметр: registry (назва реєстру).
Фільтри передаються в об'єкті filters — набір полів залежить від реєстру.

Доступні реєстри:
${registryDescriptions}

Приклад: registry="sanctions", filters={"name": "Путін"}
Приклад: registry="lawyers", filters={"last_name": "Іваненко", "ra_name": "Київська"}
Приклад: registry="vehicle_registrations", filters={"vin": "WVWZZZ3CZWE123456"}`,
      inputSchema: {
        type: 'object',
        properties: {
          registry: {
            type: 'string',
            enum: REGISTRY_KEYS,
            description: 'Назва реєстру для пошуку',
          },
          filters: {
            type: 'object',
            description: 'Фільтри пошуку (набір полів залежить від реєстру). Передайте registry без filters щоб побачити доступні поля.',
          },
          aggregate: {
            type: 'object',
            description: `Режим агрегації замість переліку рядків: group_by (поле з фільтрів реєстру), count_distinct (рахувати унікальні значення цього поля в групі), min_count (залишити групи з count_distinct ≥ N), min_length (мін. довжина значення group_by, відсікає шум). Повертає топ груп за спаданням.
Приклад (тотожні ТМ на кількох власників у класі 33): registry="trademarks", filters={"nice_class": 33}, aggregate={"group_by": "mark_text", "count_distinct": "holder_name", "min_count": 2, "min_length": 4}`,
            properties: {
              group_by: { type: 'string', description: 'Поле групування (з переліку фільтрів реєстру)' },
              count_distinct: { type: 'string', description: 'Поле, унікальні значення якого рахуються в групі' },
              min_count: { type: 'number', description: 'Мін. кількість унікальних значень count_distinct у групі (за замовч. 2, якщо задано count_distinct)' },
              min_length: { type: 'number', description: 'Мін. довжина значення group_by у символах' },
            },
            required: ['group_by'],
          },
          limit: {
            type: 'number',
            description: 'Макс. результатів (за замовч. 50, макс. 100)',
          },
        },
        required: ['registry'],
      },
    }];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'search_registry') return null;

    const { registry, filters = {}, limit, aggregate } = args;
    const def = REGISTRY_CATALOG[registry];
    if (!def) {
      return this.wrapError(`Невідомий реєстр "${registry}". Доступні: ${REGISTRY_KEYS.join(', ')}`);
    }

    if (!filters || Object.keys(filters).length === 0) {
      return this.wrapResponse(this.describeRegistry(registry, def));
    }

    // Reject unknown filter keys with a helpful field list, instead of silently
    // ignoring them (which returns misleadingly unfiltered results). The model then
    // self-corrects — e.g. it guessed `company_name` where the field is `entity_name`.
    const validNames = new Set(def.fields.map(f => f.name));
    const unknown = Object.keys(filters).filter(k => !validNames.has(k));
    if (unknown.length > 0) {
      return this.wrapResponse(`Невідомі поля фільтра: ${unknown.join(', ')}. ${this.describeRegistry(registry, def)}`);
    }

    for (const req of (def.requiredFields ?? [])) {
      if (!filters[req]) {
        return this.wrapResponse(`Обов'язковий параметр: ${req}. ${this.describeRegistry(registry, def)}`);
      }
    }

    const { whereClause, values, paramIndex } = this.buildWhereClause(def.fields, filters);
    if (!whereClause) {
      return this.wrapResponse(`Вкажіть хоча б один фільтр для пошуку. ${this.describeRegistry(registry, def)}`);
    }

    const maxLimit = def.maxLimit ?? 100;
    const defaultLimit = def.defaultLimit ?? 50;
    const lim = Math.max(1, Math.min(Number(limit) || defaultLimit, maxLimit));

    // A constant registry-level predicate (no bind params) ANDed in when one
    // physical table backs several logical registries (e.g. ip_objects).
    const fullWhere = def.baseWhere ? `(${def.baseWhere}) AND (${whereClause})` : whereClause;

    if (aggregate) {
      return this.executeAggregate(registry, def, aggregate, fullWhere, values, paramIndex, lim);
    }

    const countValues = [...values];
    values.push(lim);

    const innerSql = `SELECT ${def.selectColumns}
      FROM ${def.table}
      WHERE ${fullWhere}
      ORDER BY ${def.orderBy}
      LIMIT $${paramIndex}`;

    // outerColumns defers expensive per-row expressions until after the LIMIT.
    // Without it a document snippet is computed for every matching row and only
    // then thrown away by the sort — see RegistryDef.outerColumns for the
    // measurement.
    // The outer ORDER BY is not decoration: SQL does not carry a subquery's
    // ordering into the enclosing query, so without it the page could come back
    // in executor order. It sorts at most `limit` rows.
    const dataSql = def.outerColumns
      ? `SELECT ${def.outerColumns} FROM (${innerSql}) t`
        + (def.outerOrderBy ? `\n      ORDER BY ${def.outerOrderBy}` : '')
      : innerSql;

    const countSql = `SELECT COUNT(*) AS total FROM ${def.table} WHERE ${fullWhere}`;

    try {
      const [dataResult, countResult] = await Promise.all([
        this.db.query(dataSql, values),
        this.db.query(countSql, countValues),
      ]);
      if (dataResult.rows.length === 0) return this.wrapResponse(def.emptyMessage);
      const totalCount = parseInt(countResult.rows[0]?.total ?? '0', 10);
      dataResult.rows.forEach((r: any) => { r._total_count = totalCount; });
      // Licence acknowledgement travels with the results, not only in the
      // documentation: a caller that ever only sees tool output would otherwise
      // never see it.
      return this.wrapSearchResults(dataResult.rows, lim, 0, def.attribution);
    } catch (error: any) {
      logger.error(`search_registry[${registry}] error`, { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  /**
   * Aggregate mode (LEXAI-1820): GROUP BY a catalog field with an optional
   * distinct-count, so multi-thousand-row questions («тотожні марки на кількох
   * власників») come back as a ranked top instead of raw rows the LLM cannot
   * aggregate. All identifiers are resolved through the catalog — user input
   * never reaches SQL as an identifier.
   */
  private async executeAggregate(
    registry: string,
    def: RegistryDef,
    aggregate: any,
    whereClause: string,
    values: any[],
    paramIndex: number,
    lim: number
  ): Promise<ToolResult> {
    const resolveColumn = (fieldName: string, role: string): string | null => {
      const field = def.fields.find(f => f.name === fieldName);
      if (!field) return null;
      // Array-typed columns (array_contains / array_contains_text) cannot be
      // grouped/counted directly.
      if (isArrayMatch(field.match)) return null;
      return field.columns[0];
    };

    const groupCol = aggregate.group_by ? resolveColumn(String(aggregate.group_by), 'group_by') : null;
    if (!groupCol) {
      const usable = def.fields.filter(f => !isArrayMatch(f.match)).map(f => f.name).join(', ');
      return this.wrapResponse(`Невірне поле group_by. Доступні для агрегації: ${usable}`);
    }

    let distinctCol: string | null = null;
    if (aggregate.count_distinct) {
      distinctCol = resolveColumn(String(aggregate.count_distinct), 'count_distinct');
      if (!distinctCol) {
        const usable = def.fields.filter(f => !isArrayMatch(f.match)).map(f => f.name).join(', ');
        return this.wrapResponse(`Невірне поле count_distinct. Доступні для агрегації: ${usable}`);
      }
    }

    const conditions = [whereClause, `${groupCol} IS NOT NULL`];
    const minLength = Number(aggregate.min_length) || 0;
    if (minLength > 0) conditions.push(`length(${groupCol}) >= ${Math.floor(minLength)}`);

    const minCount = Math.max(1, Number(aggregate.min_count) || (distinctCol ? 2 : 1));
    const having = distinctCol && minCount > 1 ? ` HAVING COUNT(DISTINCT ${distinctCol}) >= ${Math.floor(minCount)}` : '';

    const distinctSelect = distinctCol
      ? `COUNT(DISTINCT ${distinctCol}) AS distinct_count, (array_agg(DISTINCT ${distinctCol}))[1:5] AS samples,`
      : '';
    const orderBy = distinctCol ? 'distinct_count DESC, row_count DESC' : 'row_count DESC';

    const sql = `SELECT lower(${groupCol}::text) AS group_value,
        ${distinctSelect}
        COUNT(*) AS row_count
      FROM ${def.table}
      WHERE ${conditions.join(' AND ')}
      GROUP BY 1${having}
      ORDER BY ${orderBy}
      LIMIT $${paramIndex}`;

    try {
      const result = await this.db.query(sql, [...values, lim]);
      if (result.rows.length === 0) {
        return this.wrapResponse('Агрегація не знайшла жодної групи за заданими умовами.');
      }
      return this.wrapResponse({
        aggregate: {
          registry,
          group_by: aggregate.group_by,
          ...(aggregate.count_distinct ? { count_distinct: aggregate.count_distinct, min_count: minCount } : {}),
        },
        groups: result.rows,
        total_groups: result.rows.length,
      });
    } catch (error: any) {
      logger.error(`search_registry[${registry}] aggregate error`, { error: error.message });
      return this.wrapError(`Помилка агрегації: ${error.message}`);
    }
  }

  private buildWhereClause(
    fields: FieldDef[],
    filters: Record<string, any>
  ): { whereClause: string | null; values: any[]; paramIndex: number } {
    // Delegates to the shared query-builder (single source of WHERE-building
    // logic for registry + EDRSR). `paramIndex` = next free $N for LIMIT.
    const { whereClause, values, nextParamIndex } = buildWhere(fields, filters);
    return { whereClause, values, paramIndex: nextParamIndex };
  }

  private describeRegistry(key: string, def: RegistryDef): string {
    const fieldDescs = def.fields.map(f => `  • ${f.name} — ${f.description}`).join('\n');
    return `Реєстр "${key}" (${def.title}):\n${def.description}\n\nДоступні фільтри:\n${fieldDescs}`;
  }
}
