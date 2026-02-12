/**
 * Timer Store - Zustand state for active timers
 * Manages timer state, background pinging, and elapsed time tracking
 */

import { create } from 'zustand';
import { timeEntryService } from '../services/api/TimeEntryService';
import { ActiveTimer } from '../types/models';

interface TimerState {
  timers: ActiveTimer[];
  isLoading: boolean;
  error: string | null;
  lastSync: number | null;

  // Actions
  loadTimers: () => Promise<void>;
  startTimer: (matterId: string, description?: string) => Promise<void>;
  stopTimer: (matterId: string, createEntry?: boolean) => Promise<void>;
  pingTimers: () => Promise<void>;
  updateElapsed: () => void;
}

// Background ping interval (60 seconds)
const PING_INTERVAL = 60 * 1000;

// Elapsed time update interval (1 second)
const ELAPSED_UPDATE_INTERVAL = 1000;

let pingIntervalId: NodeJS.Timeout | null = null;
let elapsedIntervalId: NodeJS.Timeout | null = null;

export const useTimerStore = create<TimerState>((set, get) => {
  // Start background intervals
  if (!pingIntervalId) {
    pingIntervalId = setInterval(() => {
      const store = get();
      if (store.timers.length > 0) {
        store.pingTimers();
      }
    }, PING_INTERVAL);
  }

  if (!elapsedIntervalId) {
    elapsedIntervalId = setInterval(() => {
      const store = get();
      if (store.timers.length > 0) {
        store.updateElapsed();
      }
    }, ELAPSED_UPDATE_INTERVAL);
  }

  return {
    timers: [],
    isLoading: false,
    error: null,
    lastSync: null,

    /**
     * Load active timers from server
     */
    loadTimers: async () => {
      set({ isLoading: true, error: null });
      try {
        const timers = await timeEntryService.getActiveTimers();
        set({ timers, isLoading: false, lastSync: Date.now() });
      } catch (error: any) {
        set({ error: error.message || 'Failed to load timers', isLoading: false });
      }
    },

    /**
     * Start a new timer
     */
    startTimer: async (matterId: string, description?: string) => {
      set({ isLoading: true, error: null });
      try {
        const timer = await timeEntryService.startTimer(matterId, description);

        // Add to local state
        set((state) => ({
          timers: [...state.timers, timer],
          isLoading: false,
          lastSync: Date.now(),
        }));
      } catch (error: any) {
        set({ error: error.message || 'Failed to start timer', isLoading: false });
        throw error;
      }
    },

    /**
     * Stop a timer
     */
    stopTimer: async (matterId: string, createEntry: boolean = true) => {
      set({ isLoading: true, error: null });
      try {
        await timeEntryService.stopTimer(matterId, createEntry);

        // Remove from local state
        set((state) => ({
          timers: state.timers.filter((t) => t.matter_id !== matterId),
          isLoading: false,
          lastSync: Date.now(),
        }));
      } catch (error: any) {
        set({ error: error.message || 'Failed to stop timer', isLoading: false });
        throw error;
      }
    },

    /**
     * Ping all active timers to keep them alive
     */
    pingTimers: async () => {
      const { timers } = get();

      if (timers.length === 0) return;

      try {
        // Ping all timers in parallel
        await Promise.all(
          timers.map((timer) => timeEntryService.pingTimer(timer.matter_id))
        );
        set({ lastSync: Date.now() });
      } catch (error: any) {
        console.error('[TimerStore] Ping failed:', error);
        // Don't set error state for ping failures, just log them
      }
    },

    /**
     * Update elapsed time for all timers (local only)
     */
    updateElapsed: () => {
      set((state) => {
        const now = Date.now();
        const updatedTimers = state.timers.map((timer) => {
          const startedAt = new Date(timer.started_at).getTime();
          const elapsedSeconds = Math.floor((now - startedAt) / 1000);
          return {
            ...timer,
            elapsed_seconds: elapsedSeconds,
          };
        });
        return { timers: updatedTimers };
      });
    },
  };
});

// Export helper to get timer for specific matter
export function getTimerForMatter(matterId: string): ActiveTimer | undefined {
  return useTimerStore.getState().timers.find((t) => t.matter_id === matterId);
}

// Export helper to check if matter has active timer
export function hasMatterTimer(matterId: string): boolean {
  return !!getTimerForMatter(matterId);
}

// Cleanup intervals on hot reload (development)
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (pingIntervalId) clearInterval(pingIntervalId);
    if (elapsedIntervalId) clearInterval(elapsedIntervalId);
  });
}
