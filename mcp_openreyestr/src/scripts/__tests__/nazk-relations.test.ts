import {
  buildInsert, CORPORATE_RIGHT_COLUMNS, extractNazkRelations, nazkDate, nazkNumber, nazkText, normalizeEdrpou,
} from '../lib/nazk-relations';

// Synthetic documents shaped like /v2/documents/{id} (schema 5 and schema 2, observed 19.11.2026).
// Names, codes and amounts are invented.
const HIDDEN = '[Конфіденційна інформація]';

const schema5 = {
  id: '00000000-0000-4000-8000-000000000005',
  user_declarant_id: 900001,
  declaration_year: 2024,
  declaration_type: 1,
  schema_version: 5,
  data: {
    step_1: { data: { lastname: 'Тестенко', firstname: 'Марія', middlename: 'Іванівна' } },
    step_2: {
      isNotApplicable: 0,
      data: [
        {
          id: 1700000000001, lastname: 'Тестенко', firstname: 'Петро', middlename: 'Олегович',
          subjectRelation: 'чоловік', citizenship: '1', birthday: HIDDEN, taxNumber: HIDDEN,
          passport: HIDDEN, unzr: HIDDEN, street: HIDDEN, houseNum: HIDDEN,
          non_ukraine_identity: {
            '1700000000999': {
              nui_last_name: 'TESTENKO', nui_first_name: 'PETRO', nui_middle_name: '[Не застосовується]',
              nui_document_number: HIDDEN,
            },
          },
        },
        {
          id: 1700000000002, lastname: 'Тестенко', firstname: 'Оксана', middlename: 'Петрівна',
          subjectRelation: 'дочка', citizenship: '1', birthday: HIDDEN,
        },
      ],
    },
    step_7: {
      isNotApplicable: 0,
      data: [{
        iteration: '1700000000100', typeProperty: 'Акції', emitent: 'j',
        emitent_type: 'Юридична особа, зареєстрована в Україні',
        emitent_ua_company_name: 'ПрАТ "Умовний завод"', emitent_ua_company_code: '4012000',
        amount: '6462', cost: '0,25', owningDate: '31.10.2009',
        rights: [{ rightBelongs: '1700000000001', ownershipType: 'Власність' }],
      }],
    },
    step_8: {
      isNotApplicable: 0,
      data: [
        {
          iteration: '1700000000200', name: 'Приватне підприємство УМОВА', legalForm: 'приватне підприємство',
          corporate_rights_company_code: '33000001', country: '1', cost: '260000', cost_percent: '100',
          owningDate: '27.04.2005', is_transferred: 'Не передано',
          rights: [{ rightBelongs: '1700000000001' }],
        },
        {
          iteration: '1700000000201', name: 'ТОВ "СПІЛЬНА СПРАВА"', legalForm: 'ТОВ',
          corporate_rights_company_code: '44000002', country: '1', cost: '1 500,50', cost_percent: '25,06',
          rights: [{ rightBelongs: '1', ownershipType: 'Спільна власність' }, { rightBelongs: 'j' }],
        },
        {
          iteration: '1700000000202', name: 'Example Holdings Limited', country: '12',
          corporate_rights_company_code: 'HE123456', cost_percent: '10', rights: [{ rightBelongs: '1' }],
        },
      ],
    },
    step_9: {
      isNotApplicable: 0,
      data: [{
        iteration: '1700000000300', legalForm: 'Приватне підприємство',
        company_name_beneficial_owner: "Приватне підприємство 'УМОВА'", ua_company_code_beneficial_owner: '33000001',
        country_beneficial_owner: '1', address_beneficial_owner: 'м. Київ, вул. Умовна, 1',
        phone: '[Не застосовується]', mail: '[Не відомо]',
        person_who_care: [{ rightBelongs: '1700000000001' }],
      }],
    },
  },
};

const schema2 = {
  id: '00000000-0000-4000-8000-000000000002',
  user_declarant_id: 900002,
  declaration_year: 2016,
  schema_version: 2,
  data: {
    step_1: { data: { lastname: 'Зразков', firstname: 'Андрій', middlename: 'Миколайович' } },
    step_2: {
      isNotApplicable: 0,
      data: [{ id: 1480000000001, lastname: 'Зразкова', firstname: 'Людмила ', middlename: 'Петрівна', subjectRelation: 'дружина', citizenship: '1', birthday: HIDDEN }],
    },
    step_7: { isNotApplicable: 1, data: [] },
    step_8: {
      isNotApplicable: 0,
      data: [
        { iteration: '1480000000200', name: 'ПП "Буревій"', person: '1480000000001', regNumber: HIDDEN, country: '1', cost: '[Не застосовується]', cost_percent: '100', rights: [{ rightBelongs: '1480000000001', ownershipType: 'Власність' }] },
        { iteration: '1480000000201', name: 'ТОВ "Старт"', person: '1', regNumber: '35000003', country: '1', cost_percent: '70' },
      ],
    },
    step_9: {
      isNotApplicable: 0,
      data: [{ iteration: '1480000000300', name: 'ТОВ "Старт"', person: '1', beneficial_owner_company_code: '35000003', country: '1', legalForm: 'товариство', phone: '0000000000' }],
    },
  },
};

describe('value helpers', () => {
  it('treats NAZK placeholders as null', () => {
    expect(nazkText(HIDDEN)).toBeNull();
    expect(nazkText('[Не відомо]')).toBeNull();
    expect(nazkText("[Член сім'ї не надав інформацію]")).toBeNull();
    expect(nazkText('  Людмила  ')).toBe('Людмила');
    expect(nazkNumber('25,06')).toBe(25.06);
    expect(nazkNumber('1 500,50')).toBe(1500.5);
    expect(nazkNumber('[Не застосовується]')).toBeNull();
    expect(nazkDate('27.04.2005')).toBe('2005-04-27');
    expect(nazkDate('2005')).toBeNull();
  });

  it('pads Ukrainian codes to 8 digits and leaves foreign ones out', () => {
    expect(normalizeEdrpou('4012000')).toBe('04012000');
    expect(normalizeEdrpou('33 000 001', '1')).toBe('33000001');
    expect(normalizeEdrpou('HE123456', '12')).toBeNull();
    expect(normalizeEdrpou('12345678', '12')).toBeNull();
    expect(normalizeEdrpou('1234567890')).toBeNull();
    expect(normalizeEdrpou(HIDDEN)).toBeNull();
    expect(normalizeEdrpou('00000000')).toBeNull();
  });
});

describe('extractNazkRelations, schema 5', () => {
  const { familyMembers, corporateRights } = extractNazkRelations(schema5);

  it('extracts family members without any hidden identifiers', () => {
    expect(familyMembers).toHaveLength(2);
    expect(familyMembers[0]).toEqual({
      declaration_id: schema5.id, declarant_id: 900001, declaration_year: 2024,
      member_key: '1700000000001', full_name: 'Тестенко Петро Олегович',
      lastname: 'Тестенко', firstname: 'Петро', middlename: 'Олегович',
      name_latin: 'TESTENKO PETRO', name_key: 'testenko petro olehovik',
      relation: 'чоловік', citizenship: '1',
    });
    expect(JSON.stringify(familyMembers)).not.toContain('Конфіденційна');
  });

  it('extracts securities with the owner resolved to the family member', () => {
    const sec = corporateRights.filter(r => r.section === 7);
    expect(sec).toHaveLength(1);
    expect(sec[0]).toMatchObject({
      right_kind: 'securities', owner_type: 'family', owner_key: '1700000000001',
      owner_name: 'Тестенко Петро Олегович', owner_relation: 'чоловік',
      company_name: 'ПрАТ "Умовний завод"', edrpou: '04012000', country: '1',
      security_type: 'Акції', amount: 6462, value: 0.25, acquired_date: '2009-10-31',
      ownership_type: 'Власність', is_beneficial_owner: false,
    });
  });

  it('extracts corporate rights, one row per owner, third persons without a name', () => {
    const cr = corporateRights.filter(r => r.section === 8);
    expect(cr.map(r => [r.entry_key, r.owner_type, r.edrpou])).toEqual([
      ['1700000000200', 'family', '33000001'],
      ['1700000000201', 'declarant', '44000002'],
      ['1700000000201', 'other', '44000002'],
      ['1700000000202', 'declarant', null],
    ]);
    expect(cr[1]).toMatchObject({
      owner_name: 'Тестенко Марія Іванівна', share_percent: 25.06, value: 1500.5,
      ownership_type: 'Спільна власність', company_name_key: 'spilna sprava',
    });
    expect(cr[2].owner_name).toBeNull();
    expect(cr[3]).toMatchObject({ company_code_raw: 'HE123456', country: '12', company_name: 'Example Holdings Limited' });
  });

  it('extracts beneficial ownership and drops contacts', () => {
    const bo = corporateRights.filter(r => r.section === 9);
    expect(bo).toHaveLength(1);
    expect(bo[0]).toMatchObject({
      right_kind: 'beneficial_owner', is_beneficial_owner: true, owner_type: 'family',
      edrpou: '33000001', company_name: "Приватне підприємство 'УМОВА'", legal_form: 'Приватне підприємство',
    });
    expect(JSON.stringify(bo)).not.toMatch(/Умовна, 1|phone|mail/);
  });
});

describe('extractNazkRelations, schema 2', () => {
  const { familyMembers, corporateRights } = extractNazkRelations(schema2);

  it('reads the older field names (person, regNumber, beneficial_owner_company_code)', () => {
    expect(familyMembers).toHaveLength(1);
    expect(familyMembers[0].firstname).toBe('Людмила');
    expect(corporateRights.map(r => [r.section, r.owner_type, r.edrpou, r.company_code_raw])).toEqual([
      [8, 'family', null, null],
      [8, 'declarant', '35000003', '35000003'],
      [9, 'declarant', '35000003', '35000003'],
    ]);
    expect(corporateRights[0]).toMatchObject({ value: null, share_percent: 100, owner_name: 'Зразкова Людмила Петрівна' });
  });

  it('returns nothing for a list-only document', () => {
    expect(extractNazkRelations({ id: 'x', data: { step_0: {}, step_1: { data: {} } } }))
      .toEqual({ familyMembers: [], corporateRights: [] });
  });
});

describe('buildInsert', () => {
  it('numbers placeholders across rows', () => {
    const rows = extractNazkRelations(schema2).corporateRights;
    const q = buildInsert('nazk_corporate_rights', CORPORATE_RIGHT_COLUMNS, rows);
    expect(q.values).toHaveLength(rows.length * CORPORATE_RIGHT_COLUMNS.length);
    expect(q.text).toContain(`$${q.values.length})`);
    expect(q.text.startsWith('INSERT INTO nazk_corporate_rights (declaration_id, ')).toBe(true);
  });
});
