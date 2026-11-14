/**
 * B2B Invoice Request Modal
 * Form for requesting a new B2B invoice (bank transfer).
 * If org is missing EDRPOU/address, collects them first.
 */

import { useState, useEffect } from 'react';
import { X, FileText, AlertCircle, Building2, Loader2 } from 'lucide-react';
import { b2bInvoiceApi, billingApi } from '../../utils/api/billing';
import { useCurrencyRate } from '../../hooks/useCurrencyRate';

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

interface TierOption {
  tier_key: string;
  display_name: string;
  monthly_price_usd: number;
}

interface OrgInfo {
  id: string;
  name: string;
  edrpou: string | null;
  legal_address: string | null;
  billing_email: string | null;
}

const billingCycles = [
  { value: 'monthly', label: 'Щомісячно', months: 1 },
  { value: 'quarterly', label: 'Щоквартально', months: 3 },
  { value: 'annual', label: 'Щорічно', months: 12 },
];

const VAT_RATE = 0.20;

export function B2BInvoiceRequestModal({ onClose, onCreated }: Props) {
  // the same NBU rate the backend uses for the invoice, not a fixed 41,5
  const { rate: uahRate } = useCurrencyRate();
  // Org info state
  const [orgLoading, setOrgLoading] = useState(true);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [needsOrgDetails, setNeedsOrgDetails] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgEdrpou, setOrgEdrpou] = useState('');
  const [orgAddress, setOrgAddress] = useState('');
  const [orgSaving, setOrgSaving] = useState(false);

  // Invoice form state
  const [invoiceType, setInvoiceType] = useState<'subscription' | 'topup'>('topup');
  const [tierKey, setTierKey] = useState('');
  const [billingCycle, setBillingCycle] = useState('monthly');
  const [amountUah, setAmountUah] = useState('');
  const [notes, setNotes] = useState('');
  const [tiers, setTiers] = useState<TierOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Fetch org info and tiers in parallel
    Promise.all([
      b2bInvoiceApi.getOrgInfo().catch(() => ({ data: { org: null } })),
      billingApi.getPricingInfo().catch(() => ({ data: { tiers: [] } })),
    ]).then(([orgRes, tierRes]) => {
      const orgData = orgRes.data.org as OrgInfo | null;
      setOrg(orgData);

      if (!orgData || !orgData.edrpou) {
        setNeedsOrgDetails(true);
        if (orgData) {
          setOrgName(orgData.name || '');
          setOrgEdrpou(orgData.edrpou || '');
          setOrgAddress(orgData.legal_address || '');
        }
      }

      const allTiers = tierRes.data.tiers || [];
      const paidTiers = allTiers.filter((t: TierOption) => t.tier_key !== 'free' && t.tier_key !== 'internal');
      setTiers(paidTiers);
      if (paidTiers.length > 0) setTierKey(paidTiers[0].tier_key);
    }).finally(() => setOrgLoading(false));
  }, []);

  const handleSaveOrg = async () => {
    if (!orgEdrpou.trim()) {
      setError('ЄДРПОУ є обов\'язковим полем');
      return;
    }
    if (orgEdrpou.trim().length < 8) {
      setError('ЄДРПОУ повинен містити 8-10 цифр');
      return;
    }

    setOrgSaving(true);
    setError('');
    try {
      await b2bInvoiceApi.updateOrgInfo({
        name: orgName.trim() || undefined,
        edrpou: orgEdrpou.trim(),
        legal_address: orgAddress.trim() || undefined,
      });
      setNeedsOrgDetails(false);
      // Refresh org info
      const res = await b2bInvoiceApi.getOrgInfo();
      setOrg(res.data.org);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Помилка збереження реквізитів');
    } finally {
      setOrgSaving(false);
    }
  };

  const selectedTier = tiers.find(t => t.tier_key === tierKey);
  const selectedCycle = billingCycles.find(c => c.value === billingCycle);

  let estimatedUah = 0;
  let estimatedVat = 0;
  let estimatedTotal = 0;

  if (invoiceType === 'subscription' && selectedTier && selectedCycle) {
    estimatedUah = selectedTier.monthly_price_usd * selectedCycle.months * uahRate;
    estimatedVat = estimatedUah * VAT_RATE;
    estimatedTotal = estimatedUah + estimatedVat;
  } else if (invoiceType === 'topup') {
    const amt = parseFloat(amountUah) || 0;
    estimatedUah = amt;
    estimatedVat = amt * VAT_RATE;
    estimatedTotal = amt + estimatedVat;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const payload: { invoice_type: string; tier_key?: string; billing_cycle?: string; amount_uah?: number; notes?: string } = {
        invoice_type: invoiceType,
        notes: notes || undefined,
      };

      if (invoiceType === 'subscription') {
        payload.tier_key = tierKey;
        payload.billing_cycle = billingCycle;
      } else {
        const amt = parseFloat(amountUah);
        if (!amt || amt < 500) {
          setError('Мінімальна сума поповнення — 500 грн');
          setLoading(false);
          return;
        }
        payload.amount_uah = amt;
      }

      await b2bInvoiceApi.create(payload);
      onCreated();
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'Помилка створення рахунку';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-claude-border">
          <div className="flex items-center gap-3">
            <FileText size={20} className="text-claude-accent" />
            <h2 className="text-lg font-semibold text-claude-text">Запросити рахунок</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-claude-bg rounded-lg">
            <X size={20} className="text-claude-subtext" />
          </button>
        </div>

        {orgLoading ? (
          <div className="p-8 flex items-center justify-center gap-2 text-claude-subtext">
            <Loader2 size={18} className="animate-spin" />
            Завантаження...
          </div>
        ) : needsOrgDetails ? (
          /* Step 1: Collect org billing details */
          <div className="p-6 space-y-5">
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <Building2 size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-800">
                  Заповніть реквізити організації
                </p>
                <p className="text-xs text-amber-600 mt-0.5">
                  Для виставлення рахунку потрібні ЄДРПОУ та юридична адреса
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-claude-text mb-1.5">
                Назва організації
              </label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="ТОВ «Назва»"
                className="w-full px-4 py-2.5 border border-claude-border rounded-lg text-sm focus:outline-none focus:border-claude-accent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-claude-text mb-1.5">
                ЄДРПОУ <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={orgEdrpou}
                onChange={(e) => setOrgEdrpou(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="12345678"
                maxLength={10}
                className="w-full px-4 py-2.5 border border-claude-border rounded-lg text-sm focus:outline-none focus:border-claude-accent font-mono"
                required
              />
              <p className="text-xs text-claude-subtext mt-1">8-10 цифр</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-claude-text mb-1.5">
                Юридична адреса
              </label>
              <input
                type="text"
                value={orgAddress}
                onChange={(e) => setOrgAddress(e.target.value)}
                placeholder="м. Київ, вул. Хрещатик, 1"
                className="w-full px-4 py-2.5 border border-claude-border rounded-lg text-sm focus:outline-none focus:border-claude-accent"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <button
              type="button"
              onClick={handleSaveOrg}
              disabled={orgSaving || !orgEdrpou.trim()}
              className="w-full py-3 bg-claude-accent text-white rounded-lg font-medium text-sm hover:bg-claude-accent/90 transition-colors disabled:opacity-50">
              {orgSaving ? 'Збереження...' : 'Зберегти та продовжити'}
            </button>
          </div>
        ) : (
          /* Step 2: Invoice form */
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {/* Org info summary */}
            {org && (
              <div className="flex items-center gap-2 p-3 bg-claude-bg/50 border border-claude-border rounded-lg text-xs text-claude-subtext">
                <Building2 size={14} className="flex-shrink-0" />
                <span>{org.name}</span>
                {org.edrpou && <span className="font-mono">· ЄДРПОУ {org.edrpou}</span>}
              </div>
            )}

            {/* Invoice type toggle */}
            <div>
              <label className="block text-sm font-medium text-claude-text mb-2">Тип рахунку</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setInvoiceType('topup')}
                  className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                    invoiceType === 'topup'
                      ? 'bg-claude-accent text-white border-claude-accent'
                      : 'bg-white text-claude-subtext border-claude-border hover:border-claude-accent'
                  }`}>
                  Поповнення балансу
                </button>
                <button
                  type="button"
                  onClick={() => setInvoiceType('subscription')}
                  className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                    invoiceType === 'subscription'
                      ? 'bg-claude-accent text-white border-claude-accent'
                      : 'bg-white text-claude-subtext border-claude-border hover:border-claude-accent'
                  }`}>
                  Підписка
                </button>
              </div>
            </div>

            {/* Topup amount */}
            {invoiceType === 'topup' && (
              <div>
                <label className="block text-sm font-medium text-claude-text mb-2">
                  Сума поповнення, грн
                </label>
                <input
                  type="number"
                  min="500"
                  step="100"
                  value={amountUah}
                  onChange={(e) => setAmountUah(e.target.value)}
                  placeholder="Мінімум 500 грн"
                  className="w-full px-4 py-2.5 border border-claude-border rounded-lg text-sm focus:outline-none focus:border-claude-accent"
                  required
                />
                <p className="text-xs text-claude-subtext mt-1">Мінімальна сума — 500 грн</p>
              </div>
            )}

            {/* Subscription: tier + cycle */}
            {invoiceType === 'subscription' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-claude-text mb-2">Тариф</label>
                  <select
                    value={tierKey}
                    onChange={(e) => setTierKey(e.target.value)}
                    className="w-full px-4 py-2.5 border border-claude-border rounded-lg text-sm focus:outline-none focus:border-claude-accent"
                    required>
                    <option value="">Оберіть тариф</option>
                    {tiers.map((t) => (
                      <option key={t.tier_key} value={t.tier_key}>
                        {t.display_name} — ${t.monthly_price_usd}/міс
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-claude-text mb-2">Період оплати</label>
                  <div className="flex gap-2">
                    {billingCycles.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => setBillingCycle(c.value)}
                        className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                          billingCycle === c.value
                            ? 'bg-claude-accent text-white border-claude-accent'
                            : 'bg-white text-claude-subtext border-claude-border hover:border-claude-accent'
                        }`}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium text-claude-text mb-2">
                Примітки <span className="text-claude-subtext font-normal">(необов&apos;язково)</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full px-4 py-2.5 border border-claude-border rounded-lg text-sm focus:outline-none focus:border-claude-accent resize-none"
                placeholder="Додаткова інформація..."
              />
            </div>

            {/* Calculation preview */}
            {estimatedTotal > 0 && (
              <div className="bg-claude-bg/50 border border-claude-border rounded-xl p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-claude-subtext">Сума</span>
                  <span>{estimatedUah.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} грн</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-claude-subtext">ПДВ 20%</span>
                  <span>{estimatedVat.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} грн</span>
                </div>
                <div className="border-t border-claude-border pt-2 flex justify-between text-sm font-semibold">
                  <span>Всього до оплати</span>
                  <span>{estimatedTotal.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} грн</span>
                </div>
                <p className="text-xs text-claude-subtext">
                  * Точна сума буде розрахована при формуванні рахунку
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-claude-accent text-white rounded-lg font-medium text-sm hover:bg-claude-accent/90 transition-colors disabled:opacity-50">
              {loading ? 'Створення...' : 'Створити рахунок'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
