/**
 * Rada dictionary codes for the full НПА corpus (schema `npa`).
 *
 * `npa.act.status_code` and `npa.act.types_raw` hold raw Rada dictionary ids. The
 * dictionaries themselves (stan.txt / typ.txt) were loaded into the separate `rada_npa`
 * working database during the harvest, so they are NOT joinable from `secondlayer_prod`
 * — hence the hardcoded maps here.
 *
 * types_raw is a pipe-separated MULTI-value field ("2|125"): an act can carry several
 * type ids at once, so match it as a list, never with equality.
 */

export const NPA_STATUS: Record<number, string> = {
  0: 'Не визначено',
  1: 'Втратив чинність',
  2: 'Набирає чинності',
  3: 'Дію зупинено',
  4: 'Дію відновлено',
  5: 'Чинний',
  6: 'Не набрав чинності',
  7: 'Не застосовується на території України',
  8: 'Частково набрав чинності',
  9: 'Втратив чинність крім окремих положень',
};

/** Status codes that mean "no longer in force" — filtered out unless explicitly asked for. */
export const NPA_REPEALED_CODES = [1, 9];

/** Accepted values of the `status` tool argument → status_code. */
export const NPA_STATUS_ARG: Record<string, number> = {
  'чинний': 5,
  'втратив чинність': 1,
  'набирає чинності': 2,
  'не набрав чинності': 6,
};

export const NPA_DOC_TYPE: Record<number, string> = {
  1: 'Закон',
  2: 'Постанова',
  3: 'Указ',
  6: 'Розпорядження',
  // Декрети КМУ of 1992-93, the acts whose nreg ends -92/-93 (83 of them).
  // Missing here meant they rendered with no document type at all.
  8: 'Декрет',
  9: 'Наказ',
  11: 'Положення',
  12: "Роз'яснення",
  15: 'Лист',
  17: 'Угода',
  18: 'Протокол',
  20: 'Конвенція',
  21: 'Кодекс України',
  22: 'Рішення',
  30: 'Ухвала',
  32: 'Регламент',
  44: 'Рекомендації',
  52: 'Резолюція',
  95: 'Повідомлення',
  100: 'Конституція',
  124: 'Кодекс',
  130: 'Статус',
  216: 'Конституція України',
};

/** Label → doc-type id, for the `doc_type` tool argument (case-insensitive). */
const DOC_TYPE_BY_LABEL: Record<string, number> = Object.entries(NPA_DOC_TYPE).reduce(
  (acc, [id, label]) => { acc[label.toLowerCase()] = Number(id); return acc; },
  {} as Record<string, number>
);

export function docTypeIdFromLabel(label: string): number | null {
  const key = String(label || '').trim().toLowerCase();
  if (!key) return null;
  if (DOC_TYPE_BY_LABEL[key] !== undefined) return DOC_TYPE_BY_LABEL[key];
  // "кодекс" should also find "Кодекс України"; take the shortest label that starts with it.
  const hit = Object.keys(DOC_TYPE_BY_LABEL)
    .filter((l) => l.startsWith(key))
    .sort((a, b) => a.length - b.length)[0];
  return hit ? DOC_TYPE_BY_LABEL[hit] : null;
}

export function statusLabel(code: number | null | undefined): string {
  return code == null ? 'Не визначено' : (NPA_STATUS[code] ?? `Код ${code}`);
}

/** types_raw ("2|125") → readable labels ["Постанова", …]. Unknown ids are dropped. */
export function docTypeLabels(typesRaw: string | null | undefined): string[] {
  return String(typesRaw || '')
    .split('|')
    .map((t) => Number(t.trim()))
    .filter((n) => Number.isInteger(n) && NPA_DOC_TYPE[n] !== undefined)
    .map((n) => NPA_DOC_TYPE[n]);
}

/** zakon.rada.gov.ua permalink; a historical edition gets the /ed{YYYYMMDD} suffix. */
export function npaUrl(nreg: string, edDate?: string | null, isCurrent = true): string {
  const base = `https://zakon.rada.gov.ua/laws/show/${nreg}`;
  if (!edDate || isCurrent) return base;
  return `${base}/ed${edDate.replace(/-/g, '')}`;
}
