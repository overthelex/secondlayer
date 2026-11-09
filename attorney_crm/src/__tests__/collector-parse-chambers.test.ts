import fs from 'fs';
import path from 'path';
import {
  parseKrakowRadcy, parseKrakowKancelarie, parseOlsztynKancelarie, parseOpoleList, parseOpoleDetail,
  parseZielonaGoraKancelarie, parseSzczecinList, parseSzczecinDetail, parseRzeszowJson, personFromOfficeName, looseEntryKey,
} from '../collector/parse-chambers';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures/pl', f), 'utf8');

test('Kraków radca cards: name, KR number, contacts only where the radca filled them in', () => {
  const r = parseKrakowRadcy(fx('oirp-krakow-radcy-page1.html'));
  expect(r.lastPage).toBe(507);
  expect(r.rows).toHaveLength(10);
  expect(r.rows[1]).toEqual({ name: 'Marian ACHINGER', entryNumber: 'KR-652', phone: null, email: null });
  expect(r.rows[2]).toEqual({ name: 'Agata ADAMCZYK', entryNumber: 'KR-1363', phone: '+48124112277', email: 'a.adamczyk@adamczyk-law.pl' });
  // the test account on the chamber's site is not a radca
  expect(r.rows[0].entryNumber).toBe('123123K');
});

test('Kraków firm cards: kind, contacts, NIP, city and specialities', () => {
  const r = parseKrakowKancelarie(fx('oirp-krakow-kancelarie-page1.html'));
  expect(r.lastPage).toBe(67);
  expect(r.rows).toHaveLength(10);
  expect(r.rows[0]).toMatchObject({ name: 'GP Kancelaria Radców Prawnych Strzelec-Gwóźdź', kind: 'Spółka', phone: '+48122002525', email: 'kontakt@gpkancelaria.pl', website: 'https://gpkancelaria.pl', nip: '6762491695', city: 'Kraków' });
  expect(r.rows[0].tags).toContain('prawo gospodarcze (handlowe)');
  expect(r.rows[1]).toMatchObject({ name: 'Anna Poprawa Kancelaria Radcy Prawnego', kind: 'Kancelaria Radcy Prawnego' });
});

test('Olsztyn firm table: phones, e-mail hidden in the address cell, header row skipped', () => {
  const rows = parseOlsztynKancelarie(fx('oirp-olsztyn-kancelarie.html'));
  expect(rows).toHaveLength(7);
  expect(rows[0]).toMatchObject({ name: 'dr Karpińska-Głowcka Bogusława Kancelaria Radcy Prawnego', city: null, phone: '+48603451220', email: 'kancelaria.bkg@opoczta.pl' });
  expect(rows[1]).toMatchObject({ name: 'Lewicka Ewa Kancelaria Radcy Prawnego', city: 'Bartoszyce', phone: '+48897622204', phone2: '+48606829381', email: null, address: '11-200 Bartoszyce, ul. Grota-Roweckiego 1' });
  expect(rows[2]).toMatchObject({ email: 'u.skibicka@list.pl' });
  // "fax. 23 673 88 09" is not a second phone; the www goes to website
  expect(rows[5]).toMatchObject({ name: 'Grabowska Ewa-Kancelaria Radcy Prawnego', phone: '+48600270534', phone2: null, email: 'grabowska.radcaprawny@wp.pl', website: 'www.grabowska-radcaprawny.pl' });
});

test('Opole firm list and firm page', () => {
  const l = parseOpoleList(fx('oirp-opole-kancelarie-page1.html'));
  expect(l.lastPage).toBe(61);
  expect(l.rows).toHaveLength(10);
  expect(l.rows[2]).toEqual({ name: 'K.R.P., Waldemar Leśniewski', city: 'Opole', phone: '+48784022308', path: '/kancelarie/3' });
  expect(l.rows[0].phone).toBeNull();
  const d = parseOpoleDetail(fx('oirp-opole-kancelarie-10.html'));
  expect(d).toEqual({ name: 'K.R.P., Bogusława Kedzior & Partnerzy', address: 'Miodowa', city: 'Turawa-Marszałki', postcode: '46-045', phone: null, phone2: null, email: null, website: null });
});

test('Zielona Góra firm cards carry the radca name and entry number', () => {
  const rows = parseZielonaGoraKancelarie(fx('zielonagora-oirp-lista-kancelarii.html'));
  expect(rows).toHaveLength(6);
  expect(rows[0]).toEqual({ surname: 'Kunt', givenNames: 'Łukasz', entryNumberRaw: 'ZG/G/397', officeName: 'Kancelaria Prawa Handlowego i Gospodarczego Radca Prawny Łukasz Kunt', address: 'Osiedlowa 6a lok.9, 66-471 Kostrzyn nad Odrą', phone: '+48724419572', email: 'kamcelaria@kancelariakunt.pl', website: null });
  expect(rows[1]).toMatchObject({ surname: 'Kwietniowski', givenNames: 'Sławomir', entryNumberRaw: 'ZG ZG 500', phone: '+48684593606', email: 'kancelaria@kwietniowscy.pl', website: 'www.kwietniowscy.pl' });
  expect(rows[4]).toMatchObject({ surname: 'Siemienik-Kamieniarz', givenNames: 'Irena', entryNumberRaw: 'RZG/ZG/439' });
});

test('Szczecin tiles and firm page', () => {
  const l = parseSzczecinList(fx('oirp-szczecin-lista-kancelarii.html'));
  expect(l).toEqual([
    { url: 'https://oirp.szczecin.pl/kancelaria/pawel-kowalski-radca-prawny/', name: 'Paweł Kowalski', city: 'Szczecin' },
    { url: 'https://oirp.szczecin.pl/kancelaria/bakun-consulting/', name: 'Paweł Waldemar Bakun', city: 'SZCZECIN' },
    { url: 'https://oirp.szczecin.pl/kancelaria/kancelaria-prawna-kamil-zielinski/', name: 'Kamil Zieliński', city: 'Szczecin' },
  ]);
  const d = parseSzczecinDetail(fx('oirp-szczecin-kancelaria-pawel-kowalski.html'));
  // the chamber's own phone numbers in the footer must not be taken
  expect(d).toEqual({ officeName: 'Paweł Kowalski Radca Prawny', address: 'Andrzeja Małkowskiego 30/1, 70-304 Szczecin', postcode: '70-304', city: 'Szczecin', phone: '+48692597590', email: 'pkowalski@pk-radcaprawny.pl', website: 'https://pk-radcaprawny.pl', tags: ['prawo pracy (i zatrudnienia)', 'prawo spółek', 'prawo umów'] });
});

test('Rzeszów firm JSON', () => {
  const rows = parseRzeszowJson(fx('oirp-rzeszow-kancelaria.json'));
  expect(rows).toHaveLength(6);
  expect(rows[0]).toEqual({ name: 'Kancelaria Radcy Prawnego Anna Kostecka-Szyndak', kind: 'Kancelaria Radcy Prawnego', phone: '+48785345294', email: 'anna.kostecka-szyndak@o2.pl', website: null, address: 'ul. Wojska Polskiego 41 lok. 16', postcode: '38-400', city: 'Krosno' });
  expect(rows[3]).toMatchObject({ kind: 'Kancelaria Radców Prawnych', website: 'ammlegal.pl' });
  expect(rows[5]).toMatchObject({ phone: null, email: null });
});

test('personFromOfficeName: a one-person firm name yields both name orders, a multi-name firm yields nothing', () => {
  expect(personFromOfficeName('Kancelaria Radcy Prawnego Anna Kostecka-Szyndak')).toEqual([
    { surname: 'Kostecka-Szyndak', givenNames: 'Anna' }, { surname: 'Anna', givenNames: 'Kostecka-Szyndak' },
  ]);
  expect(personFromOfficeName('Lewicka Ewa Kancelaria Radcy Prawnego')).toEqual([{ surname: 'Ewa', givenNames: 'Lewicka' }, { surname: 'Lewicka', givenNames: 'Ewa' }]);
  expect(personFromOfficeName('K.R.P., Waldemar Leśniewski')).toEqual([{ surname: 'Leśniewski', givenNames: 'Waldemar' }, { surname: 'Waldemar', givenNames: 'Leśniewski' }]);
  expect(personFromOfficeName('dr Karpińska-Głowcka Bogusława Kancelaria Radcy Prawnego')).toEqual([{ surname: 'Bogusława', givenNames: 'Karpińska-Głowcka' }, { surname: 'Karpińska-Głowcka', givenNames: 'Bogusława' }]);
  expect(personFromOfficeName('Grabowska Ewa-Kancelaria Radcy Prawnego')).toEqual([{ surname: 'Ewa', givenNames: 'Grabowska' }, { surname: 'Grabowska', givenNames: 'Ewa' }]);
  expect(personFromOfficeName('"MW" Kancelaria Radcy Prawnego Radca Prawny Martyna Wawrzyńska')).toEqual([{ surname: 'Wawrzyńska', givenNames: 'Martyna' }, { surname: 'Martyna', givenNames: 'Wawrzyńska' }]);
  // three tokens: first-and-last orders plus "two given names" reading
  expect(personFromOfficeName('Kancelaria Radcy Prawnego Jan Maria Kowalski')).toEqual([
    { surname: 'Kowalski', givenNames: 'Jan Maria' }, { surname: 'Jan', givenNames: 'Maria Kowalski' },
  ]);
  expect(personFromOfficeName('Kancelaria Radców Prawnych N. Belcik-Stefańska i M. Jastrzębska')).toEqual([]);
  expect(personFromOfficeName('Kancelaria Radców Prawnych AM&M Legal Pukała, Polak sp.k.')).toEqual([]);
  expect(personFromOfficeName('GP Kancelaria Radców Prawnych Strzelec-Gwóźdź')).toEqual([]);
  expect(personFromOfficeName('Kancelaria Prawnicza ARITON (filia)')).toEqual([]);
  expect(personFromOfficeName('A. Sobczyk i Współpracownicy')).toEqual([]);
});

test('looseEntryKey: the chambers write the same number in several ways', () => {
  expect(looseEntryKey('ZG ZG 500', 'ZG')).toBe('ZGZG500');
  expect(looseEntryKey('R-ZG-ZG-690', 'ZG')).toBe('ZGZG690');
  expect(looseEntryKey('RZG/ZG/439', 'ZG')).toBe('ZGZG439');
  expect(looseEntryKey('KR-1363', 'KR')).toBe('KR1363');
  expect(looseEntryKey('kr 1363')).toBe('KR1363');
  expect(looseEntryKey('RZ-1176', 'RZ')).toBe('RZ1176');
});
