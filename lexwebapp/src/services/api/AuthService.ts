/**
 * Auth Service
 * Handles authentication and user profile operations
 */

import { BaseService } from '../base/BaseService';
import { User } from '../../types/models';
import {
  UpdateProfileRequest,
  GetMeResponse,
  RefreshTokenResponse,
} from '../../types/api';

export class AuthService extends BaseService {
  /**
   * Get current user profile
   */
  async getMe(): Promise<User> {
    try {
      const response = await this.client.get<GetMeResponse>('/auth/me');
      return response.data.user;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Update user profile
   */
  async updateProfile(data: UpdateProfileRequest): Promise<User> {
    try {
      const response = await this.client.put<{ user: User }>('/auth/profile', data);
      return response.data.user;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Refresh authentication token
   */
  async refreshToken(): Promise<string> {
    try {
      const response = await this.client.post<RefreshTokenResponse>('/auth/refresh');
      return response.data.token;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Logout user
   */
  async logout(): Promise<void> {
    try {
      await this.client.post('/auth/logout');
    } catch (error) {
      // Log error but don't throw - logout should always succeed client-side
      console.error('Logout API call failed:', error);
    }
  }

  /**
   * Verify token validity
   */
  async verifyToken(): Promise<boolean> {
    try {
      await this.getMe();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register new user with email and password
   */
  async register(email: string, password: string, name?: string): Promise<any> {
    try {
      const response = await this.client.post('/auth/register', { email, password, name });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Verify email with token
   */
  async verifyEmail(token: string): Promise<any> {
    try {
      const response = await this.client.post('/auth/verify-email', { token });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Request password reset email
   */
  async forgotPassword(email: string): Promise<any> {
    try {
      const response = await this.client.post('/auth/forgot-password', { email });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Reset password with token
   */
  async resetPassword(token: string, password: string): Promise<any> {
    try {
      const response = await this.client.post('/auth/reset-password', { token, password });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ========================================================================
  // WebAuthn (Passkeys)
  // ========================================================================

  /**
   * Generate WebAuthn registration options
   */
  async webauthnRegisterOptions(attachment?: 'cross-platform' | 'platform'): Promise<any> {
    try {
      const response = await this.client.post('/auth/webauthn/register/options', { attachment });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Verify WebAuthn registration
   */
  async webauthnRegisterVerify(response: any, friendlyName?: string, attachment?: string): Promise<any> {
    try {
      const res = await this.client.post('/auth/webauthn/register/verify', {
        response,
        friendlyName,
        attachment,
      });
      return res.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Generate WebAuthn authentication options (login)
   */
  async webauthnAuthOptions(attachment?: 'cross-platform'): Promise<any> {
    try {
      const response = await this.client.post('/auth/webauthn/auth/options', { attachment });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Verify WebAuthn authentication (login)
   */
  async webauthnAuthVerify(response: any, challenge: string): Promise<any> {
    try {
      const res = await this.client.post('/auth/webauthn/auth/verify', { response, challenge });
      return res.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * List user's WebAuthn credentials
   */
  async webauthnListCredentials(): Promise<any> {
    try {
      const response = await this.client.get('/auth/webauthn/credentials');
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Delete a WebAuthn credential
   */
  async webauthnDeleteCredential(credentialId: string): Promise<any> {
    try {
      const response = await this.client.delete(`/auth/webauthn/credentials/${credentialId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }
}

// Export singleton instance
export const authService = new AuthService();
