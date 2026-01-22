import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Clock,
  MessageSquare,
  Trash2,
  MoreVertical,
  Calendar,
  Filter,
  LayoutGrid,
  List,
  FileText,
  CheckCircle,
  XCircle } from
'lucide-react';
interface HistoryItem {
  id: string;
  query: string;
  timestamp: string;
  resultCount: number;
  status: 'completed' | 'partial' | 'error';
  category: string;
}
const historyData: HistoryItem[] = [
{
  id: '1',
  query: 'Підключення к API Ради без ключей',
  timestamp: '2024-02-10T14:30:00',
  resultCount: 5,
  status: 'completed',
  category: 'Технические вопросы'
},
{
  id: '2',
  query: 'Анализ судебной практики по банкротству',
  timestamp: '2024-02-10T11:15:00',
  resultCount: 12,
  status: 'completed',
  category: 'Судебная практика'
},
{
  id: '3',
  query: 'Поиск решений Верховного Суда по налоговым спорам',
  timestamp: '2024-02-09T16:45:00',
  resultCount: 8,
  status: 'completed',
  category: 'Судебная практика'
},
{
  id: '4',
  query: 'Статистика судьи Иванова П.С.',
  timestamp: '2024-02-09T10:20:00',
  resultCount: 3,
  status: 'partial',
  category: 'Аналитика'
},
{
  id: '5',
  query: 'Образец искового заявления о взыскании задолженности',
  timestamp: '2024-02-08T15:30:00',
  resultCount: 7,
  status: 'completed',
  category: 'Документы'
},
{
  id: '6',
  query: 'Комментарий к статье 617 ГК',
  timestamp: '2024-02-08T09:10:00',
  resultCount: 0,
  status: 'error',
  category: 'Нормативные акты'
},
{
  id: '7',
  query: 'Практика применения сроков исковой давности',
  timestamp: '2024-02-07T14:00:00',
  resultCount: 15,
  status: 'completed',
  category: 'Судебная практика'
},
{
  id: '8',
  query: 'Анализ дела №А40-12345/2024',
  timestamp: '2024-02-07T11:30:00',
  resultCount: 4,
  status: 'completed',
  category: 'Дела'
},
{
  id: '9',
  query: 'Поиск адвокатов по корпоративному праву',
  timestamp: '2024-02-06T16:20:00',
  resultCount: 6,
  status: 'completed',
  category: 'Адвокаты'
},
{
  id: '10',
  query: 'Обзор изменений в налоговом законодательстве 2024',
  timestamp: '2024-02-06T10:45:00',
  resultCount: 9,
  status: 'completed',
  category: 'Нормативные акты'
},
{
  id: '11',
  query: 'Статистика по делам о банкротстве за 2023 год',
  timestamp: '2024-02-05T15:15:00',
  resultCount: 11,
  status: 'completed',
  category: 'Аналитика'
},
{
  id: '12',
  query: 'Образцы договоров поставки',
  timestamp: '2024-02-05T09:30:00',
  resultCount: 5,
  status: 'completed',
  category: 'Документы'
},
{
  id: '13',
  query: 'Анализ практики Арбитражного суда Москвы',
  timestamp: '2024-02-04T14:50:00',
  resultCount: 18,
  status: 'completed',
  category: 'Судебная практика'
},
{
  id: '14',
  query: 'Поиск клиентов по ИНН',
  timestamp: '2024-02-04T11:00:00',
  resultCount: 2,
  status: 'partial',
  category: 'Клиенты'
},
{
  id: '15',
  query: 'Комментарии к Арбитражному процессуальному кодексу',
  timestamp: '2024-02-03T16:30:00',
  resultCount: 13,
  status: 'completed',
  category: 'Нормативные акты'
}];

const statusConfig = {
  completed: {
    label: 'Выполнено',
    icon: CheckCircle,
    color: 'text-green-600 bg-green-50 border-green-200'
  },
  partial: {
    label: 'Частично',
    icon: Clock,
    color: 'text-amber-600 bg-amber-50 border-amber-200'
  },
  error: {
    label: 'Ошибка',
    icon: XCircle,
    color: 'text-red-600 bg-red-50 border-red-200'
  }
};
function groupByDate(items: HistoryItem[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const thisWeek = new Date(today);
  thisWeek.setDate(thisWeek.getDate() - 7);
  const thisMonth = new Date(today);
  thisMonth.setMonth(thisMonth.getMonth() - 1);
  const groups: {
    [key: string]: HistoryItem[];
  } = {
    Сегодня: [],
    Вчера: [],
    'На этой неделе': [],
    'В этом месяце': [],
    Ранее: []
  };
  items.forEach((item) => {
    const itemDate = new Date(item.timestamp);
    if (itemDate >= today) {
      groups['Сегодня'].push(item);
    } else if (itemDate >= yesterday) {
      groups['Вчера'].push(item);
    } else if (itemDate >= thisWeek) {
      groups['На этой неделе'].push(item);
    } else if (itemDate >= thisMonth) {
      groups['В этом месяце'].push(item);
    } else {
      groups['Ранее'].push(item);
    }
  });
  return Object.entries(groups).filter(([_, items]) => items.length > 0);
}
interface HistoryPageProps {
  onSelectHistory?: (item: HistoryItem) => void;
}
export function HistoryPage({ onSelectHistory }: HistoryPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'comfortable' | 'compact'>(
    'comfortable'
  );
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const filteredHistory = historyData.filter(
    (item) =>
    item.query.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.category.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const groupedHistory = groupByDate(filteredHistory);
  const toggleItemSelection = (itemId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSelected = new Set(selectedItems);
    if (newSelected.has(itemId)) {
      newSelected.delete(itemId);
    } else {
      newSelected.add(itemId);
    }
    setSelectedItems(newSelected);
  };
  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    });
  };
  const formatDate = (timestamp: string) => {
    return new Date(timestamp).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short'
    });
  };
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-4xl mx-auto space-y-6">
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
          }}
          className="space-y-4">

          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight mb-2">
                История запросов
              </h1>
              <p className="text-claude-subtext font-sans text-sm">
                Все ваши предыдущие запросы и результаты
              </p>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm text-sm font-sans">
              <Clock size={16} className="text-claude-subtext" />
              <span className="text-claude-subtext">
                {historyData.length} запросов
              </span>
            </div>
          </div>

          {/* Search and Controls */}
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1 group">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-claude-subtext group-focus-within:text-claude-accent transition-colors" />
              </div>
              <input
                type="text"
                className="block w-full pl-11 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans"
                placeholder="Поиск в истории..."
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

        {/* History Timeline */}
        <div className="space-y-8">
          {groupedHistory.map(([period, items], groupIndex) =>
          <motion.div
            key={period}
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
              delay: groupIndex * 0.1
            }}>

              {/* Period Header */}
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-lg font-serif text-claude-text font-medium">
                  {period}
                </h2>
                <div className="flex-1 h-px bg-claude-border"></div>
                <span className="text-sm text-claude-subtext font-sans">
                  {items.length} {items.length === 1 ? 'запрос' : 'запросов'}
                </span>
              </div>

              {/* Items */}
              <div
              className={viewMode === 'compact' ? 'space-y-2' : 'space-y-3'}>

                {items.map((item, index) => {
                const StatusIcon = statusConfig[item.status].icon;
                return (
                  <motion.div
                    key={item.id}
                    initial={{
                      opacity: 0,
                      x: -20
                    }}
                    animate={{
                      opacity: 1,
                      x: 0
                    }}
                    transition={{
                      duration: 0.3,
                      delay: index * 0.05
                    }}
                    onClick={() => onSelectHistory?.(item)}
                    className={`group bg-white rounded-xl border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all cursor-pointer ${viewMode === 'compact' ? 'p-3' : 'p-4'}`}>

                      <div className="flex items-start gap-3">
                        {/* Icon */}
                        {viewMode === 'comfortable' &&
                      <div className="w-10 h-10 rounded-lg bg-claude-sidebar border border-claude-border flex items-center justify-center flex-shrink-0">
                            <MessageSquare
                          size={18}
                          className="text-claude-subtext" />

                          </div>
                      }

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-3 mb-2">
                            <div className="flex-1">
                              <h3
                              className={`font-sans font-medium text-claude-text group-hover:text-claude-accent transition-colors line-clamp-2 ${viewMode === 'compact' ? 'text-sm' : 'text-base'}`}>

                                {item.query}
                              </h3>
                              <div
                              className={`flex items-center gap-2 mt-1 ${viewMode === 'compact' ? 'text-xs' : 'text-sm'}`}>

                                <span className="text-claude-subtext font-sans">
                                  {formatTime(item.timestamp)}
                                </span>
                                <span className="text-claude-border">•</span>
                                <span className="text-claude-subtext font-sans">
                                  {item.category}
                                </span>
                                {viewMode === 'comfortable' &&
                              <>
                                    <span className="text-claude-border">
                                      •
                                    </span>
                                    <span className="text-claude-subtext font-sans">
                                      {item.resultCount} результатов
                                    </span>
                                  </>
                              }
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {/* Status Badge */}
                              <div
                              className={`flex items-center gap-1 px-2 py-1 rounded border ${statusConfig[item.status].color} ${viewMode === 'compact' ? 'text-xs' : 'text-sm'}`}>

                                <StatusIcon
                                size={viewMode === 'compact' ? 12 : 14} />

                                {viewMode === 'comfortable' &&
                              <span className="font-sans font-medium">
                                    {statusConfig[item.status].label}
                                  </span>
                              }
                              </div>

                              {/* More Button */}
                              <button
                              onClick={(e) => e.stopPropagation()}
                              className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors opacity-0 group-hover:opacity-100">

                                <MoreVertical size={16} />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </motion.div>);

              })}
              </div>
            </motion.div>
          )}
        </div>

        {filteredHistory.length === 0 &&
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
              Попробуйте изменить параметры поиска
            </p>
          </motion.div>
        }
      </div>
    </div>);

}