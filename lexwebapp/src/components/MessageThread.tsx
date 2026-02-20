import React, { useEffect, useRef } from 'react';
import { Message, MessageProps } from './Message';

interface MessageThreadProps {
  messages: MessageProps[];
  onRegenerate?: (userQuery: string) => void;
  onEdit?: (messageId: string, newContent: string) => void;
}

export function MessageThread({
  messages,
  onRegenerate,
  onEdit,
}: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end'
    });
  }, [messages]);

  return <div className="flex-1 overflow-y-auto scroll-smooth">
      <div className="flex flex-col">
        <div className="h-4 md:h-6" />
        {messages.map((message, idx) => {
          // For assistant messages, find the preceding user message for regeneration
          let handleRegenerate: (() => void) | undefined;
          if (message.role === 'assistant' && onRegenerate) {
            const prevMsg = messages[idx - 1];
            if (prevMsg?.role === 'user') {
              handleRegenerate = () => onRegenerate(prevMsg.content);
            }
          }
          const handleEdit = (message.role === 'user' && onEdit)
            ? (newContent: string) => onEdit(message.id, newContent)
            : undefined;

          return (
            <Message
              key={message.id}
              {...message}
              onRegenerate={handleRegenerate}
              onEdit={handleEdit}
            />
          );
        })}
        <div ref={bottomRef} className="h-4" />
      </div>
    </div>;
}
