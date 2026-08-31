import { CourtDecisionTools } from '../tools/court-decision-tools';

/**
 * Regression for the 907/665/18 report (2026-08-13): get_case_documents_chain
 * returned the OLDEST 50 documents of a 322-document bankruptcy file, reported
 * that window size as `total_documents`, and computed the instance summary over
 * the window — so the chat produced a "звіт розгляду справи" that ended in
 * January 2019 and never mentioned the appeal or the cassation ruling.
 *
 * The window must stay capped (context budget), but it must be HONEST about the
 * case size, must show both ends of the case by default, and must be pageable.
 */

const JUDGMENT_FORMS = new Map<number, string>([
  [1, 'Вирок'],
  [2, 'Постанова'],
  [3, 'Рішення'],
  [4, 'Судовий наказ'],
  [5, 'Ухвала'],
  [6, 'Окрема ухвала'],
]);

interface FakeDoc {
  doc_id: number;
  adjudication_date: string;
  judgment_code: number;
  court_name: string;
  instance_code: number;
}

/** A case shaped like 907/665/18: a long tail of ухвали + a few substantive acts. */
function buildCase(): FakeDoc[] {
  const docs: FakeDoc[] = [];
  const firstInstance = { court_name: 'Господарський суд Закарпатської області', instance_code: 3 };
  const appeal = { court_name: 'Західний апеляційний господарський суд', instance_code: 2 };
  const cassation = { court_name: 'Касаційний господарський суд Верховного Суду', instance_code: 1 };

  // 200 procedural rulings, 2018-11 → 2024-06
  for (let i = 0; i < 200; i++) {
    const year = 2018 + Math.floor(i / 34);
    const month = (i % 12) + 1;
    docs.push({
      doc_id: 70_000_000 + i,
      adjudication_date: `${year}-${String(month).padStart(2, '0')}-10T00:00:00.000Z`,
      judgment_code: 5,
      ...firstInstance,
    });
  }
  // Appeal rulings + постанови, 2021
  for (let i = 0; i < 20; i++) {
    docs.push({
      doc_id: 95_000_000 + i,
      adjudication_date: `2021-${String((i % 12) + 1).padStart(2, '0')}-15T00:00:00.000Z`,
      judgment_code: i < 18 ? 5 : 2,
      ...appeal,
    });
  }
  // The outcome the old window never reached: cassation постанова + late acts
  docs.push({ doc_id: 126_085_723, adjudication_date: '2025-03-11T00:00:00.000Z', judgment_code: 2, ...cassation });
  docs.push({ doc_id: 136_199_626, adjudication_date: '2026-04-23T00:00:00.000Z', judgment_code: 2, ...firstInstance });
  docs.push({ doc_id: 138_361_401, adjudication_date: '2026-07-21T00:00:00.000Z', judgment_code: 5, ...firstInstance });

  return docs.sort((a, b) => a.adjudication_date.localeCompare(b.adjudication_date));
}

const CASE_DOCS = buildCase();

function makeDb(docs: FakeDoc[] = CASE_DOCS) {
  return {
    query: jest.fn(async (sql: string, params: any[]) => {
      // Case-number resolution (tool-utils): no rewrite for this spelling.
      if (sql.includes('edrsr_case_index')) {
        return { rows: [] };
      }

      if (sql.includes('edrsr_judgment_forms')) {
        const codes: number[] = params[0];
        return {
          rows: codes
            .filter(c => JUDGMENT_FORMS.has(c))
            .map(c => ({ judgment_code: c, name: JUDGMENT_FORMS.get(c) })),
        };
      }

      // Population stats: GROUP BY instance/court/judgment form over the whole case
      if (sql.includes('GROUP BY c.instance_code')) {
        const groups = new Map<string, any>();
        for (const d of docs) {
          const key = `${d.instance_code}|${d.court_name}|${d.judgment_code}`;
          const g = groups.get(key);
          if (!g) {
            groups.set(key, {
              instance_code: d.instance_code,
              court_name: d.court_name,
              judgment_code: d.judgment_code,
              n: 1,
              first_date: d.adjudication_date,
              last_date: d.adjudication_date,
            });
          } else {
            g.n++;
            if (d.adjudication_date < g.first_date) g.first_date = d.adjudication_date;
            if (d.adjudication_date > g.last_date) g.last_date = d.adjudication_date;
          }
        }
        return { rows: Array.from(groups.values()) };
      }

      // Document window: [variations, limit, offset, codes?]
      const [, limit, offset, codes] = params;
      let pool = docs;
      if (Array.isArray(codes)) pool = pool.filter(d => codes.includes(d.judgment_code));
      const ordered = sql.includes('adjudication_date DESC') ? [...pool].reverse() : pool;
      return {
        rows: ordered.slice(offset, offset + limit).map(d => ({
          doc_id: d.doc_id,
          cause_num: '907/665/18',
          judge: 'Тестовий суддя',
          judgment_code: d.judgment_code,
          adjudication_date: d.adjudication_date,
          court_name: d.court_name,
          instance_code: d.instance_code,
        })),
      };
    }),
  };
}

function buildTools(db: any) {
  return new CourtDecisionTools(
    {} as any, {} as any, {} as any, {} as any, {} as any, db, undefined, undefined
  );
}

async function callChain(db: any, args: any) {
  const tools = buildTools(db);
  const result = await tools.executeTool('get_case_documents_chain', { case_number: '907/665/18', ...args });
  return JSON.parse(result!.content[0].text);
}

describe('get_case_documents_chain — window honesty', () => {
  it('reports the size of the CASE, not the size of the window', async () => {
    const payload = await callChain(makeDb(), { max_docs: 50 });

    expect(payload.total_documents).toBe(CASE_DOCS.length); // 223, not 50
    expect(payload.returned_documents).toBe(50);
    expect(payload.has_more).toBe(true);
    expect(payload.coverage_warning).toContain('показано');
  });

  it('shows both ends of the case by default (balanced window)', async () => {
    const payload = await callChain(makeDb(), { max_docs: 50, group_by_instance: false });
    const ids = payload.documents.map((d: any) => Number(d.doc_id));

    expect(ids).toContain(CASE_DOCS[0].doc_id); // opening ruling
    expect(ids).toContain(138_361_401); // latest document — the old ASC window lost it
    expect(ids).toContain(126_085_723); // cassation постанова
  });

  it('summarises the whole case, not the returned window', async () => {
    const payload = await callChain(makeDb(), { max_docs: 10 });

    expect(payload.returned_documents).toBe(10);
    expect(payload.summary.scope).toBe('вся справа');
    expect(payload.summary.instances.first_instance).toBe(202);
    expect(payload.summary.instances.appeal).toBe(20);
    expect(payload.summary.instances.cassation).toBe(1);
    expect(payload.summary.document_types.rulings).toBe(4); // Постанови across all instances
    expect(payload.summary.date_range.from).toContain('2018');
    expect(payload.summary.date_range.to).toContain('2026');
  });

  it('pages through the case with offset + sort', async () => {
    const db = makeDb();
    const first = await callChain(db, { max_docs: 20, sort: 'asc', offset: 0, group_by_instance: false });
    const second = await callChain(db, { max_docs: 20, sort: 'asc', offset: 20, group_by_instance: false });

    const firstIds = first.documents.map((d: any) => Number(d.doc_id));
    const secondIds = second.documents.map((d: any) => Number(d.doc_id));

    expect(firstIds).toHaveLength(20);
    expect(secondIds).toHaveLength(20);
    expect(firstIds.filter((id: number) => secondIds.includes(id))).toHaveLength(0);
    expect(second.window.offset).toBe(20);
    expect(second.has_more).toBe(true);
  });

  it('sort=desc returns the end of the case', async () => {
    const payload = await callChain(makeDb(), { max_docs: 3, sort: 'desc', group_by_instance: false });
    const ids = payload.documents.map((d: any) => Number(d.doc_id));

    expect(ids[0]).toBe(138_361_401);
    expect(ids).toContain(136_199_626);
  });

  it('filters by document type so substantive acts fit the window', async () => {
    const payload = await callChain(makeDb(), {
      max_docs: 50,
      document_types: ['Рішення', 'Постанова'],
      group_by_instance: false,
    });

    expect(payload.window.document_types).toEqual(['Рішення', 'Постанова']);
    expect(payload.window.matching_documents).toBe(4);
    expect(payload.returned_documents).toBe(4);
    expect(payload.has_more).toBe(false);
    expect(payload.documents.every((d: any) => d.document_type === 'Постанова')).toBe(true);
    // The whole-case totals stay visible even under a narrow filter
    expect(payload.total_documents).toBe(CASE_DOCS.length);
  });

  it('accepts inflected type names from the model', async () => {
    const payload = await callChain(makeDb(), {
      max_docs: 50,
      document_types: ['постанови'],
      group_by_instance: false,
    });

    expect(payload.returned_documents).toBe(4);
  });

  it('explains itself when the requested type is absent from the case', async () => {
    const payload = await callChain(makeDb(), { document_types: ['Вирок'] });

    expect(payload.returned_documents).toBe(0);
    expect(payload.total_documents).toBe(CASE_DOCS.length);
    expect(payload.message).toContain('Наявні форми');
  });

  it('returns an empty result for an unknown case', async () => {
    const payload = await callChain(makeDb([]), {});

    expect(payload.total_documents).toBe(0);
    expect(payload.has_more).toBe(false);
  });
});
