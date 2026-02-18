import { motion } from 'framer-motion';
import {
  Scale,
  ArrowLeft,
  FileSearch
} from 'lucide-react';
import { useBackNavigation } from '../hooks/useBackNavigation';

interface CaseAnalysisPageProps {
  onBack?: () => void;
}

export function CaseAnalysisPage({ onBack }: CaseAnalysisPageProps) {
  const handleBack = useBackNavigation(onBack);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-claude-border">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-4">
          <div className="flex items-center gap-4">
            <button
              onClick={handleBack}
              className="p-2 hover:bg-claude-bg rounded-lg transition-colors">
              <ArrowLeft size={20} className="text-claude-text" />
            </button>
            <div>
              <h1 className="text-2xl font-serif text-claude-text font-medium">
                Аналіз справи
              </h1>
              <p className="text-sm text-claude-subtext font-sans">
                Контекст та пов'язана судова практика
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Empty State */}
      <div className="max-w-7xl mx-auto px-4 md:px-8 py-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 bg-claude-accent/10 rounded-2xl flex items-center justify-center mb-6">
            <FileSearch size={40} className="text-claude-accent" />
          </div>
          <h2 className="text-xl font-serif text-claude-text font-medium mb-3">
            Справу не обрано
          </h2>
          <p className="text-sm text-claude-subtext font-sans max-w-md mb-8">
            Оберіть судове рішення для аналізу через пошук або завантажте документ у систему.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={handleBack}
              className="px-6 py-3 bg-claude-accent text-white rounded-xl text-sm font-medium font-sans hover:bg-[#C66345] transition-colors flex items-center gap-2">
              <Scale size={16} />
              Перейти до пошуку
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
