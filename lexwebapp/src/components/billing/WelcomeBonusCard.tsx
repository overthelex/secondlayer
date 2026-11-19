/**
 * Welcome bonus offer: link a card with a Monobank payment that is credited to
 * the balance (not refunded) plus the welcome bonus on top. The first click
 * shows the terms (CardLinkNotice); only the second sends the user to
 * Monobank. Renders nothing once the account has claimed it (or the status
 * cannot be loaded).
 */

import { useEffect, useState } from 'react';
import { Gift, Loader2 } from 'lucide-react';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';
import { getErrorMessage } from '../../utils/errors';
import { CardLinkNotice, type WelcomeBonusStatus } from './CardLinkNotice';

export function WelcomeBonusCard() {
  const [status, setStatus] = useState<WelcomeBonusStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const returned = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('card_verify') === '1';

  useEffect(() => {
    api.payment.getWelcomeBonus()
      .then(({ data }) => setStatus(data))
      .catch(() => setStatus(null));
  }, []);

  if (!status) return null;

  if (status.status === 'pending_review') {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
        Картку прив'язано, сплачені {status.payment_uah} ₴ зараховано на баланс. Вітальний бонус{' '}
        {status.amount_uah} ₴ на перевірці: ми нараховуємо його один раз одній людині й підтвердимо
        найближчим часом.
      </div>
    );
  }

  if (!status.available) {
    if (!returned) return null;
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-800">
        Картку прив'язано. Сплачені {status.payment_uah} ₴ зараховано на баланс, а вітальний бонус{' '}
        {status.amount_uah} ₴ додано зверху, якщо ця картка ще не приносила бонус.
      </div>
    );
  }

  const handlePay = async () => {
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
    <div className="bg-white border border-claude-border rounded-xl p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <Gift size={28} className="text-claude-accent shrink-0" />
        <div className="flex-1">
          <p className="font-semibold text-claude-text">
            Прив'яжіть картку: сплатіть {status.payment_uah} ₴ і отримайте {status.total_uah} ₴ на баланс
          </p>
          <p className="text-sm text-claude-subtext mt-1">
            {returned
              ? 'Оплату ще обробляємо. Оновіть сторінку за хвилину.'
              : `${status.payment_uah} ₴ зараховуємо на баланс і додаємо ${status.amount_uah} ₴ бонусу. Один бонус на людину.`}
          </p>
        </div>
        {!confirming && (
          <button
            onClick={() => setConfirming(true)}
            className="px-4 py-2 rounded-lg bg-claude-accent text-white font-medium">
            Прив'язати картку
          </button>
        )}
      </div>

      {confirming && (
        <>
          <CardLinkNotice offer={status} />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirming(false)}
              disabled={isProcessing}
              className="px-4 py-2 rounded-lg border border-claude-border text-claude-text font-medium disabled:opacity-60">
              Скасувати
            </button>
            <button
              onClick={handlePay}
              disabled={isProcessing}
              className="px-4 py-2 rounded-lg bg-claude-accent text-white font-medium disabled:opacity-60 flex items-center gap-2">
              {isProcessing ? <Loader2 size={16} className="animate-spin" /> : null}
              Сплатити {status.payment_uah} ₴
            </button>
          </div>
        </>
      )}
    </div>
  );
}
