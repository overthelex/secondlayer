import { detectDamagedCourtText, guardCourtText, DAMAGED_TEXT_REASON } from '../../services/edrsr-text-integrity';

/**
 * Samples are taken verbatim from prod (`edrsr_fulltext`), 2026-08-13 audit:
 *  - doc 134457167 (2026): the registry overload page stored as the decision
 *  - doc 57163010 (2016): registry HTML decoded as latin1
 *  - doc 81801275 (2019): a REAL 2,412-char ruling — the length that was almost used
 *    as a signature, which is exactly why the detector must key on content
 */
const OVERLOAD_PAGE =
  'Р„РґРёРЅРёР№ РґРµСЂР¶Р°РІРЅРёР№ СЂРµС”СЃС‚СЂ СЃСѓРґРѕРІРёС… СЂС–С€РµРЅСЊ ' +
  'Р”РѕСЃС‚СѓРї РґРѕ Р РµС”СЃС‚СЂСѓ Р·РґС–Р№СЃРЅСЋС”С‚СЊСЃСЏ РІ С‚РµСЃС‚РѕРІРѕРјСѓ (РѕР±РјРµР¶РµРЅРѕ'.padEnd(2091, ' ');

const LATIN1_HTML =
  '<HTML> <HEAD> <TITLE>815/1796/16</TITLE> <!-- BEGIN METADATA --> ' +
  '<!-- Íàéìåíóâàííÿ ôàéëà ç ð³øåííÿì --> <META NAME="FILENAME" CONTENT="2316_22469710.html">'.padEnd(500, ' ');

const REAL_RULING =
  'Справа № 484/1373/19 Провадження № 1-кп/484/275/19 Кримінальне провадження № 12019150110000544 ' +
  'УХВАЛА про виправлення описки 17 травня 2019 року м. Миколаїв. Суд, розглянувши матеріали, ' +
  'ПОСТАНОВИВ: виправити описку у резолютивній частині.'.padEnd(2412, ' ');

describe('detectDamagedCourtText', () => {
  it('flags the registry overload page stored as a decision', () => {
    expect(detectDamagedCourtText(OVERLOAD_PAGE)).toBe('registry_overload_page');
  });

  it('flags the page even if a future decoder gets the encoding right', () => {
    const decoded =
      'Єдиний державний реєстр судових рішень. Перегляд сторінки недоступний. ' +
      'Сервер перевантажений запитами. Спробуйте зайти пізніше.';
    expect(detectDamagedCourtText(decoded)).toBe('registry_overload_page');
  });

  it('flags registry HTML decoded as latin1', () => {
    expect(detectDamagedCourtText(LATIN1_HTML)).toBe('undecoded_html');
  });

  it('flags a long text with no Cyrillic at all', () => {
    expect(detectDamagedCourtText('A'.repeat(500))).toBe('undecoded_html');
  });

  it('does NOT flag a real ruling that happens to match the discarded length heuristic', () => {
    expect(detectDamagedCourtText(REAL_RULING)).toBeNull();
  });

  it('does NOT flag lawful short stubs the registry really publishes', () => {
    const restricted =
      'Інформація заборонена для оприлюднення згідно з Законом України ' +
      '"Про доступ до судових рішень" (п. 4 ст. 7).';
    expect(detectDamagedCourtText(restricted)).toBeNull();
    expect(detectDamagedCourtText('04.01.22')).toBeNull();
  });

  it('does NOT flag a decision that merely mentions markup in its body', () => {
    const itDispute =
      'РІШЕННЯ ІМЕНЕМ УКРАЇНИ. Позивач стверджує, що на сайті відповідача розміщено код ' +
      '<html><body> без його згоди, чим порушено авторські права. '.padEnd(600, 'і');
    expect(detectDamagedCourtText(itDispute)).toBeNull();
  });

  it('passes empty and null through untouched', () => {
    expect(detectDamagedCourtText('')).toBeNull();
    expect(detectDamagedCourtText(null)).toBeNull();
    expect(detectDamagedCourtText(undefined)).toBeNull();
  });
});

describe('a document with no text at all', () => {
  it('has a reason of its own, distinct from a damaged text', () => {
    expect(DAMAGED_TEXT_REASON.not_harvested).toMatch(/ще не завантажено/);
    expect(DAMAGED_TEXT_REASON.not_harvested).toMatch(/не роби висновків/);
    expect(DAMAGED_TEXT_REASON.not_harvested).not.toBe(DAMAGED_TEXT_REASON.registry_overload_page);
  });

  it('is not something the content detector can find — the caller must supply it', () => {
    // detectDamagedCourtText inspects text; "no row in edrsr_fulltext" has none to
    // inspect. The read paths translate that absence into `not_harvested`, which is why
    // an empty string must NOT come back as a damage kind here.
    expect(detectDamagedCourtText('')).toBeNull();
  });
});

describe('guardCourtText', () => {
  it('returns the text when it is sound', () => {
    const out = guardCourtText(REAL_RULING);
    expect(out.ok).toBe(true);
    expect(out.text).toBe(REAL_RULING);
    expect(out.text_unavailable).toBeUndefined();
  });

  it('replaces damaged text with a reason the model can act on', () => {
    const out = guardCourtText(OVERLOAD_PAGE);
    expect(out.ok).toBe(false);
    expect(out.text).toBeUndefined();
    expect(out.text_unavailable?.kind).toBe('registry_overload_page');
    expect(out.text_unavailable?.reason).toBe(DAMAGED_TEXT_REASON.registry_overload_page);
    expect(out.text_unavailable?.reason).toMatch(/Не переказуй/);
  });
});
