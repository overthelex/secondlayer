/**
 * Team Page Component
 * Main team management interface with tabs for overview and other features
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, Zap, BarChart3, CreditCard, Shield } from 'lucide-react';
import { OverviewTab } from './OverviewTab';
import { UnderConstructionTab } from './UnderConstructionTab';

type TeamTab = 'overview' | 'tariffs' | 'statistics' | 'payments' | 'limits';

interface Tab {
  id: TeamTab;
  label: string;
  icon: React.ComponentType<any>;
}

export function TeamPage() {
  const [activeTab, setActiveTab] = useState<TeamTab>('overview');

  const tabs: Tab[] = [
    {
      id: 'overview',
      label: 'Огляд',
      icon: TrendingUp,
    },
    {
      id: 'tariffs',
      label: 'Тарифи',
      icon: Zap,
    },
    {
      id: 'statistics',
      label: 'Статистика',
      icon: BarChart3,
    },
    {
      id: 'payments',
      label: 'Платежі',
      icon: CreditCard,
    },
    {
      id: 'limits',
      label: 'Ліміти',
      icon: Shield,
    },
  ];

  return (
    <div className="flex-1 h-full overflow-y-auto bg-gray-50">
      <div className="max-w-7xl mx-auto p-6 md:p-8 lg:p-12 space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-200 pb-6">
          <div>
            <h1 className="text-3xl font-semibold text-gray-900 tracking-tight">
              Управління командою
            </h1>
            <p className="text-gray-600 mt-1">
              Запрошуйте колег та відстежуйте використання на рівні команди
            </p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex overflow-x-auto pb-2 md:pb-0 gap-1 border-b border-gray-200 scrollbar-hide">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <motion.button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 font-medium text-sm whitespace-nowrap transition-all duration-200 relative ${
                  isActive
                    ? 'text-blue-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
                whileHover={{ y: -2 }}
                whileTap={{ y: 0 }}
              >
                <Icon size={18} />
                {tab.label}
                {isActive && (
                  <motion.div
                    layoutId="activeTab"
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600"
                    initial={false}
                    transition={{
                      type: 'spring',
                      stiffness: 380,
                      damping: 30,
                    }}
                  />
                )}
              </motion.button>
            );
          })}
        </div>

        {/* Tab Content */}
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.3 }}
        >
          {activeTab === 'overview' && <OverviewTab />}
          {activeTab === 'tariffs' && <UnderConstructionTab />}
          {activeTab === 'statistics' && <UnderConstructionTab />}
          {activeTab === 'payments' && <UnderConstructionTab />}
          {activeTab === 'limits' && <UnderConstructionTab />}
        </motion.div>
      </div>
    </div>
  );
}
