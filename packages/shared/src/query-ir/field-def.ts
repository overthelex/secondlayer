/**
 * query-ir/field-def.ts — declarative field → SQL match mapping.
 *
 * Canonical home for MatchType / FieldDef (moved out of mcp_backend
 * registry-catalog.ts so registry AND EDRSR share ONE definition).
 * A FieldDef whitelists a slot: only declared fields ever reach SQL, and
 * each maps to a fixed parameterized condition shape — no interpolation.
 */

export type MatchType =
  | 'ilike'          // col ILIKE $N  (%val%)
  | 'exact'          // col = $N
  | 'exact_ci'       // col ILIKE $N  (val verbatim, no wildcards) — case-insensitive exact match for categorical enums
  | 'ilike_multi'    // (col1 ILIKE $N OR col2 ILIKE $N ...)  (%val%)
  | 'exact_multi'    // (col1 = $N OR col2 = $N ...)
  | 'gte'            // col >= $N
  | 'lte'            // col <= $N
  | 'array_contains' // $N = ANY(col)         — col is an array column, val is scalar
  | 'array_contains_text' // $N::text = ANY(col) — text[] array column, val cast to text (LLM may send a number)
  | 'eq_any'         // col = ANY($N)          — col is scalar, val is an array of allowed values
  | 'ilike_cast'     // col::text ILIKE $N  (%val%)
  | 'fts'            // to_tsvector('english', col) @@ plainto_tsquery('english', $N)
  | 'fts_simple';    // to_tsvector('simple', col) @@ plainto_tsquery('simple', $N)

export interface FieldDef {
  name: string;
  /** Human/LLM-facing description of the filter (optional for non-catalog uses). */
  description?: string;
  match: MatchType;
  /** Fully-qualified column name(s), e.g. 'name' or 'd.judge'. */
  columns: string[];
  type?: 'string' | 'number' | 'boolean';
  transform?: 'uppercase';
  /**
   * For 'fts' / 'fts_simple' only: the exact expression to build the tsvector
   * from, replacing the default `columns[0]`.
   *
   * A GIN index on a tsvector expression is only used when the query repeats
   * that expression character for character. Several corpora index a
   * concatenation rather than one column — `uk_court_decisions` has
   * `to_tsvector('english', COALESCE(parties,'') || ' ' || COALESCE(abstract,'')
   * || ' ' || COALESCE(full_text,''))` — so searching `full_text` alone silently
   * drops to a sequential scan over gigabytes. Name the indexed expression here
   * instead of duplicating the index.
   *
   * Trusted, code-authored SQL like `columns` and `RegistryDef.baseWhere`; it is
   * never built from user input.
   */
  ftsExpression?: string;
}
