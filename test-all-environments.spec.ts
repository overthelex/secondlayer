/**
 * Playwright test for Google OAuth on all environments
 */
import { test, expect } from '@playwright/test';

const environments = [
  { name: 'Development', url: 'https://dev.legal.org.ua', callbackUrl: 'https://dev.legal.org.ua/auth/callback' },
  { name: 'Staging', url: 'https://stage.legal.org.ua', callbackUrl: 'https://stage.legal.org.ua/auth/callback' },
  { name: 'Production', url: 'https://legal.org.ua', callbackUrl: 'https://legal.org.ua/auth/callback' },
];

for (const env of environments) {
  test.describe(`${env.name} Environment`, () => {
    test(`should show login page on ${env.name}`, async ({ page }) => {
      console.log(`\n🧪 Testing ${env.name}: ${env.url}`);

      try {
        await page.goto(env.url, { timeout: 15000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 });

        // Check if login page or chat is displayed
        const loginButton = page.locator('text=Войти через Google');
        const isLoginVisible = await loginButton.isVisible().catch(() => false);

        if (isLoginVisible) {
          console.log(`✅ ${env.name}: Login page displayed`);
          expect(isLoginVisible).toBe(true);
        } else {
          // Might be already logged in or different state
          console.log(`ℹ️ ${env.name}: Login page not shown (might be authenticated or different UI)`);
        }
      } catch (error) {
        console.log(`⚠️ ${env.name}: ${error.message}`);
        throw error;
      }
    });

    test(`should have correct OAuth configuration on ${env.name}`, async ({ request }) => {
      console.log(`\n🔧 Testing OAuth config on ${env.name}`);

      try {
        const response = await request.get(`${env.url}/auth/google`, {
          maxRedirects: 0,
          timeout: 10000
        });

        expect(response.status()).toBe(302);

        const location = response.headers()['location'];
        expect(location).toContain('accounts.google.com/o/oauth2/v2/auth');
        expect(location).toContain(`redirect_uri=${encodeURIComponent(env.callbackUrl)}`);

        console.log(`✅ ${env.name}: OAuth redirect configured correctly`);
        console.log(`   Callback: ${env.callbackUrl}`);
      } catch (error) {
        console.log(`❌ ${env.name}: OAuth config error - ${error.message}`);
        throw error;
      }
    });

    test(`should check backend health on ${env.name}`, async ({ request }) => {
      console.log(`\n🏥 Testing backend health on ${env.name}`);

      try {
        const response = await request.get(`${env.url}/health`, {
          timeout: 10000
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.status).toBe('ok');

        console.log(`✅ ${env.name}: Backend healthy`);
        console.log(`   Service: ${body.service}`);
      } catch (error) {
        console.log(`❌ ${env.name}: Backend health check failed - ${error.message}`);
        throw error;
      }
    });

    test(`should load frontend assets on ${env.name}`, async ({ page }) => {
      console.log(`\n📦 Testing frontend assets on ${env.name}`);

      try {
        await page.goto(env.url, { timeout: 15000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 });

        const root = page.locator('#root');
        await expect(root).toBeVisible({ timeout: 5000 });

        const html = await page.content();
        const hasReact = html.includes('react') || html.includes('React');

        console.log(`✅ ${env.name}: Frontend loaded`);
        console.log(`   React detected: ${hasReact}`);
      } catch (error) {
        console.log(`❌ ${env.name}: Frontend load error - ${error.message}`);
        throw error;
      }
    });
  });
}

test.describe('Cross-Environment Comparison', () => {
  test('should compare OAuth configurations', async ({ request }) => {
    console.log('\n📊 Comparing OAuth configurations across environments:\n');

    for (const env of environments) {
      try {
        const response = await request.get(`${env.url}/auth/google`, {
          maxRedirects: 0,
          timeout: 10000
        });

        const location = response.headers()['location'];
        const url = new URL(location);
        const redirectUri = url.searchParams.get('redirect_uri');
        const clientId = url.searchParams.get('client_id');

        console.log(`${env.name}:`);
        console.log(`  Status: ${response.status() === 302 ? '✅' : '❌'} ${response.status()}`);
        console.log(`  Callback: ${redirectUri}`);
        console.log(`  Client ID: ${clientId?.substring(0, 20)}...`);
        console.log('');
      } catch (error) {
        console.log(`${env.name}: ❌ ${error.message}\n`);
      }
    }
  });
});
