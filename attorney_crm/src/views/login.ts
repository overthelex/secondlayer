import { html } from './html';
import { renderBare } from './layout';

export function renderLogin(o: { error?: string; email?: string }): string {
  return renderBare(
    'Вхід',
    html`<section class="card login">
  <img src="/static/favicon.svg" alt="" width="48" height="48" class="login-mark">
  <h1>Вхід для менеджерів</h1>
  ${o.error ? html`<p class="error" role="alert">${o.error}</p>` : ''}
  <form method="post" action="/login" class="form">
    <label>E-mail<input type="email" name="email" value="${o.email ?? ''}" required autocomplete="username" autofocus></label>
    <label>Пароль<input type="password" name="password" required autocomplete="current-password"></label>
    <button type="submit" class="btn btn-primary">Увійти</button>
  </form>
</section>`,
  );
}
