import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Scale,
  TrendingUp,
  Download,
  FileText,
  Eye,
  CheckCircle,
  XCircle,
  BarChart3,
  Calendar,
  ArrowLeft,
  ChevronDown,
  Building2,
  Users,
  Tag } from
'lucide-react';
interface CourtCase {
  id: string;
  number: string;
  court: string;
  date: string;
  result: 'approved' | 'rejected';
}
interface CourtPracticeAnalysisPageProps {
  onBack?: () => void;
}
const mockCases: CourtCase[] = [
{
  id: '1',
  number: '123/456/2024',
  court: 'ВС',
  date: '15.01.2024',
  result: 'approved'
},
{
  id: '2',
  number: '789/012/2024',
  court: 'КАС',
  date: '10.01.2024',
  result: 'rejected'
},
{
  id: '3',
  number: '345/678/2024',
  court: 'ВС',
  date: '08.01.2024',
  result: 'approved'
},
{
  id: '4',
  number: '901/234/2024',
  court: 'ХОС',
  date: '05.01.2024',
  result: 'approved'
},
{
  id: '5',
  number: '567/890/2024',
  court: 'КАС',
  date: '03.01.2024',
  result: 'rejected'
}];

const categories = [
{
  id: 'civil',
  label: 'Цивільні',
  icon: '⚖️'
},
{
  id: 'criminal',
  label: 'Кримінальні',
  icon: '🔒'
},
{
  id: 'administrative',
  label: 'Адміністративні',
  icon: '🏛️'
},
{
  id: 'economic',
  label: 'Господарські',
  icon: '💼'
},
{
  id: 'electoral',
  label: 'Виборчі',
  icon: '🗳️'
}];

const topCourts = [
{
  name: 'Верховний Суд',
  cases: 89
},
{
  name: 'Київський апеляційний суд',
  cases: 56
},
{
  name: 'Харківський окружний суд',
  cases: 34
},
{
  name: 'Одеський апеляційний суд',
  cases: 28
},
{
  name: 'Львівський окружний суд',
  cases: 22
}];

const keyArguments = [
{
  text: 'Проект передбачає...',
  count: 156
},
{
  text: 'Майбутня норма закону...',
  count: 89
},
{
  text: 'Законодавча ініціатива...',
  count: 67
},
{
  text: 'Відповідно до проекту...',
  count: 45
},
{
  text: 'У разі прийняття закону...',
  count: 34
}];

const monthlyData = [
{
  month: 'Січ',
  count: 45
},
{
  month: 'Лют',
  count: 52
},
{
  month: 'Бер',
  count: 38
},
{
  month: 'Квіт',
  count: 61
},
{
  month: 'Трав',
  count: 48
},
{
  month: 'Черв',
  count: 55
},
{
  month: 'Лип',
  count: 42
},
{
  month: 'Серп',
  count: 39
},
{
  month: 'Вер',
  count: 47
},
{
  month: 'Жовт',
  count: 53
},
{
  month: 'Лист',
  count: 28
},
{
  month: 'Груд',
  count: 15
}];

export function CourtPracticeAnalysisPage({
  onBack
}: CourtPracticeAnalysisPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState('2024-01-01');
  const [dateTo, setDateTo] = useState('2026-01-19');
  const [showResults, setShowResults] = useState(false);
  const handleAnalyze = () => {
    setShowResults(true);
  };
  const maxCount = Math.max(...monthlyData.map((d) => d.count));
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
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
            duration: 0.5,
            ease: [0.22, 1, 0.36, 1]
          }}>

          <div className="flex items-center gap-4 mb-6">
            {onBack &&
            <button
              onClick={onBack}
              className="p-2 hover:bg-white rounded-lg transition-colors border border-claude-border">

                <ArrowLeft size={20} className="text-claude-text" />
              </button>
            }
            <div>
              <div className="flex items-center gap-3 mb-2">
                <Scale size={32} className="text-claude-accent" />
                <h1 className="text-3xl md:text-4xl font-sans text-claude-text font-medium tracking-tight">
                  Аналіз судової практики
                </h1>
              </div>
              <p className="text-claude-subtext font-sans text-sm">
                Зв'язок законопроектів та судових рішень
              </p>
            </div>
          </div>

          {/* Statistics */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
            <div className="flex items-center gap-2 mb-6">
              <BarChart3 size={20} className="text-claude-accent" />
              <h3 className="text-lg font-sans text-claude-text font-medium">
                Статистика впливу на судову практику
              </h3>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 bg-claude-bg rounded-lg border border-claude-border">
                <p className="text-xs text-claude-subtext font-sans mb-1">
                  Всього проаналізовано справ
                </p>
                <p className="text-xl font-sans font-bold text-claude-text">
                  2,847
                </p>
              </div>
              <div className="p-3 bg-claude-bg rounded-lg border border-claude-border">
                <p className="text-xs text-claude-subtext font-sans mb-1">
                  Посилань на закон
                </p>
                <p className="text-xl font-sans font-bold text-claude-text">
                  1,234
                </p>
              </div>
              <div className="p-3 bg-claude-bg rounded-lg border border-claude-border">
                <p className="text-xs text-claude-subtext font-sans mb-1">
                  Середня частота
                </p>
                <p className="text-xl font-sans font-bold text-claude-text">
                  43%
                </p>
              </div>
              <div className="p-3 bg-claude-bg rounded-lg border border-claude-border">
                <p className="text-xs text-claude-subtext font-sans mb-1">
                  Тренд
                </p>
                <p className="text-xl font-sans font-bold text-green-600 flex items-center gap-1">
                  <TrendingUp size={16} />
                  +15%
                </p>
              </div>
            </div>
          </div>

          {/* Top Courts */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
            <div className="flex items-center gap-2 mb-4">
              <Building2 size={20} className="text-claude-accent" />
              <h3 className="text-lg font-sans text-claude-text font-medium">
                Топ-5 судів з найбільшою кількістю посилань
              </h3>
            </div>
            <div className="space-y-3">
              {topCourts.map((court, index) =>
              <motion.div
                key={court.name}
                initial={{
                  opacity: 0,
                  x: -20
                }}
                animate={{
                  opacity: 1,
                  x: 0
                }}
                transition={{
                  delay: index * 0.1
                }}
                className="flex items-center gap-4 p-3 bg-claude-bg rounded-xl border border-claude-border">

                  <div className="w-8 h-8 rounded-full bg-claude-accent text-white flex items-center justify-center font-serif font-bold text-sm">
                    {index + 1}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-claude-text font-sans">
                      {court.name}
                    </p>
                  </div>
                  <div className="text-sm font-medium text-claude-accent font-sans">
                    {court.cases} справ
                  </div>
                </motion.div>
              )}
            </div>
          </div>

          {/* Key Arguments */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
            <div className="flex items-center gap-2 mb-4">
              <FileText size={20} className="text-claude-accent" />
              <h3 className="text-lg font-sans text-claude-text font-medium">
                Ключові аргументи в рішеннях
              </h3>
            </div>
            <div className="space-y-2">
              {keyArguments.map((arg, index) =>
              <motion.div
                key={arg.text}
                initial={{
                  opacity: 0,
                  y: 10
                }}
                animate={{
                  opacity: 1,
                  y: 0
                }}
                transition={{
                  delay: index * 0.05
                }}
                className="flex items-center justify-between p-3 bg-claude-bg rounded-lg border border-claude-border">

                  <span className="text-sm text-claude-text font-sans">
                    • {arg.text}
                  </span>
                  <span className="text-xs text-claude-subtext font-sans bg-white px-2 py-1 rounded border border-claude-border">
                    {arg.count} разів
                  </span>
                </motion.div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </div>);

}