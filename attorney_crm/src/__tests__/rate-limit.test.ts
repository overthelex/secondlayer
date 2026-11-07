import { LoginRateLimit } from '../auth/rate-limit';

test('10 failures within 15 minutes block the next attempt', () => {
  const rl = new LoginRateLimit();
  const t0 = 1_000_000;
  for (let i = 0; i < 9; i++) rl.recordFailure('A@x', t0 + i * 1000);
  expect(rl.isBlocked('a@x', t0 + 10_000)).toBe(false);
  rl.recordFailure('a@x', t0 + 10_000);
  expect(rl.isBlocked('a@x', t0 + 11_000)).toBe(true);
});

test('failures older than the window do not count', () => {
  const rl = new LoginRateLimit();
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) rl.recordFailure('a@x', t0 + i * 1000);
  expect(rl.isBlocked('a@x', t0 + 15 * 60 * 1000 + 10_000)).toBe(false);
});

test('reset unblocks', () => {
  const rl = new LoginRateLimit();
  for (let i = 0; i < 10; i++) rl.recordFailure('a@x', 5000 + i);
  expect(rl.isBlocked('a@x', 6000)).toBe(true);
  rl.reset('a@x');
  expect(rl.isBlocked('a@x', 6000)).toBe(false);
});
