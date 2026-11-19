/**
 * Card link offer terms, shown before the user is sent to Monobank. The card
 * link payment is not refunded: it is credited to the balance and the welcome
 * bonus is added on top. Amounts come from GET /api/billing/payment/welcome-bonus.
 */

export interface WelcomeBonusStatus {
  /** Welcome bonus added on top of the payment. */
  amount_uah: number;
  /** Charged when linking the card; credited to the balance, not refunded. */
  payment_uah: number;
  /** payment_uah + amount_uah: what lands on the balance. */
  total_uah: number;
  status?: 'available' | 'credited' | 'pending_review' | 'rejected';
  available: boolean;
}

export function CardLinkNotice({ offer }: { offer: WelcomeBonusStatus }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-semibold">
        Monobank спише з картки {offer.payment_uah} ₴. Ця сума не повертається.
      </p>
      <ul className="mt-2 list-disc pl-5 space-y-1">
        <li>
          {offer.payment_uah} ₴ зараховуємо на ваш баланс як поповнення і додаємо{' '}
          {offer.amount_uah} ₴ вітального бонусу: разом <strong>{offer.total_uah} ₴</strong>.
        </li>
        <li>Підписки немає: кошти з балансу списуються лише за виконані запити.</li>
        <li>
          Бонус нараховуємо один раз одній людині. Якщо картка чи акаунт уже отримували бонус,
          на баланс зарахуються лише сплачені {offer.payment_uah} ₴.
        </li>
      </ul>
    </div>
  );
}
