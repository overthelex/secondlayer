import { hashPassword, verifyPassword } from '../auth/password';

test('hash has the documented shape and verifies', async () => {
  const h = await hashPassword('correct horse');
  expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
  expect(h.split('$')).toHaveLength(6);
  expect(await verifyPassword('correct horse', h)).toBe(true);
  expect(await verifyPassword('wrong', h)).toBe(false);
});

test('two hashes of the same password differ (random salt)', async () => {
  expect(await hashPassword('x')).not.toEqual(await hashPassword('x'));
});

test('malformed stored hash verifies false', async () => {
  expect(await verifyPassword('x', 'garbage')).toBe(false);
  expect(await verifyPassword('x', 'scrypt$1$1$1$AAAA$BBBB')).toBe(false);
  expect(await verifyPassword('x', '')).toBe(false);
});
