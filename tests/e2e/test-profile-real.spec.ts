import { test, expect } from '@playwright/test';

test('Open profile page with real auth', async ({ page }) => {
  // Открываем главную страницу
  console.log('Opening https://dev.legal.org.ua...');
  await page.goto('https://dev.legal.org.ua');

  // Ждем загрузки
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  // Проверяем авторизацию
  const hasAuthToken = await page.evaluate(() => {
    const token = localStorage.getItem('auth_token');
    const user = localStorage.getItem('user');
    console.log('Has token:', !!token);
    console.log('Has user:', !!user);
    if (user) {
      console.log('User data:', JSON.parse(user));
    }
    return !!token && !!user;
  });

  console.log('Is authenticated:', hasAuthToken);

  if (!hasAuthToken) {
    console.log('⚠️  NOT AUTHENTICATED - You need to login with Google OAuth first');
    await page.screenshot({ path: 'not-authenticated.png' });
    return;
  }

  // Переходим на профиль
  console.log('Navigating to /profile...');
  await page.goto('https://dev.legal.org.ua/profile');

  // Ждем загрузки
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Проверяем что отображается
  const currentUrl = page.url();
  const pathname = await page.evaluate(() => window.location.pathname);

  console.log('Current URL:', currentUrl);
  console.log('Current pathname:', pathname);

  // Делаем скриншот
  await page.screenshot({ path: 'profile-real-auth.png', fullPage: true });
  console.log('Screenshot saved to profile-real-auth.png');

  // Проверяем содержимое
  const bodyText = await page.textContent('body');
  console.log('Page contains "Профіль":', bodyText?.includes('Профіль'));
  console.log('Page contains "Edit Profile":', bodyText?.includes('Edit Profile'));
  console.log('Page contains "Вход в систему":', bodyText?.includes('Вход в систему'));

  // Проверяем какая страница загружена
  const pageInfo = await page.evaluate(() => {
    const root = document.getElementById('root');
    const html = root?.innerHTML || '';
    return {
      isLoginPage: html.includes('Вход в систему') || html.includes('Войти через Google'),
      isProfilePage: html.includes('Edit Profile') || html.includes('Profile Information'),
      isChatPage: html.includes('Ласкаво просимо') || html.includes('Відповісти')
    };
  });

  console.log('Page detection:', pageInfo);

  // Ждем 5 секунд чтобы можно было посмотреть
  await page.waitForTimeout(5000);
});
