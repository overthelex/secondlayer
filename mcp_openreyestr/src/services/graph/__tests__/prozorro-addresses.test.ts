/**
 * ProZorro supplier address -> ЄДР-layout raw address (LEXAI-2317). Synthetic addresses only.
 */
import { normAddress } from '../../graph-norm/address';
import { composeProzorroAddress } from '../prozorro-addresses';

const cityKey = (oblast: string, city: string) => normAddress(`Україна, ${oblast}, місто ${city}, вулиця Тестова, будинок 1`).settlementKey!;
const CITIES = new Set([cityKey('Львівська обл.', 'Львів'), cityKey('', 'Київ')]);
const key = (r: string | null) => (r ? normAddress(r).addressKey : null);

describe('composeProzorroAddress', () => {
  it('builds the ЄДР layout from the OCDS region / locality / streetAddress', () => {
    const c = composeProzorroAddress('Львівська область', 'м. Львів', 'вул. Тестова, 5', null);
    expect(c.status).toBe('ok');
    expect(key(c.raw)).toBe(key('Україна, 79000, Львівська обл., місто Львів, ВУЛИЦЯ ТЕСТОВА, будинок 5'));
  });

  it('reads a bare locality as a city only when the ЄДР knows that city in the oblast', () => {
    const c = composeProzorroAddress('Львівська область', 'Львів', 'вул. Тестова, 5', CITIES);
    expect(c.status).toBe('ok');
    expect(c.raw).toContain('м. Львів');
    // unknown bare locality: not a city, no postcode -> no usable key
    expect(composeProzorroAddress('Львівська область', 'Тестівка', 'вул. Тестова, 5', CITIES).status).not.toBe('ok');
    // without the city list nothing is assumed
    expect(composeProzorroAddress('Львівська область', 'Львів', 'вул. Тестова, 5', null).status).not.toBe('ok');
  });

  it('assumes вулиця for a street written without its type', () => {
    const c = composeProzorroAddress('м. Київ', 'Київ', 'Тестова, 5', CITIES);
    expect(c.status).toBe('ok');
    expect(key(c.raw)).toBe(key('Україна, 01001, місто Київ, ВУЛИЦЯ ТЕСТОВА, будинок 5'));
  });

  it('splits the comma-less layout of the newer extracts', () => {
    const c = composeProzorroAddress('Львівська область', null, 'Тестовий р-н місто Львів вул.Тестова будинок 7 офіс 2', null);
    expect(c.status).toBe('ok');
    expect(key(c.raw)).toBe(key('Україна, 79000, Львівська обл., місто Львів, вулиця Тестова, будинок 7'));
  });

  it('keeps a village only with a postcode (village keys include it)', () => {
    expect(composeProzorroAddress('Київська область', 'село Тестове', 'вул. Садова, 1', null).status).toBe('village_no_postcode');
    const c = composeProzorroAddress('Київська область', 'село Тестове', '08000, вул. Садова, 1', null);
    expect(c.status).toBe('ok');
    expect(normAddress(c.raw).settlementKey).toMatch(/\|08000$/);
  });

  it('skips addresses without a street, a building or an oblast', () => {
    expect(composeProzorroAddress('Львівська область', 'м. Львів', null, null)).toEqual({ raw: null, status: 'no_street' });
    expect(composeProzorroAddress('Львівська область', 'м. Львів', 'Інформація відсутня', null).status).toBe('no_key');
    expect(composeProzorroAddress(null, 'м. Тестополь', 'вул. Тестова, 5', null).status).toBe('no_oblast');
  });

  it('cuts 10-digit runs (phones, РНОКПП) and escaped line breaks from the text', () => {
    const c = composeProzorroAddress('м. Київ', 'м. Київ', 'вул. Тестова, 5, тел. 0441234567\\r\\n', null);
    expect(c.status).toBe('ok');
    expect(c.raw).not.toMatch(/[0-9]{10}/);
    expect(c.raw).not.toMatch(/\\r/);
  });
});
