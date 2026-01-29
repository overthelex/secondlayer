import React from 'react';
import { BarChart3, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { motion } from 'framer-motion';
interface AnalyticsData {
  totalCases: number;
  satisfied: number;
  rejected: number;
  partial: number;
  trend: 'up' | 'down' | 'stable';
  interpretation: string;
}
interface AnalyticsBlockProps {
  data: AnalyticsData;
}
export function AnalyticsBlock({
  data
}: AnalyticsBlockProps) {
  const satisfiedPercent = Math.round(data.satisfied / data.totalCases * 100);
  const rejectedPercent = Math.round(data.rejected / data.totalCases * 100);
  const partialPercent = Math.round(data.partial / data.totalCases * 100);
  return <motion.div initial={{
    opacity: 0,
    y: 10
  }} animate={{
    opacity: 1,
    y: 0
  }} transition={{
    duration: 0.4,
    ease: [0.22, 1, 0.36, 1]
  }} className="bg-claude-bg/60 backdrop-blur-sm border border-claude-border rounded-xl p-5 my-4 shadow-sm">
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2.5 bg-white/80 backdrop-blur-sm rounded-xl shadow-sm border border-claude-border">
          <BarChart3 size={20} className="text-claude-text" strokeWidth={2} />
        </div>
        <h4 className="font-sans text-[16px] font-bold text-claude-text tracking-tight">
          Аналитика по найденной практике
        </h4>
      </div>

      {/* Statistics Grid */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <motion.div initial={{
        opacity: 0,
        scale: 0.95
      }} animate={{
        opacity: 1,
        scale: 1
      }} transition={{
        duration: 0.4,
        delay: 0.1
      }} className="bg-white/90 backdrop-blur-sm rounded-xl p-3.5 border border-claude-border shadow-sm">
          <div className="text-[11px] text-claude-subtext font-semibold mb-1.5 uppercase tracking-wide">
            Удовлетворено
          </div>
          <div className="text-3xl font-bold text-claude-text mb-1">
            {satisfiedPercent}%
          </div>
          <div className="text-[10px] text-claude-subtext font-medium">
            {data.satisfied} дел
          </div>
        </motion.div>
        <motion.div initial={{
        opacity: 0,
        scale: 0.95
      }} animate={{
        opacity: 1,
        scale: 1
      }} transition={{
        duration: 0.4,
        delay: 0.2
      }} className="bg-white/90 backdrop-blur-sm rounded-xl p-3.5 border border-claude-border shadow-sm">
          <div className="text-[11px] text-claude-subtext font-semibold mb-1.5 uppercase tracking-wide">
            Отказано
          </div>
          <div className="text-3xl font-bold text-claude-text mb-1">
            {rejectedPercent}%
          </div>
          <div className="text-[10px] text-claude-subtext font-medium">
            {data.rejected} дел
          </div>
        </motion.div>
        <motion.div initial={{
        opacity: 0,
        scale: 0.95
      }} animate={{
        opacity: 1,
        scale: 1
      }} transition={{
        duration: 0.4,
        delay: 0.3
      }} className="bg-white/90 backdrop-blur-sm rounded-xl p-3.5 border border-claude-border shadow-sm">
          <div className="text-[11px] text-claude-subtext font-semibold mb-1.5 uppercase tracking-wide">
            Частично
          </div>
          <div className="text-3xl font-bold text-claude-text mb-1">
            {partialPercent}%
          </div>
          <div className="text-[10px] text-claude-subtext font-medium">
            {data.partial} дел
          </div>
        </motion.div>
      </div>

      {/* Visual Bar */}
      <div className="h-3 bg-white/60 backdrop-blur-sm rounded-full overflow-hidden mb-4 flex shadow-inner">
        <motion.div initial={{
        width: 0
      }} animate={{
        width: `${satisfiedPercent}%`
      }} transition={{
        duration: 0.8,
        ease: [0.22, 1, 0.36, 1],
        delay: 0.4
      }} className="bg-gradient-to-r from-claude-text/60 to-claude-text/70 h-full" />
        <motion.div initial={{
        width: 0
      }} animate={{
        width: `${rejectedPercent}%`
      }} transition={{
        duration: 0.8,
        ease: [0.22, 1, 0.36, 1],
        delay: 0.5
      }} className="bg-gradient-to-r from-claude-subtext/50 to-claude-subtext/60 h-full" />
        <motion.div initial={{
        width: 0
      }} animate={{
        width: `${partialPercent}%`
      }} transition={{
        duration: 0.8,
        ease: [0.22, 1, 0.36, 1],
        delay: 0.6
      }} className="bg-gradient-to-r from-claude-subtext/30 to-claude-subtext/40 h-full" />
      </div>

      {/* Interpretation */}
      <motion.div initial={{
      opacity: 0,
      y: 10
    }} animate={{
      opacity: 1,
      y: 0
    }} transition={{
      duration: 0.4,
      delay: 0.7
    }} className="bg-white/90 backdrop-blur-sm rounded-xl p-4 border border-claude-border shadow-sm">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-claude-bg border border-claude-border">
            {data.trend === 'up' ? <TrendingUp size={16} className="text-claude-text" strokeWidth={2.5} /> : data.trend === 'down' ? <TrendingDown size={16} className="text-claude-text" strokeWidth={2.5} /> : <Minus size={16} className="text-claude-subtext" strokeWidth={2.5} />}
          </div>
          <p className="font-sans text-[14px] text-claude-text leading-relaxed flex-1">
            {data.interpretation}
          </p>
        </div>
      </motion.div>
    </motion.div>;
}