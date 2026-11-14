/**
 * Shared error handling and conversation utilities for chat hooks.
 * Extracted from useAIChat and useMCPTool to eliminate duplication.
 */

import { useChatStore } from '../../stores';
import showToast from '../../utils/toast';
import { getErrorMessage } from '../../utils/errors';

/**
 * Handles stream/tool errors: updates the message, resets streaming state,
 * shows a toast, and invokes the optional onError callback.
 */
export function handleStreamError(
  assistantMessageId: string,
  error: { message?: string; code?: string; current_balance_usd?: number; free_tier?: { daily_limit: number; used_today: number; remaining: number } },
  deps: {
    updateMessage: ReturnType<typeof useChatStore.getState>['updateMessage'];
    setStreaming: ReturnType<typeof useChatStore.getState>['setStreaming'];
    setStreamController: ReturnType<typeof useChatStore.getState>['setStreamController'];
    setCurrentTool: ReturnType<typeof useChatStore.getState>['setCurrentTool'];
    onError?: (error: Error) => void;
  }
) {
  const { updateMessage, setStreaming, setStreamController, setCurrentTool, onError } = deps;

  let content: string;
  let toastMessage: string;

  if (error.code === 'BETA_RESTRICTED') {
    content = `⚠️ **Потрібен баланс**\n\nЩоб користуватися чатом, прив'яжіть картку й отримайте 430 грн вітального бонусу або поповніть баланс. [Перейти до білінгу](/billing).`;
    toastMessage = 'Прив\'яжіть картку або поповніть баланс';
  } else if (error.code === 'INSUFFICIENT_BALANCE') {
    const balance = error.current_balance_usd != null
      ? `$${error.current_balance_usd.toFixed(2)}`
      : '';
    const freeTier = error.free_tier;
    if (freeTier && freeTier.daily_limit > 0) {
      content = `⚠️ **Вичерпано безкоштовні запити** (${freeTier.used_today}/${freeTier.daily_limit} за сьогодні).\n\nДля необмеженого доступу, будь ласка, [поповніть баланс](/billing).`;
      toastMessage = `Безкоштовні запити вичерпано (${freeTier.used_today}/${freeTier.daily_limit})`;
    } else {
      content = `⚠️ **Недостатньо коштів на балансі**${balance ? ` (поточний баланс: ${balance})` : ''}.\n\nДля продовження роботи, будь ласка, [поповніть баланс](/billing).`;
      toastMessage = 'Недостатньо коштів на балансі';
    }
  } else {
    const msg = error.message || 'Невідома помилка';
    content = `Помилка: ${msg}`;
    toastMessage = msg;
  }

  updateMessage(assistantMessageId, {
    content,
    isStreaming: false,
  });
  setStreaming(false);
  setStreamController(null);
  setCurrentTool(null);
  showToast.error(toastMessage);

  onError?.(new Error(toastMessage));
}

/**
 * Handles catch-block errors (unknown type): extracts message,
 * then delegates to handleStreamError.
 *
 * Note: setStreamController is not called here because catch blocks
 * in the original code did not reset it (the controller was never set
 * when these errors occur). We still accept it for consistency.
 */
export function handleCatchError(
  assistantMessageId: string,
  error: unknown,
  deps: {
    updateMessage: ReturnType<typeof useChatStore.getState>['updateMessage'];
    setStreaming: ReturnType<typeof useChatStore.getState>['setStreaming'];
    setCurrentTool: ReturnType<typeof useChatStore.getState>['setCurrentTool'];
    onError?: (error: Error) => void;
  }
) {
  const msg = getErrorMessage(error);
  const { updateMessage, setStreaming, setCurrentTool, onError } = deps;

  updateMessage(assistantMessageId, {
    content: `Помилка: ${msg}`,
    isStreaming: false,
  });
  setStreaming(false);
  setCurrentTool(null);
  showToast.error(msg);

  onError?.(error instanceof Error ? error : new Error(msg));
}

/**
 * Auto-rename a conversation to the first user message content
 * if the conversation still has the default title.
 *
 * @param opts.maxMessages - When set, only auto-title if message count
 *   is at most this value (used by useMCPTool for first-exchange guard).
 */
export function autoTitleConversation(opts?: { maxMessages?: number }) {
  const state = useChatStore.getState();
  if (!state.conversationId) return;

  if (opts?.maxMessages != null && state.messages.length > opts.maxMessages) {
    return;
  }

  const conv = state.conversations.find(
    (c) => c.id === state.conversationId
  );
  const needsRename =
    !conv || conv.title === 'New conversation' || conv.title === 'Нова розмова';

  if (needsRename) {
    const firstUserMsg = state.messages.find((m) => m.role === 'user');
    if (firstUserMsg) {
      const title = firstUserMsg.content.slice(0, 60).trim();
      state.renameConversation(state.conversationId!, title);
    }
  }
}
