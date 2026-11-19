import { countryIso, historyNameKey, normUa, uaMatchKey } from '../norm';

// [input, norm_ua(input), ua_match_key(input)] produced by the Python original
// (forensic app/registers/norm.py, run with `python3 -I`); the TS port must match exactly.
// Inputs are invented or generic names, none taken from the register dumps.
const GOLDEN: Array<[string, string, string]> = [
  ['ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "СКАРАМАНДЕР ЛІМІТЕД"', 'товариство з обмеженою відповідальністю скарамандер лімітед', 'skaramander'],
  ['Scaramander Limited', 'scaramander limited', 'skaramander'],
  ['БЕЛЛІНІ МАРКО', 'белліні марко', 'belini marko'],
  ['Marco Bellini', 'marco bellini', 'marko belini'],
  ["В'ЯЧЕСЛАВ Йосипович", 'вячеслав йосипович', 'viakeslav iosipovik'],
  ['ДЖОНАТАН ДЖОН', 'джонатан джон', 'dzhonatan dzhon'],
  ['Jonathan John', 'jonathan john', 'dzhonatan dzhon'],
  ['ТЕСТЕНКО ОЛЕНА ІВАНІВНА', 'тестенко олена іванівна', 'testenko olena ivanivna'],
  ['ЩУКА Ю. Ж.', 'щука ю ж', 'shkuka iu zh'],
  ['Ålborg Ærø Øresund GmbH & Co. KG', 'alborg r resund gmbh co kg', 'alborh resund'],
  ['Ёлкин Пётр Ильич', 'елкин петр ильич', 'elkin petr ilik'],
  ['ЖИТОМИРСЬКА ЄВРОПА-ҐРУНТ «ЇЖАК»', 'житомирська європа ґрунт їжак', 'zhitomirska ievropa hrunt izhak'],
  ['Müller-Lüdenscheidt Holding B.V.', 'muller ludenscheidt holding b v', 'muler ludensheidt holdinh'],
  ['КРАНМОР ХОЛДІНГС ЛІМІТЕД (KRANMOR HOLDINGS LIMITED)', 'кранмор холдінгс лімітед kranmor holdings limited', 'kranmor holdinhs'],
  ['Kranmor Holdings Ltd', 'kranmor holdings ltd', 'kranmor holdinhs'],
  ['Xavier Quentin Wright', 'xavier quentin wright', 'ksavier kuentin vriht'],
  ["КСАВ'ЄР КВЕНТІН РАЙТ", 'ксавєр квентін райт', 'ksavier kventin rait'],
  ['Thomas Schmidt', 'thomas schmidt', 'tomas shmidt'],
  ['ТОМАС ШМІДТ', 'томас шмідт', 'tomas shmidt'],
  ['Philippe Chatelain', 'philippe chatelain', 'filipe katelain'],
  ['ФІЛІП ШАТЛЕН', 'філіп шатлен', 'filip shatlen'],
  ['Ahmed Al-Hajj', 'ahmed al hajj', 'amed al hadzhdzh'],
  ['АХМЕД АЛЬ-ХАДЖ', 'ахмед аль хадж', 'amed al hadzh'],
  ['', '', ''],
  ['   ', '', ''],
  ['12345678', '12345678', '12345678'],
  ['ТОВ ПП АТ', 'тов пп ат', ''],
  ['A B C', 'a b c', ''],
  ['Ńeść Żółw', 'nesc zo w', 'nesk'],
  ['İstanbul Şirketi', 'istanbul sirketi', 'istanbul sirketi'],
  ['ß straße', 'stra e', 'stra'],
  ['O’Brien ʼMcDonald‘s', 'obrien mcdonalds', 'obrien mkdonalds'],
  ['«Альфа»—Вест “Плюс” „Мінус“', 'альфа вест плюс мінус', 'alfa vest plius minus'],
  ['Hhh Ahh Ohh john', 'hhh ahh ohh john', 'ah oh dzhon'],
  ['ЯЮЄЇ щЩ ьЬъЪ ыэ', 'яюєї щщ ььъъ ыэ', 'iaiuiei shkshk ie'],
  ['Ⅻ ﬁnance ²', 'xii finance 2', 'ksi finanke'],
  ['Dzhon Dzhons', 'dzhon dzhons', 'dzhon dzhons'],
  ['Ivan Ivanenko Ivan', 'ivan ivanenko ivan', 'ivan ivanenko'],
];

describe('normUa / uaMatchKey (golden, from the Python original)', () => {
  it.each(GOLDEN)('%j', (input, norm, key) => {
    expect(normUa(input)).toBe(norm);
    expect(uaMatchKey(input)).toBe(key);
  });

  it('matches a Latin query to the Ukrainian transcription', () => {
    expect(uaMatchKey('Scaramander Limited')).toBe(uaMatchKey('ТОВ "СКАРАМАНДЕР ЛІМІТЕД"'));
    expect(uaMatchKey('Thomas Schmidt')).toBe(uaMatchKey('ТОМАС ШМІДТ'));
    expect(historyNameKey('СКАРАМАНДЕР ЛІМІТЕД (SCARAMANDER LIMITED)')).toBe(historyNameKey('СКАРАМАНДЕР ЛІМІТЕД'));
  });

  it('maps country names to ISO codes', () => {
    expect(countryIso('Сполучене Королівство')).toBe('GB');
    expect(countryIso("Об'єднані Арабські Емірати")).toBe('AE');
    expect(countryIso('Республіка Кіпр')).toBe('CY');
    expect(countryIso('cy')).toBe('CY');
    expect(countryIso('Атлантида')).toBeNull();
    expect(countryIso('')).toBeNull();
    expect(countryIso('constructor')).toBeNull();
    expect(countryIso('__proto__')).toBeNull();
    expect(countryIso('toString')).toBeNull();
  });
});
