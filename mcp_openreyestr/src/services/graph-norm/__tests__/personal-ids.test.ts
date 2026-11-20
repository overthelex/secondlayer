/**
 * Personal numbers in ЄДР names and texts (LEXAI-2322). Synthetic names and numbers only.
 */
import { hasTenDigits, stripIdNumbers, stripPersonIds } from '../personal-ids';

const NAME = 'ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ';

describe('stripPersonIds', () => {
  it('strips the РНОКПП in the shapes the register writes it', () => {
    for (const s of [
      `${NAME} (1234567890)`, `${NAME}(1234567890)`, `${NAME} 1234567890`, `${NAME}1234567890`, `${NAME}, 1234567890`,
      `${NAME} .1234567890`, `${NAME} ІНД.1234567890`, `${NAME} ІДН 1234567890`, `${NAME}, РНОКПП: 1234567890`,
      `${NAME}, РНОКПП 1234567890.`, `${NAME} (РНКПП 1234567890)`, `${NAME} ІПН 1234567890`, `${NAME} (ІПН:1234567890`,
      `${NAME} ідентифікаційний код 1234567890`, `${NAME}, реєстраційний номер облікової картки платника податків 1234567890`,
      `${NAME}, код 1234567890`, `${NAME} /1234567890/`, `1234567890 ${NAME}`,
    ]) {
      expect([s, stripPersonIds(s)]).toEqual([s, NAME]);
    }
  });

  it('strips longer runs (a number glued to a postcode), 9-digit ID cards and passport series', () => {
    expect(stripPersonIds(`${NAME} .123456789001001`)).toBe(NAME);
    expect(stripPersonIds(`${NAME} 123456789`)).toBe(NAME);
    expect(stripPersonIds(`${NAME}, паспорт серії АА № 123456`)).toBe(NAME);
    expect(stripPersonIds(`${NAME} серіяАА123456`)).toBe(NAME);
    // seven digits after a two-letter series, in brackets, glued to a dash or with a space (seen on prod, 20.11)
    expect(stripPersonIds(`${NAME} (АА1234567)- ТЕСТОВО`)).toBe(`${NAME} - ТЕСТОВО`);
    expect(stripPersonIds(`${NAME} (АА 1234567`)).toBe(NAME);
    // eight digits after a two-letter word, with or without brackets (seen on prod, 20.11)
    expect(stripPersonIds(`${NAME} (АА 01234567)`)).toBe(NAME);
    expect(stripPersonIds(`${NAME} АА 12345678`)).toBe(NAME);
    // nine digits after two letters stays a different token; an 8-digit code without letters stays
    expect(stripPersonIds(`ТОВ «ТЕСТ» 12345678`)).toBe('ТОВ «ТЕСТ» 12345678');
    expect(stripPersonIds(`ТЕСТЕНКО ТЕСТ/ ТЕСТ ТЕСТОВИЧ/1234567890/АА123456`)).toBe('ТЕСТЕНКО ТЕСТ/ ТЕСТ ТЕСТОВИЧ');
  });

  it('keeps the rest of the entry and its neighbours', () => {
    expect(stripPersonIds('ТЕСТЕНКО Т.Т. (1234567890) 50%')).toBe('ТЕСТЕНКО Т.Т. 50%');
    expect(stripPersonIds(`${NAME} (РНОКПП 1234567890) ЛІКВІДАТОР`)).toBe(`${NAME} ЛІКВІДАТОР`);
    expect(stripPersonIds(`${NAME} .1234567890 01001`)).toBe(`${NAME} 01001`);
    // a surname that starts like a marker word is not a marker
    expect(stripPersonIds('ТЕСТ НОМЕРЕНКО 1234567890')).toBe('ТЕСТ НОМЕРЕНКО');
    expect(stripPersonIds('1234567890')).toBe('');
  });

  it('leaves 8-digit ЄДРПОУ codes, short numbers and clean names alone', () => {
    for (const s of [NAME, 'ТОВ "АЛЬФА", 12345678', 'ТОВ "АЛЬФА" (код 01234567)', 'ПРАТ ГАЄК', '91 акціонер', 'ТЕСТЕНКО Т.Т.',
      `${NAME}, 01001, м. Київ`, '', null, undefined]) {
      expect(stripPersonIds(s as string)).toBe(s);
    }
  });
});

describe('stripIdNumbers (free text)', () => {
  it('strips standalone 10-digit numbers with their markers, keeps ЄДРПОУ and other numbers', () => {
    expect(stripIdNumbers('Прямий вирішальний вплив; через ТОВ "АЛЬФА" (12345678), бенефіціар ТЕСТЕНКО Т.Т. (РНОКПП 1234567890), номер запису 1234567890123456'))
      .toBe('Прямий вирішальний вплив; через ТОВ "АЛЬФА" (12345678), бенефіціар ТЕСТЕНКО Т.Т., номер запису 1234567890123456');
    expect(stripIdNumbers('опосередкований; ТЕСТЕНКО ТЕСТ, 01.01.1980 р.н., РНОКПП 1234567890, країна громадянства Україна'))
      .toBe('опосередкований; ТЕСТЕНКО ТЕСТ, 01.01.1980 р.н., країна громадянства Україна');
    expect(stripIdNumbers('ТЕСТЕНКО ТЕСТ (1234567890), ТЕСТОВА ТЕСТА (2345678901)')).toBe('ТЕСТЕНКО ТЕСТ, ТЕСТОВА ТЕСТА');
    for (const s of ['Прямий вирішальний вплив', '100', 'через ТОВ "АЛЬФА" (12345678)', 'тел +380441234567', '', null]) {
      expect(stripIdNumbers(s as string)).toBe(s);
    }
  });

  it('hasTenDigits is the post-build check', () => {
    expect(hasTenDigits(`${NAME} 1234567890`)).toBe(true);
    expect(hasTenDigits(stripPersonIds(`${NAME} 1234567890`))).toBe(false);
    expect(hasTenDigits('12345678')).toBe(false);
    expect(hasTenDigits('1234567890123456')).toBe(false);
  });
});
