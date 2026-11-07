import { emailList, orgList, phoneList, splitContacts, telHref } from '../views/contacts';

test('splits on commas and semicolons, trims, drops duplicates ignoring formatting', () => {
  expect(splitContacts('+38(050)500-51-34, +38(050)500-51-34')).toEqual(['+38(050)500-51-34']);
  expect(splitContacts('+38(067)536-18-55, +38(044)536-21-55')).toEqual(['+38(067)536-18-55', '+38(044)536-21-55']);
  expect(splitContacts('a@x.ua; A@x.ua, b@x.ua')).toEqual(['a@x.ua', 'b@x.ua']);
  expect(splitContacts(null)).toEqual([]);
  expect(splitContacts('  ')).toEqual([]);
});

test('tel: href keeps only digits and the plus', () => {
  expect(telHref('+38(050)500-51-34')).toBe('tel:+380505005134');
  expect(telHref('38 050 500 51 34')).toBe('tel:+380505005134');
});

test('phone and e-mail lists render one clickable item each, e-mails must contain @', () => {
  const phones = String(phoneList('+38(050)1-11-11, +38(050)1-11-11, +38(044)2-22-22'));
  expect(phones.match(/href="tel:/g)).toHaveLength(2);
  expect(phones).toContain('href="tel:+3805011111"');
  const mails = String(emailList('a@x.ua, not-an-email, <b@x.ua>'));
  expect(mails.match(/href="mailto:/g)).toHaveLength(2);
  expect(mails).toContain('&lt;b@x.ua&gt;');
  expect(String(phoneList(null))).toBe('');
});

test('organisations split on the semicolon into lines', () => {
  expect(String(orgList('Адвокатське бюро X; Адвокатське об\'єднання Y'))).toBe(
    '<span class="line">Адвокатське бюро X</span><span class="line">Адвокатське об&#39;єднання Y</span>',
  );
  expect(String(orgList(null))).toBe('');
});
