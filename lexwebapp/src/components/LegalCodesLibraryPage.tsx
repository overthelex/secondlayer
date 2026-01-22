import React, { useState, Children } from 'react';
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
  X,
  Zap,
  Library,
  ScrollText,
  Building2,
  Folder } from
'lucide-react';
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
const mainCodes: Code[] = [
{
  id: 'civil',
  name: 'Цивільний кодекс',
  number: '435-15',
  icon: '⚖️',
  category: 'main'
},
{
  id: 'criminal',
  name: 'Кримінальний кодекс',
  number: '2341-14',
  icon: '📋',
  category: 'main'
},
{
  id: 'economic',
  name: 'Господарський кодекс',
  number: '436-15',
  icon: '🏛️',
  category: 'main'
},
{
  id: 'family',
  name: 'Сімейний кодекс',
  number: '2947-14',
  icon: '👨‍👩‍👧',
  category: 'main'
},
{
  id: 'land',
  name: 'Земельний кодекс',
  number: '2768-14',
  icon: '🌳',
  category: 'main'
},
{
  id: 'labor',
  name: 'Трудовий кодекс',
  number: '322-08',
  icon: '💼',
  category: 'main'
},
{
  id: 'administrative',
  name: 'Адміністративний кодекс',
  number: '80731-10',
  icon: '⚙️',
  category: 'main'
},
{
  id: 'tax',
  name: 'Податковий кодекс',
  number: '2755-17',
  icon: '💰',
  category: 'main'
},
{
  id: 'environmental',
  name: 'Екологічний кодекс',
  number: '',
  icon: '🌿',
  category: 'main'
}];

const proceduralCodes = [
{
  name: 'Цивільний процесуальний кодекс (ЦПК)',
  number: '1618-15'
},
{
  name: 'Господарський процесуальний кодекс (ГПК)',
  number: '1798-12'
},
{
  name: 'Кримінальний процесуальний кодекс (КПК)',
  number: '4651-17'
},
{
  name: 'Кодекс адміністративного судочинства (КАС)',
  number: '2747-15'
}];

const categories = [
'Банківське',
'Митне',
'Виборче',
'Бюджетне',
'Про освіту',
"Про охорону здоров'я",
'Про нотаріат'];

const tableOfContents = [
{
  id: 'book1',
  title: 'Книга перша. ЗАГАЛЬНІ ПОЛОЖЕННЯ',
  children: [
  {
    id: 'section1',
    title: 'Розділ I. ОСНОВНІ ПОЛОЖЕННЯ',
    children: []
  },
  {
    id: 'section2',
    title: 'Розділ II. ОСОБИ',
    children: []
  },
  {
    id: 'section3',
    title: "Розділ III. ОБ'ЄКТИ ЦИВІЛЬНИХ ПРАВ",
    children: [
    {
      id: 'para1',
      title: '§1. Загальні положення',
      children: []
    },
    {
      id: 'para2',
      title: '§2. Речі',
      children: [
      {
        id: 'art15',
        title: 'Стаття 15',
        children: []
      },
      {
        id: 'art16',
        title: 'Стаття 16',
        children: []
      },
      {
        id: 'art17',
        title: 'Стаття 17',
        children: []
      }]

    }]

  },
  {
    id: 'section4',
    title: 'Розділ IV. ПРАВОЧИНИ',
    children: []
  }]

},
{
  id: 'book2',
  title: 'Книга друга. ОСОБИСТІ НЕМАЙНОВІ ПРАВА',
  children: []
}];

const searchResults = [
{
  article: 'Стаття 15. Поняття договору',
  text: 'Договором є домовленість двох або більше сторін, спрямована на встановлення, зміну або припинення...'
},
{
  article: 'Стаття 626. Договір',
  text: 'Договір є правочином, тому до договору застосовуються...'
}];

export function LegalCodesLibraryPage({ onBack }: LegalCodesLibraryPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [showTableOfContents, setShowTableOfContents] = useState(true);
  const [expandedSections, setExpandedSections] = useState<string[]>([
  'book1',
  'section3',
  'para2']
  );
  const [showSearch, setShowSearch] = useState(false);
  const [documentSearch, setDocumentSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const toggleSection = (id: string) => {
    setExpandedSections((prev) =>
    prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };
  const renderTableOfContents = (items: any[], level = 0) => {
    return items.map((item) => {
      const isExpanded = expandedSections.includes(item.id);
      const hasChildren = item.children && item.children.length > 0;
      return (
        <div
          key={item.id}
          style={{
            marginLeft: `${level * 12}px`
          }}>

          <button
            onClick={() => hasChildren && toggleSection(item.id)}
            className={`w-full text-left px-2 py-1.5 rounded text-sm font-sans transition-colors flex items-center gap-2 ${item.id === 'art16' ? 'bg-claude-accent/10 text-claude-accent font-medium' : 'text-claude-text hover:bg-claude-bg'}`}>

            {hasChildren && (
            isExpanded ?
            <ChevronDown size={14} /> :

            <ChevronRight size={14} />)
            }
            {!hasChildren && <span className="w-3.5" />}
            <span className="truncate">{item.title}</span>
          </button>
          {hasChildren && isExpanded &&
          <div className="mt-1">
              {renderTableOfContents(item.children, level + 1)}
            </div>
          }
        </div>);

    });
  };
  if (selectedCode) {
    return (
      <div className="flex-1 h-full overflow-hidden bg-claude-bg">
        {/* Header */}
        <div className="bg-white border-b border-claude-border p-4">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSelectedCode(null)}
                  className="p-2 hover:bg-claude-bg rounded-lg transition-colors">

                  <ArrowLeft size={20} className="text-claude-text" />
                </button>
                <div>
                  <h1 className="text-xl font-serif text-claude-text font-medium">
                    ⚖️ Цивільний кодекс України
                  </h1>
                  <p className="text-xs text-claude-subtext font-sans">
                    № 435-15 від 16.01.2003 • Редакція від 01.01.2024, підстава:
                    3091-IX
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowTableOfContents(!showTableOfContents)}
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                  title="Зміст">

                  <Menu size={20} />
                </button>
                <button
                  onClick={() => setShowSearch(!showSearch)}
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                  title="Пошук">

                  <Search size={20} />
                </button>
                <button
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                  title="Завантажити">

                  <Download size={20} />
                </button>
                <button
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                  title="Друк">

                  <Printer size={20} />
                </button>
                <button
                  className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                  title="В обране">

                  <Star size={20} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Search Panel */}
        <AnimatePresence>
          {showSearch &&
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
            className="bg-white border-b border-claude-border overflow-hidden">

              <div className="max-w-7xl mx-auto p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="flex-1 relative">
                    <input
                    type="text"
                    value={documentSearch}
                    onChange={(e) => setDocumentSearch(e.target.value)}
                    placeholder="Знайти у документі..."
                    className="w-full px-4 py-2 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans"
                    autoFocus />

                    {documentSearch &&
                  <button
                    onClick={() => setDocumentSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-claude-subtext hover:text-claude-text">

                        <X size={16} />
                      </button>
                  }
                  </div>
                  <button className="px-4 py-2 bg-claude-accent text-white rounded-lg font-medium hover:bg-[#C66345] transition-colors font-sans">
                    Пошук
                  </button>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                    type="checkbox"
                    checked={caseSensitive}
                    onChange={(e) => setCaseSensitive(e.target.checked)}
                    className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent" />

                    <span className="text-claude-text font-sans">
                      Враховувати регістр
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                    type="checkbox"
                    checked={wholeWord}
                    onChange={(e) => setWholeWord(e.target.checked)}
                    className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent" />

                    <span className="text-claude-text font-sans">
                      Ціле слово
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                    type="checkbox"
                    checked={regex}
                    onChange={(e) => setRegex(e.target.checked)}
                    className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent" />

                    <span className="text-claude-text font-sans">
                      Регулярний вираз
                    </span>
                  </label>
                </div>
                {documentSearch &&
              <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-claude-subtext font-sans">
                        Знайдено: 847 входжень
                      </span>
                      <div className="flex items-center gap-2">
                        <button className="px-3 py-1 text-claude-text hover:bg-claude-bg rounded transition-colors font-sans">
                          ▲ Попередній
                        </button>
                        <span className="text-claude-subtext font-sans">
                          (12/847)
                        </span>
                        <button className="px-3 py-1 text-claude-text hover:bg-claude-bg rounded transition-colors font-sans">
                          ▼ Наступний
                        </button>
                      </div>
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-2">
                      {searchResults.map((result, index) =>
                  <div
                    key={index}
                    className="p-3 bg-claude-bg rounded-lg border border-claude-border">

                          <p className="text-sm font-medium text-claude-text font-sans mb-1">
                            {result.article}
                          </p>
                          <p className="text-sm text-claude-subtext font-sans mb-2">
                            {result.text}
                          </p>
                          <button className="text-xs text-claude-accent hover:text-[#C66345] font-sans font-medium">
                            Перейти до статті →
                          </button>
                        </div>
                  )}
                    </div>
                  </div>
              }
              </div>
            </motion.div>
          }
        </AnimatePresence>

        {/* Content */}
        <div className="flex h-[calc(100vh-120px)]">
          {/* Table of Contents */}
          <AnimatePresence>
            {showTableOfContents &&
            <motion.div
              initial={{
                width: 0,
                opacity: 0
              }}
              animate={{
                width: 280,
                opacity: 1
              }}
              exit={{
                width: 0,
                opacity: 0
              }}
              className="bg-white border-r border-claude-border overflow-hidden">

                <div className="h-full overflow-y-auto p-4 scrollbar-hide">
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-medium text-claude-text font-sans">
                        ЗМІСТ
                      </h3>
                      <span className="text-xs text-claude-subtext font-sans">
                        (25%)
                      </span>
                    </div>
                  </div>
                  {renderTableOfContents(tableOfContents)}
                </div>
              </motion.div>
            }
          </AnimatePresence>

          {/* Main Content */}
          <div className="flex-1 overflow-y-auto p-8 bg-claude-bg">
            <div className="max-w-4xl mx-auto bg-white rounded-2xl border border-claude-border shadow-sm p-8">
              <h2 className="text-2xl font-serif font-bold text-claude-text mb-6">
                Книга перша. ЗАГАЛЬНІ ПОЛОЖЕННЯ
              </h2>

              <h3 className="text-xl font-serif font-bold text-claude-text mb-4">
                Розділ I. ОСНОВНІ ПОЛОЖЕННЯ
              </h3>

              <div className="space-y-6">
                <div>
                  <h4 className="text-lg font-serif font-medium text-claude-text mb-3">
                    Стаття 1. Відносини, що регулюються ЦК
                  </h4>
                  <p className="text-base text-claude-text font-sans leading-relaxed mb-4">
                    Цивільним законодавством регулюються особисті немайнові та
                    майнові відносини (цивільні відносини), засновані на
                    юридичній рівності, вільному волевиявленні, майновій
                    самостійності їх учасників.
                  </p>
                  <p className="text-base text-claude-text font-sans leading-relaxed">
                    До майнових відносин, заснованих на адміністративному або
                    іншому владному підпорядкуванні однієї сторони іншій
                    стороні, цивільне законодавство не застосовується, якщо інше
                    не встановлено законом.
                  </p>
                </div>

                <div className="border-t border-claude-border pt-6">
                  <h4 className="text-lg font-serif font-medium text-claude-text mb-3">
                    Стаття 2. Відносини, на які поширюється дія ЦК
                  </h4>
                  <p className="text-base text-claude-text font-sans leading-relaxed">
                    Цивільне законодавство поширюється на відносини за участю
                    іноземців, осіб без громадянства та іноземних юридичних
                    осіб, якщо інше не встановлено законом.
                  </p>
                </div>
              </div>

              {/* Tools Panel */}
              <div className="mt-8 pt-6 border-t border-claude-border flex items-center gap-3">
                <button className="flex items-center gap-2 px-4 py-2 bg-claude-bg hover:bg-claude-border text-claude-text rounded-lg text-sm font-medium font-sans transition-colors">
                  <Copy size={16} />
                  Копіювати
                </button>
                <button className="flex items-center gap-2 px-4 py-2 bg-claude-bg hover:bg-claude-border text-claude-text rounded-lg text-sm font-medium font-sans transition-colors">
                  <LinkIcon size={16} />
                  Посилання
                </button>
                <button className="flex items-center gap-2 px-4 py-2 bg-claude-bg hover:bg-claude-border text-claude-text rounded-lg text-sm font-medium font-sans transition-colors">
                  <MessageSquare size={16} />
                  Коментар
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>);

  }
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
                  className="block w-full pl-11 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans" />

              </div>
              <button className="px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans">
                Пошук
              </button>
            </div>
            <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
              <span>Популярні запити:</span>
              {['конституція', 'цпк', 'цк', 'кк', 'зку'].map((query) =>
              <button
                key={query}
                className="text-claude-accent hover:text-[#C66345] font-medium">

                  {query}
                </button>
              )}
            </div>
          </div>

          {/* Main Codes */}
          <div className="mb-6">
            <h2 className="text-xl font-sans text-claude-text font-medium mb-4 flex items-center gap-2">
              <Library size={24} />
              Основні кодекси
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {mainCodes.map((code, index) =>
              <motion.div
                key={code.id}
                initial={{
                  opacity: 0,
                  scale: 0.95
                }}
                animate={{
                  opacity: 1,
                  scale: 1
                }}
                transition={{
                  delay: index * 0.05
                }}
                className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 hover:shadow-md hover:border-claude-accent/30 transition-all">

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
                    className="flex-1 px-3 py-2 bg-claude-accent text-white rounded-lg text-sm font-medium hover:bg-[#C66345] transition-colors font-sans">

                      Відкрити
                    </button>
                    <button className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors">
                      <Download size={18} />
                    </button>
                  </div>
                </motion.div>
              )}
            </div>
          </div>

          {/* Procedural Codes */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 mb-6">
            <h2 className="text-lg font-sans text-claude-text font-medium mb-4 flex items-center gap-2">
              <ScrollText size={20} />
              Процесуальні кодекси
            </h2>
            <div className="space-y-2">
              {proceduralCodes.map((code, index) =>
              <motion.div
                key={code.number}
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
                className="flex items-center justify-between p-3 bg-claude-bg rounded-lg hover:bg-claude-border transition-colors">

                  <span className="text-sm font-sans text-claude-text">
                    • {code.name}
                  </span>
                  <div className="flex gap-2">
                    <button className="px-3 py-1.5 text-sm font-medium font-sans text-claude-text hover:text-claude-accent transition-colors">
                      Відкрити
                    </button>
                    <button className="p-1.5 text-claude-subtext hover:text-claude-text transition-colors">
                      <Download size={16} />
                    </button>
                  </div>
                </motion.div>
              )}
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
                <button className="px-3 py-1.5 text-sm font-medium font-sans text-claude-text hover:text-claude-accent transition-colors">
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
              {categories.map((category, index) =>
              <motion.button
                key={category}
                initial={{
                  opacity: 0,
                  scale: 0.9
                }}
                animate={{
                  opacity: 1,
                  scale: 1
                }}
                transition={{
                  delay: index * 0.03
                }}
                className="px-4 py-2 bg-claude-bg hover:bg-claude-accent hover:text-white border border-claude-border hover:border-claude-accent rounded-xl text-sm font-medium font-sans transition-all">

                  {category}
                </motion.button>
              )}
              <button className="px-4 py-2 bg-claude-bg hover:bg-claude-border border border-claude-border rounded-xl text-sm font-medium font-sans text-claude-subtext hover:text-claude-text transition-all">
                Показати всі (47)
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>);

}