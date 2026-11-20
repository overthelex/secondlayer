/**
 * Foreign founders in the ЄДР relationship graph (LEXAI-2321), the builder's side:
 *   - graph_stage.foreign_fix: founder entries the parser marked as foreign organisations, re-read
 *     in JS (keys.ts foreignFounderFix). Individuals among them (passport data or a date of birth
 *     in the code or the name, a patronymic, a beneficial owner / qualifying holder written into
 *     the founder list) become person_name endpoints with a cleaned name and no code; companies
 *     keep their registration numbers but lose passport words and dates of birth.
 *   - checkPassportsAndDob: the post-build check next to checkPersonalIds (10-digit runs):
 *     passport series / the word 'паспорт' in person and organisation labels and keys, a full
 *     date in a person's label, and in a foreign entity's label, key or codes the word 'паспорт'
 *     or a date of birth. Foreign registration numbers that look like passport series ('HE 123456',
 *     'FN 123456 z', a Russian 10-digit ИНН) are not personal and are not checked.
 */
import type { PoolClient } from 'pg';
import { uaMatchKey } from '../edr-history/norm';
import { DATE_CHECK_SQL, DOB_CHECK_SQL, PASSPORT_CHECK_SQL, PASSPORT_WORD_CHECK_SQL } from '../graph-norm/personal-ids';
import { foreignFounderFix } from './keys';

type Q = Pick<PoolClient, 'query'>;

/**
 * Stage graph_stage.foreign_fix (name, code) -> (kind, clean, clean_key, drop_code) for the
 * foreign organisation founder entries of edr_hist.founder (rows matching scopeSql) and
 * graph_stage.cur_founder. Empty name / code are stored as ''. Returns counts for graph.build.
 */
export async function stageForeignFix(c: Q, scopeSql: string): Promise<Record<string, number>> {
  await c.query(`CREATE UNLOGGED TABLE graph_stage.foreign_fix (name text NOT NULL, code text NOT NULL, kind text NOT NULL,
    clean text, clean_key text, drop_code boolean NOT NULL, PRIMARY KEY (name, code))`);
  const src = (await c.query(`SELECT DISTINCT coalesce(name, '') AS name, coalesce(code, '') AS code FROM (
      SELECT name, code FROM edr_hist.founder WHERE kind = 'organisation' AND coalesce(country_code, 'UA') <> 'UA' AND ${scopeSql}
      UNION ALL
      SELECT name, code FROM graph_stage.cur_founder WHERE kind = 'organisation' AND coalesce(country_code, 'UA') <> 'UA') x`)).rows as Array<{ name: string; code: string }>;
  const rows: Array<[string, string, string, string | null, string | null, boolean]> = [];
  let persons = 0;
  let codesDropped = 0;
  for (const r of src) {
    const fix = foreignFounderFix(r.name || null, r.code || null);
    if (!fix) continue;
    if (fix.kind === 'person') persons++;
    if (fix.dropCode && r.code) codesDropped++;
    rows.push([r.name, r.code, fix.kind, fix.name, fix.name ? uaMatchKey(fix.name) || null : null, fix.dropCode]);
  }
  for (let i = 0; i < rows.length; i += 20000) {
    const b = rows.slice(i, i + 20000);
    await c.query(`INSERT INTO graph_stage.foreign_fix
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[]) ON CONFLICT DO NOTHING`,
      [0, 1, 2, 3, 4, 5].map(k => b.map(x => x[k])));
  }
  await c.query('ANALYZE graph_stage.foreign_fix');
  return {
    foreign_founder_values: src.length,
    foreign_founder_values_to_person: persons,
    foreign_founder_values_fixed: rows.length,
    foreign_founder_codes_dropped: codesDropped,
  };
}

/**
 * Post-build check (LEXAI-2321): throws when passport data or a date of birth is left in the
 * graph (see the module comment), so such a build is never swapped in. The same on the live graph:
 *
 *   SELECT kind, count(*) FROM graph.node WHERE
 *        (kind IN ('person_name', 'organisation') AND (label ~ :passport OR key ~ :passport))
 *     OR (kind = 'person_name' AND label ~ :date)
 *     OR (kind = 'foreign_entity' AND (label ~ :passport_word OR key ~ :passport_word OR label ~ :dob
 *         OR coalesce(attrs->>'codes', '') ~ :passport_word OR coalesce(attrs->>'codes', '') ~ :date))
 *   GROUP BY kind;
 * with the patterns PASSPORT_CHECK_SQL, DATE_CHECK_SQL, PASSPORT_WORD_CHECK_SQL, DOB_CHECK_SQL of
 * graph-norm/personal-ids.ts.
 */
export async function checkPassportsAndDob(c: Q, schema: string): Promise<{ passport_dob_nodes: number }> {
  const rows = (await c.query(`SELECT kind, count(*) AS n FROM ${schema}.node WHERE
       (kind IN ('person_name', 'organisation') AND (label ~ $1 OR key ~ $1))
    OR (kind = 'person_name' AND label ~ $2)
    OR (kind = 'foreign_entity' AND (label ~ $3 OR key ~ $3 OR label ~ $4
        OR coalesce(attrs->>'codes', '') ~ $3 OR coalesce(attrs->>'codes', '') ~ $2))
    GROUP BY kind`, [PASSPORT_CHECK_SQL, DATE_CHECK_SQL, PASSPORT_WORD_CHECK_SQL, DOB_CHECK_SQL])).rows as Array<{ kind: string; n: string }>;
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  if (total) {
    throw new Error(`passport data or dates of birth left in the graph: ${total} nodes (${rows.map(r => `${r.kind} ${r.n}`).join(', ')}); `
      + 'see graph-norm/personal-ids.ts and graph/foreign-founders.ts. Not swapped in.');
  }
  return { passport_dob_nodes: total };
}
