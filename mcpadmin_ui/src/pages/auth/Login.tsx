/**
 * Login Page
 * Google OAuth2 sign-in interface
 */

import React, { useEffect } from 'react';
import { Button, Card, Typography, Space, Alert } from 'antd';
import { GoogleOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

const { Title, Paragraph } = Typography;

export function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, isAuthenticated } = useAuth();
  const [error, setError] = React.useState<string | null>(null);

  useEffect(() => {
    // If already authenticated, redirect to dashboard
    if (isAuthenticated) {
      navigate('/');
      return;
    }

    // Handle OAuth callback (token in URL)
    const token = searchParams.get('token');
    const errorParam = searchParams.get('error');

    if (token) {
      // Login with received token
      login(token)
        .then(() => {
          // Clear URL parameters
          window.history.replaceState({}, '', '/login');
          // Redirect to dashboard
          navigate('/');
        })
        .catch((err) => {
          console.error('Login error:', err);
          setError('Failed to authenticate. Please try again.');
        });
    } else if (errorParam) {
      // Handle OAuth errors
      if (errorParam === 'oauth_failed') {
        setError('Google authentication failed. Please try again.');
      } else if (errorParam === 'server_error') {
        setError('Server error occurred. Please try again later.');
      } else {
        setError('An error occurred during authentication.');
      }
      // Clear error from URL
      window.history.replaceState({}, '', '/login');
    }
  }, [searchParams, login, navigate, isAuthenticated]);

  const handleGoogleLogin = () => {
    // Redirect to backend OAuth endpoint
    window.location.href = '/auth/google';
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }}
    >
      <Card
        style={{
          width: 450,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          borderRadius: 16,
        }}
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Title level={2} style={{ marginBottom: 8 }}>
              SecondLayer Admin
            </Title>
            <Paragraph type="secondary">
              Legal Document Analysis Platform
            </Paragraph>
          </div>

          {error && (
            <Alert
              message="Authentication Error"
              description={error}
              type="error"
              closable
              onClose={() => setError(null)}
            />
          )}

          <div>
            <Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Sign in to access:
            </Paragraph>
            <ul style={{ paddingLeft: 20, marginBottom: 24 }}>
              <li>Court document management</li>
              <li>Legal pattern analysis</li>
              <li>Search query tracking</li>
              <li>MCP tool administration</li>
            </ul>
          </div>

          <Button
            type="primary"
            size="large"
            icon={<GoogleOutlined />}
            onClick={handleGoogleLogin}
            block
            style={{ height: 48, fontSize: 16 }}
          >
            Sign in with Google
          </Button>

          <Paragraph type="secondary" style={{ fontSize: 12, textAlign: 'center', margin: 0 }}>
            By signing in, you agree to our terms of service
          </Paragraph>
        </Space>
      </Card>
    </div>
  );
}
