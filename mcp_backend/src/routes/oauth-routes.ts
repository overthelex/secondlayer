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
import { OAuthService } from '../services/oauth-service.js';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import bcrypt from 'bcryptjs';
import { getUserService } from '../middleware/dual-auth.js';

export function createOAuthRouter(db: Database): Router {
  const router = Router();
  const oauthService = new OAuthService(db);
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

      // Render authorization form with modern design
      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SecondLayer MCP - Authorization</title>
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
      <p class="subtitle">MCP legal.org.ua — OAuth2 Authorization</p>
    </div>

    <div class="client-info">
      <strong>Application requesting access</strong>
      <span>${client.name}</span>
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

    <div class="footer">
      Secure OAuth 2.0 Authentication
    </div>
  </div>

  <script>
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
            client_id: '${client_id}',
            redirect_uri: '${redirect_uri}',
            scope: '${scope}',
            state: '${state || ''}',
            code_challenge: '${code_challenge || ''}',
            code_challenge_method: '${code_challenge_method || ''}',
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
      const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } = req.body;

      // Validate grant_type
      if (grant_type !== 'authorization_code') {
        return res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'Only authorization_code grant type is supported',
        });
      }

      // Validate required parameters
      if (!code || !redirect_uri || !client_id || !client_secret) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing required parameters',
        });
      }

      // Verify client credentials
      const isValidClient = await oauthService.verifyClient(client_id, client_secret);
      if (!isValidClient) {
        return res.status(401).json({
          error: 'invalid_client',
          error_description: 'Invalid client credentials',
        });
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

  /**
   * GET /.well-known/oauth-authorization-server
   * OAuth 2.0 Authorization Server Metadata (RFC 8414)
   *
   * This endpoint provides discovery metadata for OAuth clients
   */
  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    const baseUrl = process.env.PUBLIC_URL || 'https://stage.legal.org.ua';

    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: ['mcp'],
      code_challenge_methods_supported: [],
    });
  });

  /**
   * GET /.well-known/openid-configuration
   * OpenID Connect Discovery (for compatibility)
   *
   * Some OAuth clients also check this endpoint
   */
  router.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
    const baseUrl = process.env.PUBLIC_URL || 'https://stage.legal.org.ua';

    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: ['mcp'],
    });
  });

  return router;
}
