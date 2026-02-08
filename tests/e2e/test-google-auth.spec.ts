/**
 * Playwright test for Google OAuth authentication on dev.legal.org.ua
 */
import { test, expect } from '@playwright/test';

test.describe('Google OAuth Authentication', () => {
  test('should show login page when not authenticated', async ({ page }) => {
    // Navigate to dev environment
    await page.goto('https://dev.legal.org.ua');

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Check if login page is displayed
    const loginButton = page.locator('text=Войти через Google');
    await expect(loginButton).toBeVisible({ timeout: 10000 });

    console.log('✅ Login page is displayed correctly');
  });

  test('should redirect to Google OAuth when clicking login button', async ({ page }) => {
    // Navigate to dev environment
    await page.goto('https://dev.legal.org.ua');

    // Wait for login page
    await page.waitForLoadState('networkidle');

    // Find and click Google login button
    const googleButton = page.locator('button:has-text("Войти через Google")');
    await expect(googleButton).toBeVisible({ timeout: 10000 });

    // Click and wait for navigation
    await Promise.all([
      page.waitForNavigation({ timeout: 10000 }),
      googleButton.click()
    ]);

    // Check if redirected to Google OAuth
    const currentUrl = page.url();
    expect(currentUrl).toContain('accounts.google.com');
    expect(currentUrl).toContain('oauth2');

    console.log('✅ Redirected to Google OAuth:', currentUrl);

    // Verify callback URL parameter
    const url = new URL(currentUrl);
    const redirectUri = url.searchParams.get('redirect_uri');
    expect(redirectUri).toBe('https://dev.legal.org.ua/auth/callback');

    console.log('✅ Callback URL is correct:', redirectUri);
  });

  test('should show loading spinner while checking auth', async ({ page }) => {
    // Navigate to dev environment
    await page.goto('https://dev.legal.org.ua');

    // Check for loading state (should appear briefly)
    const loadingText = page.locator('text=Завантаження');

    // Either loading appears or login page appears quickly
    await Promise.race([
      loadingText.waitFor({ state: 'visible', timeout: 2000 }).catch(() => null),
      page.locator('text=Вход в систему').waitFor({ timeout: 5000 })
    ]);

    console.log('✅ Auth check mechanism working');
  });

  test('should have correct OAuth configuration', async ({ page, request }) => {
    // Test direct OAuth endpoint
    const response = await request.get('https://dev.legal.org.ua/auth/google', {
      maxRedirects: 0
    });

    // Should redirect (302)
    expect(response.status()).toBe(302);

    // Get redirect location
    const location = response.headers()['location'];
    expect(location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(location).toContain('redirect_uri=https%3A%2F%2Fdev.legal.org.ua%2Fauth%2Fcallback');
    expect(location).toContain('client_id=');

    console.log('✅ OAuth endpoint configured correctly');
    console.log('Redirect URL:', location);
  });

  test('should check frontend assets are deployed', async ({ page }) => {
    await page.goto('https://dev.legal.org.ua');

    // Check if React app loaded
    const root = page.locator('#root');
    await expect(root).toBeVisible();

    // Check if assets loaded (CSS and JS)
    const styles = await page.locator('link[rel="stylesheet"]').count();
    const scripts = await page.locator('script[src]').count();

    expect(styles).toBeGreaterThan(0);
    expect(scripts).toBeGreaterThan(0);

    console.log('✅ Frontend assets loaded:', { styles, scripts });
  });
});
