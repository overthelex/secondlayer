import { signUnsubscribeToken, verifyUnsubscribeToken, normaliseEmail } from '../mail/token';
import { unsubscribeHeaders, unsubscribeUrl } from '../mail/headers';

const secret = 'test-secret';

test('a signed token verifies back to the normalised address', () => {
  const token = signUnsubscribeToken(secret, '  Ivan.Petrenko@Example.UA ');
  expect(verifyUnsubscribeToken(secret, token)).toBe('ivan.petrenko@example.ua');
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('a token signed with another secret, a tampered address or garbage is rejected', () => {
  const token = signUnsubscribeToken(secret, 'a@b.ua');
  expect(verifyUnsubscribeToken('other', token)).toBeNull();
  const [, mac] = token.split('.');
  expect(verifyUnsubscribeToken(secret, `${Buffer.from('c@b.ua').toString('base64url')}.${mac}`)).toBeNull();
  expect(verifyUnsubscribeToken(secret, 'nodot')).toBeNull();
  expect(verifyUnsubscribeToken(secret, '.x')).toBeNull();
  expect(verifyUnsubscribeToken(secret, `${token}!`)).toBeNull();
  expect(verifyUnsubscribeToken(secret, undefined)).toBeNull();
  expect(verifyUnsubscribeToken(secret, 'a'.repeat(600))).toBeNull();
});

test('normaliseEmail trims and lower-cases', () => {
  expect(normaliseEmail(' X@Y.Z ')).toBe('x@y.z');
});

test('List-Unsubscribe carries mailto and https targets plus the one-click marker', () => {
  const cfg = { publicUrl: 'https://attorney.legal.org.ua/', mailbox: 'unsubscribe@legal.org.ua', secret };
  const h = unsubscribeHeaders(cfg, 'a@b.ua');
  const token = signUnsubscribeToken(secret, 'a@b.ua');
  expect(h['List-Unsubscribe']).toBe(`<mailto:unsubscribe@legal.org.ua?subject=unsubscribe%20${token}>, <https://attorney.legal.org.ua/u/${token}>`);
  expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  expect(unsubscribeUrl(cfg, 'a@b.ua')).toBe(`https://attorney.legal.org.ua/u/${token}`);
});
