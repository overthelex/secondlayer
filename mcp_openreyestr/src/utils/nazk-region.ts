/**
 * NAZK declarations carry the region either as text or as a dictionary code such as
 * "1.2.80" (the last segment is the КОАТУУ region prefix: 80 = м. Київ). The code
 * reached callers verbatim, e.g. the President's 2020 declaration showed
 * declarant_region "1.2.80" (LEXAI-2196).
 */
export const KOATUU_REGIONS: Record<string, string> = {
  '01': 'Автономна Республіка Крим', '05': 'Вінницька', '07': 'Волинська', '12': 'Дніпропетровська',
  '14': 'Донецька', '18': 'Житомирська', '21': 'Закарпатська', '23': 'Запорізька',
  '26': 'Івано-Франківська', '32': 'Київська', '35': 'Кіровоградська', '44': 'Луганська',
  '46': 'Львівська', '48': 'Миколаївська', '51': 'Одеська', '53': 'Полтавська', '56': 'Рівненська',
  '59': 'Сумська', '61': 'Тернопільська', '63': 'Харківська', '65': 'Херсонська',
  '68': 'Хмельницька', '71': 'Черкаська', '73': 'Чернівецька', '74': 'Чернігівська',
  '80': 'м. Київ', '85': 'м. Севастополь',
};

export function normalizeNazkRegion(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^\d+(?:\.\d+)*$/.exec(s);
  if (!m) return s;
  const last = s.split('.').pop()!.padStart(2, '0');
  return KOATUU_REGIONS[last] ?? null;
}

/** Codes whose region name contains `query` (for the declarant_region filter). */
export function nazkRegionCodesMatching(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return Object.entries(KOATUU_REGIONS)
    .filter(([, name]) => name.toLowerCase().includes(q))
    .map(([code]) => code);
}
