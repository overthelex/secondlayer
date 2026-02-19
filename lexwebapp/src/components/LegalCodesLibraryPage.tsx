import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Download,
  ArrowLeft,
  Menu,
  Printer,
  Star,
  Copy,
  Link as LinkIcon,
  MessageSquare,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  X,
  Loader2,
  Library,
  ScrollText,
  Building2,
  Folder,
} from 'lucide-react';
import { mcpService } from '../services';
import { showToast } from '../utils/toast';

interface LegalCodesLibraryPageProps {
  onBack?: () => void;
}

interface Code {
  id: string;
  name: string;
  number: string;
  icon: string;
  category: string;
}

interface TOCArticleEntry {
  article_number: string;
  title: string;
  byte_size?: number;
}

interface TOCChapter {
  type: 'chapter';
  number: string;
  articles: TOCArticleEntry[];
}

interface TOCSection {
  type: 'section';
  number: string;
  articles: TOCArticleEntry[];
  chapters?: TOCChapter[];
}

type TOCEntry = TOCSection | TOCChapter | TOCArticleEntry;

interface LegislationStructure {
  rada_id: string;
  title: string;
  short_title?: string;
  type?: string;
  total_articles: number;
  table_of_contents: TOCEntry[];
  articles_summary: TOCArticleEntry[];
}

interface ArticleData {
  rada_id: string;
  article_number: string;
  title: string;
  full_text: string;
  url?: string;
  metadata?: any;
}

interface SearchResult {
  rada_id: string;
  article_number: string;
  title: string;
  full_text: string;
  url?: string;
}

const FAVORITES_KEY = 'legislation_favorites';
const COMMENTS_KEY = 'legislation_comments';

function loadFavorites(): Set<string> {
  try {
    const stored = localStorage.getItem(FAVORITES_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function saveFavorites(favorites: Set<string>) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
}

function loadComment(radaId: string, articleNumber: string): string {
  try {
    const stored = localStorage.getItem(COMMENTS_KEY);
    const comments = stored ? JSON.parse(stored) : {};
    return comments[`${radaId}:${articleNumber}`] || '';
  } catch {
    return '';
  }
}

function saveComment(radaId: string, articleNumber: string, text: string) {
  try {
    const stored = localStorage.getItem(COMMENTS_KEY);
    const comments = stored ? JSON.parse(stored) : {};
    if (text) {
      comments[`${radaId}:${articleNumber}`] = text;
    } else {
      delete comments[`${radaId}:${articleNumber}`];
    }
    localStorage.setItem(COMMENTS_KEY, JSON.stringify(comments));
  } catch {
    // ignore
  }
}

function parseToolResult(result: any): any {
  if (result?.result?.content?.[0]?.text) {
    return JSON.parse(result.result.content[0].text);
  }
  return result?.result || result;
}

const mainCodes: Code[] = [
  { id: '435-15', name: 'Цивільний кодекс', number: '435-15', icon: '⚖️', category: 'main' },
  { id: '2341-14', name: 'Кримінальний кодекс', number: '2341-14', icon: '📋', category: 'main' },
  { id: '436-15', name: 'Господарський кодекс', number: '436-15', icon: '🏛️', category: 'main' },
  { id: '2947-14', name: 'Сімейний кодекс', number: '2947-14', icon: '👨‍👩‍👧', category: 'main' },
  { id: '2768-14', name: 'Земельний кодекс', number: '2768-14', icon: '🌳', category: 'main' },
  { id: '322-08', name: 'Трудовий кодекс', number: '322-08', icon: '💼', category: 'main' },
  { id: '80731-10', name: 'Адміністративний кодекс', number: '80731-10', icon: '⚙️', category: 'main' },
  { id: '2755-17', name: 'Податковий кодекс', number: '2755-17', icon: '💰', category: 'main' },
];

const proceduralCodes = [
  { name: 'Цивільний процесуальний кодекс (ЦПК)', number: '1618-15' },
  { name: 'Господарський процесуальний кодекс (ГПК)', number: '1798-12' },
  { name: 'Кримінальний процесуальний кодекс (КПК)', number: '4651-17' },
  { name: 'Кодекс адміністративного судочинства (КАС)', number: '2747-15' },
];

const categories = [
  'Банківське',
  'Митне',
  'Виборче',
  'Бюджетне',
  'Про освіту',
  "Про охорону здоров'я",
  'Про нотаріат',
];

export function LegalCodesLibraryPage({ onBack }: LegalCodesLibraryPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [showTableOfContents, setShowTableOfContents] = useState(true);
  const [expandedSections, setExpandedSections] = useState<string[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [documentSearch, setDocumentSearch] = useState('');

  // Dynamic data state
  const [legislationData, setLegislationData] = useState<LegislationStructure | null>(null);
  const [currentArticle, setCurrentArticle] = useState<ArticleData | null>(null);
  const [loadingStructure, setLoadingStructure] = useState(false);
  const [loadingArticle, setLoadingArticle] = useState(false);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [selectedArticleNumber, setSelectedArticleNumber] = useState<string | null>(null);

  // Search state
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchTotal, setSearchTotal] = useState(0);

  // Favorites
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);

  // Comment state
  const [showComment, setShowComment] = useState(false);
  const [commentText, setCommentText] = useState('');

  // All articles list for prev/next navigation
  const allArticles = legislationData?.articles_summary || [];

  // Fetch legislation structure when code is selected
  useEffect(() => {
    if (!selectedCode) {
      setLegislationData(null);
      setCurrentArticle(null);
      setSelectedArticleNumber(null);
      setStructureError(null);
      setSearchResults([]);
      setShowComment(false);
      return;
    }

    let cancelled = false;
    setLoadingStructure(true);
    setStructureError(null);
    setCurrentArticle(null);
    setSelectedArticleNumber(null);
    setSearchResults([]);
    setShowComment(false);

    (async () => {
      try {
        const result = await mcpService.callTool('get_legislation_structure', { rada_id: selectedCode });
        if (cancelled) return;
        const data = parseToolResult(result);
        if (data.error) {
          setStructureError(data.error);
        } else {
          setLegislationData(data);
          // Expand top-level sections by default
          const topIds = (data.table_of_contents || [])
            .filter((e: any) => e.type === 'section' || e.type === 'chapter')
            .slice(0, 2)
            .map((_: any, i: number) => `toc-${i}`);
          setExpandedSections(topIds);
        }
      } catch (err: any) {
        if (!cancelled) {
          setStructureError(err.message || 'Failed to load structure');
        }
      } finally {
        if (!cancelled) setLoadingStructure(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedCode]);

  // Load comment when article changes
  useEffect(() => {
    if (currentArticle && selectedCode) {
      setCommentText(loadComment(selectedCode, currentArticle.article_number));
    }
  }, [currentArticle, selectedCode]);

  const fetchArticle = useCallback(async (articleNumber: string) => {
    if (!selectedCode) return;
    setLoadingArticle(true);
    setSelectedArticleNumber(articleNumber);
    setShowComment(false);
    try {
      const result = await mcpService.callTool('get_legislation_article', {
        rada_id: selectedCode,
        article_number: articleNumber,
      });
      const data = parseToolResult(result);
      if (data.error) {
        showToast.error(data.error);
        setCurrentArticle(null);
      } else {
        setCurrentArticle(data);
      }
    } catch (err: any) {
      showToast.error(err.message || 'Failed to load article');
      setCurrentArticle(null);
    } finally {
      setLoadingArticle(false);
    }
  }, [selectedCode]);

  const handleSearch = useCallback(async () => {
    if (!documentSearch.trim()) return;
    setSearchLoading(true);
    setSearchResults([]);
    try {
      const params: any = { query: documentSearch.trim(), limit: 20 };
      if (selectedCode) params.rada_id = selectedCode;
      const result = await mcpService.callTool('search_legislation', params);
      const data = parseToolResult(result);
      setSearchResults(data.articles || []);
      setSearchTotal(data.total_found || 0);
    } catch (err: any) {
      showToast.error(err.message || 'Search failed');
    } finally {
      setSearchLoading(false);
    }
  }, [documentSearch, selectedCode]);

  const toggleSection = (id: string) => {
    setExpandedSections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };

  const toggleFavorite = () => {
    if (!selectedCode) return;
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(selectedCode)) {
        next.delete(selectedCode);
      } else {
        next.add(selectedCode);
      }
      saveFavorites(next);
      return next;
    });
  };

  const handleCopy = () => {
    if (!currentArticle) return;
    const text = `${currentArticle.title}\n\n${currentArticle.full_text}`;
    navigator.clipboard.writeText(text).then(() => {
      showToast.success('Скопійовано');
    }).catch(() => {
      showToast.error('Не вдалося скопіювати');
    });
  };

  const handleCopyLink = () => {
    if (!currentArticle?.url) {
      showToast.info('Посилання недоступне');
      return;
    }
    navigator.clipboard.writeText(currentArticle.url).then(() => {
      showToast.success('Посилання скопійовано');
    }).catch(() => {
      showToast.error('Не вдалося скопіювати');
    });
  };

  const handleSaveComment = (text: string) => {
    if (!selectedCode || !currentArticle) return;
    setCommentText(text);
    saveComment(selectedCode, currentArticle.article_number, text);
  };

  const handlePrint = () => {
    if (!currentArticle) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html><head><title>${currentArticle.title}</title>
      <style>body { font-family: serif; max-width: 800px; margin: 40px auto; padding: 20px; }
      h1 { font-size: 18px; } p { line-height: 1.6; white-space: pre-wrap; }</style>
      </head><body>
      <h1>${currentArticle.title}</h1>
      <p>${currentArticle.full_text}</p>
      </body></html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  const handleDownload = () => {
    if (!currentArticle && !legislationData) return;
    let content: string;
    let filename: string;
    if (currentArticle) {
      content = `${currentArticle.title}\n\n${currentArticle.full_text}`;
      filename = `${legislationData?.short_title || selectedCode}_ст_${currentArticle.article_number}.txt`;
    } else {
      content = `${legislationData?.title || selectedCode}\n\nЗМІСТ\n\n`;
      content += allArticles.map(a => `Стаття ${a.article_number}. ${a.title}`).join('\n');
      filename = `${legislationData?.short_title || selectedCode}_зміст.txt`;
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Navigate to prev/next article
  const currentArticleIndex = allArticles.findIndex(
    (a) => a.article_number === selectedArticleNumber
  );
  const prevArticle = currentArticleIndex > 0 ? allArticles[currentArticleIndex - 1] : null;
  const nextArticle = currentArticleIndex < allArticles.length - 1 ? allArticles[currentArticleIndex + 1] : null;

  const renderTOCArticle = (article: TOCArticleEntry, key: string, level: number) => {
    const isSelected = selectedArticleNumber === article.article_number;
    return (
      <div key={key} style={{ marginLeft: `${level * 12}px` }}>
        <button
          onClick={() => fetchArticle(article.article_number)}
          className={`w-full text-left px-2 py-1.5 rounded text-sm font-sans transition-colors flex items-center gap-2 ${
            isSelected
              ? 'bg-claude-accent/10 text-claude-accent font-medium'
              : 'text-claude-text hover:bg-claude-bg'
          }`}
        >
          <span className="w-3.5" />
          <span className="truncate">
            Ст. {article.article_number}. {article.title}
          </span>
        </button>
      </div>
    );
  };

  const renderTOCItems = (items: TOCEntry[], level = 0, parentKey = 'toc') => {
    return items.map((item, index) => {
      const key = `${parentKey}-${index}`;

      // Article entry (no type field, has article_number)
      if ('article_number' in item && !('type' in item)) {
        return renderTOCArticle(item as TOCArticleEntry, key, level);
      }

      // Section or chapter
      const typed = item as TOCSection | TOCChapter;
      const isExpanded = expandedSections.includes(key);
      const label = typed.type === 'section'
        ? `Розділ ${typed.number}`
        : `Глава ${typed.number}`;

      const children: React.ReactNode[] = [];
      if (isExpanded) {
        // Render chapters if section
        if (typed.type === 'section' && (typed as TOCSection).chapters) {
          children.push(
            ...renderTOCItems((typed as TOCSection).chapters!, level + 1, key)
          );
        }
        // Render articles
        if (typed.articles && typed.articles.length > 0) {
          children.push(
            ...typed.articles.map((a, ai) =>
              renderTOCArticle(a, `${key}-art-${ai}`, level + 1)
            )
          );
        }
      }

      return (
        <div key={key} style={{ marginLeft: `${level * 12}px` }}>
          <button
            onClick={() => toggleSection(key)}
            className="w-full text-left px-2 py-1.5 rounded text-sm font-sans transition-colors flex items-center gap-2 text-claude-text hover:bg-claude-bg font-medium"
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="truncate">{label}</span>
          </button>
          {isExpanded && <div className="mt-1">{children}</div>}
        </div>
      );
    });
  };

  // Code viewer
  if (selectedCode) {
    const codeInfo = mainCodes.find((c) => c.id === selectedCode);
    const isFavorited = favorites.has(selectedCode);

    return (
      <div className="flex-1 h-full overflow-hidden bg-claude-bg">
        {/* Header */}
        <div className="bg-white border-b border-claude-border p-4">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSelectedCode(null)}
                  className="p-2 hover:bg-claude-bg rounded-lg transition-colors"
                >
                  <ArrowLeft size={20} className="text-claude-text" />
                </button>
                <div>
                  <h1 className="text-xl font-serif text-claude-text font-medium">
                    {codeInfo?.icon || '📜'}{' '}
                    {legislationData?.title || codeInfo?.name || selectedCode}
                  </h1>
                  <p className="text-xs text-claude-subtext font-sans">
                    № {selectedCode}
                    {legislationData?.total_articles
                      ? ` • ${legislationData.total_articles} статей`
                      : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowTableOfContents(!showTableOfContents)}
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                  title="Зміст"
                >
                  <Menu size={20} />
                </button>
                <button
                  onClick={() => setShowSearch(!showSearch)}
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                  title="Пошук"
                >
                  <Search size={20} />
                </button>
                <button
                  onClick={handleDownload}
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                  title="Завантажити"
                >
                  <Download size={20} />
                </button>
                <button
                  onClick={handlePrint}
                  disabled={!currentArticle}
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors disabled:opacity-40"
                  title="Друк"
                >
                  <Printer size={20} />
                </button>
                <button
                  onClick={toggleFavorite}
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                  title="В обране"
                >
                  <Star
                    size={20}
                    className={isFavorited ? 'fill-yellow-400 text-yellow-400' : ''}
                  />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Search Panel */}
        <AnimatePresence>
          {showSearch && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="bg-white border-b border-claude-border overflow-hidden"
            >
              <div className="max-w-7xl mx-auto p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={documentSearch}
                      onChange={(e) => setDocumentSearch(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="Знайти у документі..."
                      className="w-full px-4 py-2 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
                      autoFocus
                    />
                    {documentSearch && (
                      <button
                        onClick={() => {
                          setDocumentSearch('');
                          setSearchResults([]);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-claude-subtext hover:text-claude-text"
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                  <button
                    onClick={handleSearch}
                    disabled={searchLoading || !documentSearch.trim()}
                    className="px-4 py-2 bg-claude-accent text-white rounded-lg font-medium hover:bg-[#C66345] transition-colors font-sans disabled:opacity-50 flex items-center gap-2"
                  >
                    {searchLoading && <Loader2 size={16} className="animate-spin" />}
                    Пошук
                  </button>
                </div>

                {searchResults.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-claude-subtext font-sans">
                        Знайдено: {searchTotal} результатів
                      </span>
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-2">
                      {searchResults.map((result, index) => (
                        <div
                          key={index}
                          className="p-3 bg-claude-bg rounded-lg border border-claude-border"
                        >
                          <p className="text-sm font-medium text-claude-text font-sans mb-1">
                            Ст. {result.article_number}. {result.title}
                          </p>
                          <p className="text-sm text-claude-subtext font-sans mb-2 line-clamp-2">
                            {result.full_text}
                          </p>
                          <button
                            onClick={() => {
                              fetchArticle(result.article_number);
                              setShowSearch(false);
                            }}
                            className="text-xs text-claude-accent hover:text-[#C66345] font-sans font-medium"
                          >
                            Перейти до статті &rarr;
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!searchLoading && documentSearch && searchResults.length === 0 && searchTotal === 0 && (
                  <p className="text-sm text-claude-subtext font-sans">
                    Нічого не знайдено
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content */}
        <div className="flex h-[calc(100vh-120px)]">
          {/* Table of Contents */}
          <AnimatePresence>
            {showTableOfContents && (
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 300, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                className="bg-white border-r border-claude-border overflow-hidden"
              >
                <div className="h-full overflow-y-auto p-4 scrollbar-hide">
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-medium text-claude-text font-sans">
                        ЗМІСТ
                      </h3>
                      {legislationData && (
                        <span className="text-xs text-claude-subtext font-sans">
                          {legislationData.total_articles} статей
                        </span>
                      )}
                    </div>
                  </div>

                  {loadingStructure && (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 size={24} className="animate-spin text-claude-accent" />
                    </div>
                  )}

                  {structureError && (
                    <div className="text-sm text-red-500 font-sans p-2">
                      {structureError}
                    </div>
                  )}

                  {legislationData && !loadingStructure && (
                    <div className="space-y-0.5">
                      {renderTOCItems(legislationData.table_of_contents)}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Main Content */}
          <div className="flex-1 overflow-y-auto p-8 bg-claude-bg">
            <div className="max-w-4xl mx-auto bg-white rounded-2xl border border-claude-border shadow-sm p-8">
              {/* Loading state */}
              {loadingArticle && (
                <div className="flex items-center justify-center py-24">
                  <Loader2 size={32} className="animate-spin text-claude-accent" />
                </div>
              )}

              {/* No article selected yet */}
              {!loadingArticle && !currentArticle && (
                <div className="text-center py-24">
                  <Library size={48} className="mx-auto text-claude-subtext/30 mb-4" />
                  <p className="text-claude-subtext font-sans">
                    {loadingStructure
                      ? 'Завантаження структури...'
                      : 'Оберіть статтю зі змісту'}
                  </p>
                </div>
              )}

              {/* Article content */}
              {!loadingArticle && currentArticle && (
                <>
                  <h2 className="text-2xl font-serif font-bold text-claude-text mb-6">
                    Стаття {currentArticle.article_number}. {currentArticle.title}
                  </h2>

                  <div className="text-base text-claude-text font-sans leading-relaxed whitespace-pre-wrap">
                    {currentArticle.full_text}
                  </div>

                  {/* Prev/Next navigation */}
                  <div className="mt-8 pt-4 border-t border-claude-border flex items-center justify-between">
                    <button
                      onClick={() => prevArticle && fetchArticle(prevArticle.article_number)}
                      disabled={!prevArticle}
                      className="flex items-center gap-2 px-3 py-2 text-sm font-sans text-claude-text hover:bg-claude-bg rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft size={16} />
                      {prevArticle
                        ? `Ст. ${prevArticle.article_number}`
                        : 'Попередня'}
                    </button>
                    <span className="text-xs text-claude-subtext font-sans">
                      {currentArticleIndex + 1} / {allArticles.length}
                    </span>
                    <button
                      onClick={() => nextArticle && fetchArticle(nextArticle.article_number)}
                      disabled={!nextArticle}
                      className="flex items-center gap-2 px-3 py-2 text-sm font-sans text-claude-text hover:bg-claude-bg rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {nextArticle
                        ? `Ст. ${nextArticle.article_number}`
                        : 'Наступна'}
                      <ChevronRight size={16} />
                    </button>
                  </div>

                  {/* Action buttons */}
                  <div className="mt-4 pt-4 border-t border-claude-border flex items-center gap-3">
                    <button
                      onClick={handleCopy}
                      className="flex items-center gap-2 px-4 py-2 bg-claude-bg hover:bg-claude-border text-claude-text rounded-lg text-sm font-medium font-sans transition-colors"
                    >
                      <Copy size={16} />
                      Копіювати
                    </button>
                    <button
                      onClick={handleCopyLink}
                      className="flex items-center gap-2 px-4 py-2 bg-claude-bg hover:bg-claude-border text-claude-text rounded-lg text-sm font-medium font-sans transition-colors"
                    >
                      <LinkIcon size={16} />
                      Посилання
                    </button>
                    <button
                      onClick={() => setShowComment(!showComment)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium font-sans transition-colors ${
                        showComment || commentText
                          ? 'bg-claude-accent/10 text-claude-accent'
                          : 'bg-claude-bg hover:bg-claude-border text-claude-text'
                      }`}
                    >
                      <MessageSquare size={16} />
                      Коментар
                    </button>
                  </div>

                  {/* Comment area */}
                  <AnimatePresence>
                    {showComment && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-4">
                          <textarea
                            value={commentText}
                            onChange={(e) => handleSaveComment(e.target.value)}
                            placeholder="Додати нотатку до статті..."
                            className="w-full px-4 py-3 bg-claude-bg border border-claude-border rounded-lg text-sm font-sans text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent resize-y min-h-[80px]"
                            rows={3}
                          />
                          <p className="text-xs text-claude-subtext font-sans mt-1">
                            Нотатка зберігається автоматично в браузері
                          </p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Library listing page
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex items-center gap-4 mb-6">
            {onBack && (
              <button
                onClick={onBack}
                className="p-2 hover:bg-white rounded-lg transition-colors border border-claude-border"
              >
                <ArrowLeft size={20} className="text-claude-text" />
              </button>
            )}
            <div>
              <div className="flex items-center gap-3 mb-2">
                <Library size={32} className="text-claude-accent" />
                <h1 className="text-3xl md:text-4xl font-sans text-claude-text font-medium tracking-tight">
                  Бібліотека кодексів і законів України
                </h1>
              </div>
              <p className="text-claude-subtext font-sans text-sm">
                Швидкий доступ до нормативно-правових актів
              </p>
            </div>
          </div>

          {/* Quick Search */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 mb-6">
            <label className="block text-sm font-medium text-claude-text font-sans mb-3 flex items-center gap-2">
              <Search size={16} />
              Швидкий пошук
            </label>
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1 group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-claude-subtext group-focus-within:text-claude-accent transition-colors" />
                </div>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Введіть назву кодексу або закону..."
                  className="block w-full pl-11 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans"
                />
              </div>
              <button className="px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans">
                Пошук
              </button>
            </div>
            <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
              <span>Популярні запити:</span>
              {['конституція', 'цпк', 'цк', 'кк', 'зку'].map((query) => (
                <button
                  key={query}
                  className="text-claude-accent hover:text-[#C66345] font-medium"
                >
                  {query}
                </button>
              ))}
            </div>
          </div>

          {/* Main Codes */}
          <div className="mb-6">
            <h2 className="text-xl font-sans text-claude-text font-medium mb-4 flex items-center gap-2">
              <Library size={24} />
              Основні кодекси
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {mainCodes.map((code, index) => (
                <motion.div
                  key={code.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.05 }}
                  className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 hover:shadow-md hover:border-claude-accent/30 transition-all"
                >
                  <div className="text-4xl mb-3">{code.icon}</div>
                  <h3 className="text-base font-sans font-medium text-claude-text mb-1">
                    {code.name}
                  </h3>
                  <p className="text-sm text-claude-subtext font-sans mb-4">
                    {code.number}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelectedCode(code.id)}
                      className="flex-1 px-3 py-2 bg-claude-accent text-white rounded-lg text-sm font-medium hover:bg-[#C66345] transition-colors font-sans"
                    >
                      Відкрити
                    </button>
                    <button className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors">
                      <Download size={18} />
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Procedural Codes */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 mb-6">
            <h2 className="text-lg font-sans text-claude-text font-medium mb-4 flex items-center gap-2">
              <ScrollText size={20} />
              Процесуальні кодекси
            </h2>
            <div className="space-y-2">
              {proceduralCodes.map((code, index) => (
                <motion.div
                  key={code.number}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="flex items-center justify-between p-3 bg-claude-bg rounded-lg hover:bg-claude-border transition-colors"
                >
                  <span className="text-sm font-sans text-claude-text">
                    • {code.name}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelectedCode(code.number)}
                      className="px-3 py-1.5 text-sm font-medium font-sans text-claude-text hover:text-claude-accent transition-colors"
                    >
                      Відкрити
                    </button>
                    <button className="p-1.5 text-claude-subtext hover:text-claude-text transition-colors">
                      <Download size={16} />
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Constitutional Acts */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 mb-6">
            <h2 className="text-lg font-sans text-claude-text font-medium mb-4 flex items-center gap-2">
              <Building2 size={20} />
              Конституційні акти
            </h2>
            <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
              <span className="text-sm font-sans text-claude-text">
                • Конституція України (254к/96-ВР)
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setSelectedCode('254к/96-вр')}
                  className="px-3 py-1.5 text-sm font-medium font-sans text-claude-text hover:text-claude-accent transition-colors"
                >
                  Відкрити
                </button>
                <button className="p-1.5 text-claude-subtext hover:text-claude-text transition-colors">
                  <Download size={16} />
                </button>
              </div>
            </div>
          </div>

          {/* Categories */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">
            <h2 className="text-lg font-sans text-claude-text font-medium mb-4 flex items-center gap-2">
              <Folder size={20} />
              Категорії законів
            </h2>
            <div className="flex flex-wrap gap-2">
              {categories.map((category, index) => (
                <motion.button
                  key={category}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.03 }}
                  className="px-4 py-2 bg-claude-bg hover:bg-claude-accent hover:text-white border border-claude-border hover:border-claude-accent rounded-xl text-sm font-medium font-sans transition-all"
                >
                  {category}
                </motion.button>
              ))}
              <button className="px-4 py-2 bg-claude-bg hover:bg-claude-border border border-claude-border rounded-xl text-sm font-medium font-sans text-claude-subtext hover:text-claude-text transition-all">
                Показати всі (47)
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
