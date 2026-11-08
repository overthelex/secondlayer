import { setTenant, loadTenant } from '../tenant';
import { en } from '../i18n/en';
import { renderLogin } from '../views/login';
import { renderPage } from '../views/layout';
import { html } from '../views/html';
import { endOfLocalDay } from '../leads/repo';

afterEach(() => setTenant(loadTenant({})));

test('ua layout is unchanged', () => {
  const page = renderPage({ title: 'T', body: html`<p>x</p>` });
  expect(page).toContain('<html lang="uk">');
  expect(page).toContain('CRM адвокатів');
  expect(page).toContain('Сьогодні');
  expect(page).toContain('legal.org.ua CRM');
});

test('en strings flow through login when the tenant is English', () => {
  setTenant({ ...loadTenant({}), lang: 'en', strings: en, brand: { name: 'lawrider', domain: 'lawrider.pl', logo: 'logo-lawrider.png', mark: 'logo-lawrider.png', tagline: 'Lawyer CRM' } });
  const page = renderLogin({});
  expect(page).toContain('<html lang="en">');
  expect(page).toContain('Sign in');
  expect(page).not.toMatch(/[А-Яа-яІіЇїЄє]/);
});

test('endOfLocalDay respects the timezone', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  expect(endOfLocalDay(now, 'Europe/Kyiv').toISOString()).toBe('2026-11-08T22:00:00.000Z');
  expect(endOfLocalDay(now, 'Europe/Warsaw').toISOString()).toBe('2026-11-08T23:00:00.000Z');
});

test('the login mark and the favicon are the tenant brand, not the UA mark', () => {
  setTenant(loadTenant({ ATTORNEY_CRM_TENANT: 'pl' }));
  const page = renderLogin({});
  expect(page).toContain('src="/static/logo-lawrider.png"');
  expect(page).toContain('rel="icon" href="/static/logo-lawrider.png"');
  expect(page).not.toContain('favicon.svg');
  setTenant(loadTenant({}));
  const ua = renderLogin({});
  expect(ua).toContain('rel="icon" href="/static/favicon.svg"');
  expect(ua).toContain('class="login-mark" src="/static/favicon.svg"');
});
