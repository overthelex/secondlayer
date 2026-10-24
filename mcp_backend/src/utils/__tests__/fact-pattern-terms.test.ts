import {
  parseTermsFromLlmContent,
  extractKeywordsDeterministic,
  extractFactPatternTerms,
  termsToStems,
  countTermHits,
} from '../fact-pattern-terms';

const FACTS =
  'Працівника звільнили за прогул, хоча він у цей день перебував на лікарняному; ' +
  'лікарняний підтверджено листком непрацездатності';

describe('parseTermsFromLlmContent (LEXAI-2101)', () => {
  it('reads {"keywords": [...]} — the shape gpt-5.4-mini returned on local', () => {
    const raw = '{"keywords":["звільнення за прогул","листок непрацездатності","лікарняний"]}';
    expect(parseTermsFromLlmContent(raw)).toEqual(['звільнення за прогул', 'листок непрацездатності', 'лікарняний']);
  });

  it('accepts other key names, bare arrays, code fences and prose around JSON', () => {
    expect(parseTermsFromLlmContent('{"terms":["прогул"]}')).toEqual(['прогул']);
    expect(parseTermsFromLlmContent('["прогул","лікарняний"]')).toEqual(['прогул', 'лікарняний']);
    expect(parseTermsFromLlmContent('```json\n{"search_terms":["прогул"]}\n```')).toEqual(['прогул']);
    expect(parseTermsFromLlmContent('Ось терміни: {"keywords":[{"term":"прогул"}]} — готово')).toEqual(['прогул']);
  });

  it('returns [] for empty, non-JSON or termless content and dedupes case-insensitively', () => {
    expect(parseTermsFromLlmContent('')).toEqual([]);
    expect(parseTermsFromLlmContent(null)).toEqual([]);
    expect(parseTermsFromLlmContent('немає')).toEqual([]);
    expect(parseTermsFromLlmContent('{"keywords":[]}')).toEqual([]);
    expect(parseTermsFromLlmContent('{"keywords":["Прогул","прогул"]}')).toEqual(['Прогул']);
  });
});

describe('extractKeywordsDeterministic', () => {
  it('keeps content words, drops stop words and repeated stems', () => {
    const kw = extractKeywordsDeterministic(FACTS);
    expect(kw).toEqual(expect.arrayContaining(['працівника', 'звільнили', 'прогул', 'лікарняному', 'листком', 'непрацездатності']));
    expect(kw).not.toContain('хоча');
    expect(kw).not.toContain('день');
    // «лікарняному» and «лікарняний» share a prefix — counted once.
    expect(kw.filter(w => w.startsWith('лікарн'))).toHaveLength(1);
    expect(kw.length).toBeLessThanOrEqual(8);
  });
});

describe('termsToStems / countTermHits', () => {
  it('strips endings from long words, keeps short ones whole, can keep words unstemmed', () => {
    expect(termsToStems(['звільнення за прогул', 'листок непрацездатності'])).toEqual(['звільнен', 'прогул', 'листок', 'непрацездатнос']);
    expect(termsToStems(['звільнення за прогул', 'листок непрацездатності'], 4, false)).toEqual(['звільнення', 'прогул', 'листок', 'непрацездатності']);
  });

  it('counts a term only when every stem of it is present', () => {
    const text = 'Звільнено за прогул; позивач надав листок непрацездатності.';
    expect(countTermHits(text, ['звільнення за прогул', 'листок непрацездатності', 'переведення на іншу роботу'])).toBe(2);
  });
});

describe('extractFactPatternTerms', () => {
  it('uses the LLM terms when the call succeeds', async () => {
    const llm: any = { chatCompletion: jest.fn().mockResolvedValue({ content: '{"keywords":["звільнення за прогул","листок непрацездатності"]}' }) };
    const r = await extractFactPatternTerms(FACTS, llm);
    expect(r).toEqual({ terms: ['звільнення за прогул', 'листок непрацездатності'], source: 'llm' });
    const req = llm.chatCompletion.mock.calls[0][0];
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(req.max_tokens).toBeUndefined();
    expect(llm.chatCompletion.mock.calls[0][1]).toBe('quick');
  });

  it('falls back to deterministic keywords on empty content, errors and timeouts', async () => {
    const empty: any = { chatCompletion: jest.fn().mockResolvedValue({ content: '' }) };
    const failing: any = { chatCompletion: jest.fn().mockRejectedValue(new Error('429')) };
    const hanging: any = { chatCompletion: jest.fn().mockReturnValue(new Promise(() => {})) };
    for (const llm of [empty, failing, hanging, undefined]) {
      const r = await extractFactPatternTerms(FACTS, llm, 50);
      expect(r.source).toBe('keyword_fallback');
      expect(r.terms).toContain('прогул');
    }
  });
});
