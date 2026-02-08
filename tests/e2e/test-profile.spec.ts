import { test, expect } from '@playwright/test';

test('Check profile page routing', async ({ page }) => {
  // Установим токен и данные пользователя из логов
  await page.goto('https://dev.legal.org.ua');

  // Установим auth token из localStorage
  await page.evaluate(() => {
    localStorage.setItem('auth_token', 'test-token');
    localStorage.setItem('user', JSON.stringify({
      id: '3e9acb68-2671-4e13-93d9-36dd18b7e0d4',
      email: 'shepherdvovkes@gmail.com',
      name: 'vovkes shepherd',
      emailVerified: true
    }));
  });

  // Перезагрузим страницу с токеном
  await page.reload();

  // Подождем загрузки
  await page.waitForLoadState('networkidle');

  // Перейдем на профиль
  console.log('Navigating to /profile...');
  await page.goto('https://dev.legal.org.ua/profile');

  // Подождем загрузки
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Проверим URL
  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  // Проверим pathname через evaluate
  const pathname = await page.evaluate(() => window.location.pathname);
  console.log('Current pathname:', pathname);

  // Сделаем скриншот
  await page.screenshot({ path: 'profile-page-screenshot.png', fullPage: true });
  console.log('Screenshot saved to profile-page-screenshot.png');

  // Проверим что на странице
  const bodyText = await page.textContent('body');
  console.log('Page contains "Профіль":', bodyText?.includes('Профіль'));
  console.log('Page contains "Чат":', bodyText?.includes('Чат'));
  console.log('Page contains "Edit Profile":', bodyText?.includes('Edit Profile'));

  // Получим HTML title
  const title = await page.title();
  console.log('Page title:', title);

  // Проверим структуру React Router
  const reactRouterInfo = await page.evaluate(() => {
    const rootElement = document.getElementById('root');
    return {
      hasRoot: !!rootElement,
      rootHTML: rootElement?.innerHTML?.substring(0, 500)
    };
  });
  console.log('React Router info:', reactRouterInfo);
});
