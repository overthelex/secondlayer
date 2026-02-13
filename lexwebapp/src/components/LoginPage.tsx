import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Mail,
  Lock,
  Key,
  Smartphone,
  Shield,
  ShieldCheck,
  ExternalLink,
  X,
  ArrowRight,
  Loader2,
  AlertCircle,
  Eye,
  EyeOff,
  User } from
'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import { useAuth } from '../contexts/AuthContext';
import { authService } from '../services';
import showToast from '../utils/toast';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
// Auth endpoints are at root level, not under /api
const BASE_URL = API_URL.replace(/\/api$/, '');

type AuthMethod = 'password' | 'hardware-key' | 'phone-key';

interface LoginPageProps {
  onLoginSuccess?: () => void;
}

// Password strength calculator
function checkPasswordStrength(pwd: string): 'weak' | 'medium' | 'strong' {
  let strength = 0;
  if (pwd.length >= 8) strength++;
  if (/[A-Z]/.test(pwd)) strength++;
  if (/[a-z]/.test(pwd)) strength++;
  if (/[0-9]/.test(pwd)) strength++;
  if (/[^A-Za-z0-9]/.test(pwd)) strength++;

  if (strength < 3) return 'weak';
  if (strength < 5) return 'medium';
  return 'strong';
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordStrength, setPasswordStrength] = useState<'weak' | 'medium' | 'strong'>('weak');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState('');
  const [showGDPR, setShowGDPR] = useState(false);

  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  // Handle OAuth callback on mount
  useEffect(() => {
    const handleOAuthCallback = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get('token');
      const error = urlParams.get('error');

      // Handle error from OAuth
      if (error) {
        if (error === 'oauth_failed') {
          setError('Google authentication failed. Please try again.');
          showToast.error('Google authentication failed');
        } else if (error === 'server_error') {
          setError('Server error occurred. Please try again later.');
          showToast.error('Server error occurred');
        } else {
          setError('Authentication failed. Please try again.');
          showToast.error('Authentication failed');
        }
        // Clear error param from URL
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }

      // Handle successful OAuth token
      if (token) {
        setIsLoading(true);
        setError(null);

        try {
          // Login with the token
          await login(token);

          // Clear token from URL for security
          window.history.replaceState({}, '', window.location.pathname);

          // Call success callback if provided
          if (onLoginSuccess) {
            onLoginSuccess();
          }

          // Navigate to chat after successful login
          navigate('/chat', { replace: true });
        } catch (err: any) {
          console.error('Login failed:', err);
          setError('Не вдалося завершити вхід. Спробуйте ще раз.');
          showToast.error('Помилка входу');
        } finally {
          setIsLoading(false);
        }
      }
    };

    handleOAuthCallback();
  }, [login, onLoginSuccess]);

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      if (onLoginSuccess) {
        onLoginSuccess();
      }
      navigate('/chat', { replace: true });
    }
  }, [isAuthenticated, isLoading, onLoginSuccess, navigate]);

  const handleGoogleAuth = () => {
    setError(null);
    // Redirect to backend Google OAuth endpoint (auth routes are at root level)
    window.location.href = `${BASE_URL}/auth/google`;
  };

  const handlePasswordChange = (value: string) => {
    setPassword(value);
    if (!isLogin) {
      setPasswordStrength(checkPasswordStrength(value));
    }
  };

  const handlePasswordAuth = async () => {
    setError(null);

    if (isLogin) {
      // Login flow
      if (!email || !password) {
        setError('Please enter both email and password');
        return;
      }

      setIsLoading(true);

      try {
        const response = await fetch(`${BASE_URL}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || 'Login failed');
        }

        await login(data.token);
        showToast.success('Login successful!');

        if (onLoginSuccess) {
          onLoginSuccess();
        }

        navigate('/chat', { replace: true });
      } catch (err: any) {
        console.error('Password login failed:', err);
        setError(err.message || 'Login failed. Please check your credentials.');
        showToast.error('Login failed');
      } finally {
        setIsLoading(false);
      }
    } else {
      // Registration flow
      if (!email || !password) {
        setError('Please fill in email and password');
        return;
      }

      setIsLoading(true);

      try {
        const response = await fetch(`${BASE_URL}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name: name || undefined }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || 'Registration failed');
        }

        showToast.success('Registration successful! Please check your email to verify your account.');

        // Switch to login mode
        setIsLogin(true);
        setEmail('');
        setPassword('');
        setName('');
      } catch (err: any) {
        console.error('Registration failed:', err);
        setError(err.message || 'Registration failed. Please try again.');
        showToast.error('Registration failed');
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleForgotPassword = async () => {
    if (!forgotPasswordEmail) {
      setError('Please enter your email');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${BASE_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotPasswordEmail }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to send reset email');
      }

      showToast.success('Password reset link sent to your email');
      setShowForgotPassword(false);
      setForgotPasswordEmail('');
    } catch (err: any) {
      setError(err.message || 'Failed to send reset email');
      showToast.error('Failed to send reset email');
    } finally {
      setIsLoading(false);
    }
  };

  const handleWebAuthnLogin = async (attachment?: 'cross-platform') => {
    setError(null);
    setIsLoading(true);

    try {
      // Get authentication options from server
      const options = await authService.webauthnAuthOptions(attachment);

      // Start WebAuthn authentication (browser handles UI including QR for hybrid)
      const authResponse = await startAuthentication({ optionsJSON: options });

      // Verify with server
      const result = await authService.webauthnAuthVerify(authResponse, options.challenge);

      // Login with the returned JWT
      await login(result.token);
      showToast.success('Вхід виконано успішно!');

      if (onLoginSuccess) {
        onLoginSuccess();
      }

      navigate('/chat', { replace: true });
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setError('Автентифікацію скасовано');
      } else {
        console.error('WebAuthn login failed:', err);
        setError(err.message || 'Помилка автентифікації');
        showToast.error('Помилка автентифікації');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleHardwareKey = () => {
    handleWebAuthnLogin('cross-platform');
  };

  const handlePhoneKey = () => {
    handleWebAuthnLogin(); // No attachment constraint — browser shows QR for hybrid transport
  };

  // Show loading state during OAuth callback processing
  if (isLoading && !showForgotPassword) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2 size={48} className="text-claude-accent animate-spin mx-auto mb-4" />
          <p className="text-claude-text font-sans">Completing authentication...</p>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar flex items-center justify-center p-4">
      <motion.div
        initial={{
          opacity: 0,
          y: 20
        }}
        animate={{
          opacity: 1,
          y: 0
        }}
        transition={{
          duration: 0.6,
          ease: [0.22, 1, 0.36, 1]
        }}
        className="w-full max-w-md">

        {/* Logo */}
        <div className="text-center mb-8">
          <motion.div
            initial={{
              scale: 0.9,
              opacity: 0
            }}
            animate={{
              scale: 1,
              opacity: 1
            }}
            transition={{
              duration: 0.5,
              delay: 0.1
            }}
            className="inline-block">

            <img
              src="/Image.jpg"
              alt="Lex"
              className="h-20 w-auto mx-auto" />

          </motion.div>
        </div>

        {/* Error Banner */}
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
            <AlertCircle size={20} className="text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-red-800 font-sans">{error}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-red-600 hover:text-red-800">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </motion.div>
        )}

        {/* Main Card */}
        <motion.div
          initial={{
            opacity: 0,
            y: 20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          transition={{
            duration: 0.6,
            delay: 0.2
          }}
          className="bg-white rounded-2xl shadow-xl border border-claude-border p-8">

          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-sans text-claude-text font-medium mb-2">
              {isLogin ? 'Вхід в систему' : 'Реєстрація'}
            </h1>
            <p className="text-claude-subtext font-sans text-sm">
              {isLogin ?
              'Оберіть зручний спосіб входу' :
              'Створіть акаунт для початку роботи'}
            </p>
          </div>

          {/* Google Auth Button */}
          <motion.button
            whileHover={{
              scale: 1.02
            }}
            whileTap={{
              scale: 0.98
            }}
            onClick={handleGoogleAuth}
            className="w-full flex items-center justify-center gap-3 px-4 py-3.5 bg-white border-2 border-claude-border hover:border-claude-accent hover:bg-claude-bg rounded-xl font-medium text-claude-text transition-all shadow-sm mb-6 font-sans">

            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg">

              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4" />

              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853" />

              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05" />

              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335" />

            </svg>
            {isLogin ? 'Увійти через Google' : 'Зареєструватися через Google'}
          </motion.button>

          {/* Divider */}
          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-claude-border"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-white text-claude-subtext font-sans">
                або
              </span>
            </div>
          </div>

          {/* Auth Method Tabs */}
          <div className="flex gap-2 mb-6 bg-claude-bg p-1 rounded-xl">
            <button
              onClick={() => setAuthMethod('password')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg font-medium text-sm font-sans transition-all ${authMethod === 'password' ? 'bg-white text-claude-text shadow-sm' : 'text-claude-subtext hover:text-claude-text'}`}>

              <Lock size={16} />
              Пароль
            </button>
            <button
              onClick={() => setAuthMethod('hardware-key')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg font-medium text-sm font-sans transition-all ${authMethod === 'hardware-key' ? 'bg-white text-claude-text shadow-sm' : 'text-claude-subtext hover:text-claude-text'}`}>

              <Key size={16} />
              Ключ
            </button>
            <button
              onClick={() => setAuthMethod('phone-key')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg font-medium text-sm font-sans transition-all ${authMethod === 'phone-key' ? 'bg-white text-claude-text shadow-sm' : 'text-claude-subtext hover:text-claude-text'}`}>

              <Smartphone size={16} />
              Телефон
            </button>
          </div>

          {/* Auth Forms */}
          <AnimatePresence mode="wait">
            {authMethod === 'password' &&
            <motion.div
              key="password"
              initial={{
                opacity: 0,
                x: -20
              }}
              animate={{
                opacity: 1,
                x: 0
              }}
              exit={{
                opacity: 0,
                x: 20
              }}
              transition={{
                duration: 0.3
              }}
              className="space-y-4">

                {/* Name field (Registration only) */}
                {!isLogin && (
                  <div>
                    <label htmlFor="name" className="block text-sm font-medium text-claude-text font-sans mb-2">
                      Ім'я
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <User size={18} className="text-claude-subtext" />
                      </div>
                      <input
                        id="name"
                        name="name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Іван Петренко"
                        autoComplete="name"
                        className="block w-full pl-10 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />
                    </div>
                  </div>
                )}

                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-claude-text font-sans mb-2">
                    Email
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Mail size={18} className="text-claude-subtext" />
                    </div>
                    <input
                    id="email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    autoComplete="email"
                    className="block w-full pl-10 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                  </div>
                </div>

                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-claude-text font-sans mb-2">
                    Пароль
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Lock size={18} className="text-claude-subtext" />
                    </div>
                    <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => handlePasswordChange(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handlePasswordAuth()}
                    placeholder="••••••••"
                    autoComplete={isLogin ? 'current-password' : 'new-password'}
                    className="block w-full pl-10 pr-12 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-claude-subtext hover:text-claude-text transition-colors"
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>

                  {/* Password strength indicator (Registration only) */}
                  {!isLogin && password && (
                    <div className="mt-2">
                      <div className="flex gap-1 mb-1">
                        <div className={`h-1 flex-1 rounded ${passwordStrength === 'weak' ? 'bg-red-500' : passwordStrength === 'medium' ? 'bg-yellow-500' : 'bg-green-500'}`}></div>
                        <div className={`h-1 flex-1 rounded ${passwordStrength === 'medium' || passwordStrength === 'strong' ? (passwordStrength === 'medium' ? 'bg-yellow-500' : 'bg-green-500') : 'bg-gray-200'}`}></div>
                        <div className={`h-1 flex-1 rounded ${passwordStrength === 'strong' ? 'bg-green-500' : 'bg-gray-200'}`}></div>
                      </div>
                      <p className="text-xs text-claude-subtext">
                        {passwordStrength === 'weak' && 'Слабкий пароль — додайте великі літери, цифри або спецсимволи'}
                        {passwordStrength === 'medium' && 'Середній пароль'}
                        {passwordStrength === 'strong' && 'Сильний пароль'}
                      </p>
                    </div>
                  )}
                </div>

                {isLogin &&
              <div className="flex justify-end">
                    <button
                      onClick={() => {
                        setShowForgotPassword(true);
                        setForgotPasswordEmail(email);
                        setError(null);
                      }}
                      className="text-sm text-claude-accent hover:text-[#C66345] font-sans"
                    >
                      Забули пароль?
                    </button>
                  </div>
              }

                <motion.button
                whileHover={{
                  scale: 1.02
                }}
                whileTap={{
                  scale: 0.98
                }}
                onClick={handlePasswordAuth}
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-3.5 bg-black text-white rounded-xl font-medium hover:bg-gray-800 transition-colors shadow-sm font-sans disabled:opacity-50">

                  {isLoading ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <>
                      {isLogin ? 'Увійти' : 'Зареєструватися'}
                      <ArrowRight size={18} />
                    </>
                  )}
                </motion.button>
              </motion.div>
            }

            {authMethod === 'hardware-key' &&
            <motion.div
              key="hardware-key"
              initial={{
                opacity: 0,
                x: -20
              }}
              animate={{
                opacity: 1,
                x: 0
              }}
              exit={{
                opacity: 0,
                x: 20
              }}
              transition={{
                duration: 0.3
              }}
              className="space-y-6">

                <div className="text-center py-8">
                  <motion.div
                  animate={{
                    scale: [1, 1.1, 1]
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity
                  }}
                  className="inline-flex items-center justify-center w-20 h-20 bg-claude-accent/10 rounded-full mb-4">

                    <Shield size={40} className="text-claude-accent" />
                  </motion.div>
                  <h3 className="text-lg font-serif text-claude-text mb-2">
                    Підключіть ключ безпеки
                  </h3>
                  <p className="text-sm text-claude-subtext font-sans mb-6">
                    Вставте USB-ключ або використайте NFC
                  </p>
                  <motion.button
                  whileHover={{
                    scale: 1.02
                  }}
                  whileTap={{
                    scale: 0.98
                  }}
                  onClick={handleHardwareKey}
                  disabled={isLoading}
                  className="px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans disabled:opacity-50">
                    {isLoading ? (
                      <Loader2 size={18} className="animate-spin inline mr-2" />
                    ) : null}
                    Автентифікація
                  </motion.button>
                </div>
              </motion.div>
            }

            {authMethod === 'phone-key' &&
            <motion.div
              key="phone-key"
              initial={{
                opacity: 0,
                x: -20
              }}
              animate={{
                opacity: 1,
                x: 0
              }}
              exit={{
                opacity: 0,
                x: 20
              }}
              transition={{
                duration: 0.3
              }}
              className="space-y-6">

                <div className="text-center py-8">
                  <motion.div
                    animate={{
                      rotate: [0, 5, -5, 0]
                    }}
                    transition={{
                      duration: 2,
                      repeat: Infinity
                    }}
                    className="inline-flex items-center justify-center w-20 h-20 bg-claude-accent/10 rounded-full mb-4">
                    <Smartphone size={40} className="text-claude-accent" />
                  </motion.div>
                  <h3 className="text-lg font-serif text-claude-text mb-2">
                    Вхід через телефон
                  </h3>
                  <p className="text-sm text-claude-subtext font-sans mb-6">
                    Браузер покаже QR-код для сканування телефоном
                  </p>
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={handlePhoneKey}
                    disabled={isLoading}
                    className="px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans disabled:opacity-50">
                    {isLoading ? (
                      <Loader2 size={18} className="animate-spin inline mr-2" />
                    ) : null}
                    Автентифікація
                  </motion.button>
                </div>
              </motion.div>
            }
          </AnimatePresence>
        </motion.div>

        {/* Toggle Login/Register */}
        <motion.div
          initial={{
            opacity: 0
          }}
          animate={{
            opacity: 1
          }}
          transition={{
            delay: 0.4
          }}
          className="text-center mt-6">

          <p className="text-claude-subtext font-sans text-sm">
            {isLogin ? 'Немає акаунту?' : 'Вже є акаунт?'}{' '}
            <button
              onClick={() => {
                setIsLogin(!isLogin);
                setError(null);
                setPassword('');
              }}
              className="text-claude-accent hover:text-[#C66345] font-medium">

              {isLogin ? 'Зареєструватися' : 'Увійти'}
            </button>
          </p>
        </motion.div>

        {/* GDPR Compliance Badge */}
        <motion.button
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45, duration: 0.5 }}
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
          onClick={() => setShowGDPR(true)}
          className="w-full mt-6 px-4 py-3 bg-white/70 backdrop-blur-sm border border-[#003399]/10 hover:border-[#003399]/25 rounded-xl flex items-center gap-3 cursor-pointer transition-colors text-left"
        >
          <div className="flex-shrink-0 w-9 h-9 bg-[#003399]/10 rounded-lg flex items-center justify-center">
            <ShieldCheck size={20} className="text-[#003399]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-bold text-[#003399] tracking-wider font-sans uppercase">GDPR</span>
              <span className="text-[10px] text-claude-subtext/50">|</span>
              <span className="text-[11px] text-claude-text font-medium font-sans">Захист даних</span>
            </div>
            <p className="text-[10px] text-claude-subtext font-sans mt-0.5 leading-tight">
              Сервіс відповідає вимогам Регламенту ЄС 2016/679 щодо захисту персональних даних
            </p>
          </div>
          {/* EU stars accent */}
          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#003399]/10 flex items-center justify-center" title="European Union">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((angle) => {
                const r = 10;
                const cx = 12 + r * Math.cos((angle - 90) * Math.PI / 180);
                const cy = 12 + r * Math.sin((angle - 90) * Math.PI / 180);
                return (
                  <circle key={angle} cx={cx} cy={cy} r="1.2" fill="#003399" opacity="0.7" />
                );
              })}
            </svg>
          </div>
        </motion.button>

        {/* Footer */}
        <motion.div
          initial={{
            opacity: 0
          }}
          animate={{
            opacity: 1
          }}
          transition={{
            delay: 0.5
          }}
          className="text-center mt-4 text-xs text-claude-subtext font-sans">

          <p>
            Продовжуючи, ви погоджуєтесь з{' '}
            <a href="#" className="text-claude-accent hover:text-[#C66345]">
              Умовами використання
            </a>{' '}
            та{' '}
            <a href="#" className="text-claude-accent hover:text-[#C66345]">
              Політикою конфіденційності
            </a>
          </p>
        </motion.div>
      </motion.div>

      {/* Forgot Password Modal */}
      <AnimatePresence>
        {showForgotPassword && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setShowForgotPassword(false);
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl"
            >
              <h2 className="text-xl font-sans text-claude-text mb-2">Скидання паролю</h2>
              <p className="text-sm text-claude-subtext mb-6">
                Введіть email вашого акаунту, і ми відправимо вам посилання для скидання паролю.
              </p>

              <div className="relative mb-4">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail size={18} className="text-claude-subtext" />
                </div>
                <input
                  type="email"
                  value={forgotPasswordEmail}
                  onChange={(e) => setForgotPasswordEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleForgotPassword()}
                  placeholder="your@email.com"
                  autoFocus
                  className="block w-full pl-10 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowForgotPassword(false);
                    setError(null);
                  }}
                  className="flex-1 px-4 py-3 border border-claude-border rounded-xl hover:bg-claude-bg transition-colors font-sans"
                >
                  Скасувати
                </button>
                <button
                  onClick={handleForgotPassword}
                  disabled={isLoading}
                  className="flex-1 px-4 py-3 bg-black text-white rounded-xl hover:bg-gray-800 transition-colors font-sans disabled:opacity-50 flex items-center justify-center"
                >
                  {isLoading ? <Loader2 size={18} className="animate-spin" /> : 'Відправити'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* GDPR Info Modal */}
      <AnimatePresence>
        {showGDPR && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setShowGDPR(false);
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl max-w-lg w-full shadow-2xl max-h-[90vh] flex flex-col"
            >
              {/* Header */}
              <div className="flex items-center gap-3 p-6 pb-4 border-b border-claude-border">
                <div className="w-10 h-10 bg-[#003399]/10 rounded-xl flex items-center justify-center flex-shrink-0">
                  <ShieldCheck size={22} className="text-[#003399]" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-sans text-claude-text font-medium">Відповідність GDPR</h2>
                  <p className="text-xs text-claude-subtext font-sans">Регламент ЄС 2016/679</p>
                </div>
                <button
                  onClick={() => setShowGDPR(false)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-claude-bg text-claude-subtext hover:text-claude-text transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Content */}
              <div className="overflow-y-auto p-6 space-y-5">
                <p className="text-sm text-claude-text font-sans leading-relaxed">
                  Наш сервіс повністю відповідає вимогам <strong>Загального регламенту захисту даних (GDPR)</strong> Європейського Союзу. Ми забезпечуємо найвищий рівень захисту ваших персональних даних.
                </p>

                {/* Compliance points */}
                <div className="space-y-3">
                  {[
                    {
                      title: 'Законність обробки даних',
                      desc: 'Обробка персональних даних здійснюється виключно на підставі вашої згоди або для виконання договору.',
                      article: 'Ст. 6 GDPR',
                    },
                    {
                      title: 'Право на доступ до даних',
                      desc: 'Ви маєте право отримати інформацію про те, які ваші дані ми обробляємо, та отримати їх копію.',
                      article: 'Ст. 15 GDPR',
                    },
                    {
                      title: 'Право на видалення',
                      desc: 'Ви можете вимагати повного видалення ваших персональних даних з наших систем у будь-який час.',
                      article: 'Ст. 17 GDPR',
                    },
                    {
                      title: 'Право на перенесення даних',
                      desc: 'Ви маєте право отримати ваші дані у структурованому форматі для передачі іншому оператору.',
                      article: 'Ст. 20 GDPR',
                    },
                    {
                      title: 'Захист за замовчуванням',
                      desc: 'Ми застосовуємо принципи privacy by design та privacy by default до всіх наших процесів.',
                      article: 'Ст. 25 GDPR',
                    },
                    {
                      title: 'Безпека обробки',
                      desc: 'Дані захищені шифруванням, контролем доступу та регулярним аудитом безпеки.',
                      article: 'Ст. 32 GDPR',
                    },
                  ].map((item) => (
                    <div key={item.article} className="flex gap-3 p-3 bg-claude-bg/50 rounded-xl">
                      <div className="flex-shrink-0 w-6 h-6 bg-[#003399]/10 rounded-md flex items-center justify-center mt-0.5">
                        <ShieldCheck size={14} className="text-[#003399]" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-claude-text font-sans">{item.title}</span>
                          <span className="text-[10px] text-[#003399] bg-[#003399]/10 px-1.5 py-0.5 rounded font-medium font-sans">{item.article}</span>
                        </div>
                        <p className="text-xs text-claude-subtext font-sans mt-1 leading-relaxed">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Official links */}
                <div className="pt-2 border-t border-claude-border">
                  <p className="text-xs font-medium text-claude-text font-sans mb-3">Офіційні документи ЄС:</p>
                  <div className="space-y-2">
                    <a
                      href="https://eur-lex.europa.eu/legal-content/UK/TXT/?uri=CELEX:32016R0679"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-xs text-[#003399] hover:text-[#002266] font-sans transition-colors group"
                    >
                      <ExternalLink size={13} className="flex-shrink-0 opacity-60 group-hover:opacity-100" />
                      <span>Регламент (ЄС) 2016/679 — повний текст українською</span>
                    </a>
                    <a
                      href="https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-xs text-[#003399] hover:text-[#002266] font-sans transition-colors group"
                    >
                      <ExternalLink size={13} className="flex-shrink-0 opacity-60 group-hover:opacity-100" />
                      <span>General Data Protection Regulation (GDPR) — English</span>
                    </a>
                    <a
                      href="https://commission.europa.eu/law/law-topic/data-protection_en"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-xs text-[#003399] hover:text-[#002266] font-sans transition-colors group"
                    >
                      <ExternalLink size={13} className="flex-shrink-0 opacity-60 group-hover:opacity-100" />
                      <span>European Commission — Data Protection</span>
                    </a>
                    <a
                      href="https://edpb.europa.eu/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-xs text-[#003399] hover:text-[#002266] font-sans transition-colors group"
                    >
                      <ExternalLink size={13} className="flex-shrink-0 opacity-60 group-hover:opacity-100" />
                      <span>European Data Protection Board (EDPB)</span>
                    </a>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="p-6 pt-4 border-t border-claude-border">
                <button
                  onClick={() => setShowGDPR(false)}
                  className="w-full px-4 py-3 bg-[#003399] text-white rounded-xl hover:bg-[#002266] transition-colors font-sans font-medium text-sm"
                >
                  Зрозуміло
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>);

}
