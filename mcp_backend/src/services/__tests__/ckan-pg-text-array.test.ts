jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import { VALUE_TRANSFORMS } from '../ckan-multifile-import';

// LEXAI-2126: ВРП decisions carry JSON lists for TEXT[] columns.
describe('VALUE_TRANSFORMS.pg_text_array', () => {
  const t = VALUE_TRANSFORMS.pg_text_array;
  it('builds a text[] literal', () => {
    expect(t(['1-2/2026', 'a.docx'])).toBe('{"1-2/2026","a.docx"}');
  });
  it('escapes quotes and backslashes, keeps empty and null', () => {
    expect(t(['ТОВ "Х"', 'a\\b', null])).toBe('{"ТОВ \\"Х\\"","a\\\\b",NULL}');
    expect(t([])).toBe('{}');
    expect(t(null)).toBeNull();
  });
  it('wraps a scalar', () => {
    expect(t('x')).toBe('{"x"}');
  });
});
