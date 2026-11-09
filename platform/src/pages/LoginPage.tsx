import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '@/utils/api-client';
import { setAuth } from '@/utils/auth';
import { TurnstileWidget, turnstileEnabled } from '@/components/TurnstileWidget';

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

  // Handle OAuth callback: /login?token=JWT
  useEffect(() => {
    const token = searchParams.get('token');
    const oauthError = searchParams.get('error');

    if (oauthError) {
      setError('Помилка авторизації через Google. Спробуйте ще раз.');
      window.history.replaceState({}, '', '/login');
      return;
    }

    if (token) {
      setLoading(true);
      localStorage.setItem('auth_token', token);
      api.get('/auth/me').then(({ data }) => {
        if (data.user) {
          setAuth(token, data.user);
          navigate('/', { replace: true });
        } else {
          setError('Не вдалося отримати профіль');
          setLoading(false);
        }
      }).catch(() => {
        setError('Невалідний токен');
        localStorage.removeItem('auth_token');
        setLoading(false);
      });
      window.history.replaceState({}, '', '/login');
    }
  }, [searchParams, navigate]);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    if (turnstileEnabled && !turnstileToken) {
      setError('Підтвердіть, що ви не робот');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const { data } = await api.post('/auth/login', { email, password, turnstileToken });
      if (data.token && data.user) {
        setAuth(data.token, data.user);
        navigate('/', { replace: true });
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Помилка входу';
      setError(msg);
      setLoading(false);
      // Turnstile tokens are single-use
      setTurnstileToken(null);
      setTurnstileReset((k) => k + 1);
    }
  };

  const handleGoogleLogin = () => {
    window.location.href = `${window.location.origin}/auth/google`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-sidebar-bg flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-white" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-sidebar-bg flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-brand-600 flex items-center justify-center text-white font-bold text-lg mx-auto mb-4">
            SL
          </div>
          <h1 className="text-xl font-bold text-txt-primary">SecondLayer Platform</h1>
          <p className="text-sm text-txt-muted mt-1">Developer Console</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Google OAuth */}
        <button
          onClick={handleGoogleLogin}
          className="flex items-center justify-center gap-3 w-full px-4 py-2.5 bg-white border border-border rounded-lg text-sm font-medium text-txt-primary hover:bg-surface-secondary transition-colors"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Увійти через Google
        </button>

        <div className="flex items-center gap-3 my-5">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-txt-muted">або</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* Email/Password login */}
        <form onSubmit={handlePasswordLogin} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-txt-secondary mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-txt-secondary mb-1">Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Ваш пароль"
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              autoComplete="current-password"
            />
          </div>
          <TurnstileWidget action="login" onToken={setTurnstileToken} resetKey={turnstileReset} />

          <button
            type="submit"
            disabled={!email || !password}
            className="w-full px-4 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Увійти
          </button>
        </form>

        <p className="text-xs text-txt-muted mt-6 text-center">
          Керуйте API-ключами, переглядайте документацію та аналітику використання.
        </p>
      </div>
    </div>
  );
}
