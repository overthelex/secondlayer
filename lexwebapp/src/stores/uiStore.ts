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

  // Modals
  openModals: Set<string>;
  openModal: (modalId: string) => void;
  closeModal: (modalId: string) => void;
  isModalOpen: (modalId: string) => boolean;

  // Theme
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
  toggleTheme: () => void;

  // Loading states
  globalLoading: boolean;
  setGlobalLoading: (loading: boolean) => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    persist(
      (set, get) => ({
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

        // Modals
        openModals: new Set(),
        openModal: (modalId) =>
          set((state) => ({
            openModals: new Set(state.openModals).add(modalId),
          })),
        closeModal: (modalId) =>
          set((state) => {
            const newSet = new Set(state.openModals);
            newSet.delete(modalId);
            return { openModals: newSet };
          }),
        isModalOpen: (modalId) => get().openModals.has(modalId),

        // Theme
        theme: 'light',
        setTheme: (theme) => set({ theme }),
        toggleTheme: () =>
          set((state) => ({
            theme: state.theme === 'light' ? 'dark' : 'light',
          })),

        // Loading
        globalLoading: false,
        setGlobalLoading: (loading) => set({ globalLoading: loading }),
      }),
      {
        name: 'ui-storage',
        partialize: (state) => ({
          // Persist sidebar, panel, and theme preferences
          isSidebarOpen: state.isSidebarOpen,
          isRightPanelOpen: state.isRightPanelOpen,
          rightPanelWidth: state.rightPanelWidth,
          theme: state.theme,
        }),
      }
    ),
    { name: 'UIStore' }
  )
);
