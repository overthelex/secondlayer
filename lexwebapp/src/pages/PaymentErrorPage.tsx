/**
 * Payment Error/Decline Page
 * Monobank redirects here after a failed or declined payment
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { XCircle, ArrowRight, RefreshCw } from 'lucide-react';
import { ROUTES } from '../router/routes';

export function PaymentErrorPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [orderInfo, setOrderInfo] = useState<{
    orderId?: string;
    amount?: string;
    currency?: string;
    reason?: string;
  }>({});

  useEffect(() => {
    const orderId = searchParams.get('order_id') || '';
    const amount = searchParams.get('amount') || '';
    const currency = searchParams.get('currency') || 'UAH';
    const reason = searchParams.get('response_description') || searchParams.get('error_message') || '';

    if (orderId || reason) {
      setOrderInfo({
        orderId: orderId || undefined,
        amount: amount ? (parseInt(amount, 10) / 100).toFixed(2) : undefined,
        currency,
        reason: reason || undefined,
      });
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-red-50 to-white flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg border border-red-100 p-8 text-center">
        <div className="flex justify-center mb-6">
          <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center">
            <XCircle size={48} className="text-red-600" />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          Payment Failed
        </h1>

        <p className="text-gray-600 mb-6">
          Unfortunately, your payment could not be processed. No charges were made to your account.
        </p>

        {(orderInfo.orderId || orderInfo.reason) && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-left">
            <div className="space-y-2 text-sm">
              {orderInfo.orderId && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Order ID:</span>
                  <span className="font-medium text-gray-800">{orderInfo.orderId}</span>
                </div>
              )}
              {orderInfo.amount && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Amount:</span>
                  <span className="font-medium text-gray-800">
                    {orderInfo.currency === 'UAH' ? '₴' : '$'}{orderInfo.amount}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">Status:</span>
                <span className="font-medium text-red-700">Declined</span>
              </div>
              {orderInfo.reason && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Reason:</span>
                  <span className="font-medium text-red-700">{orderInfo.reason}</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <button
            onClick={() => navigate(ROUTES.BILLING)}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium"
          >
            <RefreshCw size={18} />
            Try Again
          </button>

          <button
            onClick={() => navigate(ROUTES.CHAT)}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
          >
            Go to Dashboard
            <ArrowRight size={18} />
          </button>
        </div>

        <p className="text-xs text-gray-400 mt-4">
          If this problem persists, please contact our support team.
        </p>
      </div>
    </div>
  );
}
