/**
 * Regression: /login?token=<expired JWT> (an old bookmark of the OAuth callback URL) must be
 * tried exactly once. The callback effect used to depend on `login`, whose identity changed on
 * every AuthProvider render, and the token stayed in the URL after a failed login, so the page
 * re-ran login() in a tight loop: ~85 GET /auth/me per minute until the edge rate limit cut in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockGetMe = vi.fn();
vi.mock('../../services', () => ({
  authService: {
    getMe: (...args: unknown[]) => mockGetMe(...args),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshToken: vi.fn(),
  },
}));

vi.mock('../../utils/toast', () => {
  const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
  return { default: toast, showToast: toast };
});

// happy-dom rejects framer-motion's cancelled animations on unmount; render plain elements.
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MOTION_PROPS = new Set(['initial', 'animate', 'exit', 'transition', 'variants', 'layout',
    'whileHover', 'whileTap', 'whileInView', 'viewport']);
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(tag, ({ children, ...props }: Record<string, unknown>) => {
            const domProps = Object.fromEntries(
              Object.entries(props).filter(([key]) => !MOTION_PROPS.has(key))
            );
            return React.createElement(tag, domProps, children as React.ReactNode);
          });
        }
        return cache.get(tag);
      },
    }
  );
  return { motion, AnimatePresence: ({ children }: { children: React.ReactNode }) => children };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { AuthProvider } from '../../contexts/AuthContext';
import { LoginPage } from '../LoginPage';

const renderAt = (url: string) => {
  window.history.replaceState({}, '', url);
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>
  );
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe('LoginPage OAuth callback (?token=)', () => {
  beforeEach(() => {
    mockGetMe.mockReset();
    mockNavigate.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('tries an expired token once, then stops and drops it from the URL', async () => {
    mockGetMe.mockRejectedValue({ status: 401, message: 'Token has expired' });

    renderAt('/login?token=expired.jwt.token');

    await waitFor(() => expect(mockGetMe).toHaveBeenCalled());
    await settle(); // room for a retry loop to spin, if there is one

    expect(mockGetMe).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('');
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('logs in once with a valid token and leaves the login page', async () => {
    mockGetMe.mockResolvedValue({ id: 'u1', email: 'user@example.com', name: 'Тест' });

    renderAt('/login?token=valid.jwt.token');

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/chat', { replace: true }));
    await settle();

    expect(mockGetMe).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('');
    expect(localStorage.getItem('auth_token')).toBe('valid.jwt.token');
  });
});
