/**
 * Payment Success Page
 * Fondy redirects here (POST) after a successful payment
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle, ArrowRight } from 'lucide-react';
import { ROUTES } from '../router/routes';

export function PaymentSuccessPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [orderInfo, setOrderInfo] = useState<{
    orderId?: string;
    amount?: string;
    currency?: string;
  }>({});

  useEffect(() => {
    // Fondy may send data via POST (form) or GET (query params)
    const orderId = searchParams.get('order_id') || '';
    const amount = searchParams.get('amount') || '';
    const currency = searchParams.get('currency') || 'UAH';

    if (orderId) {
      setOrderInfo({
        orderId,
        amount: amount ? (parseInt(amount, 10) / 100).toFixed(2) : undefined,
        currency,
      });
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-green-50 to-white flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg border border-green-100 p-8 text-center">
        <div className="flex justify-center mb-6">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
            <CheckCircle size={48} className="text-green-600" />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          Payment Successful
        </h1>

        <p className="text-gray-600 mb-6">
          Your payment has been processed successfully. Your account balance will be updated shortly.
        </p>

        {orderInfo.orderId && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6 text-left">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Order ID:</span>
                <span className="font-medium text-gray-800">{orderInfo.orderId}</span>
              </div>
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
                <span className="font-medium text-green-700">Approved</span>
              </div>
            </div>
          </div>
        )}

        <button
          onClick={() => navigate(ROUTES.BILLING)}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
        >
          Go to Billing
          <ArrowRight size={18} />
        </button>

        <p className="text-xs text-gray-400 mt-4">
          You will receive an email confirmation shortly.
        </p>
      </div>
    </div>
  );
}
