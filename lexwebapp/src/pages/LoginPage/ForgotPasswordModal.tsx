import { useState } from 'react';
import { motion } from 'framer-motion';
import { Mail, Loader2, X } from 'lucide-react';
import showToast from '../../utils/toast';
import { useForgotPasswordT } from '../../i18n/locales';
import { API_BASE } from '../../utils/api/base';

const API_URL = API_BASE;
const BASE_URL = API_URL.replace(/\/api$/, '');

interface ForgotPasswordModalProps {
  initialEmail: string;
  onClose: () => void;
  isDark?: boolean;
}

export function ForgotPasswordModal({ initialEmail, onClose, isDark = true }: ForgotPasswordModalProps) {
  const [email, setEmail] = useState(initialEmail);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dk = isDark;
  const { t } = useForgotPasswordT();

  const handleSubmit = async () => {
    if (!email) {
      setError(t.enterEmail);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${BASE_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || t.sendError);
      }

      showToast.success(t.sendSuccess);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t.sendFailedGeneric;
      setError(msg);
      showToast.error(t.sendErrorToast);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className={`fixed inset-0 backdrop-blur-sm flex items-center justify-center z-50 p-4 ${dk ? 'bg-black/80' : 'bg-black/40'}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 12 }}
        transition={{ duration: 0.2 }}
        className={`border rounded-2xl p-6 max-w-md w-full shadow-2xl ${dk ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-zinc-200'}`}
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className={`text-base font-semibold ${dk ? 'text-zinc-100' : 'text-zinc-900'}`}>{t.title}</h2>
            <p className={`text-xs mt-0.5 leading-relaxed ${dk ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {t.description}
            </p>
          </div>
          <button
            onClick={onClose}
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors flex-shrink-0 ml-4 ${dk ? 'hover:bg-zinc-800 text-zinc-600 hover:text-zinc-300' : 'hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600'}`}
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <p className={`text-xs mb-4 px-3 py-2 rounded-lg border ${dk ? 'text-red-400 bg-red-950/30 border-red-800/30' : 'text-red-600 bg-red-50 border-red-200'}`}>
            {error}
          </p>
        )}

        <div className="relative mb-4">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Mail size={14} className={dk ? 'text-zinc-600' : 'text-zinc-400'} />
          </div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="your@email.com"
            autoFocus
            className={`block w-full pl-9 pr-4 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-1 transition-all ${dk ? 'bg-zinc-900 border-zinc-800 text-zinc-100 placeholder-zinc-700 focus:ring-zinc-600 focus:border-zinc-600' : 'bg-zinc-50 border-zinc-200 text-zinc-900 placeholder-zinc-400 focus:ring-zinc-400 focus:border-zinc-400'}`}
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className={`flex-1 px-4 py-2.5 border rounded-lg text-sm transition-colors duration-150 ${dk ? 'border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:border-zinc-700' : 'border-zinc-200 text-zinc-500 hover:text-zinc-700 hover:border-zinc-300'}`}
          >
            {t.cancel}
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 disabled:opacity-40 flex items-center justify-center ${dk ? 'bg-white text-zinc-900 hover:bg-zinc-100' : 'bg-zinc-900 text-white hover:bg-zinc-800'}`}
          >
            {isLoading ? <Loader2 size={15} className="animate-spin" /> : t.send}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
