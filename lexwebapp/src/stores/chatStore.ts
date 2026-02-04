/**
 * Chat Store
 * Zustand store for chat state management
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { Message } from '../types/models';

interface ChatState {
  // State
  messages: Message[];
  isStreaming: boolean;
  currentSessionId: string | null;

  // Actions
  addMessage: (message: Message) => void;
  removeMessage: (messageId: string) => void;
  clearMessages: () => void;
  setStreaming: (isStreaming: boolean) => void;
  setSessionId: (sessionId: string | null) => void;

  // Helpers
  getLastMessage: () => Message | undefined;
  getMessageById: (messageId: string) => Message | undefined;
}

export const useChatStore = create<ChatState>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state
        messages: [],
        isStreaming: false,
        currentSessionId: null,

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
          }),

        // Set streaming state
        setStreaming: (isStreaming) => set({ isStreaming }),

        // Set session ID
        setSessionId: (sessionId) => set({ currentSessionId: sessionId }),

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
          // Only persist messages
          messages: state.messages,
          currentSessionId: state.currentSessionId,
        }),
      }
    ),
    { name: 'ChatStore' } // DevTools name
  )
);
