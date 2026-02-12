import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  List,
  ExternalLink,
  Gavel,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { mcpService } from '../services';
import showToast from '../utils/toast';

interface SearchFilters {
  query: string;
  caseNumber: string;
  court: string;
  dateFrom: string;
  dateTo: string;
  procedureCode: string;
  courtLevel: string;
}

interface CourtDecision {
  doc_id: number;
  court: string;
  chamber: string;
  date: string;
  case_number: string;
  url: string;
  snippets: string[];
}

const procedureCodes = [
  { value: 'gpc', label: 'Господарський (ГПК)' },
  { value: 'cpc', label: 'Цивільний (ЦПК)' },
  { value: 'cac', label: 'Адміністративний (КАС)' },
  { value: 'crpc', label: 'Кримінальний (КПК)' },
];

const courtLevels = [
  { value: '', label: 'Всі рівні' },
  { value: 'SC', label: 'Верховний Суд' },
  { value: 'AC', label: 'Апеляційні суди' },
  { value: 'FC', label: 'Суди першої інстанції' },
];

export function DecisionsSearchPage() {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [viewMode, setViewMode] = useState<'comfortable' | 'compact'>('comfortable');
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [results, setResults] = useState<CourtDecision[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<SearchFilters>({
    query: '',
    caseNumber: '',
    court: '',
    dateFrom: '',
    dateTo: '',
    procedureCode: 'gpc',
    courtLevel: '',
  });

  const handleSearch = async () => {
    if (!filters.query.trim() && !filters.caseNumber.trim()) {
      showToast.error('Введіть пошуковий запит або номер справи');
      return;
    }

    setIsSearching(true);
    setError(null);
    setHasSearched(true);

    try {
      const params: any = {
        procedure_code: filters.procedureCode,
        query: filters.query || filters.caseNumber,
        limit: 20,
      };

      if (filters.courtLevel) {
        params.court_level = filters.courtLevel;
      }

      if (filters.dateFrom || filters.dateTo) {
        params.time_range = {};
        if (filters.dateFrom) params.time_range.from = filters.dateFrom;
        if (filters.dateTo) params.time_range.to = filters.dateTo;
      }

      const response = await mcpService.callTool('search_supreme_court_practice', params);

      // Parse response — result is in content[0].text as JSON string
      let parsed: any = null;
      if (response?.result?.content?.[0]?.text) {
        parsed = JSON.parse(response.result.content[0].text);
      }

      if (parsed?.results) {
        setResults(parsed.results);
        setTotalResults(parsed.total_returned || parsed.results.length);
      } else {
        setResults([]);
        setTotalResults(0);
      }
    } catch (err: any) {
      console.error('Search failed:', err);
      setError(err.message || 'Помилка пошуку');
      setResults([]);
      setTotalResults(0);
    } finally {
      setIsSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isSearching) {
      handleSearch();
    }
  };

  const updateFilter = (key: keyof SearchFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setFilters({
      query: '',
      caseNumber: '',
      court: '',
      dateFrom: '',
      dateTo: '',
      procedureCode: 'gpc',
      courtLevel: '',
    });
    setResults([]);
    setHasSearched(false);
    setError(null);
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
            <div>
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight mb-2">
                Пошук судових рішень
              </h1>
              <p className="text-claude-subtext font-sans text-sm">
                Пошук в базі судових рішень України через ZakonOnline
              </p>
            </div>
          </div>

          {/* Search Form */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 space-y-4">
            {/* Main Search */}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                  Пошуковий запит
                </label>
                <input
                  type="text"
                  value={filters.query}
                  onChange={(e) => updateFilter('query', e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="позовна давність, неустойка, відшкодування збитків..."
                  className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                    Процесуальний кодекс
                  </label>
                  <select
                    value={filters.procedureCode}
                    onChange={(e) => updateFilter('procedureCode', e.target.value)}
                    className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
                  >
                    {procedureCodes.map((pc) => (
                      <option key={pc.value} value={pc.value}>
                        {pc.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                    Номер справи
                  </label>
                  <input
                    type="text"
                    value={filters.caseNumber}
                    onChange={(e) => updateFilter('caseNumber', e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="910/12345/23"
                    className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
                  />
                </div>
              </div>
            </div>

            {/* Advanced Filters Toggle */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm font-medium text-claude-accent hover:text-[#C66345] transition-colors font-sans"
            >
              {showAdvanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              Розширені фільтри
            </button>

            {/* Advanced Filters */}
            <AnimatePresence>
              {showAdvanced && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="overflow-hidden space-y-4 pt-4 border-t border-claude-border"
                >
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Рівень суду
                      </label>
                      <select
                        value={filters.courtLevel}
                        onChange={(e) => updateFilter('courtLevel', e.target.value)}
                        className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
                      >
                        {courtLevels.map((cl) => (
                          <option key={cl.value} value={cl.value}>
                            {cl.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Дата від
                      </label>
                      <input
                        type="date"
                        value={filters.dateFrom}
                        onChange={(e) => updateFilter('dateFrom', e.target.value)}
                        className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                        Дата до
                      </label>
                      <input
                        type="date"
                        value={filters.dateTo}
                        onChange={(e) => updateFilter('dateTo', e.target.value)}
                        className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
                      />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Search Button */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleSearch}
                disabled={isSearching}
                className="flex items-center gap-2 px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSearching ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Search size={18} />
                )}
                {isSearching ? 'Пошук...' : 'Знайти рішення'}
              </button>
              <button
                onClick={resetFilters}
                className="px-4 py-3 text-claude-text hover:bg-claude-bg rounded-xl transition-colors font-sans font-medium"
              >
                Скинути
              </button>
            </div>
          </div>
        </motion.div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm font-sans">
            <AlertCircle size={18} />
            {error}
          </div>
        )}

        {/* Results Header */}
        {hasSearched && !error && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-serif text-claude-text font-medium">
                Результати пошуку
              </h2>
              <span className="text-sm text-claude-subtext font-sans">
                {isSearching ? 'Пошук...' : `${totalResults} рішень знайдено`}
              </span>
            </div>

            {/* View Mode Toggle */}
            <div className="flex bg-white border border-claude-border rounded-xl p-1">
              <button
                onClick={() => setViewMode('comfortable')}
                className={`p-2 rounded-lg transition-colors ${viewMode === 'comfortable' ? 'bg-claude-accent text-white' : 'text-claude-subtext hover:text-claude-text'}`}
                title="Комфортний вигляд"
              >
                <LayoutGrid size={18} />
              </button>
              <button
                onClick={() => setViewMode('compact')}
                className={`p-2 rounded-lg transition-colors ${viewMode === 'compact' ? 'bg-claude-accent text-white' : 'text-claude-subtext hover:text-claude-text'}`}
                title="Компактний вигляд"
              >
                <List size={18} />
              </button>
            </div>
          </div>
        )}

        {/* Loading */}
        {isSearching && (
          <div className="flex flex-col items-center justify-center py-16">
            <Loader2 size={40} className="text-claude-accent animate-spin mb-4" />
            <p className="text-claude-subtext font-sans text-sm">Шукаємо судові рішення...</p>
          </div>
        )}

        {/* Empty State */}
        {hasSearched && !isSearching && results.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Gavel size={48} className="text-claude-border mb-4" />
            <h3 className="text-lg font-serif text-claude-text mb-2">Нічого не знайдено</h3>
            <p className="text-claude-subtext font-sans text-sm max-w-md">
              Спробуйте змінити пошуковий запит або розширити фільтри
            </p>
          </div>
        )}

        {/* Results */}
        {!isSearching && results.length > 0 && (
          <div className={viewMode === 'compact' ? 'space-y-2' : 'space-y-3'}>
            {results.map((decision, index) => (
              <motion.a
                key={decision.doc_id}
                href={decision.url}
                target="_blank"
                rel="noopener noreferrer"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: index * 0.05 }}
                className={`group block bg-white rounded-2xl border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all ${viewMode === 'compact' ? 'p-3' : 'p-5'}`}
              >
                <div className="flex items-start gap-4">
                  {/* Icon */}
                  {viewMode === 'comfortable' && (
                    <div className="w-12 h-12 rounded-xl bg-claude-sidebar border-2 border-white shadow-sm flex items-center justify-center flex-shrink-0">
                      <Gavel size={20} className="text-claude-subtext" />
                    </div>
                  )}

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3
                            className={`font-serif font-medium text-claude-text group-hover:text-claude-accent transition-colors ${viewMode === 'compact' ? 'text-base' : 'text-lg'}`}
                          >
                            {decision.case_number}
                          </h3>
                        </div>
                        <p className={`text-claude-text font-sans ${viewMode === 'compact' ? 'text-xs' : 'text-sm'}`}>
                          {decision.court}
                          {decision.chamber && decision.chamber !== decision.court && ` • ${decision.chamber}`}
                        </p>
                        {decision.snippets?.length > 0 && viewMode === 'comfortable' && (
                          <p className="text-sm text-claude-subtext font-sans mt-1 line-clamp-2">
                            {decision.snippets[0]}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors opacity-0 group-hover:opacity-100">
                          <ExternalLink size={16} />
                        </button>
                      </div>
                    </div>

                    <div className={`flex items-center gap-3 ${viewMode === 'compact' ? 'text-xs' : 'text-sm'}`}>
                      <span className="text-claude-subtext font-sans">
                        {decision.date
                          ? new Date(decision.date).toLocaleDateString('uk-UA', {
                              year: 'numeric',
                              month: 'long',
                              day: 'numeric',
                            })
                          : '—'}
                      </span>
                      <span className="text-claude-border">•</span>
                      <span className="text-claude-subtext font-sans text-xs">
                        ID: {decision.doc_id}
                      </span>
                    </div>
                  </div>
                </div>
              </motion.a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
