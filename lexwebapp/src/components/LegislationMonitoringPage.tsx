import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Filter,
  ChevronDown,
  Eye,
  Download,
  Star,
  Bell,
  X,
  FileText,
  Calendar,
  CheckCircle,
  ArrowLeft,
  ExternalLink,
  Printer,
  Share2,
  BookOpen,
  History,
  Link as LinkIcon,
  TrendingUp,
  AlertCircle,
  Clock,
  XCircle } from
'lucide-react';
interface LegislationDocument {
  id: string;
  title: string;
  number: string;
  date: string;
  status: 'active' | 'inactive' | 'draft' | 'rejected';
  type: string;
  category: string;
}
interface LegislationMonitoringPageProps {
  onBack?: () => void;
}
const mockDocuments: LegislationDocument[] = [
{
  id: '1',
  title: 'Про внесення змін до Цивільного кодексу України',
  number: '1234-IX',
  date: '15.01.2024',
  status: 'active',
  type: 'Закон',
  category: 'Цивільне право'
},
{
  id: '2',
  title: 'Цивільний кодекс України',
  number: '435-15',
  date: '16.01.2003',
  status: 'active',
  type: 'Кодекс',
  category: 'Цивільне право'
},
{
  id: '3',
  title: 'Про захист прав споживачів',
  number: '1023-XII',
  date: '12.05.1991',
  status: 'active',
  type: 'Закон',
  category: 'Цивільне право'
},
{
  id: '4',
  title: 'Кримінальний кодекс України',
  number: '2341-III',
  date: '05.04.2001',
  status: 'active',
  type: 'Кодекс',
  category: 'Кримінальне право'
},
{
  id: '5',
  title: 'Про внесення змін до Податкового кодексу',
  number: '2456-IX',
  date: '20.11.2023',
  status: 'draft',
  type: 'Законопроект',
  category: 'Податкове право'
}];

const statusConfig = {
  active: {
    label: 'Чинний',
    color: 'bg-green-50 text-green-700 border-green-200',
    icon: <CheckCircle size={12} className="text-green-600" />
  },
  inactive: {
    label: 'Втратив чинність',
    color: 'bg-red-50 text-red-700 border-red-200',
    icon: <XCircle size={12} className="text-red-600" />
  },
  draft: {
    label: 'На розгляді',
    color: 'bg-amber-50 text-amber-700 border-amber-200',
    icon: <Clock size={12} className="text-amber-600" />
  },
  rejected: {
    label: 'Відхилено',
    color: 'bg-gray-50 text-gray-700 border-gray-200',
    icon: <XCircle size={12} className="text-gray-600" />
  }
};
const documentTypes = [
'Всі типи',
'Закони',
'Кодекси',
'Конституція',
'Постанови',
'Рішення',
'Розпорядження'];

const documentStatuses = [
'Всі статуси',
'Чинний',
'Втратив чинність',
'На розгляді',
'Відхилено'];

const legalCategories = [
'Всі сфери',
'Цивільне право',
'Кримінальне право',
'Адміністративне право',
'Господарське право',
'Трудове право',
'Податкове право'];

export function LegislationMonitoringPage({
  onBack
}: LegislationMonitoringPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedDocument, setSelectedDocument] =
  useState<LegislationDocument | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [activeTab, setActiveTab] = useState<
    'text' | 'card' | 'history' | 'links'>(
    'card');
  const [filters, setFilters] = useState({
    type: 'Всі типи',
    status: 'Всі статуси',
    category: 'Всі сфери',
    dateFrom: '',
    dateTo: ''
  });
  const filteredDocuments = mockDocuments.filter((doc) => {
    const matchesSearch =
    doc.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    doc.number.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = filters.type === 'Всі типи' || doc.type === filters.type;
    const matchesCategory =
    filters.category === 'Всі сфери' || doc.category === filters.category;
    return matchesSearch && matchesType && matchesCategory;
  });
  if (selectedDocument) {
    return (
      <div className="flex-1 h-full overflow-y-auto bg-claude-bg">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b border-claude-border">
          <div className="max-w-7xl mx-auto px-4 md:px-8 py-4">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setSelectedDocument(null)}
                className="p-2 hover:bg-claude-bg rounded-lg transition-colors">

                <ArrowLeft size={20} className="text-claude-text" />
              </button>
              <div className="flex-1">
                <h1 className="text-2xl font-sans text-claude-text font-medium">
                  {selectedDocument.title}
                </h1>
                <p className="text-sm text-claude-subtext font-sans">
                  № {selectedDocument.number} від {selectedDocument.date}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors">
                  <Star size={20} />
                </button>
                <button className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors">
                  <Bell size={20} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 md:px-8 py-8">
          {/* Tabs */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
            <div className="flex border-b border-claude-border">
              {[
              {
                id: 'text',
                label: 'Текст',
                icon: FileText
              },
              {
                id: 'card',
                label: 'Картка',
                icon: BookOpen
              },
              {
                id: 'history',
                label: 'Історія',
                icon: History
              },
              {
                id: 'links',
                label: "Зв'язки",
                icon: LinkIcon
              }].
              map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium font-sans transition-colors relative ${activeTab === tab.id ? 'text-claude-accent bg-claude-accent/5' : 'text-claude-subtext hover:text-claude-text hover:bg-claude-bg'}`}>

                    <Icon size={16} />
                    {tab.label}
                    {activeTab === tab.id &&
                    <motion.div
                      layoutId="activeTab"
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-claude-accent" />

                    }
                  </button>);

              })}
            </div>

            <div className="p-6">
              {activeTab === 'card' &&
              <motion.div
                initial={{
                  opacity: 0,
                  y: 10
                }}
                animate={{
                  opacity: 1,
                  y: 0
                }}
                className="space-y-6">

                  {/* Metadata */}
                  <div>
                    <h3 className="text-lg font-sans font-medium text-claude-text mb-4">
                      Метадані
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="p-4 bg-claude-bg rounded-xl border border-claude-border">
                        <p className="text-xs text-claude-subtext font-sans mb-1">
                          Тип документа
                        </p>
                        <p className="text-sm font-medium text-claude-text font-sans">
                          {selectedDocument.type}
                        </p>
                      </div>
                      <div className="p-4 bg-claude-bg rounded-xl border border-claude-border">
                        <p className="text-xs text-claude-subtext font-sans mb-1">
                          Статус
                        </p>
                        <span
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border ${statusConfig[selectedDocument.status].color}`}>

                          {statusConfig[selectedDocument.status].icon}{' '}
                          {statusConfig[selectedDocument.status].label}
                        </span>
                      </div>
                      <div className="p-4 bg-claude-bg rounded-xl border border-claude-border">
                        <p className="text-xs text-claude-subtext font-sans mb-1">
                          Поточна редакція
                        </p>
                        <p className="text-sm font-medium text-claude-text font-sans">
                          від 01.01.2024 (підстава: 3091-IX)
                        </p>
                      </div>
                      <div className="p-4 bg-claude-bg rounded-xl border border-claude-border">
                        <p className="text-xs text-claude-subtext font-sans mb-1">
                          Набув чинності
                        </p>
                        <p className="text-sm font-medium text-claude-text font-sans">
                          01.01.2004
                        </p>
                      </div>
                      <div className="p-4 bg-claude-bg rounded-xl border border-claude-border md:col-span-2">
                        <p className="text-xs text-claude-subtext font-sans mb-1">
                          Прийнятий
                        </p>
                        <p className="text-sm font-medium text-claude-text font-sans">
                          Верховна Рада України
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Content Structure */}
                  <div>
                    <h3 className="text-lg font-sans font-medium text-claude-text mb-4">
                      Зміст документа
                    </h3>
                    <div className="space-y-2">
                      {[
                    'Книга перша. Загальні положення',
                    'Книга друга. Особисті немайнові права фізичної особи',
                    'Книга третя. Право власності та інші речові права',
                    'Книга четверта. Право інтелектуальної власності',
                    "Книга п'ята. Зобов'язальне право",
                    'Книга шоста. Спадкове право'].
                    map((section, index) =>
                    <button
                      key={index}
                      className="w-full flex items-center gap-3 p-3 bg-white border border-claude-border rounded-xl hover:border-claude-accent/30 hover:bg-claude-bg transition-all text-left">

                          <BookOpen
                        size={16}
                        className="text-claude-subtext flex-shrink-0" />

                          <span className="text-sm font-sans text-claude-text">
                            {section}
                          </span>
                        </button>
                    )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap gap-3 pt-4 border-t border-claude-border">
                    <button className="flex items-center gap-2 px-4 py-2 bg-claude-accent text-white rounded-xl text-sm font-medium font-sans hover:bg-[#C66345] transition-colors">
                      <Download size={16} />
                      Завантажити
                    </button>
                    <button className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border text-claude-text rounded-xl text-sm font-medium font-sans hover:bg-claude-bg transition-colors">
                      <Printer size={16} />
                      Друк
                    </button>
                    <button className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border text-claude-text rounded-xl text-sm font-medium font-sans hover:bg-claude-bg transition-colors">
                      <Share2 size={16} />
                      Поділитися
                    </button>
                    <button className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border text-claude-text rounded-xl text-sm font-medium font-sans hover:bg-claude-bg transition-colors">
                      <Star size={16} />В обране
                    </button>
                  </div>
                </motion.div>
              }

              {activeTab === 'text' &&
              <motion.div
                initial={{
                  opacity: 0,
                  y: 10
                }}
                animate={{
                  opacity: 1,
                  y: 0
                }}
                className="prose max-w-none">

                  <p className="text-claude-subtext font-sans">
                    Повний текст документа буде відображатися тут...
                  </p>
                </motion.div>
              }

              {activeTab === 'history' &&
              <motion.div
                initial={{
                  opacity: 0,
                  y: 10
                }}
                animate={{
                  opacity: 1,
                  y: 0
                }}
                className="space-y-4">

                  <p className="text-claude-subtext font-sans">
                    Історія змін документа буде відображатися тут...
                  </p>
                </motion.div>
              }

              {activeTab === 'links' &&
              <motion.div
                initial={{
                  opacity: 0,
                  y: 10
                }}
                animate={{
                  opacity: 1,
                  y: 0
                }}
                className="space-y-4">

                  <p className="text-claude-subtext font-sans">
                    Зв'язки з іншими документами будуть відображатися тут...
                  </p>
                </motion.div>
              }
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
                <Bell size={32} className="text-claude-accent" />
                <h1 className="text-3xl md:text-4xl font-sans text-claude-text font-medium tracking-tight">
                  Моніторинг законодавства
                </h1>
              </div>
              <p className="text-claude-subtext font-sans text-sm">
                Відстеження змін у законах та кодексах України
              </p>
            </div>
          </div>

          {/* Search and Filters */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 space-y-4">
            <div className="flex gap-2">
              <div className="relative flex-1 group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-claude-subtext group-focus-within:text-claude-accent transition-colors" />
                </div>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Пошук законів, кодексів або статей..."
                  className="block w-full pl-11 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans" />

              </div>
              <button className="px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans flex items-center gap-2">
                <Search size={18} />
                Пошук
              </button>
            </div>

            {/* Filters */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2 flex items-center gap-2">
                  <Calendar size={16} />
                  Період
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={filters.dateFrom}
                    onChange={(e) =>
                    setFilters({
                      ...filters,
                      dateFrom: e.target.value
                    })
                    }
                    className="w-full px-3 pr-8 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm" />

                  <input
                    type="date"
                    value={filters.dateTo}
                    onChange={(e) =>
                    setFilters({
                      ...filters,
                      dateTo: e.target.value
                    })
                    }
                    className="w-full px-3 pr-8 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm" />

                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2 flex items-center gap-2">
                  <Filter size={16} />
                  Тип документа
                </label>
                <select
                  value={filters.type}
                  onChange={(e) =>
                  setFilters({
                    ...filters,
                    type: e.target.value
                  })
                  }
                  className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                  {documentTypes.map((type) =>
                  <option key={type} value={type}>
                      {type}
                    </option>
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2 flex items-center gap-2">
                  <FileText size={16} />
                  Сфера права
                </label>
                <select
                  value={filters.category}
                  onChange={(e) =>
                  setFilters({
                    ...filters,
                    category: e.target.value
                  })
                  }
                  className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                  {legalCategories.map((category) =>
                  <option key={category} value={category}>
                      {category}
                    </option>
                  )}
                </select>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <motion.div
            initial={{
              opacity: 0,
              scale: 0.95
            }}
            animate={{
              opacity: 1,
              scale: 1
            }}
            transition={{
              delay: 0.1
            }}
            className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">

            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-sm text-claude-subtext font-sans mb-1">
                  Нових змін
                </p>
                <p className="text-3xl font-sans font-bold text-claude-text">
                  23
                </p>
              </div>
              <div className="p-2 bg-claude-accent/10 rounded-lg">
                <FileText size={20} className="text-claude-accent" />
              </div>
            </div>
            <div className="flex items-center gap-1 text-sm">
              <TrendingUp size={16} className="text-green-600" />
              <span className="text-green-600 font-medium font-sans">+12%</span>
              <span className="text-claude-subtext font-sans">цього тижня</span>
            </div>
          </motion.div>

          <motion.div
            initial={{
              opacity: 0,
              scale: 0.95
            }}
            animate={{
              opacity: 1,
              scale: 1
            }}
            transition={{
              delay: 0.2
            }}
            className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">

            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-sm text-claude-subtext font-sans mb-1">
                  Чинних законів
                </p>
                <p className="text-3xl font-sans font-bold text-claude-text">
                  124
                </p>
              </div>
              <div className="p-2 bg-claude-accent/10 rounded-lg">
                <CheckCircle size={20} className="text-claude-accent" />
              </div>
            </div>
            <div className="flex items-center gap-1 text-sm">
              <TrendingUp size={16} className="text-green-600" />
              <span className="text-green-600 font-medium font-sans">+3%</span>
              <span className="text-claude-subtext font-sans">цього тижня</span>
            </div>
          </motion.div>

          <motion.div
            initial={{
              opacity: 0,
              scale: 0.95
            }}
            animate={{
              opacity: 1,
              scale: 1
            }}
            transition={{
              delay: 0.3
            }}
            className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">

            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-sm text-claude-subtext font-sans mb-1">
                  На розгляді
                </p>
                <p className="text-3xl font-sans font-bold text-claude-text">
                  18
                </p>
              </div>
              <div className="p-2 bg-claude-accent/10 rounded-lg">
                <AlertCircle size={20} className="text-claude-accent" />
              </div>
            </div>
            <div className="flex items-center gap-1 text-sm">
              <TrendingUp size={16} className="text-green-600" />
              <span className="text-green-600 font-medium font-sans">+5%</span>
              <span className="text-claude-subtext font-sans">цього тижня</span>
            </div>
          </motion.div>
        </div>

        {/* Results Header */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-claude-subtext font-sans">
            Показано: 1-{filteredDocuments.length} з {filteredDocuments.length}
          </p>
        </div>

        {/* Results Table */}
        <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-claude-bg border-b border-claude-border">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                    № з/п
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                    Назва документа
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                    Номер
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                    Дата
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                    Статус
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                    Дії
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-claude-border">
                {filteredDocuments.map((doc, index) =>
                <motion.tr
                  key={doc.id}
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
                  className="hover:bg-claude-bg transition-colors cursor-pointer"
                  onClick={() => setSelectedDocument(doc)}>

                    <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-subtext font-sans">
                      {index + 1}
                    </td>
                    <td className="px-6 py-4 text-sm text-claude-text font-sans font-medium">
                      {doc.title}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-text font-sans">
                      {doc.number}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-claude-subtext font-sans">
                      {doc.date}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border ${statusConfig[doc.status].color}`}>

                        {statusConfig[doc.status].icon}{' '}
                        {statusConfig[doc.status].label}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end gap-2">
                        <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedDocument(doc);
                        }}
                        className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded transition-colors"
                        title="Переглянути">

                          <Eye size={16} />
                        </button>
                        <button
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded transition-colors"
                        title="Завантажити">

                          <Download size={16} />
                        </button>
                        <button
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded transition-colors"
                        title="В обране">

                          <Star size={16} />
                        </button>
                        <button
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded transition-colors"
                        title="Відстежувати">

                          <Bell size={16} />
                        </button>
                      </div>
                    </td>
                  </motion.tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Notifications Modal */}
      <AnimatePresence>
        {showNotifications &&
        <>
            <motion.div
            initial={{
              opacity: 0
            }}
            animate={{
              opacity: 1
            }}
            exit={{
              opacity: 0
            }}
            onClick={() => setShowNotifications(false)}
            className="fixed inset-0 bg-black/50 z-50 backdrop-blur-sm" />

            <motion.div
            initial={{
              opacity: 0,
              scale: 0.95,
              y: 20
            }}
            animate={{
              opacity: 1,
              scale: 1,
              y: 0
            }}
            exit={{
              opacity: 0,
              scale: 0.95,
              y: 20
            }}
            className="fixed inset-4 md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-full md:max-w-2xl bg-white rounded-2xl border border-claude-border shadow-2xl z-50 overflow-hidden">

              <div className="flex items-center justify-between p-6 border-b border-claude-border">
                <h2 className="text-xl font-serif text-claude-text font-medium">
                  Налаштування сповіщень
                </h2>
                <button
                onClick={() => setShowNotifications(false)}
                className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors">

                  <X size={20} />
                </button>
              </div>

              <div className="p-6 space-y-6 max-h-[calc(100vh-200px)] overflow-y-auto">
                {/* Notification Channels */}
                <div>
                  <h3 className="text-sm font-medium text-claude-text font-sans mb-3">
                    Канали сповіщень
                  </h3>
                  <div className="space-y-2">
                    <label className="flex items-center gap-3 p-3 bg-claude-bg rounded-lg cursor-pointer hover:bg-claude-border transition-colors">
                      <input
                      type="checkbox"
                      defaultChecked
                      className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent" />

                      <span className="text-sm text-claude-text font-sans">
                        Email сповіщення
                      </span>
                    </label>
                    <label className="flex items-center gap-3 p-3 bg-claude-bg rounded-lg cursor-pointer hover:bg-claude-border transition-colors">
                      <input
                      type="checkbox"
                      defaultChecked
                      className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent" />

                      <span className="text-sm text-claude-text font-sans">
                        Push-сповіщення
                      </span>
                    </label>
                  </div>
                </div>

                {/* Frequency */}
                <div>
                  <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                    Частота
                  </label>
                  <select className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">
                    <option>Миттєво</option>
                    <option>Щоденний дайджест (о 09:00)</option>
                    <option>Щотижневий дайджест (понеділок, 09:00)</option>
                  </select>
                </div>

                {/* Tracked Documents */}
                <div>
                  <h3 className="text-sm font-medium text-claude-text font-sans mb-3">
                    Відстежувані документи
                  </h3>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                      <span className="text-sm text-claude-text font-sans">
                        Цивільний кодекс України (435-15)
                      </span>
                      <button className="p-1 text-red-600 hover:bg-red-50 rounded transition-colors">
                        <X size={16} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                      <span className="text-sm text-claude-text font-sans">
                        Кримінальний кодекс України (2341-14)
                      </span>
                      <button className="p-1 text-red-600 hover:bg-red-50 rounded transition-colors">
                        <X size={16} />
                      </button>
                    </div>
                    <button className="w-full p-3 border-2 border-dashed border-claude-border rounded-lg text-sm text-claude-subtext hover:text-claude-text hover:border-claude-accent transition-colors font-sans">
                      + Додати документ
                    </button>
                  </div>
                </div>

                {/* Categories */}
                <div>
                  <h3 className="text-sm font-medium text-claude-text font-sans mb-3">
                    Відстежувати нові документи в категоріях
                  </h3>
                  <div className="space-y-2">
                    {[
                  'Цивільне право',
                  'Кримінальне право',
                  'Адміністративне право'].
                  map((category) =>
                  <label
                    key={category}
                    className="flex items-center gap-3 p-3 bg-claude-bg rounded-lg cursor-pointer hover:bg-claude-border transition-colors">

                        <input
                      type="checkbox"
                      defaultChecked={category !== 'Адміністративне право'}
                      className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent" />

                        <span className="text-sm text-claude-text font-sans">
                          {category}
                        </span>
                      </label>
                  )}
                  </div>
                </div>

                <button className="w-full px-4 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans">
                  Зберегти налаштування
                </button>
              </div>
            </motion.div>
          </>
        }
      </AnimatePresence>
    </div>);

}