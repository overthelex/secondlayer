// The 27 practice areas an adwokat may declare on rejestradwokatow.pl ("Preferowana
// praktyka"), used as the canonical Polish taxonomy. szukajradcy.pl tags are mapped
// onto the same codes where the meaning is the same; the rest stay raw.

export interface PlPractice {
  code: string;
  pl: string;
  en: string;
}

export const PL_PRACTICES: readonly PlPractice[] = [
  { code: 'general', pl: 'Praktyka ogólna', en: 'General practice' },
  { code: 'administrative', pl: 'Prawo i postępowanie administracyjne', en: 'Administrative law and procedure' },
  { code: 'arbitration', pl: 'Postępowanie arbitrażowe', en: 'Arbitration' },
  { code: 'mediation', pl: 'Postępowanie mediacyjne', en: 'Mediation' },
  { code: 'civil', pl: 'Prawo i postępowanie cywilne', en: 'Civil law and procedure' },
  { code: 'human_rights', pl: 'Prawa człowieka i prawa obywatelskie', en: 'Human and civil rights' },
  { code: 'construction', pl: 'Prawo budowlane i zagospodarowania przestrzennego', en: 'Construction and planning law' },
  { code: 'eu', pl: 'Prawo europejskie', en: 'European law' },
  { code: 'commercial', pl: 'Prawo gospodarcze', en: 'Commercial law' },
  { code: 'companies', pl: 'Prawo spółek', en: 'Company law' },
  { code: 'criminal', pl: 'Prawo i postępowanie karne', en: 'Criminal law and procedure' },
  { code: 'medical', pl: 'Prawo medyczne i farmaceutyczne', en: 'Medical and pharmaceutical law' },
  { code: 'real_estate', pl: 'Prawo obrotu nieruchomościami', en: 'Real estate law' },
  { code: 'consumer', pl: 'Prawo ochrony konsumentów', en: 'Consumer protection' },
  { code: 'environment', pl: 'Prawo ochrony środowiska', en: 'Environmental law' },
  { code: 'banking', pl: 'Prawo bankowe i papierów wartościowych', en: 'Banking and securities law' },
  { code: 'tax', pl: 'Prawo podatkowe i finansowe', en: 'Tax and finance law' },
  { code: 'labour', pl: 'Prawo pracy', en: 'Labour law' },
  { code: 'press', pl: 'Prawo prasowe', en: 'Press law' },
  { code: 'family', pl: 'Prawo rodzinne i opiekuńcze', en: 'Family law' },
  { code: 'damages', pl: 'Prawo odszkodowawcze', en: 'Damages and compensation' },
  { code: 'inheritance', pl: 'Prawo spadkowe', en: 'Inheritance law' },
  { code: 'transport', pl: 'Prawo transportowe', en: 'Transport law' },
  { code: 'social_security', pl: 'Prawo ubezpieczeń społecznych', en: 'Social security law' },
  { code: 'restructuring', pl: 'Prawo restrukturyzacyjne', en: 'Restructuring and insolvency' },
  { code: 'ip', pl: 'Prawo własności intelektualnej i znaków towarowych', en: 'Intellectual property and trademarks' },
  { code: 'public_procurement', pl: 'Prawo zamówień publicznych', en: 'Public procurement' },
];

export const PL_PRACTICE_CODES: readonly string[] = PL_PRACTICES.map((p) => p.code);

const BY_CODE = new Map(PL_PRACTICES.map((p) => [p.code, p]));
const BY_PL_LABEL = new Map(PL_PRACTICES.map((p) => [p.pl.toLowerCase(), p.code]));

export function plPracticeLabel(code: string): string {
  return BY_CODE.get(code)?.en ?? code;
}

/** NRA label as printed on a profile → code; null when it is not one of the 27. */
export function nraLabelToCode(label: string): string | null {
  return BY_PL_LABEL.get(label.trim().toLowerCase()) ?? null;
}

/** szukajradcy.pl practice tags (lower-cased) → canonical code. */
export const PL_TAG_MAP: Record<string, string> = {
  'cywilne': 'civil',
  'pracy': 'labour',
  'rodzinne i opiekuńcze': 'family',
  'karne': 'criminal',
  'karne skarbowe': 'criminal',
  'wykroczenia': 'criminal',
  'administracyjne (w tym postępowanie)': 'administrative',
  'administracyjne': 'administrative',
  'zamówienia publiczne': 'public_procurement',
  'podatkowe': 'tax',
  'finansowe': 'tax',
  'nieruchomości': 'real_estate',
  'prawo spółek handlowych': 'companies',
  'spółki handlowe': 'companies',
  'działalność gospodarcza': 'commercial',
  'umowy gospodarcze (handlowe)': 'commercial',
  'gospodarcze': 'commercial',
  'konsumenckie': 'consumer',
  'własność intelektualna': 'ip',
  'własność intelektualna i przemysłowa': 'ip',
  'prawo autorskie': 'ip',
  'znaki towarowe': 'ip',
  'spadkowe': 'inheritance',
  'odszkodowania': 'damages',
  'odszkodowawcze': 'damages',
  'ubezpieczenia społeczne': 'social_security',
  'ubezpieczeń społecznych': 'social_security',
  'medyczne': 'medical',
  'farmaceutyczne': 'medical',
  'budowlane': 'construction',
  'budowlane i zagospodarowania przestrzennego': 'construction',
  'ochrony środowiska': 'environment',
  'ochrona środowiska': 'environment',
  'bankowe': 'banking',
  'bankowe i finansowe': 'banking',
  'papiery wartościowe': 'banking',
  'arbitraż i mediacje': 'arbitration',
  'arbitraż': 'arbitration',
  'mediacje': 'mediation',
  'transport i logistyka': 'transport',
  'transportowe': 'transport',
  'upadłościowe i restrukturyzacyjne': 'restructuring',
  'upadłościowe': 'restructuring',
  'restrukturyzacyjne': 'restructuring',
  'prasowe': 'press',
  'europejskie': 'eu',
  'unii europejskiej': 'eu',
  'prawa człowieka': 'human_rights',
  // chamber sites (oirp.krakow.pl, oirp.szczecin.pl) word the same areas slightly differently
  'spółek': 'companies',
  'umów': 'commercial',
  'ochrony konsumentów': 'consumer',
  'niewypłacalność i prawo upadłościowe': 'restructuring',
  'zatrudnienia': 'labour',
};

/** Exact tag first; then without a leading "prawo " and a trailing bracket ("prawo pracy (i zatrudnienia)" → "pracy"). */
export function mapPracticeTag(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  const exact = PL_TAG_MAP[t];
  if (exact) return exact;
  const bare = t.replace(/^prawo\s+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return PL_TAG_MAP[bare] ?? null;
}
