/**
 * Detection of EDRSR full texts that are not the decision they claim to be.
 *
 * A 2026-08-13 audit of all 79.6M rows in `edrsr_fulltext` found two populations
 * that are stored, non-empty, `text_length`-consistent — and useless:
 *
 * 1. **The registry's overload page** (~3.8M rows, 4.77% of the corpus). Under load
 *    od.reyestr.court.gov.ua answers HTTP 200 with "Перегляд сторінки недоступний.
 *    Сервер перевантажений запитами", the harvester treats 200 as success, and the
 *    page goes through the RTF/latin1 path into the text column as double-mojibake
 *    ("Р„РґРёРЅРёР№ РґРµСЂР¶Р°РІРЅРёР№ СЂРµС”СЃС‚СЂ…"). Rate correlates with request
 *    rate: the 2026-04-19 run at ~1200 docs/s poisoned 36% of April, the 2026-08-13
 *    runs at ~100 docs/s 0.03%.
 * 2. **Registry HTML decoded as latin1** (~427K rows, concentrated in 2016-2018).
 *    Stored verbatim with every Cyrillic byte turned into À-ÿ, so the text contains
 *    no Cyrillic at all.
 *
 * Both carry valid case metadata from `edrsr_documents`, so a retrieval path that
 * loads text by doc_id hands the model an "official decision" with the right court,
 * judge and date, and garbage as its content. Neither is findable by Ukrainian
 * full-text search (their lexemes are mojibake), so they surface only on by-id
 * fetches — exactly the grounded-answer path.
 *
 * Until the rows are refetched, reads must refuse them rather than pass them on.
 *
 * The detector is deliberately anchored on CONTENT, not on length: 2,091 characters
 * looked like a reliable signature but on the 2026 partition 608 rows of that exact
 * length are real decisions, while 2,670 overload pages have other lengths.
 */

export type DamagedTextKind = 'registry_overload_page' | 'undecoded_html' | 'not_harvested';

/**
 * Double-mojibake of "Єдиний державний реєстр судових рішень" — the header of the
 * registry's own error/notice page. Verified against the corpus: 513,696 hits on the
 * 2026 partition, and zero rows anywhere hold a correctly decoded copy of the notice,
 * so the mojibake form is the only shape this page is stored in.
 */
const OVERLOAD_MOJIBAKE = 'Р„РґРёРЅРёР№ РґРµСЂР¶Р°РІРЅРёР№';

/**
 * The same notice as it would look if a future decoder got the encoding right. Nothing
 * in the corpus matches this today; it is here so that fixing the decoder cannot
 * silently turn a blocked page back into an accepted "decision".
 */
const OVERLOAD_DECODED = [
  'Сервер перевантажений запитами',
  'Перегляд сторінки недоступний',
];

/**
 * Anchored at the start on purpose. A stored HTML export always OPENS with the tag,
 * while a real decision can quote markup in its body — an IT dispute over a copied
 * page does exactly that, and an "appears in the first 400 characters" rule threw it
 * away as damaged.
 */
const HTML_OPENING = /^\s*<(!doctype\s+html|html\b|\?xml\b)/i;

const CYRILLIC = /[Ѐ-ӿ]/;

/**
 * Returns the kind of damage, or null when the text looks like a real decision.
 *
 * Cheap by construction: it reads a prefix for markup and scans for a fixed
 * substring, so it is safe to call on every row of a result set.
 */
export function detectDamagedCourtText(text: string | null | undefined): DamagedTextKind | null {
  if (!text) return null;

  if (text.includes(OVERLOAD_MOJIBAKE)) return 'registry_overload_page';
  for (const marker of OVERLOAD_DECODED) {
    if (text.includes(marker)) return 'registry_overload_page';
  }

  if (HTML_OPENING.test(text)) return 'undecoded_html';

  // Latin-1-decoded Cyrillic contains no Cyrillic at all. Short strings are exempt:
  // the corpus legitimately holds date-only and reference-only stubs that are faithful
  // to equally short source files.
  if (text.length >= 400 && !CYRILLIC.test(text)) return 'undecoded_html';

  return null;
}

/** Human-readable reason, in the product's language, for surfacing to the model. */
export const DAMAGED_TEXT_REASON: Record<DamagedTextKind, string> = {
  // A document whose text was never harvested used to be served as `sections: []` with
  // `full_text_length: 0` — indistinguishable from a decision that simply says little.
  // Silent incompleteness reads as completeness, which is the failure this quarantine
  // exists to prevent. Measured 2026-08-14: ~119K such documents for 2023-2026 whose
  // metadata carries no usable link, so no harvest run will fill them.
  not_harvested:
    'Текст цього документа ще не завантажено до бази — є лише метадані (суд, суддя, дата, номер справи). ' +
    'Зміст недоступний: не переказуй його, не цитуй і не роби висновків про те, що вирішив суд у цьому документі.',
  registry_overload_page:
    'Замість тексту рішення в базі збережено службову сторінку реєстру («Сервер перевантажений запитами»). ' +
    'Текст потребує повторного завантаження з ЄДРСР. Не переказуй вміст цього документа і не цитуй його.',
  undecoded_html:
    'Текст цього документа збережено з пошкодженою кодуванням (HTML/latin1) і не читається. ' +
    'Потребує повторного завантаження з ЄДРСР. Не переказуй вміст цього документа і не цитуй його.',
};

/**
 * Replace a damaged text with an explicit unavailability marker, or pass it through.
 * Callers spread the result into their payload so the shape is the same either way.
 */
export function guardCourtText(text: string | null | undefined): {
  ok: boolean;
  text?: string;
  text_unavailable?: { reason: string; kind: DamagedTextKind };
} {
  const kind = detectDamagedCourtText(text);
  if (!kind) return { ok: true, text: text ?? undefined };
  return { ok: false, text_unavailable: { reason: DAMAGED_TEXT_REASON[kind], kind } };
}
