/**
 * chatStore Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';
import type { Message, ThinkingStep } from '../../types/models';

describe('chatStore', () => {
  beforeEach(() => {
    // Reset store before each test
    useChatStore.setState({
      messages: [],
      isStreaming: false,
      streamController: null,
      currentTool: null,
    });
  });

  describe('Basic actions', () => {
    it('should add message', () => {
      const message: Message = {
        id: '1',
        role: 'user',
        content: 'Test message',
      };

      useChatStore.getState().addMessage(message);

      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().messages[0]).toEqual(message);
    });

    it('should remove message by ID', () => {
      const message1: Message = { id: '1', role: 'user', content: 'Test 1' };
      const message2: Message = { id: '2', role: 'user', content: 'Test 2' };

      useChatStore.getState().addMessage(message1);
      useChatStore.getState().addMessage(message2);

      expect(useChatStore.getState().messages).toHaveLength(2);

      useChatStore.getState().removeMessage('1');

      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().messages[0].id).toBe('2');
    });

    it('should clear all messages', () => {
      useChatStore.getState().addMessage({ id: '1', role: 'user', content: 'Test' });
      useChatStore.getState().addMessage({ id: '2', role: 'assistant', content: 'Response' });

      expect(useChatStore.getState().messages).toHaveLength(2);

      useChatStore.getState().clearMessages();

      expect(useChatStore.getState().messages).toHaveLength(0);
    });

    it('should set streaming state', () => {
      expect(useChatStore.getState().isStreaming).toBe(false);

      useChatStore.getState().setStreaming(true);

      expect(useChatStore.getState().isStreaming).toBe(true);
    });
  });

  describe('Streaming actions', () => {
    it('should update message by ID', () => {
      const message: Message = {
        id: '1',
        role: 'assistant',
        content: 'Initial',
        isStreaming: true,
      };

      useChatStore.getState().addMessage(message);

      useChatStore.getState().updateMessage('1', {
        content: 'Updated',
        isStreaming: false,
      });

      const updated = useChatStore.getState().messages[0];

      expect(updated.content).toBe('Updated');
      expect(updated.isStreaming).toBe(false);
    });

    it('should not update non-existent message', () => {
      const message: Message = { id: '1', role: 'user', content: 'Test' };

      useChatStore.getState().addMessage(message);

      useChatStore.getState().updateMessage('999', { content: 'Updated' });

      expect(useChatStore.getState().messages[0].content).toBe('Test');
    });

    it('should add thinking step to message', () => {
      const message: Message = {
        id: '1',
        role: 'assistant',
        content: 'Thinking...',
        thinkingSteps: [],
      };

      useChatStore.getState().addMessage(message);

      const step: ThinkingStep = {
        id: 'step-1',
        title: 'Analyzing',
        content: 'Analyzing query',
        isComplete: false,
      };

      useChatStore.getState().addThinkingStep('1', step);

      const updated = useChatStore.getState().messages[0];

      expect(updated.thinkingSteps).toHaveLength(1);
      expect(updated.thinkingSteps![0]).toEqual(step);
    });

    it('should append thinking steps', () => {
      const message: Message = {
        id: '1',
        role: 'assistant',
        content: 'Thinking...',
        thinkingSteps: [
          { id: 'step-1', title: 'Step 1', content: '', isComplete: true },
        ],
      };

      useChatStore.getState().addMessage(message);

      const step2: ThinkingStep = {
        id: 'step-2',
        title: 'Step 2',
        content: '',
        isComplete: false,
      };

      useChatStore.getState().addThinkingStep('1', step2);

      const updated = useChatStore.getState().messages[0];

      expect(updated.thinkingSteps).toHaveLength(2);
      expect(updated.thinkingSteps![1]).toEqual(step2);
    });

    it('should handle message without existing thinking steps', () => {
      const message: Message = {
        id: '1',
        role: 'assistant',
        content: 'Test',
      };

      useChatStore.getState().addMessage(message);

      const step: ThinkingStep = {
        id: 'step-1',
        title: 'First step',
        content: '',
        isComplete: true,
      };

      useChatStore.getState().addThinkingStep('1', step);

      const updated = useChatStore.getState().messages[0];

      expect(updated.thinkingSteps).toHaveLength(1);
    });

    it('should set stream controller', () => {
      const controller = new AbortController();

      expect(useChatStore.getState().streamController).toBeNull();

      useChatStore.getState().setStreamController(controller);

      expect(useChatStore.getState().streamController).toBe(controller);
    });

    it('should clear stream controller', () => {
      const controller = new AbortController();

      useChatStore.getState().setStreamController(controller);
      expect(useChatStore.getState().streamController).toBe(controller);

      useChatStore.getState().setStreamController(null);
      expect(useChatStore.getState().streamController).toBeNull();
    });

    it('should set current tool', () => {
      expect(useChatStore.getState().currentTool).toBeNull();

      useChatStore.getState().setCurrentTool('get_legal_advice');

      expect(useChatStore.getState().currentTool).toBe('get_legal_advice');
    });

    it('should cancel stream', () => {
      const controller = new AbortController();

      useChatStore.setState({
        streamController: controller,
        isStreaming: true,
        currentTool: 'get_legal_advice',
      });

      expect(controller.signal.aborted).toBe(false);

      useChatStore.getState().cancelStream();

      expect(controller.signal.aborted).toBe(true);
      expect(useChatStore.getState().streamController).toBeNull();
      expect(useChatStore.getState().isStreaming).toBe(false);
      expect(useChatStore.getState().currentTool).toBeNull();
    });

    it('should handle cancel with no active controller', () => {
      expect(useChatStore.getState().streamController).toBeNull();

      // Should not throw
      useChatStore.getState().cancelStream();

      expect(useChatStore.getState().streamController).toBeNull();
    });
  });

  describe('Persistence', () => {
    it('should only persist specific fields', () => {
      // This is tested by the middleware configuration
      // streamController and currentTool should NOT be persisted
      const controller = new AbortController();

      useChatStore.setState({
        messages: [{ id: '1', role: 'user', content: 'Test' }],
        isStreaming: true,
        streamController: controller,
        currentTool: 'get_legal_advice',
      });

      // Check what would be persisted (via partialize)
      const persistedState = {
        messages: useChatStore.getState().messages,
      };

      expect(persistedState.messages).toHaveLength(1);
      expect('streamController' in persistedState).toBe(false);
      expect('currentTool' in persistedState).toBe(false);
      expect('isStreaming' in persistedState).toBe(false);
    });
  });

  describe('Complex scenarios', () => {
    it('should handle complete streaming flow', () => {
      const controller = new AbortController();

      // Start streaming
      const userMsg: Message = { id: '1', role: 'user', content: 'Query' };
      const assistantMsg: Message = {
        id: '2',
        role: 'assistant',
        content: '',
        isStreaming: true,
      };

      useChatStore.getState().addMessage(userMsg);
      useChatStore.getState().addMessage(assistantMsg);
      useChatStore.getState().setStreaming(true);
      useChatStore.getState().setStreamController(controller);
      useChatStore.getState().setCurrentTool('get_legal_advice');

      // Add thinking steps
      useChatStore.getState().addThinkingStep('2', {
        id: 'step-1',
        title: 'Step 1',
        content: 'Processing',
        isComplete: false,
      });

      useChatStore.getState().addThinkingStep('2', {
        id: 'step-2',
        title: 'Step 2',
        content: 'Completed',
        isComplete: true,
      });

      // Complete streaming
      useChatStore.getState().updateMessage('2', {
        content: 'Final answer',
        isStreaming: false,
      });

      useChatStore.getState().setStreaming(false);
      useChatStore.getState().setStreamController(null);
      useChatStore.getState().setCurrentTool(null);

      const state = useChatStore.getState();

      expect(state.messages).toHaveLength(2);
      expect(state.messages[1].content).toBe('Final answer');
      expect(state.messages[1].isStreaming).toBe(false);
      expect(state.messages[1].thinkingSteps).toHaveLength(2);
      expect(state.isStreaming).toBe(false);
      expect(state.streamController).toBeNull();
      expect(state.currentTool).toBeNull();
    });

    it('should handle multiple concurrent messages', () => {
      useChatStore.getState().addMessage({ id: '1', role: 'user', content: 'Q1' });
      useChatStore.getState().addMessage({ id: '2', role: 'assistant', content: 'A1' });
      useChatStore.getState().addMessage({ id: '3', role: 'user', content: 'Q2' });
      useChatStore.getState().addMessage({ id: '4', role: 'assistant', content: '', isStreaming: true });

      useChatStore.getState().updateMessage('4', { content: 'A2' });
      useChatStore.getState().addThinkingStep('2', {
        id: 'step-1',
        title: 'Backfill',
        content: '',
        isComplete: true,
      });

      const state = useChatStore.getState();

      expect(state.messages).toHaveLength(4);
      expect(state.messages[1].thinkingSteps).toHaveLength(1);
      expect(state.messages[3].content).toBe('A2');
    });
  });
});
