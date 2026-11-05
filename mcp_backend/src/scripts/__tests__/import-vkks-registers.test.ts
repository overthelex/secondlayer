jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import {
  int, parseEvaluations, parseJudges, parseVacancySheet, snapshotDate,
} from '../import-vkks-registers';

// LEXAI-2126: layouts as published on data.gov.ua in November 2026.
describe('import-vkks-registers parsers', () => {
  it('reads the snapshot date from the title row', () => {
    expect(snapshotDate('СПИСОК СУДДІВ СТАНОМ НА  02.11.2026')).toBe('2026-11-02');
    expect(snapshotDate('без дати')).toBeNull();
  });

  it('parses judges below the title and keeps leading zeros', () => {
    const rows = [
      ['СПИСОК СУДДІВ СТАНОМ НА 02.11.2026'],
      ['№ з/п', 'Номер досьє', "Прізвище, ім'я, по батькові осіб, призначених (обраних) на посаду судді", 'Стать', 'Найменування суду, до якого призначено'],
      ['1', 6935, 'Аббасова Наталія Володимирівна', 'Ж', 'Шевченківський районний суд міста Києва'],
      ['2', '06935', 'Дубль', 'Ж', 'X суд'],
      ['3', null, null, null, null],
    ];
    expect(parseJudges(rows)).toEqual([
      { dossier_number: '06935', full_name: 'Аббасова Наталія Володимирівна', gender: 'Ж', court_name: 'Шевченківський районний суд міста Києва' },
    ]);
  });

  it('parses vacancies: text cells become null, the АС region column shifts the numbers', () => {
    const head = ['№ з/п', 'Найменування суду', 'Гранична', 'Призначено (обрано)', 'Вакантні', 'Триває процедура зайняття'];
    const ms = parseVacancySheet('МС', [['ІНФОРМАЦІЯ'], head, head,
      ['1', 'Бершадський окружний суд Вінницької області', 'не розпочав роботу', '-', '-', '-'],
      ['2', 'Бершадський районний суд Вінницької області', '6', '3', '3', '0'],
      [null, '* примітка'],
      [null, 'Примітка: 1. Інформація надається з урахуванням граничної кількості суддів у суді.'],
    ]);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ court_level: 'місцевий', positions_limit: null, region: null });
    expect(ms[1]).toMatchObject({ positions_limit: 6, positions_filled: 3, positions_vacant: 3, positions_in_process: 0 });

    const asHead = ['№ з/п', 'Найменування суду (сортування за регіонами)', 'Регіон та місцезнаходження суду', 'Гранична', 'Призначено', 'Вакантні', 'Триває процедура'];
    const as = parseVacancySheet('АС', [asHead, ['1', 'Вінницький апеляційний суд', 'Вінницька область', '35', '19', '16', '15']]);
    expect(as[0]).toMatchObject({ court_level: 'апеляційний', region: 'Вінницька область', positions_limit: 35, positions_in_process: 15 });
    expect(parseVacancySheet('Аркуш1', [asHead])).toEqual([]);
  });

  it('parses both evaluation layouts, NA -> null', () => {
    const regular = parseEvaluations([
      ['dossier_code', 'judge', 'court', 'panel_decision_date', 'panel_decision_number', 'panel_decision_essence',
        'panel_decision_web', 'panel_decision_file', 'competence', 'integrity', 'professional_ethics', 'overall_score',
        'plenary_or_chamber_decision_date', 'plenary_or_chamber_decision_number', 'plenary_or_chamber_decision_essence',
        'plenary_or_chamber_decision_web', 'plenary_or_chamber_decision_file', 'notes'],
      ['01237', 'Абдукадирова К. Е.', 'Суд', '2019-05-11', '213/ко-19', 'Підтверджено', 'https://w', 'https://f',
        '358.625', '160', '200', '718.625', 'NA', 'NA', 'NA', 'NA', 'NA', 'NA'],
    ], 'regular');
    expect(regular[0]).toMatchObject({
      dossier_number: '01237', collegium_decision_date: '2019-05-11', total_score: 718.625,
      plenary_decision_date: null, decision_url: 'https://w', decision_file_url: 'https://f', notes: null, evaluation_type: 'regular',
    });
    const primary = parseEvaluations([
      ['dossier_code', 'judge', 'court', 'decision_date', 'decision_number', 'core_of_the_decision', 'decision_url', 'decision_file', 'notes'],
      ['00693', 'Авраменко М. Г.', 'Суд', '2016-04-20', '117/ко-16', 'Підтверджено можливість', 'https://u', 'https://d', 'NA'],
    ], 'primary');
    expect(primary[0]).toMatchObject({ collegium_decision_number: '117/ко-16', collegium_decision_essence: 'Підтверджено можливість', decision_url: 'https://u', total_score: null });
  });

  it('int() only accepts whole numbers', () => {
    expect(int('12')).toBe(12);
    expect(int(30)).toBe(30);
    expect(int('підсудність визначено іншому суду')).toBeNull();
  });
});
