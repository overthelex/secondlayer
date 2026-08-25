import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useConsentStore } from '../../stores/consentStore';
import {
  Mail,
  Lock,
  Key,
  Smartphone,
  Shield,
  ShieldCheck,
  ArrowRight,
  Loader2,
  AlertCircle,
  Eye,
  EyeOff,
  User,
  BookOpen,
  X,
  TrendingUp,
  FileText,
  ChevronRight,
  Gift,
  UserPlus,
  Heart,
  Sparkles,
  Building2,
} from 'lucide-react';
import { ClosedBetaModal } from '../../components/ClosedBetaModal';
import { startAuthentication } from '@simplewebauthn/browser';
import { hasRecentArticles } from '../BlogPage/articles';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../services';
import showToast from '../../utils/toast';
import { toastT } from '../../i18n/toast-i18n';
import { ForgotPasswordModal } from './ForgotPasswordModal';
import { GDPRModal } from './GDPRModal';
import { useLoginPageT, setLocale as setI18nLocale, type Locale } from '../../i18n/locales';
import { API_BASE } from '../../utils/api/base';

function LanguageSwitcher() {
  const { locale } = useLoginPageT();
  const langs: { code: Locale; label: string }[] = [
    { code: 'uk', label: 'UA' },
    { code: 'en', label: 'EN' },
    { code: 'de', label: 'DE' },
    { code: 'es', label: 'ES' },
  ];
  return (
    <div className="flex items-center gap-0.5">
      {langs.map((l) => (
        <button
          key={l.code}
          onClick={() => { setI18nLocale(l.code); window.location.reload(); }}
          className={`px-2 py-1 text-[10px] tracking-wider uppercase rounded transition-colors duration-150 ${
            locale === l.code
              ? 'text-zinc-200 bg-zinc-800/80'
              : 'text-zinc-700 hover:text-zinc-500'
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

function isInAppBrowser(): boolean {
  const ua = navigator.userAgent || '';
  return /LinkedInApp|FBAN|FBAV|Instagram|Twitter|Line\/|Snapchat|TikTok|Telegram|Viber/i.test(ua)
    || (/(iPhone|iPod|iPad).*AppleWebKit(?!.*Safari)/i.test(ua))
    || (/Android.*wv\b/.test(ua));
}

const API_URL = API_BASE;
const BASE_URL = API_URL.replace(/\/api$/, '');

type AuthMethod = 'password' | 'hardware-key' | 'phone-key';

interface LoginPageProps {
  onLoginSuccess?: () => void;
}

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

const FADE_UP = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, ease: 'easeOut' as const },
};

// Animated Julia-set fractal on canvas — dark theme with teal/indigo
function FractalBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const startTime = Date.now();
    const MAX_ITER = 35;

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0) {
        canvas.width = Math.floor(w * 0.5);
        canvas.height = Math.floor(h * 0.5);
      }
    };
    setTimeout(resize, 100);
    window.addEventListener('resize', resize);

    function julia(zx: number, zy: number, cx: number, cy: number): number {
      for (let i = 0; i < MAX_ITER; i++) {
        if (zx * zx + zy * zy > 4) {
          return (i + 1 - Math.log(Math.log(Math.sqrt(zx * zx + zy * zy))) / Math.LN2) / MAX_ITER;
        }
        const t = zx * zx - zy * zy + cx;
        zy = 2 * zx * zy + cy;
        zx = t;
      }
      return 0;
    }

    let currentRow = 0;
    let imgData: ImageData | null = null;
    let frameJcx = 0;
    let frameJcy = 0;
    const ROWS_PER_TICK = 100;

    function startNewFrame() {
      const w = canvas!.width;
      const h = canvas!.height;
      if (w === 0 || h === 0) return;

      const elapsed = (Date.now() - startTime) / 1000;
      frameJcx = -0.7 + 0.18 * Math.sin(elapsed * 0.25);
      frameJcy = 0.27015 + 0.14 * Math.cos(elapsed * 0.19);
      imgData = ctx!.createImageData(w, h);
      currentRow = 0;
    }

    function renderChunk() {
      animId = requestAnimationFrame(renderChunk);

      const w = canvas!.width;
      const h = canvas!.height;
      if (w === 0 || h === 0) return;

      if (!imgData || imgData.width !== w || imgData.height !== h) {
        startNewFrame();
      }
      if (!imgData) return;

      const d = imgData.data;
      const aspect = w / h;
      const span = 3.0;
      const endRow = Math.min(currentRow + ROWS_PER_TICK, h);

      for (let y = currentRow; y < endRow; y++) {
        for (let x = 0; x < w; x++) {
          const fx = (x / w - 0.5) * span * aspect;
          const fy = (y / h - 0.5) * span;

          const v = julia(fx, fy, frameJcx, frameJcy);
          const idx = (y * w + x) * 4;

          if (v > 0) {
            const t = v * 3;
            d[idx] = Math.min(255, Math.floor(t * 25 + v * v * 80));
            d[idx + 1] = Math.min(255, Math.floor(t * 55 + v * 40));
            d[idx + 2] = Math.min(255, Math.floor(t * 90 + v * v * 120));
          } else {
            d[idx] = 8;
            d[idx + 1] = 8;
            d[idx + 2] = 10;
          }
          d[idx + 3] = 255;
        }
      }

      currentRow = endRow;

      if (currentRow >= h) {
        ctx!.putImageData(imgData, 0, 0);
        startNewFrame();
      }
    }

    startNewFrame();
    animId = requestAnimationFrame(renderChunk);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', imageRendering: 'auto' }}
      aria-hidden="true"
    />
  );
}

// Vertical rule separating left from right panel — fades top and bottom
function PanelDivider() {
  return (
    <div className="hidden lg:block absolute right-0 top-0 bottom-0 w-px">
      <div className="h-full bg-gradient-to-b from-transparent via-zinc-700/35 to-transparent" />
    </div>
  );
}

const DONATION_AMOUNTS_UAH = [200, 400] as const;
const DONATION_MAX_UAH = 200000;

function DonateCard() {
  const [selected, setSelected] = useState<number | 'custom'>(200);
  const [customAmount, setCustomAmount] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBetaModal, setShowBetaModal] = useState(false);

  const amountUah = selected === 'custom'
    ? Math.floor(parseFloat(customAmount) || 0)
    : selected;
  const canDonate = amountUah >= 1 && amountUah <= DONATION_MAX_UAH;

  const handleDonate = async () => {
    if (!canDonate) {
      setError(amountUah < 1 ? 'Мінімум 1 ₴' : `Максимум ${DONATION_MAX_UAH.toLocaleString('uk-UA')} ₴`);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`${BASE_URL}/api/donations/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_uah: amountUah }),
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 403 || data.errCode === 'FORBIDDEN' || (data.message || data.error || '').includes('terminal')) {
          setShowBetaModal(true);
          setIsLoading(false);
          return;
        }
        throw new Error(data.message || data.error || 'Не вдалося створити донат');
      }

      window.location.href = data.pageUrl;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Помилка донату';
      if (msg.includes('FORBIDDEN') || msg.includes('terminal')) {
        setShowBetaModal(true);
        setIsLoading(false);
        return;
      }
      setError(msg);
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full mt-4 px-4 py-4 rounded-lg bg-zinc-900/40 border border-zinc-800/50 hover:border-zinc-700/70 transition-colors duration-150">
      <div className="flex items-center gap-2 mb-3">
        <Heart size={11} className="text-rose-500/80" />
        <span className="text-[9px] font-bold text-zinc-400 tracking-[0.2em] uppercase">
          Підтримати проект
        </span>
      </div>
      <p className="text-[10px] text-zinc-500 leading-relaxed mb-3">
        Донат через Monobank допомагає розвивати платформу для всіх.
      </p>
      <div className="grid grid-cols-3 gap-1.5 mb-2">
        {DONATION_AMOUNTS_UAH.map((amount) => (
          <button
            key={amount}
            type="button"
            onClick={() => { setSelected(amount); setError(null); }}
            className={`py-2 rounded-md text-[11px] font-medium tracking-wide transition-all duration-150 ${
              selected === amount
                ? 'bg-zinc-100 text-zinc-900 border border-zinc-100'
                : 'bg-zinc-900/60 text-zinc-400 border border-zinc-800/70 hover:border-zinc-700 hover:text-zinc-200'
            }`}
          >
            {amount} ₴
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setSelected('custom'); setError(null); }}
          className={`py-2 rounded-md text-[11px] font-medium tracking-wide transition-all duration-150 ${
            selected === 'custom'
              ? 'bg-zinc-100 text-zinc-900 border border-zinc-100'
              : 'bg-zinc-900/60 text-zinc-400 border border-zinc-800/70 hover:border-zinc-700 hover:text-zinc-200'
          }`}
        >
          Своя
        </button>
      </div>
      {selected === 'custom' && (
        <div className="relative mb-3">
          <input
            type="number"
            min="1"
            max={DONATION_MAX_UAH}
            step="1"
            inputMode="numeric"
            value={customAmount}
            onChange={(e) => { setCustomAmount(e.target.value); setError(null); }}
            placeholder="Введіть суму"
            className="block w-full pl-3 pr-8 py-2 bg-zinc-900/60 border border-zinc-800/70 rounded-md text-[12px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500 pointer-events-none">₴</span>
        </div>
      )}
      {error && (
        <p className="text-[10px] text-red-400 mb-2 flex items-center gap-1">
          <AlertCircle size={10} />
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handleDonate}
        disabled={isLoading || !canDonate}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/70 hover:border-zinc-600 text-zinc-200 text-[11px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isLoading ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <>
            <Heart size={11} className="text-rose-500/80" />
            {canDonate ? `Задонатити ${amountUah} ₴` : 'Задонатити'}
          </>
        )}
      </button>
      <ClosedBetaModal isOpen={showBetaModal} onClose={() => setShowBetaModal(false)} variant="dark" />
    </div>
  );
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
  const [showGDPR, setShowGDPR] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [acceptedDpa, setAcceptedDpa] = useState(false);
  const [showSSOForm, setShowSSOForm] = useState(false);
  const [ssoEmail, setSsoEmail] = useState('');
  const [ssoPassword, setSsoPassword] = useState('');
  const [showSSOPassword, setShowSSOPassword] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [diiaDeeplink, setDiiaDeeplink] = useState<string | null>(null);
  const [diiaSessionId, setDiiaSessionId] = useState<string | null>(null);
  const diiaPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const { t } = useLoginPageT();

  const getReturnUrl = (): string => {
    const saved = sessionStorage.getItem('login_return_url');
    if (saved) {
      sessionStorage.removeItem('login_return_url');
      return saved;
    }
    return '/chat';
  };

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const returnUrl = urlParams.get('returnUrl');
    if (returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
      sessionStorage.setItem('login_return_url', returnUrl);
    }
  }, []);

  useEffect(() => {
    const handleOAuthCallback = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get('token');
      const oauthError = urlParams.get('error');
      const diiaDeeplinkParam = urlParams.get('diia_deeplink');
      const diiaSessionParam = urlParams.get('diia_session');

      if (diiaSessionParam) {
        if (diiaDeeplinkParam) {
          try {
            const parsed = new URL(diiaDeeplinkParam);
            if (parsed.origin === 'https://diia.app') {
              setDiiaDeeplink(parsed.href);
            }
          } catch { /* invalid URL, ignore */ }
        }
        setDiiaSessionId(diiaSessionParam);
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }

      if (oauthError) {
        const errorMap: Record<string, string> = {
          oauth_failed: 'Помилка автентифікації через Google. Спробуйте ще раз.',
          oidc_failed: 'Помилка автентифікації через SSO. Спробуйте ще раз.',
          server_error: 'Помилка сервера. Спробуйте пізніше.',
          diia_not_configured: 'Дія авторизацію ще не налаштовано.',
          diia_scope_forbidden: 'Дія авторизація (diiaId:auth) ще не активована для цього акаунта. Зверніться до адміністратора.',
          diia_failed: 'Помилка автентифікації через Дію. Спробуйте ще раз.',
          diia_no_result: 'Не отримано дані від Дії. Спробуйте ще раз.',
        };
        const msg = errorMap[oauthError] || 'Помилка автентифікації. Спробуйте ще раз.';
        setError(msg);
        showToast.error(msg);
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }

      if (token) {
        setIsLoading(true);
        setError(null);

        try {
          await login(token);
          window.history.replaceState({}, '', window.location.pathname);
          if (onLoginSuccess) onLoginSuccess();
          navigate(getReturnUrl(), { replace: true });
        } catch (err: unknown) {
          console.error('Login failed:', err);
          setError('Не вдалося завершити вхід. Спробуйте ще раз.');
          showToast.error(toastT('loginError'));
        } finally {
          setIsLoading(false);
        }
      }
    };

    handleOAuthCallback();
  }, [login, onLoginSuccess]);

  useEffect(() => {
    if (!diiaSessionId) return;

    diiaPollingRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${BASE_URL}/auth/diia/status/${diiaSessionId}`);
        if (!resp.ok) return;
        const data = await resp.json();

        if (data.status === 'complete' && data.token) {
          clearInterval(diiaPollingRef.current!);
          setDiiaDeeplink(null);
          setDiiaSessionId(null);
          await login(data.token);
          if (onLoginSuccess) onLoginSuccess();
          navigate(getReturnUrl(), { replace: true });
        } else if (data.status === 'expired') {
          clearInterval(diiaPollingRef.current!);
          setDiiaDeeplink(null);
          setDiiaSessionId(null);
          setError('Сесія Дії закінчилась. Спробуйте ще раз.');
        }
      } catch {
        // ignore polling errors
      }
    }, 3000);

    return () => {
      if (diiaPollingRef.current) clearInterval(diiaPollingRef.current);
    };
  }, [diiaSessionId]);

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      if (onLoginSuccess) onLoginSuccess();
      navigate(getReturnUrl(), { replace: true });
    }
  }, [isAuthenticated, isLoading, onLoginSuccess, navigate]);

  const handleSSOAuth = () => {
    if (!isLogin && !allConsentsAccepted) {
      setError('Для реєстрації необхідно прийняти всі документи');
      return;
    }
    setError(null);
    setShowSSOForm(!showSSOForm);
  };

  const handleSSOLogin = async () => {
    setError(null);

    if (!ssoEmail || !ssoPassword) {
      setError('Введіть email та пароль SSO');
      return;
    }

    setSsoLoading(true);

    try {
      const response = await fetch(`${BASE_URL}/auth/oidc/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ssoEmail, password: ssoPassword }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'SSO login failed');

      await login(data.token);
      showToast.success(toastT('ssoLoginSuccess'));
      if (onLoginSuccess) onLoginSuccess();
      navigate(getReturnUrl(), { replace: true });
    } catch (err: unknown) {
      console.error('SSO login failed:', err);
      const msg = err instanceof Error ? err.message : 'Помилка автентифікації через SSO';
      setError(msg);
      showToast.error(toastT('ssoError'));
    } finally {
      setSsoLoading(false);
    }
  };

  const [showWebViewWarning, setShowWebViewWarning] = useState(false);

  const handleGoogleAuth = () => {
    if (!isLogin && !allConsentsAccepted) {
      setError('Для реєстрації необхідно прийняти всі документи');
      return;
    }
    if (isInAppBrowser()) {
      setShowWebViewWarning(true);
      return;
    }
    setError(null);
    window.location.href = `${window.location.origin}/auth/google`;
  };

  const handleDiiaAuth = () => {
    if (!isLogin && !allConsentsAccepted) {
      setError('Для реєстрації необхідно прийняти всі документи');
      return;
    }
    setError(null);
    window.location.href = `${window.location.origin}/auth/diia`;
  };

  const allConsentsAccepted = acceptedTerms && acceptedPrivacy && acceptedDpa;

  const resetConsents = () => {
    setAcceptedTerms(false);
    setAcceptedPrivacy(false);
    setAcceptedDpa(false);
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
      if (!email || !password) {
        setError('Введіть email та пароль');
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
        if (!response.ok) throw new Error(data.message || 'Помилка входу');

        await login(data.token);
        showToast.success(toastT('loginSuccess'));
        if (onLoginSuccess) onLoginSuccess();
        navigate(getReturnUrl(), { replace: true });
      } catch (err: unknown) {
        console.error('Password login failed:', err);
        const msg = err instanceof Error ? err.message : 'Невірний email або пароль';
        setError(msg);
        showToast.error(toastT('loginError'));
      } finally {
        setIsLoading(false);
      }
    } else {
      if (!email || !password) {
        setError('Введіть email та пароль');
        return;
      }

      if (!allConsentsAccepted) {
        setError('Для реєстрації необхідно прийняти всі документи');
        return;
      }

      setIsLoading(true);

      try {
        const referralCode = localStorage.getItem('referral_code') || undefined;

        const response = await fetch(`${BASE_URL}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name: name || undefined, referralCode }),
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Registration failed');

        localStorage.removeItem('referral_code');
        // Track registration as Google Ads conversion (only with analytics consent)
        if (typeof window.gtag === 'function' && useConsentStore.getState().isAllowed('analytics')) {
          window.gtag('event', 'conversion', { send_to: 'AW-18033840618/60XJCI7zyo0cEOqjmpdD', value: 1.0, currency: 'UAH' });
        }
        showToast.success(toastT('registrationSuccess'));
        setIsLogin(true);
        setEmail('');
        setPassword('');
        setName('');
      } catch (err: unknown) {
        console.error('Registration failed:', err);
        const msg = err instanceof Error ? err.message : 'Помилка реєстрації. Спробуйте ще раз.';
        setError(msg);
        showToast.error(toastT('registrationError'));
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleWebAuthnLogin = async (attachment?: 'cross-platform') => {
    setError(null);
    setIsLoading(true);

    try {
      const options = await authService.webauthnAuthOptions(attachment);
      const authResponse = await startAuthentication({ optionsJSON: options });
      const result = await authService.webauthnAuthVerify(authResponse, options.challenge);

      await login(result.token);
      showToast.success(toastT('loginSuccess'));
      if (onLoginSuccess) onLoginSuccess();
      navigate('/chat', { replace: true });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError('Автентифікацію скасовано');
      } else {
        console.error('WebAuthn login failed:', err);
        const msg = err instanceof Error ? err.message : 'Помилка автентифікації';
        setError(msg);
        showToast.error(toastT('authError'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading && !showForgotPassword) {
    return (
      <div className="min-h-screen bg-[#080808] flex items-center justify-center">
        <FractalBackground />
        <div className="relative z-10 flex flex-col items-center gap-6">
          <div className="w-10 h-10 rounded-full border border-zinc-800 flex items-center justify-center">
            <Loader2 size={16} className="text-zinc-600 animate-spin" />
          </div>
          <p className="text-[10px] text-zinc-500 tracking-[0.22em] uppercase">{t.authenticating}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080808] flex relative overflow-hidden">

      {/* ── Architectural background — static, authoritative ── */}
      <FractalBackground />

      {/* ── Left panel: brand identity ── */}
      <div className="hidden lg:flex lg:w-[480px] xl:w-[540px] flex-shrink-0 flex-col justify-between relative overflow-hidden">

        {/* Semi-transparent backdrop for readability over fractal */}
        <div className="absolute inset-0" style={{ background: 'rgba(8,8,8,0.55)' }} />

        {/* Divider on the right edge */}
        <PanelDivider />

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-between h-full p-12 xl:p-14">

          {/* Logo */}
          <div>
            <img src="/logo-white.png" alt="SecondLayer" className="h-9 w-auto opacity-90" />
          </div>

          {/* Value proposition */}
          <div className="space-y-10">

            {/* Eyebrow + Headline */}
            <div>
              <div className="mb-5">
                <span className="inline-block text-[9px] font-semibold tracking-[0.22em] uppercase text-zinc-400 border border-zinc-700/80 px-2.5 py-[5px] rounded-sm">
                  {t.tagline}
                </span>
              </div>
              <h1 className="text-[2.5rem] xl:text-[2.75rem] font-semibold text-white leading-[1.08] tracking-[-0.02em]">
                {t.headline1}
                <br />
                <span className="text-zinc-400">{t.headline2}</span>
              </h1>
              <p className="mt-5 text-[0.85rem] text-zinc-400 leading-[1.7] max-w-[320px]">
                {t.description}
              </p>
            </div>

            {/* Feature list — architectural numbered style */}
            <div className="border-l border-zinc-800/70">
              {[
                { label: t.feature01, number: '01' },
                { label: t.feature02, number: '02' },
                { label: t.feature03, number: '03' },
                { label: t.feature04, number: '04' },
              ].map((feature, i) => (
                <div
                  key={feature.number}
                  className={`flex items-start gap-4 px-5 py-3.5 ${i < 3 ? 'border-b border-zinc-800/50' : ''}`}
                >
                  <span className="text-[10px] font-mono text-zinc-600 mt-0.5 flex-shrink-0 w-5 tabular-nums select-none">{feature.number}</span>
                  <span className="text-[0.775rem] text-zinc-300 leading-snug">{feature.label}</span>
                </div>
              ))}
            </div>

            {/* Welcome & referral promo */}
            <button
              onClick={() => setShowWelcome(true)}
              className="group flex items-center gap-3 text-left w-full"
            >
              <div className="flex-shrink-0 px-2 py-[3px] rounded border border-emerald-800/30 bg-emerald-950/20">
                <span className="text-[8px] font-bold text-emerald-700 tracking-[0.2em] uppercase">{t.promoNew}</span>
              </div>
              <span className="text-[11px] text-zinc-500 group-hover:text-zinc-300 transition-colors duration-200 leading-snug">
                {t.promoDesc}
              </span>
              <ChevronRight
                size={11}
                className="text-zinc-800 group-hover:text-zinc-600 flex-shrink-0 transition-all duration-200 group-hover:translate-x-0.5"
              />
            </button>

          </div>

          {/* AWS Startups Logo */}
          <div className="text-center mt-6">
            <motion.a
              href="https://aws.amazon.com/startups/showcase/startup-details/aa3724a2-2ad3-429d-a762-4415407bbd86"
              target="_blank"
              rel="noopener noreferrer"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.5 }}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              className="inline-flex flex-col items-center gap-2 opacity-70 hover:opacity-100 transition-opacity"
            >
              <span className="text-[10px] text-claude-subtext tracking-wide uppercase">Backed by AWS Activate</span>
              <img
                src="/aws.starups_dark.svg"
                alt="Backed by AWS Activate — LexApp отримав підтримку від AWS Activate для розвитку масштабованої AI-інфраструктури та обробки великих масивів правових даних"
                className="h-8 w-auto"
              />
            </motion.a>
          </div>

          {/* Bottom navigation */}
          <div className="flex items-center gap-5 flex-wrap">
            <a
              href="/blog"
              className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors duration-200 tracking-wide"
            >
              <BookOpen size={10} />
              <span>{t.readBlog}</span>
              {hasRecentArticles() && (
                <span className="w-1 h-1 rounded-full bg-zinc-600 inline-block" />
              )}
            </a>
            <a
              href="/investor"
              className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors duration-200 tracking-wide"
            >
              <TrendingUp size={10} />
              <span>{t.investorsLink}</span>
            </a>
            <a
              href="/uk_investor"
              className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors duration-200 tracking-wide"
            >
              <Shield size={10} />
              <span>UK Investors</span>
            </a>
            <a
              href="/product"
              className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors duration-200 tracking-wide"
            >
              <Sparkles size={10} />
              <span>Product</span>
            </a>
            <a
              href="/about"
              className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors duration-200 tracking-wide"
            >
              <Building2 size={10} />
              <span>About</span>
            </a>
            <a
              href="/pitch-deck.html"
              className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors duration-200 tracking-wide"
            >
              <FileText size={10} />
              <span>Pitch Deck</span>
            </a>
          </div>

        </div>
      </div>

      {/* ── Right panel: auth form ── */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-12 lg:px-16 xl:px-24 relative">

        {/* Semi-transparent backdrop for readability over fractal */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'rgba(8,8,8,0.65)' }}
        />

        {/* Language switcher — top right */}
        <div className="absolute top-4 right-4 sm:top-6 sm:right-6 z-20">
          <LanguageSwitcher />
        </div>

        {/* Mobile logo & tagline */}
        <div className="lg:hidden mb-8 self-start relative z-10">
          <img src="/logo-white.png" alt="SecondLayer" className="h-7 sm:h-8 w-auto opacity-90 mb-3" />
          <p className="text-[0.8rem] text-zinc-400 leading-relaxed max-w-[300px]">
            {t.description}
          </p>
        </div>

        <motion.div
          {...FADE_UP}
          className="w-full max-w-[392px] sm:max-w-[392px] relative z-10"
        >
          {/* Heading */}
          <div className="mb-8">
            <h2 className="text-[1.45rem] font-semibold text-white tracking-[-0.01em] leading-tight mb-2">
              {isLogin ? t.loginTitle : t.registerTitle}
            </h2>
            <p className="text-[0.75rem] text-zinc-400 tracking-wide">
              {isLogin
                ? t.authSubtitleLogin
                : t.authSubtitleRegister}
            </p>
          </div>

          {/* Error banner */}
          <AnimatePresence mode="wait">
            {error && (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="mb-5 px-4 py-3 rounded-lg bg-red-950/20 border border-red-900/30 flex items-start gap-3"
              >
                <AlertCircle size={12} className="text-red-500 flex-shrink-0 mt-px" />
                <p className="text-[0.75rem] text-red-400 leading-snug flex-1">{error}</p>
                <button
                  onClick={() => setError(null)}
                  className="text-red-900 hover:text-red-600 flex-shrink-0 transition-colors ml-1"
                >
                  <X size={12} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Legal consent (registration only) */}
          <AnimatePresence>
            {!isLogin && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
                className="overflow-hidden mb-5"
              >
                <div className="space-y-2.5 px-4 py-4 rounded-lg bg-zinc-900/50 border border-zinc-800/60">
                  <p className="text-[9px] font-semibold text-zinc-400 uppercase tracking-[0.2em] mb-3">
                    {t.consentRequired}
                  </p>
                  {[
                    {
                      checked: acceptedTerms,
                      onChange: setAcceptedTerms,
                      links: [
                        { href: '/ua/terms', label: t.consentTerms },
                        { href: '/ua/offer', label: t.consentOffer },
                      ],
                      separator: t.consentAnd,
                    },
                    {
                      checked: acceptedPrivacy,
                      onChange: setAcceptedPrivacy,
                      links: [{ href: '/ua/privacy', label: t.consentPrivacy }],
                      separator: '',
                    },
                    {
                      checked: acceptedDpa,
                      onChange: setAcceptedDpa,
                      links: [{ href: '/ua/dpa', label: t.consentDpa }],
                      separator: '',
                    },
                  ].map((item, i) => (
                    <label key={i} className="flex items-start gap-2.5 cursor-pointer group">
                      <div
                        className="relative mt-0.5 flex-shrink-0"
                        onClick={() => item.onChange(!item.checked)}
                      >
                        <div className={`w-3.5 h-3.5 rounded-sm border transition-all duration-150 flex items-center justify-center ${
                          item.checked
                            ? 'bg-white border-white'
                            : 'border-zinc-700 bg-transparent group-hover:border-zinc-500'
                        }`}>
                          {item.checked && (
                            <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                              <path d="M1 3.5L3.5 6L8 1" stroke="#080808" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          )}
                        </div>
                      </div>
                      <span className="text-[11px] text-zinc-500 leading-relaxed group-hover:text-zinc-400 transition-colors">
                        {item.links.map((link, li) => (
                          <span key={link.href}>
                            <a
                              href={link.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-zinc-300 hover:text-white underline underline-offset-2 decoration-zinc-700 hover:decoration-zinc-400 transition-colors"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {link.label}
                            </a>
                            {li < item.links.length - 1 && item.separator}
                          </span>
                        ))}
                      </span>
                    </label>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Primary: Google OAuth */}
          <button
            onClick={handleGoogleAuth}
            className="w-full flex items-center justify-center gap-3 px-4 py-[11px] rounded-lg bg-white text-zinc-900 text-[0.825rem] font-medium hover:bg-zinc-100 active:bg-zinc-200 transition-colors duration-150 mb-2 shadow-sm"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            {t.googleAuth}
          </button>

          {showWebViewWarning && (
            <div className="flex flex-col gap-2 px-3 py-2.5 mb-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[0.78rem] leading-snug">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{t.webviewGoogleWarning}</span>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(window.location.origin);
                  showToast.success(t.webviewLinkCopied);
                }}
                className="w-full py-2 rounded-md bg-amber-500/20 hover:bg-amber-500/30 active:bg-amber-500/40 text-amber-200 font-medium text-[0.8rem] transition-colors"
              >
                {t.webviewCopyLink}
              </button>
            </div>
          )}

          {/* Diia Auth */}
          <button
            onClick={handleDiiaAuth}
            className="w-full flex items-center justify-center gap-1.5 px-4 py-[11px] rounded-lg bg-[#0a0a0a] border border-zinc-800/80 text-zinc-300 text-[0.825rem] font-medium hover:bg-zinc-900 hover:border-zinc-700 active:opacity-80 transition-colors duration-150 mb-2"
          >
            <img src="/diia-logo-stroke.png" alt="Дія" width="24" height="24" className="flex-shrink-0" />
            {t.diiaAuth}
          </button>

          {/* SSO */}
          <button
            onClick={handleSSOAuth}
            className={`w-full flex items-center justify-center gap-2.5 px-4 py-[11px] bg-[#0a0a0a] border border-zinc-800/80 text-zinc-400 text-[0.825rem] font-medium hover:bg-zinc-900 hover:border-zinc-700 hover:text-zinc-300 active:opacity-80 transition-colors duration-150 ${showSSOForm ? 'rounded-t-lg' : 'rounded-lg mb-5'}`}
          >
            <ShieldCheck size={13} className="flex-shrink-0" />
            {t.ssoAuth}
          </button>

          <AnimatePresence>
            {showSSOForm && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden mb-5"
              >
                <div className="bg-zinc-900/60 border border-t-0 border-zinc-800/80 rounded-b-lg p-4 space-y-3">
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Mail size={12} className="text-zinc-700" />
                    </div>
                    <input
                      type="email"
                      value={ssoEmail}
                      onChange={(e) => setSsoEmail(e.target.value)}
                      placeholder="SSO email"
                      autoComplete="username"
                      className="block w-full pl-9 pr-4 py-2.5 bg-zinc-800/50 border border-zinc-700/50 rounded-md text-sm text-zinc-200 placeholder-zinc-700 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                    />
                  </div>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Lock size={12} className="text-zinc-700" />
                    </div>
                    <input
                      type={showSSOPassword ? 'text' : 'password'}
                      value={ssoPassword}
                      onChange={(e) => setSsoPassword(e.target.value)}
                      placeholder="SSO пароль"
                      autoComplete="current-password"
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSSOLogin(); }}
                      className="block w-full pl-9 pr-10 py-2.5 bg-zinc-800/50 border border-zinc-700/50 rounded-md text-sm text-zinc-200 placeholder-zinc-700 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSSOPassword(!showSSOPassword)}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-700 hover:text-zinc-500 transition-colors"
                    >
                      {showSSOPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                  <button
                    onClick={handleSSOLogin}
                    disabled={ssoLoading}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-700/80 hover:bg-zinc-700 text-zinc-100 rounded-md text-sm font-medium transition-colors duration-150 disabled:opacity-40"
                  >
                    {ssoLoading ? <Loader2 size={13} className="animate-spin" /> : <><ArrowRight size={12} />{t.ssoLoginButtonText}</>}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Divider */}
          <div className="relative mb-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-zinc-800/50" />
            </div>
            <div className="relative flex justify-center">
              <span className="px-3 bg-[#080808] text-[9px] text-zinc-500 tracking-[0.18em] uppercase">{t.orDivider}</span>
            </div>
          </div>

          {/* Auth method tabs */}
          <div className="flex gap-px mb-5 rounded-lg overflow-hidden border border-zinc-800/50 bg-[#0a0a0a]">
            {([
              { key: 'password', icon: Lock, label: t.tabPassword },
              { key: 'hardware-key', icon: Key, label: t.tabKey },
              { key: 'phone-key', icon: Smartphone, label: t.tabPhone },
            ] as const).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onClick={() => setAuthMethod(key)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] font-medium transition-all duration-150 ${
                  authMethod === key
                    ? 'bg-zinc-800/80 text-zinc-200'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40'
                }`}
              >
                <Icon size={11} />
                {label}
              </button>
            ))}
          </div>

          {/* Auth forms */}
          <AnimatePresence mode="wait">
            {authMethod === 'password' && (
              <motion.form
                key="password"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 6 }}
                transition={{ duration: 0.18 }}
                className="space-y-3"
                onSubmit={(e) => { e.preventDefault(); handlePasswordAuth(); }}
                method="post"
                autoComplete="on"
              >
                {!isLogin && (
                  <div>
                    <label htmlFor="name" className="block text-[10px] font-medium text-zinc-400 mb-1.5 tracking-[0.08em] uppercase">
                      {t.nameLabel}
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <User size={12} className="text-zinc-700" />
                      </div>
                      <input
                        id="name"
                        name="name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t.namePlaceholderExample}
                        autoComplete="name"
                        className="block w-full pl-9 pr-4 py-2.5 bg-zinc-900/50 border border-zinc-800/70 rounded-lg text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label htmlFor="email" className="block text-[10px] font-medium text-zinc-400 mb-1.5 tracking-[0.08em] uppercase">
                    Email
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Mail size={12} className="text-zinc-700" />
                    </div>
                    <input
                      id="email"
                      name="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      autoComplete={isLogin ? 'username' : 'email'}
                      className="block w-full pl-9 pr-4 py-2.5 bg-zinc-900/50 border border-zinc-800/70 rounded-lg text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="password" className="block text-[10px] font-medium text-zinc-400 tracking-[0.08em] uppercase">
                      {t.passwordLabel}
                    </label>
                    {isLogin && (
                      <button
                        type="button"
                        onClick={() => { setShowForgotPassword(true); setError(null); }}
                        className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors duration-150"
                      >
                        {t.forgotPassword}
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Lock size={12} className="text-zinc-700" />
                    </div>
                    <input
                      id="password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => handlePasswordChange(e.target.value)}
                      placeholder="••••••••"
                      autoComplete={isLogin ? 'current-password' : 'new-password'}
                      className="block w-full pl-9 pr-10 py-2.5 bg-zinc-900/50 border border-zinc-800/70 rounded-lg text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-700 hover:text-zinc-500 transition-colors"
                    >
                      {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>

                  {!isLogin && password && (
                    <div className="mt-2.5">
                      <div className="flex gap-0.5">
                        {(['weak', 'medium', 'strong'] as const).map((level, i) => {
                          const filled = (
                            (passwordStrength === 'weak' && i === 0) ||
                            (passwordStrength === 'medium' && i <= 1) ||
                            (passwordStrength === 'strong')
                          );
                          const color = passwordStrength === 'weak' ? 'bg-red-700' : passwordStrength === 'medium' ? 'bg-amber-600' : 'bg-emerald-600';
                          return <div key={level} className={`h-px flex-1 ${filled ? color : 'bg-zinc-800'} transition-colors duration-200`} />;
                        })}
                      </div>
                      <p className="text-[10px] text-zinc-500 mt-1.5">
                        {passwordStrength === 'weak' && t.strengthWeakDesc}
                        {passwordStrength === 'medium' && t.strengthMediumDesc}
                        {passwordStrength === 'strong' && t.strengthStrongDesc}
                      </p>
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={isLoading || (!isLogin && !allConsentsAccepted)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-[11px] mt-1 bg-white text-zinc-900 rounded-lg text-[0.825rem] font-medium hover:bg-zinc-100 active:bg-zinc-200 transition-colors duration-150 disabled:opacity-20 disabled:cursor-not-allowed shadow-sm"
                >
                  {isLoading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <>
                      {isLogin ? t.loginButton : t.registerButton}
                      <ArrowRight size={12} />
                    </>
                  )}
                </button>
              </motion.form>
            )}

            {authMethod === 'hardware-key' && (
              <motion.div
                key="hardware-key"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 6 }}
                transition={{ duration: 0.18 }}
                className="py-10 text-center"
              >
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-zinc-900/50 border border-zinc-800/70 mb-5">
                  <Shield size={20} className="text-zinc-600" />
                </div>
                <h3 className="text-[0.825rem] font-medium text-zinc-300 mb-1.5">{t.hardwareKeyTitle}</h3>
                <p className="text-[0.75rem] text-zinc-400 mb-6 leading-relaxed">{t.hardwareKeyDesc}</p>
                <button
                  onClick={() => handleWebAuthnLogin('cross-platform')}
                  disabled={isLoading}
                  className="px-6 py-2.5 bg-zinc-900/80 border border-zinc-700/80 text-zinc-400 rounded-lg text-sm font-medium hover:bg-zinc-800 hover:text-zinc-200 transition-colors duration-150 disabled:opacity-40"
                >
                  {isLoading ? <Loader2 size={13} className="animate-spin inline mr-2" /> : null}
                  {t.authenticating}
                </button>
              </motion.div>
            )}

            {authMethod === 'phone-key' && (
              <motion.div
                key="phone-key"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 6 }}
                transition={{ duration: 0.18 }}
                className="py-10 text-center"
              >
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-zinc-900/50 border border-zinc-800/70 mb-5">
                  <Smartphone size={20} className="text-zinc-600" />
                </div>
                <h3 className="text-[0.825rem] font-medium text-zinc-300 mb-1.5">{t.phoneKeyTitle}</h3>
                <p className="text-[0.75rem] text-zinc-400 mb-6 leading-relaxed">{t.phoneKeyDesc}</p>
                <button
                  onClick={() => handleWebAuthnLogin()}
                  disabled={isLoading}
                  className="px-6 py-2.5 bg-zinc-900/80 border border-zinc-700/80 text-zinc-400 rounded-lg text-sm font-medium hover:bg-zinc-800 hover:text-zinc-200 transition-colors duration-150 disabled:opacity-40"
                >
                  {isLoading ? <Loader2 size={13} className="animate-spin inline mr-2" /> : null}
                  {t.authenticating}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Toggle login / register */}
          <p className="text-center text-[12px] text-zinc-500 mt-6">
            {isLogin ? t.noAccount : t.hasAccount}{' '}
            <button
              onClick={() => { setIsLogin(!isLogin); setError(null); setPassword(''); resetConsents(); }}
              className="text-zinc-400 hover:text-white transition-colors duration-150 font-medium"
            >
              {isLogin ? t.createAccount : t.signIn}
            </button>
          </p>

          {/* GDPR badge */}
          <button
            onClick={() => setShowGDPR(true)}
            className="w-full mt-5 px-4 py-3 rounded-lg bg-zinc-900/40 border border-zinc-800/50 hover:border-zinc-700/70 hover:bg-zinc-900/60 flex items-center gap-3 transition-colors duration-150 text-left group"
          >
            <div className="flex-shrink-0 w-6 h-6 rounded-md bg-[#0c1524] border border-[#172645]/50 flex items-center justify-center">
              <ShieldCheck size={11} className="text-[#4d6ef5]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[8px] font-bold text-[#4d6ef5] tracking-[0.2em] uppercase">GDPR</span>
                <span className="w-px h-2 bg-zinc-800 inline-block" />
                <span className="text-[10px] text-zinc-400">{t.gdprDesc}</span>
              </div>
              <p className="text-[9px] text-zinc-500 tracking-wide">
                {t.gdprCompliance}
              </p>
            </div>
            <ChevronRight
              size={11}
              className="text-zinc-800 group-hover:text-zinc-600 flex-shrink-0 transition-all duration-200 group-hover:translate-x-0.5"
            />
          </button>

          {/* Donate */}
          <DonateCard />

          {/* Footer legal links */}
          <div className="mt-5 pb-4 sm:pb-0 flex flex-wrap justify-center gap-x-3 gap-y-1.5">
            {[
              { href: '/ua/terms', label: t.footerTerms },
              { href: '/ua/offer', label: t.footerOffer },
              { href: '/ua/privacy', label: t.footerPrivacy },
              { href: '/ua/dpa', label: t.footerDpa },
              { href: '/ua/ai-usage', label: t.footerAiPolicy },
              { href: '/ua/ai-transparency', label: t.footerAiTransparency },
            ].map(({ href, label }) => (
              <a
                key={href}
                href={href}
                className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors duration-150"
              >
                {label}
              </a>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Forgot Password Modal */}
      <AnimatePresence>
        {showForgotPassword && (
          <ForgotPasswordModal
            initialEmail={email}
            onClose={() => setShowForgotPassword(false)}
          />
        )}
      </AnimatePresence>

      {/* GDPR Info Modal */}
      <AnimatePresence>
        {showGDPR && <GDPRModal onClose={() => setShowGDPR(false)} />}
      </AnimatePresence>

      {/* Welcome & Offers Modal */}
      <AnimatePresence>
        {showWelcome && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={() => setShowWelcome(false)}
          >
            <motion.div
              initial={{ scale: 0.97, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.97, opacity: 0, y: 8 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
              className="relative bg-zinc-950 border border-zinc-800/70 rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto"
            >
              <button
                onClick={() => setShowWelcome(false)}
                className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-md text-zinc-700 hover:text-zinc-400 hover:bg-zinc-900 transition-colors z-10"
              >
                <X size={13} />
              </button>

              <div className="p-8">
                {/* Header */}
                <div className="mb-6">
                  <h3 className="text-xl font-semibold text-white mb-1.5 tracking-tight">{t.welcomeModalTitle}</h3>
                  <p className="text-sm text-zinc-500">{t.welcomeModalDesc}</p>
                </div>

                {/* Documents section */}
                <div className="mb-6">
                  <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.18em] mb-3">
                    {t.legalDocsTitle}
                  </p>
                  <div className="space-y-1.5">
                    {[
                      { href: '/ua/offer', label: t.docOffer, desc: t.docOfferDesc },
                      { href: '/ua/terms', label: t.docTerms, desc: t.docTermsDesc },
                      { href: '/ua/privacy', label: t.docPrivacy, desc: t.docPrivacyDesc },
                      { href: '/ua/dpa', label: t.docDpa, desc: t.docDpaDesc },
                      { href: '/ua/refund', label: t.docRefund, desc: t.docRefundDesc },
                    ].map((doc) => (
                      <a
                        key={doc.href}
                        href={doc.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between px-4 py-3 rounded-lg bg-zinc-900/50 border border-zinc-800/50 hover:border-zinc-700/80 hover:bg-zinc-900/80 transition-colors group"
                      >
                        <div>
                          <p className="text-sm text-zinc-300 group-hover:text-white transition-colors">{doc.label}</p>
                          <p className="text-[11px] text-zinc-600">{doc.desc}</p>
                        </div>
                        <ChevronRight size={13} className="text-zinc-700 group-hover:text-zinc-500 flex-shrink-0 transition-colors" />
                      </a>
                    ))}
                  </div>
                </div>

                {/* Divider */}
                <div className="h-px bg-zinc-800/50 mb-6" />

                {/* Referral program */}
                <div className="mb-6">
                  <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.18em] mb-3">
                    {t.referralTitle}
                  </p>
                  <div className="px-4 py-4 rounded-lg bg-zinc-900/50 border border-zinc-800/50">
                    <div className="flex items-start gap-3 mb-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-emerald-950/40 border border-emerald-800/25 flex items-center justify-center">
                        <Gift size={13} className="text-emerald-700" />
                      </div>
                      <div>
                        <p className="text-sm text-zinc-300 font-medium mb-0.5">{t.referralHeadline}</p>
                        <p className="text-[11px] text-zinc-600 leading-relaxed">
                          {t.referralDesc}
                        </p>
                      </div>
                    </div>
                    <div className="space-y-1.5 ml-11">
                      {[
                        t.referralItem1,
                        t.referralItem2,
                        t.referralItem3,
                      ].map((item, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <div className="w-1 h-1 rounded-full bg-zinc-700 flex-shrink-0" />
                          <span className="text-[11px] text-zinc-500">{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* CTA */}
                <button
                  onClick={() => {
                    setShowWelcome(false);
                    setIsLogin(false);
                  }}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-white text-zinc-900 rounded-lg text-sm font-medium hover:bg-zinc-100 transition-colors"
                >
                  <UserPlus size={14} />
                  {t.referralCta}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Diia completing — returned from Diia app, polling in progress */}
      <AnimatePresence>
        {diiaSessionId && !diiaDeeplink && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          >
            <motion.div
              initial={{ scale: 0.97, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.97, opacity: 0, y: 8 }}
              transition={{ duration: 0.2 }}
              className="relative bg-zinc-950 border border-zinc-800/70 rounded-2xl shadow-2xl p-8 max-w-sm w-full text-center"
            >
              <button
                onClick={() => { setDiiaSessionId(null); }}
                className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-md text-zinc-700 hover:text-zinc-400 hover:bg-zinc-900 transition-colors"
              >
                <X size={13} />
              </button>

              <img src="/diia-logo-stroke.png" alt="Дія" width="44" height="44" className="mx-auto mb-5" />

              <h2 className="text-[0.9rem] font-semibold text-zinc-100 mb-1.5 tracking-tight">Завершення входу</h2>
              <p className="text-[0.75rem] text-zinc-500 mb-6 leading-relaxed">
                Обробка авторизації через Дію…
              </p>

              <Loader2 size={22} className="animate-spin text-zinc-600 mx-auto mb-4" />

              <p className="text-[10px] text-zinc-700">
                Очікування підтвердження від Дії
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Diia QR Modal */}
      <AnimatePresence>
        {diiaDeeplink && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={() => { setDiiaDeeplink(null); setDiiaSessionId(null); }}
          >
            <motion.div
              initial={{ scale: 0.97, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.97, opacity: 0, y: 8 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
              className="relative bg-zinc-950 border border-zinc-800/70 rounded-2xl shadow-2xl p-8 max-w-sm w-full text-center"
            >
              <button
                onClick={() => { setDiiaDeeplink(null); setDiiaSessionId(null); }}
                className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-md text-zinc-700 hover:text-zinc-400 hover:bg-zinc-900 transition-colors"
              >
                <X size={13} />
              </button>

              <img src="/diia-logo-stroke.png" alt="Дія" width="44" height="44" className="mx-auto mb-5" />

              <h2 className="text-[0.9rem] font-semibold text-zinc-100 mb-1.5 tracking-tight">Авторизація через Дія.Підпис</h2>
              <p className="text-[0.75rem] text-zinc-500 mb-6 leading-relaxed">
                Відкрийте застосунок Дія та відскануйте QR-код або натисніть кнопку нижче
              </p>

              <div className="bg-white rounded-xl p-4 mb-5 inline-block mx-auto">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(diiaDeeplink)}`}
                  alt="Diia QR code"
                  className="w-44 h-44"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>

              <a
                href={diiaDeeplink}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-300 rounded-lg font-medium text-sm transition-colors mb-4"
              >
                Відкрити в застосунку Дія
              </a>

              <p className="text-[10px] text-zinc-700 flex items-center justify-center gap-2">
                <Loader2 size={10} className="animate-spin" />
                Очікування автентифікації…
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
