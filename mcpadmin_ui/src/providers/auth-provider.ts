/**
 * Refine Auth Provider
 * Integrates authentication with Refine framework
 */

import { AuthBindings } from '@refinedev/core';
import { TokenStorage } from '../utils/token-storage';
import axios from 'axios';

export const authProvider: AuthBindings = {
  /**
   * Login handler
   * Called when user returns from OAuth with token
   */
  login: async ({ token }) => {
    if (token) {
      TokenStorage.setToken(token);
      return {
        success: true,
        redirectTo: '/',
      };
    }

    return {
      success: false,
      error: {
        name: 'LoginError',
        message: 'Invalid token',
      },
    };
  },

  /**
   * Logout handler
   * Clear token and redirect to login
   */
  logout: async () => {
    TokenStorage.removeToken();

    return {
      success: true,
      redirectTo: '/login',
    };
  },

  /**
   * Check if user is authenticated
   * Called on each route navigation
   */
  check: async () => {
    const token = TokenStorage.getToken();

    if (token) {
      try {
        // Verify token is still valid by checking with backend
        await axios.get('/api/auth/me', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        return {
          authenticated: true,
        };
      } catch (error) {
        // Token is invalid
        TokenStorage.removeToken();
        return {
          authenticated: false,
          redirectTo: '/login',
          error: {
            message: 'Session expired',
            name: 'Unauthorized',
          },
        };
      }
    }

    return {
      authenticated: false,
      redirectTo: '/login',
    };
  },

  /**
   * Get user identity
   * Used to display user info in the header
   */
  getIdentity: async () => {
    const token = TokenStorage.getToken();

    if (!token) {
      return null;
    }

    try {
      const response = await axios.get('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const user = response.data.user;

      return {
        id: user.id,
        name: user.name || user.email,
        email: user.email,
        avatar: user.picture,
      };
    } catch (error) {
      console.error('Error fetching user identity:', error);
      return null;
    }
  },

  /**
   * Get user permissions (if implementing role-based access)
   */
  getPermissions: async () => {
    // TODO: Implement role-based permissions if needed
    return null;
  },

  /**
   * Handle authentication errors
   */
  onError: async (error) => {
    // If 401 Unauthorized, logout user
    if (error.response?.status === 401) {
      return {
        logout: true,
        redirectTo: '/login',
        error: {
          message: 'Session expired',
          name: 'Unauthorized',
        },
      };
    }

    return {};
  },
};
