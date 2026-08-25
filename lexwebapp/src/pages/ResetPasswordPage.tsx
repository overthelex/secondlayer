import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Lock, Eye, EyeOff, CheckCircle, Loader2 } from 'lucide-react';
import showToast from '../utils/toast';
import { toastT } from '../i18n/toast-i18n';
import { getErrorMessage } from '../utils/errors';
import { getLocale, Locale } from '../i18n/locales';
import { API_BASE } from '../utils/api/base';

const resetStrings: Record<Locale, Record<string, string>> = {
  uk: {
    title: 'Скидання паролю', subtitle: 'Введіть новий пароль',
    newPassword: 'Новий пароль', confirmPassword: 'Підтвердіть пароль',
    submit: 'Скинути пароль', fillAll: 'Заповніть всі поля',
    mismatch: 'Паролі не співпадають', tooShort: 'Пароль повинен містити щонайменше 8 символів',
    invalidLink: 'Недійсне посилання для скидання', resetError: 'Помилка скидання паролю',
    successTitle: 'Пароль успішно скинуто!', successDesc: 'Тепер ви можете увійти з новим паролем.',
    redirecting: 'Перенаправлення на сторінку входу...',
  },
  en: {
    title: 'Reset Password', subtitle: 'Enter your new password',
    newPassword: 'New password', confirmPassword: 'Confirm password',
    submit: 'Reset password', fillAll: 'Fill in all fields',
    mismatch: 'Passwords do not match', tooShort: 'Password must be at least 8 characters',
    invalidLink: 'Invalid reset link', resetError: 'Password reset error',
    successTitle: 'Password reset successfully!', successDesc: 'You can now sign in with your new password.',
    redirecting: 'Redirecting to login page...',
  },
  de: {
    title: 'Passwort zurücksetzen', subtitle: 'Geben Sie Ihr neues Passwort ein',
    newPassword: 'Neues Passwort', confirmPassword: 'Passwort bestätigen',
    submit: 'Passwort zurücksetzen', fillAll: 'Alle Felder ausfüllen',
    mismatch: 'Passwörter stimmen nicht überein', tooShort: 'Passwort muss mindestens 8 Zeichen lang sein',
    invalidLink: 'Ungültiger Reset-Link', resetError: 'Fehler beim Zurücksetzen des Passworts',
    successTitle: 'Passwort erfolgreich zurückgesetzt!', successDesc: 'Sie können sich jetzt mit Ihrem neuen Passwort anmelden.',
    redirecting: 'Weiterleitung zur Anmeldeseite...',
  },
  es: {
    title: 'Restablecer contraseña', subtitle: 'Introduzca su nueva contraseña',
    newPassword: 'Nueva contraseña', confirmPassword: 'Confirmar contraseña',
    submit: 'Restablecer contraseña', fillAll: 'Complete todos los campos',
    mismatch: 'Las contraseñas no coinciden', tooShort: 'La contraseña debe tener al menos 8 caracteres',
    invalidLink: 'Enlace de restablecimiento no válido', resetError: 'Error al restablecer la contraseña',
    successTitle: '¡Contraseña restablecida con éxito!', successDesc: 'Ahora puede iniciar sesión con su nueva contraseña.',
    redirecting: 'Redirigiendo a la página de inicio de sesión...',
  },
};

const API_URL = API_BASE;
const BASE_URL = API_URL.replace(/\/api$/, '');

export function ResetPasswordPage() {
  const t = resetStrings[getLocale()];
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async () => {
    setError(null);

    if (!password || !confirmPassword) {
      setError(t.fillAll);
      return;
    }

    if (password !== confirmPassword) {
      setError(t.mismatch);
      return;
    }

    if (password.length < 8) {
      setError(t.tooShort);
      return;
    }

    const token = searchParams.get('token');

    if (!token) {
      setError(t.invalidLink);
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(`${BASE_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || t.resetError);
      }

      setSuccess(true);
      showToast.success(toastT('passwordResetSuccess'));

      setTimeout(() => {
        navigate('/login');
      }, 3000);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
      showToast.error(toastT('passwordResetError'));
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-2xl shadow-xl border border-claude-border p-8 max-w-md w-full text-center"
        >
          <CheckCircle size={64} className="text-green-500 mx-auto mb-4" />
          <h1 className="text-2xl font-sans text-claude-text mb-2">{t.successTitle}</h1>
          <p className="text-claude-subtext mb-6">{t.successDesc}</p>
          <p className="text-sm text-claude-subtext">{t.redirecting}</p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-2xl shadow-xl border border-claude-border p-8 max-w-md w-full"
      >
        <h1 className="text-3xl font-sans text-claude-text mb-2 text-center">{t.title}</h1>
        <p className="text-claude-subtext mb-6 text-center">{t.subtitle}</p>

        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-claude-text mb-2 font-sans">{t.newPassword}</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock size={18} className="text-claude-subtext" />
              </div>
              <input
                id="reset-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className="block w-full pl-10 pr-12 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-claude-subtext hover:text-claude-text transition-colors"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2 font-sans">{t.confirmPassword}</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock size={18} className="text-claude-subtext" />
              </div>
              <input
                id="reset-confirm-password"
                name="confirmPassword"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                placeholder="••••••••"
                autoComplete="new-password"
                className="block w-full pl-10 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
              />
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={isLoading}
            className="w-full px-4 py-3 bg-black text-white rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 font-sans flex items-center justify-center"
          >
            {isLoading ? <Loader2 size={18} className="animate-spin" /> : t.submit}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
