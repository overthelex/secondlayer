/**
 * Billing Dashboard
 * Main billing interface with 5 tabs: Overview, Tariffs, History, Analytics, Settings
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  DollarSign,
  Receipt,
  Settings,
  ArrowLeft,
  Zap,
  TrendingUp,
} from 'lucide-react';
import { OverviewTab } from './billing/OverviewTab';
import { TariffsTab } from './billing/TariffsTab';
import { HistoryTab } from './billing/HistoryTab';
import { AnalyticsTab } from './billing/AnalyticsTab';
import { SettingsTab } from './billing/SettingsTab';
import { TopUpModal } from './billing/TopUpModal';

type BillingTab = 'overview' | 'tariffs' | 'history' | 'analytics' | 'settings';

interface BillingDashboardProps {
  onBack?: () => void;
  initialTab?: BillingTab;
}

export function BillingDashboard({ onBack, initialTab = 'overview' }: BillingDashboardProps) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<BillingTab>(initialTab);
  const [showTopUpModal, setShowTopUpModal] = useState(false);

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      navigate(-1);
    }
  };

  const tabs = [
    { id: 'overview' as const, label: 'Огляд', icon: DollarSign },
    { id: 'tariffs' as const, label: 'Тарифи', icon: Zap },
    { id: 'history' as const, label: 'Історія', icon: Receipt },
    { id: 'analytics' as const, label: 'Аналітика', icon: TrendingUp },
    { id: 'settings' as const, label: 'Налаштування', icon: Settings },
  ];

  return (
    <div className="flex flex-col h-screen bg-claude-bg">
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

        {/* Tabs */}
        <div className="flex gap-2 mt-4 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto p-6">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}>
            {activeTab === 'overview' && <OverviewTab onTopUp={() => setShowTopUpModal(true)} />}
            {activeTab === 'tariffs' && <TariffsTab />}
            {activeTab === 'history' && <HistoryTab />}
            {activeTab === 'analytics' && <AnalyticsTab />}
            {activeTab === 'settings' && <SettingsTab />}
          </motion.div>
        </div>
      </div>

      {/* Top-Up Modal */}
      <TopUpModal
        isOpen={showTopUpModal}
        onClose={() => setShowTopUpModal(false)}
      />
    </div>
  );
}
