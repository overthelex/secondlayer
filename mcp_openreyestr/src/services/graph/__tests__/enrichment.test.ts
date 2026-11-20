import * as fs from 'fs';
import * as path from 'path';
import {
  countriesOf, enrichDdl, enrichIndexDdl, ENRICH_EDGE_KINDS, ENRICH_FLAGS, ENRICH_EDGE_LABELS, FLAG_LABELS, nazkRelation,
  sanctionEndpoints, STEPS, uaCodesFromIdentifiers,
} from '../enrichment';
import { foreignEntityKey, personKey } from '../keys';

const EDR_IDS = 'Відомості згідно з Єдиним державним реєстром юридичних осіб, фізичних осіб-підприємців та громадських формувань';

describe('graph enrichment helpers (LEXAI-2305)', () => {
  it('reads 8-digit ЄДРПОУ codes from РНБО identifiers, never a 10-digit tax number', () => {
    expect(uaCodesFromIdentifiers(`11111110 ${EDR_IDS}; 9990001112223 Відомості згідно з ЄДР РФ`)).toEqual(['11111110']);
    expect(uaCodesFromIdentifiers('22222220 Податковий номер Україна')).toEqual(['22222220']);
    expect(uaCodesFromIdentifiers('1234567890 Податковий номер Україна')).toEqual([]);
    expect(uaCodesFromIdentifiers('00000000 Податковий номер Україна')).toEqual([]);
    expect(uaCodesFromIdentifiers(null)).toEqual([]);
  });

  it('reads ISO country codes', () => {
    expect(countriesOf('Російська Федерація RU; Україна UA')).toEqual(['RU', 'UA']);
    expect(countriesOf('Республіка Білорусь BY')).toEqual(['BY']);
    expect(countriesOf('')).toEqual([]);
  });

  it('maps a sanctions record to graph endpoints', () => {
    expect(sanctionEndpoints({ schema_type: 'Person', name: 'Тестенко Тест Тестович', identifiers: '1234567890 Податковий номер Україна' }))
      .toEqual([{ kind: 'person_name', key: personKey('Тестенко Тест Тестович'), match: 'name' }]);
    expect(sanctionEndpoints({ schema_type: 'Organization', name: 'ТОВ "Тест"', identifiers: `11111110 ${EDR_IDS}`, countries: 'Україна UA' }))
      .toEqual([{ kind: 'company', key: '11111110', match: 'code' }]);
    const ru = sanctionEndpoints({ schema_type: 'Organization', name: 'Товариство з обмеженою відповідальністю "Ромашка"', countries: 'Російська Федерація RU; Україна UA' });
    expect(ru).toEqual([{ kind: 'foreign_entity', key: foreignEntityKey('RU', 'ТОВ «РОМАШКА»'), match: 'name' }]);
    expect(sanctionEndpoints({ schema_type: 'Vessel', name: 'TEST' })).toEqual([]);
    expect(sanctionEndpoints({ schema_type: 'Person', name: '' })).toEqual([]);
  });

  it('takes spouses and parents from НАЗК family members, never children or siblings', () => {
    expect(nazkRelation(' Дружина ')).toBe('дружина');
    expect(nazkRelation('батько')).toBe('батько');
    for (const r of ['син', 'дочка', 'рідний брат', 'рідна сестра', 'особи, які спільно проживають та не перебувають у шлюбі', null]) {
      expect(nazkRelation(r)).toBeNull();
    }
  });

  it('staged DDL is identical to migration 035', () => {
    const norm = (s: string) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
    const mig = norm(fs.readFileSync(path.join(__dirname, '../../../migrations/035_graph_enrichment.sql'), 'utf8'));
    const [flagDdl, edgeDdl] = enrichDdl('graph').map(norm);
    const [flagPk, edgePk] = enrichIndexDdl('graph').map(norm);
    const cols = (ddl: string) => ddl.replace(/^CREATE TABLE graph\.\w+ \(/, '').replace(/\)$/, '');
    expect(mig).toContain(`CREATE TABLE IF NOT EXISTS graph.node_flag (${cols(flagDdl)}, CONSTRAINT node_flag_pkey PRIMARY KEY (kind, key, flag, source));`);
    expect(mig).toContain(`CREATE TABLE IF NOT EXISTS graph.enrich_edge (${cols(edgeDdl)}, CONSTRAINT enrich_edge_pkey PRIMARY KEY (id));`);
    expect(flagPk).toContain('PRIMARY KEY (kind, key, flag, source)');
    expect(edgePk).toContain('PRIMARY KEY (id)');
    expect(mig).toContain('CREATE INDEX IF NOT EXISTS enrich_edge_src ON graph.enrich_edge (src_kind, src_key);');
    expect(mig).toContain('CREATE INDEX IF NOT EXISTS enrich_edge_dst ON graph.enrich_edge (dst_kind, dst_key);');
  });

  it('every flag / edge kind has a Ukrainian label; step names are unique', () => {
    for (const f of ENRICH_FLAGS) expect(FLAG_LABELS[f]).toMatch(/[а-яіїє]/i);
    for (const k of ENRICH_EDGE_KINDS) expect(ENRICH_EDGE_LABELS[k]).toMatch(/[а-яіїє]/i);
    expect(new Set(STEPS.map(s => s.name)).size).toBe(STEPS.length);
  });
});
