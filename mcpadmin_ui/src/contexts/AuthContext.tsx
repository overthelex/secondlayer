/**
 * Authentication Context
 * Manages user authentication state and JWT tokens
 */

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import axios from 'axios';
import { TokenStorage } from '../utils/token-storage';

export interface User {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  emailVerified: boolean;
  lastLogin?: string;
  createdAt: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(TokenStorage.getToken());
  const [isLoading, setIsLoading] = useState(true);

  /**
   * Fetch current user from API
   */
  const fetchUser = async (authToken: string): Promise<void> => {
    try {
      const response = await axios.get('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      setUser(response.data.user);
    } catch (error) {
      console.error('Error fetching user:', error);
      // Token is invalid - clear it
      logout();
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Initialize auth state on mount
   */
  useEffect(() => {
    const initAuth = async () => {
      const storedToken = TokenStorage.getToken();
      if (storedToken) {
        setToken(storedToken);
        await fetchUser(storedToken);
      } else {
        setIsLoading(false);
      }
    };

    initAuth();
  }, []);

  /**
   * Login with JWT token
   */
  const login = async (newToken: string): Promise<void> => {
    TokenStorage.setToken(newToken);
    setToken(newToken);
    await fetchUser(newToken);
  };

  /**
   * Logout user
   */
  const logout = (): void => {
    TokenStorage.removeToken();
    setToken(null);
    setUser(null);
  };

  /**
   * Refresh user data
   */
  const refreshUser = async (): Promise<void> => {
    if (token) {
      await fetchUser(token);
    }
  };

  const value: AuthContextType = {
    user,
    token,
    isAuthenticated: !!user && !!token,
    isLoading,
    login,
    logout,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access auth context
 */
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
