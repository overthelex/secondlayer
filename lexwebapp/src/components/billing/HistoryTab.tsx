/**
 * History Tab
 * Combines Transactions and Invoices with a sub-toggle
 */

import React, { useState } from 'react';
import { Receipt, FileText } from 'lucide-react';
import { TransactionsTab } from './TransactionsTab';
import { InvoicesTab } from './InvoicesTab';

type HistoryView = 'transactions' | 'invoices';

export function HistoryTab() {
  const [view, setView] = useState<HistoryView>('transactions');

  return (
    <div className="space-y-6">
      {/* Sub-toggle */}
      <div className="flex gap-2 bg-white border border-claude-border rounded-xl p-1.5 w-fit">
        <button
          onClick={() => setView('transactions')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            view === 'transactions'
              ? 'bg-claude-accent text-white'
              : 'text-claude-subtext hover:text-claude-text hover:bg-claude-bg'
          }`}>
          <Receipt size={16} />
          Транзакції
        </button>
        <button
          onClick={() => setView('invoices')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            view === 'invoices'
              ? 'bg-claude-accent text-white'
              : 'text-claude-subtext hover:text-claude-text hover:bg-claude-bg'
          }`}>
          <FileText size={16} />
          Рахунки
        </button>
      </div>

      {/* Content */}
      {view === 'transactions' && <TransactionsTab />}
      {view === 'invoices' && <InvoicesTab />}
    </div>
  );
}
