/**
 * Settings Store
 * Zustand store for user preferences and settings
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

interface SettingsState {
  // Chat settings
  showThinkingSteps: boolean;
  showCitations: boolean;
  maxPrecedents: number;

  // Actions
  setShowThinkingSteps: (show: boolean) => void;
  setShowCitations: (show: boolean) => void;
  setMaxPrecedents: (max: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  devtools(
    persist(
      (set) => ({
        // Initial state
        showThinkingSteps: true,
        showCitations: true,
        maxPrecedents: 5,

        // Chat settings
        setShowThinkingSteps: (show) => set({ showThinkingSteps: show }),
        setShowCitations: (show) => set({ showCitations: show }),
        setMaxPrecedents: (max) => set({ maxPrecedents: max }),
      }),
      {
        name: 'settings-storage',
      }
    ),
    { name: 'SettingsStore' }
  )
);
