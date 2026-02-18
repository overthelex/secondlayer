/**
 * Top-up Modal
 * Wraps TopUpTab in a full-screen modal overlay
 */

import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { TopUpTab } from './TopUpTab';

interface TopUpModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  initialAmount?: number;
  upgradeTier?: string;
}

export function TopUpModal({ isOpen, onClose, onSuccess, initialAmount, upgradeTier }: TopUpModalProps) {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}>
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="relative w-full max-w-3xl my-8 mx-4 bg-claude-bg rounded-2xl shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-claude-border bg-white rounded-t-2xl">
              <div>
                <h2 className="text-xl font-semibold text-claude-text">Поповнити баланс</h2>
                {upgradeTier && (
                  <p className="text-sm text-claude-subtext mt-0.5">
                    Для переходу на тариф <strong>{upgradeTier.charAt(0).toUpperCase() + upgradeTier.slice(1)}</strong> необхідно поповнити баланс на <strong>${initialAmount?.toFixed(2)}</strong>
                  </p>
                )}
              </div>
              <button
                onClick={onClose}
                className="p-2 hover:bg-claude-bg rounded-lg transition-colors">
                <X size={20} className="text-claude-subtext" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6">
              <TopUpTab initialAmount={initialAmount} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
