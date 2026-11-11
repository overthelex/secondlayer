/**
 * Article tables for the cases toolset: which articles a court document is checked
 * against (cases_find_violations) and which articles govern a complaint
 * (cases_complaint_norms). Pure data; every number was verified against the editions
 * in force on 10.11.2026. Texts are always read from legislation_articles, never from here.
 */

export type CaseCode = 'цпк' | 'гпк' | 'кас' | 'кпк' | 'купап';
export type DocKind = 'ухвала' | 'рішення' | 'постанова' | 'вирок' | 'протокол' | 'інше';
export type ComplaintKind =
  | 'апеляційна скарга на рішення'
  | 'апеляційна скарга на ухвалу'
  | 'касаційна скарга'
  | 'скарга на постанову у справі про адмінправопорушення'
  | 'заява про перегляд за нововиявленими обставинами';

export const CASE_CODES: CaseCode[] = ['цпк', 'гпк', 'кас', 'кпк', 'купап'];
export const DOC_KINDS: DocKind[] = ['ухвала', 'рішення', 'постанова', 'вирок', 'протокол', 'інше'];
export const COMPLAINT_KINDS: ComplaintKind[] = [
  'апеляційна скарга на рішення',
  'апеляційна скарга на ухвалу',
  'касаційна скарга',
  'скарга на постанову у справі про адмінправопорушення',
  'заява про перегляд за нововиявленими обставинами',
];

/** КУпАП is the in-force code 8073-10 (not the pre-2017 halves 80731-10 / 80732-10). */
export const CODE_RADA_ID: Record<CaseCode, string> = {
  'цпк': '1618-15',
  'гпк': '1798-12',
  'кас': '2747-15',
  'кпк': '4651-17',
  'купап': '8073-10',
};

export const CODE_TITLE: Record<CaseCode, string> = {
  'цпк': 'ЦПК України',
  'гпк': 'ГПК України',
  'кас': 'КАС України',
  'кпк': 'КПК України',
  'купап': 'КУпАП',
};

/** Закон «Про судовий збір»: ставки. Not charged for КПК and КУпАП complaints. */
export const COURT_FEE = { radaId: '3674-17', articles: ['4'] } as const;

const LATIN_ALIASES: Record<string, CaseCode> = {
  cpk: 'цпк', cpc: 'цпк',
  gpk: 'гпк', hpk: 'гпк',
  kas: 'кас',
  kpk: 'кпк',
  kupap: 'купап',
};

export function parseCode(s: unknown): CaseCode | null {
  if (typeof s !== 'string') return null;
  const key = s.trim().toLowerCase().replace(/\s+/g, '');
  if ((CASE_CODES as string[]).includes(key)) return key as CaseCode;
  return LATIN_ALIASES[key] ?? null;
}

const RULING_LIKE: Partial<Record<CaseCode, string[]>> = {
  'цпк': ['259', '263', '264', '265', '268', '272', '352', '353', '354'],
  'кас': ['242', '243', '244', '245', '246', '295'],
  'гпк': ['236', '237', '238', '254', '255', '256'],
};

const VIOLATION_CHECKS: Record<DocKind, Partial<Record<CaseCode, string[]>>> = {
  'ухвала': {
    'цпк': ['260', '272', '128', '187'],
    'кас': ['248', '251'],
    'гпк': ['234', '242'],
    'кпк': ['369', '372'],
  },
  'рішення': RULING_LIKE,
  'постанова': {
    'кас': RULING_LIKE['кас'],
    'гпк': RULING_LIKE['гпк'],
    'купап': ['268', '277', '278', '280', '283', '284', '285', '287', '289', '294'],
  },
  'вирок': {
    'кпк': ['110', '370', '371', '372', '373', '374'],
  },
  'протокол': {
    'купап': ['254', '256', '268', '277', '278', '280'],
  },
  'інше': {},
};

/** Articles to check a document of this kind against; [] when the code has no such document. */
export function violationArticles(docKind: DocKind, code: CaseCode): string[] {
  return [...(VIOLATION_CHECKS[docKind]?.[code] ?? [])];
}

const COMPLAINT_NORMS: Record<CaseCode, Partial<Record<ComplaintKind, string[]>>> = {
  'цпк': {
    'апеляційна скарга на рішення': ['352', '354', '355', '356', '357'],
    'апеляційна скарга на ухвалу': ['353', '354', '355', '356', '357'],
    'касаційна скарга': ['389', '390', '391', '392'],
    'заява про перегляд за нововиявленими обставинами': ['423', '424', '425', '426'],
  },
  'гпк': {
    'апеляційна скарга на рішення': ['254', '256', '257', '258', '259'],
    'апеляційна скарга на ухвалу': ['255', '256', '257', '258'],
    'касаційна скарга': ['287', '288', '289', '290'],
    'заява про перегляд за нововиявленими обставинами': ['320', '321', '322', '323'],
  },
  'кас': {
    'апеляційна скарга на рішення': ['293', '295', '296', '297'],
    'апеляційна скарга на ухвалу': ['294', '295', '296', '297'],
    'касаційна скарга': ['328', '329', '330', '331'],
    'заява про перегляд за нововиявленими обставинами': ['361', '363', '364', '365'],
  },
  'кпк': {
    'апеляційна скарга на рішення': ['392', '393', '395', '396'],
    'апеляційна скарга на ухвалу': ['392', '393', '395', '396'],
    'касаційна скарга': ['424', '425', '426', '427'],
    'заява про перегляд за нововиявленими обставинами': ['459', '461', '462'],
  },
  'купап': {
    'скарга на постанову у справі про адмінправопорушення': ['287', '288', '289', '291', '294', '295'],
  },
};

/** Complaint articles for the code and kind, and whether the court fee article applies; null when the code has no such complaint. */
export function complaintArticles(code: CaseCode, kind: ComplaintKind): { articles: string[]; fee: boolean } | null {
  const articles = COMPLAINT_NORMS[code]?.[kind];
  if (!articles) return null;
  return { articles: [...articles], fee: code !== 'кпк' && code !== 'купап' };
}
