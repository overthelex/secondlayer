import { test, expect } from '@playwright/test';

test('Login to dev environment with admin:admin123', async ({ page }) => {
  // Открываем dev окружение
  await page.goto('https://dev.legal.org.ua');

  // Ждем загрузки страницы
  await page.waitForLoadState('networkidle');

  // Делаем скриншот начальной страницы
  await page.screenshot({ path: 'dev-initial-page.png', fullPage: true });
  console.log('Initial page screenshot saved');

  // Ищем поля для логина
  const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  const loginButton = page.locator('button:has-text("Войти"), button:has-text("Login"), button[type="submit"]').first();

  // Проверяем, что поля существуют
  await expect(emailInput).toBeVisible({ timeout: 5000 });
  await expect(passwordInput).toBeVisible({ timeout: 5000 });

  console.log('Login form found');

  // Вводим данные
  await emailInput.fill('admin');
  await passwordInput.fill('admin123');

  // Скриншот перед отправкой формы
  await page.screenshot({ path: 'dev-before-login.png', fullPage: true });
  console.log('Before login screenshot saved');

  // Нажимаем кнопку входа
  await loginButton.click();

  // Ждем навигации или ответа
  await page.waitForTimeout(3000);

  // Скриншот после логина
  await page.screenshot({ path: 'dev-after-login.png', fullPage: true });
  console.log('After login screenshot saved');

  // Проверяем URL или наличие элементов после логина
  const currentUrl = page.url();
  console.log('Current URL after login:', currentUrl);

  // Проверяем, есть ли индикаторы успешного входа
  const isLoggedIn = await page.locator('[data-testid="user-menu"], .user-profile, text=/Profile|Профиль|Logout|Выйти/i').count() > 0;

  if (isLoggedIn) {
    console.log('✅ Login successful!');
  } else {
    console.log('❌ Login may have failed or page structure is different');

    // Ищем сообщения об ошибке
    const errorMessage = await page.locator('.error, .alert, [role="alert"]').textContent().catch(() => null);
    if (errorMessage) {
      console.log('Error message:', errorMessage);
    }
  }

  // Получаем HTML страницы для анализа
  const pageContent = await page.content();
  console.log('Page title:', await page.title());
});
