/**
 * BetaRestrictedModal
 *
 * Shown when the current user may not use chat / document upload yet: not a
 * beta tester and no balance. The modal is opened by `useAccessGateStore`
 * (proactively on app load and reactively when chat/upload returns 403
 * BETA_RESTRICTED).
 *
 * While the account can still claim the welcome bonus, the main action is
 * linking a card (a refundable 1 UAH Monobank check) to get it; otherwise
 * the user is sent to top up.
 */

import React, { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal/Modal';
import { Button } from '../ui/Button';
import { useAccessGateStore } from '../../stores/accessGateStore';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';
import { getErrorMessage } from '../../utils/errors';

interface BonusStatus {
  amount_uah: number;
  verify_amount_uah: number;
  available: boolean;
}

export const BetaRestrictedModal: React.FC = () => {
  const { modalOpen, closeModal, isBetaTester, isAdministrator } = useAccessGateStore();
  const [bonus, setBonus] = useState<BonusStatus | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    if (!modalOpen) return;
    api.payment.getWelcomeBonus()
      .then(({ data }) => setBonus(data))
      .catch(() => setBonus(null));
  }, [modalOpen]);

  // Defensive: never show the modal to users who are explicitly allowed.
  if (isBetaTester || isAdministrator) return null;

  const goToBilling = () => {
    closeModal();
    window.location.href = '/billing';
  };

  const linkCard = async () => {
    setIsProcessing(true);
    try {
      const { data } = await api.payment.createCardVerify();
      window.location.href = data.pageUrl;
    } catch (err: unknown) {
      showToast.error(getErrorMessage(err));
      setIsProcessing(false);
    }
  };

  const offer = bonus?.available ? bonus : null;

  return (
    <Modal
      isOpen={modalOpen}
      onClose={closeModal}
      title={offer ? `Отримайте ${offer.amount_uah} грн на старт` : 'Поповніть баланс, щоб продовжити'}
      size="md"
      closeOnBackdrop={false}
      showCloseButton={true}
    >
      <div className="space-y-4 text-sm text-gray-700 leading-relaxed">
        {offer ? (
          <>
            <p>
              Щоб користуватися чатом і завантажувати документи, <strong>прив'яжіть картку</strong>.
              На баланс одразу зарахується <strong>{offer.amount_uah} грн</strong> вітального бонусу.
            </p>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-gray-700">
              <ul className="list-disc pl-5 space-y-1">
                <li>Monobank спише {offer.verify_amount_uah} ₴ для перевірки картки й одразу поверне їх.</li>
                <li>Підписки немає: далі ви платите лише за виконані запити.</li>
                <li>Один бонус на акаунт і на картку.</li>
              </ul>
            </div>
          </>
        ) : (
          <p>
            Чат і завантаження документів працюють за рахунок балансу. Поповніть його через
            Monobank, і доступ відкриється автоматично після зарахування платежу.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {offer ? (
            <>
              <Button variant="secondary" onClick={goToBilling}>
                Поповнити баланс
              </Button>
              <Button variant="primary" onClick={linkCard} disabled={isProcessing}>
                {isProcessing ? 'Відкриваємо Monobank…' : `Прив'язати картку й отримати ${offer.amount_uah} грн`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={closeModal}>
                Закрити
              </Button>
              <Button variant="primary" onClick={goToBilling}>
                Поповнити баланс
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default BetaRestrictedModal;
