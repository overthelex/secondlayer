import { html, raw } from '../views/html';
import { renderPage } from '../views/layout';
import { renderLogin } from '../views/login';

test('escapes interpolations, keeps raw(), joins arrays', () => {
  expect(String(html`<b>${'<i>&"\''}</b>`)).toBe('<b>&lt;i&gt;&amp;&quot;&#39;</b>');
  expect(String(html`${raw('<i>')}`)).toBe('<i>');
  expect(String(html`${[1, 2].map((n) => html`<li>${n}</li>`)}`)).toBe('<li>1</li><li>2</li>');
  expect(String(html`${null}${undefined}`)).toBe('');
});

test('nested html results are not double-escaped', () => {
  const inner = html`<em>${'a&b'}</em>`;
  expect(String(html`<p>${inner}</p>`)).toBe('<p><em>a&amp;b</em></p>');
});

test('layout carries the brand header, nav and the user menu', () => {
  const page = renderPage({ title: 'Адвокати', user: { id: 1, email: 'v@legal.org.ua', displayName: '' }, active: 'advocates', body: html`<p>x</p>` });
  expect(page).toContain('<title>Адвокати · legal.org.ua CRM</title>');
  expect(page).toContain('/static/logo-white.png');
  expect(page).toContain('href="/advocates"');
  expect(page).toContain('v@legal.org.ua');
  expect(page).toContain('action="/logout"');
  expect(page).toContain('fonts.googleapis.com');
});

test('login page has the form and shows the error', () => {
  const page = renderLogin({ error: 'Невірний e-mail або пароль' });
  expect(page).toContain('action="/login"');
  expect(page).toContain('name="email"');
  expect(page).toContain('name="password"');
  expect(page).toContain('Увійти');
  expect(page).toContain('Невірний e-mail або пароль');
  expect(renderLogin({})).not.toContain('class="error"');
});
