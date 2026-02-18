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
  currentSessionId: string | null;
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
  setSessionId: (sessionId: string | null) => void;

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

  // Helpers
  getLastMessage: () => Message | undefined;
  getMessageById: (messageId: string) => Message | undefined;
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
        currentSessionId: null,
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
            currentSessionId: null,
            conversationId: null,
          }),

        // Set streaming state
        setStreaming: (isStreaming) => set({ isStreaming }),

        // Set session ID
        setSessionId: (sessionId) => set({ currentSessionId: sessionId }),

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
              thinkingSteps: m.thinking_steps,
              decisions: m.decisions,
              citations: m.citations,
              documents: m.documents,
            }));
            set({
              conversationId,
              messages,
              currentSessionId: null,
            });
          } catch {
            // Keep conversationId set but preserve existing messages if API fails
            if (get().conversationId !== conversationId) {
              set({ conversationId, currentSessionId: null });
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
            currentSessionId: null,
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
            })
            .catch(() => {
              // Silent fail - localStorage backup remains
            });
        },

        // Get last message
        getLastMessage: () => {
          const { messages } = get();
          return messages[messages.length - 1];
        },

        // Get message by ID
        getMessageById: (messageId) => {
          const { messages } = get();
          return messages.find((msg) => msg.id === messageId);
        },
      }),
      {
        name: 'chat-storage', // localStorage key
        partialize: (state) => ({
          // Only persist messages (not runtime state like streamController)
          messages: state.messages,
          currentSessionId: state.currentSessionId,
          conversationId: state.conversationId,
        }),
      }
    ),
    { name: 'ChatStore' } // DevTools name
  )
);
