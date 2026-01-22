import React from 'react';
import { Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
interface EmptyStateProps {
  onSelectPrompt: (prompt: string) => void;
}
export function EmptyState({ onSelectPrompt }: EmptyStateProps) {
  const prompts = [
  'Допоможіть скласти позовну заяву про стягнення заборгованості',
  'Знайдіть практику ВС по договорах поставки',
  'Проаналізуйте підстави для скасування рішення суду',
  'Які документи потрібні для банкрутства фізичної особи?'];

  return (
    <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto">
      <div className="max-w-2xl w-full">
        <motion.div
          initial={{
            opacity: 0,
            y: 20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          transition={{
            duration: 0.6,
            ease: [0.22, 1, 0.36, 1]
          }}
          className="text-center mb-12">

          <h1 className="font-sans text-3xl md:text-4xl font-bold text-claude-text mb-4 tracking-tight">
            Ласкаво просимо до Lex
          </h1>
          <p className="font-sans text-claude-subtext text-base md:text-lg leading-relaxed max-w-xl mx-auto">
            Ваш AI-асистент для роботи з українським правом. Аналіз практики,
            підготовка документів, правові консультації.
          </p>
        </motion.div>

        <motion.div
          initial={{
            opacity: 0,
            y: 20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          transition={{
            duration: 0.6,
            delay: 0.2,
            ease: [0.22, 1, 0.36, 1]
          }}
          className="grid gap-3 md:gap-4">

          {prompts.map((prompt, index) =>
          <motion.button
            key={index}
            initial={{
              opacity: 0,
              x: -20
            }}
            animate={{
              opacity: 1,
              x: 0
            }}
            transition={{
              duration: 0.4,
              delay: 0.3 + index * 0.1
            }}
            onClick={() => onSelectPrompt(prompt)}
            className="group text-left p-4 md:p-5 bg-white border border-claude-border hover:border-claude-subtext/40 rounded-xl transition-all duration-300 hover:shadow-elevation-1 active:scale-[0.98]">

              <div className="flex items-start gap-3 md:gap-4">
                <div className="p-2 bg-claude-subtext/8 rounded-lg group-hover:bg-claude-subtext/12 transition-colors duration-200 flex-shrink-0">
                  <Sparkles
                  size={18}
                  className="text-claude-text"
                  strokeWidth={2} />

                </div>
                <p className="font-sans text-[14px] md:text-[15px] text-claude-text leading-relaxed flex-1">
                  {prompt}
                </p>
              </div>
            </motion.button>
          )}
        </motion.div>
      </div>
    </div>);

}