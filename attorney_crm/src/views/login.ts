import { html } from './html';
import { renderBare } from './layout';
import { tenant } from '../tenant';

export function renderLogin(o: { error?: string; email?: string }): string {
  const s = tenant().strings.login;
  return renderBare(
    s.title,
    html`<section class="card login">
  <img src="/static/favicon.svg" alt="" width="48" height="48" class="login-mark">
  <h1>${s.heading}</h1>
  ${o.error ? html`<p class="error" role="alert">${o.error}</p>` : ''}
  <form method="post" action="/login" class="form">
    <label>${s.email}<input type="email" name="email" value="${o.email ?? ''}" required autocomplete="username" autofocus></label>
    <label>${s.password}<input type="password" name="password" required autocomplete="current-password"></label>
    <button type="submit" class="btn btn-primary">${s.submit}</button>
  </form>
</section>`,
  );
}
