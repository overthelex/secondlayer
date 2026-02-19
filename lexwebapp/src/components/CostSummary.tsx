import React, { useState } from 'react';
import { ChevronDown, Coins } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { CostSummary as CostSummaryType } from '../types/models/Message';

const TOOL_LABELS: Record<string, string> = {
  search_legal_precedents: 'Пошук прецедентів',
  search_supreme_court_practice: 'Практика ВС',
  get_court_decision: 'Отримання рішення',
  get_case_documents_chain: 'Ланцюг документів',
  find_similar_fact_pattern_cases: 'Схожі справи',
  compare_practice_pro_contra: 'Аналіз за і проти',
  search_legislation: 'Пошук законодавства',
  get_legislation_article: 'Стаття закону',
  semantic_search: 'Семантичний пошук',
  openreyestr_search_entities: 'Пошук юросіб',
  openreyestr_get_by_edrpou: 'Пошук за ЄДРПОУ',
  rada_search_parliament_bills: 'Законопроекти Ради',
};

function getToolLabel(name: string): string {
  return TOOL_LABELS[name] || name;
}

interface CostSummaryProps {
  data: CostSummaryType;
}

export function CostSummary({ data }: CostSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[12px] text-claude-subtext hover:text-claude-text transition-colors"
      >
        <Coins size={12} strokeWidth={2} />
        <span>
          {data.charged_usd != null && Number(data.charged_usd) > 0
            ? `$${Number(data.charged_usd).toFixed(4)}`
            : Number(data.total_cost_usd) > 0
              ? `$${Number(data.total_cost_usd).toFixed(4)}`
              : '$0.00'}
        </span>
        <ChevronDown
          size={12}
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          strokeWidth={2}
        />
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 px-3 py-2.5 rounded-lg border border-claude-border/50 bg-claude-bg/40 text-[12px] text-claude-subtext space-y-1.5">
              {/* Tools used */}
              {data.tools_used.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  <span className="font-medium text-claude-text">Інструменти:</span>
                  {data.tools_used.map((tool) => (
                    <span
                      key={tool}
                      className="px-1.5 py-0.5 rounded bg-claude-subtext/8 text-[11px]"
                    >
                      {getToolLabel(tool)}
                    </span>
                  ))}
                </div>
              )}

              {/* Cost breakdown */}
              <div className="flex items-center gap-3 flex-wrap">
                {Number(data.total_cost_usd) > 0 && (
                  <span>Вартість LLM: ${Number(data.total_cost_usd).toFixed(4)}</span>
                )}
                {data.charged_usd != null && Number(data.charged_usd) > 0 && (
                  <span>Списано: ${Number(data.charged_usd).toFixed(4)}</span>
                )}
                {data.balance_usd != null && (
                  <span>Баланс: ${Number(data.balance_usd).toFixed(2)}</span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
