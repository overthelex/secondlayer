import { useState } from 'react';
import { ChevronDown, CheckCircle2, Circle, Target } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ExecutionPlan } from '../types/models/Message';

interface PlanDisplayProps {
  plan: ExecutionPlan;
}

export function PlanDisplay({ plan }: PlanDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const completedCount = plan.steps.filter((s) => s.completed).length;
  const totalCount = plan.steps.length;

  return (
    <div className="my-3 border border-claude-border/50 rounded-lg overflow-hidden bg-white/50">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-claude-bg/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <Target size={14} className="text-claude-text flex-shrink-0" strokeWidth={2} />
          <span className="text-[13px] text-claude-text font-medium truncate">
            {plan.goal}
          </span>
          <span className="text-[11px] text-claude-subtext flex-shrink-0">
            {completedCount}/{totalCount}
          </span>
        </div>
        <ChevronDown
          size={14}
          className={`text-claude-subtext transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
          strokeWidth={2}
        />
      </button>

      {/* Steps */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-claude-border/30"
          >
            <div className="p-3 space-y-2">
              {plan.steps.map((step) => (
                <div
                  key={step.id}
                  className="flex items-start gap-2.5"
                >
                  {step.completed ? (
                    <CheckCircle2
                      size={14}
                      className="text-green-600 flex-shrink-0 mt-0.5"
                      strokeWidth={2}
                    />
                  ) : (
                    <Circle
                      size={14}
                      className="text-claude-subtext/40 flex-shrink-0 mt-0.5"
                      strokeWidth={2}
                    />
                  )}
                  <div className="min-w-0">
                    <span
                      className={`text-[13px] leading-relaxed ${
                        step.completed
                          ? 'text-claude-subtext line-through'
                          : 'text-claude-text'
                      }`}
                    >
                      {step.purpose}
                    </span>
                    <span className="text-[11px] text-claude-subtext/60 ml-1.5">
                      {step.tool}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
