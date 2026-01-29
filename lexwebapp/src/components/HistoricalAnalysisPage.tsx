import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Download,
  Printer,
  ArrowLeft,
  TrendingUp,
  PieChart as PieChartIcon,
  Eye,
  ChevronDown,
  ChevronUp,
  ScrollText,
  BookOpen,
  BarChart3,
  RefreshCw,
  Clock } from
'lucide-react';
interface HistoricalAnalysisPageProps {
  onBack?: () => void;
}
interface Revision {
  id: number;
  date: string;
  basis: string;
  changes: string;
}
const popularLaws = [
{
  name: 'Конституція України',
  number: '254к/96-ВР',
  revisions: 33
},
{
  name: 'Цивільний кодекс',
  number: '435-15',
  revisions: 127
},
{
  name: 'Кримінальний кодекс',
  number: '2341-14',
  revisions: 456
},
{
  name: 'Податковий кодекс',
  number: '2755-17',
  revisions: 389
}];

const revisions: Revision[] = [
{
  id: 33,
  date: '01.01.2020',
  basis: '27-IX',
  changes: '12 статей'
},
{
  id: 32,
  date: '03.09.2019',
  basis: '38-IX',
  changes: 'Технічні'
},
{
  id: 31,
  date: '07.02.2019',
  basis: '2680-VIII',
  changes: '3 статті'
},
{
  id: 30,
  date: '21.02.2014',
  basis: '742-VII',
  changes: '47 статей'
},
{
  id: 29,
  date: '19.09.2013',
  basis: '586-VII',
  changes: 'Редакційні'
}];

const yearlyChanges = [
{
  year: '1996',
  count: 0
},
{
  year: '2000',
  count: 2
},
{
  year: '2004',
  count: 47
},
{
  year: '2008',
  count: 5
},
{
  year: '2012',
  count: 8
},
{
  year: '2016',
  count: 12
},
{
  year: '2020',
  count: 15
}];

const topSections = [
{
  name: 'Розділ XII. Конституційний Суд',
  changes: 15
},
{
  name: 'Розділ V. Президент України',
  changes: 12
},
{
  name: 'Розділ VI. Кабінет Міністрів України',
  changes: 11
},
{
  name: 'Розділ IV. Верховна Рада України',
  changes: 9
},
{
  name: 'Розділ VIII. Правосуддя',
  changes: 8
}];

const changeTypes = [
{
  type: 'Редакційні правки',
  percentage: 35,
  color: 'from-blue-500 to-blue-600'
},
{
  type: 'Зміна повноважень',
  percentage: 28,
  color: 'from-green-500 to-green-600'
},
{
  type: 'Нові положення',
  percentage: 20,
  color: 'from-amber-500 to-amber-600'
},
{
  type: 'Виключення статей',
  percentage: 10,
  color: 'from-red-500 to-red-600'
},
{
  type: 'Перехідні положення',
  percentage: 7,
  color: 'from-purple-500 to-purple-600'
}];

const articleVersions = [
{
  version: 7,
  date: '01.01.2020',
  basis: '№ 27-IX від 03.09.2019',
  changes: 'додано пункти 28-33',
  text: 'До повноважень Верховної Ради України належить:\n1) внесення змін до Конституції України...\n2) призначення всеукраїнського референдуму...\n... (33 пункти)'
},
{
  version: 6,
  date: '02.06.2016',
  basis: '№ 1401-VIII від 02.06.2016',
  changes: 'редакційні правки в пунктах 12, 15, 23',
  text: 'До повноважень Верховної Ради України належить:\n... (27 пунктів)'
}];

export function HistoricalAnalysisPage({
  onBack
}: HistoricalAnalysisPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLaw, setSelectedLaw] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    'timeline' | 'statistics' | 'comparison' | 'article'>(
    'timeline');
  const [periodFilter, setPeriodFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [comparisonA, setComparisonA] = useState('33');
  const [comparisonB, setComparisonB] = useState('1');
  const [displayMode, setDisplayMode] = useState<'side-by-side' | 'unified'>(
    'side-by-side'
  );
  const [showAdded, setShowAdded] = useState(true);
  const [showDeleted, setShowDeleted] = useState(true);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [expandedVersions, setExpandedVersions] = useState<number[]>([7]);
  const maxChanges = Math.max(...yearlyChanges.map((y) => y.count));
  const toggleVersion = (version: number) => {
    setExpandedVersions((prev) =>
    prev.includes(version) ?
    prev.filter((v) => v !== version) :
    [...prev, version]
    );
  };
  if (selectedLaw) {
    return (
      <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Header */}
          <motion.div
            initial={{
              opacity: 0,
              y: 20
            }}
            animate={{
              opacity: 1,
              y: 0
            }}>

            <div className="flex items-center gap-4 mb-6">
              {onBack &&
              <button
                onClick={onBack}
                className="p-2 hover:bg-white rounded-lg transition-colors border border-claude-border">

                  <ArrowLeft size={20} className="text-claude-text" />
                </button>
              }
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <ScrollText size={32} className="text-claude-accent" />
                  <h1 className="text-2xl md:text-3xl font-sans text-claude-text font-medium">
                    Історія редакцій: Конституція України
                  </h1>
                </div>
                <p className="text-sm text-claude-subtext font-sans">
                  254к/96-ВР від 28.06.1996
                </p>
              </div>
            </div>

            {/* Tabs */}
            <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden mb-6">
              <div className="flex border-b border-claude-border overflow-x-auto">
                {[
                {
                  id: 'timeline',
                  label: 'Timeline',
                  icon: Clock
                },
                {
                  id: 'statistics',
                  label: 'Статистика',
                  icon: BarChart3
                },
                {
                  id: 'comparison',
                  label: 'Порівняння',
                  icon: RefreshCw
                },
                {
                  id: 'article',
                  label: 'Історія статті',
                  icon: ScrollText
                }].
                map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id as any)}
                      className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium font-sans transition-colors relative whitespace-nowrap ${activeTab === tab.id ? 'text-claude-accent bg-claude-accent/5' : 'text-claude-subtext hover:text-claude-text hover:bg-claude-bg'}`}>

                      <Icon size={16} />
                      {tab.label}
                      {activeTab === tab.id &&
                      <motion.div
                        layoutId="activeHistoricalTab"
                        className="absolute bottom-0 left-0 right-0 h-0.5 bg-claude-accent" />

                      }
                    </button>);

                })}
              </div>

              <div className="p-6">
                <AnimatePresence mode="wait">
                  {activeTab === 'timeline' &&
                  <motion.div
                    key="timeline"
                    initial={{
                      opacity: 0,
                      y: 10
                    }}
                    animate={{
                      opacity: 1,
                      y: 0
                    }}
                    exit={{
                      opacity: 0,
                      y: -10
                    }}
                    className="space-y-6">

                      {/* Stats */}
                      <div className="flex items-center justify-between p-4 bg-claude-bg rounded-xl border border-claude-border">
                        <div>
                          <p className="text-sm text-claude-subtext font-sans mb-1">
                            Всього редакцій:{' '}
                            <span className="font-medium text-claude-text">
                              33
                            </span>{' '}
                            (з 1996 по 2020 рік)
                          </p>
                          <p className="text-sm text-claude-subtext font-sans">
                            Остання зміна:{' '}
                            <span className="font-medium text-claude-text">
                              01.01.2020
                            </span>{' '}
                            (підстава: 27-IX)
                          </p>
                        </div>
                      </div>

                      {/* Filters */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                            Період
                          </label>
                          <select
                          value={periodFilter}
                          onChange={(e) => setPeriodFilter(e.target.value)}
                          className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                            <option value="all">Весь час</option>
                            <option value="recent">Останні 5 років</option>
                            <option value="decade">Остання декада</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                            Тип змін
                          </label>
                          <select
                          value={typeFilter}
                          onChange={(e) => setTypeFilter(e.target.value)}
                          className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                            <option value="all">Усі зміни</option>
                            <option value="major">Значні зміни</option>
                            <option value="editorial">Редакційні</option>
                          </select>
                        </div>
                      </div>

                      {/* Timeline Visualization */}
                      <div className="bg-claude-bg rounded-xl border border-claude-border p-6">
                        <h3 className="text-sm font-medium text-claude-text font-sans mb-4">
                          Timeline (інтерактивний)
                        </h3>
                        <div className="relative h-24 mb-8">
                          <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-claude-border"></div>
                          {[1996, 2000, 2004, 2010, 2014, 2020].map(
                          (year, index) =>
                          <motion.div
                            key={year}
                            initial={{
                              scale: 0
                            }}
                            animate={{
                              scale: 1
                            }}
                            transition={{
                              delay: index * 0.1
                            }}
                            className="absolute top-1/2 -translate-y-1/2 group cursor-pointer"
                            style={{
                              left: `${index / 5 * 100}%`
                            }}>

                                <div className="w-4 h-4 bg-claude-accent rounded-full border-2 border-white shadow-lg"></div>
                                <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2">
                                  <p className="text-xs text-claude-subtext font-sans whitespace-nowrap">
                                    {year}
                                  </p>
                                </div>
                                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <div className="bg-claude-text text-white px-3 py-2 rounded-lg text-xs font-sans whitespace-nowrap shadow-xl">
                                    <p className="font-medium">
                                      Редакція від{' '}
                                      {year === 1996 ? '28.06' : '01.01'}.{year}
                                    </p>
                                    <p className="text-white/80">
                                      Підстава:{' '}
                                      {year === 1996 ?
                                  'Оригінал' :
                                  `${Math.floor(Math.random() * 9000) + 1000}-${['IV', 'VII', 'VIII', 'IX'][Math.floor(Math.random() * 4)]}`}
                                    </p>
                                    <p className="text-white/80">
                                      Змінено:{' '}
                                      {year === 2004 ?
                                  47 :
                                  Math.floor(Math.random() * 20)}{' '}
                                      статей
                                    </p>
                                  </div>
                                </div>
                              </motion.div>

                        )}
                        </div>
                      </div>

                      {/* Revisions Table */}
                      <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
                        <div className="p-6 border-b border-claude-border">
                          <h3 className="text-lg font-sans text-claude-text font-medium">
                            Список редакцій
                          </h3>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full">
                            <thead className="bg-claude-bg border-b border-claude-border">
                              <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                  №
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                  Дата
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                  Підстава
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                  Зміни
                                </th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                  Дії
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-claude-border">
                              {revisions.map((revision, index) =>
                            <motion.tr
                              key={revision.id}
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
                              className="hover:bg-claude-bg transition-colors">

                                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-claude-text font-sans">
                                    {revision.id}
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-text font-sans">
                                    {revision.date}
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-text font-sans">
                                    {revision.basis}
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-subtext font-sans">
                                    {revision.changes}
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                    <div className="flex items-center justify-end gap-2">
                                      <button className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded transition-colors">
                                        <Eye size={16} />
                                      </button>
                                      <button className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded transition-colors">
                                        <Download size={16} />
                                      </button>
                                    </div>
                                  </td>
                                </motion.tr>
                            )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </motion.div>
                  }

                  {activeTab === 'statistics' &&
                  <motion.div
                    key="statistics"
                    initial={{
                      opacity: 0,
                      y: 10
                    }}
                    animate={{
                      opacity: 1,
                      y: 0
                    }}
                    exit={{
                      opacity: 0,
                      y: -10
                    }}
                    className="space-y-6">

                      {/* Yearly Changes Chart */}
                      <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
                        <div className="flex items-center gap-2 mb-6">
                          <TrendingUp
                          size={20}
                          className="text-claude-accent" />

                          <h3 className="text-lg font-sans text-claude-text font-medium">
                            Динаміка змін за роками
                          </h3>
                        </div>
                        <div className="h-64 flex items-end gap-4 px-4 mb-4">
                          {yearlyChanges.map((data, index) =>
                        <div
                          key={data.year}
                          className="flex-1 flex flex-col items-center gap-2">

                              <motion.div
                            initial={{
                              height: 0
                            }}
                            animate={{
                              height: `${data.count / maxChanges * 100}%`
                            }}
                            transition={{
                              duration: 0.5,
                              delay: index * 0.05
                            }}
                            className="w-full bg-claude-accent rounded-t hover:bg-[#C66345] transition-colors cursor-pointer relative group">

                                <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-claude-text text-white px-2 py-1 rounded text-xs font-sans opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                                  {data.count} змін
                                </div>
                              </motion.div>
                              <span className="text-xs text-claude-subtext font-sans">
                                {data.year}
                              </span>
                            </div>
                        )}
                        </div>
                        <p className="text-sm text-claude-subtext font-sans text-center">
                          Пік змін: 2004 рік (47 статей)
                        </p>
                      </div>

                      {/* Top Sections */}
                      <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
                        <h3 className="text-lg font-sans text-claude-text font-medium mb-4">
                          🎯 Найчастіше змінювані розділи
                        </h3>
                        <div className="space-y-3">
                          {topSections.map((section, index) =>
                        <motion.div
                          key={section.name}
                          initial={{
                            opacity: 0,
                            x: -20
                          }}
                          animate={{
                            opacity: 1,
                            x: 0
                          }}
                          transition={{
                            delay: index * 0.05
                          }}
                          className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">

                              <div className="flex items-center gap-3">
                                <div className="w-6 h-6 rounded-full bg-claude-accent text-white flex items-center justify-center text-xs font-bold font-sans">
                                  {index + 1}
                                </div>
                                <span className="text-sm text-claude-text font-sans">
                                  {section.name}
                                </span>
                              </div>
                              <span className="text-sm font-medium text-claude-accent font-sans">
                                {section.changes} змін
                              </span>
                            </motion.div>
                        )}
                        </div>
                      </div>

                      {/* Change Types */}
                      <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
                        <div className="flex items-center gap-2 mb-6">
                          <PieChartIcon
                          size={20}
                          className="text-claude-accent" />

                          <h3 className="text-lg font-sans text-claude-text font-medium">
                            Типи змін
                          </h3>
                        </div>
                        <div className="space-y-3">
                          {changeTypes.map((type, index) =>
                        <motion.div
                          key={type.type}
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
                          className="flex items-center justify-between">

                              <div className="flex items-center gap-3 flex-1">
                                <div
                              className={`w-4 h-4 rounded bg-gradient-to-br ${type.color}`}>
                            </div>
                                <span className="text-sm text-claude-text font-sans">
                                  {type.type}
                                </span>
                              </div>
                              <div className="flex items-center gap-3">
                                <div className="w-32 h-2 bg-claude-bg rounded-full overflow-hidden">
                                  <motion.div
                                initial={{
                                  width: 0
                                }}
                                animate={{
                                  width: `${type.percentage}%`
                                }}
                                transition={{
                                  duration: 0.8,
                                  delay: index * 0.05
                                }}
                                className={`h-full bg-gradient-to-r ${type.color}`} />

                                </div>
                                <span className="text-sm font-medium text-claude-text font-sans w-12 text-right">
                                  {type.percentage}%
                                </span>
                              </div>
                            </motion.div>
                        )}
                        </div>
                      </div>

                      {/* Frequency Stats */}
                      <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
                        <h3 className="text-lg font-sans text-claude-text font-medium mb-4">
                          ⏱️ Середня частота змін
                        </h3>
                        <div className="space-y-2 text-sm font-sans">
                          <p className="text-claude-text">
                            • 1996-2004:{' '}
                            <span className="font-medium">
                              1 зміна на 2.7 років
                            </span>
                          </p>
                          <p className="text-claude-text">
                            • 2004-2010:{' '}
                            <span className="font-medium">
                              1 зміна на 1.2 року
                            </span>
                          </p>
                          <p className="text-claude-text">
                            • 2010-2020:{' '}
                            <span className="font-medium">
                              1 зміна на 0.8 років
                            </span>
                          </p>
                        </div>
                      </div>

                      {/* Export Buttons */}
                      <div className="flex gap-3">
                        <button className="flex items-center gap-2 px-4 py-2 bg-claude-accent text-white rounded-xl text-sm font-medium font-sans hover:bg-[#C66345] transition-colors shadow-sm">
                          <Download size={16} />
                          Експорт звіту
                        </button>
                        <button className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border text-claude-text rounded-xl text-sm font-medium font-sans hover:bg-claude-bg transition-colors">
                          <Printer size={16} />
                          Друк
                        </button>
                      </div>
                    </motion.div>
                  }

                  {activeTab === 'comparison' &&
                  <motion.div
                    key="comparison"
                    initial={{
                      opacity: 0,
                      y: 10
                    }}
                    animate={{
                      opacity: 1,
                      y: 0
                    }}
                    exit={{
                      opacity: 0,
                      y: -10
                    }}
                    className="space-y-6">

                      {/* Comparison Controls */}
                      <div className="bg-claude-bg rounded-xl border border-claude-border p-6 space-y-4">
                        <h3 className="text-base font-sans text-claude-text font-medium mb-4">
                          Оберіть редакції для порівняння
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                              Редакція А
                            </label>
                            <select
                            value={comparisonA}
                            onChange={(e) => setComparisonA(e.target.value)}
                            className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                              <option value="33">01.01.2020 (№33)</option>
                              <option value="32">03.09.2019 (№32)</option>
                              <option value="31">07.02.2019 (№31)</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                              Редакція Б
                            </label>
                            <select
                            value={comparisonB}
                            onChange={(e) => setComparisonB(e.target.value)}
                            className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                              <option value="1">28.06.1996 (Оригінал)</option>
                              <option value="30">21.02.2014 (№30)</option>
                            </select>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div>
                            <p className="text-sm font-medium text-claude-text font-sans mb-2">
                              Режим відображення
                            </p>
                            <div className="flex gap-4">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                type="radio"
                                checked={displayMode === 'side-by-side'}
                                onChange={() =>
                                setDisplayMode('side-by-side')
                                }
                                className="w-4 h-4 text-claude-accent focus:ring-claude-accent" />

                                <span className="text-sm text-claude-text font-sans">
                                  Side-by-side
                                </span>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                type="radio"
                                checked={displayMode === 'unified'}
                                onChange={() => setDisplayMode('unified')}
                                className="w-4 h-4 text-claude-accent focus:ring-claude-accent" />

                                <span className="text-sm text-claude-text font-sans">
                                  Unified
                                </span>
                              </label>
                            </div>
                          </div>

                          <div>
                            <p className="text-sm font-medium text-claude-text font-sans mb-2">
                              Показати
                            </p>
                            <div className="flex gap-4">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                type="checkbox"
                                checked={showAdded}
                                onChange={(e) =>
                                setShowAdded(e.target.checked)
                                }
                                className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent" />

                                <span className="text-sm text-claude-text font-sans">
                                  Додане
                                </span>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                type="checkbox"
                                checked={showDeleted}
                                onChange={(e) =>
                                setShowDeleted(e.target.checked)
                                }
                                className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent" />

                                <span className="text-sm text-claude-text font-sans">
                                  Видалене
                                </span>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                type="checkbox"
                                checked={showUnchanged}
                                onChange={(e) =>
                                setShowUnchanged(e.target.checked)
                                }
                                className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent" />

                                <span className="text-sm text-claude-text font-sans">
                                  Без змін
                                </span>
                              </label>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Comparison Stats */}
                      <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
                        <h3 className="text-lg font-sans text-claude-text font-medium mb-4">
                          Загальна статистика
                        </h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div className="p-4 bg-claude-bg rounded-xl">
                            <p className="text-xs text-claude-subtext font-sans mb-1">
                              Змінено статей
                            </p>
                            <p className="text-2xl font-serif font-bold text-claude-text">
                              89{' '}
                              <span className="text-sm text-claude-subtext">
                                / 161
                              </span>
                            </p>
                            <p className="text-xs text-claude-subtext font-sans">
                              (55%)
                            </p>
                          </div>
                          <div className="p-4 bg-green-50 rounded-xl border border-green-200">
                            <p className="text-xs text-green-700 font-sans mb-1">
                              Додано
                            </p>
                            <p className="text-2xl font-serif font-bold text-green-700">
                              12
                            </p>
                          </div>
                          <div className="p-4 bg-red-50 rounded-xl border border-red-200">
                            <p className="text-xs text-red-700 font-sans mb-1">
                              Виключено
                            </p>
                            <p className="text-2xl font-serif font-bold text-red-700">
                              3
                            </p>
                          </div>
                          <div className="p-4 bg-gray-50 rounded-xl border border-gray-200">
                            <p className="text-xs text-gray-700 font-sans mb-1">
                              Без змін
                            </p>
                            <p className="text-2xl font-serif font-bold text-gray-700">
                              60
                            </p>
                            <p className="text-xs text-gray-600 font-sans">
                              (37%)
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Side-by-side Comparison */}
                      {displayMode === 'side-by-side' &&
                    <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
                          <div className="grid grid-cols-2 divide-x divide-claude-border">
                            <div className="p-6">
                              <h4 className="text-sm font-medium text-claude-text font-sans mb-4">
                                01.01.2020 (Редакція)
                              </h4>
                              <div className="space-y-4 text-sm font-sans">
                                <div className="p-3 bg-green-50 border-l-4 border-green-500 rounded">
                                  <p className="text-green-900">
                                    Стаття 1. Україна є суверенна і незалежна
                                    демократична, соціальна, правова держава.
                                  </p>
                                </div>
                                <div className="p-3 bg-amber-50 border-l-4 border-amber-500 rounded">
                                  <p className="text-amber-900">
                                    Стаття 5. Носієм суверенітету і єдиним
                                    джерелом влади в Україні є народ. Народ
                                    здійснює владу безпосередньо і через органи
                                    державної влади та органи місцевого
                                    самоврядування.
                                  </p>
                                </div>
                              </div>
                            </div>
                            <div className="p-6">
                              <h4 className="text-sm font-medium text-claude-text font-sans mb-4">
                                28.06.1996 (Оригінал)
                              </h4>
                              <div className="space-y-4 text-sm font-sans">
                                <div className="p-3 bg-gray-50 border-l-4 border-gray-300 rounded">
                                  <p className="text-gray-700">
                                    Стаття 1. Україна є суверенна і незалежна,
                                    демократична, соціальна, правова держава.
                                  </p>
                                </div>
                                <div className="p-3 bg-gray-50 border-l-4 border-gray-300 rounded">
                                  <p className="text-gray-700">
                                    Стаття 5. Носієм суверенітету і єдиним
                                    джерелом влади в Україні є народ. Народ
                                    здійснює владу безпосередньо і через органи
                                    державної влади та органи місцевого
                                    самоврядування.
                                  </p>
                                  <p className="text-gray-700 mt-2">
                                    Право визначати і змінювати конституційний
                                    лад в Україні належить виключно народу і не
                                    може бути узурповане державою.
                                  </p>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="p-4 bg-claude-bg border-t border-claude-border flex items-center justify-between">
                            <div className="flex items-center gap-4 text-xs font-sans">
                              <div className="flex items-center gap-2">
                                <div className="w-3 h-3 bg-green-500 rounded"></div>
                                <span className="text-claude-subtext">
                                  Додано
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-3 h-3 bg-red-500 rounded"></div>
                                <span className="text-claude-subtext">
                                  Видалено
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-3 h-3 bg-amber-500 rounded"></div>
                                <span className="text-claude-subtext">
                                  Змінено
                                </span>
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button className="px-3 py-1.5 text-xs font-medium font-sans text-claude-text hover:bg-white rounded-lg transition-colors">
                                ▲ Попередня зміна
                              </button>
                              <button className="px-3 py-1.5 text-xs font-medium font-sans text-claude-text hover:bg-white rounded-lg transition-colors">
                                ▼ Наступна зміна
                              </button>
                            </div>
                          </div>
                        </div>
                    }
                    </motion.div>
                  }

                  {activeTab === 'article' &&
                  <motion.div
                    key="article"
                    initial={{
                      opacity: 0,
                      y: 10
                    }}
                    animate={{
                      opacity: 1,
                      y: 0
                    }}
                    exit={{
                      opacity: 0,
                      y: -10
                    }}
                    className="space-y-6">

                      <div className="bg-claude-bg rounded-xl border border-claude-border p-4">
                        <p className="text-sm text-claude-subtext font-sans">
                          Ця стаття змінювалася{' '}
                          <span className="font-medium text-claude-text">
                            7 разів
                          </span>{' '}
                          з 1996 по 2020 рік
                        </p>
                      </div>

                      {/* Article Timeline */}
                      <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
                        <div className="relative h-16 mb-8">
                          <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-claude-border"></div>
                          {[1996, 2004, 2006, 2010, 2014, 2016, 2019, 2020].map(
                          (year, index) =>
                          <div
                            key={year}
                            className="absolute top-1/2 -translate-y-1/2"
                            style={{
                              left: `${index / 7 * 100}%`
                            }}>

                                <div className="w-3 h-3 bg-claude-accent rounded-full border-2 border-white"></div>
                                <p className="absolute top-full mt-2 left-1/2 -translate-x-1/2 text-xs text-claude-subtext font-sans whitespace-nowrap">
                                  {year}
                                </p>
                              </div>

                        )}
                        </div>
                      </div>

                      {/* Version List */}
                      <div className="space-y-4">
                        {articleVersions.map((version) =>
                      <div
                        key={version.version}
                        className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">

                            <button
                          onClick={() => toggleVersion(version.version)}
                          className="w-full p-6 text-left hover:bg-claude-bg transition-colors">

                              <div className="flex items-center justify-between">
                                <div>
                                  <h4 className="text-base font-serif font-medium text-claude-text mb-1">
                                    Версія {version.version}{' '}
                                    {version.version === 7 && '(поточна)'}: від{' '}
                                    {version.date}
                                  </h4>
                                  <p className="text-sm text-claude-subtext font-sans">
                                    Підстава: {version.basis} • Зміни:{' '}
                                    {version.changes}
                                  </p>
                                </div>
                                {expandedVersions.includes(version.version) ?
                            <ChevronUp
                              size={20}
                              className="text-claude-subtext" /> :


                            <ChevronDown
                              size={20}
                              className="text-claude-subtext" />

                            }
                              </div>
                            </button>
                            <AnimatePresence>
                              {expandedVersions.includes(version.version) &&
                          <motion.div
                            initial={{
                              height: 0,
                              opacity: 0
                            }}
                            animate={{
                              height: 'auto',
                              opacity: 1
                            }}
                            exit={{
                              height: 0,
                              opacity: 0
                            }}
                            className="overflow-hidden">

                                  <div className="p-6 pt-0 border-t border-claude-border">
                                    <pre className="text-sm text-claude-text font-sans whitespace-pre-wrap bg-claude-bg p-4 rounded-lg">
                                      {version.text}
                                    </pre>
                                  </div>
                                </motion.div>
                          }
                            </AnimatePresence>
                          </div>
                      )}
                      </div>

                      <div className="flex gap-3">
                        <button className="px-4 py-2 bg-claude-accent text-white rounded-xl text-sm font-medium font-sans hover:bg-[#C66345] transition-colors shadow-sm">
                          Показати всі версії
                        </button>
                        <button className="px-4 py-2 bg-white border border-claude-border text-claude-text rounded-xl text-sm font-medium font-sans hover:bg-claude-bg transition-colors">
                          🔄 Порівняти версії
                        </button>
                      </div>
                    </motion.div>
                  }
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        </div>
      </div>);

  }
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
                <BookOpen size={32} className="text-claude-accent" />
                <h1 className="text-3xl md:text-4xl font-sans text-claude-text font-medium tracking-tight">
                  Історичний аналіз законодавства України
                </h1>
              </div>
              <p className="text-claude-subtext font-sans text-sm">
                Відстеження еволюції законів та кодексів
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>);

}