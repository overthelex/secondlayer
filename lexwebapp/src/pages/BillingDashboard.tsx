/**
 * Billing Dashboard
 * Layout with tab navigation — each tab is a nested route rendered via Outlet
 */

import { useState } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  DollarSign,
  Receipt,
  Settings,
  ArrowLeft,
  Zap,
  TrendingUp,
  FileText,
} from 'lucide-react';
import { TopUpModal } from '../components/billing/TopUpModal';
import { WelcomeBonusCard } from '../components/billing/WelcomeBonusCard';

type BillingTab = 'overview' | 'tariffs' | 'history' | 'analytics' | 'b2b-invoices' | 'settings';

const tabs = [
  { id: 'overview' as const, label: 'Огляд', icon: DollarSign },
  { id: 'tariffs' as const, label: 'Тарифи', icon: Zap },
  { id: 'history' as const, label: 'Історія', icon: Receipt },
  { id: 'analytics' as const, label: 'Аналітика', icon: TrendingUp },
  { id: 'b2b-invoices' as const, label: 'Рахунки B2B', icon: FileText },
  { id: 'settings' as const, label: 'Налаштування', icon: Settings },
];

export interface BillingOutletContext {
  onTopUp: () => void;
  onUpgradeTopUp: (amount: number, targetTier: string) => void;
}

export function BillingDashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [showTopUpModal, setShowTopUpModal] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState<number | undefined>();
  const [upgradeTier, setUpgradeTier] = useState<string | undefined>();

  // Derive active tab from URL path
  const pathSegment = location.pathname.split('/').pop() as BillingTab;
  const activeTab: BillingTab = tabs.some(t => t.id === pathSegment) ? pathSegment : 'overview';

  const handleUpgradeTopUp = (amount: number, targetTier: string) => {
    setTopUpAmount(amount);
    setUpgradeTier(targetTier);
    setShowTopUpModal(true);
  };

  const handleCloseTopUp = () => {
    setShowTopUpModal(false);
    setTopUpAmount(undefined);
    setUpgradeTier(undefined);
  };

  const handleBack = () => {
    navigate(-1);
  };

  const outletContext: BillingOutletContext = {
    onTopUp: () => setShowTopUpModal(true),
    onUpgradeTopUp: handleUpgradeTopUp,
  };

  return (
    <div className="flex flex-col h-full bg-claude-bg">
      {/* Header */}
      <div className="bg-white border-b border-claude-border px-6 py-4">
        <div className="flex items-center gap-4">
          <button
            onClick={handleBack}
            className="p-2 hover:bg-claude-bg rounded-lg transition-colors">
            <ArrowLeft size={20} className="text-claude-text" />
          </button>
          <div>
            <h1 className="text-2xl font-semibold text-claude-text">Панель білінгу</h1>
            <p className="text-sm text-claude-subtext mt-1">
              Керуйте балансом, оплатами та налаштуваннями вашого акаунта
            </p>
          </div>
        </div>

        <div className="mt-4"><WelcomeBonusCard /></div>

        {/* Tabs */}
        <div className="flex gap-2 mt-4 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => navigate(`/billing/${tab.id}`)}
                className={`
                  flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm
                  transition-all whitespace-nowrap relative
                  ${
                    isActive
                      ? 'bg-claude-accent text-white'
                      : 'text-claude-subtext hover:text-claude-text hover:bg-claude-bg'
                  }
                `}>
                <Icon size={18} />
                {tab.label}

                {isActive && (
                  <motion.div
                    layoutId="activeTabIndicator"
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-white"
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content — rendered by nested route */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto p-6">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}>
            <Outlet context={outletContext} />
          </motion.div>
        </div>
      </div>

      {/* Top-Up Modal */}
      <TopUpModal
        isOpen={showTopUpModal}
        onClose={handleCloseTopUp}
        initialAmount={topUpAmount}
        upgradeTier={upgradeTier}
      />
    </div>
  );
}
