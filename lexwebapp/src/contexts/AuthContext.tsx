/**
 * Authentication Context
 * Manages user authentication state, token storage, and profile
 */

import React, { createContext, useCallback, useContext, useMemo, useState, useEffect, ReactNode } from 'react';
import { authService } from '../services';
import { User } from '../types/models';
import showToast from '../utils/toast';
import { toastT, toastTDynamic } from '../i18n/toast-i18n';
import { useEncryptionStore } from '../stores/encryptionStore';

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
  refreshToken: () => Promise<void>;
  updateUser: (updates: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Initialize auth state from localStorage
  useEffect(() => {
    const initializeAuth = async () => {
      const storedToken = localStorage.getItem('auth_token');
      const storedUser = localStorage.getItem('user');

      if (storedToken && storedUser) {
        try {
          setToken(storedToken);
          setUser(JSON.parse(storedUser));

          // Verify token is still valid by fetching user profile
          const userData = await authService.getMe();

          // Update user data from server
          setUser(userData);
          localStorage.setItem('user', JSON.stringify(userData));
        } catch (error) {
          // Token invalid or expired - clear auth state
          console.error('Token validation failed:', error);
          localStorage.removeItem('auth_token');
          localStorage.removeItem('user');
          setToken(null);
          setUser(null);
        }
      }

      setIsLoading(false);
    };

    initializeAuth();
  }, []);

  // login/logout/refreshToken/updateUser keep a stable identity: consumers list them in effect
  // dependencies, and a new function on every render re-ran those effects each time auth state
  // changed (the /login?token= callback looped on an expired token this way).
  const login = useCallback(async (newToken: string) => {
    try {
      // Store token
      localStorage.setItem('auth_token', newToken);
      setToken(newToken);

      // Fetch user profile
      const userData = await authService.getMe();

      // Store user data
      setUser(userData);
      localStorage.setItem('user', JSON.stringify(userData));

      showToast.success(toastTDynamic('welcomeUser', userData.name));
    } catch (error) {
      console.error('Login failed:', error);
      localStorage.removeItem('auth_token');
      setToken(null);
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      // Call backend logout (for logging purposes)
      await authService.logout();
    } catch (error) {
      console.error('Logout API call failed:', error);
      // Continue with client-side logout even if API fails
    }

    // Clear local storage
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user');

    // Clear encryption state + sessionStorage
    useEncryptionStore.getState().reset();

    // Clear state
    setToken(null);
    setUser(null);

    showToast.info(toastT('loggedOut'));
  }, []);

  const refreshToken = useCallback(async () => {
    try {
      const newToken = await authService.refreshToken();

      // Update token
      localStorage.setItem('auth_token', newToken);
      setToken(newToken);

      console.log('Token refreshed successfully');
    } catch (error) {
      console.error('Token refresh failed:', error);
      // If refresh fails, logout user
      logout();
      throw error;
    }
  }, [logout]);

  // Auto-refresh token before expiry (7 days - refresh at 6 days)
  useEffect(() => {
    if (!token) return;

    // Refresh token every 6 days (518400000 ms)
    const refreshInterval = setInterval(
      async () => {
        try {
          await refreshToken();
        } catch (error) {
          console.error('Token refresh failed:', error);
        }
      },
      6 * 24 * 60 * 60 * 1000
    ); // 6 days

    return () => clearInterval(refreshInterval);
  }, [token, refreshToken]);

  const updateUser = useCallback((updates: Partial<User>) => {
    if (!user) return;

    const updatedUser = { ...user, ...updates };
    setUser(updatedUser);
    localStorage.setItem('user', JSON.stringify(updatedUser));
  }, [user]);

  const value: AuthContextType = useMemo(
    () => ({
      user,
      token,
      isAuthenticated: !!token && !!user,
      isLoading,
      login,
      logout,
      refreshToken,
      updateUser,
    }),
    [user, token, isLoading, login, logout, refreshToken, updateUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// Custom hook to use auth context
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthContext;
