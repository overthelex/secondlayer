/**
 * Chat Page
 * Main chat interface with message thread and input
 * Now using MCP streaming with all 43 tools support
 */

import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ChatInput } from '../../components/ChatInput';
import { MessageThread } from '../../components/MessageThread';
import { EmptyState } from '../../components/EmptyState';
import { useChatStore } from '../../stores';
import { useSettingsStore } from '../../stores';
import { useMCPTool } from '../../hooks/useMCPTool';
import { Message } from '../../types/models';
import showToast from '../../utils/toast';

export function ChatPage() {
  const location = useLocation();
  const [selectedTool, setSelectedTool] = useState('get_legal_advice');

  // Zustand stores
  const { messages, isStreaming, clearMessages, setStreaming } = useChatStore();
  const { maxPrecedents } = useSettingsStore();

  // MCP Tool hook with streaming support
  const { executeTool } = useMCPTool(selectedTool, {
    enableStreaming: import.meta.env.VITE_ENABLE_SSE_STREAMING !== 'false',
  });

  // Reset messages when navigating to chat with reset state
  useEffect(() => {
    if (location.state?.reset) {
      clearMessages();
      setStreaming(false);
      // Clear the state to prevent reset on subsequent renders
      window.history.replaceState({}, document.title);
    }
  }, [location.state, clearMessages, setStreaming]);

  /**
   * Parse content to tool-specific parameters
   */
  const parseContentToToolParams = (toolName: string, content: string): any => {
    switch (toolName) {
      case 'get_legal_advice':
      case 'packaged_lawyer_answer':
        return {
          query: content,
          max_precedents: maxPrecedents,
          include_reasoning: true,
        };

      case 'search_court_cases':
        return {
          query: content,
          limit: 10,
        };

      case 'search_legislation':
      case 'search_legal_precedents':
        return {
          query: content,
          limit: 5,
        };

      case 'classify_intent':
        return {
          query: content,
        };

      case 'get_document_text':
        return {
          document_id: content,
          include_metadata: true,
        };

      case 'search_deputies':
        return {
          query: content,
          limit: 10,
        };

      case 'search_entities':
        return {
          query: content,
          entity_type: 'all',
          limit: 10,
        };

      default:
        // Generic fallback
        return { query: content };
    }
  };

  const handleSend = async (content: string, toolName?: string) => {
    const tool = toolName || selectedTool;
    const params = parseContentToToolParams(tool, content);

    try {
      await executeTool(params);
    } catch (error: any) {
      console.error('MCP tool execution error:', error);
      showToast.error(
        error.message || 'Помилка при зверненні до API. Спробуйте пізніше.'
      );
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
        <ChatInput onSend={handleSend} disabled={isStreaming} />
      </div>
    </>
  );
}
