import fs from 'fs';
import path from 'path';
import { parseAdwokaciList, parseAdwokatDetail } from '../collector/parse-adwokaci';
import { parseRadcowieFragment } from '../collector/parse-radcowie';
import { parseCityPage, parseDirectoryProfile } from '../collector/parse-szukajradcy';
import { normaliseEntryNumber, normalisePhone, statusFromRaw } from '../collector/normalise';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures/pl', f), 'utf8');

test('adwokaci list page 1', () => {
  const r = parseAdwokaciList(fx('adwokaci-list-page1.html'));
  expect(r.rows).toHaveLength(100);
  expect(r.lastPage).toBe(352);
  expect(r.rows[0]).toMatchObject({ surname: 'Abłażewicz', givenNames: 'Agnieszka', city: 'Czechowice-Dziedzice', chamber: 'Katowice', statusRaw: 'Wykonujący zawód' });
  expect(r.rows[0].profileUrl).toMatch(/^https:\/\/rejestradwokatow\.pl\/adwokat\/[a-z0-9-]+-\d+$/);
  expect(r.rows[0].id).toMatch(/^\d+$/);
  expect(r.rows[1].givenNames).toBe('Dominik Witold');
});

test('adwokat detail without practices', () => {
  const d = parseAdwokatDetail(fx('adwokat-kowalski-jakub-82891.html'));
  expect(d).toMatchObject({ entryNumber: 'RAD/Adw/211', statusRaw: 'Wykonujący zawód', entryDate: '2018-05-23', officeName: 'Kancelaria Adwokacka', postcode: '26-900', city: 'Kozienice', phone: '512-017-377', email: null, practices: [] });
  expect(d.name).toBe('Kowalski Jakub');
  expect(d.address).toContain('Warszawska 34');
});

test('adwokat detail with practices', () => {
  const d = parseAdwokatDetail(fx('adwokat-adamczyk-andrzej-42384.html'));
  expect(d.entryNumber).toBe('WAW/Adw/4');
  expect(d.entryDate).toBe('1988-02-04');
  expect(d.phone).toBe('601355341');
  expect(d.email).toBe('adw.adamczyk@gmail.com');
  expect(d.name).toBe('Adamczyk Andrzej Wiktor');
  expect(d.practices).toEqual(['Praktyka ogólna', 'Prawo i postępowanie cywilne', 'Prawo i postępowanie karne', 'Prawo rodzinne i opiekuńcze', 'Prawo spadkowe']);
});

test('radcowie fragment', () => {
  const rows = parseRadcowieFragment(fx('radcowie-getdataw-stan1-page1.html'));
  expect(rows).toHaveLength(15);
  expect(rows[0]).toEqual({ surname: 'ABBATELLI', givenNames: 'WIOLETTA MARIOLA', entryNumber: 'WR-4293', chamber: 'OIRP WROCŁAW', city: 'WROCŁAW', statusRaw: 'Wykonuje zawód' });
});

test('szukajradcy city page and profile', () => {
  const city = parseCityPage(fx('szukajradcy-city-warszawa.html'));
  expect(city.profiles).toHaveLength(24);
  expect(city.profiles[0]).toMatch(/^https:\/\/szukajradcy\.pl\/lawyers\/rw_[0-9a-f]+$/);
  expect(city.lastPage).toBe(34);
  expect(city.pageParam).toBe('radcowie_page_warszawa');
  const p = parseDirectoryProfile(fx('szukajradcy-lawyer-adam-krukowski.html'));
  // the only tel: on the page is the KIRP footer, so phone must be null, not the chamber's number
  expect(p).toMatchObject({ name: 'Adam Krukowski', city: 'Katowice', email: 'kancelaria@krukowski.legal', phone: null, entryNumber: 'WA-17979', officeName: 'Kancelaria Radcy Prawnego Adam Krukowski', website: 'http://www.krukowski.legal' });
  expect(p.address).toBe('Żelazna 2, 40-851');
  expect(p.tags).toContain('zamówienia publiczne');
  expect(p.tags).toHaveLength(11);
});

test('normaliseEntryNumber', () => {
  expect(normaliseEntryNumber(' wa 17979 ')).toBe('WA-17979');
  expect(normaliseEntryNumber('WR-4293')).toBe('WR-4293');
  expect(normaliseEntryNumber('WAW/Adw/4')).toBe('WAW/ADW/4');
  expect(normaliseEntryNumber('')).toBeNull();
});

test('normalisePhone', () => {
  expect(normalisePhone('512-017-377')).toBe('+48512017377');
  expect(normalisePhone('48 362 57 40')).toBe('+48483625740');
  expect(normalisePhone('tel:+48223008640')).toBe('+48223008640');
  expect(normalisePhone('0048 22 300 86 40')).toBe('+48223008640');
  expect(normalisePhone('')).toBeNull();
});

test('statusFromRaw', () => {
  expect(statusFromRaw('adwokat', 'Wykonujący zawód')).toBe('active');
  expect(statusFromRaw('adwokat', 'Niewykonujący zawodu')).toBe('inactive');
  expect(statusFromRaw('adwokat', 'Były adwokat')).toBe('former');
  expect(statusFromRaw('radca', 'Wykonuje zawód')).toBe('active');
  expect(statusFromRaw('radca', 'Nie wykonuje zawodu')).toBe('inactive');
});

import { validIsoDate } from '../collector/normalise';

test('validIsoDate keeps real dates and drops the ones the register invents', () => {
  expect(validIsoDate('1988-02-04')).toBe('1988-02-04');
  expect(validIsoDate('0000-00-00')).toBeNull();
  expect(validIsoDate('2023-02-30')).toBeNull();
  expect(validIsoDate('2023-13-01')).toBeNull();
  expect(validIsoDate('04.02.1988')).toBeNull();
  expect(validIsoDate(null)).toBeNull();
});

test('a profile whose entry date is 0000-00-00 parses to a null date, not a value Postgres rejects', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/pl', 'adwokat-adamczyk-andrzej-42384.html'), 'utf8');
  expect(parseAdwokatDetail(html).entryDate).toBe('1988-02-04');
  expect(parseAdwokatDetail(html.replace('1988-02-04', '0000-00-00')).entryDate).toBeNull();
});
