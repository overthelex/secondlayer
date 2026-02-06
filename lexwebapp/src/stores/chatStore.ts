/**
 * Chat Store
 * Zustand store for chat state management
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { Message, ThinkingStep } from '../types/models';

interface ChatState {
  // State
  messages: Message[];
  isStreaming: boolean;
  currentSessionId: string | null;
  streamController: AbortController | null;
  currentTool: string | null;

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
        streamController: null,
        currentTool: null,

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
            messages: state.messages.map((msg) =>
              msg.id === messageId
                ? {
                    ...msg,
                    thinkingSteps: [...(msg.thinkingSteps || []), step],
                  }
                : msg
            ),
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
        }),
      }
    ),
    { name: 'ChatStore' } // DevTools name
  )
);
