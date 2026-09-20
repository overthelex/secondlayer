/**
 * A migration says what a deployment IS. A repair fixes what happened to one
 * database once.
 *
 * Mixing them means the fix for one box's incident ships automatically to every
 * box, during a deploy, with nobody watching. That is not hypothetical: on
 * 2026-09-19 a repair written for the UK corpus ran against legal.org.ua as part
 * of an ordinary deploy. It matched nothing — by luck, its predicate was wrong
 * and could have matched — and because it was recorded in schema_migrations it
 * could never be corrected in place, which cost a second migration to undo the
 * first.
 *
 * Repairs now live in mcp_backend/src/repairs/ and run from
 * .github/workflows/run-repair.yml: named repair, named target, dry run first.
 *
 * This test is what keeps that true. A rule about where files go survives
 * exactly until the first time someone needs to fix production quickly.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..');
const REPAIRS = join(MIGRATIONS, '..', 'repairs');

// Everything at or below this number predates the rule. They are not being
// rewritten — several are seed data that new deployments genuinely need, and
// the rest have long since run everywhere. The line is drawn, not backdated.
// ⚠ 220, not 222. Removing 220 and 221 from the tree left the highest migration
// at 219, so a threshold of 222 made this test pass over an empty set — and left
// the two slots the incident actually used wide open. The line sits immediately
// above the last existing migration.
const GRANDFATHERED_BELOW = 220;

// Tables that hold harvested law. An UPDATE against one of these is repairing
// a corpus, which is a thing that happened to a database rather than a thing a
// deployment is.
//
// Reference data is deliberately NOT here: tool pricing, sync sources and the
// like are seeded by migrations on purpose, because a deployment without them
// is not a working deployment.
const CORPUS_TABLES = [
  'uk_legislation', 'uk_legislation_versions', 'uk_legislation_provisions',
  'uk_provision_version', 'uk_provision_text', 'uk_court_decisions',
  'edrsr_documents', 'edrsr_fulltext', 'ch_court_decisions', 'ch_cantonal_registry',
  'legislation_articles', 'opendata_trademarks', 'opendata_patents',
];

function migrationNumber(f: string): number {
  const m = /^(\d+)_/.exec(f);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

describe('migrations are not repairs', () => {
  it('no new migration repairs a corpus table', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
      if (migrationNumber(f) < GRANDFATHERED_BELOW) continue;
      const sql = readFileSync(join(MIGRATIONS, f), 'utf-8')
        // strip line comments so a table named only in prose does not trip this
        .replace(/--[^\n]*/g, '');
      for (const t of CORPUS_TABLES) {
        const rx = new RegExp(`\\b(update|delete\\s+from)\\s+(public\\.)?${t}\\b`, 'i');
        if (rx.test(sql)) offenders.push(`${f} -> ${t}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('repairs live in their own directory and carry no transaction control', () => {
    // The runner supplies BEGIN/COMMIT so that the same bytes can be rolled
    // back for a dry run. A COMMIT inside the file would keep the changes
    // anyway, which is the one thing a dry run must not do.
    expect(existsSync(REPAIRS)).toBe(true);
    const files = readdirSync(REPAIRS).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    // ⚠ The same pattern as run-repair.yml, deliberately. They had drifted: the
    // workflow refused `COMMIT WORK;` at run time while this test — which is the
    // gate a pull request actually passes through — matched only the bare
    // keyword, so such a file would have merged and only failed later, in front
    // of production data.
    //
    // Keyword plus word boundary, anchored at a statement start rather than a
    // line start, because `UPDATE t SET x=1; COMMIT WORK;` is one line.
    const TX = /(^|;)[ \t]*(begin|start\s+transaction|commit|end|rollback|savepoint)\b/im;
    const withTx = files.filter((f) => {
      const sql = readFileSync(join(REPAIRS, f), 'utf-8')
        .replace(/--[^\n]*/g, '')          // a COMMIT in prose is not a COMMIT
        .replace(/'(?:[^']|'')*'/g, "''");  // nor is one inside a string literal
      return TX.test(sql);
    });
    expect(withTx).toEqual([]);
  });

  it('no repair is also listed as a migration', () => {
    // The same fix in both places would run unwatched during a deploy, which is
    // the arrangement this whole split exists to end.
    const repairs = new Set(readdirSync(REPAIRS).filter((f) => f.endsWith('.sql')));
    const dupes = readdirSync(MIGRATIONS).filter((f) => repairs.has(f));
    expect(dupes).toEqual([]);
  });
});
