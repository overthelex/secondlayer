/**
 * Auth Guard
 * Protects routes that require authentication
 */

import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ROUTES } from '../routes';

export const AuthGuard: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();

  // Show loading spinner while checking authentication
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-claude-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-claude-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-claude-subtext">Завантаження...</p>
        </div>
      </div>
    );
  }

  // Redirect to login if not authenticated
  if (!isAuthenticated) {
    return <Navigate to={ROUTES.LOGIN} replace />;
  }

  // Render child routes if authenticated
  return <Outlet />;
};
