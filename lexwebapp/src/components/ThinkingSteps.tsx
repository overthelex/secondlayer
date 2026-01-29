import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
interface ThinkingStep {
  id: string;
  title: string;
  content?: string;
  isComplete: boolean;
}
interface ThinkingStepsProps {
  steps: ThinkingStep[];
  isThinking?: boolean;
}
export function ThinkingSteps({
  steps,
  isThinking = false
}: ThinkingStepsProps) {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };
  return <div className="space-y-2 my-4">
      {/* Header */}
      <button onClick={() => {
      if (expandedSteps.size === steps.length) {
        setExpandedSteps(new Set());
      } else {
        setExpandedSteps(new Set(steps.map((s) => s.id)));
      }
    }} className="flex items-center gap-2 text-[13px] text-claude-subtext hover:text-claude-text transition-colors group w-full">
        <ChevronUp size={14} className={`transition-transform ${expandedSteps.size === 0 ? 'rotate-180' : ''}`} strokeWidth={2} />
        <span className="font-medium">{steps.length} steps</span>
        {isThinking && <Loader2 size={12} className="animate-spin text-claude-subtext" strokeWidth={2} />}
      </button>

      {/* Steps */}
      <AnimatePresence>
        {steps.map((step) => <motion.div key={step.id} initial={{
        opacity: 0,
        height: 0
      }} animate={{
        opacity: 1,
        height: 'auto'
      }} exit={{
        opacity: 0,
        height: 0
      }} className="border border-claude-border/50 rounded-lg overflow-hidden bg-white/50">
            <button onClick={() => toggleStep(step.id)} className="w-full flex items-center justify-between p-3 hover:bg-claude-bg/50 transition-colors text-left">
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${step.isComplete ? 'bg-claude-text' : 'bg-claude-subtext/30'}`} />
                <span className="text-[13px] text-claude-text font-medium truncate">
                  {step.title}
                </span>
              </div>
              <ChevronDown size={14} className={`text-claude-subtext transition-transform flex-shrink-0 ${expandedSteps.has(step.id) ? 'rotate-180' : ''}`} strokeWidth={2} />
            </button>

            <AnimatePresence>
              {expandedSteps.has(step.id) && step.content && <motion.div initial={{
            height: 0,
            opacity: 0
          }} animate={{
            height: 'auto',
            opacity: 1
          }} exit={{
            height: 0,
            opacity: 0
          }} transition={{
            duration: 0.2
          }} className="border-t border-claude-border/30">
                  <div className="p-3 text-[13px] text-claude-text leading-relaxed bg-claude-bg/30">
                    {step.content}
                  </div>
                </motion.div>}
            </AnimatePresence>
          </motion.div>)}
      </AnimatePresence>
    </div>;
}