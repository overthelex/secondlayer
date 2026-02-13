/**
 * WebAuthn Service
 * Handles passkey registration and authentication using @simplewebauthn/server
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  GenerateRegistrationOptionsOpts,
  GenerateAuthenticationOptionsOpts,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

export interface WebAuthnCredential {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  device_type: string;
  backed_up: boolean;
  transports: string[] | null;
  authenticator_attachment: string | null;
  friendly_name: string | null;
  last_used_at: string | null;
  created_at: string;
}

export class WebAuthnService {
  private db: Database;
  private rpName: string;
  private rpID: string;
  private origin: string;

  constructor(db: Database) {
    this.db = db;
    this.rpName = process.env.WEBAUTHN_RP_NAME || 'SecondLayer Legal';
    this.rpID = process.env.WEBAUTHN_RP_ID || 'localhost';
    this.origin = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';
  }

  /**
   * Generate registration options for a new credential
   */
  async generateRegistrationOpts(
    userId: string,
    email: string,
    attachment?: 'cross-platform' | 'platform'
  ) {
    // Get existing credentials to exclude
    const existingCreds = await this.getCredentialsByUserId(userId);

    const opts: GenerateRegistrationOptionsOpts = {
      rpName: this.rpName,
      rpID: this.rpID,
      userName: email,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: existingCreds.map((cred) => ({
        id: cred.credential_id,
        transports: (cred.transports as AuthenticatorTransportFuture[]) || undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        ...(attachment ? { authenticatorAttachment: attachment } : {}),
      },
    };

    const options = await generateRegistrationOptions(opts);

    logger.info('WebAuthn registration options generated', {
      userId,
      attachment,
      excludedCount: existingCreds.length,
    });

    return options;
  }

  /**
   * Verify a registration response and store the credential
   */
  async verifyRegistration(
    response: RegistrationResponseJSON,
    expectedChallenge: string,
    userId: string,
    friendlyName?: string,
    attachment?: string
  ): Promise<VerifiedRegistrationResponse> {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('Registration verification failed');
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    // Store credential in database
    await this.db.query(
      `INSERT INTO webauthn_credentials
        (user_id, credential_id, public_key, counter, device_type, backed_up, transports, authenticator_attachment, friendly_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credentialDeviceType,
        credentialBackedUp,
        response.response.transports || null,
        attachment || null,
        friendlyName || null,
      ]
    );

    logger.info('WebAuthn credential registered', {
      userId,
      credentialId: credential.id.substring(0, 16) + '...',
      deviceType: credentialDeviceType,
      attachment,
    });

    return verification;
  }

  /**
   * Generate authentication options (discoverable credential flow)
   */
  async generateAuthenticationOpts(attachment?: 'cross-platform' | 'platform') {
    const opts: GenerateAuthenticationOptionsOpts = {
      rpID: this.rpID,
      userVerification: 'preferred',
      // Empty allowCredentials = discoverable credentials (passkeys)
      allowCredentials: [],
    };

    const options = await generateAuthenticationOptions(opts);

    logger.info('WebAuthn authentication options generated', { attachment });

    return options;
  }

  /**
   * Verify an authentication response
   * Returns the user_id associated with the credential
   */
  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    expectedChallenge: string
  ): Promise<{ verified: boolean; userId: string }> {
    // Look up the credential by ID
    const credResult = await this.db.query(
      'SELECT * FROM webauthn_credentials WHERE credential_id = $1',
      [response.id]
    );

    if (credResult.rows.length === 0) {
      throw new Error('Credential not found');
    }

    const cred: WebAuthnCredential = credResult.rows[0];

    const verification: VerifiedAuthenticationResponse =
      await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(cred.public_key),
          counter: cred.counter,
          transports: (cred.transports as AuthenticatorTransportFuture[]) || undefined,
        },
      });

    if (verification.verified) {
      // Update counter and last_used_at
      await this.db.query(
        'UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE credential_id = $2',
        [verification.authenticationInfo.newCounter, response.id]
      );

      logger.info('WebAuthn authentication verified', {
        userId: cred.user_id,
        credentialId: cred.credential_id.substring(0, 16) + '...',
      });
    }

    return { verified: verification.verified, userId: cred.user_id };
  }

  /**
   * Get all credentials for a user (safe for API response - no public_key)
   */
  async getCredentialsByUserId(userId: string): Promise<WebAuthnCredential[]> {
    const result = await this.db.query(
      'SELECT * FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  /**
   * Delete a credential owned by a specific user
   */
  async deleteCredential(credentialId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2',
      [credentialId, userId]
    );
    const deleted = (result.rowCount ?? 0) > 0;
    if (deleted) {
      logger.info('WebAuthn credential deleted', { credentialId, userId });
    }
    return deleted;
  }
}
