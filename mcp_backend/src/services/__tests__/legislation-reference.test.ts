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
      radaId: '435-15',
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
});
