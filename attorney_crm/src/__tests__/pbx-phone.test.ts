import { formatE164, nationalPart, toDialable } from '../pbx/phone';

test('toDialable accepts the registry shapes and rejects the rest (UA)', () => {
  expect(toDialable('+38(050)500-51-34', '380')).toBe('380505005134');
  expect(toDialable('0505005134', '380')).toBe('380505005134');
  expect(toDialable('38 050 500 51 34', '380')).toBe('380505005134');
  expect(toDialable('00380505005134', '380')).toBe('380505005134');
  expect(toDialable('505005134', '380')).toBe('380505005134');
  expect(toDialable('044 123', '380')).toBeNull();
  expect(toDialable('+48 601 234 567', '380')).toBeNull();
  expect(toDialable('', '380')).toBeNull();
});

test('toDialable for the Polish tenant', () => {
  expect(toDialable('+48 601 234 567', '48')).toBe('48601234567');
  expect(toDialable('601234567', '48')).toBe('48601234567');
});

test('nationalPart and formatE164', () => {
  expect(nationalPart('380505005134', '380')).toBe('505005134');
  expect(formatE164('380505005134', '380')).toBe('+380 50 500 51 34');
  expect(formatE164('48601234567', '48')).toBe('+48 601 234 567');
});
