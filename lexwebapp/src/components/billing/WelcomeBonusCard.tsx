/**
 * Welcome bonus offer: verify a card with a refundable 1 UAH Monobank
 * payment and get the welcome bonus. Renders nothing once the account has
 * claimed it (or the status cannot be loaded).
 */

import { useEffect, useState } from 'react';
import { Gift, Loader2 } from 'lucide-react';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';
import { getErrorMessage } from '../../utils/errors';

interface BonusStatus {
  amount_uah: number;
  verify_amount_uah: number;
  available: boolean;
}

export function WelcomeBonusCard() {
  const [status, setStatus] = useState<BonusStatus | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const returned = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('card_verify') === '1';

  useEffect(() => {
    api.payment.getWelcomeBonus()
      .then(({ data }) => setStatus(data))
      .catch(() => setStatus(null));
  }, []);

  if (!status) return null;

  if (!status.available) {
    if (!returned) return null;
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-800">
        Картку перевірено. Вітальний бонус {status.amount_uah} грн нараховано на баланс (якщо ця картка
        ще не приносила бонус іншому акаунту), а {status.verify_amount_uah} ₴ повертаємо на картку.
      </div>
    );
  }

  const handleVerify = async () => {
    setIsProcessing(true);
    try {
      const { data } = await api.payment.createCardVerify();
      window.location.href = data.pageUrl;
    } catch (err: unknown) {
      showToast.error(getErrorMessage(err));
      setIsProcessing(false);
    }
  };

  return (
    <div className="bg-white border border-claude-border rounded-xl p-5 flex flex-col sm:flex-row sm:items-center gap-4">
      <Gift size={28} className="text-claude-accent shrink-0" />
      <div className="flex-1">
        <p className="font-semibold text-claude-text">
          Прив'яжіть картку й отримайте {status.amount_uah} грн на баланс
        </p>
        <p className="text-sm text-claude-subtext mt-1">
          {returned
            ? 'Оплату перевірки ще обробляємо. Оновіть сторінку за хвилину.'
            : `Monobank спише ${status.verify_amount_uah} ₴ для перевірки картки й одразу поверне їх. Один бонус на акаунт і на картку.`}
        </p>
      </div>
      <button
        onClick={handleVerify}
        disabled={isProcessing}
        className="px-4 py-2 rounded-lg bg-claude-accent text-white font-medium disabled:opacity-60 flex items-center gap-2">
        {isProcessing ? <Loader2 size={16} className="animate-spin" /> : null}
        Прив'язати картку
      </button>
    </div>
  );
}
