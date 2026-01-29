/**
 * Protected Route Component
 * Wrapper component that requires authentication
 * Redirects to login if user is not authenticated
 */

import React, { ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface ProtectedRouteProps {
  children: ReactNode;
  fallback?: ReactNode;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, fallback }) => {
  const { isAuthenticated, isLoading } = useAuth();

  // Show loading spinner while checking authentication
  if (isLoading) {
    return (
      fallback || (
        <div className="min-h-screen flex items-center justify-center bg-claude-bg">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-claude-accent border-t-transparent rounded-full animate-spin" />
            <p className="text-claude-subtext">Loading...</p>
          </div>
        </div>
      )
    );
  }

  // Not authenticated - show login prompt
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-claude-bg">
        <div className="max-w-md w-full mx-4 bg-white rounded-lg shadow-lg p-8 text-center">
          <div className="w-16 h-16 bg-claude-accent rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
          <h2 className="text-2xl font-semibold text-claude-text mb-2">Authentication Required</h2>
          <p className="text-claude-subtext mb-6">
            You need to be logged in to access this page.
          </p>
          <button
            onClick={() => (window.location.href = '/login')}
            className="w-full bg-claude-accent text-white py-3 px-6 rounded-lg hover:bg-opacity-90 transition-all font-medium"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  // Authenticated - render children
  return <>{children}</>;
};

export default ProtectedRoute;
