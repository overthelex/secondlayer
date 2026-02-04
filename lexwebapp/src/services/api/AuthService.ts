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
}

// Export singleton instance
export const authService = new AuthService();
