/**
 * Admin Billing Management Page
 * Tabs: Pricing Tiers, Organizations, Subscriptions, Welcome bonuses
 */

import { useState } from 'react';
import { PricingTiersTab } from './PricingTiersTab';
import { OrganizationsTab } from './OrganizationsTab';
import { SubscriptionsTab } from './SubscriptionsTab';
import { WelcomeBonusTab } from './WelcomeBonusTab';

export function AdminBillingPage() {
  const [tab, setTab] = useState<'tiers' | 'organizations' | 'subscriptions' | 'welcome'>('tiers');

  const tabs = [
    { id: 'tiers' as const, label: 'Pricing Tiers' },
    { id: 'organizations' as const, label: 'Organizations' },
    { id: 'subscriptions' as const, label: 'Subscriptions' },
    { id: 'welcome' as const, label: 'Вітальні бонуси' },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Tab Bar */}
        <div className="flex gap-1 border-b border-gray-200 mb-6">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {tab === 'tiers' && <PricingTiersTab />}
        {tab === 'organizations' && <OrganizationsTab />}
        {tab === 'subscriptions' && <SubscriptionsTab />}
        {tab === 'welcome' && <WelcomeBonusTab />}
      </div>
    </div>
  );
}
