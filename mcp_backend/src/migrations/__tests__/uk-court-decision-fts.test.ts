/**
 * uk_search_judgments ranks over uk_court_decision_fts (migration 221), while
 * search_registry matches through idx_uk_court_fts (migration 155). If the two
 * disagree about what a judgment's search text is, the same query finds different
 * judgments depending on the tool. Hold them together here.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..');
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

/** The ordered column list and config of a to_tsvector over COALESCE(col, '') parts. */
function shape(sql: string) {
  return {
    config: /to_tsvector\(\s*'(\w+)'/.exec(sql)?.[1],
    columns: [...sql.matchAll(/COALESCE\(\s*(?:NEW\.|d\.)?(\w+)\s*,\s*''\s*\)/gi)].map((m) => m[1]),
  };
}

describe('UK judgment search text', () => {
  it('migration 221 defines the same text as idx_uk_court_fts', () => {
    const idx = /CREATE INDEX idx_uk_court_fts[\s\S]*?;/.exec(read('155_uk_ie_court_decisions.sql'))![0];
    const fn = /FUNCTION uk_court_decision_tsv[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(read('221_uk_court_decision_fts.sql'))![1];
    expect(shape(fn)).toEqual(shape(idx));
    expect(shape(fn).columns).toEqual(['parties', 'abstract', 'full_text']);
  });

  it('the trigger and the backfill both go through that one function', () => {
    const trigger = /FUNCTION uk_court_decision_fts_sync[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(read('221_uk_court_decision_fts.sql'))![1];
    expect(trigger).toMatch(/uk_court_decision_tsv\(NEW\.parties, NEW\.abstract, NEW\.full_text\)/);
    expect(trigger).not.toMatch(/to_tsvector/);
    const backfill = readFileSync(join(MIGRATIONS, '../../scripts/uk-judgment-fts-backfill.sql'), 'utf8');
    expect(backfill).toMatch(/uk_court_decision_tsv\(d\.parties, d\.abstract, d\.full_text\)/);
    expect(backfill).not.toMatch(/to_tsvector/);
  });
});
