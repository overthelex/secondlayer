/**
 * Shown when Monobank refuses to create a payment (e.g. the terminal is
 * disabled), so the user knows payment is temporarily unavailable and whom
 * to contact. The component name is historical.
 */
import { motion, AnimatePresence } from 'framer-motion';
import { X, Mail, CreditCard } from 'lucide-react';

interface ClosedBetaModalProps {
  isOpen: boolean;
  onClose: () => void;
  variant?: 'dark' | 'light';
}

const CONTACT_EMAIL = 'info@legal.org.ua';

export function ClosedBetaModal({ isOpen, onClose, variant = 'dark' }: ClosedBetaModalProps) {
  const isDark = variant === 'dark';

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[1050] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.25 }}
            className={`relative w-full max-w-md mx-4 rounded-2xl shadow-2xl ${
              isDark
                ? 'bg-zinc-950 border border-zinc-800/70'
                : 'bg-white border border-gray-200'
            }`}
          >
            <button
              onClick={onClose}
              className={`absolute top-4 right-4 p-1.5 rounded-lg transition-colors ${
                isDark
                  ? 'text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/60'
                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
              }`}
            >
              <X size={16} />
            </button>

            <div className="px-6 pt-6 pb-5">
              <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl mb-4 ${
                isDark ? 'bg-zinc-800/80' : 'bg-gray-100'
              }`}>
                <CreditCard size={18} className={isDark ? 'text-zinc-400' : 'text-gray-500'} />
              </div>

              <h3 className={`text-base font-semibold mb-2 ${
                isDark ? 'text-zinc-100' : 'text-gray-900'
              }`}>
                Оплата тимчасово недоступна
              </h3>

              <p className={`text-sm leading-relaxed mb-4 ${
                isDark ? 'text-zinc-400' : 'text-gray-600'
              }`}>
                Не вдалося відкрити сторінку оплати Monobank. Спробуйте ще раз за кілька хвилин.
              </p>

              <div className={`rounded-xl px-4 py-3 mb-4 ${
                isDark
                  ? 'bg-zinc-900/60 border border-zinc-800/60'
                  : 'bg-gray-50 border border-gray-200'
              }`}>
                <p className={`text-xs font-medium mb-1.5 ${
                  isDark ? 'text-zinc-300' : 'text-gray-700'
                }`}>
                  Якщо помилка повторюється:
                </p>
                <p className={`text-xs leading-relaxed ${
                  isDark ? 'text-zinc-500' : 'text-gray-500'
                }`}>
                  Напишіть нам, і ми допоможемо поповнити баланс або виставимо рахунок для оплати.
                </p>
              </div>

              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className={`flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 ${
                  isDark
                    ? 'bg-zinc-100 text-zinc-900 hover:bg-white'
                    : 'bg-gray-900 text-white hover:bg-gray-800'
                }`}
              >
                <Mail size={14} />
                {CONTACT_EMAIL}
              </a>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
