/**
 * query-ir/build-where.ts — the single safe WHERE-clause builder.
 *
 * Generalizes the registry-search buildWhereClause so registry AND EDRSR
 * share one implementation. Guarantees:
 *   - field whitelist: only declared FieldDef[] are processed; any extra key
 *     in `filters` is ignored (combine with a z.strictObject IR upstream).
 *   - parameterization: every value goes through a $N placeholder, never
 *     string-interpolated into SQL.
 *
 * Special slots that aren't a simple column match (e.g. EDRSR party_role
 * regex anchoring, FTS tsquery composition) stay in the caller and compose
 * via the `startParamIndex` / `nextParamIndex` cursor.
 */
import type { FieldDef } from './field-def';

export interface BuildWhereOptions {
  /** First $N index to use (default 1). Lets callers prepend other conditions. */
  startParamIndex?: number;
}

export interface BuildWhereResult {
  /** Conditions joined with AND, or null when nothing matched. */
  whereClause: string | null;
  values: any[];
  /** Next free $N index (for LIMIT/OFFSET or further conditions). */
  nextParamIndex: number;
}

/**
 * Build a parameterized WHERE fragment from whitelisted fields + raw filters.
 * Faithful port of registry-search-tool.buildWhereClause, made pure + composable.
 */
export function buildWhere(
  fields: FieldDef[],
  filters: Record<string, any>,
  opts: BuildWhereOptions = {}
): BuildWhereResult {
  const conditions: string[] = [];
  const values: any[] = [];
  let pi = opts.startParamIndex ?? 1;

  for (const field of fields) {
    let val = filters[field.name];
    if (val === undefined || val === null || val === '') continue;

    if (field.type === 'number') val = Number(val);
    if (field.transform === 'uppercase' && typeof val === 'string') val = val.toUpperCase();

    switch (field.match) {
      case 'ilike':
        conditions.push(`${field.columns[0]} ILIKE $${pi}`);
        values.push(`%${val}%`);
        pi++;
        break;

      case 'exact':
        conditions.push(`${field.columns[0]} = $${pi}`);
        values.push(val);
        pi++;
        break;

      // Case-insensitive exact match for categorical enums. ILIKE with a value
      // that has no % / _ is a plain case-insensitive equality — avoids the
      // substring trap of 'ilike' (e.g. status "active" matching "inactive").
      case 'exact_ci':
        conditions.push(`${field.columns[0]} ILIKE $${pi}`);
        values.push(val);
        pi++;
        break;

      case 'ilike_multi':
        conditions.push(`(${field.columns.map(c => `${c} ILIKE $${pi}`).join(' OR ')})`);
        values.push(`%${val}%`);
        pi++;
        break;

      case 'exact_multi':
        conditions.push(`(${field.columns.map(c => `${c} = $${pi}`).join(' OR ')})`);
        values.push(val);
        pi++;
        break;

      case 'gte':
        conditions.push(`${field.columns[0]} >= $${pi}`);
        values.push(val);
        pi++;
        break;

      case 'lte':
        conditions.push(`${field.columns[0]} <= $${pi}`);
        values.push(val);
        pi++;
        break;

      case 'array_contains':
        conditions.push(`$${pi} = ANY(${field.columns[0]})`);
        values.push(val);
        pi++;
        break;

      case 'array_contains_text':
        // text[] array column; cast the bind param so a numeric slot value
        // (e.g. NICE class 25) compares against text elements without a
        // "operator does not exist: integer = text" error.
        conditions.push(`$${pi}::text = ANY(${field.columns[0]})`);
        values.push(String(val));
        pi++;
        break;

      case 'eq_any':
        conditions.push(`${field.columns[0]} = ANY($${pi})`);
        values.push(val);
        pi++;
        break;

      case 'ilike_cast':
        conditions.push(`${field.columns[0]}::text ILIKE $${pi}`);
        values.push(`%${val}%`);
        pi++;
        break;

      // ftsExpression, when a registry declares one, must be reproduced verbatim:
      // a GIN index over a tsvector expression is only used if the query spells
      // that expression identically. See FieldDef.ftsExpression.
      case 'fts':
        conditions.push(`to_tsvector('english', ${field.ftsExpression || field.columns[0]}) @@ plainto_tsquery('english', $${pi})`);
        values.push(val);
        pi++;
        break;

      case 'fts_simple':
        conditions.push(`to_tsvector('simple', ${field.ftsExpression || field.columns[0]}) @@ plainto_tsquery('simple', $${pi})`);
        values.push(val);
        pi++;
        break;
    }
  }

  return {
    whereClause: conditions.length > 0 ? conditions.join(' AND ') : null,
    values,
    nextParamIndex: pi,
  };
}
