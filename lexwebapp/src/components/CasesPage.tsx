import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Briefcase,
  Plus,
  Filter,
  Calendar,
  User,
  Scale,
  MoreVertical,
  Trash2,
  Edit,
  Eye,
  X,
  LayoutGrid,
  List,
  Send,
  ChevronDown } from
'lucide-react';
interface Case {
  id: string;
  number: string;
  title: string;
  client: string;
  judge: string;
  status: 'active' | 'pending' | 'closed' | 'appeal';
  category: string;
  nextHearing: string;
  createdDate: string;
  court: string;
}
const casesData: Case[] = [
{
  id: '1',
  number: 'А40-12345/2024',
  title: 'Взыскание задолженности по договору поставки',
  client: 'Александров Игорь Петрович',
  judge: 'Иванов Петр Сергеевич',
  status: 'active',
  category: 'Арбитражный спор',
  nextHearing: '2024-02-15',
  createdDate: '2024-01-10',
  court: 'Арбитражный суд г. Москвы'
},
{
  id: '2',
  number: 'А40-23456/2024',
  title: 'Оспаривание решения налогового органа',
  client: 'Григорьев Андрей Владимирович',
  judge: 'Петрова Анна Викторовна',
  status: 'pending',
  category: 'Налоговый спор',
  nextHearing: '2024-02-20',
  createdDate: '2024-01-15',
  court: 'Арбитражный суд г. Москвы'
},
{
  id: '3',
  number: 'А40-34567/2023',
  title: 'Признание сделки недействительной',
  client: 'Белова Мария Сергеевна',
  judge: 'Сидоров Михаил Александрович',
  status: 'closed',
  category: 'Корпоративный спор',
  nextHearing: '2024-01-05',
  createdDate: '2023-11-20',
  court: 'Арбитражный суд г. Москвы'
},
{
  id: '4',
  number: 'А40-45678/2024',
  title: 'Взыскание убытков',
  client: 'Ковалев Сергей Александрович',
  judge: 'Кузнецова Елена Дмитриевна',
  status: 'appeal',
  category: 'Гражданское дело',
  nextHearing: '2024-03-01',
  createdDate: '2024-01-05',
  court: 'Девятый арбитражный апелляционный суд'
},
{
  id: '5',
  number: 'А40-56789/2024',
  title: 'Защита деловой репутации',
  client: 'Григорьев Андрей Владимирович',
  judge: 'Иванов Петр Сергеевич',
  status: 'active',
  category: 'Гражданское дело',
  nextHearing: '2024-02-18',
  createdDate: '2024-01-12',
  court: 'Арбитражный суд г. Москвы'
},
{
  id: '6',
  number: 'А40-67890/2024',
  title: 'Взыскание неустойки по договору подряда',
  client: 'Александров Игорь Петрович',
  judge: 'Петрова Анна Викторовна',
  status: 'active',
  category: 'Строительные споры',
  nextHearing: '2024-02-22',
  createdDate: '2024-01-18',
  court: 'Арбитражный суд г. Москвы'
},
{
  id: '7',
  number: 'А40-78901/2024',
  title: 'Признание права собственности',
  client: 'Белова Мария Сергеевна',
  judge: 'Сидоров Михаил Александрович',
  status: 'pending',
  category: 'Недвижимость',
  nextHearing: '2024-02-25',
  createdDate: '2024-01-20',
  court: 'Арбитражный суд Московской области'
},
{
  id: '8',
  number: 'А40-89012/2023',
  title: 'Банкротство физического лица',
  client: 'Дмитриева Елена Николаевна',
  judge: 'Кузнецова Елена Дмитриевна',
  status: 'closed',
  category: 'Банкротство',
  nextHearing: '2023-12-15',
  createdDate: '2023-10-05',
  court: 'Арбитражный суд г. Москвы'
},
{
  id: '9',
  number: 'А40-90123/2024',
  title: 'Взыскание задолженности по кредитному договору',
  client: 'Ковалев Сергей Александрович',
  judge: 'Иванов Петр Сергеевич',
  status: 'active',
  category: 'Кредитные споры',
  nextHearing: '2024-02-28',
  createdDate: '2024-01-22',
  court: 'Арбитражный суд г. Москвы'
},
{
  id: '10',
  number: 'А40-01234/2024',
  title: 'Оспаривание сделки купли-продажи',
  client: 'Григорьев Андрей Владимирович',
  judge: 'Петрова Анна Викторовна',
  status: 'pending',
  category: 'Корпоративный спор',
  nextHearing: '2024-03-05',
  createdDate: '2024-01-25',
  court: 'Арбитражный суд г. Москвы'
},
{
  id: '11',
  number: 'А40-11111/2024',
  title: 'Защита прав потребителей',
  client: 'Белова Мария Сергеевна',
  judge: 'Сидоров Михаил Александрович',
  status: 'active',
  category: 'Потребительские споры',
  nextHearing: '2024-03-08',
  createdDate: '2024-01-28',
  court: 'Районный суд'
},
{
  id: '12',
  number: 'А40-22222/2023',
  title: 'Трудовой спор о восстановлении на работе',
  client: 'Александров Игорь Петрович',
  judge: 'Кузнецова Елена Дмитриевна',
  status: 'closed',
  category: 'Трудовые споры',
  nextHearing: '2023-12-20',
  createdDate: '2023-11-01',
  court: 'Районный суд'
},
{
  id: '13',
  number: 'А40-33333/2024',
  title: 'Взыскание компенсации морального вреда',
  client: 'Ковалев Сергей Александрович',
  judge: 'Иванов Петр Сергеевич',
  status: 'appeal',
  category: 'Гражданское дело',
  nextHearing: '2024-03-12',
  createdDate: '2024-01-30',
  court: 'Девятый арбитражный апелляционный суд'
},
{
  id: '14',
  number: 'А40-44444/2024',
  title: 'Раздел совместно нажитого имущества',
  client: 'Дмитриева Елена Николаевна',
  judge: 'Петрова Анна Викторовна',
  status: 'pending',
  category: 'Семейные споры',
  nextHearing: '2024-03-15',
  createdDate: '2024-02-01',
  court: 'Районный суд'
},
{
  id: '15',
  number: 'А40-55555/2024',
  title: 'Признание договора незаключенным',
  client: 'Григорьев Андрей Владимирович',
  judge: 'Сидоров Михаил Александрович',
  status: 'active',
  category: 'Корпоративный спор',
  nextHearing: '2024-03-18',
  createdDate: '2024-02-03',
  court: 'Арбитражный суд г. Москвы'
},
{
  id: '16',
  number: 'А40-66666/2024',
  title: 'Взыскание платы за коммунальные услуги',
  client: 'Белова Мария Сергеевна',
  judge: 'Кузнецова Елена Дмитриевна',
  status: 'active',
  category: 'ЖКХ споры',
  nextHearing: '2024-03-20',
  createdDate: '2024-02-05',
  court: 'Районный суд'
},
{
  id: '17',
  number: 'А40-77777/2024',
  title: 'Оспаривание кадастровой стоимости',
  client: 'Александров Игорь Петрович',
  judge: 'Иванов Петр Сергеевич',
  status: 'pending',
  category: 'Недвижимость',
  nextHearing: '2024-03-22',
  createdDate: '2024-02-07',
  court: 'Арбитражный суд Московской области'
},
{
  id: '18',
  number: 'А40-88888/2023',
  title: 'Ликвидация юридического лица',
  client: 'Ковалев Сергей Александрович',
  judge: 'Петрова Анна Викторовна',
  status: 'closed',
  category: 'Корпоративный спор',
  nextHearing: '2023-12-28',
  createdDate: '2023-11-15',
  court: 'Арбитражный суд г. Москвы'
}];

const statusConfig = {
  active: {
    label: 'Активное',
    color: 'bg-green-100 text-green-700 border-green-200'
  },
  pending: {
    label: 'Ожидание',
    color: 'bg-amber-100 text-amber-700 border-amber-200'
  },
  closed: {
    label: 'Закрыто',
    color: 'bg-gray-100 text-gray-700 border-gray-200'
  },
  appeal: {
    label: 'Апелляция',
    color: 'bg-blue-100 text-blue-700 border-blue-200'
  }
};
interface CasesPageProps {
  onSelectCase?: (caseItem: Case) => void;
}
export function CasesPage({ onSelectCase }: CasesPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | Case['status']>(
    'all'
  );
  const [filterClient, setFilterClient] = useState('all');
  const [filterJudge, setFilterJudge] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [viewMode, setViewMode] = useState<'comfortable' | 'compact'>(
    'comfortable'
  );
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [isSelectAllActive, setIsSelectAllActive] = useState(false);
  const filteredCases = casesData.filter((caseItem) => {
    const matchesSearch =
    caseItem.number.toLowerCase().includes(searchQuery.toLowerCase()) ||
    caseItem.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    caseItem.client.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
    filterStatus === 'all' || caseItem.status === filterStatus;
    const matchesClient =
    filterClient === 'all' || caseItem.client === filterClient;
    const matchesJudge = filterJudge === 'all' || caseItem.judge === filterJudge;
    return matchesSearch && matchesStatus && matchesClient && matchesJudge;
  });
  const stats = {
    total: casesData.length,
    active: casesData.filter((c) => c.status === 'active').length,
    pending: casesData.filter((c) => c.status === 'pending').length,
    closed: casesData.filter((c) => c.status === 'closed').length
  };
  const uniqueClients = Array.from(new Set(casesData.map((c) => c.client)));
  const uniqueJudges = Array.from(new Set(casesData.map((c) => c.judge)));
  const toggleCaseSelection = (caseId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSelected = new Set(selectedCases);
    if (newSelected.has(caseId)) {
      newSelected.delete(caseId);
    } else {
      newSelected.add(caseId);
    }
    setSelectedCases(newSelected);
  };
  const selectAll = () => {
    if (
    selectedCases.size === filteredCases.length &&
    filteredCases.length > 0)
    {
      setSelectedCases(new Set());
      setIsSelectAllActive(false);
    } else {
      setSelectedCases(new Set(filteredCases.map((c) => c.id)));
      setIsSelectAllActive(true);
    }
  };
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-6xl mx-auto space-y-6">
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
          className="space-y-4">

          <div className="flex items-center justify-end gap-4">
            <button className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors shadow-sm active:scale-[0.98]">
              <Plus size={18} />
              Добавить дело
            </button>
          </div>

          {/* Search and Controls */}
          <div className="space-y-3">
            <div className="flex flex-col md:flex-row gap-3">
              <div className="relative flex-1 group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-claude-subtext group-focus-within:text-claude-accent transition-colors" />
                </div>
                <input
                  type="text"
                  className="block w-full pl-11 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans"
                  placeholder="Поиск по номеру дела, названию или клиенту..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)} />

              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className={`flex items-center gap-2 px-4 py-3 rounded-xl font-medium text-sm font-sans transition-all ${showFilters ? 'bg-claude-accent text-white shadow-sm' : 'bg-white text-claude-text border border-claude-border hover:bg-claude-bg'}`}>

                  <Filter size={18} />
                  Фильтры
                  <ChevronDown
                    size={16}
                    className={`transition-transform ${showFilters ? 'rotate-180' : ''}`} />

                </button>

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
            </div>

            {/* All Filters - Collapsible */}
            <AnimatePresence>
              {showFilters &&
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
                transition={{
                  duration: 0.3
                }}
                className="overflow-hidden">

                  <div className="bg-white rounded-xl p-4 border border-claude-border shadow-sm space-y-4">
                    {/* Status Quick Filters */}
                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Статус дела
                      </label>
                      <div className="flex gap-2 flex-wrap">
                        <button
                        onClick={() => setFilterStatus('all')}
                        className={`px-3 py-1.5 rounded-lg font-medium text-sm font-sans whitespace-nowrap transition-all ${filterStatus === 'all' ? 'bg-claude-accent text-white shadow-sm' : 'bg-claude-bg text-claude-text border border-claude-border hover:bg-claude-border'}`}>

                          Все дела
                        </button>
                        {Object.entries(statusConfig).map(
                        ([status, config]) =>
                        <button
                          key={status}
                          onClick={() =>
                          setFilterStatus(status as Case['status'])
                          }
                          className={`px-3 py-1.5 rounded-lg font-medium text-sm font-sans whitespace-nowrap transition-all ${filterStatus === status ? config.color : 'bg-claude-bg text-claude-text border border-claude-border hover:bg-claude-border'}`}>

                              {config.label}
                            </button>

                      )}
                      </div>
                    </div>

                    {/* Advanced Filters */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-claude-border">
                      <div>
                        <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                          Клиент
                        </label>
                        <select
                        value={filterClient}
                        onChange={(e) => setFilterClient(e.target.value)}
                        className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                          <option value="all">Все клиенты</option>
                          {uniqueClients.map((client) =>
                        <option key={client} value={client}>
                              {client}
                            </option>
                        )}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                          Судья
                        </label>
                        <select
                        value={filterJudge}
                        onChange={(e) => setFilterJudge(e.target.value)}
                        className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                          <option value="all">Все судьи</option>
                          {uniqueJudges.map((judge) =>
                        <option key={judge} value={judge}>
                              {judge}
                            </option>
                        )}
                        </select>
                      </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                      <button
                      onClick={() => {
                        setFilterClient('all');
                        setFilterJudge('all');
                        setFilterStatus('all');
                      }}
                      className="px-4 py-2 text-sm font-medium font-sans text-claude-text hover:bg-claude-bg rounded-lg transition-colors">

                        Сбросить
                      </button>
                    </div>
                  </div>
                </motion.div>
              }
            </AnimatePresence>

            {/* Select All */}
            {filteredCases.length > 0 &&
            <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 px-3 py-2 bg-white rounded-lg border border-claude-border hover:bg-claude-bg transition-colors cursor-pointer">
                  <input
                  type="checkbox"
                  checked={
                  selectedCases.size === filteredCases.length &&
                  filteredCases.length > 0
                  }
                  onChange={selectAll}
                  className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent cursor-pointer" />

                  <span className="text-sm font-medium text-claude-text font-sans">
                    Выбрать все
                  </span>
                </label>
                {selectedCases.size > 0 &&
              <span className="text-sm text-claude-subtext font-sans">
                    Выбрано: {selectedCases.size}
                  </span>
              }
              </div>
            }
          </div>
        </motion.div>

        {/* Cases List */}
        <div className={viewMode === 'compact' ? 'space-y-2' : 'space-y-3'}>
          {filteredCases.map((caseItem, index) =>
          <motion.div
            key={caseItem.id}
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
              delay: index * 0.02 + 0.1
            }}
            onClick={() => onSelectCase?.(caseItem)}
            className={`group bg-white rounded-2xl border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all cursor-pointer ${viewMode === 'compact' ? 'p-3' : 'p-5'}`}>

              <div className="flex items-start gap-3">
                {/* Checkbox - Only show when select all is active */}
                {isSelectAllActive &&
              <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                    <input
                  type="checkbox"
                  checked={selectedCases.has(caseItem.id)}
                  onChange={(e) => toggleCaseSelection(caseItem.id, e)}
                  className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent cursor-pointer" />

                  </div>
              }

                {/* Case Icon */}
                {viewMode === 'comfortable' &&
              <div className="w-12 h-12 rounded-xl bg-claude-sidebar border-2 border-white shadow-sm flex items-center justify-center flex-shrink-0">
                    <Briefcase size={20} className="text-claude-subtext" />
                  </div>
              }

                {/* Main Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <h3
                        className={`font-serif font-medium text-claude-text group-hover:text-claude-accent transition-colors ${viewMode === 'compact' ? 'text-base' : 'text-lg'}`}>

                          {caseItem.number}
                        </h3>
                        <span
                        className={`px-2 py-0.5 rounded font-medium border font-sans ${statusConfig[caseItem.status].color} ${viewMode === 'compact' ? 'text-[10px]' : 'text-xs'}`}>

                          {statusConfig[caseItem.status].label}
                        </span>
                      </div>
                      <p
                      className={`text-claude-text font-sans font-medium ${viewMode === 'compact' ? 'text-xs' : 'text-sm'}`}>

                        {caseItem.title}
                      </p>
                      {viewMode === 'comfortable' &&
                    <p className="text-xs text-claude-subtext font-sans mt-1">
                          {caseItem.category} • {caseItem.court}
                        </p>
                    }
                    </div>

                    <button
                    onClick={(e) => e.stopPropagation()}
                    className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors opacity-0 group-hover:opacity-100">

                      <MoreVertical size={16} />
                    </button>
                  </div>

                  {/* Case Details */}
                  <div
                  className={`grid gap-2 ${viewMode === 'compact' ? 'grid-cols-3 text-xs' : 'grid-cols-1 md:grid-cols-3 text-sm mb-4'}`}>

                    <div className="flex items-center gap-1.5 text-claude-subtext">
                      <User
                      size={viewMode === 'compact' ? 12 : 14}
                      className="flex-shrink-0" />

                      <span className="truncate font-sans">
                        {caseItem.client}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-claude-subtext">
                      <Scale
                      size={viewMode === 'compact' ? 12 : 14}
                      className="flex-shrink-0" />

                      <span className="truncate font-sans">
                        {caseItem.judge}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-claude-subtext">
                      <Calendar
                      size={viewMode === 'compact' ? 12 : 14}
                      className="flex-shrink-0" />

                      <span className="font-sans">
                        {new Date(caseItem.nextHearing).toLocaleDateString(
                        'ru-RU'
                      )}
                      </span>
                    </div>
                  </div>

                  {/* Quick Actions */}
                  {viewMode === 'comfortable' &&
                <div className="flex items-center gap-2 pt-3 border-t border-claude-border/50">
                      <button
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-claude-text hover:bg-claude-bg rounded-lg transition-colors">

                        <Eye size={14} />
                        Просмотр
                      </button>
                      <button
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-claude-text hover:bg-claude-bg rounded-lg transition-colors">

                        <Edit size={14} />
                        Редактировать
                      </button>
                      <button
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-red-600 hover:bg-red-50 rounded-lg transition-colors ml-auto">

                        <Trash2 size={14} />
                        Удалить
                      </button>
                    </div>
                }
                </div>
              </div>
            </motion.div>
          )}
        </div>

        {filteredCases.length === 0 &&
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
              Дела не найдены
            </h3>
            <p className="text-claude-subtext font-sans max-w-md mx-auto">
              Попробуйте изменить параметры поиска или добавьте новое дело
            </p>
          </motion.div>
        }
      </div>

      {/* Floating Action Bar */}
      <AnimatePresence>
        {selectedCases.size > 0 &&
        <motion.div
          initial={{
            y: 100,
            opacity: 0
          }}
          animate={{
            y: 0,
            opacity: 1
          }}
          exit={{
            y: 100,
            opacity: 0
          }}
          transition={{
            duration: 0.3,
            ease: [0.22, 1, 0.36, 1]
          }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">

            <div className="bg-claude-text text-white rounded-2xl shadow-2xl p-4 flex items-center gap-4">
              <div className="flex items-center gap-3 px-2">
                <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-serif font-medium">
                  {selectedCases.size}
                </div>
                <span className="font-sans text-sm">
                  {selectedCases.size === 1 ? 'дело выбрано' : 'дел выбрано'}
                </span>
              </div>

              <div className="h-8 w-px bg-white/20" />

              <div className="flex gap-2">
                <button className="flex items-center gap-2 px-4 py-2 bg-white text-claude-text rounded-xl font-medium text-sm font-sans hover:bg-gray-100 transition-colors">
                  <Send size={16} />
                  Действия
                </button>
                <button
                onClick={() => {
                  setSelectedCases(new Set());
                  setIsSelectAllActive(false);
                }}
                className="p-2 hover:bg-white/10 rounded-xl transition-colors">

                  <X size={20} />
                </button>
              </div>
            </div>
          </motion.div>
        }
      </AnimatePresence>
    </div>);

}