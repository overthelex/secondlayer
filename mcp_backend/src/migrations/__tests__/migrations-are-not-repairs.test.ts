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
 * ⚠ The repairs themselves, and the workflow that runs them, moved to
 * overthelex/lawrider-uk on 2026-09-22 along with the rest of the UK pipeline.
 * The assertions about that directory moved with them. What stays here is the
 * half that guards THIS repository: a migration must not repair a corpus.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..');

// ⚠ 220, and the exact number matters. The last existing migration is 219, so
// this is the first slot a new one can take. It was 222 once, which made the
// test pass over an empty set — and left open precisely the two slots the
// incident had used. A threshold above the highest migration is not a lax
// guard, it is no guard.
//
// Everything at or below this number predates the rule. They are not being
// rewritten — several are seed data that new deployments genuinely need, and
// the rest have long since run everywhere. The line is drawn, not backdated.
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
});
