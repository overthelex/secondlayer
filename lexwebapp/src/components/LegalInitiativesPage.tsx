import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Scale,
  Gavel,
  Briefcase,
  DollarSign,
  Building,
  Landmark,
  TreePine,
  Leaf,
  TrendingUp,
  Users,
  Tag,
  ArrowLeft,
  ChevronDown,
  Target } from
'lucide-react';
interface LegalArea {
  id: string;
  name: string;
  icon: any;
  count: number;
  color: string;
}
interface Initiative {
  id: string;
  number: string;
  title: string;
  initiator: string;
  date: string;
  status: 'registered' | 'committee' | 'ready' | 'approved' | 'rejected';
}
interface LegalInitiativesPageProps {
  onBack?: () => void;
}
const legalAreas: LegalArea[] = [
{
  id: 'civil',
  name: 'Цивільне право',
  icon: Scale,
  count: 234,
  color: 'from-blue-500 to-blue-600'
},
{
  id: 'criminal',
  name: 'Кримінальне право',
  icon: Gavel,
  count: 156,
  color: 'from-red-500 to-red-600'
},
{
  id: 'labor',
  name: 'Трудове право',
  icon: Briefcase,
  count: 89,
  color: 'from-green-500 to-green-600'
},
{
  id: 'tax',
  name: 'Податкове право',
  icon: DollarSign,
  count: 67,
  color: 'from-amber-500 to-amber-600'
},
{
  id: 'administrative',
  name: 'Адміністративне право',
  icon: Building,
  count: 123,
  color: 'from-purple-500 to-purple-600'
},
{
  id: 'economic',
  name: 'Господарське право',
  icon: Landmark,
  count: 98,
  color: 'from-indigo-500 to-indigo-600'
},
{
  id: 'land',
  name: 'Земельне право',
  icon: TreePine,
  count: 45,
  color: 'from-emerald-500 to-emerald-600'
},
{
  id: 'environmental',
  name: 'Екологічне право',
  icon: Leaf,
  count: 34,
  color: 'from-teal-500 to-teal-600'
}];

const mockInitiatives: Initiative[] = [
{
  id: '1',
  number: '8234-IX',
  title:
  'Про внесення змін до Цивільного кодексу України щодо договірних відносин',
  initiator: 'Іванов І.І.',
  date: '15.01.2026',
  status: 'committee'
},
{
  id: '2',
  number: '8156-IX',
  title: 'Про договори купівлі-продажу нерухомості',
  initiator: 'КабМін',
  date: '10.01.2026',
  status: 'ready'
},
{
  id: '3',
  number: '8089-IX',
  title: 'Про спадкування за заповітом',
  initiator: 'Петренко П.П.',
  date: '05.01.2026',
  status: 'registered'
},
{
  id: '4',
  number: '7945-IX',
  title: 'Про право власності на землю',
  initiator: 'Комітет з правової політики',
  date: '28.12.2025',
  status: 'approved'
},
{
  id: '5',
  number: '7823-IX',
  title: 'Про позовну давність у цивільних справах',
  initiator: 'Сидоренко С.С.',
  date: '20.12.2025',
  status: 'rejected'
}];

const statusConfig = {
  registered: {
    label: 'Зареєстровано',
    color: 'bg-gray-100 text-gray-700 border-gray-200',
    icon: '⚪'
  },
  committee: {
    label: 'У комітеті',
    color: 'bg-amber-100 text-amber-700 border-amber-200',
    icon: '🟡'
  },
  ready: {
    label: 'Готовий',
    color: 'bg-blue-100 text-blue-700 border-blue-200',
    icon: '🔵'
  },
  approved: {
    label: 'Прийнято',
    color: 'bg-green-100 text-green-700 border-green-200',
    icon: '🟢'
  },
  rejected: {
    label: 'Відхилено',
    color: 'bg-red-100 text-red-700 border-red-200',
    icon: '🔴'
  }
};
const topInitiators = [
{
  name: 'Іванов І.І.',
  count: 23
},
{
  name: 'Петренко П.П.',
  count: 18
},
{
  name: 'Комітет з правової політики',
  count: 15
},
{
  name: 'Сидоренко С.С.',
  count: 12
},
{
  name: 'КабМін України',
  count: 10
}];

const popularTags = [
{
  text: 'Договори',
  size: 24
},
{
  text: 'Спадкування',
  size: 20
},
{
  text: 'Власність',
  size: 22
},
{
  text: "Зобов'язання",
  size: 18
},
{
  text: 'Право власності',
  size: 16
},
{
  text: 'ЦПК',
  size: 14
},
{
  text: 'Позовна давність',
  size: 15
}];

const monthlyData = [
{
  month: 'Січ 25',
  registered: 18,
  approved: 3
},
{
  month: 'Лют 25',
  registered: 22,
  approved: 5
},
{
  month: 'Бер 25',
  registered: 15,
  approved: 4
},
{
  month: 'Квіт 25',
  registered: 25,
  approved: 6
},
{
  month: 'Трав 25',
  registered: 19,
  approved: 4
},
{
  month: 'Черв 25',
  registered: 21,
  approved: 5
},
{
  month: 'Лип 25',
  registered: 17,
  approved: 3
},
{
  month: 'Серп 25',
  registered: 16,
  approved: 2
},
{
  month: 'Вер 25',
  registered: 20,
  approved: 4
},
{
  month: 'Жовт 25',
  registered: 23,
  approved: 5
},
{
  month: 'Лист 25',
  registered: 14,
  approved: 3
},
{
  month: 'Груд 25',
  registered: 11,
  approved: 2
},
{
  month: 'Січ 26',
  registered: 23,
  approved: 0
}];

export function LegalInitiativesPage({ onBack }: LegalInitiativesPageProps) {
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [period, setPeriod] = useState('all');
  const [status, setStatus] = useState('all');
  const [groupBy, setGroupBy] = useState('none');
  const [sortBy, setSortBy] = useState('date-desc');
  const maxCount = Math.max(
    ...monthlyData.map((d) => Math.max(d.registered, d.approved))
  );
  if (selectedArea) {
    const area = legalAreas.find((a) => a.id === selectedArea);
    const AreaIcon = area?.icon;
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
            }}>

            <div className="flex items-center gap-4 mb-6">
              <button
                onClick={() => setSelectedArea(null)}
                className="p-2 hover:bg-white rounded-lg transition-colors border border-claude-border">

                <ArrowLeft size={20} className="text-claude-text" />
              </button>
              <div className="flex items-center gap-3">
                {AreaIcon &&
                <div
                  className={`w-12 h-12 rounded-xl bg-gradient-to-br ${area?.color} flex items-center justify-center text-white shadow-lg`}>

                    <AreaIcon size={24} />
                  </div>
                }
                <div>
                  <h1 className="text-3xl font-serif text-claude-text font-medium">
                    {area?.name}
                  </h1>
                  <p className="text-sm text-claude-subtext font-sans">
                    Законодавчі ініціативи
                  </p>
                </div>
              </div>
            </div>

            {/* Statistics */}
            <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 mb-6">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp size={20} className="text-claude-accent" />
                <h3 className="text-lg font-serif text-claude-text font-medium">
                  Статистика
                </h3>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-claude-bg rounded-xl border border-claude-border">
                  <p className="text-xs text-claude-subtext font-sans mb-1">
                    Всього ініціатив
                  </p>
                  <p className="text-2xl font-serif font-bold text-claude-text">
                    234
                  </p>
                </div>
                <div className="p-4 bg-blue-50 rounded-xl border border-blue-200">
                  <p className="text-xs text-blue-700 font-sans mb-1">
                    Зареєстровано у 2026
                  </p>
                  <p className="text-2xl font-serif font-bold text-blue-700">
                    23
                  </p>
                </div>
                <div className="p-4 bg-amber-50 rounded-xl border border-amber-200">
                  <p className="text-xs text-amber-700 font-sans mb-1">
                    На розгляді
                  </p>
                  <p className="text-2xl font-serif font-bold text-amber-700">
                    156
                  </p>
                </div>
                <div className="p-4 bg-green-50 rounded-xl border border-green-200">
                  <p className="text-xs text-green-700 font-sans mb-1">
                    Прийнято у 2026
                  </p>
                  <p className="text-2xl font-serif font-bold text-green-700">
                    12
                  </p>
                </div>
              </div>
            </div>

            {/* Chart */}
            <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 mb-6">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp size={20} className="text-claude-accent" />
                <h3 className="text-lg font-serif text-claude-text font-medium">
                  Динаміка по місяцях (2025-2026)
                </h3>
              </div>
              <div className="h-64 flex items-end gap-1 px-4">
                {monthlyData.map((data, index) =>
                <div
                  key={data.month}
                  className="flex-1 flex flex-col items-center gap-2">

                    <div
                    className="w-full flex gap-1 items-end"
                    style={{
                      height: '100%'
                    }}>

                      <motion.div
                      initial={{
                        height: 0
                      }}
                      animate={{
                        height: `${data.registered / maxCount * 100}%`
                      }}
                      transition={{
                        duration: 0.5,
                        delay: index * 0.03
                      }}
                      className="flex-1 bg-blue-500 rounded-t hover:bg-blue-600 transition-colors cursor-pointer relative group">

                        <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-claude-text text-white px-2 py-1 rounded text-xs font-sans opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                          Зареєстр: {data.registered}
                        </div>
                      </motion.div>
                      <motion.div
                      initial={{
                        height: 0
                      }}
                      animate={{
                        height: `${data.approved / maxCount * 100}%`
                      }}
                      transition={{
                        duration: 0.5,
                        delay: index * 0.03 + 0.1
                      }}
                      className="flex-1 bg-green-500 rounded-t hover:bg-green-600 transition-colors cursor-pointer relative group">

                        <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-claude-text text-white px-2 py-1 rounded text-xs font-sans opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                          Прийнято: {data.approved}
                        </div>
                      </motion.div>
                    </div>
                    <span className="text-[10px] text-claude-subtext font-sans whitespace-nowrap">
                      {data.month}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-center gap-6 mt-4 pt-4 border-t border-claude-border">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 bg-blue-500 rounded"></div>
                  <span className="text-xs text-claude-subtext font-sans">
                    Зареєстровано
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 bg-green-500 rounded"></div>
                  <span className="text-xs text-claude-subtext font-sans">
                    Прийнято
                  </span>
                </div>
              </div>
            </div>

            {/* Tag Cloud */}
            <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 mb-6">
              <div className="flex items-center gap-2 mb-4">
                <Tag size={20} className="text-claude-accent" />
                <h3 className="text-lg font-serif text-claude-text font-medium">
                  Популярні теми
                </h3>
              </div>
              <div className="flex flex-wrap gap-3 justify-center py-4">
                {popularTags.map((tag, index) =>
                <motion.button
                  key={tag.text}
                  initial={{
                    opacity: 0,
                    scale: 0.8
                  }}
                  animate={{
                    opacity: 1,
                    scale: 1
                  }}
                  transition={{
                    delay: index * 0.05
                  }}
                  className="px-4 py-2 bg-claude-bg hover:bg-claude-accent hover:text-white border border-claude-border hover:border-claude-accent rounded-xl transition-all font-sans font-medium"
                  style={{
                    fontSize: `${tag.size}px`
                  }}>

                    {tag.text}
                  </motion.button>
                )}
              </div>
            </div>

            {/* Top Initiators */}
            <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 mb-6">
              <div className="flex items-center gap-2 mb-4">
                <Users size={20} className="text-claude-accent" />
                <h3 className="text-lg font-serif text-claude-text font-medium">
                  Найактивніші ініціатори
                </h3>
              </div>
              <div className="space-y-3">
                {topInitiators.map((initiator, index) =>
                <motion.div
                  key={initiator.name}
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
                  className="flex items-center gap-4 p-3 bg-claude-bg rounded-xl border border-claude-border hover:border-claude-accent transition-colors cursor-pointer">

                    <div className="w-8 h-8 rounded-full bg-claude-accent text-white flex items-center justify-center font-serif font-bold text-sm">
                      {index + 1}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-claude-text font-sans">
                        {initiator.name}
                      </p>
                    </div>
                    <div className="text-sm font-medium text-claude-accent font-sans">
                      {initiator.count} ініціатив
                    </div>
                  </motion.div>
                )}
              </div>
            </div>
          </motion.div>

          {/* Initiatives Table */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
            <div className="p-6 border-b border-claude-border">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-serif text-claude-text font-medium">
                  Ініціативи
                </h3>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-claude-subtext font-sans">
                      Групування:
                    </span>
                    <select
                      value={groupBy}
                      onChange={(e) => setGroupBy(e.target.value)}
                      className="px-3 py-1.5 bg-white border border-claude-border rounded-lg text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                      <option value="none">Без групування</option>
                      <option value="status">За статусом</option>
                      <option value="initiator">За ініціатором</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-claude-subtext font-sans">
                      Сортування:
                    </span>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="px-3 py-1.5 bg-white border border-claude-border rounded-lg text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                      <option value="date-desc">Дата (спадання)</option>
                      <option value="date-asc">Дата (зростання)</option>
                      <option value="number">Номер</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-claude-bg border-b border-claude-border">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                      №
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                      Номер
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                      Назва
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                      Ініціатор
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                      Дата
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                      Статус
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-claude-border">
                  {mockInitiatives.map((initiative, index) =>
                  <motion.tr
                    key={initiative.id}
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
                    className="hover:bg-claude-bg transition-colors cursor-pointer">

                      <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-subtext font-sans">
                        {index + 1}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-text font-sans font-medium">
                        {initiative.number}
                      </td>
                      <td className="px-6 py-4 text-sm text-claude-text font-sans">
                        <div
                        className="max-w-md truncate"
                        title={initiative.title}>

                          {initiative.title}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-text font-sans">
                        {initiative.initiator}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-subtext font-sans">
                        {initiative.date}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border ${statusConfig[initiative.status].color}`}>

                          {statusConfig[initiative.status].icon}{' '}
                          {statusConfig[initiative.status].label}
                        </span>
                      </td>
                    </motion.tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
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
                <Target size={32} className="text-claude-accent" />
                <h1 className="text-3xl md:text-4xl font-sans text-claude-text font-medium tracking-tight">
                  Моніторинг законодавчих ініціатив
                </h1>
              </div>
              <p className="text-claude-subtext font-sans text-sm">
                Оберіть сферу права для детального аналізу
              </p>
            </div>
          </div>

          {/* Top Initiators */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <Users size={20} className="text-claude-accent" />
              <h3 className="text-lg font-sans text-claude-text font-medium">
                Найактивніші ініціатори
              </h3>
            </div>
            <div className="space-y-3">
              {topInitiators.map((initiator, index) =>
              <motion.div
                key={initiator.name}
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
                className="flex items-center gap-4 p-3 bg-claude-bg rounded-xl border border-claude-border hover:border-claude-accent transition-colors cursor-pointer">

                  <div className="w-8 h-8 rounded-full bg-claude-accent text-white flex items-center justify-center font-serif font-bold text-sm">
                    {index + 1}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-claude-text font-sans">
                      {initiator.name}
                    </p>
                  </div>
                  <div className="text-sm font-medium text-claude-accent font-sans">
                    {initiator.count} ініціатив
                  </div>
                </motion.div>
              )}
            </div>
          </div>

          {/* Legal Areas Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {legalAreas.map((area, index) => {
              const AreaIcon = area.icon;
              return (
                <motion.button
                  key={area.id}
                  initial={{
                    opacity: 0,
                    scale: 0.9
                  }}
                  animate={{
                    opacity: 1,
                    scale: 1
                  }}
                  transition={{
                    delay: index * 0.05
                  }}
                  onClick={() => setSelectedArea(area.id)}
                  className="group relative overflow-hidden bg-white rounded-2xl border-2 border-claude-border hover:border-transparent hover:shadow-xl transition-all p-6 text-left">

                  <div
                    className={`absolute inset-0 bg-gradient-to-br ${area.color} opacity-0 group-hover:opacity-100 transition-opacity`} />

                  <div className="relative z-10">
                    <div className="w-12 h-12 rounded-xl bg-claude-bg group-hover:bg-white/20 flex items-center justify-center mb-4 transition-colors">
                      <AreaIcon
                        size={24}
                        className="text-claude-text group-hover:text-white transition-colors" />

                    </div>
                    <h3 className="text-base font-serif font-medium text-claude-text group-hover:text-white mb-2 transition-colors">
                      {area.name}
                    </h3>
                    <p className="text-2xl font-serif font-bold text-claude-accent group-hover:text-white transition-colors">
                      {area.count}
                    </p>
                    <p className="text-xs text-claude-subtext group-hover:text-white/80 font-sans transition-colors">
                      активних ініціатив
                    </p>
                  </div>
                </motion.button>);

            })}
          </div>

          {/* Filters */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
            <h3 className="text-sm font-medium text-claude-text font-sans mb-4">
              Додаткові фільтри
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                  Період
                </label>
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                  <option value="all">Всі дати</option>
                  <option value="month">Останній місяць</option>
                  <option value="3months">Останні 3 місяці</option>
                  <option value="6months">Останні 6 місяців</option>
                  <option value="year">Останній рік</option>
                  <option value="session">Поточне скликання</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                  Статус
                </label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                  <option value="all">Всі статуси</option>
                  <option value="registered">Зареєстровано</option>
                  <option value="committee">На розгляді в комітеті</option>
                  <option value="ready">Готовий до 2-го читання</option>
                  <option value="approved">Прийнято</option>
                  <option value="rejected">Відхилено</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                  Комітет
                </label>
                <select className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">
                  <option>Всі комітети</option>
                  <option>Комітет з правової політики</option>
                  <option>Комітет з питань бюджету</option>
                  <option>Комітет з питань економічного розвитку</option>
                </select>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>);

}