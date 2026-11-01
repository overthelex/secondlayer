import { Pool } from 'pg';
import {
  ARMA_OWNER_NOT_PUBLISHED,
  buildArmaFilters,
  categorizeAsset,
  mapArmaItem,
  regionFromCourt,
  repairArmaLine,
  resolveRegionFilter,
  splitCaseNumbers,
} from '../arma-mapping';
import { OpenReyestrTools } from '../../api/openreyestr-tools';

// Real items from data.gov.ua edra_opendata.json (downloaded 2026-11-01).
const ITEM_WITH_ACTION = {
  id: 3000000067284,
  description: 'Автомобіль ',
  props: 'Марка: Mercedes-Benz | Модель: Vaneo',
  dectypename: 'передача майна в управління',
  docnum: '757/2732/19-к',
  decisiondate: '01.02.2019',
  numerdr: '12014100030013137',
  props_1: 'Найменування суду: Печерський районний суд міста Києва; ПІБ судді: Карабань В.М.; Найменування органу досудового розс.: ОВС ГСУ НП України; ПІБ слідчого: Костецький Є.Й.; Назва органу прокуратури: Генеральна прокуратура України',
  name: 'Оцінка',
  dateaction: '08.04.2019',
  props_2: 'Дата складання звіту: 08.04.2019; Оціночна вартість майна (грн): 2596617; Термін дії оцінки (міс.): 6',
  state: 'Підготовча стадія',
  actionincomesum: 0,
};

const ITEM_ARREST = {
  id: 3000000055694,
  description: 'вилучене майно з вантажного контейнеру, а саме: гіроскутери у кількості 326 штук',
  dectypename: 'накладення арешту на майно; передача майна в управління',
  docnum: '522/4178/19, 1-кс/522/1/19',
  decisiondate: '15.11.2019',
  numerdr: '42019000000000164',
  props_1: 'Найменування суду: Приморський районний суд м. Одеси; ПІБ судді: Іванов В. В.; Найменування органу досудового розс.: ГСУ ДБР',
};

describe('ARMA field map (LEXAI-2161)', () => {
  it('maps source fields to the right columns and leaves owner_* out', () => {
    const r = mapArmaItem(ITEM_WITH_ACTION);
    expect(r).toMatchObject({
      asset_id: '3000000067284',
      case_number: '757/2732/19-к',
      case_numbers: ['757/2732/19-к'],
      criminal_proceeding_number: '12014100030013137',
      case_date: '2019-02-01',
      court_name: 'Печерський районний суд міста Києва',
      judge_name: 'Карабань В.М.',
      investigation_body: 'ОВС ГСУ НП України',
      region: 'м. Київ',
      decision_type: 'передача майна в управління',
      asset_type: 'транспортний засіб',
      asset_description: 'Автомобіль',
      asset_props: 'Марка: Mercedes-Benz | Модель: Vaneo',
      action_name: 'Оцінка',
      action_date: '2019-04-08',
      status: 'Підготовча стадія',
      arrest_date: null,
      manager: null,
      action_income_sum: '0',
    });
    expect(r).not.toHaveProperty('owner_name');
    expect(r).not.toHaveProperty('owner_edrpou');
  });

  it('splits multi-number docnum and sets arrest_date only for arrest decisions', () => {
    const r = mapArmaItem(ITEM_ARREST);
    expect(r.case_numbers).toEqual(['522/4178/19', '1-кс/522/1/19']);
    expect(r.arrest_date).toBe('2019-11-15');
    expect(r.region).toBe('Одеська область');
    expect(r.status).toBeNull();
    expect(r.action_name).toBeNull();
  });

  it('takes the asset manager from action details, not the judge', () => {
    const r = mapArmaItem({
      ...ITEM_WITH_ACTION,
      name: 'Управління за договором',
      props_2: 'Назва управителя/ПІБ управителя: ТОВ "УПРАВИТЕЛЬ"; Номер договору: 1; Дата підписання: 05.06.2020',
    });
    expect(r.manager).toBe('ТОВ "УПРАВИТЕЛЬ"');
    expect(r.transfer_date).toBe('2020-06-05');
  });

  it('repairs the decimal comma in actionincomesum', () => {
    const line = '{"id":3000000034732,"state":"Розміщення\\/ Перерозміщення на депозиті","actionincomesum":583526,51}';
    expect(() => JSON.parse(line)).toThrow();
    const item = JSON.parse(repairArmaLine(line));
    expect(item.actionincomesum).toBe(583526.51);
    expect(mapArmaItem(item).action_income_sum).toBe('583526.51');
  });

  it('splits and dedupes case numbers', () => {
    expect(splitCaseNumbers('991/1718/25, 1-кп/991/22/25')).toEqual(['991/1718/25', '1-кп/991/22/25']);
    expect(splitCaseNumbers('760/14539/18, 760/14539/18')).toEqual(['760/14539/18']);
    expect(splitCaseNumbers(null)).toEqual([]);
  });
});

describe('regionFromCourt', () => {
  it.each([
    ['Шевченківський районний суд міста Києва', 'м. Київ'],
    ['Київський районний суд м. Одеси', 'Одеська область'],
    ['Київський апеляційний суд', 'м. Київ'],
    ['Ірпінський міський суд Київської області', 'Київська область'],
    ['Личаківський районний суд м. Львова', 'Львівська область'],
    ['Центрально-Міський районний суд м. Кривого Рогу', 'Дніпропетровська область'],
    ['Індустріальний районний суд м. Дніпра', 'Дніпропетровська область'],
    ['Автозаводський районний суд м. Кременчука', 'Полтавська область'],
    ['Подільський районний суд міста Кропивницького', 'Кіровоградська область'],
    ['Приморський районний суд м. Маріуполя', 'Донецька область'],
    ['Заводський районний суд м. Кам\'янського', 'Дніпропетровська область'],
    ['Дніпровський апеляційний суд', 'Дніпропетровська область'],
    ['Хаджибейський районний суд міста Одеси (Малиновський районний суд м. Одеси)', 'Одеська область'],
    ['Вінницький міський суд Вінницької області', 'Вінницька область'],
    ['Сумський апеляційний суд', 'Сумська область'],
    ['Вищий антикорупційний суд', null],
    ['Апеляційна палата Вищого антикорупційного суду', null],
  ])('%s → %s', (court, region) => {
    expect(regionFromCourt(court)).toBe(region);
  });
});

describe('categorizeAsset', () => {
  it.each([
    ['Автомобіль', 'Марка: Mercedes-Benz | Модель: Vaneo', 'транспортний засіб'],
    ['вагон', null, 'транспорт: залізничний вагон'],
    ['свідоцтво про реєстрацію транспортного засобу', null, 'документи'],
    ['Земельна ділянка', 'Площа: 2440 кв.м. | Призначення, вид: для ведення ОСГ', 'земельна ділянка'],
    ['машиномісце, підвал підземного паркінгу за адресою м. Київ', null, 'нерухоме майно'],
    ['грошові кошти', 'Валюта: грн. | Сума: 1000', 'грошові кошти'],
    ['прості іменні акції АТ "Мотор Січ"', null, 'цінні папери / корпоративні права'],
    ['мобільний телефон', 'Вид приладу: мобільний телефон', 'техніка / електроніка'],
    ['картонна коробка коричневого кольору', null, 'товарно-матеріальні цінності'],
    ['баркас риболовний', 'Тип і призначення судна: Баркас', 'транспорт: судно / повітряне судно'],
    ['щось незрозуміле', null, 'інше'],
  ])('%s → %s', (d, p, cat) => {
    expect(categorizeAsset(d, p)).toBe(cat);
  });
});

describe('resolveRegionFilter', () => {
  it('maps "Київ" to the city and the oblast', () => {
    expect(resolveRegionFilter('Київ').sort()).toEqual(['Київська область', 'м. Київ'].sort());
  });
  it('maps oblast and city spellings', () => {
    expect(resolveRegionFilter('Одеська область')).toEqual(['Одеська область']);
    expect(resolveRegionFilter('Одеса')).toEqual(['Одеська область']);
    expect(resolveRegionFilter('Дніпро')).toEqual(['Дніпропетровська область']);
    expect(resolveRegionFilter('Львівська обл.')).toEqual(['Львівська область']);
  });
  it('returns nothing for unknown text', () => {
    expect(resolveRegionFilter('Атлантида')).toEqual([]);
  });
});

describe('buildArmaFilters', () => {
  it('matches a case number inside the comma-separated list', () => {
    const { conditions, values } = buildArmaFilters({ case_number: '991/1718/25' });
    expect(conditions).toEqual(['case_numbers @> ARRAY[$1]::text[]']);
    expect(values).toEqual(['991/1718/25']);
  });

  it('matches any of several case numbers', () => {
    const { conditions, values } = buildArmaFilters({ case_number: '991/1718/25, 1-кп/991/22/25' });
    expect(conditions).toEqual(['case_numbers && $1::text[]']);
    expect(values).toEqual([['991/1718/25', '1-кп/991/22/25']]);
  });

  it('treats a 17-digit case_number as an ЄРДР number', () => {
    const { conditions } = buildArmaFilters({ case_number: '12014100030013137' });
    expect(conditions[0]).toMatch(/criminal_proceeding_number = \$1/);
  });

  it('maps documented English statuses to Ukrainian values', () => {
    expect(buildArmaFilters({ status: 'arrested' }).conditions[0]).toMatch(/накладення арешту/);
    expect(buildArmaFilters({ status: 'Returned' }).conditions[0]).toMatch(/Повернення власнику/);
    expect(buildArmaFilters({ status: 'sold' }).conditions[0]).toBe("status = 'Реалізовано'");
    expect(buildArmaFilters({ status: 'transferred' }).values).toEqual([]);
    const free = buildArmaFilters({ status: 'Передано для реалізації' });
    expect(free.conditions[0]).toMatch(/status ILIKE \$1 OR decision_type ILIKE \$1/);
    expect(free.values).toEqual(['%Передано для реалізації%']);
  });

  it('matches asset_type as a substring of the category or the description', () => {
    const { conditions, values } = buildArmaFilters({ asset_type: 'транспорт' });
    expect(conditions[0]).toBe('(asset_type ILIKE $1 OR asset_description ILIKE $1)');
    expect(values).toEqual(['%транспорт%']);
  });

  it('resolves region to canonical names', () => {
    const { conditions, values } = buildArmaFilters({ region: 'Київ' });
    expect(conditions[0]).toBe('region = ANY($1::text[])');
    expect((values[0] as string[]).sort()).toEqual(['Київська область', 'м. Київ'].sort());
  });

  it('ignores owner filters (not in open data) and escapes LIKE wildcards', () => {
    const { conditions, values } = buildArmaFilters({ owner_name: 'Медведчук', court_name: '100%_суд' });
    expect(conditions).toEqual(['court_name ILIKE $1']);
    expect(values).toEqual(['%100\\%\\_суд%']);
  });
});

describe('searchArmaSeizedAssets', () => {
  function mockPool(rows: any[] = []) {
    const query = jest.fn().mockResolvedValue({ rows });
    return { pool: { query } as unknown as Pool, query };
  }

  it('explains that owner data is not published instead of querying', async () => {
    const { pool, query } = mockPool();
    const res = await new OpenReyestrTools(pool).searchArmaSeizedAssets({ owner_name: 'Медведчук' });
    expect(query).not.toHaveBeenCalled();
    expect(res[0]).toMatchObject({ found: false, message: ARMA_OWNER_NOT_PUBLISHED });
  });

  it('numbers LIMIT/OFFSET after the filters and clamps limit', async () => {
    const { pool, query } = mockPool([{ case_number: '991/1718/25' }]);
    await new OpenReyestrTools(pool).searchArmaSeizedAssets({ court_name: 'суд', region: 'Одеса', limit: 500, offset: 3 });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/court_name ILIKE \$1 AND region = ANY\(\$2::text\[\]\)/);
    expect(sql).toMatch(/LIMIT \$3 OFFSET \$4/);
    expect(sql).not.toMatch(/owner_/);
    expect(values).toEqual(['%суд%', ['Одеська область'], 100, 3]);
  });
});
