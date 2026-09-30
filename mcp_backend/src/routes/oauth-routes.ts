/**
 * OAuth 2.0 Routes for MCP Server
 * Implements Authorization Code Flow for ChatGPT integration
 *
 * Endpoints:
 * - GET /oauth/authorize - Authorization endpoint (user consent)
 * - POST /oauth/token - Token endpoint (exchange code for token)
 * - GET /oauth/authorize-form - HTML form for user login
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import passport from 'passport';
import { OAuthService } from '../services/oauth-service.js';
import { logger } from '../utils/logger.js';
import bcrypt from 'bcryptjs';
import { getUserService } from '../middleware/dual-auth.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/</g, '\\x3c')
    .replace(/>/g, '\\x3e');
}

export function createOAuthRouter(oauthService: OAuthService): Router {
  const router = Router();
  const userService = getUserService();

  /**
   * GET /oauth/authorize
   * Authorization endpoint - initiates OAuth flow
   *
   * Query params:
   * - response_type: must be "code"
   * - client_id: OAuth client identifier
   * - redirect_uri: where to redirect after authorization
   * - scope: requested permissions (optional)
   * - state: CSRF protection token (recommended)
   */
  router.get('/authorize', async (req: Request, res: Response) => {
    try {
      const {
        response_type,
        client_id,
        redirect_uri,
        scope = 'mcp',
        state,
        code_challenge,
        code_challenge_method,
      } = req.query;

      // Validate required parameters
      if (!response_type || response_type !== 'code') {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'response_type must be "code"',
        });
      }

      if (!client_id || typeof client_id !== 'string') {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'client_id is required',
        });
      }

      if (!redirect_uri || typeof redirect_uri !== 'string') {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri is required',
        });
      }

      // Verify client exists
      const client = await oauthService.getClient(client_id);
      if (!client) {
        return res.status(401).json({
          error: 'invalid_client',
          error_description: 'Client not found',
        });
      }

      // Validate redirect URI
      const isValidRedirect = await oauthService.validateRedirectUri(client_id, redirect_uri);
      if (!isValidRedirect) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Invalid redirect_uri for this client',
        });
      }

      // Render authorization form with modern design. OAUTH_BRAND=lawrider (mcp.lawrider.uk)
      // shows LawRider in English and hides Google sign-in, which is registered for
      // legal.org.ua only.
      const lawrider = process.env.OAUTH_BRAND === 'lawrider';
      const brand = lawrider
        ? { title: 'LawRider MCP - Authorization', subtitle: 'LawRider (mcp.lawrider.uk) — sign in to connect', or: 'or', google: 'Sign in with Google', showGoogle: false }
        : { title: 'SecondLayer MCP - Authorization', subtitle: 'MCP legal.org.ua — OAuth2 Authorization', or: 'або', google: 'Увійти через Google', showGoogle: true };
      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brand.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      min-height: 100vh;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
      padding: 20px;
    }

    /* Full-page background image */
    .background {
      position: absolute;
      inset: 0;
      background-image: url('https://cdn.magicpatterns.com/uploads/94NC27nbdKFZJnUMAiJT3K/BACK2.png');
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      z-index: 0;
    }

    /* Subtle overlay for readability */
    .overlay {
      position: absolute;
      inset: 0;
      background-color: rgba(255, 255, 255, 0.15);
      backdrop-filter: blur(2px);
      z-index: 1;
    }

    /* White card with login form */
    .container {
      position: relative;
      z-index: 2;
      width: 100%;
      max-width: 480px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(20px);
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255, 255, 255, 0.5);
      padding: 40px;
    }

    .header {
      margin-bottom: 32px;
    }

    h1 {
      color: #1a1a1a;
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .subtitle {
      color: #6b7280;
      font-size: 15px;
      line-height: 1.5;
    }

    .client-info {
      background: #f9fafb;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 28px;
      border-left: 4px solid #1a1a1a;
    }

    .client-info strong {
      color: #374151;
      display: block;
      margin-bottom: 6px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    .client-info span {
      color: #1a1a1a;
      font-weight: 700;
      font-size: 15px;
    }

    .form-group {
      margin-bottom: 24px;
    }

    label {
      display: block;
      color: #333;
      font-weight: 600;
      margin-bottom: 8px;
      font-size: 13px;
    }

    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      font-size: 15px;
      background: #f9fafb;
      transition: all 0.15s ease;
    }

    input[type="email"]:hover,
    input[type="password"]:hover {
      border-color: #d1d5db;
    }

    input[type="email"]:focus,
    input[type="password"]:focus {
      outline: none;
      border-color: #1a1a1a;
      background: #ffffff;
    }

    input::placeholder {
      color: #9ca3af;
    }

    button {
      width: 100%;
      padding: 14px;
      background: #000;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      transition: all 0.15s ease;
    }

    button:hover:not(:disabled) {
      background: #333;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
      transform: translateY(-1px);
    }

    button:active:not(:disabled) {
      transform: translateY(0);
    }

    button:disabled {
      background: #666;
      cursor: not-allowed;
    }

    .error {
      background: #fef2f2;
      color: #dc2626;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
      border-left: 4px solid #dc2626;
    }

    .divider {
      display: flex;
      align-items: center;
      margin: 24px 0;
      color: #9ca3af;
      font-size: 13px;
    }

    .divider::before,
    .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e5e7eb;
    }

    .divider span {
      padding: 0 12px;
    }

    .google-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 12px;
      background: #fff;
      color: #374151;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.15s ease;
    }

    .google-btn:hover {
      background: #f9fafb;
      border-color: #d1d5db;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    }

    .footer {
      text-align: center;
      margin-top: 24px;
      color: #9ca3af;
      font-size: 12px;
    }

    @media (max-width: 640px) {
      .container {
        padding: 28px;
      }

      h1 {
        font-size: 28px;
      }
    }
  </style>
</head>
<body>
  <div class="background"></div>
  <div class="overlay"></div>

  <div class="container">
    <div class="header">
      <h1>Welcome back</h1>
      <p class="subtitle">${brand.subtitle}</p>
    </div>

    <div class="client-info">
      <strong>Application requesting access</strong>
      <span>${escapeHtml(client.name)}</span>
    </div>

    <div id="error" class="error"></div>

    <form id="authForm" onsubmit="handleSubmit(event)">
      <div class="form-group">
        <label for="email">Email</label>
        <input
          type="email"
          id="email"
          name="email"
          placeholder="Email Address"
          required
          autocomplete="email"
        />
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input
          type="password"
          id="password"
          name="password"
          placeholder="Password 8-16 characters"
          required
          autocomplete="current-password"
        />
      </div>

      <button type="submit" id="submitBtn">
        Authorize Access
      </button>
    </form>

    ${brand.showGoogle ? '' : '<!--'}
    <div class="divider"><span>${brand.or}</span></div>

    <a id="googleBtn" class="google-btn" href="#">
      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
        <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
        <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 2.58 9 2.58z" fill="#EA4335"/>
      </svg>
      ${brand.google}
    </a>
    ${brand.showGoogle ? '' : '-->'}

    <div class="footer">
      Secure OAuth 2.0 Authentication
    </div>
  </div>

  <script>
    // Build Google OAuth link with MCP params
    (function() {
      const params = new URLSearchParams({
        client_id: '${escapeJsString(String(client_id))}',
        redirect_uri: '${escapeJsString(String(redirect_uri))}',
        scope: '${escapeJsString(String(scope))}',
        state: '${escapeJsString(String(state || ''))}',
        code_challenge: '${escapeJsString(String(code_challenge || ''))}',
        code_challenge_method: '${escapeJsString(String(code_challenge_method || ''))}',
      });
      const googleBtn = document.getElementById('googleBtn');
      if (googleBtn) googleBtn.href = '/oauth/google?' + params.toString();
    })();

    async function handleSubmit(event) {
      event.preventDefault();

      const submitBtn = document.getElementById('submitBtn');
      const errorDiv = document.getElementById('error');
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;

      // Disable button
      submitBtn.disabled = true;
      submitBtn.textContent = 'Authorizing...';
      errorDiv.style.display = 'none';

      try {
        const response = await fetch('/oauth/authorize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email,
            password,
            client_id: '${escapeJsString(String(client_id))}',
            redirect_uri: '${escapeJsString(String(redirect_uri))}',
            scope: '${escapeJsString(String(scope))}',
            state: '${escapeJsString(String(state || ''))}',
            code_challenge: '${escapeJsString(String(code_challenge || ''))}',
            code_challenge_method: '${escapeJsString(String(code_challenge_method || ''))}',
          }),
        });

        const data = await response.json();

        if (response.ok && data.redirect_url) {
          // Success - redirect to ChatGPT
          window.location.href = data.redirect_url;
        } else {
          // Error
          errorDiv.textContent = data.error_description || 'Authentication failed';
          errorDiv.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Authorize Access';
        }
      } catch (error) {
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Authorize Access';
      }
    }
  </script>
</body>
</html>
      `;

      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error: any) {
      logger.error('Error in /oauth/authorize GET:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error',
      });
    }
  });

  /**
   * POST /oauth/authorize
   * Process authorization form submission
   */
  router.post('/authorize', async (req: Request, res: Response) => {
    try {
      const {
        email,
        password,
        client_id,
        redirect_uri,
        scope = 'mcp',
        state,
        code_challenge,
        code_challenge_method,
      } = req.body;

      // Validate inputs
      if (!email || !password || !client_id || !redirect_uri) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing required parameters',
        });
      }

      // Verify client
      const client = await oauthService.getClient(client_id);
      if (!client) {
        return res.status(401).json({
          error: 'invalid_client',
          error_description: 'Client not found',
        });
      }

      // Validate redirect URI
      const isValidRedirect = await oauthService.validateRedirectUri(client_id, redirect_uri);
      if (!isValidRedirect) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Invalid redirect_uri',
        });
      }

      // Authenticate user
      const user = await userService.findByEmail(email);
      if (!user) {
        return res.status(401).json({
          error: 'access_denied',
          error_description: 'Invalid email or password',
        });
      }

      // Verify password
      if (!user.password_hash) {
        return res.status(401).json({
          error: 'access_denied',
          error_description: 'Password authentication not enabled for this account',
        });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password_hash);
      if (!isPasswordValid) {
        return res.status(401).json({
          error: 'access_denied',
          error_description: 'Invalid email or password',
        });
      }

      // Generate authorization code
      const code = await oauthService.createAuthorizationCode({
        clientId: client_id,
        userId: user.id,
        redirectUri: redirect_uri,
        scope,
        codeChallenge: code_challenge || undefined,
        codeChallengeMethod: code_challenge_method || undefined,
      });

      // Build redirect URL
      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set('code', code);
      if (state) {
        redirectUrl.searchParams.set('state', state);
      }

      logger.info('Authorization granted', {
        userId: user.id,
        email: user.email,
        clientId: client_id,
      });

      // Return redirect URL (for AJAX submission)
      res.json({
        redirect_url: redirectUrl.toString(),
      });
    } catch (error: any) {
      logger.error('Error in /oauth/authorize POST:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error',
      });
    }
  });

  /**
   * POST /oauth/token
   * Token endpoint - exchange authorization code for access token
   *
   * Request body:
   * - grant_type: must be "authorization_code"
   * - code: authorization code from /oauth/authorize
   * - redirect_uri: must match the one used in /oauth/authorize
   * - client_id: OAuth client identifier
   * - client_secret: OAuth client secret
   */
  router.post('/token', async (req: Request, res: Response) => {
    try {
      logger.info('Token request received', {
        contentType: req.headers['content-type'],
        bodyKeys: Object.keys(req.body || {}),
        hasClientSecret: !!req.body?.client_secret,
        hasCodeVerifier: !!req.body?.code_verifier,
        clientId: req.body?.client_id,
      });

      const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } = req.body;

      // Validate grant_type
      if (grant_type !== 'authorization_code') {
        return res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'Only authorization_code grant type is supported',
        });
      }

      // Validate required parameters (client_secret optional when using PKCE with code_verifier)
      if (!code || !redirect_uri || !client_id) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing required parameters',
        });
      }

      // Verify client: when PKCE code_verifier is present, skip secret check
      // (the code_verifier proves client identity via the code_challenge)
      if (client_secret && !code_verifier) {
        const isValidClient = await oauthService.verifyClient(client_id, client_secret);
        if (!isValidClient) {
          return res.status(401).json({
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          });
        }
      } else {
        // PKCE flow or no secret — just verify client exists
        const client = await oauthService.getClient(client_id);
        if (!client) {
          return res.status(401).json({
            error: 'invalid_client',
            error_description: 'Client not found',
          });
        }
      }

      // Exchange code for token
      const tokenData = await oauthService.exchangeCodeForToken({
        code,
        clientId: client_id,
        redirectUri: redirect_uri,
        codeVerifier: code_verifier || undefined,
      });

      if (!tokenData) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid or expired authorization code',
        });
      }

      logger.info('Access token issued', {
        clientId: client_id,
      });

      // Return access token
      res.json({
        access_token: tokenData.accessToken,
        token_type: tokenData.tokenType,
        expires_in: tokenData.expiresIn,
      });
    } catch (error: any) {
      logger.error('Error in /oauth/token:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error',
      });
    }
  });

  /**
   * GET /oauth/token
   * Handle GET requests to token endpoint (should be POST)
   * Returns error indicating that POST method is required
   */
  router.get('/token', (req: Request, res: Response) => {
    res.status(405).json({
      error: 'invalid_request',
      error_description: 'Token endpoint only accepts POST requests. Please use POST method with application/x-www-form-urlencoded or application/json content type.',
    });
  });

  /**
   * POST /oauth/revoke
   * Revoke an access token
   */
  router.post('/revoke', async (req: Request, res: Response) => {
    try {
      const { token, client_id, client_secret } = req.body;

      if (!token) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'token is required',
        });
      }

      // Verify client if provided
      if (client_id && client_secret) {
        const isValidClient = await oauthService.verifyClient(client_id, client_secret);
        if (!isValidClient) {
          return res.status(401).json({
            error: 'invalid_client',
          });
        }
      }

      // Revoke token
      await oauthService.revokeAccessToken(token);

      logger.info('Access token revoked', { token: token.substring(0, 10) + '...' });

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error in /oauth/revoke:', error);
      res.status(500).json({
        error: 'server_error',
      });
    }
  });

  // Rate limit for dynamic client registration (RFC 7591) — prevent abuse
  const registrationRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // max 5 registrations per IP per 15 minutes
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: 'Too many client registration attempts, please try again later' },
  });

  /**
   * POST /oauth/register
   * Dynamic Client Registration (RFC 7591)
   *
   * Allows MCP clients (Claude Code, Claude Desktop) to register themselves
   * automatically as OAuth clients without pre-registration.
   */
  router.post('/register', registrationRateLimit, async (req: Request, res: Response) => {
    try {
      const {
        client_name,
        redirect_uris,
        grant_types,
        response_types,
        token_endpoint_auth_method,
        scope,
      } = req.body;

      // Validate redirect_uris (required per RFC 7591)
      if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'redirect_uris is required and must be a non-empty array',
        });
      }

      // Validate each redirect URI: must be a valid URL with https (or http://localhost for dev)
      for (const uri of redirect_uris) {
        try {
          const parsed = new URL(uri);
          const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
          if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
            return res.status(400).json({
              error: 'invalid_redirect_uri',
              error_description: `redirect_uri must use https (or http for localhost): ${uri}`,
            });
          }
        } catch {
          return res.status(400).json({
            error: 'invalid_redirect_uri',
            error_description: `Invalid redirect_uri format: ${uri}`,
          });
        }
      }

      // Limit number of redirect URIs per client
      if (redirect_uris.length > 10) {
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'Maximum 10 redirect_uris allowed per client',
        });
      }

      // Register the client
      const name = client_name || `MCP Client ${new Date().toISOString().slice(0, 10)}`;
      const client = await oauthService.registerClient({
        name,
        redirect_uris,
      });

      logger.info('Dynamic client registration', {
        clientId: client.client_id,
        name,
        redirectUris: redirect_uris,
      });

      // Return RFC 7591 response
      res.status(201).json({
        client_id: client.client_id,
        client_secret: client.client_secret,
        client_name: name,
        redirect_uris,
        grant_types: grant_types || ['authorization_code'],
        response_types: response_types || ['code'],
        token_endpoint_auth_method: token_endpoint_auth_method || 'client_secret_post',
        scope: scope || 'mcp',
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0, // never expires
      });
    } catch (error: any) {
      logger.error('Error in /oauth/register:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Failed to register client',
      });
    }
  });

  // ==========================================
  // Google OAuth for MCP authorization
  // ==========================================

  const ALLOWED_CALLBACK_HOSTS = new Set([
    'legal.org.ua',
    'platform.legal.org.ua',
    'mcp.legal.org.ua',
    'preview.legal.org.ua',
  ]);

  function getOAuthCallbackURL(req: Request): string {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
    const host = ALLOWED_CALLBACK_HOSTS.has(rawHost) ? rawHost : 'legal.org.ua';
    return `${protocol}://${host}/oauth/google/callback`;
  }

  /**
   * GET /oauth/google
   * Initiates Google OAuth flow with MCP params encoded in state
   */
  router.get('/google', async (req: Request, res: Response) => {
    try {
      const { client_id, redirect_uri, scope = 'mcp', state, code_challenge, code_challenge_method } = req.query;

      if (!client_id || typeof client_id !== 'string' || !redirect_uri || typeof redirect_uri !== 'string') {
        return res.status(400).json({ error: 'invalid_request', error_description: 'client_id and redirect_uri are required' });
      }

      // Verify client exists and redirect_uri is valid
      const client = await oauthService.getClient(client_id);
      if (!client) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Client not found' });
      }
      const isValidRedirect = await oauthService.validateRedirectUri(client_id, redirect_uri);
      if (!isValidRedirect) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Invalid redirect_uri for this client' });
      }

      // Sign MCP params into state
      const signedState = oauthService.signMcpState({
        client_id,
        redirect_uri,
        scope: String(scope),
        state: state ? String(state) : undefined,
        code_challenge: code_challenge ? String(code_challenge) : undefined,
        code_challenge_method: code_challenge_method ? String(code_challenge_method) : undefined,
      });

      // Redirect to Google OAuth with signed state
      passport.authenticate('google', {
        scope: ['profile', 'email'],
        session: false,
        state: signedState,
        callbackURL: getOAuthCallbackURL(req),
      } as any)(req, res);
    } catch (error: any) {
      logger.error('Error in /oauth/google:', error);
      res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
    }
  });

  /**
   * GET /oauth/google/callback
   * Google OAuth callback — creates MCP authorization code and redirects to MCP client
   */
  router.get('/google/callback', (req: Request, res: Response, next) => {
    const callbackURL = getOAuthCallbackURL(req);
    passport.authenticate('google', {
      session: false,
      failureRedirect: '/oauth/authorize?error=google_auth_failed',
      callbackURL,
    } as any)(req, res, next);
  }, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).send('Google authentication failed');
      }

      // Verify and decode MCP state
      const signedState = req.query.state as string;
      if (!signedState) {
        return res.status(400).send('Missing state parameter');
      }

      const mcpParams = oauthService.verifyMcpState(signedState);
      if (!mcpParams) {
        return res.status(400).send('Invalid or expired state');
      }

      // Re-validate client and redirect_uri
      const client = await oauthService.getClient(mcpParams.client_id);
      if (!client) {
        return res.status(401).send('Invalid OAuth client');
      }
      const isValidRedirect = await oauthService.validateRedirectUri(mcpParams.client_id, mcpParams.redirect_uri);
      if (!isValidRedirect) {
        return res.status(400).send('Invalid redirect_uri');
      }

      // Generate MCP authorization code
      const code = await oauthService.createAuthorizationCode({
        clientId: mcpParams.client_id,
        userId: user.id,
        redirectUri: mcpParams.redirect_uri,
        scope: mcpParams.scope,
        codeChallenge: mcpParams.code_challenge,
        codeChallengeMethod: mcpParams.code_challenge_method,
      });

      // Redirect to MCP client with authorization code
      const redirectUrl = new URL(mcpParams.redirect_uri);
      redirectUrl.searchParams.set('code', code);
      if (mcpParams.state) {
        redirectUrl.searchParams.set('state', mcpParams.state);
      }

      logger.info('MCP authorization via Google OAuth granted', {
        userId: user.id,
        email: user.email,
        clientId: mcpParams.client_id,
      });

      res.redirect(redirectUrl.toString());
    } catch (error: any) {
      logger.error('Error in /oauth/google/callback:', error);
      res.status(500).send('Internal server error');
    }
  });

  /**
   * GET /.well-known/oauth-authorization-server
   * OAuth 2.0 Authorization Server Metadata (RFC 8414)
   *
   * This endpoint provides discovery metadata for OAuth clients
   */
  router.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['mcp', 'claudeai'],
      code_challenge_methods_supported: ['S256', 'plain'],
    });
  });

  /**
   * GET /.well-known/openid-configuration
   * OpenID Connect Discovery (for compatibility)
   *
   * Some OAuth clients also check this endpoint
   */
  router.get('/.well-known/openid-configuration', (req: Request, res: Response) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['mcp', 'claudeai'],
      code_challenge_methods_supported: ['S256', 'plain'],
    });
  });

  return router;
}
