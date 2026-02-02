/**
 * Authentication Context
 * Manages user authentication state, token storage, and profile
 */

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '../utils/api-client';
import showToast from '../utils/toast';

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified?: boolean;
  lastLogin?: string;
  createdAt?: string;
}

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
          const response = await api.auth.getMe();
          const userData = response.data.user;

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
  }, [token]);

  const login = async (newToken: string) => {
    try {
      // Store token
      localStorage.setItem('auth_token', newToken);
      setToken(newToken);

      // Fetch user profile
      const response = await api.auth.getMe();
      const userData = response.data.user;

      // Store user data
      setUser(userData);
      localStorage.setItem('user', JSON.stringify(userData));

      showToast.success(`Welcome, ${userData.name}!`);
    } catch (error) {
      console.error('Login failed:', error);
      localStorage.removeItem('auth_token');
      setToken(null);
      throw error;
    }
  };

  const logout = async () => {
    try {
      // Call backend logout (for logging purposes)
      await api.auth.logout();
    } catch (error) {
      console.error('Logout API call failed:', error);
      // Continue with client-side logout even if API fails
    }

    // Clear local storage
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user');

    // Clear state
    setToken(null);
    setUser(null);

    showToast.info('Ви вийшли з системи');
  };

  const refreshToken = async () => {
    try {
      const response = await api.auth.refreshToken();
      const newToken = response.data.token;

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
  };

  const updateUser = (updates: Partial<User>) => {
    if (!user) return;

    const updatedUser = { ...user, ...updates };
    setUser(updatedUser);
    localStorage.setItem('user', JSON.stringify(updatedUser));
  };

  const value: AuthContextType = {
    user,
    token,
    isAuthenticated: !!token && !!user,
    isLoading,
    login,
    logout,
    refreshToken,
    updateUser,
  };

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
