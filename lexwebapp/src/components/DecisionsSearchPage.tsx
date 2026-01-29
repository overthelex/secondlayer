import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Filter,
  ChevronDown,
  ChevronUp,
  Download,
  Save,
  LayoutGrid,
  List,
  ExternalLink,
  Gavel,
  X } from
'lucide-react';
interface SearchFilters {
  caseNumber: string;
  court: string;
  judge: string;
  dateFrom: string;
  dateTo: string;
  category: string;
  parties: string;
  keywords: string;
  decisionType: string;
  instance: string;
  legalBasis: string;
}
interface Decision {
  id: string;
  caseNumber: string;
  court: string;
  judge: string;
  date: string;
  category: string;
  parties: string;
  summary: string;
  decisionType: string;
  instance: string;
  relevance: number;
}
const mockDecisions: Decision[] = [
{
  id: '1',
  caseNumber: '910/12345/23',
  court: 'Верховний Суд КГС',
  judge: 'Іванов П.С.',
  date: '2023-05-15',
  category: 'Господарські спори',
  parties: 'ТОВ "Альфа" vs ТОВ "Бета"',
  summary:
  'Постанова щодо застосування строків позовної давності у спорах про стягнення неустойки за договорами поставки.',
  decisionType: 'Постанова',
  instance: 'Касаційна',
  relevance: 95
},
{
  id: '2',
  caseNumber: '910/23456/23',
  court: 'Верховний Суд КГС',
  judge: 'Петрова А.В.',
  date: '2023-06-20',
  category: 'Податкові спори',
  parties: 'ТОВ "Гамма" vs ДПС',
  summary:
  'Постанова про визнання недійсним податкового повідомлення-рішення щодо донарахування податку на прибуток.',
  decisionType: 'Постанова',
  instance: 'Касаційна',
  relevance: 88
},
{
  id: '3',
  caseNumber: '910/34567/23',
  court: 'Київський апеляційний господарський суд',
  judge: 'Сидоров М.О.',
  date: '2023-07-10',
  category: 'Корпоративні спори',
  parties: 'Акціонер Іванов І.І. vs ПАТ "Дельта"',
  summary:
  'Постанова про визнання недійсним рішення загальних зборів акціонерів щодо реорганізації товариства.',
  decisionType: 'Постанова',
  instance: 'Апеляційна',
  relevance: 82
},
{
  id: '4',
  caseNumber: '910/45678/23',
  court: 'Господарський суд м. Києва',
  judge: 'Кузнецова О.Д.',
  date: '2023-08-05',
  category: 'Договірні спори',
  parties: 'ТОВ "Епсілон" vs ТОВ "Дзета"',
  summary:
  "Рішення про стягнення заборгованості за договором підряду та пені за прострочення виконання зобов'язань.",
  decisionType: 'Рішення',
  instance: 'Перша',
  relevance: 76
},
{
  id: '5',
  caseNumber: '910/56789/23',
  court: 'Верховний Суд КГС',
  judge: 'Іванов П.С.',
  date: '2023-09-12',
  category: 'Банкрутство',
  parties: 'Кредитор ПАТ "Банк" vs Боржник ТОВ "Ета"',
  summary:
  'Постанова про визнання недійсним правочину щодо відчуження майна боржника в процедурі банкрутства.',
  decisionType: 'Постанова',
  instance: 'Касаційна',
  relevance: 91
}];

const categories = [
'Всі категорії',
'Господарські спори',
'Податкові спори',
'Корпоративні спори',
'Договірні спори',
'Банкрутство',
'Інтелектуальна власність',
'Земельні спори'];

const decisionTypes = [
'Всі типи',
'Постанова',
'Рішення',
'Ухвала',
'Окрема думка'];

const instances = ['Всі інстанції', 'Перша', 'Апеляційна', 'Касаційна'];
export function DecisionsSearchPage() {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [viewMode, setViewMode] = useState<'comfortable' | 'compact'>(
    'comfortable'
  );
  const [filters, setFilters] = useState<SearchFilters>({
    caseNumber: '',
    court: '',
    judge: '',
    dateFrom: '',
    dateTo: '',
    category: 'Всі категорії',
    parties: '',
    keywords: '',
    decisionType: 'Всі типи',
    instance: 'Всі інстанції',
    legalBasis: ''
  });
  const [results, setResults] = useState<Decision[]>(mockDecisions);
  const handleSearch = () => {
    console.log('Searching with filters:', filters);
  };
  const updateFilter = (key: keyof SearchFilters, value: string) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value
    }));
  };
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

          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
            <div>
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight mb-2">
                Пошук судових рішень
              </h1>
              <p className="text-claude-subtext font-sans text-sm">
                Розширений пошук в базі судових рішень України
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button className="flex items-center gap-2 px-3 py-2 text-sm font-sans font-medium text-claude-text bg-white border border-claude-border rounded-xl hover:bg-claude-bg transition-colors shadow-sm">
                <Save size={16} />
                Зберегти
              </button>
              <button className="flex items-center gap-2 px-3 py-2 text-sm font-sans font-medium text-claude-text bg-white border border-claude-border rounded-xl hover:bg-claude-bg transition-colors shadow-sm">
                <Download size={16} />
                Експорт
              </button>
            </div>
          </div>

          {/* Search Form */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 space-y-4">
            {/* Main Search */}
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                    Номер справи
                  </label>
                  <input
                    type="text"
                    value={filters.caseNumber}
                    onChange={(e) => updateFilter('caseNumber', e.target.value)}
                    placeholder="910/12345/23"
                    className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                </div>

                <div>
                  <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                    Суд
                  </label>
                  <input
                    type="text"
                    value={filters.court}
                    onChange={(e) => updateFilter('court', e.target.value)}
                    placeholder="Верховний Суд"
                    className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                  Ключові слова
                </label>
                <input
                  type="text"
                  value={filters.keywords}
                  onChange={(e) => updateFilter('keywords', e.target.value)}
                  placeholder="позовна давність, неустойка, договір..."
                  className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

              </div>
            </div>

            {/* Advanced Filters Toggle */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm font-medium text-claude-accent hover:text-[#C66345] transition-colors font-sans">

              {showAdvanced ?
              <ChevronUp size={16} /> :

              <ChevronDown size={16} />
              }
              Розширені фільтри
            </button>

            {/* Advanced Filters */}
            <AnimatePresence>
              {showAdvanced &&
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
                className="overflow-hidden space-y-4 pt-4 border-t border-claude-border">

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Суддя
                      </label>
                      <input
                      type="text"
                      value={filters.judge}
                      onChange={(e) => updateFilter('judge', e.target.value)}
                      placeholder="Прізвище судді"
                      className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                    </div>

                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Сторони
                      </label>
                      <input
                      type="text"
                      value={filters.parties}
                      onChange={(e) =>
                      updateFilter('parties', e.target.value)
                      }
                      placeholder="Назва організації або ПІБ"
                      className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                    </div>

                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Дата від
                      </label>
                      <input
                      type="date"
                      value={filters.dateFrom}
                      onChange={(e) =>
                      updateFilter('dateFrom', e.target.value)
                      }
                      className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                    </div>

                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Дата до
                      </label>
                      <input
                      type="date"
                      value={filters.dateTo}
                      onChange={(e) => updateFilter('dateTo', e.target.value)}
                      className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                    </div>

                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Категорія справи
                      </label>
                      <select
                      value={filters.category}
                      onChange={(e) =>
                      updateFilter('category', e.target.value)
                      }
                      className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                        {categories.map((cat) =>
                      <option key={cat} value={cat}>
                            {cat}
                          </option>
                      )}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Тип рішення
                      </label>
                      <select
                      value={filters.decisionType}
                      onChange={(e) =>
                      updateFilter('decisionType', e.target.value)
                      }
                      className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                        {decisionTypes.map((type) =>
                      <option key={type} value={type}>
                            {type}
                          </option>
                      )}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Інстанція
                      </label>
                      <select
                      value={filters.instance}
                      onChange={(e) =>
                      updateFilter('instance', e.target.value)
                      }
                      className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                        {instances.map((inst) =>
                      <option key={inst} value={inst}>
                            {inst}
                          </option>
                      )}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Правова основа
                      </label>
                      <input
                      type="text"
                      value={filters.legalBasis}
                      onChange={(e) =>
                      updateFilter('legalBasis', e.target.value)
                      }
                      placeholder="ст. 617 ЦКУ"
                      className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                    </div>
                  </div>
                </motion.div>
              }
            </AnimatePresence>

            {/* Search Button */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleSearch}
                className="flex items-center gap-2 px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans">

                <Search size={18} />
                Знайти рішення
              </button>
              <button
                onClick={() =>
                setFilters({
                  caseNumber: '',
                  court: '',
                  judge: '',
                  dateFrom: '',
                  dateTo: '',
                  category: 'Всі категорії',
                  parties: '',
                  keywords: '',
                  decisionType: 'Всі типи',
                  instance: 'Всі інстанції',
                  legalBasis: ''
                })
                }
                className="px-4 py-3 text-claude-text hover:bg-claude-bg rounded-xl transition-colors font-sans font-medium">

                Скинути
              </button>
            </div>
          </div>
        </motion.div>

        {/* Results Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-serif text-claude-text font-medium">
              Результати пошуку
            </h2>
            <span className="text-sm text-claude-subtext font-sans">
              {results.length} рішень знайдено
            </span>
          </div>

          {/* View Mode Toggle */}
          <div className="flex bg-white border border-claude-border rounded-xl p-1">
            <button
              onClick={() => setViewMode('comfortable')}
              className={`p-2 rounded-lg transition-colors ${viewMode === 'comfortable' ? 'bg-claude-accent text-white' : 'text-claude-subtext hover:text-claude-text'}`}
              title="Комфортний вигляд">

              <LayoutGrid size={18} />
            </button>
            <button
              onClick={() => setViewMode('compact')}
              className={`p-2 rounded-lg transition-colors ${viewMode === 'compact' ? 'bg-claude-accent text-white' : 'text-claude-subtext hover:text-claude-text'}`}
              title="Компактний вигляд">

              <List size={18} />
            </button>
          </div>
        </div>

        {/* Results */}
        <div className={viewMode === 'compact' ? 'space-y-2' : 'space-y-3'}>
          {results.map((decision, index) =>
          <motion.div
            key={decision.id}
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
              delay: index * 0.05
            }}
            className={`group bg-white rounded-2xl border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all cursor-pointer ${viewMode === 'compact' ? 'p-3' : 'p-5'}`}>

              <div className="flex items-start gap-4">
                {/* Icon */}
                {viewMode === 'comfortable' &&
              <div className="w-12 h-12 rounded-xl bg-claude-sidebar border-2 border-white shadow-sm flex items-center justify-center flex-shrink-0">
                    <Gavel size={20} className="text-claude-subtext" />
                  </div>
              }

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3
                        className={`font-serif font-medium text-claude-text group-hover:text-claude-accent transition-colors ${viewMode === 'compact' ? 'text-base' : 'text-lg'}`}>

                          {decision.caseNumber}
                        </h3>
                        <span className="px-2 py-0.5 rounded text-xs font-medium font-sans bg-blue-50 text-blue-700 border border-blue-200">
                          {decision.decisionType}
                        </span>
                      </div>
                      <p
                      className={`text-claude-text font-sans ${viewMode === 'compact' ? 'text-xs line-clamp-1' : 'text-sm line-clamp-2'}`}>

                        {decision.summary}
                      </p>
                      {viewMode === 'comfortable' &&
                    <p className="text-xs text-claude-subtext font-sans mt-1">
                          {decision.court} • {decision.judge}
                        </p>
                    }
                    </div>

                    <div className="flex items-center gap-2">
                      <div
                      className={`px-2 py-1 rounded ${decision.relevance >= 90 ? 'bg-green-50 text-green-700' : decision.relevance >= 80 ? 'bg-blue-50 text-blue-700' : 'bg-gray-50 text-gray-700'} text-xs font-medium font-sans`}>

                        {decision.relevance}%
                      </div>
                      <button className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors opacity-0 group-hover:opacity-100">
                        <ExternalLink size={16} />
                      </button>
                    </div>
                  </div>

                  <div
                  className={`flex items-center gap-3 ${viewMode === 'compact' ? 'text-xs' : 'text-sm'}`}>

                    <span className="text-claude-subtext font-sans">
                      {new Date(decision.date).toLocaleDateString('uk-UA')}
                    </span>
                    <span className="text-claude-border">•</span>
                    <span className="text-claude-subtext font-sans">
                      {decision.category}
                    </span>
                    <span className="text-claude-border">•</span>
                    <span className="text-claude-subtext font-sans">
                      {decision.instance}
                    </span>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </div>);

}