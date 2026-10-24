/**
 * LEXAI-2105: DATE columns must come back as the 'YYYY-MM-DD' text PostgreSQL sent,
 * not as a JS Date at local midnight (which JSON-serialises a day early east of UTC).
 * TIMESTAMP / TIMESTAMPTZ stay real instants (Date).
 */
import { types } from 'pg';
import { PG_DATE_OID, registerPgTypeParsers } from '../src/database/pg-type-parsers';
import '../src/database/base-database';

const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;

describe('pg type parsers', () => {
  it('importing the shared database layer registers the DATE parser', () => {
    const parse = types.getTypeParser(PG_DATE_OID, 'text');
    expect(parse('2017-12-15')).toBe('2017-12-15');
    expect(parse('2026-06-30')).toBe('2026-06-30');
  });

  it('a DATE row value serialises to JSON unchanged', () => {
    const row = { opening_date: types.getTypeParser(PG_DATE_OID, 'text')('2017-12-15') };
    expect(JSON.stringify(row)).toBe('{"opening_date":"2017-12-15"}');
  });

  it('leaves TIMESTAMPTZ and TIMESTAMP parsed as Date', () => {
    const tz = types.getTypeParser(TIMESTAMPTZ_OID, 'text')('2017-12-15 10:30:00+02');
    expect(tz).toBeInstanceOf(Date);
    expect((tz as Date).toISOString()).toBe('2017-12-15T08:30:00.000Z');
    expect(types.getTypeParser(TIMESTAMP_OID, 'text')('2017-12-15 10:30:00')).toBeInstanceOf(Date);
  });

  it('registers on the registry a service passes in (its own pg copy)', () => {
    const setTypeParser = jest.fn();
    registerPgTypeParsers({ setTypeParser });
    expect(setTypeParser).toHaveBeenCalledTimes(1);
    expect(setTypeParser.mock.calls[0][0]).toBe(1082);
    expect(setTypeParser.mock.calls[0][1]('1999-01-02')).toBe('1999-01-02');
  });
});
