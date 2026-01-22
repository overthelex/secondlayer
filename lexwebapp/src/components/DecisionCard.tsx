import React from 'react';
import { Gavel, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';
export interface Decision {
  id: string;
  number: string;
  court: string;
  date: string;
  summary: string;
  relevance: number;
  status: 'active' | 'overturned' | 'modified';
}
interface DecisionCardProps {
  decision: Decision;
  compact?: boolean;
}
export function DecisionCard({
  decision,
  compact = false
}: DecisionCardProps) {
  return <motion.div initial={{
    opacity: 0,
    y: 10
  }} animate={{
    opacity: 1,
    y: 0
  }} transition={{
    duration: 0.4,
    ease: [0.22, 1, 0.36, 1]
  }} className="bg-white/80 backdrop-blur-sm border border-claude-border rounded-xl p-4 hover:border-claude-subtext/40 hover:shadow-elevation-1 transition-all duration-300 cursor-pointer group">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-claude-subtext/10 rounded-lg">
            <Gavel size={14} className="text-claude-text" strokeWidth={2} />
          </div>
          <span className="font-mono text-[13px] font-semibold text-claude-text tracking-tight">
            {decision.number}
          </span>
        </div>
        <span className={`text-[9px] px-2 py-1 rounded-full font-semibold uppercase tracking-wide ${decision.status === 'active' ? 'bg-claude-bg text-claude-text border border-claude-border' : decision.status === 'overturned' ? 'bg-claude-subtext/10 text-claude-subtext border border-claude-border' : 'bg-claude-bg text-claude-subtext border border-claude-border'}`}>
          {decision.status === 'active' ? 'В силе' : decision.status === 'overturned' ? 'Отменено' : 'Изменено'}
        </span>
      </div>

      <div className="text-[11px] text-claude-subtext font-medium mb-3">
        {decision.court} • {decision.date}
      </div>

      {!compact && <p className="font-sans text-[14px] text-claude-text leading-relaxed mb-3 line-clamp-2">
          {decision.summary}
        </p>}

      <div className="flex items-center justify-between pt-3 border-t border-claude-border/50">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className="w-20 h-1.5 bg-claude-bg rounded-full overflow-hidden">
              <motion.div initial={{
              width: 0
            }} animate={{
              width: `${decision.relevance}%`
            }} transition={{
              duration: 0.8,
              ease: [0.22, 1, 0.36, 1],
              delay: 0.2
            }} className="h-full bg-gradient-to-r from-claude-subtext/60 to-claude-text/60 rounded-full" />
            </div>
            <span className="text-[11px] text-claude-subtext font-semibold">
              {decision.relevance}%
            </span>
          </div>
        </div>
        <button className="text-[11px] text-claude-text hover:text-claude-subtext font-semibold flex items-center gap-1 group-hover:gap-1.5 transition-all duration-200">
          Подробнее
          <ExternalLink size={11} strokeWidth={2.5} />
        </button>
      </div>
    </motion.div>;
}