/**
 * Token Storage Utility
 * Manages JWT token persistence in localStorage
 */

const STORAGE_KEY = 'secondlayer_auth_token';

export class TokenStorage {
  /**
   * Get stored JWT token
   */
  static getToken(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      console.error('Error reading token from storage:', error);
      return null;
    }
  }

  /**
   * Save JWT token to storage
   */
  static setToken(token: string): void {
    try {
      localStorage.setItem(STORAGE_KEY, token);
    } catch (error) {
      console.error('Error saving token to storage:', error);
    }
  }

  /**
   * Remove JWT token from storage
   */
  static removeToken(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.error('Error removing token from storage:', error);
    }
  }

  /**
   * Check if token exists in storage
   */
  static hasToken(): boolean {
    return !!this.getToken();
  }
}
