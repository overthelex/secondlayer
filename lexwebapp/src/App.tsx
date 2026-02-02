import React from 'react';
import { Toaster } from 'react-hot-toast';
import { ChatLayout } from './components/ChatLayout';
import { LoginPage } from './components/LoginPage';
import { AuthProvider, useAuth } from './contexts/AuthContext';

function AppContent() {
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

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // Show main chat interface if authenticated
  return <ChatLayout />;
}

export function App() {
  return (
    <AuthProvider>
      <AppContent />
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: {
            borderRadius: '8px',
            padding: '16px',
          },
        }}
      />
    </AuthProvider>
  );
}