import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES } from '../../router/routes';

// nginx.conf answers 404 for paths whose first segment is not in its
// $spa_route map. A route added to routes.ts without updating that map
// would get a 404 status (the page still renders, but crawlers drop it).
describe('nginx $spa_route map', () => {
  const conf = fs.readFileSync(path.resolve(__dirname, '../../../nginx.conf'), 'utf-8');
  const mapLine = conf.match(/~\^\/\(([^)]+)\)\(\/\|\$\) 1;/);
  const allowed = new Set((mapLine?.[1] ?? '').split('|'));

  it('has the prefix map', () => {
    expect(allowed.size).toBeGreaterThan(10);
  });

  it('covers every static first path segment in ROUTES', () => {
    const missing = new Set<string>();
    for (const route of Object.values(ROUTES) as string[]) {
      const first = route.split('/')[1];
      if (!first || first.startsWith(':')) continue;
      if (!allowed.has(first)) missing.add(first);
    }
    expect([...missing]).toEqual([]);
  });

  it('covers the languages used by /:lang/ legal routes', () => {
    for (const lang of ['ua', 'en']) expect(allowed.has(lang)).toBe(true);
  });
});
