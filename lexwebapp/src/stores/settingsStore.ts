/**
 * Settings Store
 * Zustand store for user preferences and settings
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

interface SettingsState {
  // Chat settings
  autoSave: boolean;
  showThinkingSteps: boolean;
  showCitations: boolean;
  maxPrecedents: number;

  // Notification settings
  soundEnabled: boolean;
  desktopNotifications: boolean;

  // Display settings
  fontSize: 'small' | 'medium' | 'large';
  compactMode: boolean;

  // Language
  language: 'uk' | 'en';

  // Actions
  setAutoSave: (enabled: boolean) => void;
  setShowThinkingSteps: (show: boolean) => void;
  setShowCitations: (show: boolean) => void;
  setMaxPrecedents: (max: number) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setDesktopNotifications: (enabled: boolean) => void;
  setFontSize: (size: 'small' | 'medium' | 'large') => void;
  setCompactMode: (compact: boolean) => void;
  setLanguage: (lang: 'uk' | 'en') => void;
  resetSettings: () => void;
}

const DEFAULT_SETTINGS = {
  autoSave: true,
  showThinkingSteps: true,
  showCitations: true,
  maxPrecedents: 5,
  soundEnabled: true,
  desktopNotifications: false,
  fontSize: 'medium' as const,
  compactMode: false,
  language: 'uk' as const,
};

export const useSettingsStore = create<SettingsState>()(
  devtools(
    persist(
      (set) => ({
        // Initial state
        ...DEFAULT_SETTINGS,

        // Chat settings
        setAutoSave: (enabled) => set({ autoSave: enabled }),
        setShowThinkingSteps: (show) => set({ showThinkingSteps: show }),
        setShowCitations: (show) => set({ showCitations: show }),
        setMaxPrecedents: (max) => set({ maxPrecedents: max }),

        // Notifications
        setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
        setDesktopNotifications: (enabled) =>
          set({ desktopNotifications: enabled }),

        // Display
        setFontSize: (size) => set({ fontSize: size }),
        setCompactMode: (compact) => set({ compactMode: compact }),

        // Language
        setLanguage: (lang) => set({ language: lang }),

        // Reset to defaults
        resetSettings: () => set(DEFAULT_SETTINGS),
      }),
      {
        name: 'settings-storage',
      }
    ),
    { name: 'SettingsStore' }
  )
);
