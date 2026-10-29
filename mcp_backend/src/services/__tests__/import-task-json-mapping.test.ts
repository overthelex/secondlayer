import { getJsonPath, unresolvedMappingColumns } from '../import-task-service';

// Record shape of the ВРП data.gov.ua registers: the name header uses U+2019.
const vrpRecord = {
  '№': '136',
  'Прізвище, ім’я, по батькові судді': 'Арестова Людмила Валеріївна',
  'Назва суду': 'Донецький окружний адміністративний суд',
  'Номер рішення': '2397/3дп/15-24',
};

describe('json_array importer mapping (LEXAI-2117)', () => {
  it('resolves an exact key', () => {
    expect(getJsonPath(vrpRecord, 'Прізвище, ім’я, по батькові судді')).toBe('Арестова Людмила Валеріївна');
  });

  it('resolves a key spelt with a different apostrophe', () => {
    expect(getJsonPath(vrpRecord, "Прізвище, ім'я, по батькові судді")).toBe('Арестова Людмила Валеріївна');
    expect(getJsonPath(vrpRecord, 'Прізвище, імʼя, по батькові судді')).toBe('Арестова Людмила Валеріївна');
  });

  it('keeps dotted paths and missing keys working', () => {
    expect(getJsonPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(getJsonPath({ a: null }, 'a.b')).toBeNull();
    expect(getJsonPath({ a: 1 }, 'x')).toBeUndefined();
  });

  it('flags a mapped column that no record carries', () => {
    const mapping = {
      judge_name: 'Прізвище, ім’я, по батькові судді',
      court_name: 'Назва суду',
      applicant: 'Автор звернення',
    };
    expect(unresolvedMappingColumns([vrpRecord], mapping)).toEqual(['applicant']);
    expect(unresolvedMappingColumns([], mapping)).toEqual([]);
  });
});
