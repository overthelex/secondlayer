/**
 * Migration sets — the manifest that lets a deployment carry one jurisdiction's
 * schema instead of everyone's.
 *
 * The thing being protected: `sets/uk.txt` is what a lawrider.uk database is
 * made of. It was arrived at by applying migrations one at a time to an empty
 * database and diffing pg_tables, then pruning the other jurisdictions' corpora
 * by hand — 54 tables of Ukrainian, Spanish, Swiss, EU, ICIJ, Baltic, Nordic
 * and Western European material that arrived through neutrally-named files.
 *
 * None of that survives if the file drifts from the migrations on disk, so this
 * asserts the two agree. The expensive checks — does it bootstrap, does the app
 * boot against it — were run on a real database on 2026-09-19 and are recorded
 * in the file's own header; they are not repeatable in a unit test.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..');
const SETS = join(MIGRATIONS, 'sets');

function parseSet(name: string): string[] {
  return readFileSync(join(SETS, `${name}.txt`), 'utf-8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

describe('migration sets', () => {
  it('lists only migrations that exist', () => {
    // The runner does catch this — migrate.ts collects unmatched exact patterns
    // and exits 1 naming them. So the cost of a typo is not a silent gap; it is
    // a deployment that dies at boot, after the image is built and on the box.
    // This moves that failure to the pull request.
    const missing = parseSet('uk').filter((f) => !existsSync(join(MIGRATIONS, f)));
    expect(missing).toEqual([]);
  });

  it('is ordered the way the runner will apply it', () => {
    // The runner sorts filenames; if the file disagrees with that order someone
    // reading it will reason about the wrong sequence. 000_extensions.sql has to
    // come first — 195_uk_legislation.sql builds a gin_trgm_ops index and fails
    // on an empty database without pg_trgm.
    const set = parseSet('uk');
    expect(set).toEqual([...set].sort());
    expect(set[0]).toBe('000_extensions.sql');
  });

  it('carries the UK schema', () => {
    const set = parseSet('uk');
    for (const required of [
      '195_uk_legislation.sql',        // register + the trigram title index
      '155_uk_ie_court_decisions.sql', // uk_court_decisions lives here
      '205_uk_judgment_access.sql',    // the Find Case Law licence gate
      '217_uk_point_in_time.sql',      // intervals + uk_act_as_at
      '219_uk_provision_embedding.sql',
    ]) {
      expect(set).toContain(required);
    }
  });

  it('carries no other jurisdiction corpus', () => {
    // Named individually rather than pattern-matched: each of these was removed
    // on evidence of the tables it creates, and each deserves to fail loudly if
    // it comes back. 129 looks like infrastructure and carries Swiss registers;
    // 102 looks generic and carries Ukrainian patents.
    const set = parseSet('uk');
    for (const foreign of [
      '011_add_legislation_tables.sql',      // Ukrainian legislation
      '044_add_court_registry_scrape_tables.sql',
      '067_erau_lawyers_cache.sql',          // Ukrainian bar register
      '102_ip_and_securities_tables.sql',
      '128_eu_common_legal_data.sql',
      '129_offshore_jurisdictions_data.sql', // ICIJ + Swiss registers
      '137_es_boe_sumarios.sql',
      '153_baltic_court_decisions.sql',
      '126_spain_legal_data.sql',            // the one that cannot bootstrap
      // Both shipped in the first version of this set and were caught in
      // review. They apply cleanly to an empty database, which is why an
      // automated pass kept them — it was asking whether a migration works,
      // not whether it belongs on a British box.
      '152_hu_court_decisions.sql',          // hu_court_decisions
      '159_singapore_court_decisions.sql',   // sg_court_decisions
    ]) {
      expect(set).not.toContain(foreign);
    }
  });

  it('creates no court-decision table for a country other than the UK and Ireland', () => {
    // The list above names files; this asks the question directly, so the next
    // foreign corpus to arrive under a neutral filename fails here without
    // anyone having to think of it. Ireland is the documented exception: it
    // shares a migration with uk_court_decisions and stays empty.
    const offenders: string[] = [];
    for (const f of parseSet('uk')) {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf-8');
      for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z]{2})_court_decisions/gi)) {
        if (!['uk', 'ie'].includes(m[1].toLowerCase())) offenders.push(`${f} -> ${m[1]}_court_decisions`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the two migrations an automated prune would have taken', () => {
    // 037 was flagged because its table is `active_timers` and a prefix rule read
    // `act` as the Ukrainian acts table; it is billing. 155 creates Irish
    // decisions alongside the British ones and is kept for the British ones.
    const set = parseSet('uk');
    expect(set).toContain('037_add_time_billing.sql');
    expect(set).toContain('155_uk_ie_court_decisions.sql');
  });

  it('every set names a file the repository still has', () => {
    // Guards the next set as much as this one — which it only does if it
    // actually checks existence. It used to assert the set was non-empty, which
    // is true of a set naming nothing but deleted migrations.
    for (const f of readdirSync(SETS).filter((f) => f.endsWith('.txt'))) {
      const name = f.replace(/\.txt$/, '');
      const set = parseSet(name);
      expect(set.length).toBeGreaterThan(0);
      const missing = set.filter((m) => !m.includes('*') && !existsSync(join(MIGRATIONS, m)));
      expect({ set: name, missing }).toEqual({ set: name, missing: [] });
    }
  });
});
