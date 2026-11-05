jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import { pageArticleText } from '../legislation-tools';

// LEXAI-2151: ПК ст. 14 (~190K) was cut at 60K with no way to read the rest.
describe('pageArticleText', () => {
  const text = 'a'.repeat(150_000);

  it('returns a short article whole, with no paging fields', () => {
    expect(pageArticleText('коротко', undefined)).toEqual({ full_text: 'коротко' });
  });

  it('pages a long article and points at the next page', () => {
    const p1 = pageArticleText(text, undefined) as any;
    expect(p1.full_text).toHaveLength(60_000);
    expect(p1.truncated).toBe(true);
    expect(p1.next_offset).toBe(60_000);
    const p3 = pageArticleText(text, 120_000) as any;
    expect(p3.full_text).toHaveLength(30_000);
    expect(p3.text_offset).toBe(120_000);
    expect(p3.truncated).toBe(false);
    expect(p3.next_offset).toBeUndefined();
  });

  it('clamps a bad or oversized offset', () => {
    expect((pageArticleText(text, -5) as any).full_text).toHaveLength(60_000);
    expect((pageArticleText(text, 'x') as any).text_offset).toBe(0);
    expect((pageArticleText(text, 999_999) as any).full_text).toBe('');
  });
});
