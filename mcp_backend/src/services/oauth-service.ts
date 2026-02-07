/**
 * OAuth 2.0 Service for MCP Server
 * Implements OAuth 2.0 Authorization Code Flow for ChatGPT integration
 *
 * Flow:
 * 1. ChatGPT redirects user to /oauth/authorize
 * 2. User logs in and approves access
 * 3. Server generates authorization code and redirects back to ChatGPT
 * 4. ChatGPT exchanges code for access token via /oauth/token
 * 5. ChatGPT uses access token to authenticate SSE requests
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

export interface OAuthClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  name: string;
  created_at: Date;
}

export interface OAuthAuthorizationCode {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  expires_at: Date;
  used: boolean;
}

export interface OAuthAccessToken {
  access_token: string;
  user_id: string;
  client_id: string;
  scope: string;
  expires_at: Date;
  created_at: Date;
}

export class OAuthService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Register a new OAuth client
   */
  async registerClient(params: {
    name: string;
    redirect_uris: string[];
  }): Promise<OAuthClient> {
    const clientId = this.generateClientId();
    const clientSecret = this.generateClientSecret();

    const result = await this.db.query(
      `INSERT INTO oauth_clients (client_id, client_secret, redirect_uris, name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [clientId, clientSecret, JSON.stringify(params.redirect_uris), params.name]
    );

    logger.info('OAuth client registered', {
      clientId,
      name: params.name,
      redirectUris: params.redirect_uris,
    });

    return result.rows[0] as OAuthClient;
  }

  /**
   * Get OAuth client by client_id
   */
  async getClient(clientId: string): Promise<OAuthClient | null> {
    const result = await this.db.query(
      'SELECT * FROM oauth_clients WHERE client_id = $1',
      [clientId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const client = result.rows[0];
    // Parse redirect_uris from JSONB
    if (typeof client.redirect_uris === 'string') {
      client.redirect_uris = JSON.parse(client.redirect_uris);
    }

    return client as OAuthClient;
  }

  /**
   * Verify client credentials
   */
  async verifyClient(clientId: string, clientSecret: string): Promise<boolean> {
    const result = await this.db.query(
      'SELECT client_secret FROM oauth_clients WHERE client_id = $1',
      [clientId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    return result.rows[0].client_secret === clientSecret;
  }

  /**
   * Validate redirect URI for a client
   */
  async validateRedirectUri(clientId: string, redirectUri: string): Promise<boolean> {
    const client = await this.getClient(clientId);
    if (!client) {
      return false;
    }

    // Exact match required
    return client.redirect_uris.includes(redirectUri);
  }

  /**
   * Generate authorization code
   */
  async createAuthorizationCode(params: {
    clientId: string;
    userId: string;
    redirectUri: string;
    scope: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  }): Promise<string> {
    const code = this.generateAuthorizationCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.db.query(
      `INSERT INTO oauth_authorization_codes
       (code, client_id, user_id, redirect_uri, scope, expires_at, code_challenge, code_challenge_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        code,
        params.clientId,
        params.userId,
        params.redirectUri,
        params.scope,
        expiresAt,
        params.codeChallenge || null,
        params.codeChallengeMethod || null,
      ]
    );

    logger.info('Authorization code created', {
      clientId: params.clientId,
      userId: params.userId,
      expiresAt,
      hasPKCE: !!params.codeChallenge,
    });

    return code;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(params: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<{ accessToken: string; expiresIn: number; tokenType: string } | null> {
    // Get and verify authorization code
    const codeResult = await this.db.query(
      `SELECT * FROM oauth_authorization_codes
       WHERE code = $1 AND client_id = $2 AND redirect_uri = $3 AND used = false`,
      [params.code, params.clientId, params.redirectUri]
    );

    if (codeResult.rows.length === 0) {
      logger.warn('Invalid authorization code', params);
      return null;
    }

    const authCode = codeResult.rows[0];

    // Check if code expired
    if (new Date(authCode.expires_at) < new Date()) {
      logger.warn('Authorization code expired', { code: params.code });
      return null;
    }

    // Verify PKCE code_verifier if code_challenge was provided
    if (authCode.code_challenge) {
      if (!params.codeVerifier) {
        logger.warn('PKCE code_verifier required but not provided', {
          code: params.code,
        });
        return null;
      }

      const isValid = this.verifyPKCE(
        params.codeVerifier,
        authCode.code_challenge,
        authCode.code_challenge_method || 'S256'
      );

      if (!isValid) {
        logger.warn('PKCE verification failed', {
          code: params.code,
          method: authCode.code_challenge_method,
        });
        return null;
      }

      logger.info('PKCE verification successful', {
        code: params.code,
        method: authCode.code_challenge_method,
      });
    }

    // Mark code as used
    await this.db.query(
      'UPDATE oauth_authorization_codes SET used = true WHERE code = $1',
      [params.code]
    );

    // Generate access token
    const accessToken = this.generateAccessToken();
    const expiresIn = 30 * 24 * 60 * 60; // 30 days in seconds
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Store access token
    await this.db.query(
      `INSERT INTO oauth_access_tokens
       (access_token, user_id, client_id, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [accessToken, authCode.user_id, authCode.client_id, authCode.scope, expiresAt]
    );

    logger.info('Access token created', {
      clientId: params.clientId,
      userId: authCode.user_id,
      expiresIn,
    });

    return {
      accessToken,
      expiresIn,
      tokenType: 'Bearer',
    };
  }

  /**
   * Verify access token and return user_id
   */
  async verifyAccessToken(accessToken: string): Promise<{
    userId: string;
    clientId: string;
    scope: string;
  } | null> {
    const result = await this.db.query(
      `SELECT user_id, client_id, scope, expires_at
       FROM oauth_access_tokens
       WHERE access_token = $1`,
      [accessToken]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const token = result.rows[0];

    // Check if token expired
    if (new Date(token.expires_at) < new Date()) {
      logger.warn('Access token expired', { accessToken: accessToken.substring(0, 10) + '...' });
      return null;
    }

    return {
      userId: token.user_id,
      clientId: token.client_id,
      scope: token.scope,
    };
  }

  /**
   * Revoke access token
   */
  async revokeAccessToken(accessToken: string): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM oauth_access_tokens WHERE access_token = $1',
      [accessToken]
    );

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Clean up expired codes and tokens
   */
  async cleanupExpired(): Promise<void> {
    // Delete expired authorization codes
    const codesDeleted = await this.db.query(
      'DELETE FROM oauth_authorization_codes WHERE expires_at < NOW()'
    );

    // Delete expired access tokens
    const tokensDeleted = await this.db.query(
      'DELETE FROM oauth_access_tokens WHERE expires_at < NOW()'
    );

    logger.info('Cleaned up expired OAuth data', {
      codesDeleted: codesDeleted.rowCount,
      tokensDeleted: tokensDeleted.rowCount,
    });
  }

  /**
   * Generate client ID
   */
  private generateClientId(): string {
    return 'mcp_' + crypto.randomBytes(16).toString('hex');
  }

  /**
   * Generate client secret
   */
  private generateClientSecret(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Generate authorization code
   */
  private generateAuthorizationCode(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Generate access token
   */
  private generateAccessToken(): string {
    return 'mcp_token_' + crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Get all clients (for admin)
   */
  async getAllClients(): Promise<OAuthClient[]> {
    const result = await this.db.query(
      'SELECT client_id, redirect_uris, name, created_at FROM oauth_clients ORDER BY created_at DESC'
    );

    return result.rows.map((row: any) => ({
      ...row,
      redirect_uris: typeof row.redirect_uris === 'string'
        ? JSON.parse(row.redirect_uris)
        : row.redirect_uris,
    })) as OAuthClient[];
  }

  /**
   * Delete OAuth client
   */
  async deleteClient(clientId: string): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM oauth_clients WHERE client_id = $1',
      [clientId]
    );

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Verify PKCE code_verifier against code_challenge
   * Implements RFC 7636 - Proof Key for Code Exchange
   */
  private verifyPKCE(
    codeVerifier: string,
    codeChallenge: string,
    codeChallengeMethod: string
  ): boolean {
    if (codeChallengeMethod === 'S256') {
      // SHA256 hash of code_verifier, base64url encoded
      const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      return hash === codeChallenge;
    } else if (codeChallengeMethod === 'plain') {
      // Plain comparison
      return codeVerifier === codeChallenge;
    }

    logger.warn('Unsupported PKCE code_challenge_method', {
      method: codeChallengeMethod,
    });
    return false;
  }
}
