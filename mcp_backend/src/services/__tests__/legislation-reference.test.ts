import { parseLegislationReference } from '../legislation-service';

describe('parseLegislationReference', () => {
  it('parses "ст. 625 ЦК"', () => {
    expect(parseLegislationReference('ст. 625 ЦК')).toEqual({
      radaId: '435-15',
      articleNumber: '625',
    });
  });

  it('parses "ст. 44 ПКУ"', () => {
    expect(parseLegislationReference('ст. 44 ПКУ')).toEqual({
      radaId: '2755-17',
      articleNumber: '44',
    });
  });

  it('parses "ГПК ст. 123"', () => {
    expect(parseLegislationReference('ГПК ст. 123')).toEqual({
      radaId: '1798-12',
      articleNumber: '123',
    });
  });

  it('parses explicit rada_id reference', () => {
    expect(parseLegislationReference('1618-15 ст. 354')).toEqual({
      radaId: '1618-15',
      articleNumber: '354',
    });
  });

  it('returns null when cannot parse', () => {
    expect(parseLegislationReference('hello world')).toBeNull();
  });

  it('parses "постанова КМУ №1388 пункт 6"', () => {
    const result = parseLegislationReference('постанова КМУ №1388 пункт 6');
    expect(result).toEqual({
      radaId: 'KMU:1388',
      articleNumber: '6',
    });
  });

  it('parses "ПКМУ 704 п. 3"', () => {
    const result = parseLegislationReference('ПКМУ 704 п. 3');
    expect(result).toEqual({
      radaId: 'KMU:704',
      articleNumber: '3',
    });
  });

  it('parses "постанова Кабінету Міністрів №1388"', () => {
    const result = parseLegislationReference('постанова Кабінету Міністрів №1388');
    expect(result).toEqual({
      radaId: 'KMU:1388',
      articleNumber: '',
    });
  });

  it('parses "постанова КМУ №1388 від 1998" with explicit year', () => {
    const result = parseLegislationReference('постанова КМУ №1388 від 07.11.1998 пункт 6');
    expect(result).toEqual({
      radaId: '1388-98-п',
      articleNumber: '6',
    });
  });

  // КУпАП: Rada keeps the in-force code under 8073-10 since 07.05.2017; the
  // old halves 80731-10 / 80732-10 are frozen at that date.
  it('parses "ст. 283 КУпАП" to the in-force code 8073-10', () => {
    expect(parseLegislationReference('ст. 283 КУпАП')).toEqual({
      radaId: '8073-10',
      articleNumber: '283',
    });
  });

  it('parses an indexed КУпАП article', () => {
    expect(parseLegislationReference('ст. 173-2 КУПАП')).toEqual({
      radaId: '8073-10',
      articleNumber: '173-2',
    });
  });

  it('parses the full name of КУпАП to 8073-10', () => {
    expect(parseLegislationReference('ст. 283 Кодексу про адміністративні правопорушення')).toEqual({
      radaId: '8073-10',
      articleNumber: '283',
    });
  });
});
