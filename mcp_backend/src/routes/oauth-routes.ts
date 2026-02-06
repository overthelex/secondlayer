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
      const { response_type, client_id, redirect_uri, scope = 'mcp', state } = req.query;

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

      // Render authorization form
      // In production, this should be a proper HTML page with styling
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
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 400px;
      width: 100%;
      padding: 40px;
    }
    h1 {
      color: #333;
      font-size: 24px;
      margin-bottom: 10px;
      text-align: center;
    }
    .subtitle {
      color: #666;
      font-size: 14px;
      text-align: center;
      margin-bottom: 30px;
    }
    .client-info {
      background: #f7fafc;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 25px;
      border-left: 4px solid #667eea;
    }
    .client-info strong {
      color: #333;
      display: block;
      margin-bottom: 5px;
    }
    .client-info span {
      color: #667eea;
      font-weight: 600;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      color: #333;
      font-weight: 500;
      margin-bottom: 8px;
      font-size: 14px;
    }
    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: 12px;
      border: 2px solid #e2e8f0;
      border-radius: 8px;
      font-size: 14px;
      transition: all 0.2s;
    }
    input[type="email"]:focus,
    input[type="password"]:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
    }
    button:active {
      transform: translateY(0);
    }
    .error {
      background: #fee;
      color: #c33;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
    }
    .footer {
      text-align: center;
      margin-top: 20px;
      color: #999;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 SecondLayer MCP</h1>
    <p class="subtitle">Ukrainian Legal AI Platform</p>

    <div class="client-info">
      <strong>Application requesting access:</strong>
      <span>${client.name}</span>
    </div>

    <div id="error" class="error"></div>

    <form id="authForm" onsubmit="handleSubmit(event)">
      <div class="form-group">
        <label for="email">Email Address</label>
        <input
          type="email"
          id="email"
          name="email"
          placeholder="igor@legal.org.ua"
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
          placeholder="••••••••"
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
      const { email, password, client_id, redirect_uri, scope = 'mcp', state } = req.body;

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
      const { grant_type, code, redirect_uri, client_id, client_secret } = req.body;

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

  return router;
}
