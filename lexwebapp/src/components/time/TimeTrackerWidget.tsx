/**
 * Time Tracker Widget
 * Floating widget showing active timers with start/stop controls
 */

import React, { useEffect, useState } from 'react';
import { Clock, Square, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useTimerStore } from '../../stores';
import { motion, AnimatePresence } from 'framer-motion';

export const TimeTrackerWidget: React.FC = () => {
  const { timers, loadTimers, stopTimer } = useTimerStore();
  const [isExpanded, setIsExpanded] = useState(true);
  const [isMinimized, setIsMinimized] = useState(false);

  useEffect(() => {
    loadTimers();
  }, [loadTimers]);

  useEffect(() => {
    if (timers.length > 0) {
      setIsMinimized(false);
      setIsExpanded(true);
    }
  }, [timers.length]);

  if (timers.length === 0) return null;

  const handleStopTimer = async (matterId: string) => {
    try {
      await stopTimer(matterId, true);
    } catch (error) {
      console.error('Failed to stop timer:', error);
    }
  };

  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  };

  if (isMinimized) {
    return (
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="fixed bottom-4 right-4 z-50"
      >
        <button
          onClick={() => setIsMinimized(false)}
          className="bg-claude-accent text-white p-4 rounded-full shadow-lg hover:bg-[#C66345] transition-colors"
          aria-label="Показати таймери"
        >
          <Clock size={24} />
          {timers.length > 1 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
              {timers.length}
            </span>
          )}
        </button>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ x: 400, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 400, opacity: 0 }}
      className="fixed bottom-4 right-4 z-50 w-80 bg-white rounded-2xl shadow-xl border border-claude-border"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-claude-accent text-white rounded-t-2xl">
        <div className="flex items-center gap-2 font-sans">
          <Clock size={18} />
          <span className="font-medium text-sm">Активні таймери ({timers.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 hover:bg-white/20 rounded-lg transition-colors"
            aria-label={isExpanded ? 'Згорнути' : 'Розгорнути'}
          >
            {isExpanded ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </button>
          <button
            onClick={() => setIsMinimized(true)}
            className="p-1 hover:bg-white/20 rounded-lg transition-colors"
            aria-label="Мінімізувати"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Timer List */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="max-h-96 overflow-y-auto">
              {timers.map((timer) => (
                <div
                  key={timer.id}
                  className="border-b border-claude-border/50 last:border-b-0 p-4 hover:bg-claude-bg transition-colors"
                >
                  {/* Matter Name */}
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-serif font-medium text-claude-text truncate text-sm">
                        {timer.matter_name || 'Без справи'}
                      </h4>
                      {timer.description && (
                        <p className="text-xs text-claude-subtext font-sans truncate mt-1">
                          {timer.description}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Timer Display and Controls */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 text-claude-accent">
                        <div className="w-2 h-2 bg-claude-accent rounded-full animate-pulse" />
                        <span className="font-mono text-lg font-semibold">
                          {formatDuration(timer.elapsed_seconds)}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleStopTimer(timer.matter_id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors text-xs font-medium font-sans"
                    >
                      <Square size={12} />
                      Зупинити
                    </button>
                  </div>

                  {/* Started At */}
                  <div className="mt-2 text-xs text-claude-subtext font-sans">
                    Початок: {new Date(timer.started_at).toLocaleTimeString('uk-UA')}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
