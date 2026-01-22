import React, { useEffect, useRef } from 'react';
import { Message, MessageProps } from './Message';
interface MessageThreadProps {
  messages: MessageProps[];
}
export function MessageThread({
  messages
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
        {messages.map((message) => <Message key={message.id} {...message} />)}
        <div ref={bottomRef} className="h-4" />
      </div>
    </div>;
}