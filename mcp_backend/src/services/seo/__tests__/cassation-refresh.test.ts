import { mergeRanked, cassationCap, type RankedDecision } from '../cassation-refresh.js';
import { citedByText } from '../cassation-render.js';

const r = (doc_id: string, cause_num: string, cited_by: number, text_length: number, adj_date = '2024-01-01'): RankedDecision =>
  ({ doc_id, cause_num, court_code: 9931, adj_date, judge: null, category_code: null, ft_year: 2024, text_length, cited_by });

describe('mergeRanked', () => {
  it('keeps one decision per case, the longest text, most cited first', () => {
    const out = mergeRanked([r('1', 'a/1/20', 10, 4000), r('2', 'a/1/20', 10, 90000), r('3', 'b/2/21', 50, 5000)]);
    expect(out.map(x => x.doc_id)).toEqual(['3', '2']);
  });

  it('breaks ties by the newer date', () => {
    const out = mergeRanked([r('1', 'a', 5, 4000, '2020-01-01'), r('2', 'b', 5, 4000, '2023-01-01')]);
    expect(out.map(x => x.doc_id)).toEqual(['2', '1']);
  });
});

describe('cassationCap', () => {
  it('defaults to 5000 and accepts a non-negative integer', () => {
    expect(cassationCap({})).toBe(5000);
    expect(cassationCap({ SEO_CASSATION_CAP: '200' })).toBe(200);
    expect(cassationCap({ SEO_CASSATION_CAP: 'x' })).toBe(5000);
  });
});

describe('citedByText', () => {
  it('uses Ukrainian plural forms', () => {
    expect(citedByText(1)).toBe('посилається 1 рішення');
    expect(citedByText(3)).toBe('посилаються 3 рішення');
    expect(citedByText(11)).toBe('посилаються 11 рішень');
    expect(citedByText(25)).toBe('посилаються 25 рішень');
  });
});
