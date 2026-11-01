/** Cyrillic letters that look like Latin ones and are stored in Latin in the MVS registry. */
const CYR_TO_LAT: Record<string, string> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
  'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'І': 'I',
};

/**
 * Normalise a passport series to the registry's storage form: upper case, no spaces,
 * dots or dashes, Cyrillic look-alikes mapped to Latin. "нм" -> "HM", "СЮ" -> "CЮ"
 * (Ю has no Latin twin and is stored as Cyrillic).
 *
 * Used both by search_invalid_passports (query side) and by the invalid-passport importer
 * (storage side), so the two can never drift apart.
 */
export function normalizePassportSeries(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-.]/g, '')
    .replace(/[АВЕКМНОРСТХІ]/g, (ch) => CYR_TO_LAT[ch] ?? ch);
}
