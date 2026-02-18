/**
 * UI Store
 * Zustand store for UI state (sidebar, modals, etc)
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

interface UIState {
  // Sidebar
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (isOpen: boolean) => void;

  // Right Panel
  isRightPanelOpen: boolean;
  toggleRightPanel: () => void;
  setRightPanelOpen: (isOpen: boolean) => void;
  rightPanelWidth: number;
  setRightPanelWidth: (width: number) => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    persist(
      (set) => ({
        // Sidebar - default open on desktop, closed on mobile
        isSidebarOpen: window.innerWidth >= 1024,
        toggleSidebar: () =>
          set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
        setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),

        // Right Panel - default closed on mobile, open on desktop
        isRightPanelOpen: window.innerWidth >= 1024,
        toggleRightPanel: () =>
          set((state) => ({ isRightPanelOpen: !state.isRightPanelOpen })),
        setRightPanelOpen: (isOpen) => set({ isRightPanelOpen: isOpen }),
        rightPanelWidth: 400,
        setRightPanelWidth: (width) => set({ rightPanelWidth: Math.min(800, Math.max(320, width)) }),
      }),
      {
        name: 'ui-storage',
        partialize: (state) => ({
          isSidebarOpen: state.isSidebarOpen,
          isRightPanelOpen: state.isRightPanelOpen,
          rightPanelWidth: state.rightPanelWidth,
        }),
      }
    ),
    { name: 'UIStore' }
  )
);
