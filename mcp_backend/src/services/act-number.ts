/**
 * Act-number resolution: «Закон 2755-VI» / «№ 2262-ХІІ» / «254k/96-vr» -> an nreg.
 *
 * The corpus is keyed by the Rada registry id (2755-17), but courts, lawyers and
 * every citation use the OFFICIAL number (2755-VI). Migration 187 derived the
 * mapping into npa.act_number, and this is the read side of it.
 *
 * The lookup key is npa.norm_number(). Callers that already hold a DB handle
 * should let Postgres do the normalising — one definition, no drift, and it is
 * what makes the expression index on opendata_edrnpa_cards usable. The TS port
 * below exists for the two things SQL cannot serve: offline unit tests, and
 * validating a string before deciding whether a query is worth making.
 */

import type { IDatabase } from '../domain/ports/index.js';

/**
 * Cyrillic letters that occur in an nreg, plus х/ф for Roman numerals.
 * Everything else passes through untouched — see normalizeActNumber.
 */
const TRANSLIT_1TO1: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', з: 'z', и: 'y',
  і: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x',
};

/** Digraphs first, so the 1:1 table never has to emit an ambiguous letter. */
const TRANSLIT_DIGRAPH: Array<[RegExp, string]> = [
  [/ж/g, 'zh'],
  [/ї/g, 'yi'],
  [/є/g, 'ye'],
];

/**
 * Port of npa.norm_number(text). Keep the two in step — the parity fixture
 * config/act-number-vectors.json is checked against BOTH this function and the
 * SQL one, so a change here that is not made there fails the build.
 *
 * Deliberately many-to-one: making «2262-XII» and «2262-ХІІ» meet is the whole
 * point. The property that matters is not injectivity in the abstract but that
 * no two DISTINCT STORED aliases collide, which the backfill's gate 5 measures.
 *
 * Steps, in this order:
 *   1. strip № BEFORE normalising — NFKC rewrites it to the letters "No".
 *   2. NFKC, then drop all whitespace including NBSP.
 *   3. case-fold.
 *   4. transliterate Cyrillic to Latin, digraphs first. This is NOT a visual
 *      homoglyph fold: visual folding sends both п (постанова) and р
 *      (розпорядження) to "p" and would merge 154-2022-п with 154-2022-р, two
 *      different acts. Visual variants are stored as their own alias rows.
 *   5. strip leading zeros only from an all-digit token, so «007» finds «7».
 *      Applying it wider would collide n0001001-01 with n1001-01 across 47 997
 *      ministry acts.
 */
export function normalizeActNumber(raw: string): string {
  if (raw === null || raw === undefined) return '';
  let v = String(raw).replace(/№/g, '');
  v = v.normalize('NFKC').replace(/\s/g, '');
  v = v.toLowerCase();
  for (const [re, to] of TRANSLIT_DIGRAPH) v = v.replace(re, to);
  v = v.replace(/[а-яіїєґ]/g, (ch) => TRANSLIT_1TO1[ch] ?? ch);
  if (/^[0-9]+$/.test(v)) {
    const stripped = v.replace(/^0+/, '');
    return stripped === '' ? '0' : stripped;
  }
  return v;
}

/** One row of npa.act_number, ranked. */
export interface ActNumberMatch {
  nreg: string;
  kind: string;
  aliasRaw: string;
  confidence: number;
}

/**
 * Rank order. An exact registry id beats an official number, which beats the
 * second Roman form, which beats an abbreviation, which beats a bare core.
 * core_only is last and carries confidence 1/n on purpose: of 5 745 law-shaped
 * cores only 855 are unique and 1 016 recur across six convocations, so a bare
 * «2262» is genuinely ambiguous and must not be silently collapsed to one act.
 */
const KIND_RANK = `CASE an.kind
    WHEN 'nreg' THEN 0
    WHEN 'official' THEN 1
    WHEN 'official_alt' THEN 2
    WHEN 'official_legacy' THEN 3
    WHEN 'abbrev' THEN 4
    WHEN 'homoglyph' THEN 5
    WHEN 'reg_mojust' THEN 6
    WHEN 'treaty' THEN 6
    ELSE 9 END`;

/**
 * Resolve a number-ish string to candidate acts, best first.
 *
 * Returns a LIST, never a single act: «8073-X» is КУпАП, which Rada split
 * across three registry ids, and the УРСР convocations V–IX render to the same
 * Roman string as the independent-Ukraine ones (70 measured collisions), so
 * «117-VIII» is genuinely two acts. Callers decide whether the top candidate is
 * safe to take — see pickActNumber.
 */
export async function resolveActNumber(
  db: IDatabase,
  input: string,
  opts: { minConfidence?: number; limit?: number } = {}
): Promise<ActNumberMatch[]> {
  const raw = String(input ?? '').trim();
  if (!raw) return [];
  const minConfidence = opts.minConfidence ?? 0;
  const limit = opts.limit ?? 10;

  // The LIMIT has to sit OUTSIDE the DISTINCT ON. DISTINCT ON forces ORDER BY
  // to lead with nreg, so applying LIMIT there would truncate the candidate set
  // lexicographically by registry id — dropping the best match before it was
  // ever ranked. The inner query dedupes per act, the outer one ranks and cuts.
  const res = await db.query(
    `SELECT d.nreg, d.kind, d.alias_raw, d.confidence
       FROM (
         SELECT DISTINCT ON (an.nreg)
                an.nreg, an.kind, an.alias_raw, an.confidence, ${KIND_RANK} AS rk
           FROM npa.act_number an
          WHERE an.alias_norm = npa.norm_number($1)
            AND an.confidence >= $2
          ORDER BY an.nreg, ${KIND_RANK}, an.confidence DESC
       ) d
      ORDER BY d.rk, d.confidence DESC, d.nreg
      LIMIT $3`,
    [raw, minConfidence, limit]
  );

  return (res.rows as Array<Record<string, unknown>>)
    .map((r) => ({
      nreg: String(r.nreg),
      kind: String(r.kind),
      aliasRaw: String(r.alias_raw),
      confidence: Number(r.confidence),
    }))
    .sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || b.confidence - a.confidence);
}

function rankOf(kind: string): number {
  switch (kind) {
    case 'nreg': return 0;
    case 'official': return 1;
    case 'official_alt': return 2;
    case 'official_legacy': return 3;
    case 'abbrev': return 4;
    case 'homoglyph': return 5;
    case 'reg_mojust':
    case 'treaty': return 6;
    default: return 9;
  }
}

/**
 * Take the single best candidate, but only when it is actually unambiguous.
 *
 * Requires a MARGIN rather than just a top rank: where two acts answer to the
 * same number, picking the first would attribute law to the wrong act, and the
 * caller is better served by being told it is ambiguous. Returns null and the
 * full list so the caller can surface the choice.
 */
export function pickActNumber(matches: ActNumberMatch[]): { nreg: string | null; ambiguous: ActNumberMatch[] } {
  if (matches.length === 0) return { nreg: null, ambiguous: [] };
  if (matches.length === 1) return { nreg: matches[0].nreg, ambiguous: [] };

  const [first, second] = matches;
  const strongerKind = rankOf(first.kind) < rankOf(second.kind);
  const strongerConfidence = first.confidence >= second.confidence * 2;
  if (strongerKind || strongerConfidence) return { nreg: first.nreg, ambiguous: [] };
  return { nreg: null, ambiguous: matches };
}

/**
 * Does this string look like an OFFICIAL act number rather than a registry id?
 *
 * A registry id never ends in a Roman numeral — the corpus shapes are
 * {n}-{cc}, {n}/{yy}-вр, {n}-{yyyy}-п, z####-##, {n}_{n}, n#######-##. An
 * official number does exactly that: 2755-VI, 2262-ХІІ, 8073-X.
 *
 * Pure string test, no query. It exists so callers can resolve the alias BEFORE
 * ensureLegislationExists, which fetches from zakon.rada on a miss — passing it
 * «2755-VI» buys a guaranteed 404 over the network before the fallback ever runs.
 */
export function looksLikeOfficialNumber(raw: string): boolean {
  const v = normalizeActNumber(raw);
  return /^[0-9]{1,5}[a-z]?-[ivxlcdm]+$/.test(v);
}

/**
 * Normalise a caller-supplied article reference to the form npa.article.art_no
 * is stored in: «стаття 111-1», «ст.111 - 1», «111–1» all become «111-1».
 *
 * Lives here rather than inline in npa-tools so the regression test exercises
 * the REAL function. A test that re-implements the expression it is guarding
 * passes no matter what the shipped code does.
 *
 * The alternation is LONGEST-FIRST and must stay that way. With
 * (ст|стаття|…) the engine matches «ст», the optional dot and spaces match
 * empty, and it never backtracks to the longer branch — «стаття 111» came out
 * as «аття111» and matched no article at all.
 */
/**
 * Article-number sub-pattern, as it appears in a heading — «350», «350-1»,
 * «350 - 1», «350–1». Rada surrounds the index hyphen with spaces and sometimes
 * writes it as an en/em dash: the stored ЦПК heading is «Стаття 350 - 1 .».
 *
 * Anything that reads an article number out of a heading builds its regex from
 * this, so there is one definition to keep right. The historical-editions
 * importer used a pattern that allowed neither spaces nor the dash variants, so
 * it captured «350», collided with the real article 350 and lost the row to
 * ON CONFLICT DO NOTHING — 1 018 in-force indexed articles had no row at all
 * (LEXAI-1957). Pair it with normalizeArticleNumber to get the stored form.
 */
export const ARTICLE_NUMBER_PATTERN = String.raw`\d+(?:\s*[-–—]\s*\d+)?`;

export function normalizeArticleNumber(raw: string): string {
  return String(raw ?? '')
    .replace(/^\s*(стаття|статті|статтею|ст|пункт|пп|п)\.?\s*/i, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, '')
    .trim();
}
