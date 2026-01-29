import React from 'react';
import { Toaster } from 'react-hot-toast';
import { ChatLayout } from './components/ChatLayout';
import { AuthProvider } from './contexts/AuthContext';

export function App() {
  return (
    <AuthProvider>
      <ChatLayout />
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