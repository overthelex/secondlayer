/**
 * Chat Page
 * Main chat interface with message thread and input
 * Now using Zustand store and React Query for state management
 */

import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ChatInput } from '../../components/ChatInput';
import { MessageThread } from '../../components/MessageThread';
import { EmptyState } from '../../components/EmptyState';
import { useChatStore } from '../../stores';
import { useSettingsStore } from '../../stores';
import { useGetLegalAdvice } from '../../hooks/queries';
import { Message } from '../../types/models';
import showToast from '../../utils/toast';

export function ChatPage() {
  const location = useLocation();

  // Zustand stores
  const {
    messages,
    isStreaming,
    addMessage,
    clearMessages,
    setStreaming,
  } = useChatStore();

  const { maxPrecedents } = useSettingsStore();

  // React Query mutation
  const { mutateAsync: getLegalAdvice, isPending } = useGetLegalAdvice();

  // Reset messages when navigating to chat with reset state
  useEffect(() => {
    if (location.state?.reset) {
      clearMessages();
      setStreaming(false);
      // Clear the state to prevent reset on subsequent renders
      window.history.replaceState({}, document.title);
    }
  }, [location.state, clearMessages, setStreaming]);

  const handleSend = async (content: string) => {
    // Add user message immediately
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
    };
    addMessage(userMessage);
    setStreaming(true);

    try {
      // Call legal service via React Query
      const aiMessage = await getLegalAdvice({
        query: content,
        max_precedents: maxPrecedents,
      });

      // Add AI response to messages
      addMessage(aiMessage);
      setStreaming(false);
    } catch (error: any) {
      console.error('Legal service error:', error);

      // Show error toast
      showToast.error(
        error.message || 'Помилка при зверненні до API. Спробуйте пізніше.'
      );

      // Add error message to chat
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Вибачте, сталася помилка: ${
          error.message || 'Невідома помилка'
        }. Будь ласка, спробуйте пізніше.`,
        isStreaming: false,
      };
      addMessage(errorMessage);
      setStreaming(false);
    }
  };

  return (
    <>
      {messages.length === 0 ? (
        <EmptyState onSelectPrompt={handleSend} />
      ) : (
        <MessageThread messages={messages} />
      )}
      <div className="w-full bg-gradient-to-t from-white via-white to-transparent pt-6 pb-4 z-20 border-t border-claude-border/30">
        <ChatInput onSend={handleSend} disabled={isStreaming || isPending} />
      </div>
    </>
  );
}
