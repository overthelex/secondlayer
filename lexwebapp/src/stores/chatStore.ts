/**
 * Chat Store
 * Zustand store for chat state management with server-side sync
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { Message, ThinkingStep } from '../types/models';
import { api } from '../utils/api-client';

interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string;
}

interface ChatState {
  // State
  messages: Message[];
  isStreaming: boolean;
  streamController: AbortController | null;
  currentTool: string | null;

  // Conversation state
  conversationId: string | null;
  conversations: ConversationSummary[];
  conversationsLoading: boolean;

  // Actions
  addMessage: (message: Message) => void;
  removeMessage: (messageId: string) => void;
  clearMessages: () => void;
  setStreaming: (isStreaming: boolean) => void;

  // Streaming actions
  updateMessage: (messageId: string, updates: Partial<Message>) => void;
  addThinkingStep: (messageId: string, step: ThinkingStep) => void;
  setStreamController: (controller: AbortController | null) => void;
  setCurrentTool: (toolName: string | null) => void;
  cancelStream: () => void;

  // Conversation actions
  loadConversations: () => Promise<void>;
  createConversation: (title?: string) => Promise<string>;
  switchConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  newConversation: () => void;
  syncMessage: (message: Message) => void;

}

function isAuthenticated(): boolean {
  return !!localStorage.getItem('auth_token');
}

export const useChatStore = create<ChatState>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state
        messages: [],
        isStreaming: false,
        streamController: null,
        currentTool: null,
        conversationId: null,
        conversations: [],
        conversationsLoading: false,

        // Add message to the end
        addMessage: (message) =>
          set((state) => ({
            messages: [...state.messages, message],
          })),

        // Remove message by ID
        removeMessage: (messageId) =>
          set((state) => ({
            messages: state.messages.filter((msg) => msg.id !== messageId),
          })),

        // Clear all messages
        clearMessages: () =>
          set({
            messages: [],
            conversationId: null,
          }),

        // Set streaming state
        setStreaming: (isStreaming) => set({ isStreaming }),

        // Update specific message (for incremental streaming updates)
        updateMessage: (messageId, updates) =>
          set((state) => ({
            messages: state.messages.map((msg) =>
              msg.id === messageId ? { ...msg, ...updates } : msg
            ),
          })),

        // Add thinking step to message
        addThinkingStep: (messageId, step) =>
          set((state) => ({
            messages: state.messages.map((msg) => {
              if (msg.id !== messageId) return msg;
              const existing = (msg.thinkingSteps || []);
              const idx = existing.findIndex((s) => s.id === step.id);
              return {
                ...msg,
                thinkingSteps: idx >= 0
                  ? existing.map((s, i) => (i === idx ? step : s))
                  : [...existing, step],
              };
            }),
          })),

        // Set stream controller for cancellation
        setStreamController: (controller) =>
          set({ streamController: controller }),

        // Set current tool being executed
        setCurrentTool: (toolName) => set({ currentTool: toolName }),

        // Cancel active stream
        cancelStream: () => {
          const { streamController } = get();
          if (streamController) {
            streamController.abort();
            set({
              streamController: null,
              isStreaming: false,
              currentTool: null,
            });
          }
        },

        // Load conversations list from server
        loadConversations: async () => {
          if (!isAuthenticated()) return;
          set({ conversationsLoading: true });
          try {
            const response = await api.conversations.list({ limit: 50 });
            set({
              conversations: response.data.conversations ?? [],
              conversationsLoading: false,
            });
          } catch {
            set({ conversationsLoading: false });
          }
        },

        // Create new conversation on server
        createConversation: async (title?: string) => {
          if (!isAuthenticated()) return '';
          try {
            const response = await api.conversations.create(title);
            const conv = response.data;
            set((state) => ({
              conversationId: conv.id,
              conversations: [
                { id: conv.id, title: conv.title, updated_at: conv.updated_at },
                ...state.conversations,
              ],
            }));
            return conv.id;
          } catch {
            return '';
          }
        },

        // Switch to existing conversation
        switchConversation: async (conversationId: string) => {
          if (!isAuthenticated()) return;
          try {
            const response = await api.conversations.get(conversationId);
            const data = response.data;
            const messages: Message[] = (data.messages || []).map((m: any) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              thinkingSteps: Array.isArray(m.thinking_steps)
                ? m.thinking_steps.map((s: any, i: number) => ({
                    id: `step-${i}`,
                    title: `✓ ${s.tool || 'tool'}`,
                    content: typeof s.result === 'string'
                      ? s.result.slice(0, 500)
                      : JSON.stringify(s.result, null, 2).slice(0, 500),
                    isComplete: true,
                  }))
                : undefined,
              decisions: m.decisions,
              citations: m.citations,
              documents: m.documents,
              costSummary: m.cost_summary ?? undefined,
            }));
            set({
              conversationId,
              messages,
            });
          } catch {
            // Keep conversationId set but preserve existing messages if API fails
            if (get().conversationId !== conversationId) {
              set({ conversationId });
            }
          }
        },

        // Delete conversation
        deleteConversation: async (conversationId: string) => {
          if (!isAuthenticated()) return;
          try {
            await api.conversations.delete(conversationId);
            const { conversationId: currentId } = get();
            set((state) => ({
              conversations: state.conversations.filter((c) => c.id !== conversationId),
              ...(currentId === conversationId
                ? { conversationId: null, messages: [] }
                : {}),
            }));
          } catch {
            // ignore
          }
        },

        // Rename conversation
        renameConversation: async (conversationId: string, title: string) => {
          if (!isAuthenticated()) return;
          try {
            await api.conversations.rename(conversationId, title);
            set((state) => ({
              conversations: state.conversations.map((c) =>
                c.id === conversationId ? { ...c, title } : c
              ),
            }));
          } catch {
            // ignore
          }
        },

        // Start a new empty conversation
        newConversation: () => {
          set({
            messages: [],
            conversationId: null,
          });
        },

        // Sync message to server (fire-and-forget)
        syncMessage: (message: Message) => {
          if (!isAuthenticated()) return;
          const { conversationId } = get();
          if (!conversationId) return;

          api.conversations
            .addMessage(conversationId, {
              role: message.role,
              content: message.content,
              thinking_steps: message.thinkingSteps,
              decisions: message.decisions,
              citations: message.citations,
              documents: message.documents,
              cost_summary: message.costSummary,
            })
            .catch(() => {
              // Silent fail - localStorage backup remains
            });
        },

      }),
      {
        name: 'chat-storage', // localStorage key
        partialize: (state) => ({
          // Only persist messages (not runtime state like streamController)
          messages: state.messages,
          conversationId: state.conversationId,
        }),
      }
    ),
    { name: 'ChatStore' } // DevTools name
  )
);
