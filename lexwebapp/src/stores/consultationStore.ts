import { create } from 'zustand';
import { consultationService, type Consultation } from '../services/api/ConsultationService';
import { API_BASE } from '../utils/api/base';

/** Dedup set for recent SSE event IDs (prevents duplicate processing on reconnect) */
const recentEventIds = new Set<string>();
const MAX_RECENT_IDS = 500;

function trackEventId(id: string): boolean {
  if (recentEventIds.has(id)) return false; // Already seen
  recentEventIds.add(id);
  if (recentEventIds.size > MAX_RECENT_IDS) {
    // Evict oldest entries (Set preserves insertion order)
    const iter = recentEventIds.values();
    for (let i = 0; i < 100; i++) iter.next();
    const toDelete = [...recentEventIds].slice(0, 100);
    toDelete.forEach(id => recentEventIds.delete(id));
  }
  return true; // New event
}

interface ConsultationState {
  globalUnreadCount: number;
  pendingCount: number;
  pendingConsultations: Consultation[];
  eventSource: EventSource | null;
  listeners: Map<string, Set<(consultation: Consultation) => void>>;

  connect: () => void;
  disconnect: () => void;
  fetchInitialCounts: () => Promise<void>;
  setGlobalUnreadCount: (count: number) => void;
  decrementUnread: (by?: number) => void;
  setPendingConsultations: (consultations: Consultation[]) => void;

  // Per-consultation status listeners
  addStatusListener: (consultationId: string, cb: (consultation: Consultation) => void) => () => void;
}

export const useConsultationStore = create<ConsultationState>((set, get) => ({
  globalUnreadCount: 0,
  pendingCount: 0,
  pendingConsultations: [],
  eventSource: null,
  listeners: new Map(),

  connect: () => {
    const existing = get().eventSource;
    if (existing) return;

    const token = localStorage.getItem('auth_token');
    if (!token) return;

    const baseURL = API_BASE;
    const url = `${baseURL}/api/consultations/user-stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);

    es.addEventListener('consultation_status', (event) => {
      try {
        const data = JSON.parse(event.data);
        const consultation = data.consultation;
        if (!consultation) return;

        // Notify per-consultation listeners
        const listeners = get().listeners.get(consultation.id);
        if (listeners) {
          listeners.forEach(cb => cb(consultation));
        }

        // Update pending counts
        if (consultation.status === 'pending') {
          set(s => ({
            pendingCount: s.pendingCount + 1,
            pendingConsultations: [consultation, ...s.pendingConsultations.filter(c => c.id !== consultation.id)],
          }));
        } else {
          set(s => ({
            pendingConsultations: s.pendingConsultations.filter(c => c.id !== consultation.id),
            pendingCount: Math.max(0, s.pendingConsultations.filter(c => c.id !== consultation.id).length),
          }));
        }

        // Invalidate TanStack Query caches
        try {
          // Use window event to signal query invalidation (avoids direct queryClient dependency)
          window.dispatchEvent(new CustomEvent('consultation-updated', { detail: consultation }));
        } catch {}
      } catch {}
    });

    es.addEventListener('new_message', (event) => {
      try {
        const data = JSON.parse(event.data);
        // Deduplicate: skip if we've already processed this event
        const eventId = data.messageId || data.consultationId + ':' + data.preview;
        if (!trackEventId(eventId)) return;

        set(s => ({ globalUnreadCount: s.globalUnreadCount + 1 }));
        // Dispatch event for toast notifications
        window.dispatchEvent(new CustomEvent('consultation-new-message', { detail: data }));
      } catch {}
    });

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    set({ eventSource: es });
  },

  disconnect: () => {
    const es = get().eventSource;
    if (es) {
      es.close();
      set({ eventSource: null });
    }
  },

  fetchInitialCounts: async () => {
    try {
      const [unreadResult, pendingResult] = await Promise.all([
        consultationService.getGlobalUnreadCount(),
        consultationService.getUnseenPending(),
      ]);
      set({
        globalUnreadCount: unreadResult.count,
        pendingCount: pendingResult.count,
        pendingConsultations: pendingResult.consultations,
      });
    } catch {}
  },

  setGlobalUnreadCount: (count) => set({ globalUnreadCount: count }),

  decrementUnread: (by = 1) => set(s => ({
    globalUnreadCount: Math.max(0, s.globalUnreadCount - by),
  })),

  setPendingConsultations: (consultations) => set({
    pendingConsultations: consultations,
    pendingCount: consultations.length,
  }),

  addStatusListener: (consultationId, cb) => {
    const { listeners } = get();
    if (!listeners.has(consultationId)) {
      listeners.set(consultationId, new Set());
    }
    listeners.get(consultationId)!.add(cb);
    set({ listeners: new Map(listeners) });

    return () => {
      const current = get().listeners;
      const set_ = current.get(consultationId);
      if (set_) {
        set_.delete(cb);
        if (set_.size === 0) current.delete(consultationId);
      }
    };
  },
}));
