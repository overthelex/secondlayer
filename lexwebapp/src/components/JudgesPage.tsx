import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Search,
  Scale,
  ChevronRight,
  Gavel,
  Percent,
  Clock,
  Filter,
  LayoutGrid,
  List } from
'lucide-react';
interface Judge {
  id: string;
  name: string;
  court: string;
  cases: number;
  approvalRate: number;
  avgDuration: string;
  specialization: string;
}
const judgesData: Judge[] = [
{
  id: '1',
  name: 'Иванов Петр Сергеевич',
  court: 'Верховный Суд КГС',
  cases: 156,
  approvalRate: 68,
  avgDuration: '4.5 мес.',
  specialization: 'Банкротство'
},
{
  id: '2',
  name: 'Петрова Анна Викторовна',
  court: 'Арбитражный суд г. Москвы',
  cases: 203,
  approvalRate: 72,
  avgDuration: '3.2 мес.',
  specialization: 'Корпоративные споры'
},
{
  id: '3',
  name: 'Сидоров Михаил Александрович',
  court: 'Девятый арбитражный апелляционный суд',
  cases: 89,
  approvalRate: 65,
  avgDuration: '2.8 мес.',
  specialization: 'Недвижимость'
},
{
  id: '4',
  name: 'Кузнецова Елена Дмитриевна',
  court: 'Арбитражный суд Московской области',
  cases: 142,
  approvalRate: 59,
  avgDuration: '5.1 мес.',
  specialization: 'Налоговые споры'
}];

interface JudgesPageProps {
  onSelectJudge?: (judge: Judge) => void;
}
export function JudgesPage({ onSelectJudge }: JudgesPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'comfortable' | 'compact'>(
    'comfortable'
  );
  const filteredJudges = judgesData.filter(
    (judge) =>
    judge.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    judge.court.toLowerCase().includes(searchQuery.toLowerCase())
  );
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Header Section */}
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
          }}
          className="space-y-6">

          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight mb-2">
                Судьи
              </h1>
              <p className="text-claude-subtext font-sans">
                Поиск и аналитика по судебному корпусу
              </p>
            </div>

            <div className="flex items-center gap-2 text-sm text-claude-subtext bg-white px-3 py-1.5 rounded-lg border border-claude-border shadow-sm">
              <Scale size={16} />
              <span className="font-sans">
                {judgesData.length} судей в базе
              </span>
            </div>
          </div>

          {/* Search Bar */}
          <div className="flex gap-3">
            <div className="relative flex-1 group">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-claude-subtext group-focus-within:text-claude-accent transition-colors" />
              </div>
              <input
                type="text"
                className="block w-full pl-11 pr-4 py-4 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans"
                placeholder="Поиск по фамилии судьи или названию суда..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)} />

            </div>

            {/* View Mode Toggle */}
            <div className="flex bg-white border border-claude-border rounded-xl p-1">
              <button
                onClick={() => setViewMode('comfortable')}
                className={`p-2 rounded-lg transition-colors ${viewMode === 'comfortable' ? 'bg-claude-accent text-white' : 'text-claude-subtext hover:text-claude-text'}`}
                title="Комфортный вид">

                <LayoutGrid size={18} />
              </button>
              <button
                onClick={() => setViewMode('compact')}
                className={`p-2 rounded-lg transition-colors ${viewMode === 'compact' ? 'bg-claude-accent text-white' : 'text-claude-subtext hover:text-claude-text'}`}
                title="Компактный вид">

                <List size={18} />
              </button>
            </div>
          </div>
        </motion.div>

        {/* Results Grid */}
        <div
          className={`grid ${viewMode === 'compact' ? 'grid-cols-1 gap-2' : 'grid-cols-1 md:grid-cols-2 gap-4'}`}>

          {filteredJudges.map((judge, index) =>
          <motion.div
            key={judge.id}
            initial={{
              opacity: 0,
              y: 20
            }}
            animate={{
              opacity: 1,
              y: 0
            }}
            transition={{
              duration: 0.4,
              delay: index * 0.05 + 0.2
            }}
            onClick={() => onSelectJudge?.(judge)}
            className={`group bg-white rounded-2xl border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all cursor-pointer relative overflow-hidden ${viewMode === 'compact' ? 'p-3' : 'p-5'}`}>

              <div className="absolute top-0 right-0 p-5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 transform translate-x-2 group-hover:translate-x-0">
                <ChevronRight className="text-claude-subtext" />
              </div>

              <div
              className={`flex items-start gap-3 ${viewMode === 'compact' ? 'mb-2' : 'mb-4'}`}>

                {viewMode === 'comfortable' &&
              <div className="w-14 h-14 rounded-full bg-claude-sidebar border-2 border-white shadow-sm flex items-center justify-center text-xl font-serif text-claude-subtext flex-shrink-0">
                    {judge.name.
                split(' ').
                map((n) => n[0]).
                slice(0, 2).
                join('')}
                  </div>
              }
                <div className="flex-1">
                  <h3
                  className={`font-serif font-medium text-claude-text group-hover:text-claude-accent transition-colors ${viewMode === 'compact' ? 'text-base' : 'text-lg'}`}>

                    {judge.name}
                  </h3>
                  <p
                  className={`text-claude-subtext font-sans mt-0.5 line-clamp-1 ${viewMode === 'compact' ? 'text-xs' : 'text-sm'}`}>

                    {judge.court}
                  </p>
                  <div
                  className={`mt-2 inline-flex items-center px-2 py-0.5 rounded font-medium font-sans bg-claude-bg text-claude-subtext border border-claude-border/50 ${viewMode === 'compact' ? 'text-[10px]' : 'text-xs'}`}>

                    {judge.specialization}
                  </div>
                </div>
              </div>

              <div
              className={`grid grid-cols-3 gap-2 pt-3 border-t border-claude-border/50 ${viewMode === 'compact' ? 'text-xs' : ''}`}>

                <div className="text-center">
                  <div
                  className={`flex items-center justify-center gap-1 text-claude-subtext mb-1 font-sans ${viewMode === 'compact' ? 'text-[10px]' : 'text-xs'}`}>

                    <Gavel size={viewMode === 'compact' ? 10 : 12} />
                    <span>Дел</span>
                  </div>
                  <div
                  className={`font-medium text-claude-text font-serif ${viewMode === 'compact' ? 'text-base' : 'text-lg'}`}>

                    {judge.cases}
                  </div>
                </div>
                <div className="text-center border-l border-claude-border/50">
                  <div
                  className={`flex items-center justify-center gap-1 text-claude-subtext mb-1 font-sans ${viewMode === 'compact' ? 'text-[10px]' : 'text-xs'}`}>

                    <Percent size={viewMode === 'compact' ? 10 : 12} />
                    <span>Удовл.</span>
                  </div>
                  <div
                  className={`font-medium text-claude-text font-serif ${viewMode === 'compact' ? 'text-base' : 'text-lg'}`}>

                    {judge.approvalRate}%
                  </div>
                </div>
                <div className="text-center border-l border-claude-border/50">
                  <div
                  className={`flex items-center justify-center gap-1 text-claude-subtext mb-1 font-sans ${viewMode === 'compact' ? 'text-[10px]' : 'text-xs'}`}>

                    <Clock size={viewMode === 'compact' ? 10 : 12} />
                    <span>Срок</span>
                  </div>
                  <div
                  className={`font-medium text-claude-text font-serif ${viewMode === 'compact' ? 'text-base' : 'text-lg'}`}>

                    {judge.avgDuration}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </div>

        {filteredJudges.length === 0 &&
        <motion.div
          initial={{
            opacity: 0
          }}
          animate={{
            opacity: 1
          }}
          className="text-center py-12">

            <div className="w-16 h-16 bg-claude-bg rounded-full flex items-center justify-center mx-auto mb-4 text-claude-subtext">
              <Search size={24} />
            </div>
            <h3 className="text-lg font-serif text-claude-text mb-2">
              Ничего не найдено
            </h3>
            <p className="text-claude-subtext font-sans max-w-md mx-auto">
              Попробуйте изменить параметры поиска или проверить написание
              фамилии
            </p>
          </motion.div>
        }
      </div>
    </div>);

}