import React, { useEffect, useState, useRef } from 'react';
import { Send, Plus, Sparkles } from 'lucide-react';
interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}
export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const adjustHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };
  useEffect(() => {
    adjustHeight();
  }, [input]);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };
  const handleSubmit = () => {
    if (!input.trim() || disabled) return;
    onSend(input);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 pb-2">
      <div className="relative bg-white rounded-2xl border border-claude-border shadow-sm focus-within:shadow-md focus-within:border-claude-subtext/40 transition-all duration-300">
        <div className="flex items-end gap-2 p-2">
          <button
            type="button"
            className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200 flex-shrink-0"
            aria-label="Додати вкладення">

            <Plus size={18} strokeWidth={2} />
          </button>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Відповісти..."
            disabled={disabled}
            rows={1}
            className="flex-1 py-2 px-2 bg-transparent border-none resize-none focus:ring-0 focus:outline-none text-claude-text placeholder:text-claude-subtext/40 font-sans text-[15px] leading-relaxed max-h-[200px] overflow-hidden"
            style={{
              minHeight: '40px'
            }} />


          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200"
              aria-label="AI підказки">

              <Sparkles size={18} strokeWidth={2} />
            </button>
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || disabled}
              className={`p-2 rounded-lg transition-all duration-200 ${input.trim() && !disabled ? 'bg-claude-text text-white hover:bg-claude-text/90 shadow-sm active:scale-95' : 'bg-claude-subtext/10 text-claude-subtext/30 cursor-not-allowed'}`}
              aria-label="Надіслати повідомлення">

              <Send size={18} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </div>);

}