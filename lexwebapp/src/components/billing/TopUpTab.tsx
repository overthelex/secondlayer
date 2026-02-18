/**
 * Top-up Tab
 * Allows users to add funds via Stripe, MetaMask, or Binance Pay
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  CreditCard,
  CheckCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
  Wallet,
  QrCode,
  Copy,
} from 'lucide-react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

const STRIPE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '';
const MOCK_PAYMENTS = import.meta.env.VITE_MOCK_PAYMENTS === 'true';

const stripePromise = STRIPE_KEY ? loadStripe(STRIPE_KEY) : null;

type PaymentProvider = 'stripe' | 'metamask' | 'binance_pay';

interface ProviderInfo {
  id: string;
  name: string;
  enabled: boolean;
  currency: string;
}

const cardElementOptions = {
  style: {
    base: {
      fontSize: '16px',
      color: '#2D2D2D',
      '::placeholder': { color: '#6B6B6B' },
    },
    invalid: { color: '#ff4d4f' },
  },
};

function StripePaymentForm({ amount, onSuccess }: { amount: number; onSuccess: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setIsProcessing(true);
    setError(null);

    try {
      const { data } = await api.payment.createStripe({
        amount_usd: amount,
        metadata: { source: 'billing_dashboard' },
      });

      if (MOCK_PAYMENTS) {
        showToast.success(`Тестова оплата $${amount} успішна!`);
        setTimeout(onSuccess, 1000);
        return;
      }

      const { clientSecret } = data;
      const { error: stripeError, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card: elements.getElement(CardElement)! },
      });

      if (stripeError) {
        setError(stripeError.message || 'Помилка оплати');
        showToast.error(stripeError.message || 'Помилка оплати');
      } else if (paymentIntent?.status === 'succeeded') {
        showToast.success('Оплату здійснено! Ваш баланс буде оновлено найближчим часом.');
        onSuccess();
      }
    } catch (err: any) {
      const message = err.response?.data?.message || 'Помилка оплати. Спробуйте ще раз.';
      setError(message);
      showToast.error(message);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-claude-text mb-2">Дані картки</label>
        <div className="p-4 border border-claude-border rounded-lg bg-white">
          <CardElement options={cardElementOptions} />
        </div>
        {error && (
          <p className="mt-2 text-sm text-red-600 flex items-center gap-1">
            <AlertCircle size={14} />
            {error}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={!stripe || isProcessing}
        className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium">
        {isProcessing ? (
          <><Loader2 size={18} className="animate-spin" /> Обробка...</>
        ) : (
          <><CreditCard size={18} /> Сплатити ${amount.toFixed(2)}</>
        )}
      </button>
      {MOCK_PAYMENTS && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-xs text-yellow-800"><strong>Mock Mode:</strong> Payments are simulated.</p>
        </div>
      )}
    </form>
  );
}

const CHAIN_IDS: Record<string, string> = {
  ethereum: '0x1',
  polygon: '0x89',
};

const CHAIN_NAMES: Record<string, string> = {
  '0x1': 'Ethereum Mainnet',
  '0x89': 'Polygon Mainnet',
};

function truncateAddress(addr: string): string {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function MetaMaskPaymentForm({ amount, onSuccess }: { amount: number; onSuccess: () => void }) {
  const [network, setNetwork] = useState<'ethereum' | 'polygon'>('ethereum');
  const [token, setToken] = useState<'eth' | 'usdt' | 'usdc'>('usdt');
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentData, setPaymentData] = useState<any>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wallet connection state
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [chainId, setChainId] = useState<string | null>(null);

  const ethereum = (window as any).ethereum;
  const hasMetaMask = !!ethereum;

  // Listen for account and chain changes
  useEffect(() => {
    if (!ethereum) return;

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        setConnectedAddress(null);
        setChainId(null);
      } else {
        setConnectedAddress(accounts[0]);
      }
    };

    const handleChainChanged = (newChainId: string) => {
      setChainId(newChainId);
    };

    ethereum.on('accountsChanged', handleAccountsChanged);
    ethereum.on('chainChanged', handleChainChanged);

    // Check if already connected
    ethereum.request({ method: 'eth_accounts' }).then((accounts: string[]) => {
      if (accounts.length > 0) {
        setConnectedAddress(accounts[0]);
        ethereum.request({ method: 'eth_chainId' }).then((id: string) => setChainId(id));
      }
    });

    return () => {
      ethereum.removeListener('accountsChanged', handleAccountsChanged);
      ethereum.removeListener('chainChanged', handleChainChanged);
    };
  }, [ethereum]);

  const handleConnectWallet = async () => {
    if (!ethereum) return;
    setIsConnecting(true);
    setError(null);
    try {
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
      setConnectedAddress(accounts[0]);
      const currentChainId = await ethereum.request({ method: 'eth_chainId' });
      setChainId(currentChainId);
    } catch (err: any) {
      if (err.code === 4001) {
        setError('Підключення відхилено користувачем');
      } else {
        setError(err.message || 'Не вдалося підключити гаманець');
      }
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setConnectedAddress(null);
    setChainId(null);
    setPaymentData(null);
    setError(null);
  };

  const handleSwitchNetwork = async () => {
    if (!ethereum) return;
    const targetChainId = CHAIN_IDS[network];
    try {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetChainId }],
      });
    } catch (err: any) {
      if (err.code === 4001) {
        setError('Перемикання мережі відхилено');
      } else {
        setError(err.message || 'Не вдалося перемкнути мережу');
      }
    }
  };

  const expectedChainId = CHAIN_IDS[network];
  const isCorrectChain = chainId === expectedChainId;

  const handleCreatePayment = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      const { data } = await api.payment.createMetaMask({ amount_usd: amount, network, token });
      if (MOCK_PAYMENTS) {
        showToast.success(`Тестова крипто-оплата $${amount} створена!`);
        setPaymentData(data);
        setTimeout(async () => {
          try {
            await api.payment.verifyMetaMask({ paymentIntentId: data.paymentIntentId, txHash: '0x' + 'a'.repeat(64) });
            showToast.success('Оплату підтверджено!');
            onSuccess();
          } catch { /* mock */ }
        }, 2000);
        return;
      }
      setPaymentData(data);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Не вдалося створити платіж.');
      showToast.error(err.response?.data?.message || 'Не вдалося створити платіж.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSendViaMetaMask = async () => {
    if (!paymentData || !connectedAddress) return;
    setVerifying(true);
    setError(null);
    try {
      const from = connectedAddress;
      let txHash: string;

      if (token === 'eth') {
        const amountWei = '0x' + BigInt(Math.round(parseFloat(paymentData.cryptoAmount) * 1e18)).toString(16);
        txHash = await ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: paymentData.walletAddress, value: amountWei }],
        });
      } else {
        const contracts: Record<string, Record<string, string>> = {
          ethereum: { usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
          polygon: { usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
        };
        const contractAddress = contracts[network]?.[token];
        if (!contractAddress) throw new Error('Unknown token contract');
        const amountUnits = BigInt(Math.round(parseFloat(paymentData.cryptoAmount) * 1e6));
        const paddedTo = paymentData.walletAddress.slice(2).padStart(64, '0');
        const paddedAmount = amountUnits.toString(16).padStart(64, '0');
        const transferData = '0xa9059cbb' + paddedTo + paddedAmount;
        txHash = await ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: contractAddress, data: transferData }],
        });
      }

      showToast.info('Транзакцію відправлено. Верифікація...');
      const { data: verifyResult } = await api.payment.verifyMetaMask({ paymentIntentId: paymentData.paymentIntentId, txHash });

      if (verifyResult.status === 'succeeded') {
        showToast.success('Оплату підтверджено! Баланс оновлено.');
        onSuccess();
      } else if (verifyResult.status === 'pending') {
        showToast.info('Транзакція ще обробляється.');
      } else {
        setError(verifyResult.message || 'Верифікація не пройшла');
      }
    } catch (err: any) {
      if (err.code === 4001) {
        setError('Транзакцію відхилено користувачем');
      } else {
        setError(err.response?.data?.message || err.message || 'Помилка транзакції');
      }
    } finally {
      setVerifying(false);
    }
  };

  // State 1: MetaMask not available
  if (!hasMetaMask) {
    return (
      <div className="space-y-4">
        <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg text-center space-y-3">
          <Wallet size={32} className="text-orange-400 mx-auto" />
          <p className="text-sm font-medium text-orange-800">MetaMask не знайдено</p>
          <p className="text-sm text-orange-700">Встановіть розширення MetaMask для вашого браузера, щоб здійснювати крипто-платежі.</p>
          <a
            href="https://chromewebstore.google.com/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors font-medium text-sm"
          >
            <ExternalLink size={16} /> Встановіть MetaMask
          </a>
        </div>
      </div>
    );
  }

  // State 2: Not connected
  if (!connectedAddress) {
    return (
      <div className="space-y-4">
        <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg text-center space-y-3">
          <Wallet size={32} className="text-orange-400 mx-auto" />
          <p className="text-sm font-medium text-orange-800">MetaMask не підключено</p>
          <p className="text-sm text-orange-700">Підключіть гаманець, щоб здійснити оплату криптовалютою.</p>
        </div>
        {error && <p className="text-sm text-red-600 flex items-center gap-1"><AlertCircle size={14} />{error}</p>}
        <button
          onClick={handleConnectWallet}
          disabled={isConnecting}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 font-medium"
        >
          {isConnecting ? (
            <><Loader2 size={18} className="animate-spin" /> Підключення...</>
          ) : (
            <><Wallet size={18} /> Підключити гаманець</>
          )}
        </button>
      </div>
    );
  }

  // State 3+: Connected
  return (
    <div className="space-y-4">
      {/* Connected address badge */}
      <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-500 rounded-full" />
          <span className="text-sm font-medium text-green-800">{truncateAddress(connectedAddress)}</span>
          <button
            onClick={() => { navigator.clipboard.writeText(connectedAddress); showToast.success('Адресу скопійовано'); }}
            className="p-1 hover:bg-green-100 rounded"
          >
            <Copy size={14} className="text-green-600" />
          </button>
        </div>
        <button
          onClick={handleDisconnect}
          className="text-xs text-green-700 hover:text-red-600 transition-colors"
        >
          Відключити
        </button>
      </div>

      {!paymentData ? (
        <>
          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">Мережа</label>
            <div className="grid grid-cols-2 gap-3">
              {(['ethereum', 'polygon'] as const).map((n) => (
                <button key={n} onClick={() => setNetwork(n)}
                  className={`p-3 border-2 rounded-lg text-sm font-medium transition-all ${network === n ? 'border-claude-accent bg-claude-accent/5 text-claude-accent' : 'border-claude-border text-claude-text hover:border-claude-accent/50'}`}>
                  {n === 'ethereum' ? 'Ethereum' : 'Polygon'}
                </button>
              ))}
            </div>
          </div>

          {/* Network mismatch warning */}
          {!isCorrectChain && (
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle size={16} className="text-yellow-600" />
                <span className="text-sm text-yellow-800">
                  Поточна мережа: {CHAIN_NAMES[chainId!] || `Невідома (${chainId})`}
                </span>
              </div>
              <button
                onClick={handleSwitchNetwork}
                className="text-sm font-medium text-yellow-700 hover:text-yellow-900 underline"
              >
                Перемкнути на {network === 'ethereum' ? 'Ethereum' : 'Polygon'}
              </button>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">Токен</label>
            <div className="grid grid-cols-3 gap-3">
              {(['eth', 'usdt', 'usdc'] as const).map((t) => (
                <button key={t} onClick={() => setToken(t)}
                  className={`p-3 border-2 rounded-lg text-sm font-medium transition-all ${token === t ? 'border-claude-accent bg-claude-accent/5 text-claude-accent' : 'border-claude-border text-claude-text hover:border-claude-accent/50'}`}>
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-red-600 flex items-center gap-1"><AlertCircle size={14} />{error}</p>}
          <button onClick={handleCreatePayment} disabled={isProcessing}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-colors disabled:opacity-50 font-medium">
            {isProcessing ? <><Loader2 size={18} className="animate-spin" /> Створення...</> : <><Wallet size={18} /> Створити платіж ${amount.toFixed(2)}</>}
          </button>
        </>
      ) : (
        <>
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg space-y-3">
            <p className="text-sm font-medium text-blue-800">Відправте {paymentData.cryptoAmount} {paymentData.token.toUpperCase()} на адресу:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-white p-2 rounded border border-blue-200 break-all">{paymentData.walletAddress}</code>
              <button onClick={() => { navigator.clipboard.writeText(paymentData.walletAddress); showToast.success('Скопійовано'); }} className="p-2 hover:bg-blue-100 rounded"><Copy size={16} className="text-blue-600" /></button>
            </div>
            <p className="text-xs text-blue-700">Мережа: {paymentData.network === 'ethereum' ? 'Ethereum' : 'Polygon'}{paymentData.token === 'eth' ? ` | Курс: $${paymentData.exchangeRate?.toFixed(2)}` : ''}</p>
          </div>
          {error && <p className="text-sm text-red-600 flex items-center gap-1"><AlertCircle size={14} />{error}</p>}
          <button onClick={handleSendViaMetaMask} disabled={verifying}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 font-medium">
            {verifying ? <><Loader2 size={18} className="animate-spin" /> Верифікація...</> : <><Wallet size={18} /> Відправити через MetaMask</>}
          </button>
        </>
      )}
      {MOCK_PAYMENTS && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-xs text-yellow-800"><strong>Тестовий режим:</strong> Крипто-оплати симулюються.</p>
        </div>
      )}
    </div>
  );
}

function BinancePayForm({ amount, onSuccess }: { amount: number; onSuccess: () => void }) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [orderData, setOrderData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  const handleCreateOrder = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      const { data } = await api.payment.createBinancePay({ amount_usd: amount });
      if (MOCK_PAYMENTS) {
        showToast.success(`Тестове замовлення Binance Pay $${amount} створено!`);
        setTimeout(onSuccess, 3000);
        return;
      }
      setOrderData(data);
      pollRef.current = setInterval(async () => {
        try {
          const { data: statusData } = await api.payment.getStatus('binance_pay', data.paymentIntentId);
          if (statusData.status === 'succeeded') {
            if (pollRef.current) clearInterval(pollRef.current);
            showToast.success('Binance Pay оплату підтверджено!');
            onSuccess();
          }
        } catch { /* ignore */ }
      }, 5000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Не вдалося створити замовлення.');
      showToast.error(err.response?.data?.message || 'Не вдалося створити замовлення.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-4">
      {!orderData ? (
        <>
          <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-sm text-yellow-800">Оплата в USDT через Binance Pay. Ви отримаєте QR-код для додатку Binance.</p>
          </div>
          {error && <p className="text-sm text-red-600 flex items-center gap-1"><AlertCircle size={14} />{error}</p>}
          <button onClick={handleCreateOrder} disabled={isProcessing}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-colors disabled:opacity-50 font-medium">
            {isProcessing ? <><Loader2 size={18} className="animate-spin" /> Створення...</> : <><QrCode size={18} /> Оплатити ${amount.toFixed(2)} через Binance Pay</>}
          </button>
        </>
      ) : (
        <div className="text-center space-y-4">
          {orderData.qrcodeLink && (
            <div className="flex justify-center">
              <img src={orderData.qrcodeLink} alt="Binance Pay QR Code" className="w-48 h-48 border border-claude-border rounded-lg" />
            </div>
          )}
          <p className="text-sm text-claude-subtext">Скануйте QR-код у додатку Binance</p>
          {orderData.universalUrl && (
            <a href={orderData.universalUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 transition-colors font-medium">
              <ExternalLink size={16} /> Відкрити Binance
            </a>
          )}
          <div className="flex items-center justify-center gap-2 text-sm text-claude-subtext">
            <Loader2 size={14} className="animate-spin" /> Очікування підтвердження...
          </div>
        </div>
      )}
      {MOCK_PAYMENTS && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-xs text-yellow-800"><strong>Тестовий режим:</strong> Binance Pay симулюється.</p>
        </div>
      )}
    </div>
  );
}

interface TopUpTabProps {
  initialAmount?: number;
}

export function TopUpTab({ initialAmount }: TopUpTabProps) {
  const [provider, setProvider] = useState<PaymentProvider>('stripe');
  const [amount, setAmount] = useState<number>(initialAmount || 25);
  const [customAmount, setCustomAmount] = useState<string>(initialAmount ? String(initialAmount) : '');
  const [showSuccess, setShowSuccess] = useState(false);
  const [availableProviders, setAvailableProviders] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    api.payment.getAvailableProviders()
      .then(({ data }) => setAvailableProviders(data.providers || []))
      .catch(() => setAvailableProviders([
        { id: 'stripe', name: 'Stripe', enabled: true, currency: 'USD' },
      ]));
  }, []);

  useEffect(() => {
    if (initialAmount && initialAmount > 0) {
      setAmount(initialAmount);
      setCustomAmount(String(initialAmount));
    }
  }, [initialAmount]);

  const cryptoEnabled = availableProviders.some((p) => p.id === 'metamask' && p.enabled);
  const presetAmounts = [10, 25, 50, 100];
  const currencySymbol = '$';

  const handleSuccess = () => {
    setShowSuccess(true);
    setAmount(25);
    setCustomAmount('');
    setTimeout(() => setShowSuccess(false), 5000);
  };

  const handleProviderChange = (p: PaymentProvider) => {
    setProvider(p);
    setCustomAmount('');
    setAmount(25);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {showSuccess && (
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }}
          className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-center gap-3">
          <CheckCircle size={24} className="text-green-600" />
          <div>
            <p className="font-medium text-green-800">Оплату здійснено!</p>
            <p className="text-sm text-green-700">Ваш баланс буде оновлено найближчим часом.</p>
          </div>
        </motion.div>
      )}

      {/* Provider Selection */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4">Оберіть спосіб оплати</h3>
        <div className={`grid grid-cols-1 gap-4 ${cryptoEnabled ? 'md:grid-cols-3' : 'md:grid-cols-1'}`}>
          <button onClick={() => handleProviderChange('stripe')}
            className={`p-4 border-2 rounded-xl transition-all ${provider === 'stripe' ? 'border-claude-accent bg-claude-accent/5' : 'border-claude-border hover:border-claude-accent/50'}`}>
            <div className="flex items-center gap-3 mb-2">
              <CreditCard size={24} className={provider === 'stripe' ? 'text-claude-accent' : 'text-claude-subtext'} />
              <h4 className="font-semibold text-claude-text">Stripe</h4>
            </div>
            <p className="text-sm text-claude-subtext text-left">Кредитні/дебетові картки (міжнародні)</p>
            <p className="text-xs text-claude-subtext mt-1 text-left">Рекомендовано для оплати в USD</p>
          </button>

          {cryptoEnabled && (
            <>
              <button onClick={() => handleProviderChange('metamask')}
                className={`p-4 border-2 rounded-xl transition-all ${provider === 'metamask' ? 'border-orange-500 bg-orange-50' : 'border-claude-border hover:border-orange-300'}`}>
                <div className="flex items-center gap-3 mb-2">
                  <Wallet size={24} className={provider === 'metamask' ? 'text-orange-500' : 'text-claude-subtext'} />
                  <h4 className="font-semibold text-claude-text">MetaMask</h4>
                </div>
                <p className="text-sm text-claude-subtext text-left">ETH / USDT / USDC</p>
                <p className="text-xs text-claude-subtext mt-1 text-left">Ethereum, Polygon</p>
              </button>

              <button onClick={() => handleProviderChange('binance_pay')}
                className={`p-4 border-2 rounded-xl transition-all ${provider === 'binance_pay' ? 'border-yellow-500 bg-yellow-50' : 'border-claude-border hover:border-yellow-300'}`}>
                <div className="flex items-center gap-3 mb-2">
                  <QrCode size={24} className={provider === 'binance_pay' ? 'text-yellow-600' : 'text-claude-subtext'} />
                  <h4 className="font-semibold text-claude-text">Binance Pay</h4>
                </div>
                <p className="text-sm text-claude-subtext text-left">USDT через Binance</p>
                <p className="text-xs text-claude-subtext mt-1 text-left">QR-код або додаток</p>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Amount Selection */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4">Оберіть суму</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {presetAmounts.map((preset) => (
            <button key={preset} onClick={() => { setAmount(preset); setCustomAmount(''); }}
              className={`p-4 border-2 rounded-xl font-semibold transition-all ${amount === preset && !customAmount ? 'border-claude-accent bg-claude-accent text-white' : 'border-claude-border text-claude-text hover:border-claude-accent'}`}>
              {currencySymbol}{preset}
            </button>
          ))}
        </div>
        <div>
          <label className="block text-sm font-medium text-claude-text mb-2">Інша сума</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-claude-subtext font-medium">{currencySymbol}</span>
            <input type="number" min="1" step="0.01"
              value={customAmount} onChange={(e) => { setCustomAmount(e.target.value); const p = parseFloat(e.target.value); if (!isNaN(p) && p > 0) setAmount(p); }}
              placeholder="25.00"
              className="w-full pl-8 pr-4 py-3 border border-claude-border rounded-lg focus:outline-none focus:ring-2 focus:ring-claude-accent/20" />
          </div>
          <p className="text-xs text-claude-subtext mt-2">Мінімум: $1.00</p>
        </div>
        <div className="mt-4 p-4 bg-claude-bg rounded-lg">
          <div className="flex items-center justify-between">
            <span className="text-sm text-claude-subtext">До оплати:</span>
            <span className="text-2xl font-bold text-claude-text">{currencySymbol}{amount.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Payment Form */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4">Деталі оплати</h3>
        {provider === 'stripe' ? (
          stripePromise ? (
            <Elements stripe={stripePromise}><StripePaymentForm amount={amount} onSuccess={handleSuccess} /></Elements>
          ) : (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">Stripe не налаштовано. Додайте VITE_STRIPE_PUBLISHABLE_KEY.</p>
            </div>
          )
        ) : provider === 'metamask' ? (
          <MetaMaskPaymentForm amount={amount} onSuccess={handleSuccess} />
        ) : provider === 'binance_pay' ? (
          <BinancePayForm amount={amount} onSuccess={handleSuccess} />
        ) : null}
      </div>

      {/* Security Notice */}
      <div className="p-4 bg-claude-bg border border-claude-border rounded-lg">
        <p className="text-xs text-claude-subtext text-center">
          {provider === 'metamask' ? 'Крипто-платежі верифікуються on-chain. Баланс оновлюється після підтвердження.'
            : provider === 'binance_pay' ? 'Binance Pay оплата обробляється автоматично після підтвердження.'
            : 'Усі платежі обробляються безпечно через Stripe. Дані картки не зберігаються.'}
        </p>
      </div>
    </div>
  );
}
